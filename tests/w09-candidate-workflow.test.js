// W09 candidate workflow — RED1: bounded local_import -> immutable candidate -> status.
// Local fixtures only, lane-local temp. No live submission, no browser spend.
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
  const tmpDir = w09MkTemp('w09-wf-');
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

describe('W09 workflow RED1: local_import retains immutable candidate', () => {
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

  it('flow_script_run with source local_import persists real retained candidate and status shows it', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const f2 = await ensureLocalImage(srcDir, 'b.png', { color: 'blue', format: 'png', width: 64, height: 48 });

    const result = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [
        { path: f1, rights: 'owned', rightsNote: 'lane-local synthetic owned' },
        { path: f2, rights: 'synthetic', rightsNote: 'lane-local synthetic' },
      ],
      minWidth: 8,
      minHeight: 8,
    }));

    // New contract: result carries immutable candidates with full digests.
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.candidates).toHaveLength(2);
    for (const c of result.candidates) {
      expect(c.candidateId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.sourceKind).toBe('local_import');
      expect(c.provenance).toMatch(/local_import/);
      expect(c.provenance).not.toMatch(/flow-?generated/i);
      expect(typeof c.path).toBe('string');
      expect(fs.existsSync(c.path)).toBe(true);
    }
    expect(result.jobId).toBeTruthy();
    expect(result.invocation).toBe('not-invoked');
    expect(result.canSpend).toBe(false);
    expect(result.liveVerified).toBe(false);

    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    const cands = status.candidates ?? [];
    expect(cands.map((c) => c.candidateId).sort()).toEqual(result.candidates.map((c) => c.candidateId).sort());
    // Default remote intent stays prepare-only.
    expect(status.canSpend).toBe(false);
    expect(status.liveVerified).toBe(false);
  }, 60000);
});

describe('W09 workflow RED2: review-artifacts produces labelled immutable contact sheet', () => {
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

  it('flow_script_run stage review-artifacts with jobId returns verified sheet handle', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const f2 = await ensureLocalImage(srcDir, 'b.png', { color: 'blue' });
    const base = runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [
        { path: f1, rights: 'owned' },
        { path: f2, rights: 'synthetic' },
      ],
    });
    const imported = await callTool(handleToolCall, 'flow_script_run', base);
    expect(imported.candidates).toHaveLength(2);

    const sheet = await callTool(handleToolCall, 'flow_script_run', {
      ...base,
      stage: 'review-artifacts',
      jobId: imported.jobId,
    });
    expect(sheet.reviewId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof sheet.path).toBe('string');
    expect(typeof sheet.manifestPath).toBe('string');
    expect(sheet.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(sheet.path)).toBe(true);
    expect(fs.existsSync(sheet.manifestPath)).toBe(true);
    const html = fs.readFileSync(sheet.path, 'utf8');
    expect(html).toMatch(/local candidate review aid/i);
    expect(html).toMatch(/NOT Flow-generated/i);
    expect(html).not.toMatch(/<script/i);
    expect(sheet.candidates).toHaveLength(2);
    expect(sheet.jobId).toBe(imported.jobId);
    expect(sheet.canSpend).toBe(false);
    expect(sheet.liveVerified).toBe(false);
  }, 90000);
});

describe('W09 workflow adversarial: negatives, duplicates, containment, corruption, restart', () => {
  let tmpDir;
  let saved;
  let extraDirs;
  beforeEach(() => {
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
    extraDirs = [];
  });
  afterEach(async () => {
    await restoreEnv(saved, tmpDir);
    for (const d of extraDirs || []) {
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
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

  it('rejects quantity/files mismatch, Flow provenance claim, bad rights and HTML/missing bytes', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const f2 = await ensureLocalImage(srcDir, 'b.png', { color: 'blue' });
    const base = (over) => runArgs(scriptId, 1, 'char:elena', nodeDigest, over);

    await expectCode(callTool(handleToolCall, 'flow_script_run', base({
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
    })), 'INVALID_PARAMS');
    await expectCode(callTool(handleToolCall, 'flow_script_run', base({
      source: 'local_import', ratio: '4:3',
      files: [
        { path: f1, rights: 'owned', provenance: 'flow-generated' },
        { path: f2, rights: 'owned' },
      ],
    })), 'INVALID_PARAMS');
    await expectCode(callTool(handleToolCall, 'flow_script_run', base({
      source: 'local_import', ratio: '4:3',
      files: [
        { path: f1, rights: 'stolen' },
        { path: f2, rights: 'owned' },
      ],
    })), 'INVALID_PARAMS');

    // Pure validation failures write no intent.
    const jobsDirEarly = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs');
    expect(fs.existsSync(jobsDirEarly) ? fs.readdirSync(jobsDirEarly).filter((n) => n.endsWith('.json')) : []).toHaveLength(0);

    const badHtml = path.join(srcDir, 'bad.png');
    fs.writeFileSync(badHtml, '<html><body>expired</body></html>');
    await expect(
      callTool(handleToolCall, 'flow_script_run', base({
        source: 'local_import', ratio: '4:3',
        files: [{ path: badHtml, rights: 'owned' }],
        quantity: 1,
        candidateLimit: 1,
      }))
    ).rejects.toThrow();
    await expectCode(callTool(handleToolCall, 'flow_script_run', base({
      source: 'local_import', ratio: '4:3',
      files: [{ path: path.join(srcDir, 'nope.png'), rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    })), 'MEDIA_NOT_FOUND');

    // Media failures occur after durable job reservation: the job remains
    // (honest reservation, no fake candidate) with zero candidates.
    const jobsDir = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs');
    const jobs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter((n) => n.endsWith('.json')) : [];
    expect(jobs).toHaveLength(1);
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect(status.candidates ?? []).toHaveLength(0);
  }, 90000);

  it('duplicate bytes preserve distinct IDs with duplicateOf and reuse one blob', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const elenaDigest = created.nodeStates['char:elena'].nodeDigest;
    const bobDigest = created.nodeStates['char:bob'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'dup.png', { color: 'red' });

    const a = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', elenaDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    }));
    expect(a.candidates).toHaveLength(1);
    const b = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:bob', bobDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    }));
    expect(b.candidates).toHaveLength(1);
    expect(b.candidates[0].candidateId).not.toBe(a.candidates[0].candidateId);
    expect(b.candidates[0].hash).toBe(a.candidates[0].hash);
    expect(b.candidates[0].path).toBe(a.candidates[0].path);
    expect(b.candidates[0].duplicateOf).toBe(a.candidates[0].candidateId);
    // Transcode representation: no fake export, sourceHash is real, exportHash null.
    expect(a.candidates[0].sourceHash).toBe(a.candidates[0].hash);
    expect(a.candidates[0].exportHash).toBe(null);

    // Same job retry with identical files is idempotent (same handle, no growth).
    const a2 = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', elenaDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    }));
    expect(a2.jobId).toBe(a.jobId);
    expect(a2.candidates.map((c) => c.candidateId).sort()).toEqual(a.candidates.map((c) => c.candidateId).sort());

    // Same job with different bytes refuses overwrite.
    const f2 = await ensureLocalImage(srcDir, 'other.png', { color: 'blue' });
    await expectCode(callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', elenaDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f2, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    })), 'STORAGE_CONFLICT');
  }, 90000);

  it('candidate file symlink escaping root is refused with outside bytes surviving', async (context) => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const imported = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    }));
    const candPath = imported.candidates[0].path;
    const outsideDir = (() => {
      // Lane-local outside dir (sibling of FLOW_HOME, still under evidence/runtime-fixtures).
      const base = path.dirname(tmpDir);
      const d = fs.mkdtempSync(path.join(base, 'w09-outside-'));
      extraDirs.push(d);
      return d;
    })();
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'outside-bytes-must-survive');
    const linkPath = `${candPath}.linktest`;
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) context.skip();
      throw e;
    }
    // Planted symlink inside candidates dir escaping root must fail on status/resume/sheet.
    const plantedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const plantedPath = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'candidates', `${plantedId}.json`);
    try {
      fs.symlinkSync(outsideFile, plantedPath, 'file');
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) context.skip();
      throw e;
    }
    await expect(callTool(handleToolCall, 'flow_script_status', { scriptId })).rejects.toThrow();
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('outside-bytes-must-survive');
    fs.rmSync(linkPath, { force: true });
    fs.rmSync(plantedPath, { force: true });
  }, 90000);

  it('corrupt and id-mismatched candidate records fail closed on status', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'a.png', { color: 'red' });
    const imported = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
    }));
    const candId = imported.candidates[0].candidateId;
    const candFile = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'candidates', `${candId}.json`);
    fs.writeFileSync(candFile, 'not-json{{{');
    await expectCode(callTool(handleToolCall, 'flow_script_status', { scriptId }), 'STORAGE_CORRUPT');
  }, 60000);

  it('MCP execution-shaped keys cannot select fixture transport; default stays planned', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const base = runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 });
    await expectCode(callTool(handleToolCall, 'flow_script_run', { ...base, executionMode: 'local-fixture' }), 'INVALID_PARAMS');
    await expectCode(callTool(handleToolCall, 'flow_script_run', { ...base, handlerSubmission: {} }), 'INVALID_PARAMS');
    const planned = await callTool(handleToolCall, 'flow_script_run', base);
    expect(planned.invocation).toBe('not-invoked');
    expect(planned.canSpend).toBe(false);
    expect(planned.candidates).toBe(undefined);
  }, 60000);
});

describe('W09 repair RED: parent-reproduced local import defects', () => {
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
  it('import declaring ratio 1:1 must not retain 64x48 bytes; truthful 4:3 declaration succeeds', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const fSquareMismatch = await ensureLocalImage(srcDir, 'mismatch-64x48.png', { color: 'red', width: 64, height: 48 });
    // Declared 1:1 with actual 64x48 (4:3) must fail closed, never silently accept.
    await expect(
      callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
        source: 'local_import', ratio: '4:3',
        files: [{ path: fSquareMismatch, rights: 'owned' }],
        quantity: 1,
        candidateLimit: 1,
        ratio: '1:1',
      }))
    ).rejects.toThrow();
    // Truthful 4:3 declaration for the same 64x48 bytes succeeds with truthful stage.
    const ok = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: fSquareMismatch, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
      ratio: '4:3',
    }));
    expect(ok.candidates).toHaveLength(1);
    expect(ok.candidates[0].width).toBe(64);
    expect(ok.candidates[0].height).toBe(48);
    // Successful local import must not report remote authorization required.
    const stage = String(ok.stage ?? ok.status ?? ok.nextAction ?? '');
    expect(stage).not.toMatch(/authorization required/i);
    expect(JSON.stringify(ok)).not.toMatch(/authorization required/i);
  }, 90000);
  it('local import idempotence binds source hashes/rights/min thresholds; different declaration is conflict', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const srcDir = path.join(tmpDir, 'src-import');
    const f1 = await ensureLocalImage(srcDir, 'idem-a.png', { color: 'red', width: 64, height: 48 });
    const f2 = await ensureLocalImage(srcDir, 'idem-b.png', { color: 'blue', width: 64, height: 48 });
    const first = await callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
      ratio: '4:3',
    }));
    expect(first.candidates).toHaveLength(1);
    // Same bytes with a different rights declaration must not silently reuse the first declaration.
    await expectCode(callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f1, rights: 'licensed' }],
      quantity: 1,
      candidateLimit: 1,
      ratio: '4:3',
    })), 'STORAGE_CONFLICT');
    // Different bytes under the same bound intent must also conflict, not overwrite.
    await expectCode(callTool(handleToolCall, 'flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      source: 'local_import', ratio: '4:3',
      files: [{ path: f2, rights: 'owned' }],
      quantity: 1,
      candidateLimit: 1,
      ratio: '4:3',
    })), 'STORAGE_CONFLICT');
  }, 90000);
});

describe('W09 workflow contract parity: advertised registry matches validated schemas', () => {
  it('flow_script_run advertises local_import/source/files/minWidth/minHeight/jobId and validates them', async () => {
    const { TOOL_DEFINITIONS } = await import('../src/index.js');
    const { schemas } = await import('../src/utils/validate.js');
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'flow_script_run');
    expect(def).toBeTruthy();
    for (const f of ['source', 'files', 'minWidth', 'minHeight', 'jobId']) {
      expect(def.inputSchema.properties[f]).toBeTruthy();
    }
    expect(def.inputSchema.properties.stage.enum).toContain('review-artifacts');
    // Zod accepts new optional fields (passthrough object, exact shape check via w00).
    const shape = schemas.flow_script_run.shape;
    for (const f of ['source', 'files', 'minWidth', 'minHeight', 'jobId']) {
      expect(shape[f]).toBeTruthy();
    }
    // Story alias parity: same new fields.
    const storyShape = schemas.flow_story_run.shape;
    for (const f of ['source', 'files', 'minWidth', 'minHeight', 'jobId']) {
      expect(storyShape[f]).toBeTruthy();
    }
  });

  it('flow_script_review advertises W09 typed actions and validates them', async () => {
    const { TOOL_DEFINITIONS } = await import('../src/index.js');
    const { schemas } = await import('../src/utils/validate.js');
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'flow_script_review');
    expect(def).toBeTruthy();
    for (const f of ['action', 'candidateId', 'candidateHash', 'expectedReferenceRevision', 'expectedPackRevision', 'reason', 'gates', 'ratings', 'confidences', 'rubricVersion', 'weights', 'consideredCandidateIds']) {
      expect(def.inputSchema.properties[f]).toBeTruthy();
    }
    const shape = schemas.flow_script_review.shape;
    for (const f of ['action', 'candidateId', 'candidateHash', 'expectedReferenceRevision', 'expectedPackRevision', 'reason', 'gates', 'ratings', 'confidences', 'rubricVersion', 'weights', 'consideredCandidateIds']) {
      expect(shape[f]).toBeTruthy();
    }
  });
});
