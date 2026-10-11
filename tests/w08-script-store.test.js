import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  saveNewStory,
  getStory,
  getStoryDir,
  updateStoryRecord,
  listStories,
} from '../src/script/store.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';

describe('W08 Immutable Revision Storage & Content-Addressed Store', () => {
  let tmpDir;
  let originalFlowHome;

  beforeEach(() => {
    originalFlowHome = process.env.FLOW_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-story-store-test-'));
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

  const sampleStoryInput = {
    binding: { accountKey: 'creator@example.com', projectId: 'proj_alpha' },
    policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: {
      title: 'Neon Odyssey',
      aspectRatio: '16:9',
      fps: 24,
      targetDurationSec: 16,
    },
    bible: {
      characters: [
        { id: 'kai', name: 'Kai Ryker', prompt: 'Cyberpunk pilot Kai Ryker in worn flight jacket' },
        { id: 'mira', name: 'Mira Chen', prompt: 'Tech operative Mira Chen with neon visor' },
      ],
      locations: [
        { id: 'dock', name: 'Sky Dock 7', prompt: 'Floating sky dock platform in cyberpunk city' },
      ],
      props: [
        { id: 'drive', name: 'Quantum Drive', prompt: 'Cylindrical drive emitting blue pulse' },
      ],
    },
    scenes: [
      { id: 'sc1', title: 'Docking Bay Heist', locationId: 'dock' },
    ],
    shots: [
      {
        id: 'sh1',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['kai'], props: ['drive'] },
        expected_state_before: { props: { drive: { holder: null, state: 'inert' } } },
        expected_state_after: { props: { drive: { holder: 'kai', state: 'active' } } },
      },
      {
        id: 'sh2',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['kai', 'mira'], props: ['drive'] },
        dependencies: [{ type: 'continuity', target: 'shot:sh1' }],
        expected_state_before: { props: { drive: { holder: 'kai', state: 'active' } } },
        expected_state_after: { props: { drive: { holder: 'kai', state: 'active' } } },
      },
    ],
  };

  it('persists story in roadmap layout with immutable snapshot and manifest pointer', () => {
    const saved = saveNewStory(sampleStoryInput);

    expect(saved.storyId).toBeDefined();
    expect(saved.revision).toBe(1);
    expect(saved.digest).toBeDefined();

    const storyDir = getStoryDir(saved.storyId);
    const manifestPath = path.join(storyDir, 'manifest.json');
    const revisionsDir = path.join(storyDir, 'revisions');
    const journalDir = path.join(storyDir, 'journal');

    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(revisionsDir)).toBe(true);
    expect(fs.existsSync(journalDir)).toBe(true);

    const snapshotPath = path.join(revisionsDir, saved.revisionId, 'snapshot.json');
    expect(fs.existsSync(snapshotPath)).toBe(true);

    // Verify manifest points to revisionId
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.currentRevision).toBe(1);
    expect(manifest.currentRevisionId).toBe(saved.revisionId);
    expect(manifest.currentDigest).toBe(saved.digest);
  });

  it('retrieves an existing story by ID and validates content digest', () => {
    const saved = saveNewStory(sampleStoryInput);
    const loaded = getStory(saved.storyId);

    expect(loaded.storyId).toBe(saved.storyId);
    expect(loaded.revision).toBe(1);
    expect(loaded.brief.title).toBe('Neon Odyssey');
    expect(loaded.shots.length).toBe(2);
    expect(loaded.digest).toBe(saved.digest);
  });

  it('throws STORY_NOT_FOUND when retrieving unknown story ID', () => {
    expect(() => getStory('non_existent_story_uuid')).toThrow(/\[STORY_NOT_FOUND\]/);
  });

  it('updates story atomically committing snapshot first and manifest last under CAS lock', () => {
    const initial = saveNewStory(sampleStoryInput);
    expect(initial.revision).toBe(1);

    // Update with prop appearance change (identity change)
    const patch = {
      bible: {
        ...initial.bible,
        props: [
          { id: 'drive', name: 'Quantum Drive', prompt: 'Damaged smoking quantum drive' },
        ],
      },
    };

    const result = updateStoryRecord(initial.storyId, 1, patch);
    expect(result.story.revision).toBe(2);
    expect(result.story.revisionId).not.toBe(initial.revisionId);

    // Revision 1 snapshot must still exist untouched (immutable)!
    const rev1SnapshotPath = path.join(
      getStoryDir(initial.storyId),
      'revisions',
      initial.revisionId,
      'snapshot.json'
    );
    expect(fs.existsSync(rev1SnapshotPath)).toBe(true);

    // Revision 2 snapshot must exist
    const rev2SnapshotPath = path.join(
      getStoryDir(initial.storyId),
      'revisions',
      result.story.revisionId,
      'snapshot.json'
    );
    expect(fs.existsSync(rev2SnapshotPath)).toBe(true);

    // Drive prop identity changed, so sh1 and sh2 became stale
    expect(result.invalidations.invalidatedNodeIds).toContain('prop:drive');
    expect(result.invalidations.affectedShots).toContain('sh1');
    expect(result.invalidations.affectedShots).toContain('sh2');
    expect(result.story.nodeStates['shot:sh1'].status).toBe('stale');
  });

  it('metadata-only update preserves media and node status', () => {
    const initial = saveNewStory(sampleStoryInput);

    // Update only brief title (metadata)
    const patch = {
      brief: { ...initial.brief, title: 'Neon Odyssey (Director Cut)' },
    };

    const result = updateStoryRecord(initial.storyId, 1, patch);
    expect(result.story.revision).toBe(2);
    expect(result.story.brief.title).toBe('Neon Odyssey (Director Cut)');
    expect(result.invalidations.invalidatedNodeIds).toEqual([]);
    expect(result.story.nodeStates['shot:sh1'].status).toBe('draft');
  });

  it('rejects update with STORAGE_CONFLICT on expected revision mismatch', () => {
    const initial = saveNewStory(sampleStoryInput);

    const patch = { brief: { ...initial.brief, title: 'Wrong Title' } };
    expect(() => updateStoryRecord(initial.storyId, 999, patch)).toThrow(/\[STORAGE_CONFLICT\]/);

    // Story remains at revision 1
    const current = getStory(initial.storyId);
    expect(current.revision).toBe(1);
    expect(current.brief.title).toBe('Neon Odyssey');
  });

  it('corruption preserves original file and raises STORAGE_CORRUPT without creating empty story', () => {
    const initial = saveNewStory(sampleStoryInput);
    const manifestPath = path.join(getStoryDir(initial.storyId), 'manifest.json');

    // Overwrite manifest with corrupt garbage
    fs.writeFileSync(manifestPath, '{ this is not valid json }');

    // Reading must throw STORAGE_CORRUPT and backup the corrupt file
    expect(() => getStory(initial.storyId)).toThrow(/storage file corrupt|STORAGE_CORRUPT/);

    // Verify backup exists
    const files = fs.readdirSync(getStoryDir(initial.storyId));
    const backup = files.find((f) => f.includes('.corrupt.'));
    expect(backup).toBeDefined();
  });

  it('handles crash recovery: uncommitted snapshot leaves manifest pointing to previous revision', () => {
    const initial = saveNewStory(sampleStoryInput);

    // Simulate an orphaned snapshot written by a crashed process without manifest commit
    const orphanedRevDir = path.join(getStoryDir(initial.storyId), 'revisions', 'rev_orphaned');
    fs.mkdirSync(orphanedRevDir, { recursive: true });
    fs.writeFileSync(path.join(orphanedRevDir, 'snapshot.json'), JSON.stringify({ dummy: true }));

    // getStory must read the authoritative manifest pointer (revision 1)
    const loaded = getStory(initial.storyId);
    expect(loaded.revision).toBe(1);
    expect(loaded.revisionId).toBe(initial.revisionId);
  });

  it('lists stored stories with title, accountKey, and revision summaries', () => {
    saveNewStory(sampleStoryInput);
    saveNewStory({
      ...sampleStoryInput,
      brief: { ...sampleStoryInput.brief, title: 'Second Story' },
    });

    const list = listStories();
    expect(list.length).toBe(2);
    const titles = list.map((s) => s.title);
    expect(titles).toContain('Neon Odyssey');
    expect(titles).toContain('Second Story');
  });
});
