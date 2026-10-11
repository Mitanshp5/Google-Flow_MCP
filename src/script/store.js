import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { canonicalStringify } from '../domain/contracts.js';
import {
  getRuntimeRoot,
  atomicWriteJson,
  readVersionedJson,
  acquireLock,
} from '../storage/runtime-store.js';
import { validateStoryInput } from './schema.js';
import { buildStoryDag, computeSemanticInvalidations } from './dag.js';

export const STORY_MANIFEST_VERSION = 1;
export const STORY_SNAPSHOT_VERSION = 1;

export const SAFE_STORY_ID_RE = Object.freeze(/^[a-zA-Z0-9_-]{1,64}$/);
export const SAFE_SCRIPT_ID_RE = SAFE_STORY_ID_RE;

function getRealpathOrNull(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }
}

function isLexicallyInside(resolvedTarget, resolvedRoot) {
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function isCanonicallyInside(realTarget, realRoot) {
  const t = String(realTarget).toLowerCase();
  const r = String(realRoot).toLowerCase();
  return t === r || t.startsWith(r + path.sep.toLowerCase());
}

function findNearestExistingAncestor(resolvedPath) {
  let cur = path.resolve(resolvedPath);
  for (;;) {
    try {
      if (fs.existsSync(cur)) return cur;
    } catch {
      // treat as non-existing and walk up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function checkSymlinkTarget(targetDir, root, storyId) {
  // Detect a symlink at the exact target path (including dangling links)
  // and reject when its link target escapes the storage base.
  let st = null;
  try {
    st = fs.lstatSync(targetDir);
  } catch {
    return;
  }
  if (!st || !st.isSymbolicLink()) return;
  let link = null;
  try {
    link = fs.readlinkSync(targetDir);
  } catch {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Story/Script path is a link that cannot be verified: ${storyId || targetDir}`,
      { targetDir, root, storyId }
    );
  }
  const resolvedLink = path.resolve(path.dirname(path.resolve(targetDir)), link);
  const resolvedRoot = path.resolve(root);
  if (!isLexicallyInside(resolvedLink, resolvedRoot)) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Story/Script directory escapes allowed storage base via symlink or junction: ${storyId || targetDir}`,
      { targetDir, root, storyId }
    );
  }
  const realRoot = getRealpathOrNull(root) || resolvedRoot;
  const realLink = getRealpathOrNull(targetDir);
  if (realLink && !isCanonicallyInside(realLink, realRoot)) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Story/Script directory escapes allowed storage base via symlink or junction: ${storyId || targetDir}`,
      { targetDir, realTarget: realLink, root, realRoot, storyId }
    );
  }
}

export function getScriptsDir(root = getRuntimeRoot()) {
  const dir = path.join(root, 'scripts');
  // Validate before any side effect: lexical + ancestor/canonical checks.
  assertDirContained(dir, root, 'scripts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Re-validate after creation (resolves races / pre-existing links).
  assertDirContained(dir, root, 'scripts');
  return dir;
}

export function getStoriesDir(root = getRuntimeRoot()) {
  const dir = path.join(root, 'stories');
  assertDirContained(dir, root, 'stories');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  assertDirContained(dir, root, 'stories');
  return dir;
}

export function assertDirContained(targetDir, root, storyId = '') {
  const resolvedTarget = path.resolve(targetDir);
  const resolvedRoot = path.resolve(root);

  if (!isLexicallyInside(resolvedTarget, resolvedRoot)) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Story/Script directory escapes allowed storage base: ${storyId || targetDir}`,
      { targetDir, root, storyId }
    );
  }

  // Reject symlink escapes at the exact path before ancestor analysis
  // (covers dangling links where existsSync is false).
  checkSymlinkTarget(targetDir, root, storyId);

  try {
    const realRoot = getRealpathOrNull(root) || resolvedRoot;

    let checkPath = null;
    if (fs.existsSync(targetDir)) {
      checkPath = targetDir;
    } else {
      checkPath = findNearestExistingAncestor(targetDir);
      if (!checkPath) {
        throw new FlowError(
          'INVALID_STORY_ID',
          `[INVALID_STORY_ID] Cannot verify storage containment: ${storyId || targetDir}`,
          { targetDir, root, storyId }
        );
      }
    }

    const realCheck = getRealpathOrNull(checkPath);
    if (!realCheck) {
      throw new FlowError(
        'INVALID_STORY_ID',
        `[INVALID_STORY_ID] Cannot verify storage containment: ${storyId || targetDir}`,
        { targetDir, root, storyId }
      );
    }

    if (!isCanonicallyInside(realCheck, realRoot)) {
      throw new FlowError(
        'INVALID_STORY_ID',
        `[INVALID_STORY_ID] Story/Script directory escapes allowed storage base via symlink or junction: ${storyId || targetDir}`,
        { targetDir, realTarget: realCheck, root, realRoot, storyId }
      );
    }
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Cannot verify storage containment: ${err.message}`,
      { targetDir, root, storyId }
    );
  }
}

export function assertFileContained(targetFile, root, storyId = '') {
  const resolvedFile = path.resolve(targetFile);
  const resolvedRoot = path.resolve(root);
  if (!isLexicallyInside(resolvedFile, resolvedRoot) && resolvedFile !== resolvedRoot) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Story/Script file escapes allowed storage base: ${storyId || targetFile}`,
      { targetDir: targetFile, root, storyId }
    );
  }
  checkSymlinkTarget(targetFile, root, storyId);
  try {
    const realRoot = getRealpathOrNull(root) || resolvedRoot;
    let checkPath = null;
    if (fs.existsSync(targetFile)) {
      checkPath = targetFile;
    } else {
      checkPath = findNearestExistingAncestor(targetFile);
      if (!checkPath) {
        throw new FlowError(
          'INVALID_STORY_ID',
          `[INVALID_STORY_ID] Cannot verify storage containment: ${storyId || targetFile}`,
          { targetDir: targetFile, root, storyId }
        );
      }
    }
    const realCheck = getRealpathOrNull(checkPath);
    if (!realCheck) {
      throw new FlowError(
        'INVALID_STORY_ID',
        `[INVALID_STORY_ID] Cannot verify storage containment: ${storyId || targetFile}`,
        { targetDir: targetFile, root, storyId }
      );
    }
    if (!isCanonicallyInside(realCheck, realRoot) && realCheck.toLowerCase() !== realRoot.toLowerCase()) {
      throw new FlowError(
        'INVALID_STORY_ID',
        `[INVALID_STORY_ID] Story/Script file escapes allowed storage base via symlink or junction: ${storyId || targetFile}`,
        { targetDir: targetFile, realTarget: realCheck, root, realRoot, storyId }
      );
    }
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Cannot verify storage containment: ${err.message}`,
      { targetDir: targetFile, root, storyId }
    );
  }
}

export function validateStoryId(storyId, root = getRuntimeRoot()) {
  if (typeof storyId !== 'string' || !storyId.trim() || !SAFE_STORY_ID_RE.test(storyId.trim())) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Story/Script ID must be an alphanumeric identifier (max 64 chars): ${storyId}`,
      { storyId }
    );
  }
  const cleanId = storyId.trim();
  const scriptsDir = getScriptsDir(root);
  const targetDir = path.resolve(scriptsDir, cleanId);
  assertDirContained(targetDir, root, cleanId);
  return cleanId;
}

export const validateScriptId = validateStoryId;

export function getScriptDir(scriptId, root = getRuntimeRoot()) {
  const validId = validateStoryId(scriptId, root);
  const scriptsDir = getScriptsDir(root);
  const storiesDir = getStoriesDir(root);

  const scriptsPath = path.join(scriptsDir, validId);
  const storiesPath = path.join(storiesDir, validId);

  let chosenPath;
  if (fs.existsSync(path.join(scriptsPath, 'manifest.json'))) {
    chosenPath = scriptsPath;
  } else if (fs.existsSync(path.join(storiesPath, 'manifest.json'))) {
    chosenPath = storiesPath;
  } else if (fs.existsSync(scriptsPath)) {
    chosenPath = scriptsPath;
  } else if (fs.existsSync(storiesPath)) {
    chosenPath = storiesPath;
  } else {
    chosenPath = scriptsPath;
  }

  assertDirContained(chosenPath, root, validId);
  return chosenPath;
}

export const getStoryDir = getScriptDir;

export function getStoryManifestFile(storyId, root = getRuntimeRoot()) {
  return path.join(getStoryDir(storyId, root), 'manifest.json');
}
export const getScriptManifestFile = getStoryManifestFile;

export function getStoryLockFile(storyId, root = getRuntimeRoot()) {
  return path.join(getStoryDir(storyId, root), 'story.lock');
}
export const getScriptLockFile = getStoryLockFile;

export function getStoryRevisionsDir(storyId, root = getRuntimeRoot()) {
  return path.join(getStoryDir(storyId, root), 'revisions');
}
export const getScriptRevisionsDir = getStoryRevisionsDir;

export function getStoryJournalDir(storyId, root = getRuntimeRoot()) {
  return path.join(getStoryDir(storyId, root), 'journal');
}
export const getScriptJournalDir = getStoryJournalDir;

/**
 * Computes canonical SHA-256 digest of a payload using canonical JSON serialization.
 */
export function computeCanonicalDigest(payload) {
  const serialized = canonicalStringify(payload);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Computes digest for each bible entity, scene, and shot.
 */
function computeNodeDigests(validStory) {
  const digests = {};

  const hashList = (prefix, list = []) => {
    for (const item of list) {
      const id = `${prefix}:${item.id}`;
      digests[id] = computeCanonicalDigest(item);
    }
  };

  hashList('char', validStory.bible?.characters);
  hashList('loc', validStory.bible?.locations);
  hashList('prop', validStory.bible?.props);
  hashList('scene', validStory.scenes);
  hashList('shot', validStory.shots);

  return digests;
}

/**
 * Saves a new story specification into immutable revision storage.
 * Layout:
 *   stories/<story-uuid>/
 *     manifest.json
 *     revisions/<revision-id>/snapshot.json
 *     journal/
 */
export function saveNewStory(storyInput, { root = getRuntimeRoot() } = {}) {
  const validStory = validateStoryInput(storyInput);
  const rawId = storyInput.storyId || storyInput.scriptId || crypto.randomUUID();
  const storyId = validateStoryId(rawId, root);
  const manifestPath = getStoryManifestFile(storyId, root);
  const storyDir = getStoryDir(storyId, root);

  // Containment BEFORE any side effect: validate target + nearest ancestor.
  assertDirContained(storyDir, root, storyId);
  assertFileContained(manifestPath, root, storyId);
  // Ensure story directory exists to place lock file
  fs.mkdirSync(storyDir, { recursive: true });
  assertDirContained(storyDir, root, storyId);

  const lockFile = getStoryLockFile(storyId, root);
  assertFileContained(lockFile, root, storyId);
  const lock = acquireLock(lockFile);
  try {
    assertFileContained(manifestPath, root, storyId);
    if (fs.existsSync(manifestPath)) {
      // A symlinked manifest must never be trusted: verify canonical target.
      assertFileContained(manifestPath, root, storyId);
      throw new FlowError('STORY_EXISTS', `[STORY_EXISTS] Story already exists: ${storyId}`, { storyId });
    }

    const revisionsDir = getStoryRevisionsDir(storyId, root);
    const journalDir = getStoryJournalDir(storyId, root);
    assertDirContained(revisionsDir, root, storyId);
    assertDirContained(journalDir, root, storyId);
    fs.mkdirSync(revisionsDir, { recursive: true });
    assertDirContained(revisionsDir, root, storyId);
    fs.mkdirSync(journalDir, { recursive: true });
    assertDirContained(journalDir, root, storyId);

    const dag = buildStoryDag(validStory);
    const nodeDigests = computeNodeDigests(validStory);

    const now = new Date().toISOString();
    const nodeStates = {};
    for (const [nodeId] of dag.nodes) {
      nodeStates[nodeId] = {
        status: 'draft',
        revision: 1,
        nodeDigest: nodeDigests[nodeId] || null,
        updatedAt: now,
        reviews: [],
      };
    }

    // Calculate canonical snapshot digest
    const snapshotContent = {
      v: STORY_SNAPSHOT_VERSION,
      storyId,
      scriptId: storyId,
      revision: 1,
      parentRevisionId: null,
      createdAt: now,
      updatedAt: now,
      binding: validStory.binding,
      policy: validStory.policy,
      governance: validStory.governance,
      brief: validStory.brief,
      bible: validStory.bible,
      scenes: validStory.scenes,
      shots: validStory.shots,
      timeline: validStory.timeline,
      nodeStates,
    };

    const digest = computeCanonicalDigest(snapshotContent);
    const revisionId = `rev_1_${digest.slice(0, 8)}`;
    snapshotContent.revisionId = revisionId;
    snapshotContent.digest = digest;

    // 1. Commit immutable revision snapshot first (write-once enforcement)
    const revDir = path.join(revisionsDir, revisionId);
    assertDirContained(revDir, root, storyId);
    fs.mkdirSync(revDir, { recursive: true });
    assertDirContained(revDir, root, storyId);
    const snapshotFile = path.join(revDir, 'snapshot.json');
    assertFileContained(snapshotFile, root, storyId);
    if (fs.existsSync(snapshotFile)) {
      assertFileContained(snapshotFile, root, storyId);
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision snapshot already exists: ${revisionId}`, { storyId, revisionId });
    }
    atomicWriteJson(snapshotFile, snapshotContent);

    // 2. Commit manifest pointer last
    const manifest = {
      v: STORY_MANIFEST_VERSION,
      storyId,
      scriptId: storyId,
      currentRevision: 1,
      currentRevisionId: revisionId,
      currentDigest: digest,
      accountKey: validStory.binding.accountKey,
      projectId: validStory.binding.projectId,
      title: validStory.brief.title,
      createdAt: now,
      updatedAt: now,
    };
    assertFileContained(manifestPath, root, storyId);
    atomicWriteJson(manifestPath, manifest);

    return snapshotContent;
  } finally {
    lock.release();
  }
}
export const saveNewScript = saveNewStory;

/**
 * Retrieves a story/script record by ID (or specific revision).
 */
export function getStory(storyId, { revisionId = null, root = getRuntimeRoot() } = {}) {
  const storyDir = getStoryDir(storyId, root);
  assertDirContained(storyDir, root, storyId);

  const manifestPath = path.join(storyDir, 'manifest.json');
  assertFileContained(manifestPath, root, storyId);
  if (!fs.existsSync(manifestPath)) {
    throw new FlowError('STORY_NOT_FOUND', `[STORY_NOT_FOUND] Story not found: ${storyId}`, { storyId });
  }
  assertFileContained(manifestPath, root, storyId);

  const manifest = readVersionedJson(manifestPath, { supported: [STORY_MANIFEST_VERSION] });
  if (!manifest.currentDigest || typeof manifest.currentDigest !== 'string') {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Manifest currentDigest missing or invalid for story ${storyId}`,
      { storyId }
    );
  }

  // Cross-check manifest identity
  if (manifest.storyId !== storyId && manifest.scriptId !== storyId) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Manifest ID (${manifest.storyId || manifest.scriptId}) does not match requested ID (${storyId})`,
      { requestedId: storyId, manifestStoryId: manifest.storyId, manifestScriptId: manifest.scriptId }
    );
  }

  // Validate manifest currentRevision
  if (!Number.isSafeInteger(manifest.currentRevision) || manifest.currentRevision <= 0) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Manifest currentRevision must be a positive safe integer: ${manifest.currentRevision}`,
      { storyId, currentRevision: manifest.currentRevision }
    );
  }

  // Validate manifest currentRevisionId
  if (
    !manifest.currentRevisionId ||
    typeof manifest.currentRevisionId !== 'string' ||
    !SAFE_STORY_ID_RE.test(manifest.currentRevisionId) ||
    manifest.currentRevisionId.includes('..') ||
    manifest.currentRevisionId.includes('/') ||
    manifest.currentRevisionId.includes('\\')
  ) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Manifest currentRevisionId is invalid: ${manifest.currentRevisionId}`,
      { storyId, currentRevisionId: manifest.currentRevisionId }
    );
  }

  const targetRevId = revisionId || manifest.currentRevisionId;

  // Validate targetRevId
  if (
    !targetRevId ||
    typeof targetRevId !== 'string' ||
    !SAFE_STORY_ID_RE.test(targetRevId) ||
    targetRevId.includes('..') ||
    targetRevId.includes('/') ||
    targetRevId.includes('\\')
  ) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Invalid revisionId: ${targetRevId}`,
      { storyId, targetRevId }
    );
  }

  const revisionsDir = getStoryRevisionsDir(storyId, root);
  assertDirContained(revisionsDir, root, storyId);
  const revDir = path.resolve(revisionsDir, targetRevId);
  if (!revDir.startsWith(path.resolve(revisionsDir) + path.sep)) {
    throw new FlowError(
      'INVALID_STORY_ID',
      `[INVALID_STORY_ID] Revision directory escapes revisions directory: ${targetRevId}`,
      { storyId, targetRevId }
    );
  }
  // Physical containment: canonical target of the revision directory must
  // remain inside FLOW_HOME (catches junction/symlink escapes that pass the
  // lexical prefix check above).
  assertDirContained(revDir, root, storyId);

  const snapshotFile = path.join(revDir, 'snapshot.json');
  assertFileContained(snapshotFile, root, storyId);

  if (!fs.existsSync(snapshotFile)) {
    throw new FlowError(
      'SNAPSHOT_NOT_FOUND',
      `[SNAPSHOT_NOT_FOUND] Revision snapshot '${targetRevId}' missing for story ${storyId}`,
      { storyId, targetRevId }
    );
  }
  assertFileContained(snapshotFile, root, storyId);

  const snapshot = readVersionedJson(snapshotFile, { supported: [STORY_SNAPSHOT_VERSION] });

  // Cross-check snapshot identity
  if (snapshot.storyId !== storyId && snapshot.scriptId !== storyId) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Snapshot ID (${snapshot.storyId || snapshot.scriptId}) does not match requested ID (${storyId})`,
      { requestedId: storyId, snapshotStoryId: snapshot.storyId, snapshotScriptId: snapshot.scriptId }
    );
  }

  // Bind every loaded snapshot to its requested revision directory/ID,
  // including historical loads. revisionId is excluded from the digest, so a
  // forged snapshot.revisionId would otherwise pass digest verification.
  if (snapshot.revisionId !== targetRevId) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Snapshot revisionId (${snapshot.revisionId}) does not match requested revision (${targetRevId}) for story ${storyId}`,
      { storyId, requestedRevisionId: targetRevId, snapshotRevisionId: snapshot.revisionId }
    );
  }

  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision <= 0) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Snapshot revision must be a positive safe integer: ${snapshot.revision}`,
      { storyId, targetRevId, snapshotRevision: snapshot.revision }
    );
  }

  // Enforce current coherence whenever the selected revision IS the manifest's
  // current pointer, whether supplied explicitly (update/review) or implicitly
  // (status). Historical loads (target !== current) must not be compared to
  // the current manifest revision.
  const isCurrentPointer = targetRevId === manifest.currentRevisionId;
  // Cross-check manifest currentRevision against snapshot revision
  if (isCurrentPointer && manifest.currentRevision !== snapshot.revision) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Manifest currentRevision (${manifest.currentRevision}) contradicts snapshot revision (${snapshot.revision}) for story ${storyId}`,
      { storyId, manifestRevision: manifest.currentRevision, snapshotRevision: snapshot.revision }
    );
  }

  // Cross-check manifest currentRevisionId against snapshot revisionId
  if (isCurrentPointer && manifest.currentRevisionId !== snapshot.revisionId) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Manifest currentRevisionId (${manifest.currentRevisionId}) contradicts snapshot revisionId (${snapshot.revisionId}) for story ${storyId}`,
      { storyId, manifestRevisionId: manifest.currentRevisionId, snapshotRevisionId: snapshot.revisionId }
    );
  }

  // Verify digest integrity: digest must be non-empty string
  const expectedDigest = snapshot.digest;
  if (!expectedDigest || typeof expectedDigest !== 'string' || !expectedDigest.trim()) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Snapshot digest missing or empty for story ${storyId} rev ${targetRevId}`,
      { storyId, targetRevId }
    );
  }

  const contentToDigest = { ...snapshot };
  delete contentToDigest.digest;
  delete contentToDigest.revisionId;
  const computedDigest = computeCanonicalDigest(contentToDigest);

  if (computedDigest !== expectedDigest) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Snapshot digest mismatch for story ${storyId} rev ${targetRevId}`,
      { storyId, targetRevId, expected: expectedDigest, computed: computedDigest }
    );
  }

  // Verify that snapshot digest matches manifest currentDigest when loading the current revision
  if (targetRevId === manifest.currentRevisionId && expectedDigest !== manifest.currentDigest) {
    throw new FlowError(
      'STORAGE_CORRUPT',
      `[STORAGE_CORRUPT] Snapshot digest contradicts manifest currentDigest for story ${storyId}: snapshot=${expectedDigest} vs manifest=${manifest.currentDigest}`,
      { storyId, targetRevId, snapshotDigest: expectedDigest, manifestDigest: manifest.currentDigest }
    );
  }

  return snapshot;
}
export const getScript = getStory;

const safeStringify = (val) => (val === undefined ? '' : canonicalStringify(val));

/**
 * Semantically classifies changes between current and updated story models.
 */
function classifyModelChanges(current, updated) {
  const changes = [];

  // Characters
  const oldCharMap = new Map((current.bible?.characters || []).map((c) => [c.id, c]));
  for (const newChar of updated.bible?.characters || []) {
    const oldChar = oldCharMap.get(newChar.id);
    if (!oldChar) {
      changes.push({ nodeId: `char:${newChar.id}`, changeType: 'identity' });
    } else {
      const oldJson = canonicalStringify(oldChar);
      const newJson = canonicalStringify(newChar);
      if (oldJson !== newJson) {
        const appearanceDiff = safeStringify(oldChar.appearance) !== safeStringify(newChar.appearance);
        const promptDiff = (oldChar.prompt || '') !== (newChar.prompt || '');
        const descDiff = (oldChar.description || '') !== (newChar.description || '');
        const visualDiff =
          appearanceDiff ||
          promptDiff ||
          descDiff ||
          safeStringify(oldChar.visual) !== safeStringify(newChar.visual) ||
          safeStringify(oldChar.outfit) !== safeStringify(newChar.outfit) ||
          safeStringify(oldChar.reference_images) !== safeStringify(newChar.reference_images) ||
          safeStringify(oldChar.references) !== safeStringify(newChar.references) ||
          safeStringify(oldChar.traits) !== safeStringify(newChar.traits);

        if (visualDiff) {
          changes.push({ nodeId: `char:${newChar.id}`, changeType: 'identity' });
        } else {
          changes.push({ nodeId: `char:${newChar.id}`, changeType: 'metadata' });
        }
      }
    }
  }

  // Locations
  const oldLocMap = new Map((current.bible?.locations || []).map((l) => [l.id, l]));
  for (const newLoc of updated.bible?.locations || []) {
    const oldLoc = oldLocMap.get(newLoc.id);
    if (!oldLoc) {
      changes.push({ nodeId: `loc:${newLoc.id}`, changeType: 'identity' });
    } else {
      const oldJson = canonicalStringify(oldLoc);
      const newJson = canonicalStringify(newLoc);
      if (oldJson !== newJson) {
        const promptDiff = (oldLoc.prompt || '') !== (newLoc.prompt || '');
        const descDiff = (oldLoc.description || '') !== (newLoc.description || '');
        const envDiff = (oldLoc.environment || '') !== (newLoc.environment || '');
        const appearanceDiff = safeStringify(oldLoc.appearance) !== safeStringify(newLoc.appearance);
        const refDiff = safeStringify(oldLoc.reference_images) !== safeStringify(newLoc.reference_images);
        const visualDiff = promptDiff || descDiff || envDiff || appearanceDiff || refDiff;

        if (visualDiff) {
          changes.push({ nodeId: `loc:${newLoc.id}`, changeType: 'identity' });
        } else {
          changes.push({ nodeId: `loc:${newLoc.id}`, changeType: 'metadata' });
        }
      }
    }
  }

  // Props
  const oldPropMap = new Map((current.bible?.props || []).map((p) => [p.id, p]));
  for (const newProp of updated.bible?.props || []) {
    const oldProp = oldPropMap.get(newProp.id);
    if (!oldProp) {
      changes.push({ nodeId: `prop:${newProp.id}`, changeType: 'identity' });
    } else {
      const oldJson = canonicalStringify(oldProp);
      const newJson = canonicalStringify(newProp);
      if (oldJson !== newJson) {
        const promptDiff = (oldProp.prompt || '') !== (newProp.prompt || '');
        const descDiff = (oldProp.description || '') !== (newProp.description || '');
        const stateDiff = (oldProp.state || '') !== (newProp.state || '');
        const appearanceDiff = safeStringify(oldProp.appearance) !== safeStringify(newProp.appearance);
        const refDiff = safeStringify(oldProp.reference_images) !== safeStringify(newProp.reference_images);
        const visualDiff = promptDiff || descDiff || stateDiff || appearanceDiff || refDiff;

        if (visualDiff) {
          changes.push({ nodeId: `prop:${newProp.id}`, changeType: 'identity' });
        } else {
          changes.push({ nodeId: `prop:${newProp.id}`, changeType: 'metadata' });
        }
      }
    }
  }

  // Scenes
  const oldSceneMap = new Map((current.scenes || []).map((sc) => [sc.id, sc]));
  for (const newScene of updated.scenes || []) {
    const oldScene = oldSceneMap.get(newScene.id);
    if (!oldScene) {
      changes.push({ nodeId: `scene:${newScene.id}`, changeType: 'identity' });
    } else {
      const oldJson = canonicalStringify(oldScene);
      const newJson = canonicalStringify(newScene);
      if (oldJson !== newJson) {
        const locDiff = oldScene.locationId !== newScene.locationId;
        const promptDiff = (oldScene.prompt || '') !== (newScene.prompt || '');
        const descDiff = (oldScene.description || '') !== (newScene.description || '');
        const envDiff = (oldScene.environment || '') !== (newScene.environment || '');
        const identityDiff = locDiff || promptDiff || descDiff || envDiff;

        if (identityDiff) {
          changes.push({ nodeId: `scene:${newScene.id}`, changeType: 'identity' });
        } else {
          changes.push({ nodeId: `scene:${newScene.id}`, changeType: 'metadata' });
        }
      }
    }
  }

  // Shots
  const oldShotMap = new Map((current.shots || []).map((s) => [s.id, s]));
  for (const newShot of updated.shots || []) {
    const oldShot = oldShotMap.get(newShot.id);
    if (!oldShot) {
      changes.push({ nodeId: `shot:${newShot.id}`, changeType: 'identity' });
    } else {
      const oldJson = canonicalStringify(oldShot);
      const newJson = canonicalStringify(newShot);
      if (oldJson !== newJson) {
        const stateBeforeDiff = safeStringify(oldShot.expected_state_before) !== safeStringify(newShot.expected_state_before);
        const stateAfterDiff = safeStringify(oldShot.expected_state_after) !== safeStringify(newShot.expected_state_after);
        const hasStateDiff = stateBeforeDiff || stateAfterDiff;

        const hasIdentityDiff =
          (oldShot.prompt || '') !== (newShot.prompt || '') ||
          oldShot.sceneId !== newShot.sceneId ||
          oldShot.plannedSourceFrames !== newShot.plannedSourceFrames ||
          safeStringify(oldShot.trim) !== safeStringify(newShot.trim) ||
          safeStringify(oldShot.transitionHandles) !== safeStringify(newShot.transitionHandles) ||
          safeStringify(oldShot.entities) !== safeStringify(newShot.entities) ||
          safeStringify(oldShot.camera) !== safeStringify(newShot.camera) ||
          safeStringify(oldShot.dependencies) !== safeStringify(newShot.dependencies);

        if (hasIdentityDiff) {
          changes.push({ nodeId: `shot:${newShot.id}`, changeType: 'identity' });
        } else if (hasStateDiff) {
          changes.push({ nodeId: `shot:${newShot.id}`, changeType: 'continuity' });
        } else {
          changes.push({ nodeId: `shot:${newShot.id}`, changeType: 'metadata' });
        }
      }
    }
  }

  return changes;
}

/**
 * Updates story/script record under CAS lock:
 * 1. Verifies manifest.currentRevision === expectedRevision
 * 2. Writes new immutable revision snapshot FIRST
 * 3. Updates manifest pointer LAST
 */
export function updateStoryRecord(storyId, expectedRevision, patch = {}, { root = getRuntimeRoot() } = {}) {
  const manifestPath = getStoryManifestFile(storyId, root);
  assertFileContained(manifestPath, root, storyId);
  const lockFile = getStoryLockFile(storyId, root);
  assertFileContained(lockFile, root, storyId);
  const lock = acquireLock(lockFile);

  try {
    assertFileContained(manifestPath, root, storyId);
    if (!fs.existsSync(manifestPath)) {
      throw new FlowError('STORY_NOT_FOUND', `[STORY_NOT_FOUND] Story not found: ${storyId}`, { storyId });
    }
    assertFileContained(manifestPath, root, storyId);

    const manifest = readVersionedJson(manifestPath, { supported: [STORY_MANIFEST_VERSION] });
    if (manifest.currentRevision !== expectedRevision) {
      throw new FlowError(
        'STORAGE_CONFLICT',
        `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${manifest.currentRevision}`,
        {
          storyId,
          expectedRevision,
          actualRevision: manifest.currentRevision,
        }
      );
    }

    const currentSnapshot = getStory(storyId, { revisionId: manifest.currentRevisionId, root });

    const mergedInput = {
      binding: { ...currentSnapshot.binding, ...(patch.binding || {}) },
      policy: { ...currentSnapshot.policy, ...(patch.policy || {}) },
      governance: { ...currentSnapshot.governance, ...(patch.governance || {}) },
      brief: { ...currentSnapshot.brief, ...(patch.brief || {}) },
      bible: patch.bible
        ? {
            characters: patch.bible.characters ?? currentSnapshot.bible?.characters ?? [],
            locations: patch.bible.locations ?? currentSnapshot.bible?.locations ?? [],
            props: patch.bible.props ?? currentSnapshot.bible?.props ?? [],
          }
        : currentSnapshot.bible,
      scenes: patch.scenes ?? currentSnapshot.scenes,
      shots: patch.shots ?? currentSnapshot.shots,
      accountKey: patch.accountKey ?? currentSnapshot.binding.accountKey,
      projectId: patch.projectId ?? currentSnapshot.binding.projectId,
    };

    const validUpdated = validateStoryInput(mergedInput);
    const nodeDigests = computeNodeDigests(validUpdated);

    // Compute semantic changes and ensure any node with changed content digest is classified for invalidation
    const changes = classifyModelChanges(currentSnapshot, validUpdated);
    const changedNodeIds = new Set(changes.map((c) => c.nodeId));

    for (const [nodeId, newDig] of Object.entries(nodeDigests)) {
      const oldDig = currentSnapshot.nodeStates[nodeId]?.nodeDigest;
      if (oldDig && newDig && oldDig !== newDig && !changedNodeIds.has(nodeId)) {
        changes.push({ nodeId, changeType: 'identity' });
        changedNodeIds.add(nodeId);
      }
    }

    const dag = buildStoryDag(validUpdated);
    const invalidations = changes.length > 0
      ? computeSemanticInvalidations(dag, changes)
      : {
          invalidatedNodeIds: [],
          preservedNodeIds: Array.from(dag.nodes.keys()),
          affectedShots: [],
          affectedScenes: [],
          affectedEntities: [],
        };

    const nextRevision = manifest.currentRevision + 1;
    const now = new Date().toISOString();

    const nodeStates = { ...currentSnapshot.nodeStates };
    for (const [nodeId] of dag.nodes) {
      const oldState = currentSnapshot.nodeStates[nodeId];
      const newDigest = nodeDigests[nodeId] || null;
      const digestChanged = oldState && oldState.nodeDigest && newDigest && oldState.nodeDigest !== newDigest;
      const isInvalidated = invalidations.invalidatedNodeIds.includes(nodeId);

      if (!oldState) {
        nodeStates[nodeId] = {
          status: 'draft',
          revision: nextRevision,
          nodeDigest: newDigest,
          updatedAt: now,
          reviews: [],
        };
      } else if (digestChanged || isInvalidated) {
        // Any node whose content changed or which is semantically invalidated CANNOT remain approved!
        nodeStates[nodeId] = {
          ...oldState,
          status: 'stale',
          revision: nextRevision,
          nodeDigest: newDigest || oldState.nodeDigest,
          updatedAt: now,
        };
      } else {
        nodeStates[nodeId] = {
          ...oldState,
          nodeDigest: newDigest || oldState.nodeDigest,
        };
      }
    }

    const nextSnapshotContent = {
      v: STORY_SNAPSHOT_VERSION,
      storyId,
      scriptId: storyId,
      revision: nextRevision,
      parentRevisionId: manifest.currentRevisionId,
      createdAt: currentSnapshot.createdAt,
      updatedAt: now,
      binding: validUpdated.binding,
      policy: validUpdated.policy,
      governance: validUpdated.governance,
      brief: validUpdated.brief,
      bible: validUpdated.bible,
      scenes: validUpdated.scenes,
      shots: validUpdated.shots,
      timeline: validUpdated.timeline,
      nodeStates,
    };

    const digest = computeCanonicalDigest(nextSnapshotContent);
    const revisionId = `rev_${nextRevision}_${digest.slice(0, 8)}`;
    nextSnapshotContent.revisionId = revisionId;
    nextSnapshotContent.digest = digest;

    // 1. Commit immutable revision snapshot first (write-once enforcement)
    const revisionsDirForWrite = getStoryRevisionsDir(storyId, root);
    assertDirContained(revisionsDirForWrite, root, storyId);
    const revDir = path.join(revisionsDirForWrite, revisionId);
    assertDirContained(revDir, root, storyId);
    fs.mkdirSync(revDir, { recursive: true });
    assertDirContained(revDir, root, storyId);
    const snapshotFile = path.join(revDir, 'snapshot.json');
    assertFileContained(snapshotFile, root, storyId);
    if (fs.existsSync(snapshotFile)) {
      assertFileContained(snapshotFile, root, storyId);
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision snapshot already exists: ${revisionId}`, { storyId, revisionId });
    }
    atomicWriteJson(snapshotFile, nextSnapshotContent);

    // 2. Commit manifest pointer last
    const nextManifest = {
      v: STORY_MANIFEST_VERSION,
      storyId,
      scriptId: storyId,
      currentRevision: nextRevision,
      currentRevisionId: revisionId,
      currentDigest: digest,
      accountKey: validUpdated.binding.accountKey,
      projectId: validUpdated.binding.projectId,
      title: validUpdated.brief.title,
      createdAt: currentSnapshot.createdAt,
      updatedAt: now,
    };
    assertFileContained(manifestPath, root, storyId);
    atomicWriteJson(manifestPath, nextManifest);

    return { story: nextSnapshotContent, script: nextSnapshotContent, invalidations };
  } finally {
    lock.release();
  }
}
export const updateScriptRecord = updateStoryRecord;

/**
 * Lists all stored stories/scripts.
 */
export function listStories({ root = getRuntimeRoot() } = {}) {
  const seenIds = new Set();
  const summaries = [];

  const scanDir = (dir) => {
    try {
      assertDirContained(dir, root, '');
    } catch {
      return;
    }
    if (!fs.existsSync(dir)) return;
    let subdirs = [];
    try {
      subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return;
    }
    for (const dirent of subdirs) {
      if (seenIds.has(dirent.name)) continue;
      const entryDir = path.join(dir, dirent.name);
      try {
        assertDirContained(entryDir, root, dirent.name);
      } catch {
        continue;
      }
      const manifestPath = path.join(entryDir, 'manifest.json');
      try {
        assertFileContained(manifestPath, root, dirent.name);
      } catch {
        continue;
      }
      if (!fs.existsSync(manifestPath)) continue;

      try {
        assertFileContained(manifestPath, root, dirent.name);
        const manifest = readVersionedJson(manifestPath, { supported: [STORY_MANIFEST_VERSION] });
        if (manifest.storyId !== dirent.name && manifest.scriptId !== dirent.name) {
          continue;
        }
        seenIds.add(dirent.name);
        summaries.push({
          storyId: manifest.storyId || dirent.name,
          scriptId: manifest.scriptId || manifest.storyId || dirent.name,
          title: manifest.title || manifest.storyId || dirent.name,
          currentRevision: manifest.currentRevision,
          accountKey: manifest.accountKey,
          projectId: manifest.projectId,
          updatedAt: manifest.updatedAt,
        });
      } catch {
        // Ignore unparseable or corrupt entries in listing
      }
    }
  };

  scanDir(getScriptsDir(root));
  scanDir(getStoriesDir(root));

  return summaries;
}
export const listScripts = listStories;
