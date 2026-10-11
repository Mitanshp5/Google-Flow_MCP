import { describe, it, expect } from 'vitest';
import {
  validateStoryInput,
  parseRationalFps,
  reduceRational,
  framesForDuration,
} from '../src/script/schema.js';

describe('W08 Story Schema, Rational Time & Bounded Policy Validation', () => {
  const validBaseStory = {
    binding: {
      accountKey: 'creator@example.com',
      projectId: 'project_alpha',
    },
    policy: {
      candidateLimit: 4,
      timeBudgetSec: 3600,
      creditCap: 0,
      policyRevision: 1,
    },
    governance: {
      privacyMode: 'private',
      referenceRights: 'synthetic',
      reviewAuthority: 'client_human',
    },
    brief: {
      title: 'Neon Odyssey',
      aspectRatio: '16:9',
      fps: 24,
      targetDurationSec: 16,
    },
    bible: {
      characters: [
        { id: 'kai', name: 'Kai Ryker' },
      ],
      locations: [
        { id: 'dock', name: 'Sky Dock 7' },
      ],
      props: [
        { id: 'drive', name: 'Quantum Drive' },
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
        transitionHandles: { headFrames: 0, tailFrames: 0 },
        entities: { characters: ['kai'], props: ['drive'] },
        expected_state_before: {
          props: { drive: { holder: null, state: 'inert', visible: true } },
        },
        expected_state_after: {
          props: { drive: { holder: 'kai', state: 'active', visible: true } },
        },
      },
      {
        id: 'sh2',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['kai'], props: ['drive'] },
        dependencies: [
          { type: 'continuity', target: 'shot:sh1' },
          { type: 'reference', target: 'char:kai' },
        ],
        expected_state_before: {
          props: { drive: { holder: 'kai', state: 'active', visible: true } },
        },
        expected_state_after: {
          props: { drive: { holder: 'kai', state: 'active', visible: true } },
        },
      },
    ],
  };

  it('validates a complete story spec with explicit bindings, policy, governance and rational fps', () => {
    const validated = validateStoryInput(validBaseStory);

    expect(validated.binding.accountKey).toBe('creator@example.com');
    expect(validated.binding.projectId).toBe('project_alpha');
    expect(validated.policy.candidateLimit).toBe(4);
    expect(validated.policy.creditCap).toBe(0);
    expect(validated.governance.reviewAuthority).toBe('client_human');
    expect(validated.brief.fps).toEqual({ num: 24, den: 1 });
    expect(validated.shots.length).toBe(2);
    expect(validated.timeline.totalUsableFrames).toBe(384);
    expect(validated.timeline.totalDurationSec).toBe(16);
  });

  it('rejects missing or conflicting account and project bindings', () => {
    // Missing binding
    const missingBinding = { ...validBaseStory, binding: {} };
    expect(() => validateStoryInput(missingBinding)).toThrow(/\[BINDING_REQUIRED\]/);

    // Conflicting binding (binding object vs top-level)
    const conflictingBinding = {
      ...validBaseStory,
      binding: { accountKey: 'creator@example.com', projectId: 'proj_1' },
      accountKey: 'other@example.com',
    };
    expect(() => validateStoryInput(conflictingBinding)).toThrow(/\[BINDING_CONFLICT\]/);
  });

  it('rejects invalid bounded policy and governance options', () => {
    const invalidLimit = {
      ...validBaseStory,
      policy: { ...validBaseStory.policy, candidateLimit: 50 }, // max 20
    };
    expect(() => validateStoryInput(invalidLimit)).toThrow(/\[INVALID_POLICY\]/);

    const invalidGovernance = {
      ...validBaseStory,
      governance: { ...validBaseStory.governance, reviewAuthority: 'skynet' },
    };
    expect(() => validateStoryInput(invalidGovernance)).toThrow(/\[INVALID_GOVERNANCE\]/);
  });

  it('handles rational FPS parsing and exact frame calculation without BigInt leakage', () => {
    // Exact 24 fps
    expect(parseRationalFps(24)).toEqual({ num: 24, den: 1 });

    // Standard NTSC 23.976
    const ntsc = parseRationalFps(23.976);
    expect(ntsc).toEqual({ num: 24000, den: 1001 });

    // Exact rational reduction
    const reduced = reduceRational(48000, 2002);
    expect(reduced).toEqual({ num: 24000, den: 1001 });
    expect(typeof reduced.num).toBe('number');
    expect(typeof reduced.den).toBe('number');

    // Frames calculation
    const frames = framesForDuration(10, 24);
    expect(frames).toBe(240);
  });

  it('validates trim ranges, transition handles, and rejects impossible timing', () => {
    // Trim outFrame <= inFrame
    const invalidTrim = {
      ...validBaseStory,
      shots: [
        {
          ...validBaseStory.shots[0],
          trim: { inFrame: 50, outFrame: 40 },
        },
      ],
    };
    expect(() => validateStoryInput(invalidTrim)).toThrow(/\[IMPOSSIBLE_TIMING\]/);

    // Usable frames + handles exceeds planned source frames
    const exceedingHandles = {
      ...validBaseStory,
      shots: [
        {
          ...validBaseStory.shots[0],
          plannedSourceFrames: 100,
          trim: { inFrame: 0, outFrame: 90 }, // usable: 90
          transitionHandles: { headFrames: 10, tailFrames: 10 }, // total: 110 > 100
        },
      ],
    };
    expect(() => validateStoryInput(exceedingHandles)).toThrow(/\[IMPOSSIBLE_TIMING\]/);
  });

  it('validates continuity states and rejects conflicting simultaneous prop holders', () => {
    const conflictingHolder = {
      ...validBaseStory,
      shots: [
        {
          ...validBaseStory.shots[0],
          expected_state_before: {
            props: { drive: { holder: ['kai', 'mira'], state: 'inert' } },
          },
        },
      ],
    };
    expect(() => validateStoryInput(conflictingHolder)).toThrow(/\[STATE_CONFLICT\]/);
  });

  it('rejects dangling entity references in shot cards and continuity states', () => {
    const danglingPropInState = {
      ...validBaseStory,
      shots: [
        {
          ...validBaseStory.shots[0],
          expected_state_before: {
            props: { nonexistent_prop: { holder: null, state: 'inert' } },
          },
        },
      ],
    };
    expect(() => validateStoryInput(danglingPropInState)).toThrow(/\[DANGLING_ENTITY_REFERENCE\]/);
  });
});
