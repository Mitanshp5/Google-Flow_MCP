import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleToolCall } from '../src/index.js';
import { initRuntimeDirs, atomicWriteJson } from '../src/storage/runtime-store.js';
import { getScriptDir, computeCanonicalDigest } from '../src/script/store.js';
import { getJobRecordPath } from '../src/script/candidate-jobs.js';
import { closeLogger } from '../src/utils/logger.js';
import { basePlan, runArgs, w09MkTemp, ensureLocalImage, callTool } from './helpers/w09-candidate-fixture.js';

const gates = () => Object.fromEntries(['subject_count', 'identity', 'state_continuity', 'artifacts', 'framing', 'dimensions', 'operation_refs'].map(k => [k, { result: 'pass' }]));
const ratings = { identity: 4, environment: 4, action: 4, composition: 4, technical: 4 };
const confidences = Object.fromEntries(Object.keys(ratings).map(k => [k, 0.9]));
const weights = { identity: 0.3, environment: 0.25, action: 0.2, composition: 0.15, technical: 0.1 };
let home;
let saved;
beforeEach(() => {
  saved = process.env.FLOW_HOME;
  home = w09MkTemp('w09-post-integration-');
  process.env.FLOW_HOME = home;
  initRuntimeDirs(home);
});
afterEach(async () => {
  await closeLogger();
  if (saved === undefined) delete process.env.FLOW_HOME;
  else process.env.FLOW_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function fixture(quantity = 1) {
  const plan = basePlan();
  const story = await callTool(handleToolCall, 'flow_script_create', plan);
  const file = await ensureLocalImage(path.join(home, 'fixture'), 'image.png');
  const args = runArgs(story.scriptId, 1, 'char:elena', story.nodeStates['char:elena'].nodeDigest, {
    source: 'local_import', ratio: '4:3', quantity, candidateLimit: quantity,
    files: Array.from({ length: quantity }, () => ({ path: file, rights: 'synthetic' })),
  });
  const job = await callTool(handleToolCall, 'flow_script_run', args);
  const candidate = job.candidates[0];
  const review = {
    scriptId: story.scriptId, expectedRevision: 1, nodeId: candidate.nodeId, nodeDigest: candidate.nodeDigest,
    candidateId: candidate.candidateId, candidateHash: candidate.hash, reviewer: 'local-filmmaker',
    reason: 'Explicit synthetic local fixture review', gates: gates(), ratings, confidences, weights, rubricVersion: 'post-integration-v1',
  };
  return { plan, story, args, job, candidate, review };
}
function rewriteRecord(file, mutate) {
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { digest: dropped, ...data } = old;
  void dropped;
  mutate(data);
  atomicWriteJson(file, { ...data, digest: computeCanonicalDigest(data) });
}

describe('W09 integrated manual-state and interrupted-batch boundaries', () => {
  it('a score from an older appearance cannot approve a new semantic state with the same prompt', async () => {
    const f = await fixture();
    await callTool(handleToolCall, 'flow_script_review', { ...f.review, action: 'score_candidate' });
    const bible = { ...f.plan.bible, characters: [{ ...f.plan.bible.characters[0], appearance: { hair: 'different authored identity' } }, ...f.plan.bible.characters.slice(1)] };
    const updated = await callTool(handleToolCall, 'flow_script_update', { scriptId: f.story.scriptId, expectedRevision: 1, patch: { bible } });
    // W08 already changes the complete semantic digest, despite unchanged prompt.
    expect(updated.nodeStates['char:elena'].nodeDigest).not.toBe(f.candidate.nodeDigest);
    await expect(callTool(handleToolCall, 'flow_script_review', {
      ...f.review, expectedRevision: 2, action: 'select_reference', expectedReferenceRevision: 0,
      consideredCandidateIds: [f.candidate.candidateId],
    })).rejects.toMatchObject({ code: 'REVIEW_DIGEST_MISMATCH' });
    // Explicit re-import binds new metadata to the new authored state, while
    // preserving the original blob and never silently carrying old approval.
    const rebound = await callTool(handleToolCall, 'flow_script_run', {
      ...f.args, expectedRevision: 2, nodeDigest: updated.nodeStates['char:elena'].nodeDigest,
    });
    const current = rebound.candidates[0];
    const currentReview = { ...f.review, expectedRevision: 2, nodeDigest: current.nodeDigest, candidateId: current.candidateId, candidateHash: current.hash };
    await callTool(handleToolCall, 'flow_script_review', { ...currentReview, action: 'score_candidate' });
    const selected = await callTool(handleToolCall, 'flow_script_review', {
      ...currentReview, action: 'select_reference', expectedReferenceRevision: 0,
      consideredCandidateIds: [current.candidateId],
    });
    expect(selected.scriptRevision).toBe(2);
  });

  it('valid-checksum malformed rating records fail closed through status', async () => {
    const f = await fixture();
    const score = await callTool(handleToolCall, 'flow_script_review', { ...f.review, action: 'score_candidate' });
    const file = path.join(getScriptDir(f.story.scriptId), 'candidates', 'scores', `${score.scoreId}.json`);
    rewriteRecord(file, data => { data.ratings.identity = 'not a numeric rating'; });
    await expect(callTool(handleToolCall, 'flow_script_status', { scriptId: f.story.scriptId })).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
  });

  it('interrupted duplicate-byte batches recover by variant, not by shared hash', async () => {
    const f = await fixture(2);
    expect(f.job.candidates).toHaveLength(2);
    expect(f.job.candidates[0].hash).toBe(f.job.candidates[1].hash);
    const first = f.job.candidates[0];
    const second = f.job.candidates[1];
    // Only test-owned records: reconstruct the durable state of interruption
    // after variant 0, before variant 1 and the final job-stage commit.
    fs.unlinkSync(path.join(getScriptDir(f.story.scriptId), 'candidates', 'candidates', `${second.candidateId}.json`));
    rewriteRecord(getJobRecordPath(f.story.scriptId, f.job.jobId), data => {
      data.status = 'planned'; delete data.mediaCounts;
    });
    const recovered = await callTool(handleToolCall, 'flow_script_run', f.args);
    expect(recovered.jobId).toBe(f.job.jobId);
    expect(recovered.deadlineAtMs).toBe(f.job.deadlineAtMs);
    expect(recovered.candidates).toHaveLength(2);
    expect(recovered.candidates.find(c => c.variantIndex === 0).candidateId).toBe(first.candidateId);
    expect(recovered.candidates.map(c => c.variantIndex).sort()).toEqual([0, 1]);
    expect(recovered.candidates[1].hash).toBe(first.hash);
  });
});
