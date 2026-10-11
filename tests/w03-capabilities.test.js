import { describe, it, expect } from 'vitest';

// W03: per-combination tri-state capability + timestamps binding + restore UI;
// semantic durations only from observed supported set; unknown blocks.
// Plan: §9.1 provenance-aware candidates, W03 duration-allowlist-per-model-feature,
// G4 (reject 1-30 arbitrary), §1.4 Quality conflict stays unknown (no hardcoded fix).

import {
  parseDurationSyntax,
  toTriState,
  getDurationVerdict,
  makeCapabilityRecord,
  isCapabilityFresh,
  QUOTE_MAX_AGE_MS,
} from '../src/browser/capabilities.js';

describe('W03 duration syntax vs exact-record semantics (parent #2)', () => {
  it('syntactic parse accepts canonical labels only, rejects arbitrary 1-30', () => {
    expect(parseDurationSyntax('8s')).toBe('8s');
    expect(parseDurationSyntax('10s')).toBe('10s');
    expect(parseDurationSyntax('8')).toBe('8s');
    expect(parseDurationSyntax('5s')).toBe(null);
    expect(parseDurationSyntax('30')).toBe(null);
    expect(parseDurationSyntax('')).toBe(null);
  });

  it('exact record proves support, even unknown model names (no whitelist)', () => {
    const rec = { supportedDurations: ['8s'], observedAt: new Date().toISOString(), evidence: 'panel-row' };
    expect(getDurationVerdict({ model: 'Future Custom Model 9', feature: 'ingredients', duration: '8s', exactRecord: rec }).state).toBe('supported');
  });

  it('global array alone cannot prove support; missing record blocks', () => {
    // No exactRecord → unknown, even with canonical duration + known model.
    expect(getDurationVerdict({ model: 'Veo 3.1 - Fast', feature: 'ingredients', duration: '8s', exactRecord: null }).state).toBe('unknown');
    expect(getDurationVerdict({ model: 'Veo 3.1 - Fast', feature: 'ingredients', duration: '8s' }).state).toBe('unknown');
  });

  it('absence alone is unknown unless explicit disabled evidence', () => {
    const rec = { supportedDurations: ['8s'], observedAt: new Date().toISOString(), evidence: 'panel-row' };
    expect(getDurationVerdict({ model: 'Veo 3.1 - Fast', feature: 'ingredients', duration: '6s', exactRecord: rec }).state).toBe('unknown');
    const recDisabled = { supportedDurations: ['8s'], disabledDurations: ['6s'], observedAt: new Date().toISOString(), evidence: 'disabled-row' };
    expect(getDurationVerdict({ model: 'Veo 3.1 - Fast', feature: 'ingredients', duration: '6s', exactRecord: recDisabled }).state).toBe('unsupported');
    expect(getDurationVerdict({ model: 'Veo 3.1 - Fast', feature: 'ingredients', duration: '5s', exactRecord: rec }).state).toBe('unsupported');
  });
});

describe('W03 tri-state + timestamps binding', () => {
  it('missing row is unknown, disabled with restriction is unsupported', () => {
    expect(toTriState({ present: false }).state).toBe('unknown');
    expect(toTriState({ present: true, enabled: true }).state).toBe('supported');
    expect(toTriState({ present: true, enabled: false, restriction: 'upgrade required' }).state).toBe('unsupported');
  });

  it('capability record binds identity + evidence + observed/expiry', () => {
    const rec = makeCapabilityRecord({
      model: 'Veo 3.1 - Fast',
      feature: 'ingredients',
      ratio: '16:9',
      duration: '8s',
      state: 'supported',
      evidence: 'settings-panel-row',
    });
    expect(rec.key).toMatch(/veo/i);
    expect(rec.observedAt).toBeTruthy();
    expect(new Date(rec.expiresAt).getTime()).toBeGreaterThan(new Date(rec.observedAt).getTime());
    expect(rec.evidence).toBe('settings-panel-row');
  });

  it('freshness uses explicit TTL; quote TTL is 30s per §3.3', () => {
    expect(QUOTE_MAX_AGE_MS).toBe(30 * 1000);
    const fresh = new Date().toISOString();
    expect(isCapabilityFresh(fresh, Date.now(), 30 * 1000)).toBe(true);
    const stale = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isCapabilityFresh(stale, Date.now(), 30 * 1000)).toBe(false);
  });
});
