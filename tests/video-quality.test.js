import { describe, it, expect } from 'vitest';
import { buildVideoPrompt, checkPromptContradictions, normalizeDuration } from '../src/utils/prompt.js';
import { schemas, parseOrThrow } from '../src/utils/validate.js';
import fs from 'fs';

describe('video prompt scaffold (Higgsfield separation rule)', () => {
  it('keeps scene+action, optics in camera/style lines', () => {
    const p = buildVideoPrompt({ prompt: 'A detective looks up in an office', camera: 'slow push-in', style: 'noir, warm lamp' });
    expect(p).toContain('A detective');
    expect(p).toContain('Camera move: slow push-in.');
    expect(p).toContain('Style: noir');
  });
  it('rejects empty/oversize', () => {
    expect(() => buildVideoPrompt({ prompt: '  ' })).toThrow();
    expect(() => buildVideoPrompt({ prompt: 'x'.repeat(8001) })).toThrow();
  });
  it('flags optics-in-prompt, missing transition, unnamed ingredients', () => {
    const w1 = checkPromptContradictions({ prompt: 'f/1.4 anamorphic shot', ingredients: [] });
    expect(w1.join(' ')).toMatch(/optics/i);
    const w2 = checkPromptContradictions({ prompt: 'a scene', ingredients: [], startFrame: '/a.png' });
    expect(w2.join(' ')).toMatch(/transition/i);
    const w3 = checkPromptContradictions({ prompt: 'a walk', ingredients: ['Bob the Astronaut'] });
    expect(w3.join(' ')).toMatch(/name/i);
  });
  it('duration normalize is exact (no silent downgrade input)', () => {
    expect(normalizeDuration('8s')).toBe('8s');
    expect(normalizeDuration(8)).toBe('8s');
    expect(normalizeDuration('5s')).toBe(null);
  });
});

describe('video schema (Fast-then-Quality)', () => {
  it('accepts enums, frames, shots, camera/style', () => {
    const v = parseOrThrow(schemas.flow_generate_video, {
      prompt: 'x', model: 'Veo 3.1 - Quality', ratio: '16:9', duration: '8s',
      camera: 'push-in', style: 'noir', quantity: 2,
    }, 't');
    expect(v.model).toBe('Veo 3.1 - Quality');
  });
  it('rejects bad ratio/duration enums, accepts any model string (resolved live)', () => {
    expect(() => parseOrThrow(schemas.flow_generate_video, { prompt: 'x', ratio: '1:1' }, 't')).toThrow();
    expect(() => parseOrThrow(schemas.flow_generate_video, { prompt: 'x', duration: '5s' }, 't')).toThrow();
    // Model names are dynamic — schema accepts, resolveModel() decides.
    expect(parseOrThrow(schemas.flow_generate_video, { prompt: 'x', model: 'Kling 9.9' }, 't').model).toBe('Kling 9.9');
  });
  it('caps ingredients at 3 (Flow limit)', () => {
    expect(() => parseOrThrow(schemas.flow_generate_video, { prompt: 'x', ingredients: ['a', 'b', 'c', 'd'] }, 't')).toThrow();
  });
  it('caps shots at 6 (storyboard cap)', () => {
    const shots = Array.from({ length: 7 }, (_, i) => ({ prompt: `shot ${i}` }));
    expect(() => parseOrThrow(schemas.flow_generate_video, { prompt: 'x', shots }, 't')).toThrow();
  });
});

describe('tool surface token budget (model-optimum)', () => {
  it('video tool def stays concise with enums', () => {
    const src = fs.readFileSync('src/index.js', 'utf-8');
    const m = src.match(/name: 'flow_generate_video'[\s\S]*?required: \['prompt'\]/);
    expect(m).toBeTruthy();
    expect(m[0].length).toBeLessThan(3000);
    expect(m[0]).toContain('enum');
  });
});
