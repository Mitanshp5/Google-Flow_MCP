import { describe, it, expect } from 'vitest';
import {
  parseComposerHtml,
  snapshotComposerFromHtml,
  compareComposerSnapshots,
  decideRestoreOrInvalidate,
  needsTriggerSpace,
  hasStrayAt,
  isValidRestoreClaim,
} from '../src/browser/composer-state.js';

// W04 slice 2 — rich composer snapshot (text/chips/slots/pending/settings),
// restore-or-invalidate, no raw-innerHTML-pretend, no-stray-@ rollback.
// Semantic HTML fixtures, headless, no CDP/browser.
const RICH_HTML = `
<div class="composer" data-account="qa@example.com" data-project="p-qa">
  <div class="prompt-text">A cat in space.</div>
  <span class="mention-chip" data-chip-id="c1" data-asset-id="a1" data-title="qa-reference.png">qa-reference.png</span>
  <span class="mention-chip" data-chip-id="c2" data-asset-id="a2" data-title="Cow in space">Cow in space</span>
  <div class="slot" data-slot="start" data-asset-id="s1" data-title="hero.png"></div>
  <div class="slot" data-slot="end" data-asset-id="s2" data-title="end.png"></div>
  <div class="slot" data-slot="ingredients" data-asset-id="a1" data-title="qa-reference.png"></div>
  <div class="pending-upload" data-name="up.png" data-status="ready"></div>
  <div class="composer-settings" data-mode="image" data-model="Nano Banana Pro" data-ratio="1:1" data-quantity="x1"></div>
</div>`;

describe('W04 composer-state parse/snapshot', () => {
  it('snapshots text, chip IDs, slots, pending uploads, settings, identity', () => {
    const s = snapshotComposerFromHtml(RICH_HTML);
    expect(s.text).toBe('A cat in space.');
    expect(s.chips).toHaveLength(2);
    expect(s.chips[0]).toMatchObject({ id: 'c1', assetId: 'a1', title: 'qa-reference.png' });
    expect(s.slots.start).toMatchObject({ assetId: 's1', title: 'hero.png' });
    expect(s.slots.end.assetId).toBe('s2');
    expect(s.pendingUploads).toEqual([{ name: 'up.png', status: 'ready' }]);
    expect(s.settings).toMatchObject({ mode: 'image', ratio: '1:1' });
    expect(s.account).toBe('qa@example.com');
    expect(s.projectId).toBe('p-qa');
  });
  it('parseComposerHtml exposes the same structure', () => {
    expect(parseComposerHtml(RICH_HTML).chips).toHaveLength(2);
  });
});

describe('W04 composer-state compare + restore-or-invalidate', () => {
  it('equal snapshots compare equal', () => {
    const a = snapshotComposerFromHtml(RICH_HTML);
    const b = snapshotComposerFromHtml(RICH_HTML);
    expect(compareComposerSnapshots(a, b).equal).toBe(true);
  });
  it('chip loss is detected even when prompt text matches', () => {
    const a = snapshotComposerFromHtml(RICH_HTML);
    const stripped = RICH_HTML.replace(/<span class="mention-chip".*?<\/span>/gs, '');
    const b = snapshotComposerFromHtml(stripped);
    const c = compareComposerSnapshots(a, b);
    expect(c.textEqual).toBe(true);
    expect(c.chipsEqual).toBe(false);
    expect(c.equal).toBe(false);
  });
  it('slot swap is detected', () => {
    const a = snapshotComposerFromHtml(RICH_HTML);
    const swapped = RICH_HTML.replace('data-slot="start"', 'data-slot="__t__"')
      .replace('data-slot="end"', 'data-slot="start"')
      .replace('data-slot="__t__"', 'data-slot="end"');
    expect(compareComposerSnapshots(a, snapshotComposerFromHtml(swapped)).slotsEqual).toBe(false);
  });
  it('failed restore invalidates prep instead of claiming success', () => {
    const before = snapshotComposerFromHtml(RICH_HTML);
    const after = snapshotComposerFromHtml(RICH_HTML.replace('data-asset-id="a1"', 'data-asset-id="WRONG"'));
    const d = decideRestoreOrInvalidate({ before, afterAttempt: after, restoreOk: false });
    expect(d.restored).toBe(false);
    expect(d.mustInvalidatePrep).toBe(true);
  });
  it('raw innerHTML/text-only equality is NOT a valid restore claim', () => {
    const before = snapshotComposerFromHtml(RICH_HTML);
    const after = snapshotComposerFromHtml(RICH_HTML.replace('data-asset-id="a1"', 'data-asset-id="WRONG"'));
    // Text matches, chips differ: claiming restore from text alone is invalid.
    expect(after.text).toBe(before.text);
    expect(isValidRestoreClaim({ before, after, claimedBy: 'innerHTML' })).toBe(false);
    expect(isValidRestoreClaim({ before, after: before, claimedBy: 'chip-slot-verify' })).toBe(true);
  });
});

describe('W04 composer-state mention trigger + stray @', () => {
  it('punctuation-ending prompt needs a separating space before @', () => {
    expect(needsTriggerSpace('A cat in space.')).toBe(true);
    expect(needsTriggerSpace('Hello!')).toBe(true);
    expect(needsTriggerSpace('Hello ')).toBe(false);
    expect(needsTriggerSpace('')).toBe(false);
  });
  it('trailing @ with unchanged chips is stray', () => {
    expect(hasStrayAt('hello@', [])).toBe(true);
    expect(hasStrayAt('hello', [])).toBe(false);
    expect(hasStrayAt('hello @', [])).toBe(true);
  });
});
