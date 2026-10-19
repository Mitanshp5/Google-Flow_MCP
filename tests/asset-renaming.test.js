import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { handleRenameImage } from '../src/tools/rename-image.js';
import { renameCharacterTitle } from '../src/navigation/character-rename.js';

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe('native asset title controls', () => {
  it('renames the character name input, never the project/header editable', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<input aria-label="Editable text" value="Project title"><input aria-label="Character name" value="Untitled character">');
      expect(await renameCharacterTitle(page, 'QA Courier')).toBe(true);
      expect(await page.getByLabel('Character name', {exact:true}).inputValue()).toBe('QA Courier');
      expect(await page.getByLabel('Editable text', {exact:true}).inputValue()).toBe('Project title');
    } finally { await page.close(); }
  });

  it('waits for the debounced native title save acknowledgement', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute**', route => route.fulfill({
        body:'QA Saved Courier', headers:{'access-control-allow-origin':'*'},
      }));
      await page.setContent(`<button aria-label="Edit name">Edit</button><input aria-label="Character name" value="Untitled character"><button>Other</button>
        <script>document.querySelector('input').onblur = () => setTimeout(() => fetch('https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute', {
          method:'POST', body:new URLSearchParams({'f.req':JSON.stringify(['QA Saved Courier'])})
        }), 1200);</script>`);
      const start = Date.now();
      expect(await renameCharacterTitle(page, 'QA Saved Courier')).toBe(true);
      expect(Date.now()-start).toBeGreaterThan(1200);
    } finally { await page.close(); }
  });

  const fixture = `<input aria-label="Editable text" value="Project title">
    <flow-image-tile style="display:block"><img data-media-id="asset-1"><span class="footer-title">Original image</span>
      <button aria-label="More options">More</button></flow-image-tile>
    <button role="menuitem">editRename</button>
    <div><input class="editing" aria-label="Editable text"><button aria-label="Done">Done</button></div>
    <script>document.querySelector('button[aria-label="Done"]').onclick = () => {
      document.querySelector('.footer-title').textContent = document.querySelector('input.editing').value;
    };</script>`;

  it('renames the exact image tile, not the project title', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(fixture);
      const out = await handleRenameImage({asset_id:'asset-1', new_name:'QA Teapot'}, {
        page, ensureProject: async () => {}, navigate: async () => true, screenshot: async () => null,
      });
      expect(out).toMatchObject({status:'renamed', from:'Original image', to:'QA Teapot'});
      expect(await page.locator('input').first().inputValue()).toBe('Project title');
    } finally { await page.close(); }
  });

  it('refuses duplicate names before opening any menu', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(fixture + '<flow-image-tile style="display:block"><span class="footer-title">Original image</span></flow-image-tile>');
      await expect(handleRenameImage({name:'Original image',new_name:'QA Teapot'}, {
        page, ensureProject:async()=>{}, navigate:async()=>true,
      })).rejects.toThrow('found 2');
    } finally { await page.close(); }
  });

  it('returns from standalone character editor to the same project library before opening Images', async () => {
    const page = await browser.newPage();
    try {
      const root = 'https://flow.google.com/project/rename-regression';
      await page.route('https://flow.google.com/**', route => route.fulfill({
        contentType: 'text/html',
        body: route.request().url() === root
          ? '<nav><button>Images</button></nav>' + fixture
          : '<h1>Standalone character editor</h1>',
      }));
      await page.goto(`${root}/character/arden`);
      let reachedLibrary = false;
      const result = await handleRenameImage({asset_id:'asset-1',new_name:'Renamed in library',project_url:root}, {
        page, ensureProject:async()=>{}, screenshot:async()=>null,
        navigate:async(p, section)=>{
          reachedLibrary = p.url() === root && section === 'Images' && await p.locator('nav').isVisible();
          return reachedLibrary;
        },
      });
      expect(reachedLibrary).toBe(true);
      expect(result.status).toBe('renamed');
      expect(await page.locator('input').first().inputValue()).toBe('Project title');
    } finally { await page.close(); }
  });
});
