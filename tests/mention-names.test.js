import { describe, it, expect } from 'vitest';
import { collectMentionNames } from '../src/navigation/mentions.js';
import { schemas, parseOrThrow } from '../src/utils/validate.js';

// P0-6: image use_character/use_scene/references resolve exactly like
// ingredients (same as the video handler already did).
describe('collectMentionNames', () => {
  it('merges all four sources in order', () => {
    expect(collectMentionNames({
      ingredients: ['A'],
      references: ['B'],
      use_character: 'C',
      use_scene: 'D',
    })).toEqual(['A', 'B', 'C', 'D']);
  });

  it('empty input yields an empty list', () => {
    expect(collectMentionNames({})).toEqual([]);
    expect(collectMentionNames()).toEqual([]);
  });

  it('drops blank and non-string entries', () => {
    expect(collectMentionNames({
      ingredients: ['A', '  ', '', null, 42],
      use_character: ' ',
    })).toEqual(['A']);
  });
});

describe('P0-6 image schema advertises the wired name fields', () => {
  it('zod image schema has use_character/use_scene', () => {
    expect('use_character' in schemas.flow_generate_image.shape).toBe(true);
    expect('use_scene' in schemas.flow_generate_image.shape).toBe(true);
  });

  it('image args with names validate', () => {
    const v = parseOrThrow(
      schemas.flow_generate_image,
      { prompt: 'x', use_character: 'Bob', use_scene: 'Hangar' },
      'flow_generate_image'
    );
    expect(v.use_character).toBe('Bob');
    expect(collectMentionNames(v)).toEqual(['Bob', 'Hangar']);
  });
});
