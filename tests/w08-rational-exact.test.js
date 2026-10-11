import { describe, it, expect } from 'vitest';
import { reduceRational, parseRationalFps, calculateTimelineDuration } from '../src/script/schema.js';

// Owner: rational-schema lane. Covers family D: products and GCD must stay
// exact in BigInt before the checked JSON-safe boundary.
describe('W08 exact rational regressions (family D)', () => {
  it('reduces 3 frames at 24/MAX_SAFE_INTEGER to MAX_SAFE_INTEGER/8 exactly', () => {
    const fps = parseRationalFps({ num: 24, den: Number.MAX_SAFE_INTEGER });
    const res = calculateTimelineDuration(
      [
        { id: 'a', usableFrames: 2 },
        { id: 'b', usableFrames: 1 },
      ],
      fps
    );
    expect(res.totalUsableFrames).toBe(3);
    expect(res.durationRational).toEqual({ num: Number.MAX_SAFE_INTEGER, den: 8 });
  });

  it('reduces BigInt products without Number rounding', () => {
    const out = reduceRational(3n * BigInt(Number.MAX_SAFE_INTEGER), 24n);
    expect(out).toEqual({ num: Number.MAX_SAFE_INTEGER, den: 8 });
  });

  it('rejects unsafe FPS components', () => {
    expect(() => parseRationalFps({ num: 24, den: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/INVALID_STORY_SCHEMA/);
    expect(() => reduceRational(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(/INVALID_STORY_SCHEMA/);
  });
});
