// W04 behavioral: real mention insertion through a scoped picker fixture.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import {
  insertMentionReference,
  insertMentionReferences,
} from '../src/navigation/mentions.js';
import { readComposerSnapshot } from '../src/browser/composer-state.js';

const PICKER_FIXTURE = `
<div id="composer" data-account="qa@example.com" data-project="p1">
  <div id="prompt" contenteditable="true">A cat in space.</div>
  <div id="chips">
    <span class="mention-chip" data-chip-id="c0" data-asset-id="a0" data-title="Existing Star">Existing Star</span>
  </div>
  <div id="slots"><div data-slot="start" data-asset-id="s1" data-title="hero.png"></div></div>
  <div id="picker" role="dialog" style="display:none">
    <input placeholder="Search assets" id="search" />
    <div id="rows">
      <div role="option" data-asset-id="a1" data-title="qa-reference.png">qa-reference.png<span>Image</span></div>
      <div role="option" data-asset-id="a2" data-title="qa-reference.png extended">qa-reference.png extended<span>Image</span></div>
      <div role="option" data-asset-id="a3" data-title="Cow in space">Cow in space<span>Image</span></div>
    </div>
    <button id="addbtn">Add to Prompt</button>
  </div>
  <div id="decoy" role="option" data-asset-id="decoy" data-title="qa-reference.png">qa-reference.png</div>
</div>
<script>
const prompt = document.getElementById('prompt');
const picker = document.getElementById('picker');
// Picker opens when @ is typed (test types it via the module); expose helper too.
window.__insertChip = (assetId, title) => {
  const c = document.createElement('span');
  c.className = 'mention-chip';
  c.dataset.chipId = 'c-' + assetId;
  c.dataset.assetId = assetId;
  c.dataset.title = title;
  c.textContent = title;
  document.getElementById('chips').appendChild(c);
  picker.style.display = 'none';
  const add = document.getElementById('addbtn');
  if (add) add.style.display = 'none';
};
document.getElementById('search').addEventListener('input', (e) => {
  picker.style.display = 'block';
  const q = e.target.value.trim().toLowerCase();
  for (const r of document.querySelectorAll('#rows [role=option]')) {
    r.style.display = (q === '' || r.dataset.title.toLowerCase() === q) ? 'block' : 'none';
  }
});
for (const r of document.querySelectorAll('#rows [role=option]')) {
  r.addEventListener('click', () => {
    // Direct-insert behaviour: chip inserted and picker closes.
    window.__insertChip(r.dataset.assetId, r.dataset.title);
  });
}
document.getElementById('decoy').addEventListener('click', () => {
  document.getElementById('decoy').dataset.clicked = '1';
});
// Any @ typed in the prompt reveals the picker (fixture stand-in for Flow).
new MutationObserver(() => {
  if ((prompt.textContent || '').includes('@')) picker.style.display = 'block';
}).observe(prompt, { childList: true, characterData: true, subtree: true });
</script>`;

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('W04 behavioral mention exact insertion', () => {
  it('inserts the exact title with stable identity, never prefix/decoy', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PICKER_FIXTURE);
      const input = page.locator('#prompt');
      const ok = await insertMentionReference(page, input, 'qa-reference.png');
      expect(ok).toBe(true);
      const snap = await readComposerSnapshot(page, input);
      const hit = snap.chips.find((c) => c.title === 'qa-reference.png');
      expect(hit?.assetId).toBe('a1');
      // Page-wide decoy with identical text must not be used.
      expect(await page.locator('#decoy').getAttribute('data-clicked')).toBe(null);
      // No stray @ left behind.
      expect(snap.text.includes('@')).toBe(false);
    } finally {
      await page.close();
    }
  }, 25000);

  it('failed insert restores punctuation prompt + existing chips with no stray @', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PICKER_FIXTURE);
      const input = page.locator('#prompt');
      const before = await readComposerSnapshot(page, input);
      expect(before.text).toBe('A cat in space.');
      const res = await insertMentionReferences(page, input, ['Missing Asset XYZ']);
      expect(res.inserted).toHaveLength(0);
      expect(res.failed).toEqual(['Missing Asset XYZ']);
      const after = await readComposerSnapshot(page, input);
      expect(after.text).toBe('A cat in space.');
      expect(after.chips).toEqual(before.chips);
      expect(after.text.includes('@')).toBe(false);
      expect(await input.evaluate((el) => document.activeElement === el)).toBe(true);
    } finally {
      await page.close();
    }
  }, 25000);
});
