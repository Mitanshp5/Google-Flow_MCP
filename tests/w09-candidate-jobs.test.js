import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { handleToolCall } from '../src/index.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';
import { closeLogger } from '../src/utils/logger.js';
import { computeCanonicalDigest } from '../src/script/store.js';
import { createCandidateJob, resumeCandidateJob } from '../src/script/candidate-jobs.js';

// Parent correction matrix (W09-CORRECTIONS.md items 1-6) + preserved first tracer.
// All matrix cases run through the actual MCP dispatcher (handleToolCall) except
// the two lock-race cases, which call the real domain functions directly with a
// controlled beforeLock seam; the concurrent update inside the seam is itself a
// real dispatcher update (no mocked success).

function fixtureBaseDir() {
  const preferred = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
  fs.mkdirSync(preferred, { recursive: true });
  return preferred;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('W09 first vertical slice: bounded candidate job persists and recovers after restart', () => {
  let tmpDir;
  let originalFlowHome;
  let extraDirs;

  beforeEach(() => {
    originalFlowHome = process.env.FLOW_HOME;
    tmpDir = fs.mkdtempSync(path.join(fixtureBaseDir(), 'w09-'));
    extraDirs = [];
    process.env.FLOW_HOME = tmpDir;
    initRuntimeDirs(tmpDir);
  });

  afterEach(async () => {
    await closeLogger();
    if (originalFlowHome !== undefined) process.env.FLOW_HOME = originalFlowHome;
    else delete process.env.FLOW_HOME;
    for (const d of extraDirs || []) {
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function callTool(name, args) {
    const raw = await handleToolCall(name, args);
    return JSON.parse(raw.content[0].text);
  }

  function basePlan() {
    return {
      binding: { accountKey: 'filmmaker@example.com', projectId: 'w09_slice_proj' },
      policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
      governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
      brief: { title: 'W09 Slice', aspectRatio: '16:9', fps: 24, targetDurationSec: 8 },
      bible: {
        characters: [
          { id: 'elena', name: 'Dr. Elena Vance', prompt: 'Cinematic portrait of Dr. Elena Vance' },
          { id: 'bob', name: 'Bob', prompt: 'Portrait of Bob the assistant' },
          { id: 'nona', name: 'Nona the extra' },
        ],
        locations: [{ id: 'lab', name: 'Subterranean Lab', prompt: 'Dark underground laboratory' }],
        props: [{ id: 'vial', name: 'Vial', prompt: 'Glass vial' }],
      },
      scenes: [{ id: 'sc1', title: 'Lab', locationId: 'lab' }],
      shots: [
        {
          id: 'sh1',
          sceneId: 'sc1',
          plannedSourceFrames: 192,
          trim: { inFrame: 0, outFrame: 192 },
          entities: { characters: ['bob'], props: ['vial'] },
          prompt: 'Bob inspecting the vial',
        },
      ],
    };
  }

  function runArgs(scriptId, rev, nodeId, nodeDigest, overrides = {}) {
    return {
      scriptId,
      expectedRevision: rev,
      stage: 'image-candidates',
      nodeId,
      nodeDigest,
      model: 'Nano Banana 2',
      ratio: '1:1',
      quantity: 2,
      candidateLimit: 2,
      timeBudgetSec: 600,
      ...overrides,
    };
  }

  function jobsOnDisk(scriptId) {
    const dir = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  }

  function jobPath(scriptId, jobId) {
    return path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs', `${jobId}.json`);
  }

  function readJobRecord(scriptId, jobId) {
    return JSON.parse(fs.readFileSync(jobPath(scriptId, jobId), 'utf-8'));
  }

  function resign(obj) {
    const { digest: _drop, ...rest } = obj;
    return { ...rest, digest: computeCanonicalDigest(rest) };
  }

  async function expectCode(promise, code) {
    try {
      await promise;
    } catch (e) {
      expect(e.code).toBe(code);
      return;
    }
    throw new Error(`expected rejection with code ${code} but the call resolved`);
  }

  it('creates one bounded candidate intent via dispatcher, persists it, and recovers it in a fresh child process', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    expect(nodeDigest).toBeTruthy();

    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest));

    expect(job.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(job.invocation).toBe('not-invoked');
    expect(job.canSpend).toBe(false);
    expect(job.liveVerified).toBe(false);
    expect(job.scriptId).toBe(scriptId);

    const status = await callTool('flow_script_status', { scriptId });
    const summaries = status.candidateJobs ?? status.jobs ?? [];
    expect(summaries.map((j) => j.jobId)).toContain(job.jobId);

    const childCode = `
      import { handleToolCall } from './src/index.js';
      const s = JSON.parse((await handleToolCall('flow_script_status', { scriptId: ${JSON.stringify('__SID__')} })).content[0].text);
      const jobs = s.candidateJobs ?? s.jobs ?? [];
      const found = jobs.find((j) => j.jobId === ${JSON.stringify('__JID__')});
      if (!found) { console.log(JSON.stringify({ recovered: false })); process.exit(2); }
      const r = JSON.parse((await handleToolCall('flow_script_resume', { scriptId: ${JSON.stringify('__SID__')}, jobId: ${JSON.stringify('__JID__')}, expectedRevision: 1 })).content[0].text);
      console.log(JSON.stringify({ recovered: true, jobId: found.jobId, deadlineAt: found.deadlineAt, resume: r }));
    `
      .replaceAll('__SID__', scriptId)
      .replaceAll('__JID__', job.jobId);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
      cwd: process.cwd(),
      env: { ...process.env, FLOW_HOME: tmpDir },
      encoding: 'utf-8',
      timeout: 60000,
    });
    expect(child.status).toBe(0);
    const out = JSON.parse(child.stdout.trim().split('\n').pop());
    expect(out.recovered).toBe(true);
    expect(out.jobId).toBe(job.jobId);
    expect(out.resume.jobId).toBe(job.jobId);
    expect(out.resume.deadlineAt).toBe(job.deadlineAt);
  }, 60000);

  it('item1: quantity above candidateLimit is rejected before any intent write', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 2, candidateLimit: 1 }))
    ).rejects.toThrow(/\[INVALID_PARAMS\].*quantity/);
    expect(jobsOnDisk(scriptId)).toHaveLength(0);
  });

  it('item1: reservation is persisted and every distinct physical variant consumes allowance', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const elena = created.nodeStates['char:elena'].nodeDigest;
    const bob = created.nodeStates['char:bob'].nodeDigest;
    const sh1 = created.nodeStates['shot:sh1'].nodeDigest;

    const a = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', elena, { quantity: 2, candidateLimit: 2 }));
    expect(a.reserved).toBe(2);
    // Same node, different intent (different candidateLimit) is a distinct
    // physical variant: it consumes allowance rather than deduping by content.
    const b = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:bob', bob, { quantity: 2, candidateLimit: 4 }));
    expect(b.reserved).toBe(2);
    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'shot:sh1', sh1, { quantity: 1, candidateLimit: 1 }))
    ).rejects.toThrow(/\[RESERVATION_EXCEEDED\]/);
    expect(jobsOnDisk(scriptId).filter((n) => n !== 'index.json')).toHaveLength(2);
  });

  it('item2: exhausted time budget resumes as paused_time_budget with original deadline and measured elapsed', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    const job = await callTool(
      'flow_script_run',
      runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1, timeBudgetSec: 0.05 })
    );
    await sleep(120);
    const resumed = await callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1 });
    expect(resumed.resumable).toBe(true);
    expect(resumed.pause).toBe('paused_time_budget');
    expect(resumed.status).toBe('paused_time_budget');
    expect(resumed.authorization).toBe('authorization_required');
    expect(resumed.deadlineAt).toBe(job.deadlineAt);
    expect(resumed.deadlineAtMs).toBe(job.deadlineAtMs);
    expect(resumed.elapsedMs).toBeGreaterThanOrEqual(15);

    const persisted = readJobRecord(scriptId, job.jobId);
    expect(persisted.status).toBe('paused_time_budget');
    expect(persisted.deadlineAt).toBe(job.deadlineAt);

    // Repeated resume never resets or decreases the durable deadline.
    const resumed2 = await callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1 });
    expect(resumed2.deadlineAt).toBe(job.deadlineAt);
    expect(resumed2.pause).toBe('paused_time_budget');
  }, 30000);

  it('item2: status exposes live elapsed and exhaustion without requiring resume', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    const job = await callTool(
      'flow_script_run',
      runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1, timeBudgetSec: 0.05 })
    );
    await sleep(120);
    const status = await callTool('flow_script_status', { scriptId });
    const found = (status.candidateJobs ?? []).find((j) => j.jobId === job.jobId);
    expect(found).toBeTruthy();
    expect(found.exhausted).toBe(true);
    expect(found.elapsedMs).toBeGreaterThanOrEqual(15);
    expect(found.deadlineAt).toBe(job.deadlineAt);
  }, 30000);

  it('item2: huge finite time budgets fail clean instead of RangeError', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1, timeBudgetSec: 1e308 }))
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1, timeBudgetSec: 1e16 }))
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(jobsOnDisk(scriptId)).toHaveLength(0);
  });

  it('item3: job file symlink escaping FLOW_HOME is refused and outside bytes survive', async (context) => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));

    const outsideDir = fs.mkdtempSync(path.join(fixtureBaseDir(), 'w09-outside-'));
    extraDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'outside-bytes-must-survive');
    const linkId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const linkPath = path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs', `${linkId}.json`);
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) context.skip();
      throw e;
    }

    await expect(callTool('flow_script_status', { scriptId })).rejects.toThrow();
    await expect(
      callTool('flow_script_resume', { scriptId, jobId: linkId, expectedRevision: 1 })
    ).rejects.toThrow();
    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'char:bob', created.nodeStates['char:bob'].nodeDigest, { quantity: 1, candidateLimit: 1 }))
    ).rejects.toThrow();
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('outside-bytes-must-survive');
    expect(job.jobId).toBeTruthy();
  });

  it('item3: corrupt and structurally invalid job records fail closed, never listed', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));

    const badId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    fs.writeFileSync(path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs', `${badId}.json`), 'not-json{{{');
    await expectCode(callTool('flow_script_status', { scriptId }), 'STORAGE_CORRUPT');
    await expectCode(
      callTool('flow_script_run', runArgs(scriptId, 1, 'char:bob', created.nodeStates['char:bob'].nodeDigest, { quantity: 1, candidateLimit: 1 })),
      'STORAGE_CORRUPT'
    );
  });

  it('item3: resigned tampering with quantity and id binding is rejected, not just checksummed', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));

    const tampered = resign({ ...readJobRecord(scriptId, job.jobId), quantity: 99, reserved: 99 });
    fs.writeFileSync(jobPath(scriptId, job.jobId), JSON.stringify(tampered, null, 2));
    await expect(callTool('flow_script_status', { scriptId })).rejects.toThrow(/\[STORAGE_CORRUPT\]/);

    // A record whose id does not bind the requested filename is rejected.
    const otherId = 'cccccccc-dddd-4eee-8fff-000000000000';
    const mismatched = resign({ ...resign(readJobRecord(scriptId, job.jobId)), id: otherId, jobId: otherId });
    fs.writeFileSync(jobPath(scriptId, job.jobId), JSON.stringify(mismatched, null, 2));
    await expect(
      callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1 })
    ).rejects.toThrow(/\[STORAGE_CORRUPT\]/);
  });

  it('item3: legacy index pointer is eliminated — corrupt index.json blocks nothing', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    fs.mkdirSync(path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'scripts', scriptId, 'candidates', 'jobs', 'index.json'),
      'garbage-pointer{{{'
    );
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));
    expect(job.jobId).toBeTruthy();
    const status = await callTool('flow_script_status', { scriptId });
    expect((status.candidateJobs ?? []).map((j) => j.jobId)).toContain(job.jobId);
  });

  it('item3: status propagates failures instead of returning empty success', async () => {
    await expect(callTool('flow_script_status', { scriptId: ' bad id!' })).rejects.toThrow();
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));
    fs.writeFileSync(jobPath(scriptId, job.jobId), 'corrupt{{{');
    await expectCode(callTool('flow_script_status', { scriptId }), 'STORAGE_CORRUPT');
  });

  it('item4: create revalidates under lock — concurrent real update refuses stale intent', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    let hookFired = false;
    await expect(
      createCandidateJob(runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }), {
        root: tmpDir,
        hooks: {
          beforeLock: async () => {
            hookFired = true;
            await callTool('flow_script_update', {
              scriptId,
              expectedRevision: 1,
              patch: { policy: { candidateLimit: 2 } },
            });
          },
        },
      })
    ).rejects.toThrow(/\[STORAGE_CONFLICT\]/);
    expect(hookFired).toBe(true);
    expect(jobsOnDisk(scriptId)).toHaveLength(0);
  });

  it('item4: resume revalidates under lock — concurrent real update refuses reuse', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));

    let hookFired = false;
    await expect(
      resumeCandidateJob({ scriptId, jobId: job.jobId, expectedRevision: 1 }, {
        root: tmpDir,
        hooks: {
          beforeLock: async () => {
            hookFired = true;
            await callTool('flow_script_update', {
              scriptId,
              expectedRevision: 1,
              patch: { policy: { candidateLimit: 2 } },
            });
          },
        },
      })
    ).rejects.toThrow(/\[STORAGE_CONFLICT\]/);
    expect(hookFired).toBe(true);
  });

  it('item4: removed node is NODE_NOT_FOUND against the active DAG even though orphan nodeStates remain', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const elenaDigest = created.nodeStates['char:elena'].nodeDigest;
    expect(created.nodeStates['char:elena']).toBeTruthy();

    const plan = basePlan();
    const updated = await callTool('flow_script_update', {
      scriptId,
      expectedRevision: 1,
      patch: {
        bible: {
          characters: plan.bible.characters.filter((c) => c.id !== 'elena'),
          locations: plan.bible.locations,
          props: plan.bible.props,
        },
      },
    });
    expect(updated.revision).toBe(2);

    await expect(
      callTool('flow_script_run', runArgs(scriptId, 2, 'char:elena', elenaDigest, { quantity: 1, candidateLimit: 1 }))
    ).rejects.toThrow(/\[NODE_NOT_FOUND\].*active script DAG/);
    expect(jobsOnDisk(scriptId)).toHaveLength(0);

    // Positive control: a node that is still a DAG member binds fine at rev 2.
    const bobDigest = updated.script.nodeStates['char:bob'].nodeDigest;
    const ok = await callTool('flow_script_run', runArgs(scriptId, 2, 'char:bob', bobDigest, { quantity: 1, candidateLimit: 1 }));
    expect(ok.jobId).toBeTruthy();
  });

  it('item4: authored prompt is required — display name is not a generation prompt', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nonaDigest = created.nodeStates['char:nona'].nodeDigest;
    expect(nonaDigest).toBeTruthy();

    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'char:nona', nonaDigest, { quantity: 1, candidateLimit: 1 }))
    ).rejects.toThrow(/authored prompt/);
    expect(jobsOnDisk(scriptId)).toHaveLength(0);
  });

  it('item5: identical intent keeps the exact same handle and deadline', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    const a = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest));
    const b = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest));
    expect(b.jobId).toBe(a.jobId);
    expect(b.deadlineAt).toBe(a.deadlineAt);
    expect(jobsOnDisk(scriptId).filter((n) => n !== 'index.json')).toHaveLength(1);
  });

  it('item5: budget scope survives unrelated review revisions — no silent reset', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const elena = created.nodeStates['char:elena'].nodeDigest;
    const bob = created.nodeStates['char:bob'].nodeDigest;
    const sh1 = created.nodeStates['shot:sh1'].nodeDigest;

    const a = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', elena, { quantity: 2, candidateLimit: 2 }));
    await callTool('flow_script_run', runArgs(scriptId, 1, 'char:bob', bob, { quantity: 2, candidateLimit: 4 }));
    await expect(
      callTool('flow_script_run', runArgs(scriptId, 1, 'shot:sh1', sh1, { quantity: 1, candidateLimit: 1 }))
    ).rejects.toThrow(/\[RESERVATION_EXCEEDED\]/);

    // Unrelated approval bumps the revision but must not mint a new budget scope.
    const labDigest = created.nodeStates['loc:lab'].nodeDigest;
    const rev = await callTool('flow_script_review', {
      scriptId,
      expectedRevision: 1,
      nodeId: 'loc:lab',
      nodeDigest: labDigest,
      reviewer: 'filmmaker@example.com',
      decision: 'approve',
    });
    expect(rev.script.revision).toBe(2);

    await expect(
      callTool('flow_script_run', runArgs(scriptId, 2, 'shot:sh1', sh1, { quantity: 1, candidateLimit: 1 }))
    ).rejects.toThrow(/\[RESERVATION_EXCEEDED\]/);

    // Same approved intent still resolves to the exact same handle/deadline.
    const a2 = await callTool('flow_script_run', runArgs(scriptId, 2, 'char:elena', elena, { quantity: 2, candidateLimit: 2 }));
    expect(a2.jobId).toBe(a.jobId);
    expect(a2.deadlineAt).toBe(a.deadlineAt);

    // Bound dependencies unchanged, so resume stays valid at the new revision.
    const resumed = await callTool('flow_script_resume', { scriptId, jobId: a.jobId, expectedRevision: 2 });
    expect(resumed.resumable).toBe(true);
    expect(resumed.deadlineAt).toBe(a.deadlineAt);
  });

  it('item5: repeated resumes do not grow history without bound', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));

    await callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1 });
    await callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1 });
    const third = await callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1 });
    expect(third.history.length).toBe(2);
    expect(third.history[0].event).toBe('created');
    expect(third.history[1].event).toBe('resumed');
  });

  it('item6: conflicting scriptId/storyId is rejected, never normalized', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;

    await expect(
      callTool('flow_script_run', { ...runArgs(scriptId, 1, 'char:elena', nodeDigest), storyId: 'other-story' })
    ).rejects.toThrow(/\[INVALID_PARAMS\].*[Cc]onflict/);
    const job = await callTool('flow_script_run', runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 }));
    await expect(
      callTool('flow_script_resume', { scriptId, storyId: 'other-story', jobId: job.jobId, expectedRevision: 1 })
    ).rejects.toThrow(/\[INVALID_PARAMS\].*[Cc]onflict/);
    expect(jobsOnDisk(scriptId).filter((n) => n !== 'index.json')).toHaveLength(1);
  });

  it('item6: padded whitespace and malformed identifiers are rejected exactly', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const base = runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 });

    // Schema and domain layers both reject with code INVALID_PARAMS; assert
    // the code (not message cosmetics) since only the domain layer prefixes.
    await expectCode(callTool('flow_script_run', { ...base, nodeId: ' char:elena' }), 'INVALID_PARAMS');
    await expectCode(callTool('flow_script_run', { ...base, nodeDigest: ` ${nodeDigest}` }), 'INVALID_PARAMS');
    await expectCode(callTool('flow_script_run', { ...base, model: ' Nano Banana 2' }), 'INVALID_PARAMS');
    await expectCode(callTool('flow_script_run', { ...base, ratio: '1:1 ' }), 'INVALID_PARAMS');
    await expectCode(callTool('flow_script_run', { ...base, nodeId: 'char:' }), 'INVALID_PARAMS');
    const job = await callTool('flow_script_run', base);
    await expectCode(
      callTool('flow_script_resume', { scriptId, jobId: ` ${job.jobId}`, expectedRevision: 1 }),
      'INVALID_PARAMS'
    );
    await expectCode(
      callTool('flow_script_resume', { scriptId, jobId: 'not-a-uuid', expectedRevision: 1 }),
      'INVALID_PARAMS'
    );
    expect(jobsOnDisk(scriptId).filter((n) => n !== 'index.json')).toHaveLength(1);
  });

  it('item6: execution-shaped unknown keys are rejected and model stays exact', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const base = runArgs(scriptId, 1, 'char:elena', nodeDigest, { quantity: 1, candidateLimit: 1 });

    await expect(callTool('flow_script_run', { ...base, auto_confirm: true })).rejects.toThrow(/\[INVALID_PARAMS\]/);
    await expect(callTool('flow_script_run', { ...base, approval: { id: 'x' } })).rejects.toThrow(/\[INVALID_PARAMS\]/);
    await expect(callTool('flow_script_run', { ...base, submit: true })).rejects.toThrow(/\[INVALID_PARAMS\]/);

    const job = await callTool('flow_script_run', base);
    expect(job.model).toBe('Nano Banana 2');
    await expect(
      callTool('flow_script_resume', { scriptId, jobId: job.jobId, expectedRevision: 1, approvalChild: 'x' })
    ).rejects.toThrow(/\[INVALID_PARAMS\]/);
    expect(jobsOnDisk(scriptId).filter((n) => n !== 'index.json')).toHaveLength(1);
  });

  it('rejects an unsupported image ratio through the dispatcher before creating an intent', async () => {
    const created = await callTool('flow_script_create', basePlan());
    await expectCode(callTool('flow_script_run', runArgs(created.scriptId, 1, 'char:elena',
      created.nodeStates['char:elena'].nodeDigest, { ratio: 'nonsense' })), 'INVALID_PARAMS');
    expect(jobsOnDisk(created.scriptId)).toEqual([]);
  });

  it('rejects an escaping jobs-directory junction without reading or changing outside records', async () => {
    const created = await callTool('flow_script_create', basePlan());
    const args = runArgs(created.scriptId, 1, 'char:elena', created.nodeStates['char:elena'].nodeDigest);
    const job = await callTool('flow_script_run', args);
    const outside = fs.mkdtempSync(path.join(fixtureBaseDir(), 'w09-junction-outside-'));
    extraDirs.push(outside);
    const outsideFile = path.join(outside, `${job.jobId}.json`);
    const bytes = fs.readFileSync(jobPath(created.scriptId, job.jobId));
    fs.writeFileSync(outsideFile, bytes);
    const jobsDir = path.dirname(jobPath(created.scriptId, job.jobId));
    fs.renameSync(jobsDir, `${jobsDir}-saved-fixture`);
    fs.symlinkSync(outside, jobsDir, process.platform === 'win32' ? 'junction' : 'dir');
    await expectCode(callTool('flow_script_status', { scriptId: created.scriptId }), 'INVALID_STORY_ID');
    await expectCode(callTool('flow_script_run', args), 'INVALID_STORY_ID');
    await expectCode(callTool('flow_script_resume', { scriptId: created.scriptId, jobId: job.jobId, expectedRevision: 1 }), 'INVALID_STORY_ID');
    expect(fs.readFileSync(outsideFile)).toEqual(bytes);
    expect(fs.readdirSync(outside)).toEqual([`${job.jobId}.json`]);
  });
});
