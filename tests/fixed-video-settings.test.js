import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { configurePromptBar } from '../src/browser/safe-actions.js';
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

it('recognizes the actual tools gallery without requiring an unrelated prompt editor', () => {
  const html = '<nav><a aria-current="page">Tools</a></nav><div class="applet-manager-content"><flow-applet-hero-banner><h1>Submit your tool</h1></flow-applet-hero-banner></div>';
  expect(classifyAppState({url:'https://flow.google.com/project/qa/tools',html})).toMatchObject({app:'ready',reason:'flow-tools-gallery'});
  expect(classifyAppState({url:'https://example.com/project/qa/tools',html}).app).not.toBe('ready');
  expect(classifyAppState({url:'https://flow.google.com/project/qa/tools',html:'<h1>Tools</h1>'}).app).not.toBe('ready');
});
