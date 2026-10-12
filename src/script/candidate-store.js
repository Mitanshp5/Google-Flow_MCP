// W09 candidate store — durable immutable candidate rows.
// Local import + fixture-transport candidates live below the protected script
// directory, using accepted containment/atomic/lock helpers. No parallel
// policy stack, no disposable debug metadata. Write-once immutable children;
// current is derived by revision ordering, old history preserved.
import fs from 'fs';
import path from 'path';
import { FlowError } from '../utils/errors.js';
import { getRuntimeRoot, atomicWriteJson, readVersionedJson } from '../storage/runtime-store.js';
import {
  getScriptDir,
  computeCanonicalDigest,
  assertDirContained,
  assertFileContained,
  SAFE_SCRIPT_ID_RE,
} from './store.js';
import { VALID_ASPECT_RATIOS, VALID_REFERENCE_RIGHTS } from './schema.js';

export const CANDIDATE_VERSION = 1;
export const CANDIDATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CANDIDATE_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
export const HASH_RE = /^[0-9a-f]{64}$/i;
export const NODE_ID_RE = /^(char|loc|prop|shot):[A-Za-z0-9_-]{1,64}$/;
export const VALID_SOURCE_KINDS = Object.freeze(['local_import', 'fixture_transport']);
export const VALID_RIGHTS = VALID_REFERENCE_RIGHTS;

function assertScriptId(scriptId) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] Invalid script ID: ${scriptId}`, { scriptId });
  }
}

export function getCandidatesRoot(scriptId, root = getRuntimeRoot()) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates');
  assertDirContained(dir, root, scriptId);
  return dir;
}

export function getCandidateRecordsDir(scriptId, root = getRuntimeRoot()) {
  assertScriptId(scriptId);
  const dir = path.join(getCandidatesRoot(scriptId, root), 'candidates');
  assertDirContained(dir, root, scriptId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  assertDirContained(dir, root, scriptId);
  return dir;
}

export function getCandidateAssetsDir(scriptId, root = getRuntimeRoot()) {
  assertScriptId(scriptId);
  const dir = path.join(getCandidatesRoot(scriptId, root), 'assets', 'originals');
  assertDirContained(dir, root, scriptId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  assertDirContained(dir, root, scriptId);
  return dir;
}

function candidateFileFor(recordsDir, candidateId, root, scriptId) {
  if (typeof candidateId !== 'string' || !CANDIDATE_ID_RE.test(candidateId)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateId must be a full UUID: ${candidateId}`, { candidateId });
  }
  const file = path.join(recordsDir, `${candidateId}.json`);
  assertFileContained(file, root, scriptId);
  return file;
}

function verifyChecksum(data, file) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate record invalid: ${file}`, { file });
  }
  const { digest, ...rest } = data;
  if (typeof digest !== 'string' || !digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate digest missing: ${file}`, { file });
  }
  let computed;
  try {
    computed = computeCanonicalDigest(rest);
  } catch {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate payload undigestible: ${file}`, { file });
  }
  if (computed !== digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate digest mismatch: ${file}`, { file });
  }
  return data;
}

function assertCandidateShape(c, file) {
  const bad = (field, detail) => {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate field invalid (${field}): ${file}`, { file, field, detail });
  };
  if (c.v !== CANDIDATE_VERSION) bad('v', c.v);
  if (typeof c.id !== 'string' || !CANDIDATE_ID_RE.test(c.id)) bad('id', c.id);
  if (typeof c.candidateId !== 'string' || !CANDIDATE_ID_RE.test(c.candidateId)) bad('candidateId', c.candidateId);
  if (c.id !== c.candidateId) bad('id/candidateId', 'mismatch');
  if (typeof c.scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(c.scriptId)) bad('scriptId', c.scriptId);
  if (typeof c.jobId !== 'string' || !CANDIDATE_ID_RE.test(c.jobId)) bad('jobId', c.jobId);
  if (!Number.isInteger(c.scriptRevision) || c.scriptRevision < 1) bad('scriptRevision', c.scriptRevision);
  if (typeof c.scriptRevisionId !== 'string' || !c.scriptRevisionId) bad('scriptRevisionId', c.scriptRevisionId);
  if (typeof c.scriptDigest !== 'string' || !HASH_RE.test(c.scriptDigest)) bad('scriptDigest', c.scriptDigest);
  if (typeof c.nodeId !== 'string' || !NODE_ID_RE.test(c.nodeId)) bad('nodeId', c.nodeId);
  if (typeof c.nodeDigest !== 'string' || !HASH_RE.test(c.nodeDigest)) bad('nodeDigest', c.nodeDigest);
  if (typeof c.prompt !== 'string' || !c.prompt.trim()) bad('prompt', 'missing');
  if (typeof c.promptDigest !== 'string' || !HASH_RE.test(c.promptDigest)) bad('promptDigest', c.promptDigest);
  if (!c.binding || typeof c.binding !== 'object' || Array.isArray(c.binding)) bad('binding', typeof c.binding);
  if (typeof c.policyDigest !== 'string' || !HASH_RE.test(c.policyDigest)) bad('policyDigest', c.policyDigest);
  if (typeof c.decisionScope !== 'string' || !HASH_RE.test(c.decisionScope)) bad('decisionScope', c.decisionScope);
  if (typeof c.model !== 'string' || !c.model.trim()) bad('model', c.model);
  if (typeof c.ratio !== 'string' || !VALID_ASPECT_RATIOS.includes(c.ratio)) bad('ratio', c.ratio);
  if (!Number.isInteger(c.variantIndex) || c.variantIndex < 0 || c.variantIndex > 3) bad('variantIndex', c.variantIndex);
  if (!VALID_SOURCE_KINDS.includes(c.sourceKind)) bad('sourceKind', c.sourceKind);
  if (typeof c.provenance !== 'string' || !c.provenance.trim()) bad('provenance', c.provenance);
  if (/flow-?generated/i.test(c.provenance)) bad('provenance', 'local import must never claim Flow-generated');
  if (!VALID_RIGHTS.includes(c.rights)) bad('rights', c.rights);
  if (c.rightsNote !== undefined && (typeof c.rightsNote !== 'string' || c.rightsNote.length > 500)) bad('rightsNote', c.rightsNote);
  if (typeof c.path !== 'string' || !c.path) bad('path', c.path);
  if (typeof c.hash !== 'string' || !HASH_RE.test(c.hash)) bad('hash', c.hash);
  if (typeof c.sourceHash !== 'string' || !HASH_RE.test(c.sourceHash)) bad('sourceHash', c.sourceHash);
  // Export/transcode hash is null when no real conversion exists; never guessed equal.
  if (c.exportHash !== null && (typeof c.exportHash !== 'string' || !HASH_RE.test(c.exportHash))) bad('exportHash', c.exportHash);
  // Fixture-transport operation linkage: absent (undefined, legacy local rows)
  // or null, otherwise strictly validated. Never fabricated.
  if (c.operationId !== undefined && c.operationId !== null && (typeof c.operationId !== 'string' || !c.operationId)) bad('operationId', c.operationId);
  if (c.operationNonce !== undefined && c.operationNonce !== null && (typeof c.operationNonce !== 'string' || !c.operationNonce)) bad('operationNonce', c.operationNonce);
  if (c.requestDigest !== undefined && c.requestDigest !== null && (typeof c.requestDigest !== 'string' || !HASH_RE.test(c.requestDigest))) bad('requestDigest', c.requestDigest);
  if (c.assetId !== undefined && c.assetId !== null && (typeof c.assetId !== 'string' || !c.assetId.trim() || c.assetId.length > 200)) bad('assetId', c.assetId);
  if (c.attribution !== undefined && c.attribution !== null && (typeof c.attribution !== 'string' || !c.attribution.trim() || c.attribution.length > 200)) bad('attribution', c.attribution);
  // Validated measured aspect of the retained bytes, separate from the
  // requested job ratio constraint (explicit allowed contract, no conflation).
  if (c.observedRatio !== undefined && c.observedRatio !== null && (typeof c.observedRatio !== 'number' || !Number.isFinite(c.observedRatio) || c.observedRatio <= 0)) bad('observedRatio', c.observedRatio);
  // Independently measured retained-bytes hash (dest read-back); null only
  // when the write path did not measure it (legacy rows).
  if (c.importHash !== undefined && c.importHash !== null && (typeof c.importHash !== 'string' || !HASH_RE.test(c.importHash))) bad('importHash', c.importHash);
  if (!Number.isInteger(c.size) || c.size <= 0) bad('size', c.size);
  if (typeof c.mime !== 'string' || !c.mime) bad('mime', c.mime);
  if (typeof c.ext !== 'string' || !c.ext) bad('ext', c.ext);
  if (!Number.isInteger(c.width) || c.width <= 0) bad('width', c.width);
  if (!Number.isInteger(c.height) || c.height <= 0) bad('height', c.height);
  if (c.duplicateOf !== null && (typeof c.duplicateOf !== 'string' || !CANDIDATE_ID_RE.test(c.duplicateOf))) bad('duplicateOf', c.duplicateOf);
  if (typeof c.accountKey !== 'string' || !c.accountKey.trim()) bad('accountKey', c.accountKey);
  if (typeof c.projectId !== 'string' || !c.projectId.trim()) bad('projectId', c.projectId);
  if (typeof c.createdAt !== 'string' || !c.createdAt) bad('createdAt', c.createdAt);
  if (typeof c.createdAtMs !== 'number' || !Number.isFinite(c.createdAtMs) || c.createdAtMs < 0) bad('createdAtMs', c.createdAtMs);
  return c;
}

function assertCandidatePathBinding(c, file, root, scriptId) {
  // Candidate metadata path must bind the controlled originals path/hash, not
  // an arbitrary outside file even with a valid checksum. Originals live at
  // <script>/candidates/assets/originals/<hash>.<ext>.
  const boundRoot = root ?? getRuntimeRoot();
  const boundScript = scriptId ?? c.scriptId;
  assertFileContained(c.path, boundRoot, boundScript);
  const assetsDir = getCandidateAssetsDir(boundScript, boundRoot);
  const resolvedPath = path.resolve(c.path);
  const resolvedAssets = path.resolve(assetsDir);
  if (resolvedPath !== resolvedAssets && !resolvedPath.startsWith(resolvedAssets + path.sep)) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate path escapes controlled originals: ${file}`, { file });
  }
  const base = path.basename(resolvedPath);
  const expectedBase = `${String(c.hash).toLowerCase()}.${c.ext}`;
  if (base.toLowerCase() !== expectedBase.toLowerCase()) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate path does not bind content hash: ${file}`, { file, base, expectedBase });
  }
  return c;
}

function readCandidateFile(file, { expectedCandidateId = null, scriptId = null, root = null } = {}) {
  const data = readVersionedJson(file, { supported: [CANDIDATE_VERSION] });
  verifyChecksum(data, file);
  assertCandidateShape(data, file);
  if (expectedCandidateId !== null && (data.id !== expectedCandidateId || data.candidateId !== expectedCandidateId)) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate id does not bind requested filename: ${file}`, { file, expectedCandidateId });
  }
  if (scriptId !== null && data.scriptId !== scriptId) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate script mismatch: ${file}`, { file, scriptId });
  }
  // Path binding propagates (malformed/future-version/containment already
  // propagated above); an outside path with a valid checksum still fails here.
  assertCandidatePathBinding(data, file, root, scriptId);
  return data;
}

function listCandidateFiles(recordsDir, root, scriptId) {
  if (!fs.existsSync(recordsDir)) return [];
  return fs.readdirSync(recordsDir)
    .filter((n) => {
      if (!CANDIDATE_FILENAME_RE.test(n)) {
        throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Unexpected file in candidates directory: ${n}`, { file: n });
      }
      return true;
    })
    .map((n) => {
      const file = path.join(recordsDir, n);
      assertFileContained(file, root, scriptId);
      return { file, candidateId: n.slice(0, -'.json'.length) };
    });
}

export function listCandidates(scriptId, { root = getRuntimeRoot(), jobId = null } = {}) {
  assertScriptId(scriptId);
  const recordsDir = path.join(getCandidatesRoot(scriptId, root), 'candidates');
  if (!fs.existsSync(recordsDir)) return [];
  assertDirContained(recordsDir, root, scriptId);
  const all = listCandidateFiles(recordsDir, root, scriptId)
    .map(({ file, candidateId }) => readCandidateFile(file, { expectedCandidateId: candidateId, scriptId, root }));
  const filtered = jobId ? all.filter((c) => c.jobId === jobId) : all;
  filtered.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || (a.variantIndex - b.variantIndex));
  return filtered;
}

export function getCandidate(scriptId, candidateId, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const recordsDir = path.join(getCandidatesRoot(scriptId, root), 'candidates');
  const file = candidateFileFor(recordsDir, candidateId, root, scriptId);
  if (!fs.existsSync(file)) {
    throw new FlowError('OPERATION_NOT_FOUND', `[OPERATION_NOT_FOUND] Candidate not found: ${candidateId}`, { scriptId, candidateId });
  }
  return readCandidateFile(file, { expectedCandidateId: candidateId, scriptId, root });
}

export function writeCandidateRecord(scriptId, record, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const recordsDir = getCandidateRecordsDir(scriptId, root);
  const file = candidateFileFor(recordsDir, record.candidateId, root, scriptId);
  if (record.scriptId !== scriptId) {
    throw new FlowError('STORAGE_CORRUPT', '[STORAGE_CORRUPT] Candidate script binding mismatch on write', { scriptId });
  }
  // Controlled-originals path binding enforced on write as well (no arbitrary
  // outside file even with a valid checksum shape).
  assertCandidatePathBinding(record, file, root, scriptId);
  // Write-once: never overwrite an existing immutable record.
  if (fs.existsSync(file)) {
    const existing = readCandidateFile(file, { expectedCandidateId: record.candidateId, scriptId, root });
    // Identical digest re-write is idempotent; different bytes are a conflict.
    if (existing.digest === record.digest) return { ...existing };
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Candidate already exists with different bytes: ${record.candidateId}`, { candidateId: record.candidateId });
  }
  const { digest: _drop, ...rest } = record;
  void _drop;
  const withDigest = { ...rest, digest: computeCanonicalDigest(rest) };
  // Shape + checksum before publish.
  assertCandidateShape(withDigest, file);
  verifyChecksum(withDigest, file);
  atomicWriteJson(file, withDigest);
  return { ...withDigest };
}

export function __candidateStoreInternals() {
  return { verifyChecksum, assertCandidateShape };
}
