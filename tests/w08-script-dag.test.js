import { describe, it, expect } from 'vitest';
import { validateStoryInput } from '../src/script/schema.js';
import {
  buildStoryDag,
  topologicalSort,
  computeSemanticInvalidations,
} from '../src/script/dag.js';

describe('W08 Continuity State DAG & Semantic Invalidation', () => {
  const baseStorySpec = {
    binding: { accountKey: 'creator@example.com', projectId: 'proj_alpha' },
    policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: { title: 'The Alchemist Lab', aspectRatio: '16:9', fps: 24, targetDurationSec: 24 },
    bible: {
      characters: [
        { id: 'elena', name: 'Dr. Elena Vance' },
        { id: 'marcus', name: 'Marcus Cole' },
      ],
      locations: [
        { id: 'lab', name: 'Subterranean Lab' },
        { id: 'vault', name: 'The Vault' },
      ],
      props: [
        { id: 'vial', name: 'Bioluminescent Vial' },
        { id: 'keycard', name: 'Level 5 Keycard' },
      ],
    },
    scenes: [
      { id: 'sc1', title: 'Lab Confrontation', locationId: 'lab' },
      { id: 'sc2', title: 'Vault Entry', locationId: 'vault' },
    ],
    shots: [
      {
        id: 'sh1',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        entities: { characters: ['elena'], props: ['vial'] },
      },
      {
        id: 'sh2',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        entities: { characters: ['elena'], props: ['vial'] },
        // Explicit continuity dependency on sh1
        dependencies: [
          { type: 'continuity', target: 'shot:sh1' },
        ],
      },
      {
        id: 'sh3',
        sceneId: 'sc2',
        plannedSourceFrames: 192,
        entities: { characters: ['marcus'], props: ['keycard'] },
        // Independent shot in sc2 — no continuity dependency on sh1 or sh2
        dependencies: [],
      },
    ],
  };

  const validStory = validateStoryInput(baseStorySpec);

  it('builds DAG distinguishing explicit continuity from mere ordering', () => {
    const dag = buildStoryDag(validStory);

    expect(dag.nodes.has('char:elena')).toBe(true);
    expect(dag.nodes.has('shot:sh1')).toBe(true);
    expect(dag.nodes.has('shot:sh2')).toBe(true);
    expect(dag.nodes.has('shot:sh3')).toBe(true);

    // sh2 explicitly depends on sh1
    const sh2Incoming = dag.getDependencies('shot:sh2');
    const sh1Dep = sh2Incoming.find((d) => (d.prerequisite === 'shot:sh1' || d.source === 'shot:sh1'));
    expect(sh1Dep).toBeDefined();
    expect(sh1Dep.type).toBe('continuity');

    // sh3 has NO dependency on sh1 or sh2
    const sh3Incoming = dag.getDependencies('shot:sh3');
    expect(sh3Incoming.some((d) => d.prerequisite === 'shot:sh1' || d.source === 'shot:sh1')).toBe(false);
    expect(sh3Incoming.some((d) => d.prerequisite === 'shot:sh2' || d.source === 'shot:sh2')).toBe(false);
  });

  it('performs topological sort and detects cyclic dependencies', () => {
    const dag = buildStoryDag(validStory);
    const sorted = topologicalSort(dag);

    expect(sorted.length).toBe(dag.nodes.size);
    expect(sorted.indexOf('char:elena')).toBeLessThan(sorted.indexOf('shot:sh1'));
    expect(sorted.indexOf('shot:sh1')).toBeLessThan(sorted.indexOf('shot:sh2'));

    // Cyclic DAG throws FlowError CYCLIC_DEPENDENCY
    const cyclicDag = {
      nodes: new Map([
        ['nodeA', { id: 'nodeA', incoming: [{ target: 'nodeB', type: 'continuity' }] }],
        ['nodeB', { id: 'nodeB', incoming: [{ target: 'nodeA', type: 'continuity' }] }],
      ]),
      getDependencies: (id) => cyclicDag.nodes.get(id)?.incoming || [],
    };
    expect(() => topologicalSort(cyclicDag)).toThrow(/\[CYCLIC_DEPENDENCY\]/);
  });

  it('metadata changes produce zero downstream invalidations', () => {
    const dag = buildStoryDag(validStory);

    // Renaming character elena (metadata only)
    const result = computeSemanticInvalidations(dag, [
      { nodeId: 'char:elena', changeType: 'metadata' },
    ]);

    expect(result.invalidatedNodeIds).toEqual([]);
    expect(result.affectedShots).toEqual([]);
    expect(result.preservedNodeIds.length).toBe(dag.nodes.size);
  });

  it('identity changes propagate across reference and continuity edges while preserving unrelated branches', () => {
    const dag = buildStoryDag(validStory);

    // Identity change to prop vial (e.g. appearance redesign)
    const result = computeSemanticInvalidations(dag, [
      { nodeId: 'prop:vial', changeType: 'identity' },
    ]);

    expect(result.invalidatedNodeIds).toContain('prop:vial');
    expect(result.invalidatedNodeIds).toContain('shot:sh1');
    expect(result.invalidatedNodeIds).toContain('shot:sh2');

    // sh3, marcus, keycard, vault, sc2 must remain preserved!
    expect(result.preservedNodeIds).toContain('shot:sh3');
    expect(result.preservedNodeIds).toContain('char:marcus');
    expect(result.preservedNodeIds).toContain('prop:keycard');
    expect(result.preservedNodeIds).toContain('scene:sc2');
    expect(result.preservedNodeIds).toContain('loc:vault');
  });

  it('continuity changes only propagate across continuity edges and leave upstream preserved', () => {
    const dag = buildStoryDag(validStory);

    // Modifying continuity state on shot:sh1
    const result = computeSemanticInvalidations(dag, [
      { nodeId: 'shot:sh1', changeType: 'continuity' },
    ]);

    expect(result.invalidatedNodeIds).toContain('shot:sh1');
    expect(result.invalidatedNodeIds).toContain('shot:sh2'); // depends on sh1 via continuity
    expect(result.preservedNodeIds).toContain('char:elena'); // upstream preserved
    expect(result.preservedNodeIds).toContain('prop:vial'); // upstream preserved
    expect(result.preservedNodeIds).toContain('shot:sh3'); // independent preserved
  });
});
