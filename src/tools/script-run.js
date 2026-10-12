import { createCandidateJob } from '../script/candidate-jobs.js';
import { importLocalCandidates, createReviewSheet } from '../script/candidate-workflow.js';
import { hasCandidateTransport, runExecution } from '../script/candidate-execution.js';

export async function handleScriptRun(args) {
  const normalized = { ...args, scriptId: args?.scriptId ?? args?.storyId };
  // Review-artifacts stage produces a labelled immutable contact sheet for an
  // existing job's verified candidates. Root expectedRevision CAS mandatory.
  if (normalized?.stage === 'review-artifacts') {
    return createReviewSheet(normalized);
  }
  // Bounded explicit local import goes through real retention + immutable
  // candidate publish. Default (no source) stays planned prepare-only with
  // no browser acquisition, no spend.
  if (normalized?.source === 'local_import') {
    return importLocalCandidates(normalized);
  }
  // Trusted loopback fixture orchestration is selected ONLY by session scope
  // (AsyncLocalStorage candidateTransport). No MCP arg/config/env selects it;
  // production without scope stays planned with no browser acquisition.
  if (hasCandidateTransport()) {
    return runExecution(normalized);
  }
  return createCandidateJob(normalized);
}

export const handleStoryRun = handleScriptRun;
