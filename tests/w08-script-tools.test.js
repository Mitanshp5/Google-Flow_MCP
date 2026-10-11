import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleToolCall } from '../src/index.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';

describe('W08 MCP Story Tools End-to-End Dispatcher Flow', () => {
  let tmpDir;
  let originalFlowHome;

  beforeEach(() => {
    originalFlowHome = process.env.FLOW_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-story-tools-test-'));
    process.env.FLOW_HOME = tmpDir;
    initRuntimeDirs(tmpDir);
  });

  afterEach(() => {
    if (originalFlowHome !== undefined) {
      process.env.FLOW_HOME = originalFlowHome;
    } else {
      delete process.env.FLOW_HOME;
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function callTool(name, args) {
    const raw = await handleToolCall(name, args);
    return JSON.parse(raw.content[0].text);
  }

  const canonicalTwoShotPlan = {
    binding: { accountKey: 'filmmaker@example.com', projectId: 'story_project_01' },
    policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: {
      title: 'The Alchemist Laboratory',
      aspectRatio: '16:9',
      fps: 24,
      targetDurationSec: 16,
    },
    bible: {
      characters: [
        { id: 'elena', name: 'Dr. Elena Vance', prompt: 'Cinematic portrait of Dr. Elena Vance' },
      ],
      locations: [
        { id: 'lab', name: 'Subterranean Lab', prompt: 'Dark underground laboratory with copper coils' },
      ],
      props: [
        { id: 'vial', name: 'Bioluminescent Vial', prompt: 'Glass vial containing swirling blue bioluminescent liquid' },
      ],
    },
    scenes: [
      { id: 'sc1', title: 'Lab Confrontation', locationId: 'lab' },
    ],
    shots: [
      {
        id: 'sh1',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['elena'], props: ['vial'] },
        prompt: 'Elena inspecting the bioluminescent vial on the lab table',
        expected_state_before: { props: { vial: { holder: null, state: 'inert' } } },
        expected_state_after: { props: { vial: { holder: 'elena', state: 'active' } } },
      },
      {
        id: 'sh2',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['elena'], props: ['vial'] },
        prompt: 'Elena lifting the glowing vial up to eye level, blue light illuminating her face',
        dependencies: [
          { type: 'continuity', target: 'shot:sh1' },
          { type: 'reference', target: 'char:elena' },
          { type: 'reference', target: 'prop:vial' },
        ],
        expected_state_before: { props: { vial: { holder: 'elena', state: 'active' } } },
        expected_state_after: { props: { vial: { holder: 'elena', state: 'active' } } },
      },
    ],
  };

  it('executes full vertical slice: create -> status -> review -> update -> invalidation via dispatcher', async () => {
    // 1. flow_story_create
    const created = await callTool('flow_story_create', canonicalTwoShotPlan);
    expect(created.storyId).toBeDefined();
    expect(created.revision).toBe(1);
    expect(created.canSpend).toBe(false);
    expect(created.liveVerified).toBe(false);

    const storyId = created.storyId;

    // 2. flow_story_status
    let status = await callTool('flow_story_status', { storyId });
    expect(status.title).toBe('The Alchemist Laboratory');
    expect(status.shotsSummary[0].readyForGeneration).toBe(false);
    expect(status.shotsSummary[0].blockingPrerequisites).toContain('char:elena');

    // 3. flow_story_review (approve lab, sc1, elena, vial)
    const labDigest = created.nodeStates['loc:lab'].nodeDigest;
    let rev = await callTool('flow_story_review', {
      storyId,
      expectedRevision: 1,
      nodeId: 'loc:lab',
      nodeDigest: labDigest,
      reviewer: 'filmmaker@example.com',
      decision: 'approve',
    });
    expect(rev.story.revision).toBe(2);

    rev = await callTool('flow_story_review', {
      storyId,
      expectedRevision: 2,
      nodeId: 'scene:sc1',
      nodeDigest: rev.story.nodeStates['scene:sc1'].nodeDigest,
      reviewer: 'filmmaker@example.com',
      decision: 'approve',
    });

    rev = await callTool('flow_story_review', {
      storyId,
      expectedRevision: 3,
      nodeId: 'char:elena',
      nodeDigest: rev.story.nodeStates['char:elena'].nodeDigest,
      reviewer: 'filmmaker@example.com',
      decision: 'approve',
    });

    rev = await callTool('flow_story_review', {
      storyId,
      expectedRevision: 4,
      nodeId: 'prop:vial',
      nodeDigest: rev.story.nodeStates['prop:vial'].nodeDigest,
      reviewer: 'filmmaker@example.com',
      decision: 'approve',
    });

    // 4. flow_story_status after entity approvals: sh1 is now ready for generation!
    status = await callTool('flow_story_status', { storyId });
    const shot1 = status.shotsSummary.find((s) => s.shotId === 'sh1');
    expect(shot1.readyForGeneration).toBe(true);

    const shot2 = status.shotsSummary.find((s) => s.shotId === 'sh2');
    expect(shot2.readyForGeneration).toBe(false);
    expect(shot2.blockingPrerequisites).toContain('shot:sh1');

    // 5. flow_story_update: mutate prop vial prompt (identity redesign)
    const updateRes = await callTool('flow_story_update', {
      storyId,
      expectedRevision: 5,
      patch: {
        bible: {
          ...canonicalTwoShotPlan.bible,
          props: [
            { id: 'vial', name: 'Bioluminescent Vial (Red)', prompt: 'Red glowing vial' },
          ],
        },
      },
    });

    expect(updateRes.revision).toBe(6);
    expect(updateRes.invalidations.invalidatedNodeIds).toContain('prop:vial');
    expect(updateRes.invalidations.affectedShots).toContain('sh1');
    expect(updateRes.invalidations.affectedShots).toContain('sh2');

    // 6. flow_story_status: sh1 is now stale and blocked again!
    status = await callTool('flow_story_status', { storyId });
    const shot1AfterUpdate = status.shotsSummary.find((s) => s.shotId === 'sh1');
    expect(shot1AfterUpdate.status).toBe('stale');
    expect(shot1AfterUpdate.readyForGeneration).toBe(false);
  });

  it('rejects stale expectedRevision on flow_story_update with STORAGE_CONFLICT', async () => {
    const created = await callTool('flow_story_create', canonicalTwoShotPlan);

    await expect(
      handleToolCall('flow_story_update', {
        storyId: created.storyId,
        expectedRevision: 99,
        patch: { brief: { title: 'New Title' } },
      })
    ).rejects.toThrow(/\[STORAGE_CONFLICT\]/);
  });

  it('rejects stale review submission with REVIEW_DIGEST_MISMATCH', async () => {
    const created = await callTool('flow_story_create', canonicalTwoShotPlan);

    await expect(
      handleToolCall('flow_story_review', {
        storyId: created.storyId,
        expectedRevision: 1,
        nodeId: 'char:elena',
        nodeDigest: 'stale_hash_that_does_not_match',
        reviewer: 'filmmaker@example.com',
        decision: 'approve',
      })
    ).rejects.toThrow(/\[REVIEW_DIGEST_MISMATCH\]/);
  });

  it('rejects status call with conflicting accountKey binding', async () => {
    const created = await callTool('flow_story_create', canonicalTwoShotPlan);

    await expect(
      handleToolCall('flow_story_status', {
        storyId: created.storyId,
        accountKey: 'intruder@example.com',
      })
    ).rejects.toThrow(/\[BINDING_CONFLICT\]/);
  });
});
