import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';

// W03 behavioral corrections (parent #1/#5/#6): real headless browser HTML
// fixtures through actual handlers — no source regex, no canned evaluate.
let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
});

const SETTINGS_HTML = `
<textarea placeholder="create something"></textarea>
<div id="bar">
  <button aria-label="Settings trigger">Settings</button>
  <button>Nano Banana Pro</button>
</div>
<div role="dialog" id="composer-settings">
  <button class="mat-mdc-menu-trigger">Nano Banana Pro arrow_drop_down</button>
  <div><button>x1</button><button>x2</button><button>x3</button><button>x4</button></div>
  <div>Generating will use 0 credits</div>
  <div><button role="tab">Image</button><button role="tab">Video</button></div>
  <div><button>16:9</button><button>1:1</button></div>
  <div><button>360p</button><button>720p</button></div>
  <div><button>4s</button><button>8s</button></div>
</div>`;

const SUGGESTION_HTML = `
<textarea placeholder="create something"></textarea>
<div role="menu" id="suggestion">
  <div>Nano Banana Pro</div>
  <div>Image</div>
</div>`;

const CHANGELOG_HTML = `
<textarea placeholder="create something"></textarea>
<div role="dialog" id="changelog">
  <h2>View all changelogs</h2>
  <button>Get started</button>
  <div>Nano Banana 2 Lite suggestion card</div>
  <div>Image</div>
</div>`;

async function newPageWith(html, url = 'https://flow.google.com/project/behavioral-123') {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Avoid network: set content directly, then spoof project URL for read-only guard.
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const realUrl = page.url.bind(page);
  page.url = () => url;
  page.__realUrl = realUrl;
  page.__context = context;
  return page;
}

describe('behavioral #5 wrong-panel rejection via DOM ownership', () => {
  it('rejects suggestion dropdown (model names, no settings controls)', async () => {
    const page = await newPageWith(SUGGESTION_HTML);
    try {
      const { findSettingsPanel } = await import('../src/browser/safe-actions.js');
      const panel = await findSettingsPanel(page);
      expect(panel).toBe(null);
    } finally {
      await page.__context.close();
    }
  }, 30000);

  it('rejects changelog dialog even with model-like suggestion text', async () => {
    const page = await newPageWith(CHANGELOG_HTML);
    try {
      const { findSettingsPanel } = await import('../src/browser/safe-actions.js');
      const panel = await findSettingsPanel(page);
      expect(panel).toBe(null);
    } finally {
      await page.__context.close();
    }
  }, 30000);

  it('accepts verified composer settings with owned controls', async () => {
    const page = await newPageWith(SETTINGS_HTML);
    try {
      const { findSettingsPanel, isVerifiedSettingsPanel } = await import('../src/browser/safe-actions.js');
      const panel = await findSettingsPanel(page);
      expect(panel).not.toBe(null);
      const verdict = await isVerifiedSettingsPanel(panel);
      expect(verdict.isSettings).toBe(true);
    } finally {
      await page.__context.close();
    }
  }, 30000);
});

describe('behavioral #6 closure bug: settings click readback in real browser', () => {
  it('old buggy evaluate with free closure throws ReferenceError (pre-repair RED)', async () => {
    const page = await newPageWith(SETTINGS_HTML);
    try {
      const err = await page.evaluate(() => {
        try {
          // Simulate pre-repair probe.evaluate((b)=>{ if(selectedStateOf(b)) ... })
          const fn = new Function('b', 'return selectedStateOf(b)');
          fn(document.body);
          return null;
        } catch (e) {
          return `${e.name}: ${e.message}`;
        }
      });
      expect(err).toMatch(/ReferenceError/);
    } finally {
      await page.__context.close();
    }
  }, 30000);

  it('fixed setPromptBarRatio clicks and verifies in real DOM (GREEN)', async () => {
    const RATIO_HTML = `
<textarea placeholder="create something"></textarea>
<div id="bar"><button aria-label="Settings trigger">Settings</button></div>
<div role="dialog" id="composer-settings">
  <button class="mat-mdc-menu-trigger">Nano Banana Pro arrow_drop_down</button>
  <div>Generating will use 0 credits</div>
  <div><button role="tab">Image</button><button role="tab">Video</button></div>
  <div>
    <button role="tab" aria-checked="false">16:9</button>
    <button role="tab" aria-checked="true">1:1</button>
  </div>
  <div><button>x1</button></div>
</div>
<script>
document.querySelectorAll('#composer-settings button[role="tab"]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#composer-settings button[role="tab"]').forEach((x) => x.setAttribute('aria-checked', 'false'));
    b.setAttribute('aria-checked', 'true');
  });
});
</script>`;
    const page = await newPageWith(RATIO_HTML);
    try {
      const { setPromptBarRatio } = await import('../src/browser/safe-actions.js');
      const res = await setPromptBarRatio(page, '16:9');
      expect(res.ok).toBe(true);
      expect(res.verified).toBe(true);
    } finally {
      await page.__context.close();
    }
  }, 30000);
});
