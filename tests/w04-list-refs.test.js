// W04 behavioral: list-mentions pre-navigation snapshot + invalidation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import {
  handleListMentionOptions,
  hasPreparedState,
} from '../src/tools/list-mentions.js';

const LIST_FIXTURE = `
<div id="composer" data-account="qa@example.com" data-project="p1">
  <div id="prompt" contenteditable="true">prepared prompt</div>
  <div id="chips">
    <span class="mention-chip" data-chip-id="c1" data-asset-id="a1" data-title="qa-reference.png">qa-reference.png</span>
  </div>
  <div id="slots"><div data-slot="start" data-asset-id="s1" data-title="hero.png"></div></div>
  <div id="picker" role="dialog" style="display:none">
    <input placeholder="Search assets" id="search" />
    <div role="option" data-title="qa-reference.png">qa-reference.png<span>Image</span></div>
  </div>
</div>
<script>
const prompt = document.getElementById('prompt');
const picker = document.getElementById('picker');
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

describe('W04 behavioral list pre-navigation snapshot', () => {
  it('navigation wipe of prepared state returns invalidated blocker, not success', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(LIST_FIXTURE);
      const wipeNav = async () => {
        await page.evaluate(() => {
          document.getElementById('prompt').textContent = '';
          document.getElementById('chips').innerHTML = '';
          document.getElementById('slots').innerHTML = '';
        });
      };
      const res = await handleListMentionOptions({ project_name: 'Other Project' }, {
        page,
        ensureProjectFn: wipeNav,
        takeScreenshotFn: async () => null,
      });
      expect(hasPreparedState({ text: 'prepared prompt', chips: [{ id: 'c1' }] })).toBe(true);
      expect(res.status).toBe('blocked');
      expect(res.composer.state).toBe('invalidated');
    } finally {
      await page.close();
    }
  }, 25000);

  it('non-destructive listing preserves rich state and focuses composer with no stray @', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(LIST_FIXTURE);
      const res = await handleListMentionOptions({}, {
        page,
        ensureProjectFn: async () => {},
        takeScreenshotFn: async () => null,
      });
      expect(res.status).toBe('success');
      expect(res.composer.state).toBe('preserved');
      const text = await page.locator('#prompt').textContent();
      expect(text.includes('@')).toBe(false);
      expect(await page.locator('#prompt').evaluate((el) => document.activeElement === el)).toBe(true);
    } finally {
      await page.close();
    }
  }, 25000);

  it('plain-text preparation wiped by listing is restored verbatim, not blocked', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(LIST_FIXTURE.replace(/<div id="chips">[\s\S]*?<\/div>/, '<div id="chips"></div>')
        .replace(/<div id="slots">[\s\S]*?<\/div><\/div>/, '<div id="slots"></div></div>'));
      const wipeText = async () => {
        await page.evaluate(() => { document.getElementById('prompt').textContent = ''; });
      };
      const res = await handleListMentionOptions({}, {
        page,
        ensureProjectFn: wipeText,
        takeScreenshotFn: async () => null,
      });
      expect(res.status).toBe('success');
      expect(res.composer.state).toBe('restored');
      expect(res.references).toContain('qa-reference.png');
      expect(await page.locator('#prompt').textContent()).toBe('prepared prompt');
    } finally {
      await page.close();
    }
  }, 25000);
});
