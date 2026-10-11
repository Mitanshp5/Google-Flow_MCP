import fs from 'fs';
import path from 'path';
import { FlowError } from '../utils/errors.js';
import {
  saveNewStory,
  getStory,
  updateStoryRecord,
  getStoryManifestFile,
  getStoryLockFile,
  getStoryRevisionsDir,
  computeCanonicalDigest,
  assertDirContained,
  assertFileContained,
  STORY_MANIFEST_VERSION,
  STORY_SNAPSHOT_VERSION,
} from './store.js';
import { buildStoryDag } from './dag.js';
import {
  getRuntimeRoot,
  atomicWriteJson,
  readVersionedJson,
  acquireLock,
} from '../storage/runtime-store.js';

export const VALID_DECISIONS = Object.freeze(['approve', 'reject', 'revise', 'reset']);

/**
 * Computes actionable next planning steps based on current DAG and node statuses.
 * Invariant: Planning actions do not issue spendable approvals or enable generation.
 */
function computeNextActions(story, dag) {
  const actions = [];
  const nodeStates = story.nodeStates || {};

  // 1. Entities needing review / approval
  for (const [nodeId, node] of dag.nodes) {
    if (node.type === 'character' || node.type === 'location' || node.type === 'prop') {
      const state = nodeStates[nodeId];
      if (!state || state.status === 'draft' || state.status === 'stale') {
        actions.push({
          action: 'review_entity',
          nodeId,
          nodeDigest: state?.nodeDigest || null,
          type: node.type,
          title: `Establish and approve ${node.type}: ${node.data?.name || nodeId}`,
          priority: 'high',
        });
      }
    }
  }

  // 2. Scenes needing approval
  for (const [nodeId, node] of dag.nodes) {
    if (node.type === 'scene') {
      const state = nodeStates[nodeId];
      if (!state || state.status === 'draft' || state.status === 'stale') {
        actions.push({
          action: 'review_scene',
          nodeId,
          nodeDigest: state?.nodeDigest || null,
          type: 'scene',
          title: `Review scene: ${node.data?.title || nodeId}`,
          priority: 'medium',
        });
      }
    }
  }

  // 3. Shots ready for generation
  for (const [nodeId, node] of dag.nodes) {
    if (node.type === 'shot') {
      const state = nodeStates[nodeId];
      const deps = dag.getDependencies(nodeId);
      const unapprovedDeps = deps.filter((d) => {
        const srcId = d.prerequisite ?? d.source;
        return nodeStates[srcId]?.status !== 'approved';
      });

      if (unapprovedDeps.length === 0 && (!state || state.status !== 'approved')) {
        actions.push({
          action: 'prepare_shot',
          nodeId,
          nodeDigest: state?.nodeDigest || null,
          shotId: node.data?.id,
          title: `Plan take candidates for shot: ${node.data?.id}`,
          priority: 'high',
        });
      }
    }
  }

  return actions;
}

/**
 * Creates a new story, initializes DAG states, and calculates next actions.
 * Invariant: CanSpend remains strictly false.
 */
export function createStory(input, { root = getRuntimeRoot() } = {}) {
  const saved = saveNewStory(input, { root });
  const dag = buildStoryDag(saved);
  const nextActions = computeNextActions(saved, dag);

  return {
    storyId: saved.storyId,
    scriptId: saved.storyId,
    revision: saved.revision,
    revisionId: saved.revisionId,
    story: saved,
    script: saved,
    brief: saved.brief,
    timeline: saved.timeline,
    binding: saved.binding,
    policy: saved.policy,
    governance: saved.governance,
    nextActions,
    nodeStates: saved.nodeStates,
    canSpend: false,
    liveVerified: false,
  };
}

/**
 * Updates a story under CAS revision guard, computing semantic invalidations.
 */
export function updateStory({ storyId, expectedRevision, patch = {}, accountKey, projectId }, { root = getRuntimeRoot() } = {}) {
  const patchWithBindings = { ...patch };
  if (accountKey !== undefined) patchWithBindings.accountKey = accountKey;
  if (projectId !== undefined) patchWithBindings.projectId = projectId;

  const { story, invalidations } = updateStoryRecord(storyId, expectedRevision, patchWithBindings, { root });
  const dag = buildStoryDag(story);
  const nextActions = computeNextActions(story, dag);

  return {
    storyId: story.storyId,
    scriptId: story.storyId,
    revision: story.revision,
    revisionId: story.revisionId,
    story,
    script: story,
    invalidations,
    nextActions,
    nodeStates: story.nodeStates,
    canSpend: false,
    liveVerified: false,
  };
}

/**
 * Computes comprehensive story readiness status and unfulfilled dependencies per shot.
 */
export function getStoryStatus({ storyId, accountKey = null, projectId = null }, { root = getRuntimeRoot() } = {}) {
  const story = getStory(storyId, { root });

  if (accountKey && story.binding?.accountKey && story.binding.accountKey !== accountKey) {
    throw new FlowError(
      'BINDING_CONFLICT',
      `[BINDING_CONFLICT] Story bound to account ${story.binding.accountKey}, got ${accountKey}`,
      { storyId, expected: story.binding.accountKey, provided: accountKey }
    );
  }
  if (projectId && story.binding?.projectId && story.binding.projectId !== projectId) {
    throw new FlowError(
      'BINDING_CONFLICT',
      `[BINDING_CONFLICT] Story bound to project ${story.binding.projectId}, got ${projectId}`,
      { storyId, expected: story.binding.projectId, provided: projectId }
    );
  }

  const dag = buildStoryDag(story);
  const nodeStates = story.nodeStates || {};

  const summary = {
    draft: 0,
    stale: 0,
    ready: 0,
    approved: 0,
    rejected: 0,
    total: dag.nodes.size,
  };

  for (const [nodeId] of dag.nodes) {
    const status = nodeStates[nodeId]?.status || 'draft';
    if (summary[status] !== undefined) {
      summary[status] += 1;
    }
  }

  const shotsSummary = [];
  for (const shot of story.shots || []) {
    const nodeId = `shot:${shot.id}`;
    const deps = dag.getDependencies(nodeId);
    const blocking = [];

    for (const d of deps) {
      const srcId = d.prerequisite ?? d.source;
      if (nodeStates[srcId]?.status !== 'approved') {
        blocking.push(srcId);
      }
    }

    shotsSummary.push({
      shotId: shot.id,
      sceneId: shot.sceneId,
      status: nodeStates[nodeId]?.status || 'draft',
      readyForGeneration: blocking.length === 0,
      blockingPrerequisites: blocking,
    });
  }

  const nextActions = computeNextActions(story, dag);

  return {
    storyId: story.storyId,
    scriptId: story.scriptId || story.storyId,
    revision: story.revision,
    revisionId: story.revisionId,
    title: story.brief?.title || story.storyId,
    timeline: story.timeline,
    binding: story.binding,
    policy: story.policy,
    governance: story.governance,
    nodeSummary: summary,
    shotsSummary,
    nodeStates,
    nextActions,
    canSpend: false,
    liveVerified: false,
  };
}

/**
 * Reviews a specific story DAG node (approving, rejecting, or marking for revision).
 * Requires exact nodeDigest and reviewer identity.
 */
export function reviewStoryNode(
  { storyId, expectedRevision, nodeId, nodeDigest, reviewer, decision, notes = '' },
  { root = getRuntimeRoot() } = {}
) {
  if (!VALID_DECISIONS.includes(decision)) {
    throw new FlowError(
      'INVALID_REVIEW_DECISION',
      `[INVALID_REVIEW_DECISION] Invalid decision '${decision}'. Must be one of: ${VALID_DECISIONS.join(', ')}`,
      { decision }
    );
  }

  if (typeof reviewer !== 'string' || !reviewer.trim()) {
    throw new FlowError(
      'REVIEWER_REQUIRED',
      '[REVIEWER_REQUIRED] Review requires a non-empty reviewer identity',
      { reviewer }
    );
  }

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

    const currentDag = buildStoryDag(currentSnapshot);
    if (!currentDag.nodes.has(nodeId)) {
      throw new FlowError(
        'NODE_NOT_FOUND',
        `[NODE_NOT_FOUND] Node '${nodeId}' is not part of the active script DAG in story ${storyId}`,
        { storyId, nodeId }
      );
    }

    if (!currentSnapshot.nodeStates || !currentSnapshot.nodeStates[nodeId]) {
      throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Node '${nodeId}' not found in story ${storyId}`, {
        storyId,
        nodeId,
      });
    }

    const currentNodeState = currentSnapshot.nodeStates[nodeId];

    // Verify nodeDigest is mandatory and matches current digest
    if (!nodeDigest || typeof nodeDigest !== 'string' || !nodeDigest.trim()) {
      throw new FlowError(
        'REVIEW_DIGEST_REQUIRED',
        `[REVIEW_DIGEST_REQUIRED] nodeDigest is mandatory for review submission on node '${nodeId}'`,
        { nodeId, storyId }
      );
    }

    const cleanDigest = nodeDigest.trim();
    if (!currentNodeState.nodeDigest || cleanDigest !== currentNodeState.nodeDigest) {
      throw new FlowError(
        'REVIEW_DIGEST_MISMATCH',
        `[REVIEW_DIGEST_MISMATCH] Stale review submission for ${nodeId}: node content digest has changed`,
        {
          nodeId,
          expectedDigest: cleanDigest,
          currentDigest: currentNodeState.nodeDigest,
        }
      );
    }

    const statusMap = {
      approve: 'approved',
      reject: 'rejected',
      revise: 'stale',
      reset: 'draft',
    };

    const targetStatus = statusMap[decision];
    const nextRevision = manifest.currentRevision + 1;
    const now = new Date().toISOString();

    const reviewRecord = {
      reviewer,
      decision,
      targetStatus,
      nodeDigest: cleanDigest,
      notes,
      reviewedAt: now,
      revision: nextRevision,
    };

    const nextNodeStates = {
      ...currentSnapshot.nodeStates,
      [nodeId]: {
        ...currentNodeState,
        status: targetStatus,
        revision: nextRevision,
        updatedAt: now,
        reviews: [...(currentNodeState.reviews || []), reviewRecord],
      },
    };

    const nextSnapshotContent = {
      v: STORY_SNAPSHOT_VERSION,
      storyId,
      scriptId: storyId,
      revision: nextRevision,
      parentRevisionId: manifest.currentRevisionId,
      createdAt: currentSnapshot.createdAt,
      updatedAt: now,
      binding: currentSnapshot.binding,
      policy: currentSnapshot.policy,
      governance: currentSnapshot.governance,
      brief: currentSnapshot.brief,
      bible: currentSnapshot.bible,
      scenes: currentSnapshot.scenes,
      shots: currentSnapshot.shots,
      timeline: currentSnapshot.timeline,
      nodeStates: nextNodeStates,
    };

    const digest = computeCanonicalDigest(nextSnapshotContent);
    const revisionId = `rev_${nextRevision}_${digest.slice(0, 8)}`;
    nextSnapshotContent.revisionId = revisionId;
    nextSnapshotContent.digest = digest;

    // 1. Commit immutable revision snapshot first (write-once enforcement)
    const revisionsDirForReview = getStoryRevisionsDir(storyId, root);
    assertDirContained(revisionsDirForReview, root, storyId);
    const revDir = path.join(revisionsDirForReview, revisionId);
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
      accountKey: currentSnapshot.binding.accountKey,
      projectId: currentSnapshot.binding.projectId,
      title: currentSnapshot.brief.title,
      createdAt: currentSnapshot.createdAt,
      updatedAt: now,
    };
    assertFileContained(manifestPath, root, storyId);
    atomicWriteJson(manifestPath, nextManifest);

    return {
      story: nextSnapshotContent,
      script: nextSnapshotContent,
      decision,
      nodeId,
      canSpend: false,
      liveVerified: false,
    };
  } finally {
    lock.release();
  }
}

export const createScript = createStory;
export const updateScript = updateStory;
export const getScriptStatus = getStoryStatus;
export const reviewScriptNode = reviewStoryNode;
