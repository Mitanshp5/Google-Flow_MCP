import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
});

const DISCOVERY_HTML = `
<textarea placeholder="create something"></textarea>
<div id="bar">
  <button aria-label="Settings trigger">Settings</button>
  <button>Nano Banana Pro</button>
</div>
<div role="dialog" id="changelog">
  <h2>View all changelogs</h2>
  <button>Get started</button>
  <div>Nano Banana 2 suggestion</div>
</div>
<div role="dialog" id="composer-settings">
  <button class="mat-mdc-menu-trigger">Nano Banana Pro arrow_drop_down</button>
  <div><button>x1</button><button>x2</button></div>
  <div>Generating will use 0 credits</div>
  <div>
    <button role="tab" aria-checked="true">Image</button>
    <button role="tab" aria-checked="false">Video</button>
  </div>
  <div><button>16:9</button><button>1:1</button></div>
  <div><button>4s</button><button>8s</button></div>
</div>
<div class="cdk-overlay-pane" id="model-overlay" style="width:200px;height:200px;">
  <flow-menu-item>Nano Banana Pro</flow-menu-item>
  <flow-menu-item>Nano Banana 2 Lite</flow-menu-item>
  <flow-menu-item>Nano Banana 2.1</flow-menu-item>
  <flow-menu-item aria-disabled="true">Imagen 4</flow-menu-item>
  <flow-menu-item>Veo 3.1 - Fast</flow-menu-item>
</div>
<script>
(function () {
  const overlay = document.getElementById('model-overlay');
  overlay.style.display = 'none';
  const row = document.querySelector('#composer-settings button.mat-mdc-menu-trigger');
  if (row) row.addEventListener('click', () => {
    overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none';
  });
  document.querySelectorAll('#composer-settings button[role="tab"]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#composer-settings button[role="tab"]').forEach((x) => x.setAttribute('aria-checked', 'false'));
      b.setAttribute('aria-checked', 'true');
    });
  });
})();
</script>`;

async function newProjectPage(html) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  page.url = () => 'https://flow.google.com/project/behavioral-discovery-1';
  page.__context = context;
  return page;
}

describe('behavioral #1 nested dropdown enumeration via opened.panel', () => {
  it('selects an exact model from the separate dropdown overlay', async () => {
    const page = await newProjectPage(DISCOVERY_HTML);
    try {
      await page.evaluate(() => {
        document.querySelectorAll('#model-overlay flow-menu-item').forEach(item => {
          item.addEventListener('click', () => {
            document.querySelector('#composer-settings button.mat-mdc-menu-trigger').textContent = `${item.textContent} arrow_drop_down`;
            document.getElementById('model-overlay').style.display = 'none';
          });
        });
      });
      const { setPromptBarModel } = await import('../src/browser/safe-actions.js');
      const result = await setPromptBarModel(page, 'Nano Banana 2.1');
      expect(result.verified).toBe(true);
      expect(await page.locator('#composer-settings button.mat-mdc-menu-trigger').textContent()).toBe('Nano Banana 2.1 arrow_drop_down');
    } finally {
      await page.__context.close();
    }
  }, 30000);

  it('never accepts Lite as an exact match for Nano Banana 2', async () => {
    const page = await newProjectPage(DISCOVERY_HTML);
    try {
      await page.locator('#composer-settings button.mat-mdc-menu-trigger').evaluate(el => { el.textContent = 'Nano Banana 2 Lite arrow_drop_down'; });
      const { setPromptBarModel } = await import('../src/browser/safe-actions.js');
      const result = await setPromptBarModel(page, 'Nano Banana 2');
      expect(result.verified).toBe(false);
      expect(result.ok).toBe(false);
      expect(await page.locator('#composer-settings button.mat-mdc-menu-trigger').textContent()).toBe('Nano Banana 2 Lite arrow_drop_down');
    } finally {
      await page.__context.close();
    }
  }, 30000);

  it('enumerates Pro/Lite/2.1 from owning expanded dropdown, ignores changelog + disabled', async () => {
    const page = await newProjectPage(DISCOVERY_HTML);
    try {
      const { discoverModels } = await import('../src/navigation/model-discovery.js');
      const catalog = await discoverModels(page, { timeoutMs: 60000 });
      expect(catalog).not.toBe(null);
      expect(catalog.imageModels).toEqual(expect.arrayContaining(['Nano Banana Pro', 'Nano Banana 2 Lite', 'Nano Banana 2.1']));
      // Disabled Imagen 4 must not be enumerated as available.
      expect(catalog.imageModels).not.toContain('Imagen 4');
      // Stale suggestion "Nano Banana 2" from changelog must not leak in.
      expect(catalog.imageModels).not.toContain('Nano Banana 2');
      expect(catalog.source).toBe('live');
    } finally {
      await page.__context.close();
    }
  }, 90000);

  it('read-only refresh with no project context blocks without creation', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<textarea placeholder="create"></textarea>', { waitUntil: 'domcontentloaded' });
    // about:blank URL (not /project/): must block, must not navigate/create.
    const before = page.url();
    try {
      const { discoverModels } = await import('../src/navigation/model-discovery.js');
      const res = await discoverModels(page, { timeoutMs: 5000 });
      expect(res).toBe(null);
      expect(page.url()).toBe(before);
    } finally {
      await context.close();
    }
  }, 30000);
});
