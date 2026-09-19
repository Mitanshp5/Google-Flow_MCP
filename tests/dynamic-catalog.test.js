import { describe, it, expect } from 'vitest';
import { resolveModel, capsFor, getUniverse, FALLBACK_CATALOG, DEFAULT_CAPS, resolveIngredientsDuration, scrubLiveCaps } from '../src/utils/models.js';
import { getFlowHome } from '../src/utils/config.js';
import { getSelectors, noteSelectors, selectorKeys } from '../src/utils/selectors.js';
import fs from 'fs';
import path from 'path';

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

describe('P1-2 ingredients duration gate (data-driven, conservative)', () => {
  it('defaults merge under known entries (no per-model duration claims)', () => {
    expect(DEFAULT_CAPS.ingredientsRequireDuration).toBe('8s');
    for (const m of ['Veo 3.1 - Fast', 'Veo 3.1 - Lite', 'Veo 3.1 - Quality', 'Omni Flash']) {
      expect(capsFor(m).ingredientsRequireDuration).toBe('8s');
    }
    expect(capsFor('Future Model X').ingredientsRequireDuration).toBe('8s');
  });

  it('no ingredients passes duration through untouched', () => {
    expect(resolveIngredientsDuration(capsFor('Veo 3.1 - Fast'), '4s', false))
      .toEqual({ duration: '4s', forced: false });
  });

  it('forces 8s for every model today (identical to the old hardcoded check)', () => {
    for (const m of ['Veo 3.1 - Fast', 'Veo 3.1 - Lite', 'Veo 3.1 - Quality', 'Omni Flash', 'Future Model X']) {
      expect(resolveIngredientsDuration(capsFor(m), '4s', true))
        .toEqual({ duration: '8s', forced: true });
      expect(resolveIngredientsDuration(capsFor(m), '6s', true).forced).toBe(true);
    }
  });

  it('already-8s is not a force', () => {
    expect(resolveIngredientsDuration(capsFor('Veo 3.1 - Fast'), '8s', true))
      .toEqual({ duration: '8s', forced: false });
  });
});

describe('P1-3 live-cache preference (fixture-scoped, disk restored)', () => {
  const catalogFile = path.join(getFlowHome(), 'config', 'flow.models.json');

  // The real cache file may exist (live runs regenerate it) — never leak
  // fixture content into it.
  function withCatalogFixture(catalog, fn) {
    const had = fs.existsSync(catalogFile) ? fs.readFileSync(catalogFile, 'utf-8') : null;
    try {
      fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
      fs.writeFileSync(catalogFile, JSON.stringify(catalog));
      fn();
    } finally {
      if (had === null) {
        try { fs.rmSync(catalogFile); } catch { /* already gone */ }
      } else {
        fs.writeFileSync(catalogFile, had);
      }
    }
  }

  it('scrubLiveCaps keeps only observed booleans for known keys', () => {
    expect(scrubLiveCaps({ ingredients: true, frames: false, extend: true }))
      .toEqual({ ingredients: true, frames: false, extend: true });
    expect(scrubLiveCaps({ ingredients: true })).toEqual({ ingredients: true });
    expect(scrubLiveCaps({ ingredients: 'yes' })).toBe(null);
    expect(scrubLiveCaps({})).toBe(null);
    expect(scrubLiveCaps(null)).toBe(null);
    expect(scrubLiveCaps(['ingredients'])).toBe(null);
    // Duration requirements are never writable via discovery (rule 4).
    expect(scrubLiveCaps({ ingredients: true, ingredientsRequireDuration: '8s' }))
      .toEqual({ ingredients: true });
  });

  it('fresh live entry beats the static table', () => {
    withCatalogFixture({
      videoModels: ['Veo 3.1 - Quality'],
      capabilities: { 'veo 3.1 - quality': { ingredients: true, frames: true, extend: true } },
      capabilitiesObservedAt: new Date().toISOString(),
    }, () => {
      const c = capsFor('Veo 3.1 - Quality');
      expect(c.ingredients).toBe(true); // static table says false
      expect(c.source).toBe('live-cache');
      expect(c.known).toBe(true);
      // Duration still conservative: discovery cannot write it.
      expect(c.ingredientsRequireDuration).toBe('8s');
    });
  });

  it('stale live entries fall back to static', () => {
    withCatalogFixture({
      videoModels: ['Veo 3.1 - Quality'],
      capabilities: { 'veo 3.1 - quality': { ingredients: true } },
      capabilitiesObservedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    }, () => {
      const c = capsFor('Veo 3.1 - Quality');
      expect(c.ingredients).toBe(false);
      expect(c.source).toBe('static');
    });
  });

  it('malformed live entries fall back to static, unknown to default', () => {
    withCatalogFixture({
      videoModels: ['Veo 3.1 - Quality'],
      capabilities: { 'veo 3.1 - quality': { ingredients: 'maybe' } },
      capabilitiesObservedAt: new Date().toISOString(),
    }, () => {
      expect(capsFor('Veo 3.1 - Quality').source).toBe('static');
      expect(capsFor('Future Model X').source).toBe('default');
    });
  });
});
