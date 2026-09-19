import { describe, it, expect } from 'vitest';
import { resolveModel, capsFor, getUniverse, FALLBACK_CATALOG } from '../src/utils/models.js';
import { getSelectors, noteSelectors, selectorKeys } from '../src/utils/selectors.js';
import fs from 'fs';

describe('dynamic model universe (nothing frozen)', () => {
  it('resolves aliases + exact names, case-insensitive', () => {
    expect(resolveModel('auto', 'video').name).toBeTruthy();
    expect(resolveModel('QUALITY', 'video').name).toBe('Veo 3.1 - Quality');
    expect(resolveModel('omni 1.1 flash', 'video').name).toBe('Omni 1.1 Flash');
    expect(resolveModel('Nope 9.9', 'video')).toBe(null);
  });
  it('token-matches user spellings, refuses ambiguous ones', () => {
    // No frozen alias table: token subsets of the live universe resolve.
    expect(resolveModel('omni flash 1.1', 'video').name).toBe('Omni 1.1 Flash');
    expect(resolveModel('VeO-3.1-faST', 'video').name).toBe('Veo 3.1 - Fast');
    expect(resolveModel('pro', 'image').name).toBe('Nano Banana Pro');
    // "nano" fits Nano Banana 2 AND Nano Banana Pro — ask, don't guess.
    expect(resolveModel('nano', 'image')).toBe(null);
    expect(resolveModel('veo', 'video')).toBe(null);
  });
  it('unknown models get conservative caps (fail closed on ingredients)', () => {
    const c = capsFor('Future Model X');
    expect(c.ingredients).toBe(false);
    expect(c.known).toBe(false);
    expect(capsFor('Veo 3.1 - Fast').ingredients).toBe(true);
  });
  it('universe merges config + fallback without duplicates', () => {
    const u = getUniverse();
    expect(u.videoModels.length).toBeGreaterThan(0);
    expect(new Set(u.videoModels.map(m => m.toLowerCase())).size).toBe(u.videoModels.length);
    expect(u.source).toMatch(/config/);
  });
  it('fallback catalog covers both modalities', () => {
    expect(FALLBACK_CATALOG.videoModels.length).toBeGreaterThan(0);
    expect(FALLBACK_CATALOG.imageModels.length).toBeGreaterThan(0);
  });
});

describe('selector registry (self-healing, not frozen)', () => {
  it('exposes all keys with ordered candidates', () => {
    expect(selectorKeys()).toContain('promptInput');
    expect(selectorKeys()).toContain('modeTab');
    for (const k of selectorKeys()) {
      expect(getSelectors(k).length).toBeGreaterThan(0);
    }
  });
  it('supports {PLACEHOLDER} templating', () => {
    expect(getSelectors('modeTab', { MODE: 'VIDEO' })[0]).toContain('VIDEO');
    expect(getSelectors('modeTab', { MODE: 'IMAGE' })[0]).toContain('IMAGE');
  });
  it('tool logic has no frozen model/selector literals', () => {
    const logic = fs.readFileSync('src/tools/generate-video.js', 'utf-8')
      + fs.readFileSync('src/tools/generate-image.js', 'utf-8');
    expect(logic).not.toMatch(/const VIDEO_MODELS/);
    expect(logic).not.toMatch(/const MODEL_CAPS/);
    expect(logic).not.toMatch(/button:has-text\("Nano Banana"\)/);
  });
  it('noteSelectors is callable (map write path)', () => {
    expect(() => noteSelectors('_test_key', ['.a', '.b'])).not.toThrow();
    const map = JSON.parse(fs.readFileSync('config/selectors.map.json', 'utf-8'));
    expect(map._test_key).toContain('.a');
    delete map._test_key;
    fs.writeFileSync('config/selectors.map.json', JSON.stringify(map, null, 2));
  });
});
