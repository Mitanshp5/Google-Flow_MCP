import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleToolCall } from '../src/index.js';
import { getStoryDir, getStoryRevisionsDir, getStory } from '../src/script/store.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';

// Owner: storage/planner lane. Covers family B: current manifest/snapshot
// coherence must hold for update/review as well as status, and every loaded
// snapshot must bind to its requested revision ID.
describe('W08 manifest coherence regressions (family B)', () => {
  let caseRoot;
  let prevHome;
  const base = {
    binding: { accountKey: 'fixture@example.com', projectId: 'fixture-project' },
    policy: { candidateLimit: 4, timeBudgetSec: 60, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: { title: 'Coherence', aspectRatio: '16:9', fps: 24, targetDurationSec: 8 },
    bible: {
      characters: [{ id: 'hero', name: 'Hero', prompt: 'hero' }],
      locations: [{ id: 'lab', name: 'Lab', prompt: 'lab' }],
      props: [],
    },
    scenes: [{ id: 's1', title: 'S', locationId: 'lab' }],
    shots: [{ id: 'a', sceneId: 's1', prompt: 'a', plannedSourceFrames: 100, trim: { inFrame: 0, outFrame: 50 } }],
  };
  const call = async (n, a) => JSON.parse((await handleToolCall(n, a)).content[0].text);

  beforeEach(() => {
    prevHome = process.env.FLOW_HOME;
    caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w08-B-'));
    process.env.FLOW_HOME = path.join(caseRoot, 'flow-home');
    initRuntimeDirs(process.env.FLOW_HOME);
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = prevHome;
    fs.rmSync(caseRoot, { recursive: true, force: true });
  });

  it('rejects update with a manifest claiming revision 99 while pointing at rev 1', async () => {
    const created = await call('flow_script_create', structuredClone(base));
    const file = path.join(getStoryDir(created.scriptId, process.env.FLOW_HOME), 'manifest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.currentRevision = 99;
    fs.writeFileSync(file, JSON.stringify(m));
    await expect(
      call('flow_script_update', { scriptId: created.scriptId, expectedRevision: 99, patch: { brief: { title: 'x' } } })
    ).rejects.toThrow(/STORAGE_CORRUPT/);
  });

  it('rejects review with a manifest claiming revision 99 while pointing at rev 1', async () => {
    const created = await call('flow_script_create', structuredClone(base));
    const file = path.join(getStoryDir(created.scriptId, process.env.FLOW_HOME), 'manifest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.currentRevision = 99;
    fs.writeFileSync(file, JSON.stringify(m));
    await expect(
      call('flow_script_review', {
        scriptId: created.scriptId,
        expectedRevision: 99,
        nodeId: 'char:hero',
        nodeDigest: created.nodeStates['char:hero'].nodeDigest,
        reviewer: 'r@example.com',
        decision: 'approve',
      })
    ).rejects.toThrow(/STORAGE_CORRUPT/);
  });

  it('rejects update when snapshot.revisionId is forged', async () => {
    const created = await call('flow_script_create', structuredClone(base));
    const file = path.join(
      getStoryRevisionsDir(created.scriptId, process.env.FLOW_HOME),
      created.revisionId,
      'snapshot.json'
    );
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    s.revisionId = 'rev_999_forged';
    fs.writeFileSync(file, JSON.stringify(s));
    await expect(
      call('flow_script_update', { scriptId: created.scriptId, expectedRevision: 1, patch: { brief: { title: 'x' } } })
    ).rejects.toThrow(/STORAGE_CORRUPT/);
  });

  it('still allows genuine historical reads', async () => {
    const created = await call('flow_script_create', structuredClone(base));
    await call('flow_script_update', { scriptId: created.scriptId, expectedRevision: 1, patch: { brief: { title: 'v2' } } });
    const hist = getStory(created.scriptId, { revisionId: created.revisionId, root: process.env.FLOW_HOME });
    expect(hist.revision).toBe(1);
    const cur = getStory(created.scriptId, { root: process.env.FLOW_HOME });
    expect(cur.revision).toBe(2);
  });
});
