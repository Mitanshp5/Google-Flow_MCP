import { resumeCandidateJob } from '../script/candidate-jobs.js';
import { listCandidates } from '../script/candidate-store.js';
import { assertFileContained } from '../script/store.js';
import { getRuntimeRoot } from '../storage/runtime-store.js';
import fs from 'fs';
import { sha256Hex } from '../assets/catalog.js';
import { FlowError } from '../utils/errors.js';
import { hasCandidateTransport, resumeExecution } from '../script/candidate-execution.js';

export async function handleScriptResume(args) {
  const normalized = { ...args, scriptId: args?.scriptId ?? args?.storyId };
  if (hasCandidateTransport()) return resumeExecution(normalized);
  const resumed = await resumeCandidateJob(normalized);
  const scriptId = normalized.scriptId;
  // Reconcile durable candidates: verify file hashes still bind, report
  // resumable with measured elapsed and immutable deadline (never refreshed).
  // Tampered/missing files fail closed; no second submission is created.
  // Storage corruption/future-version/containment propagate unchanged (never
  // relabeled as a media error); only file-level failures map to media codes.
  let candidates = [];
  try {
    const root = getRuntimeRoot();
    candidates = listCandidates(scriptId).filter((c) => c.jobId === resumed.jobId).map((c) => {
      // Before EVERY stored c.path read, use accepted assertFileContained.
      assertFileContained(c.path, root, scriptId);
      if (!fs.existsSync(c.path)) {
        throw new FlowError('MEDIA_NOT_FOUND', `[MEDIA_NOT_FOUND] Candidate file missing: ${c.candidateId}`, { candidateId: c.candidateId, jobId: resumed.jobId });
      }
      assertFileContained(c.path, root, scriptId);
      const bytes = fs.readFileSync(c.path);
      if (sha256Hex(bytes).toLowerCase() !== c.hash.toLowerCase()) {
        throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed: ${c.candidateId}`, { candidateId: c.candidateId, jobId: resumed.jobId });
      }
      return {
        candidateId: c.candidateId, hash: c.hash, path: c.path,
        nodeId: c.nodeId, variantIndex: c.variantIndex, duplicateOf: c.duplicateOf,
      };
    });
  } catch (e) {
    // Never relabel storage corruption as a media error.
    if (e instanceof FlowError && (e.code === 'STORAGE_CORRUPT' || e.code === 'STORAGE_VERSION_UNSUPPORTED' || e.code === 'INVALID_STORY_ID')) throw e;
    if (e instanceof FlowError && (e.code === 'MEDIA_NOT_FOUND' || e.code === 'MEDIA_HASH_MISMATCH')) throw e;
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate file verification failed on resume: ${e.message}`, { jobId: resumed.jobId });
  }
  return { ...resumed, candidates, canSpend: false, liveVerified: false };
}

export const handleStoryResume = handleScriptResume;
