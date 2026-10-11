import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { handleToolCall } from '../src/index.js';
import { getStoryRevisionsDir } from '../src/script/store.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';

// Owner: storage/planner lane. Covers family A: revision/container junctions
// must fail closed BEFORE any outside-HOME mkdir/read/write side effect.
describe('W08 physical containment regressions (family A)', () => {
  let caseRoot;
  let prevHome;
  const base = {
    binding: { accountKey: 'fixture@example.com', projectId: 'fixture-project' },
    policy: { candidateLimit: 4, timeBudgetSec: 60, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: { title: 'Containment', aspectRatio: '16:9', fps: 24, targetDurationSec: 8 },
    bible: {
      characters: [{ id: 'hero', name: 'Hero', prompt: 'hero' }],
      locations: [{ id: 'lab', name: 'Lab', prompt: 'lab' }],
      props: [{ id: 'cup', name: 'Cup', prompt: 'cup' }],
    },
    scenes: [{ id: 'scene1', title: 'S', locationId: 'lab' }],
    shots: [
      { id: 'a', sceneId: 'scene1', prompt: 'a', plannedSourceFrames: 100, trim: { inFrame: 0, outFrame: 50 } },
    ],
  };
  const call = async (n, a) => JSON.parse((await handleToolCall(n, a)).content[0].text);

  beforeEach(() => {
    prevHome = process.env.FLOW_HOME;
    caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w08-A-'));
    process.env.FLOW_HOME = path.join(caseRoot, 'flow-home');
    initRuntimeDirs(process.env.FLOW_HOME);
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = prevHome;
    fs.rmSync(caseRoot, { recursive: true, force: true });
  });

  it('rejects create when revisions/ is a junction, with no outside snapshot write', async () => {
    const id = crypto.randomUUID();
    const dir = path.join(process.env.FLOW_HOME, 'scripts', id);
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(caseRoot, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(dir, 'revisions'), 'junction');
    } catch {
      linked = false;
    }
    if (!linked) return;
    await expect(call('flow_script_create', { ...structuredClone(base), scriptId: id })).rejects.toThrow(/INVALID_STORY_ID/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects status when the selected revision directory is a junction', async () => {
    const created = await call('flow_script_create', structuredClone(base));
    const rev = path.join(getStoryRevisionsDir(created.scriptId, process.env.FLOW_HOME), created.revisionId);
    const outside = path.join(caseRoot, 'outside');
    fs.cpSync(rev, outside, { recursive: true });
    fs.rmSync(rev, { recursive: true });
    try {
      fs.symlinkSync(outside, rev, 'junction');
    } catch {
      return;
    }
    await expect(call('flow_script_status', { scriptId: created.scriptId })).rejects.toThrow(/INVALID_STORY_ID/);
  });

  it('rejects update and review when revisions/ is a junction, with no outside write', async () => {
    for (const action of ['update', 'review']) {
      const created = await call('flow_script_create', structuredClone(base));
      const revisions = getStoryRevisionsDir(created.scriptId, process.env.FLOW_HOME);
      const outside = path.join(caseRoot, `outside-${action}`);
      fs.cpSync(revisions, outside, { recursive: true });
      fs.rmSync(revisions, { recursive: true });
      try {
        fs.symlinkSync(outside, revisions, 'junction');
      } catch {
        continue;
      }
      if (action === 'update') {
        await expect(
          call('flow_script_update', { scriptId: created.scriptId, expectedRevision: 1, patch: { brief: { title: 'x' } } })
        ).rejects.toThrow(/INVALID_STORY_ID/);
        expect(fs.readdirSync(outside)).toHaveLength(1);
      } else {
        await expect(
          call('flow_script_review', {
            scriptId: created.scriptId,
            expectedRevision: 1,
            nodeId: 'char:hero',
            nodeDigest: created.nodeStates['char:hero'].nodeDigest,
            reviewer: 'r@example.com',
            decision: 'approve',
          })
        ).rejects.toThrow(/INVALID_STORY_ID/);
      }
    }
  });

  it('rejects scripts/ container junction before creating any outside child directory', async () => {
    const id = crypto.randomUUID();
    const outside = path.join(caseRoot, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const scripts = path.join(process.env.FLOW_HOME, 'scripts');
    fs.rmSync(scripts, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, scripts, 'junction');
    } catch {
      return;
    }
    await expect(call('flow_script_create', { ...structuredClone(base), scriptId: id })).rejects.toThrow(/INVALID_STORY_ID/);
    expect(fs.existsSync(path.join(outside, id))).toBe(false);
  });
});
