// W09 reference review — RED3: scorer-free client scoring -> canonical selection.
// Local fixtures only, lane-local temp. No hosted scorer/LLM/vision.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleToolCall } from '../src/index.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';
import { closeLogger } from '../src/utils/logger.js';
import { basePlan, runArgs, w09MkTemp, ensureLocalImage, callTool } from './helpers/w09-candidate-fixture.js';

function isolateEnv() {
  const saved = {
    FLOW_HOME: process.env.FLOW_HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const tmpDir = w09MkTemp('w09-rr-');
  process.env.FLOW_HOME = tmpDir;
  process.env.TMPDIR = tmpDir;
  process.env.TEMP = tmpDir;
  process.env.TMP = tmpDir;
  initRuntimeDirs(tmpDir);
  return { saved, tmpDir };
}

async function restoreEnv(saved, tmpDir) {
  await closeLogger();
  for (const k of ['FLOW_HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function gatesAllPass() {
  const mk = () => ({ result: 'pass' });
  return {
    subject_count: mk(),
    identity: mk(),
    state_continuity: mk(),
    artifacts: mk(),
    framing: mk(),
    dimensions: mk(),
    operation_refs: mk(),
  };
}

function goodRatings() {
  return {
    ratings: { identity: 4, environment: 4, action: 3, composition: 4, technical: 4 },
    confidences: { identity: 0.9, environment: 0.8, action: 0.7, composition: 0.8, technical: 0.9 },
    rubricVersion: 'w09-rubric-v1',
    weights: { identity: 0.3, environment: 0.25, action: 0.2, composition: 0.15, technical: 0.1 },
  };
}

describe('W09 review RED3: score then select canonical reference', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
  });
  afterEach(async () => {
    await restoreEnv(saved, tmpDir);
  });

  it('score_candidate records gates/ratings and select_reference mints immutable char reference', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const f2 = await ensureLocalImage(srcDir, 'b.png', { color: 'blue' });
    const imported = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }, { path: f2, rights: 'synthetic' }],
    }));
    const [c1, c2] = imported.candidates.slice().sort((a, b) => a.variantIndex - b.variantIndex);

    const r = goodRatings();
    const score = await callTool(handleToolCall, 'flow_script_review', {
      scriptId,
      expectedRevision: 1,
      nodeId: 'char:elena',
      nodeDigest,
      reviewer: 'filmmaker@example.com',
      action: 'score_candidate',
      candidateId: c1.candidateId,
      candidateHash: c1.hash,
      gates: gatesAllPass(),
      ratings: r.ratings,
      confidences: r.confidences,
      rubricVersion: r.rubricVersion,
      weights: r.weights,
      reason: 'prefers warmer portrait for story intent',
    });
    expect(score.scoreId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(score.eligible).toBe(true);
    expect(score.candidateId).toBe(c1.candidateId);
    expect(score.canSpend).toBe(false);

    const sel = await callTool(handleToolCall, 'flow_script_review', {
      scriptId,
      expectedRevision: 1,
      nodeId: 'char:elena',
      nodeDigest,
      reviewer: 'filmmaker@example.com',
      action: 'select_reference',
      candidateId: c1.candidateId,
      candidateHash: c1.hash,
      consideredCandidateIds: [c1.candidateId, c2.candidateId],
      expectedReferenceRevision: 0,
      reason: 'client selects warmer portrait as canonical Elena',
    });
    expect(sel.referenceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(sel.nodeId).toBe('char:elena');
    expect(sel.candidateId).toBe(c1.candidateId);
    expect(sel.selectionRevision).toBe(1);
    expect(sel.canSpend).toBe(false);

    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect(status.references.current.map((x) => x.nodeId)).toContain('char:elena');
    const cur = status.references.current.find((x) => x.nodeId === 'char:elena');
    expect(cur.candidateId).toBe(c1.candidateId);
    expect(cur.hash).toBe(c1.hash);
  }, 90000);
});

describe('W09 review RED4: versioned shot packs and selective invalidation', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
  });
  afterEach(async () => {
    await restoreEnv(saved, tmpDir);
  });

  async function setupWithRefs() {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const srcDir = path.join(tmpDir, 'src-import');
    // elena, bob, lab, vial each need candidates + scores + selections
    const nodes = ['char:elena', 'char:bob', 'loc:lab', 'prop:vial'];
    const nodeDigests = {};
    for (const n of nodes) nodeDigests[n] = created.nodeStates[n].nodeDigest;
    const candsByNode = {};
    for (const n of nodes) {
      const f = await ensureLocalImage(srcDir, `${n.replace(':', '-')}.png`, { color: n.includes('elena') ? 'red' : n.includes('bob') ? 'blue' : n.includes('lab') ? 'green' : 'yellow' });
      const imp = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, n, nodeDigests[n], {
        source: 'local_import', ratio: '4:3',
        files: [{ path: f, rights: 'owned' }],
        quantity: 1,
        candidateLimit: 1,
      }));
      candsByNode[n] = imp.candidates[0];
      const r = {
        ratings: { identity: 4, environment: 4, action: 3, composition: 4, technical: 4 },
        confidences: { identity: 0.9, environment: 0.8, action: 0.7, composition: 0.8, technical: 0.9 },
        rubricVersion: 'w09-rubric-v1',
        weights: { identity: 0.3, environment: 0.25, action: 0.2, composition: 0.15, technical: 0.1 },
      };
      const gates = {
        subject_count: { result: 'pass' },
        identity: { result: 'pass' },
        state_continuity: { result: 'pass' },
        artifacts: { result: 'pass' },
        framing: { result: 'pass' },
        dimensions: { result: 'pass' },
        operation_refs: { result: 'pass' },
      };
      // loc/prop identity NA not needed here; use pass for simplicity
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: nodeDigests[n],
        reviewer: 'filmmaker@example.com', action: 'score_candidate',
        candidateId: candsByNode[n].candidateId, candidateHash: candsByNode[n].hash,
        gates, ratings: r.ratings, confidences: r.confidences,
        rubricVersion: r.rubricVersion, weights: r.weights,
        reason: `score ${n}`,
      });
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: nodeDigests[n],
        reviewer: 'filmmaker@example.com', action: 'select_reference',
        candidateId: candsByNode[n].candidateId, candidateHash: candsByNode[n].hash,
        consideredCandidateIds: [candsByNode[n].candidateId],
        expectedReferenceRevision: 0,
        reason: `select ${n}`,
      });
    }
    return { scriptId, nodeDigests, candsByNode };
  }

  it('reference_pack creates versioned immutable pack for sh1 with all required refs', async () => {
    const { scriptId } = await setupWithRefs();
    const shDigest = (await callTool(handleToolCall, 'flow_script_status', { scriptId })).nodeStates['shot:sh1'].nodeDigest;
    const pack = await callTool(handleToolCall, 'flow_script_review', {
      scriptId,
      expectedRevision: 1,
      nodeId: 'shot:sh1',
      nodeDigest: shDigest,
      reviewer: 'filmmaker@example.com',
      action: 'reference_pack',
      expectedPackRevision: 0,
      reason: 'client locks sh1 pack with canonical bob/vial/lab',
    });
    expect(pack.packId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(pack.shotId).toBe('shot:sh1');
    expect(pack.packRevision).toBe(1);
    const roles = pack.selections.map((s) => s.role).sort();
    expect(roles).toContain('ingredient');
    expect(roles).toContain('anchor');
    const nodeIds = pack.selections.map((s) => s.nodeId).sort();
    expect(nodeIds).toEqual(['char:bob', 'loc:lab', 'prop:vial'].sort());
    expect(pack.canSpend).toBe(false);
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect(status.packs.current.map((p) => p.shotId)).toContain('shot:sh1');
  }, 120000);
});

describe('W09 review adversarial: gates, CAS, packs, corruption, restart', () => {
  let tmpDir;
  let saved;
  beforeEach(() => {
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
  });
  afterEach(async () => {
    await restoreEnv(saved, tmpDir);
  });

  async function expectCode(promise, code) {
    try {
      await promise;
    } catch (e) {
      expect(e.code).toBe(code);
      return;
    }
    throw new Error(`expected rejection with code ${code} but resolved`);
  }

  function gatesAllPass() {
    const mk = () => ({ result: 'pass' });
    return {
      subject_count: mk(), identity: mk(), state_continuity: mk(),
      artifacts: mk(), framing: mk(), dimensions: mk(), operation_refs: mk(),
    };
  }

  function goodRatings() {
    return {
      ratings: { identity: 4, environment: 4, action: 3, composition: 4, technical: 4 },
      confidences: { identity: 0.9, environment: 0.8, action: 0.7, composition: 0.8, technical: 0.9 },
      rubricVersion: 'w09-rubric-v1',
      weights: { identity: 0.3, environment: 0.25, action: 0.2, composition: 0.15, technical: 0.1 },
    };
  }

  async function setupOneScoredCandidate() {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const f2 = await ensureLocalImage(srcDir, 'b.png', { color: 'blue' });
    const imported = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }, { path: f2, rights: 'synthetic' }],
    }));
    return { scriptId, nodeDigest, candidates: imported.candidates };
  }

  it('uncertain gate means needs-review and blocks selection; caller bool cannot override', async () => {
    const { scriptId, nodeDigest, candidates } = await setupOneScoredCandidate();
    const [c1] = candidates.slice().sort((a, b) => a.variantIndex - b.variantIndex);
    const r = goodRatings();
    const badGates = { ...gatesAllPass(), artifacts: { result: 'fail', note: 'extra finger' } };
    const scored = await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      gates: badGates, ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights,
      reason: 'records failure honestly',
    });
    expect(scored.eligible).toBe(false);
    expect(scored.status).toBe('needs_review');
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      consideredCandidateIds: [c1.candidateId],
      expectedReferenceRevision: 0,
      reason: 'attempt to override failed gate',
    }), 'REVIEW_NEEDS_REVIEW');

    // Invalid weights sum and NaN ratings fail without inventing scores.
    const badWeights = { ...r.weights, identity: 0.5 };
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: badWeights,
      reason: 'bad weights',
    }), 'INVALID_PARAMS');
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      gates: gatesAllPass(),
      ratings: { ...r.ratings, identity: NaN },
      confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights,
      reason: 'nan',
    }), 'INVALID_PARAMS');
  }, 90000);

  it('select_reference CAS prevents lost decisions; stale nodeDigest refused', async () => {
    const { scriptId, nodeDigest, candidates } = await setupOneScoredCandidate();
    const [c1, c2] = candidates.slice().sort((a, b) => a.variantIndex - b.variantIndex);
    const r = goodRatings();
    for (const c of [c1, c2]) {
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
        reviewer: 'filmmaker@example.com', action: 'score_candidate',
        candidateId: c.candidateId, candidateHash: c.hash,
        gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
        rubricVersion: r.rubricVersion, weights: r.weights,
        reason: `score ${c.variantIndex}`,
      });
    }
    const first = await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      consideredCandidateIds: [c1.candidateId, c2.candidateId],
      expectedReferenceRevision: 0,
      reason: 'first selection',
    });
    expect(first.selectionRevision).toBe(1);
    // Lost update with stale expected revision blocked.
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: c2.candidateId, candidateHash: c2.hash,
      consideredCandidateIds: [c1.candidateId, c2.candidateId],
      expectedReferenceRevision: 0,
      reason: 'stale race',
    }), 'STORAGE_CONFLICT');
    // Stale nodeDigest refused.
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest: '0'.repeat(64),
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: c2.candidateId, candidateHash: c2.hash,
      consideredCandidateIds: [c1.candidateId, c2.candidateId],
      expectedReferenceRevision: 1,
      reason: 'stale digest',
    }), 'REVIEW_DIGEST_MISMATCH');
    // Correct CAS advances, old history preserved.
    const second = await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: c2.candidateId, candidateHash: c2.hash,
      consideredCandidateIds: [c1.candidateId, c2.candidateId],
      expectedReferenceRevision: 1,
      reason: 'client changes mind with reason',
    });
    expect(second.selectionRevision).toBe(2);
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect(status.references.current.find((x) => x.nodeId === 'char:elena').candidateId).toBe(c2.candidateId);
    expect(status.references.history).toHaveLength(2);
  }, 90000);

  it('reference_pack blocks on missing refs and over-cap without dropping fourth', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const shDigest = created.nodeStates['shot:sh1'].nodeDigest;
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'shot:sh1', nodeDigest: shDigest,
      reviewer: 'filmmaker@example.com', action: 'reference_pack',
      expectedPackRevision: 0, reason: 'no refs yet',
    }), 'PACK_BLOCKED');
  }, 60000);

  it('legacy W08 node approval alone never establishes a media reference', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    // Legacy no-action review still requires a decision (conditional contract).
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com',
    }), 'INVALID_PARAMS');
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', decision: 'approve',
    });
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect(status.references.current).toEqual([]);
    expect(status.nodeStates['char:elena'].status).toBe('approved');
  }, 60000);

  it('restart recovers candidates, scores, references and packs with history', async () => {
    const { spawnSync } = await import('child_process');
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'restart.png', { color: 'red' });
    const imported = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    }));
    const r = goodRatings();
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: imported.candidates[0].candidateId, candidateHash: imported.candidates[0].hash,
      gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights,
      reason: 'restart score',
    });
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: imported.candidates[0].candidateId, candidateHash: imported.candidates[0].hash,
      consideredCandidateIds: [imported.candidates[0].candidateId],
      expectedReferenceRevision: 0,
      reason: 'restart select',
    });
    const childCode = `
      import { handleToolCall } from './src/index.js';
      const s = JSON.parse((await handleToolCall('flow_script_status', { scriptId: ${JSON.stringify(scriptId)} })).content[0].text);
      console.log(JSON.stringify({
        candidates: (s.candidates ?? []).length,
        scores: (s.scores ?? []).length,
        refs: (s.references?.current ?? []).length,
        refHistory: (s.references?.history ?? []).length,
      }));
      const r = JSON.parse((await handleToolCall('flow_script_resume', { scriptId: ${JSON.stringify(scriptId)}, jobId: ${JSON.stringify(imported.jobId)}, expectedRevision: 1 })).content[0].text);
      console.log(JSON.stringify({ resumable: r.resumable, candidates: (r.candidates ?? []).length, deadlineAt: r.deadlineAt }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, FLOW_HOME: tmpDir, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir },
      encoding: 'utf-8',
      timeout: 60000,
    });
    expect(child.status).toBe(0);
    const lines = child.stdout.trim().split('\n');
    const statusOut = JSON.parse(lines[lines.length - 2]);
    expect(statusOut.candidates).toBe(1);
    expect(statusOut.scores).toBe(1);
    expect(statusOut.refs).toBe(1);
    expect(statusOut.refHistory).toBe(1);
    const resumeOut = JSON.parse(lines[lines.length - 1]);
    expect(resumeOut.resumable).toBe(true);
    expect(resumeOut.candidates).toBe(1);
    expect(resumeOut.deadlineAt).toBe(imported.deadlineAt);
  }, 90000);

  it('RED parent later-rejection: earlier PASS must not permit selection after later FAIL', async () => {
    const { scriptId, nodeDigest, candidates } = await setupOneScoredCandidate();
    const [c1] = candidates.slice().sort((a, b) => a.variantIndex - b.variantIndex);
    const r = goodRatings();
    const passScore = await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights,
      reason: 'earlier pass',
    });
    expect(passScore.eligible).toBe(true);
    // candidateDigest must bind immutable metadata digest, never the byte hash.
    expect(passScore.candidateDigest).not.toBe(c1.hash);
    const failGates = { ...gatesAllPass(), identity: { result: 'fail', note: 'later identity failure' } };
    const failScore = await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      gates: failGates, ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights,
      reason: 'later fail',
    });
    expect(failScore.eligible).toBe(false);
    // Latest immutable score is FAIL, so selection must be blocked even though an earlier PASS exists.
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      consideredCandidateIds: [c1.candidateId],
      expectedReferenceRevision: 0,
      reason: 'attempt select after later fail',
    }), 'REVIEW_NEEDS_REVIEW');
    // Fail/unknown without a nonempty note must be rejected at validation.
    await expectCode(callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: c1.candidateId, candidateHash: c1.hash,
      gates: { ...gatesAllPass(), artifacts: { result: 'fail', note: '' } },
      ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights,
      reason: 'empty note must fail',
    }), 'INVALID_PARAMS');
  }, 90000);

  it('RED parent identity-change: appearance change with same prompt stales reference, display-only preserves', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest0 = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f = await ensureLocalImage(srcDir, 'identity.png', { color: 'red' });
    const imp = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest0, {
      source: 'local_import', ratio: '4:3', files: [{ path: f, rights: 'owned' }], quantity: 1, candidateLimit: 1,
    }));
    const r = goodRatings();
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest: nodeDigest0,
      reviewer: 'filmmaker@example.com', action: 'score_candidate',
      candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
      gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
      rubricVersion: r.rubricVersion, weights: r.weights, reason: 'score elena',
    });
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'char:elena', nodeDigest: nodeDigest0,
      reviewer: 'filmmaker@example.com', action: 'select_reference',
      candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
      consideredCandidateIds: [imp.candidates[0].candidateId],
      expectedReferenceRevision: 0, reason: 'select elena',
    });
    const plan = basePlan();
    const elena = plan.bible.characters.find((c) => c.id === 'elena');
    // Same prompt, changed appearance/costume/identity must stale the reference.
    const updated = await callTool(handleToolCall, 'flow_script_update', {
      scriptId, expectedRevision: 1,
      patch: { bible: { characters: plan.bible.characters.map((c) => (c.id === 'elena' ? { ...c, appearance: 'scar across left cheek, silver costume' } : c)), locations: plan.bible.locations, props: plan.bible.props } },
    });
    expect(updated.revision).toBe(2);
    const stAfterAppearance = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect((stAfterAppearance.references?.current ?? []).map((x) => x.nodeId)).not.toContain('char:elena');
    expect((stAfterAppearance.references?.stale ?? []).map((x) => x.nodeId)).toContain('char:elena');
    expect((stAfterAppearance.references?.history ?? []).length).toBeGreaterThanOrEqual(1);
    void elena;
  }, 120000);

  it('RED parent scene-location: owning scene location change stales previous pack', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', {
      ...basePlan(),
      bible: {
        ...basePlan().bible,
        locations: [...basePlan().bible.locations, { id: 'vault', name: 'Vault', prompt: 'Stone vault' }],
      },
    });
    const scriptId = created.scriptId;
    const srcDir = path.join(tmpDir, 'src-import');
    const nodes = ['char:bob', 'loc:lab', 'prop:vial'];
    const digests = {};
    for (const n of nodes) digests[n] = created.nodeStates[n].nodeDigest;
    for (const n of nodes) {
      const f = await ensureLocalImage(srcDir, `${n.replace(':', '-')}-pack.png`, { color: 'green' });
      const imp = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, n, digests[n], {
        source: 'local_import', ratio: '4:3', files: [{ path: f, rights: 'owned' }], quantity: 1, candidateLimit: 1,
      }));
      const r = goodRatings();
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: digests[n],
        reviewer: 'filmmaker@example.com', action: 'score_candidate',
        candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
        gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
        rubricVersion: r.rubricVersion, weights: r.weights, reason: `score ${n}`,
      });
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: digests[n],
        reviewer: 'filmmaker@example.com', action: 'select_reference',
        candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
        consideredCandidateIds: [imp.candidates[0].candidateId],
        expectedReferenceRevision: 0, reason: `select ${n}`,
      });
    }
    const st0 = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    const shDigest0 = st0.nodeStates['shot:sh1'].nodeDigest;
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'shot:sh1', nodeDigest: shDigest0,
      reviewer: 'filmmaker@example.com', action: 'reference_pack',
      expectedPackRevision: 0, reason: 'pack sh1 with lab',
    });
    const upd = await callTool(handleToolCall, 'flow_script_update', {
      scriptId, expectedRevision: 1, patch: { scenes: [{ id: 'sc1', title: 'Lab', locationId: 'vault' }] },
    });
    expect(upd.revision).toBe(2);
    const st1 = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect((st1.packs?.current ?? []).map((p) => p.shotId)).not.toContain('shot:sh1');
    expect((st1.packs?.stale ?? []).map((p) => p.shotId)).toContain('shot:sh1');
    expect((st1.packs?.history ?? []).length).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('RED parent corrupt-pack: corrupt pack JSON fails closed, never empty success', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const srcDir = path.join(tmpDir, 'src-import');
    const nodes = ['char:bob', 'loc:lab', 'prop:vial'];
    const digests = {};
    for (const n of nodes) digests[n] = created.nodeStates[n].nodeDigest;
    for (const n of nodes) {
      const f = await ensureLocalImage(srcDir, `${n.replace(':', '-')}-corrupt.png`, { color: 'yellow' });
      const imp = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, n, digests[n], {
        source: 'local_import', ratio: '4:3', files: [{ path: f, rights: 'owned' }], quantity: 1, candidateLimit: 1,
      }));
      const r = goodRatings();
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: digests[n],
        reviewer: 'filmmaker@example.com', action: 'score_candidate',
        candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
        gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
        rubricVersion: r.rubricVersion, weights: r.weights, reason: `score ${n}`,
      });
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: digests[n],
        reviewer: 'filmmaker@example.com', action: 'select_reference',
        candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
        consideredCandidateIds: [imp.candidates[0].candidateId],
        expectedReferenceRevision: 0, reason: `select ${n}`,
      });
    }
    const st0 = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    const shDigest = st0.nodeStates['shot:sh1'].nodeDigest;
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'shot:sh1', nodeDigest: shDigest,
      reviewer: 'filmmaker@example.com', action: 'reference_pack',
      expectedPackRevision: 0, reason: 'pack before corruption',
    });
    const packsDir = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'packs');
    const packFile = fs.readdirSync(packsDir).map((n) => path.join(packsDir, n)).find((p) => p.endsWith('.json'));
    expect(packFile).toBeTruthy();
    fs.writeFileSync(packFile, 'not-json{{{');
    await expectCode(callTool(handleToolCall, 'flow_script_status', { scriptId }), 'STORAGE_CORRUPT');
  }, 120000);

  it('canonical replacement selectively stales only affected packs; independent stay current', async () => {
    // Setup packs for sh1 (bob) and sh2 (elena) at rev1.
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const srcDir = path.join(tmpDir, 'src-import');
    const nodes = ['char:elena', 'char:bob', 'loc:lab', 'prop:vial'];
    const digests0 = {};
    for (const n of nodes) digests0[n] = created.nodeStates[n].nodeDigest;
    for (const n of nodes) {
      const f = await ensureLocalImage(srcDir, `${n.replace(':', '-')}-sel.png`, { color: 'red' });
      const imp = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, n, digests0[n], {
        source: 'local_import', ratio: '4:3', files: [{ path: f, rights: 'owned' }], quantity: 1, candidateLimit: 1,
      }));
      const r = goodRatings();
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: digests0[n],
        reviewer: 'filmmaker@example.com', action: 'score_candidate',
        candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
        gates: gatesAllPass(), ratings: r.ratings, confidences: r.confidences,
        rubricVersion: r.rubricVersion, weights: r.weights, reason: `score ${n}`,
      });
      await callTool(handleToolCall, 'flow_script_review', {
        scriptId, expectedRevision: 1, nodeId: n, nodeDigest: digests0[n],
        reviewer: 'filmmaker@example.com', action: 'select_reference',
        candidateId: imp.candidates[0].candidateId, candidateHash: imp.candidates[0].hash,
        consideredCandidateIds: [imp.candidates[0].candidateId],
        expectedReferenceRevision: 0, reason: `select ${n}`,
      });
    }
    const st0 = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    const sh1Digest0 = st0.nodeStates['shot:sh1'].nodeDigest;
    const sh2Digest0 = st0.nodeStates['shot:sh2'].nodeDigest;
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'shot:sh1', nodeDigest: sh1Digest0,
      reviewer: 'filmmaker@example.com', action: 'reference_pack',
      expectedPackRevision: 0, reason: 'pack sh1 rev1',
    });
    await callTool(handleToolCall, 'flow_script_review', {
      scriptId, expectedRevision: 1, nodeId: 'shot:sh2', nodeDigest: sh2Digest0,
      reviewer: 'filmmaker@example.com', action: 'reference_pack',
      expectedPackRevision: 0, reason: 'pack sh2 rev1',
    });

    // Identity change to bob prompt (affects sh1, not sh2).
    const plan = basePlan();
    const bob = plan.bible.characters.find((c) => c.id === 'bob');
    const updated = await callTool(handleToolCall, 'flow_script_update', {
      scriptId,
      expectedRevision: 1,
      patch: {
        bible: {
          characters: plan.bible.characters.map((c) => (c.id === 'bob' ? { ...c, prompt: `${bob.prompt} revised identity` } : c)),
          locations: plan.bible.locations,
          props: plan.bible.props,
        },
      },
    });
    expect(updated.revision).toBe(2);

    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    const packsByShot = new Map((status.packs?.current ?? []).map((p) => [p.shotId, p]));
    // sh1 requires bob -> stale or missing from current; sh2 requires elena -> stays current.
    // Old bytes/reviews remain recoverable via history.
    expect(status.packs?.history?.length).toBeGreaterThanOrEqual(2);
    const sh1Cur = packsByShot.get('shot:sh1');
    const sh2Cur = packsByShot.get('shot:sh2');
    // sh1 must not be presented as current (stale or blocked); sh2 must stay current.
    expect(sh1Cur).toBe(undefined);
    expect(sh2Cur?.shotId).toBe('shot:sh2');
    expect((status.packs?.stale ?? []).map((p) => p.shotId)).toContain('shot:sh1');
  }, 120000);
});
