import {
  commitPreparedGeneration,
  parseConfirmationQuote,
  characterImagePolicyQuote,
  readCommitQuote,
  detectNewMedia,
  snapshotMedia,
  resolveConfirmWaitMs,
  COMMIT_DEFAULT_WAIT_MS,
  COMMIT_MIN_WAIT_MS,
  COMMIT_MAX_WAIT_MS,
  COMMIT_POLL_STEP_MS,
} from '../domain/commit-prepared-generation.js';

export const GENERATE_CONFIRM_DEFAULT_WAIT_MS = COMMIT_DEFAULT_WAIT_MS;
export const GENERATE_CONFIRM_MIN_WAIT_MS = COMMIT_MIN_WAIT_MS;
export const GENERATE_CONFIRM_MAX_WAIT_MS = COMMIT_MAX_WAIT_MS;
export const GENERATE_CONFIRM_POLL_STEP_MS = COMMIT_POLL_STEP_MS;

export {
  parseConfirmationQuote,
  characterImagePolicyQuote,
  readCommitQuote,
  detectNewMedia,
  snapshotMedia,
  resolveConfirmWaitMs,
};

export async function handleGenerateConfirm(args = {}) {
  return commitPreparedGeneration(args);
}
