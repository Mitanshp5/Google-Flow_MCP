import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleToolCall } from '../src/index.js';
import { buildStoryDag, computeSemanticInvalidations } from '../src/script/dag.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';

// Owner: DAG lane. Covers family C: strongest invalidation must survive
// converging paths regardless of arrival order.
describe('W08 mixed-strength invalidation regressions (family C)', () => {
  let caseRoot;
  let prevHome;
  const base = {
    binding: { accountKey: 'fixture@example.com', projectId: 'fixture-project' },
    policy: { candidateLimit: 4, timeBudgetSec: 60, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: { title: 'Invalidation', aspectRatio: '16:9', fps: 24, targetDurationSec: 16 },
    bible: {
      characters: [{ id: 'hero', name: 'Hero', prompt: 'hero' }],
      locations: [{ id: 'lab', name: 'Lab', prompt: 'lab' }],
      props: [{ id: 'cup', name: 'Cup', prompt: 'cup' }],
    },
    scenes: [{ id: 'scene1', title: 'S', locationId: 'lab' }],
    shots: [
      { id: 'a', sceneId: 'scene1', prompt: 'a', plannedSourceFrames: 192, trim: { inFrame: 0, outFrame: 192 }, entities: { characters: ['hero'], props: ['cup'] }, expected_state_before: { props: { cup: { holder: null, state: 'closed' } } }, expected_state_after: { props: { cup: { holder: 'hero', state: 'closed' } } } },
      { id: 'b', sceneId: 'scene1', prompt: 'b', plannedSourceFrames: 192, trim: { inFrame: 0, outFrame: 192 }, entities: { characters: [], props: ['cup'] }, dependencies: [{ type: 'continuity', target: 'shot:a' }], expected_state_before: { props: { cup: { holder: 'hero', state: 'closed' } } }, expected_state_after: { props: { cup: { holder: 'hero', state: 'closed' } } } },
    ],
  };
  const call = async (n, a) => JSON.parse((await handleToolCall(n, a)).content[0].text);

  beforeEach(() => {
    prevHome = process.env.FLOW_HOME;
    caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w08-C-'));
    process.env.FLOW_HOME = path.join(caseRoot, 'flow-home');
    initRuntimeDirs(process.env.FLOW_HOME);
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = prevHome;
    fs.rmSync(caseRoot, { recursive: true, force: true });
  });

  it('invalidates a reference-dependent approved shot through a continuity-seeded node', async () => {
    const input = structuredClone(base);
    input.shots[1].entities.characters = [];
    input.shots.push({ id: 'c', sceneId: 'scene1', prompt: 'c', plannedSourceFrames: 192, trim: { inFrame: 0, outFrame: 192 }, dependencies: [{ type: 'reference', target: 'shot:b' }] });
    const created = await call('flow_script_create', input);
    await call('flow_script_review', {
      scriptId: created.scriptId,
      expectedRevision: 1,
      nodeId: 'shot:c',
      nodeDigest: created.nodeStates['shot:c'].nodeDigest,
      reviewer: 'r@example.com',
      decision: 'approve',
    });
    input.bible.characters[0].prompt = 'Hero with substantially changed visual identity';
    input.shots[0].expected_state_after.props.cup.state = 'open';
    input.shots[1].expected_state_before.props.cup.state = 'open';
    const updated = await call('flow_script_update', {
      scriptId: created.scriptId,
      expectedRevision: 2,
      patch: { bible: input.bible, shots: input.shots },
    });
    expect(updated.invalidations.invalidatedNodeIds).toEqual(expect.arrayContaining(['char:hero', 'shot:a', 'shot:b', 'shot:c']));
    expect(updated.nodeStates['shot:c'].status).toBe('stale');
  });

  it('is order-independent for converging identity and continuity paths', () => {
    const story = {
      bible: { characters: [{ id: 'hero' }], locations: [], props: [] },
      scenes: [{ id: 's', locationId: undefined }],
      shots: [
        { id: 'a', sceneId: 's' },
        { id: 'b', sceneId: 's', dependencies: [{ type: 'continuity', target: 'shot:a' }] },
        { id: 'c', sceneId: 's', dependencies: [{ type: 'reference', target: 'shot:b' }] },
      ],
    };
    // Wire minimal DAG manually: hero -> a (reference), a -> b (continuity), b -> c (reference)
    const dag = buildStoryDag({
      bible: { characters: [{ id: 'hero' }], locations: [{ id: 'lab' }], props: [] },
      scenes: [{ id: 's', locationId: 'lab' }],
      shots: [
        { id: 'a', sceneId: 's', entities: { characters: ['hero'] } },
        { id: 'b', sceneId: 's', dependencies: [{ type: 'continuity', target: 'shot:a' }] },
        { id: 'c', sceneId: 's', dependencies: [{ type: 'reference', target: 'shot:b' }] },
      ],
    });
    void story;
    const order1 = computeSemanticInvalidations(dag, [
      { nodeId: 'shot:a', changeType: 'continuity' },
      { nodeId: 'char:hero', changeType: 'identity' },
    ]);
    const order2 = computeSemanticInvalidations(dag, [
      { nodeId: 'char:hero', changeType: 'identity' },
      { nodeId: 'shot:a', changeType: 'continuity' },
    ]);
    expect(order1.invalidatedNodeIds).toEqual(expect.arrayContaining(['shot:c']));
    expect(order2.invalidatedNodeIds).toEqual(expect.arrayContaining(['shot:c']));
    expect([...order1.invalidatedNodeIds].sort()).toEqual([...order2.invalidatedNodeIds].sort());
  });
});
