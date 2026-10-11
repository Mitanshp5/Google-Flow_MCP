// W04 behavioral: real composer snapshots from Playwright fixture DOM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import {
  readComposerSnapshot,
  restoreComposerAfterPicker,
  isValidRestoreClaim,
  compareComposerSnapshots,
} from '../src/browser/composer-state.js';

const COMPOSER_FIXTURE = `
<div id="composer" data-account="qa@example.com" data-project="p1">
  <div id="prompt" contenteditable="true">A cat in space.</div>
  <div id="chips">
    <span class="mention-chip" data-chip-id="c1" data-asset-id="a1" data-title="qa-reference.png">qa-reference.png</span>
  </div>
  <div id="slots">
    <div data-slot="start" data-asset-id="s1" data-title="hero.png"></div>
    <div data-slot="end" data-asset-id="s2" data-title="end.png"></div>
  </div>
  <div id="pending"><div data-pending-upload="1" data-name="up.png" data-status="ready"></div></div>
  <div id="settings" data-mode="image" data-model="Nano Banana Pro" data-ratio="1:1" data-quantity="x1"></div>
</div>`;

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('W04 behavioral readComposerSnapshot', () => {
  it('reads text, chip IDs, slots, uploads, settings, binding from real DOM', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(COMPOSER_FIXTURE);
      const snap = await readComposerSnapshot(page, page.locator('#prompt'));
      expect(snap.text).toBe('A cat in space.');
      expect(snap.chips).toHaveLength(1);
      expect(snap.chips[0]).toMatchObject({ assetId: 'a1', title: 'qa-reference.png' });
      expect(snap.slots.start).toMatchObject({ assetId: 's1' });
      expect(snap.pendingUploads).toEqual([{ name: 'up.png', status: 'ready' }]);
      expect(snap.settings).toMatchObject({ mode: 'image' });
      expect(snap.account).toBe('qa@example.com');
      expect(snap.projectId).toBe('p1');
      expect(snap.chipsObservable).toBe(true);
    } finally {
      await page.close();
    }
  }, 20000);

  it('marks chip/slot observability unknown when markup absent', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="composer"><div id="prompt" contenteditable="true">hi</div></div>`);
      const snap = await readComposerSnapshot(page, page.locator('#prompt'));
      expect(snap.chipsObservable).toBe(false);
      expect(snap.slotsObservable).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);
});

describe('W04 behavioral restore claim strictness', () => {
  it('same chips/slots but different text/uploads/binding is NOT a valid restore', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(COMPOSER_FIXTURE);
      const before = await readComposerSnapshot(page, page.locator('#prompt'));
      await page.evaluate(() => {
        document.getElementById('prompt').textContent = 'CHANGED TEXT';
      });
      const after = await readComposerSnapshot(page, page.locator('#prompt'));
      expect(after.chips).toEqual(before.chips);
      expect(isValidRestoreClaim({ before, after, claimedBy: 'chip-slot-verify' })).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);

  it('unknown chip observation denies positive preservation', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div><div id="prompt" contenteditable="true">hi</div></div>`);
      const before = await readComposerSnapshot(page, page.locator('#prompt'));
      const after = await readComposerSnapshot(page, page.locator('#prompt'));
      expect(isValidRestoreClaim({ before, after, claimedBy: 'chip-slot-verify' })).toBe(false);
      expect(compareComposerSnapshots(before, after).bindingObservable).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);
});

describe('W04 behavioral restore exact @ delta with focus', () => {
  it('removes the exact trigger delta and refocuses the composer', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(COMPOSER_FIXTURE);
      const input = page.locator('#prompt');
      const before = await readComposerSnapshot(page, input);
      // Simulate picker open delta: space + @ typed by openMentionPopup.
      await input.click();
      await page.keyboard.press('End');
      await page.keyboard.type(' @', { delay: 10 });
      const res = await restoreComposerAfterPicker(page, input, before, { triggerDelta: ' @' });
      expect(res.restored).toBe(true);
      expect(await input.evaluate((el) => document.activeElement === el)).toBe(true);
      const after = await readComposerSnapshot(page, input);
      expect(after.text).toBe(before.text);
    } finally {
      await page.close();
    }
  }, 20000);
});
