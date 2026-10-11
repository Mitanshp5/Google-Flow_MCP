import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createStory,
  getStoryStatus,
  reviewStoryNode,
} from '../src/script/planner.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';

describe('W08 Story Planner, Review Digest Verification & Non-Spend Invariants', () => {
  let tmpDir;
  let originalFlowHome;

  beforeEach(() => {
    originalFlowHome = process.env.FLOW_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-story-planner-test-'));
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

  const canonicalTwoShotStory = {
    binding: { accountKey: 'creator@example.com', projectId: 'project_alpha' },
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

  it('creates story with non-spend invariants and computes initial blocking prerequisites', () => {
    const created = createStory(canonicalTwoShotStory);

    expect(created.storyId).toBeDefined();
    expect(created.revision).toBe(1);
    expect(created.canSpend).toBe(false);
    expect(created.liveVerified).toBe(false);

    const status = getStoryStatus({ storyId: created.storyId });
    expect(status.canSpend).toBe(false);
    expect(status.liveVerified).toBe(false);
    expect(status.title).toBe('The Alchemist Laboratory');
    expect(status.nodeSummary.draft).toBe(6); // elena, lab, vial, sc1, sh1, sh2
    expect(status.shotsSummary[0].readyForGeneration).toBe(false);
    expect(status.shotsSummary[0].blockingPrerequisites).toContain('char:elena');
    expect(status.shotsSummary[0].blockingPrerequisites).toContain('prop:vial');
  });

  it('enforces exact nodeDigest and reviewer identity when reviewing a node', () => {
    const created = createStory(canonicalTwoShotStory);
    const storyId = created.storyId;

    const currentLabDigest = created.nodeStates['loc:lab'].nodeDigest;
    expect(currentLabDigest).toBeDefined();

    // 1. Missing reviewer throws REVIEWER_REQUIRED
    expect(() =>
      reviewStoryNode({
        storyId,
        expectedRevision: 1,
        nodeId: 'loc:lab',
        nodeDigest: currentLabDigest,
        decision: 'approve',
      })
    ).toThrow(/\[REVIEWER_REQUIRED\]/);

    // 2. Stale or incorrect digest throws REVIEW_DIGEST_MISMATCH
    expect(() =>
      reviewStoryNode({
        storyId,
        expectedRevision: 1,
        nodeId: 'loc:lab',
        nodeDigest: 'stale_or_wrong_sha256_digest',
        reviewer: 'director@example.com',
        decision: 'approve',
      })
    ).toThrow(/\[REVIEW_DIGEST_MISMATCH\]/);

    // 3. Valid review with correct digest advances revision and sets status to approved
    const reviewResult = reviewStoryNode({
      storyId,
      expectedRevision: 1,
      nodeId: 'loc:lab',
      nodeDigest: currentLabDigest,
      reviewer: 'director@example.com',
      decision: 'approve',
      notes: 'Approved concept art',
    });

    expect(reviewResult.story.revision).toBe(2);
    expect(reviewResult.story.nodeStates['loc:lab'].status).toBe('approved');
    expect(reviewResult.story.nodeStates['loc:lab'].reviews[0].reviewer).toBe('director@example.com');
  });

  it('progressively unblocks shots as prerequisite entities and scenes are approved', () => {
    const created = createStory(canonicalTwoShotStory);
    const storyId = created.storyId;

    // Approve loc:lab
    let res = reviewStoryNode({
      storyId,
      expectedRevision: 1,
      nodeId: 'loc:lab',
      nodeDigest: created.nodeStates['loc:lab'].nodeDigest,
      reviewer: 'lead@example.com',
      decision: 'approve',
    });

    // Approve scene:sc1
    res = reviewStoryNode({
      storyId,
      expectedRevision: 2,
      nodeId: 'scene:sc1',
      nodeDigest: res.story.nodeStates['scene:sc1'].nodeDigest,
      reviewer: 'lead@example.com',
      decision: 'approve',
    });

    // Approve char:elena
    res = reviewStoryNode({
      storyId,
      expectedRevision: 3,
      nodeId: 'char:elena',
      nodeDigest: res.story.nodeStates['char:elena'].nodeDigest,
      reviewer: 'lead@example.com',
      decision: 'approve',
    });

    // Approve prop:vial
    res = reviewStoryNode({
      storyId,
      expectedRevision: 4,
      nodeId: 'prop:vial',
      nodeDigest: res.story.nodeStates['prop:vial'].nodeDigest,
      reviewer: 'lead@example.com',
      decision: 'approve',
    });

    // Status: sh1 should now be ready!
    let status = getStoryStatus({ storyId });
    const shot1 = status.shotsSummary.find((s) => s.shotId === 'sh1');
    expect(shot1.readyForGeneration).toBe(true);
    expect(shot1.blockingPrerequisites).toEqual([]);

    // sh2 is still blocked on sh1 continuity
    const shot2 = status.shotsSummary.find((s) => s.shotId === 'sh2');
    expect(shot2.readyForGeneration).toBe(false);
    expect(shot2.blockingPrerequisites).toContain('shot:sh1');

    // Approve shot:sh1
    res = reviewStoryNode({
      storyId,
      expectedRevision: 5,
      nodeId: 'shot:sh1',
      nodeDigest: res.story.nodeStates['shot:sh1'].nodeDigest,
      reviewer: 'lead@example.com',
      decision: 'approve',
    });
    expect(res.story.revision).toBe(6);

    // Now sh2 is also unblocked!
    status = getStoryStatus({ storyId });
    const shot2Updated = status.shotsSummary.find((s) => s.shotId === 'sh2');
    expect(shot2Updated.readyForGeneration).toBe(true);
    expect(shot2Updated.blockingPrerequisites).toEqual([]);
  });

  it('rejects status checks with conflicting accountKey or projectId', () => {
    const created = createStory(canonicalTwoShotStory);

    expect(() =>
      getStoryStatus({
        storyId: created.storyId,
        accountKey: 'other_unauthorized@example.com',
      })
    ).toThrow(/\[BINDING_CONFLICT\]/);
  });
});
