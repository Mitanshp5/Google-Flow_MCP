import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleToolCall } from '../src/index.js';
import {
  saveNewStory,
  getStory,
  getStoryDir,
  getStoryLockFile,
  computeCanonicalDigest,
} from '../src/script/store.js';
import { acquireLock } from '../src/storage/runtime-store.js';
import { reviewStoryNode } from '../src/script/planner.js';
import { buildStoryDag, topologicalSort } from '../src/script/dag.js';

describe('W08 Adversarial Verification Suite — 6 Confirmed Blocker Families', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-w08-adv-'));
    process.env.FLOW_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.FLOW_HOME;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const validStorySpec = {
    binding: { accountKey: 'creator@example.com', projectId: 'proj_alpha' },
    policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: { title: 'Adversarial Test Script', aspectRatio: '16:9', fps: 24, targetDurationSec: 16 },
    bible: {
      characters: [
        { id: 'elena', name: 'Dr. Elena Vance', prompt: 'Elena Vance in lab coat' },
        { id: 'marcus', name: 'Marcus Cole', prompt: 'Marcus Cole in tactical gear' },
      ],
      locations: [
        { id: 'lab', name: 'Subterranean Lab', prompt: 'High-tech lab with glowing apparatus' },
        { id: 'vault', name: 'The Vault', prompt: 'Titanium bank vault' },
      ],
      props: [
        { id: 'vial', name: 'Bioluminescent Vial', prompt: 'Glowing blue vial' },
      ],
    },
    scenes: [
      { id: 'sc1', title: 'Lab Scene', locationId: 'lab' },
    ],
    shots: [
      {
        id: 'sh1',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['elena'], props: ['vial'] },
        prompt: 'Elena inspecting the vial on the table',
        expected_state_before: { props: { vial: { holder: null, state: 'inert' } } },
        expected_state_after: { props: { vial: { holder: 'elena', state: 'active' } } },
      },
      {
        id: 'sh2',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['elena'], props: ['vial'] },
        prompt: 'Elena raising the active vial to the light',
        dependencies: [
          { type: 'continuity', target: 'shot:sh1' },
        ],
        expected_state_before: { props: { vial: { holder: 'elena', state: 'active' } } },
        expected_state_after: { props: { vial: { holder: 'elena', state: 'active' } } },
      },
    ],
  };

  async function callTool(name, args) {
    const res = await handleToolCall(name, args);
    return JSON.parse(res.content[0].text);
  }

  // --------------------------------------------------------------------------
  // BLOCKER 1: Filesystem Containment
  // --------------------------------------------------------------------------
  describe('Blocker 1: Filesystem Containment', () => {
    it('rejects path traversal in storyId / scriptId via dispatcher', async () => {
      await expect(
        handleToolCall('flow_story_create', {
          ...validStorySpec,
          storyId: '../../escaped-story',
        })
      ).rejects.toThrow();

      // Ensure no directory was created outside stories/
      const outsidePath = path.resolve(tmpDir, '..', 'escaped-story');
      expect(fs.existsSync(outsidePath)).toBe(false);
    });

    it('rejects path traversal in store.js getStoryDir and saveNewStory', () => {
      expect(() => getStoryDir('../../escaped-story')).toThrow(/\[INVALID_STORY_ID\]/);
      expect(() =>
        saveNewStory({
          ...validStorySpec,
          storyId: '../../escaped-story',
        })
      ).toThrow(/\[INVALID_STORY_ID\]/);
    });

    it('rejects null bytes and backslashes in story IDs', () => {
      expect(() => getStoryDir('bad\0id')).toThrow(/\[INVALID_STORY_ID\]/);
      expect(() => getStoryDir('bad\\nested\\id')).toThrow(/\[INVALID_STORY_ID\]/);
      expect(() => getStoryDir('bad/nested/id')).toThrow(/\[INVALID_STORY_ID\]/);
    });
  });

  // --------------------------------------------------------------------------
  // BLOCKER 2: Mandatory Review Binding
  // --------------------------------------------------------------------------
  describe('Blocker 2: Mandatory Review Binding', () => {
    it('rejects review approval when nodeDigest is omitted', async () => {
      const created = await callTool('flow_story_create', validStorySpec);
      const storyId = created.storyId;

      await expect(
        handleToolCall('flow_story_review', {
          storyId,
          expectedRevision: 1,
          nodeId: 'char:elena',
          reviewer: 'director@example.com',
          decision: 'approve',
        })
      ).rejects.toThrow();
    });

    it('rejects review approval when nodeDigest is empty string or whitespace', async () => {
      const created = await callTool('flow_story_create', validStorySpec);
      const storyId = created.storyId;

      await expect(
        handleToolCall('flow_story_review', {
          storyId,
          expectedRevision: 1,
          nodeId: 'char:elena',
          nodeDigest: '',
          reviewer: 'director@example.com',
          decision: 'approve',
        })
      ).rejects.toThrow();

      await expect(
        handleToolCall('flow_story_review', {
          storyId,
          expectedRevision: 1,
          nodeId: 'char:elena',
          nodeDigest: '   ',
          reviewer: 'director@example.com',
          decision: 'approve',
        })
      ).rejects.toThrow();
    });

    it('rejects planner reviewStoryNode directly without valid nodeDigest', () => {
      const created = saveNewStory(validStorySpec);
      expect(() =>
        reviewStoryNode({
          storyId: created.storyId,
          expectedRevision: 1,
          nodeId: 'char:elena',
          nodeDigest: '',
          reviewer: 'director@example.com',
          decision: 'approve',
        })
      ).toThrow(/\[REVIEW_DIGEST_REQUIRED\]/);
    });

    it('rejects review with stale or mismatched nodeDigest', async () => {
      const created = await callTool('flow_story_create', validStorySpec);
      await expect(
        handleToolCall('flow_story_review', {
          storyId: created.storyId,
          expectedRevision: 1,
          nodeId: 'char:elena',
          nodeDigest: '0000000000000000000000000000000000000000000000000000000000000000',
          reviewer: 'director@example.com',
          decision: 'approve',
        })
      ).rejects.toThrow(/\[REVIEW_DIGEST_MISMATCH\]/);
    });
  });

  // --------------------------------------------------------------------------
  // BLOCKER 3: Real Graph Validation
  // --------------------------------------------------------------------------
  describe('Blocker 3: Real Graph Validation', () => {
    it('rejects dangling dependency pointing to non-existent shot', async () => {
      const danglingStory = {
        ...validStorySpec,
        shots: [
          {
            ...validStorySpec.shots[0],
            dependencies: [{ type: 'continuity', target: 'shot:ghost_shot' }],
          },
        ],
      };

      await expect(
        handleToolCall('flow_story_create', danglingStory)
      ).rejects.toThrow(/\[DANGLING_DEPENDENCY\]/);
    });

    it('rejects two-shot dependency cycle (sh1 -> sh2 -> sh1)', async () => {
      const cyclicStory = {
        ...validStorySpec,
        shots: [
          {
            ...validStorySpec.shots[0],
            dependencies: [{ type: 'continuity', target: 'shot:sh2' }],
          },
          {
            ...validStorySpec.shots[1],
            dependencies: [{ type: 'continuity', target: 'shot:sh1' }],
          },
        ],
      };

      await expect(
        handleToolCall('flow_story_create', cyclicStory)
      ).rejects.toThrow(/\[CYCLIC_DEPENDENCY\]/);
    });

    it('correctly builds forward dependency edges and topologically sorts them', () => {
      // sh1 depends on sh2, where sh2 is declared later in the shots array
      const forwardStory = {
        ...validStorySpec,
        shots: [
          {
            id: 'sh_alpha',
            sceneId: 'sc1',
            plannedSourceFrames: 192,
            trim: { inFrame: 0, outFrame: 192 },
            dependencies: [{ type: 'reference', target: 'shot:sh_beta' }],
          },
          {
            id: 'sh_beta',
            sceneId: 'sc1',
            plannedSourceFrames: 192,
            trim: { inFrame: 0, outFrame: 192 },
            dependencies: [],
          },
        ],
      };

      const dag = buildStoryDag(forwardStory);
      const sorted = topologicalSort(dag);

      expect(dag.nodes.has('shot:sh_alpha')).toBe(true);
      expect(dag.nodes.has('shot:sh_beta')).toBe(true);

      // sh_beta is a prerequisite for sh_alpha, so it must precede sh_alpha in sorted order
      expect(sorted.indexOf('shot:sh_beta')).toBeLessThan(sorted.indexOf('shot:sh_alpha'));
    });
  });

  // --------------------------------------------------------------------------
  // BLOCKER 4: Continuity and Timing Bounds
  // --------------------------------------------------------------------------
  describe('Blocker 4: Continuity and Timing Bounds', () => {
    it('rejects impossible trim covering frames 200–300 for a 192-frame source', async () => {
      const badTrimStory = {
        ...validStorySpec,
        shots: [
          {
            ...validStorySpec.shots[0],
            plannedSourceFrames: 192,
            trim: { inFrame: 200, outFrame: 300 },
          },
        ],
      };

      await expect(
        handleToolCall('flow_story_create', badTrimStory)
      ).rejects.toThrow(/\[IMPOSSIBLE_TIMING\]/);
    });

    it('rejects unsafe frame integers', async () => {
      const unsafeStory = {
        ...validStorySpec,
        shots: [
          {
            ...validStorySpec.shots[0],
            plannedSourceFrames: Number.MAX_SAFE_INTEGER + 10,
          },
        ],
      };

      await expect(
        handleToolCall('flow_story_create', unsafeStory)
      ).rejects.toThrow(/\[IMPOSSIBLE_TIMING\]/);
    });

    it('rejects undeclared prop holder not present in bible characters', async () => {
      const undeclaredHolderStory = {
        ...validStorySpec,
        shots: [
          {
            ...validStorySpec.shots[0],
            expected_state_before: {
              props: {
                vial: { holder: 'unregistered_phantom', state: 'inert' },
              },
            },
          },
        ],
      };

      await expect(
        handleToolCall('flow_story_create', undeclaredHolderStory)
      ).rejects.toThrow(/\[UNDECLARED_HOLDER\]/);
    });

    it('rejects conflicting predecessor/successor states across continuity edge', async () => {
      const conflictingStateStory = {
        ...validStorySpec,
        shots: [
          {
            id: 'sh1',
            sceneId: 'sc1',
            plannedSourceFrames: 192,
            trim: { inFrame: 0, outFrame: 192 },
            expected_state_after: {
              props: { vial: { holder: 'elena', state: 'active' } },
            },
          },
          {
            id: 'sh2',
            sceneId: 'sc1',
            plannedSourceFrames: 192,
            trim: { inFrame: 0, outFrame: 192 },
            dependencies: [{ type: 'continuity', target: 'shot:sh1' }],
            // CONFLICT: predecessor ended with vial held by elena in active state,
            // but successor begins with vial held by marcus without explanation!
            expected_state_before: {
              props: { vial: { holder: 'marcus', state: 'active' } },
            },
            expected_state_after: {
              props: { vial: { holder: 'marcus', state: 'active' } },
            },
          },
        ],
      };

      await expect(
        handleToolCall('flow_story_create', conflictingStateStory)
      ).rejects.toThrow(/\[CONTINUITY_BREAK\]/);
    });
  });

  // --------------------------------------------------------------------------
  // BLOCKER 5: Semantic Invalidation
  // --------------------------------------------------------------------------
  describe('Blocker 5: Semantic Invalidation', () => {
    it('invalidates approved character and dependent shots when appearance changes', async () => {
      const created = await callTool('flow_story_create', validStorySpec);
      const storyId = created.storyId;

      const elenaDigest = created.nodeStates['char:elena'].nodeDigest;

      // 1. Approve elena
      const rev2 = await callTool('flow_story_review', {
        storyId,
        expectedRevision: 1,
        nodeId: 'char:elena',
        nodeDigest: elenaDigest,
        reviewer: 'director@example.com',
        decision: 'approve',
      });
      expect(rev2.story.nodeStates['char:elena'].status).toBe('approved');

      // 2. Update elena appearance
      const updated = await callTool('flow_story_update', {
        storyId,
        expectedRevision: 2,
        patch: {
          bible: {
            characters: [
              {
                id: 'elena',
                name: 'Dr. Elena Vance',
                appearance: 'Cybernetic ocular implant and scorched coat',
                prompt: 'Elena Vance with cybernetic augmentations',
              },
              validStorySpec.bible.characters[1],
            ],
            locations: validStorySpec.bible.locations,
            props: validStorySpec.bible.props,
          },
        },
      });

      // Elena must be marked stale, NOT remain approved!
      expect(updated.invalidations.invalidatedNodeIds).toContain('char:elena');
      expect(updated.invalidations.affectedShots).toContain('sh1');
      expect(updated.invalidations.affectedShots).toContain('sh2');
      expect(updated.story.nodeStates['char:elena'].status).toBe('stale');
      expect(updated.story.nodeStates['char:elena'].nodeDigest).not.toBe(elenaDigest);
    });

    it('invalidates approved scene and dependent shots when locationId changes', async () => {
      const created = await callTool('flow_story_create', validStorySpec);
      const storyId = created.storyId;

      const sc1Digest = created.nodeStates['scene:sc1'].nodeDigest;

      // 1. Approve scene sc1
      const rev2 = await callTool('flow_story_review', {
        storyId,
        expectedRevision: 1,
        nodeId: 'scene:sc1',
        nodeDigest: sc1Digest,
        reviewer: 'director@example.com',
        decision: 'approve',
      });
      expect(rev2.story.nodeStates['scene:sc1'].status).toBe('approved');

      // 2. Change sc1 location from 'lab' to 'vault'
      const updated = await callTool('flow_story_update', {
        storyId,
        expectedRevision: 2,
        patch: {
          scenes: [
            { id: 'sc1', title: 'Lab Scene Relocated', locationId: 'vault' },
          ],
        },
      });

      // Scene must be marked stale and dependent shots invalidated
      expect(updated.invalidations.invalidatedNodeIds).toContain('scene:sc1');
      expect(updated.invalidations.affectedShots).toContain('sh1');
      expect(updated.story.nodeStates['scene:sc1'].status).toBe('stale');
    });

    it('prevents any approved node from remaining approved when its digest changes', async () => {
      const created = await callTool('flow_story_create', validStorySpec);
      const storyId = created.storyId;
      const vialDigest = created.nodeStates['prop:vial'].nodeDigest;

      // Approve vial
      const rev2 = await callTool('flow_story_review', {
        storyId,
        expectedRevision: 1,
        nodeId: 'prop:vial',
        nodeDigest: vialDigest,
        reviewer: 'director@example.com',
        decision: 'approve',
      });
      expect(rev2.story.nodeStates['prop:vial'].status).toBe('approved');

      // Edit vial prompt
      const updated = await callTool('flow_story_update', {
        storyId,
        expectedRevision: 2,
        patch: {
          bible: {
            characters: validStorySpec.bible.characters,
            locations: validStorySpec.bible.locations,
            props: [
              { id: 'vial', name: 'Bioluminescent Vial', prompt: 'Cracked vial emitting red smoke', state: 'unstable' },
            ],
          },
        },
      });

      // Must be reset to stale
      expect(updated.story.nodeStates['prop:vial'].status).toBe('stale');
    });
  });

  // --------------------------------------------------------------------------
  // BLOCKER 6: Creation Locking and Snapshot Integrity
  // --------------------------------------------------------------------------
  describe('Blocker 6: Creation Locking and Snapshot Integrity', () => {
    it('fails story creation when story.lock is held', async () => {
      const storyId = 'locked-target-story';
      const storyDir = path.join(tmpDir, 'stories', storyId);
      fs.mkdirSync(storyDir, { recursive: true });

      // Acquire lock externally before creation
      const lockFile = getStoryLockFile(storyId, tmpDir);
      const lock = acquireLock(lockFile);

      try {
        await expect(
          handleToolCall('flow_story_create', {
            ...validStorySpec,
            storyId,
          })
        ).rejects.toThrow(/exclusive lock already held/);
      } finally {
        lock.release();
      }
    });

    it('rejects reading a snapshot whose digest was removed with STORAGE_CORRUPT', () => {
      const created = saveNewStory(validStorySpec);
      const storyId = created.storyId;
      const revId = created.revisionId;

      const snapshotFile = path.join(getStoryDir(storyId, tmpDir), 'revisions', revId, 'snapshot.json');
      const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));

      // Tamper: delete digest property
      delete snapshot.digest;
      fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

      expect(() => getStory(storyId)).toThrow(/\[STORAGE_CORRUPT\]/);
    });

    it('rejects a modified snapshot whose recomputed digest contradicts unchanged manifest currentDigest', () => {
      const created = saveNewStory(validStorySpec);
      const storyId = created.storyId;
      const revId = created.revisionId;

      const snapshotFile = path.join(getStoryDir(storyId, tmpDir), 'revisions', revId, 'snapshot.json');
      const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));

      // Tamper: change character prompt AND recompute snapshot.digest
      snapshot.bible.characters[0].prompt = 'TAMPERED PROMPT';
      const contentToDigest = { ...snapshot };
      delete contentToDigest.digest;
      delete contentToDigest.revisionId;
      snapshot.digest = computeCanonicalDigest(contentToDigest);

      fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

      // Reading must detect contradiction between snapshot.digest and manifest.currentDigest
      expect(() => getStory(storyId)).toThrow(/\[STORAGE_CORRUPT\]/);
    });
  });
});
