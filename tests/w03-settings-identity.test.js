import { describe, it, expect } from 'vitest';

// W03 vertical slice: settings-panel identity + ok/verified readiness + closure fix.
// QA evidence: F04 (changelog dialog "View all changelogs"/"Get started" scanned as
// settings), R02 (selectedStateOf closure unavailable in page.evaluate), plan §9 F04
// row (settings-panel-identity, actual-not-echoed, evaluate-no-free-closure).
// Uses real semantic strings from qa-output/2026-10-10/evidence/*.json.

import {
  isGenerationSettingsPanelText,
} from '../src/browser/capabilities.js';

const CHANGELOG_FIXTURE = 'View all changelogs Get started Nano Banana 2 suggestions';
const COMPOSER_SETTINGS_FIXTURE = [
  '🍌 Nano Banana Pro arrow_drop_down',
  'x1 x2 x3 x4',
  'Generating will use 0 credits',
  'crop_16_9 16:9 crop_square 1:1',
  'Image Video',
].join('\n');

describe('W03 settings-panel identity (F04)', () => {
  it('rejects changelog dialog as settings panel', () => {
    expect(isGenerationSettingsPanelText(CHANGELOG_FIXTURE).isSettings).toBe(false);
    expect(isGenerationSettingsPanelText(CHANGELOG_FIXTURE).reason).toMatch(/changelog/i);
  });

  it('accepts verified composer settings panel with model row + credit note', () => {
    const r = isGenerationSettingsPanelText(COMPOSER_SETTINGS_FIXTURE);
    expect(r.isSettings).toBe(true);
  });

  it('rejects empty shell with no model row (CDP early-render)', () => {
    const r = isGenerationSettingsPanelText('<empty shell>');
    expect(r.isSettings).toBe(false);
  });
});

describe('W03 never ready from ok:true verified:false (F04/R02, parent #5)', () => {
  it('unverified click is not ready; explicit nonempty required set only', async () => {
    const { isSettingsReady } = await import('../src/browser/capabilities.js');
    expect(isSettingsReady([{ ok: true, verified: false, kind: 'ratio', detail: 'x' }], ['ratio'])).toBe(false);
    expect(isSettingsReady([{ ok: true, verified: true, kind: 'ratio', detail: 'x' }], ['ratio'])).toBe(true);
    expect(isSettingsReady([{ ok: false, verified: false, kind: 'ratio', detail: 'x' }], ['ratio'])).toBe(false);
    // Parent #5: empty verification cannot prove requested settings.
    expect(isSettingsReady([], ['ratio'])).toBe(false);
    expect(isSettingsReady([{ ok: true, verified: true, kind: 'ratio', detail: 'x' }], [])).toBe(false);
    expect(isSettingsReady([{ ok: true, verified: true, kind: 'ratio', detail: 'x' }])).toBe(false);
    // Missing required field blocks even when others verify.
    expect(isSettingsReady(
      [{ ok: true, verified: true, kind: 'ratio', detail: 'x' }],
      ['ratio', 'model'],
    )).toBe(false);
  });

  it('DOM structure rejects suggestion dropdown with model names (parent #5)', async () => {
    const { assessSettingsPanelStructure } = await import('../src/browser/capabilities.js');
    // Suggestion/model dropdown: model names but no owned settings controls.
    expect(assessSettingsPanelStructure({
      hasModelRow: false, hasQuantityOrRatio: false, hasCreditNote: false,
      hasModeTabs: false, hasChangelogMarker: false, controlCount: 2,
    }).isSettings).toBe(false);
    // Verified composer settings.
    expect(assessSettingsPanelStructure({
      hasModelRow: true, hasQuantityOrRatio: true, hasCreditNote: true,
      hasModeTabs: true, hasChangelogMarker: false, controlCount: 8,
    }).isSettings).toBe(true);
  });
});
