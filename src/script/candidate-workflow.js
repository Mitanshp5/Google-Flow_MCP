// W09 candidate workflow — local_import orchestration.
// Real retained originals via accepted media API, immutable candidate rows,
// stale-snapshot revalidation under lock. No Flow generation, no remote IDs,
// no fake media. Default planned intent stays prepare-only.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { getRuntimeRoot } from '../storage/runtime-store.js';
import { getStory, getScriptDir, getScriptLockFile, computeCanonicalDigest, assertDirContained, assertFileContained } from './store.js';
import { buildStoryDag } from './dag.js';
import { createCandidateJob, getCandidateJob, writeJobUpdate } from './candidate-jobs.js';
import { getCandidateAssetsDir, listCandidates, writeCandidateRecord } from './candidate-store.js';
import { retainImage, createContactSheet, probeImage } from '../media/candidate-images.js';
import { acquireLock } from '../storage/runtime-store.js';
import { sha256Hex } from '../assets/catalog.js';

function policyDigestOf(snapshot) {
  return computeCanonicalDigest({ binding: snapshot.binding, policy: snapshot.policy, governance: snapshot.governance });
}

export async function importLocalCandidates(input = {}, { root = getRuntimeRoot() } = {}) {
  const { scriptId, expectedRevision, nodeId, nodeDigest, source, files } = input;
  if (source !== 'local_import') {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] importLocalCandidates requires source local_import', { source });
  }
  const minWidth = input.minWidth ?? 1;
  const minHeight = input.minHeight ?? 1;

  // 1. Bounded durable job first: revision CAS, DAG binding, finite budget,
  // idempotent handle. Validates quantity==files.length etc via jobs layer.
  const job = await createCandidateJob(input, { root });

  // 2. Slow real decode/retention OUTSIDE the script lock (bounded, real
  // ffprobe+ffmpeg). Each file must be a verifiable single still; HTML,
  // truncated, preview/screenshot bytes fail here and publish nothing.
  const assetsDir = getCandidateAssetsDir(scriptId, root);
  const declaredRatio = input.ratio;
  const retained = [];
  for (const f of files) {
    const ret = await retainImage(f.path, { assetsDir, root, minWidth, minHeight, expectedRatio: declaredRatio });
    retained.push({ file: f, ret });
  }

  // 3. Publish under the shared script lock with stale-snapshot revalidation.
  // A concurrent update landing after the slow probe refuses publication.
  // The truthful job-stage commit happens AFTER lock release (helper owns its
  // lock; never nested).
  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  let deferredPublish = null;
  try {
    const snapshot = getStory(scriptId, { root });
    if (snapshot.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch on candidate publish: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId, expectedRevision, actualRevision: snapshot.revision });
    }
    let dag;
    try {
      dag = buildStoryDag(snapshot);
    } catch (e) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Script DAG unreadable for ${scriptId}: ${e.message}`, { scriptId });
    }
    if (!dag.nodes.has(nodeId)) {
      throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Node '${nodeId}' is not part of the active script DAG`, { scriptId, nodeId });
    }
    const currentDigest = snapshot.nodeStates?.[nodeId]?.nodeDigest;
    if (!currentDigest || currentDigest !== nodeDigest) {
      throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Job node digest stale for ${nodeId}; publish refused`, { nodeId });
    }
    if (policyDigestOf(snapshot) !== job.policyDigest) {
      throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job policy/binding changed; publish refused', { jobId: job.jobId });
    }
    // Re-read job under lock to ensure it still binds.
    const freshJob = getCandidateJob(scriptId, job.jobId, { root });
    if (freshJob.policyDigest !== job.policyDigest || freshJob.nodeDigest !== nodeDigest) {
      throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job changed before candidate publish; refusing', { jobId: job.jobId });
    }

    const existing = listCandidates(scriptId, { root, jobId: job.jobId });
    const incomingHashes = retained.map((r) => r.ret.hash.toLowerCase());
    const incomingRights = retained.map((r) => `${r.file.rights}::${r.file.rightsNote ?? ''}`);
    if (existing.length > 0) {
      // Variant-exact recovery: each retained child must match the incoming
      // declaration for its exact variantIndex (hash + rights/rightsNote).
      // Hash-only membership would conflate distinct variants sharing bytes.
      const existingByVariant = new Map();
      for (const c of existing) {
        if (existingByVariant.has(c.variantIndex)) {
          throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job already has different candidates; refusing to overwrite', { jobId: job.jobId });
        }
        existingByVariant.set(c.variantIndex, c);
      }
      for (const c of existing) {
        const idx = c.variantIndex;
        if (!Number.isInteger(idx) || idx < 0 || idx >= incomingHashes.length) {
          throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job already has different candidates; refusing to overwrite', { jobId: job.jobId });
        }
        const wantHash = incomingHashes[idx];
        const wantRights = incomingRights[idx];
        const gotRights = `${c.rights}::${c.rightsNote ?? ''}`;
        if (c.hash.toLowerCase() !== wantHash || gotRights !== wantRights) {
          throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job already has different candidates; refusing to overwrite', { jobId: job.jobId });
        }
      }
      // Full or partial match falls through to publish missing variants and
      // finish the truthful stage commit (no early planned return, no overwrite).
      if (existing.length > incomingHashes.length) {
        throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job already has different candidates; refusing to overwrite', { jobId: job.jobId });
      }
    }
    if (incomingHashes.length !== freshJob.quantity) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Candidate count ${incomingHashes.length} does not match job quantity ${freshJob.quantity}`, { jobId: job.jobId });
    }

    // Duplicate bytes: distinct candidate IDs, one blob, duplicateOf links.
    // Search all script candidates for prior same-hash (cross-job duplicates).
    const allForScript = listCandidates(scriptId, { root });
    const hashToFirst = new Map();
    for (const c of allForScript) {
      const h = c.hash.toLowerCase();
      if (!hashToFirst.has(h)) hashToFirst.set(h, c.candidateId);
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const alreadyPublished = listCandidates(scriptId, { root, jobId: job.jobId });
    const publishedByVariant = new Map(alreadyPublished.map((c) => [c.variantIndex, c]));
    const created = [];
    for (let i = 0; i < retained.length; i += 1) {
      if (publishedByVariant.has(i)) continue;
      const { file, ret } = retained[i];
      const hLower = ret.hash.toLowerCase();
      let duplicateOf = hashToFirst.get(hLower) ?? null;
      // Within-batch duplicates link to the first new candidate with same hash.
      if (!duplicateOf) {
        const priorNew = created.find((c) => c.hash.toLowerCase() === hLower);
        if (priorNew) duplicateOf = priorNew.candidateId;
      }
      const candidateId = crypto.randomUUID();
      const record = {
        v: 1,
        id: candidateId,
        candidateId,
        scriptId,
        jobId: job.jobId,
        scriptRevision: snapshot.revision,
        scriptRevisionId: snapshot.revisionId,
        scriptDigest: snapshot.digest,
        nodeId,
        nodeDigest,
        prompt: freshJob.prompt,
        promptDigest: freshJob.promptDigest,
        binding: freshJob.binding,
        policyDigest: freshJob.policyDigest,
        decisionScope: freshJob.decisionScope,
        model: freshJob.model,
        ratio: freshJob.ratio,
        variantIndex: i,
        sourceKind: 'local_import',
        provenance: 'local_import',
        rights: file.rights,
        ...(file.rightsNote !== undefined ? { rightsNote: file.rightsNote } : {}),
        path: ret.path,
        hash: ret.hash,
        sourceHash: ret.hash,
        exportHash: null,
        size: ret.size,
        mime: ret.mime,
        ext: ret.ext,
        width: ret.probe.width,
        height: ret.probe.height,
        duplicateOf,
        accountKey: snapshot.binding.accountKey,
        projectId: snapshot.binding.projectId,
        createdAt: nowIso,
        createdAtMs: nowMs,
      };
      const persisted = writeCandidateRecord(scriptId, record, { root });
      created.push(persisted);
      if (!hashToFirst.has(hLower)) hashToFirst.set(hLower, persisted.candidateId);
    }
    // Batch pointer last: full immutable set for this job (retained children +
    // newly published), ordered for stable idempotence comparison.
    const publishedForJob = [...alreadyPublished, ...created]
      .slice()
      .sort((a, b) => a.variantIndex - b.variantIndex);
    const totalBytes = publishedForJob.reduce((s, c) => s + (c.size ?? 0), 0);
    const dupCount = publishedForJob.filter((c) => c.duplicateOf !== null).length;
    deferredPublish = {
      publishedForJob,
      jobUpdate: {
        scriptId,
        jobId: job.jobId,
        expectedRevision,
        status: 'media-verified',
        nextAction: 'awaiting_client_review: local import retained; score candidates via flow_script_review action score_candidate, then select_reference.',
        mediaCounts: { candidates: publishedForJob.length, duplicates: dupCount, bytes: totalBytes },
      },
      freshJob,
    };
  } finally {
    lock.release();
  }
  // Post-lock truthful stage commit (helper acquires its own lock; never nested).
  // Children are already durably retained; a stage-commit conflict still returns
  // the immutable published set (recovery via idempotent retry).
  if (deferredPublish) {
    const { publishedForJob, jobUpdate, freshJob: publishedFreshJob } = deferredPublish;
    try {
      const updatedJob = await writeJobUpdate(jobUpdate, { root });
      return { ...updatedJob, candidates: publishedForJob };
    } catch {
      return { ...publishedFreshJob, candidates: publishedForJob };
    }
  }
  throw new FlowError('STORAGE_CORRUPT', '[STORAGE_CORRUPT] Local publish completed without a result set', { jobId: job.jobId });
}

export function getReviewsDir(scriptId, root = getRuntimeRoot()) {
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'reviews');
  assertDirContained(dir, root, scriptId);
  return dir;
}

// Labelled immutable contact sheet for a job's verified candidates.
// Root script expectedRevision CAS is mandatory; stale revision refuses.
// Every original is re-verified (containment, hash, real decode) before
// display via the accepted media API. No scoring, no remote URLs.
export async function createReviewSheet(input = {}, { root = getRuntimeRoot() } = {}) {
  const { scriptId, expectedRevision, jobId } = input;
  if (typeof scriptId !== 'string' || !scriptId) {
    throw new FlowError('INVALID_STORY_ID', '[INVALID_STORY_ID] scriptId is required for review-artifacts', { scriptId });
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] expectedRevision must be a positive integer: ${expectedRevision}`, { expectedRevision });
  }
  if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] review-artifacts requires a full jobId UUID', { jobId });
  }
  const snapshot = getStory(scriptId, { root });
  if (snapshot.revision !== expectedRevision) {
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId, expectedRevision, actualRevision: snapshot.revision });
  }
  const job = getCandidateJob(scriptId, jobId, { root });
  // When the caller repeats the bound intent, it must match the job; this
  // prevents a confused-deputy sheet for the wrong node/model.
  for (const k of ['nodeId', 'nodeDigest', 'model', 'ratio']) {
    if (input[k] !== undefined && input[k] !== job[k]) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] review-artifacts ${k} does not match job ${jobId}`, { [k]: input[k] });
    }
  }
  const cands = listCandidates(scriptId, { root, jobId });
  if (cands.length === 0) {
    throw new FlowError('OPERATION_NOT_FOUND', `[OPERATION_NOT_FOUND] No candidates for job ${jobId}; import first`, { jobId });
  }
  // Re-verify every original before any sheet write.
  for (const c of cands) {
    assertFileContained(c.path, root, scriptId);
    if (!fs.existsSync(c.path)) {
      throw new FlowError('MEDIA_NOT_FOUND', `[MEDIA_NOT_FOUND] Candidate file missing: ${c.candidateId}`, { candidateId: c.candidateId });
    }
    assertFileContained(c.path, root, scriptId);
    const bytes = fs.readFileSync(c.path);
    if (sha256Hex(bytes).toLowerCase() !== c.hash.toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed: ${c.candidateId}`, { candidateId: c.candidateId });
    }
    // Real decode (single still, dimensions) — rejects tampered/truncated.
    // Technical probe hash must match after asynchronous decode.
    assertFileContained(c.path, root, scriptId);
    const sheetProbe = await probeImage(c.path, { timeoutMs: 15000 });
    if (sheetProbe.hash.toLowerCase() !== c.hash.toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate decode hash mismatch: ${c.candidateId}`, { candidateId: c.candidateId });
    }
    // Final physical hash recheck before publish (mutation between decode and use).
    assertFileContained(c.path, root, scriptId);
    const recheck = fs.readFileSync(c.path);
    if (sha256Hex(recheck).toLowerCase() !== c.hash.toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed before sheet publish: ${c.candidateId}`, { candidateId: c.candidateId });
    }
  }
  const outputDir = getReviewsDir(scriptId, root);
  const sheetInputs = cands
    .slice()
    .sort((a, b) => a.variantIndex - b.variantIndex)
    .map((c) => ({
      candidateId: c.candidateId,
      path: c.path,
      hash: c.hash,
      label: `${c.nodeId} variant ${c.variantIndex}`,
      provenance: c.provenance,
    }));
  const sheet = await createContactSheet(sheetInputs, {
    outputDir,
    root,
    title: `Candidate review ${job.nodeId} job ${job.jobId.slice(0, 8)}`,
  });
  return {
    ...sheet,
    scriptId,
    jobId: job.jobId,
    nodeId: job.nodeId,
    scriptRevision: snapshot.revision,
    canSpend: false,
    liveVerified: false,
    nextAction: 'awaiting_client_review: score candidates via flow_script_review action score_candidate, then select_reference.',
  };
}
