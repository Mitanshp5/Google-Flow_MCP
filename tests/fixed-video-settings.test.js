import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { configurePromptBar, readAuthoritativeSettings, setPromptBarModel } from '../src/browser/safe-actions.js';
import { classifyAppState } from '../src/browser/app-state.js';

it('verifies fixed Veo duration and quality from the owned composer without fake options', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent(`<div><textarea placeholder="What do you want to create?"></textarea>
      <button aria-pressed="false">Agent</button><button>Video · 720p · 8s crop_16_9 x1</button><button>Send</button></div>
      <div role="dialog"><button class="mat-mdc-menu-trigger">Veo 3.1 - Fast arrow_drop_down</button>
      <button>Video</button><button>16:9</button><button>x1</button><p>Generating will use 20 credits</p></div>
      <script>document.addEventListener('keydown', e=>{if(e.key==='Escape')document.querySelector('[role=dialog]').style.display='none';});</script>`);
    const results = await configurePromptBar(page, {quality:'720p',duration:'8s'});
    expect(results).toHaveLength(2);
    expect(results.every(r=>r.ok && r.verified && r.detail.includes('fixed'))).toBe(true);
  } finally { await browser.close(); }
}, 10000);

it('readAuthoritativeSettings ignores page header more_vert triggers and strips Leaving Dec 5 badges', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <header><button class="mat-mdc-menu-trigger">more_vert</button></header>
      <div><textarea placeholder="What do you want to create?"></textarea>
        <button aria-pressed="false">Agent</button>
        <button>Video · 720p · 8s crop_16_9 x1</button>
        <button>Send</button>
      </div>
      <div role="dialog">
        <button class="mat-mdc-menu-trigger">volume_upVeo 3.1 - Fast Leaving Dec 5 arrow_drop_down</button>
        <button aria-pressed="true">Video</button>
        <button aria-pressed="true">16:9</button>
        <button aria-pressed="true">x1</button>
        <p>Generating will use 12 credits</p>
      </div>
    `);
    const st = await readAuthoritativeSettings(page);
    expect(st.model).toBe('Veo 3.1 - Fast');
    expect(st.mode).toBe('video');
    expect(st.ratio).toBe('16:9');
    expect(st.quantity).toBe(1);
  } finally { await browser.close(); }
}, 10000);

it('setPromptBarModel selects dropdown options carrying Leaving Dec 5 deprecation suffixes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div><textarea placeholder="What do you want to create?"></textarea>
        <button aria-pressed="false">Agent</button>
        <button>Video · 720p · 8s crop_16_9 x1</button>
      </div>
      <div role="dialog">
        <button id="modelRow" class="mat-mdc-menu-trigger">Omni 1.2 Flash arrow_drop_down</button>
        <button>Video</button><button>16:9</button><button>x1</button><p>Generating will use 12 credits</p>
      </div>
      <div id="menuPane" class="cdk-overlay-pane" style="display:none;position:fixed;top:10px;left:10px;width:220px;height:140px;">
        <flow-menu-item role="menuitem" style="display:block;width:200px;height:30px;">Omni 1.2 Flash</flow-menu-item>
        <flow-menu-item role="menuitem" style="display:block;width:200px;height:30px;">volume_upVeo 3.1 - Fast Leaving Dec 5</flow-menu-item>
      </div>
      <script>
        const row = document.getElementById('modelRow');
        const pane = document.getElementById('menuPane');
        row.addEventListener('click', () => { pane.style.display = 'block'; });
        pane.querySelectorAll('flow-menu-item').forEach((item) => {
          item.addEventListener('click', () => {
            row.textContent = item.textContent + ' arrow_drop_down';
            pane.style.display = 'none';
          });
        });
      </script>
    `);
    const res = await setPromptBarModel(page, 'Veo 3.1 - Fast');
    expect(res).toMatchObject({ ok: true, verified: true, kind: 'model', detail: 'Veo 3.1 - Fast' });
  } finally { await browser.close(); }
}, 15000);

it('recognizes the actual tools gallery without requiring an unrelated prompt editor', () => {
  const html = '<nav><a aria-current="page">Tools</a></nav><div class="applet-manager-content"><flow-applet-hero-banner><h1>Submit your tool</h1></flow-applet-hero-banner></div>';
  expect(classifyAppState({url:'https://flow.google.com/project/qa/tools',html})).toMatchObject({app:'ready',reason:'flow-tools-gallery'});
  expect(classifyAppState({url:'https://example.com/project/qa/tools',html}).app).not.toBe('ready');
  expect(classifyAppState({url:'https://flow.google.com/project/qa/tools',html:'<h1>Tools</h1>'}).app).not.toBe('ready');
});
