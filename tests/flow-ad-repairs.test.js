import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { attachReferenceFiles } from '../src/browser/safe-actions.js';
import { attachUploadedPickerAssets } from '../src/browser/upload.js';
import { handleDownloadWithPage } from '../src/tools/download-latest.js';
import { isVideoPreparationVerified } from '../src/tools/generate-video.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
let browser, dir;
beforeAll(async () => { browser = await chromium.launch({headless: true}); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ad-repairs-')); });
afterAll(async () => { await browser?.close(); if (dir) fs.rmSync(dir, {recursive: true, force: true}); });

describe('live-derived Flow ad repairs (local browser fixtures, zero credits)', () => {
  it('opens the filechooser, waits for the upload and adds the stable asset to the composer', async () => {
    const page = await browser.newPage();
    const file = path.join(dir, 'hero.png'); fs.writeFileSync(file, png);
    try {
      await page.setContent(`<style>flow-add-menu-asset-item{display:block;padding:15px}</style>
        <flow-add-menu><button aria-label="Add ingredients to the prompt box" onclick="document.querySelector('#picker').hidden=false">+</button></flow-add-menu>
        <div id="picker" hidden><button onclick="document.querySelector('input').click()">Upload media</button>
        <input type="file" hidden><div id="rows"></div><button id="add">Add to prompt</button></div>
        <flow-prompt-box></flow-prompt-box><script>
        document.querySelector('input').onchange=()=>{ const name=document.querySelector('input').files[0].name;
        setTimeout(()=>document.querySelector('#rows').innerHTML='<flow-add-menu-asset-item><span class="asset-title">'+name+'</span><img src="https://flow-content.google/image/abc-123?token=x"></flow-add-menu-asset-item>',900); };
        document.querySelector('#add').onclick=()=>{document.querySelector('flow-prompt-box').innerHTML='<flow-ingredient-chip><img src="https://flow-content.google/image/abc-123?token=x"></flow-ingredient-chip>';document.querySelector('#picker').hidden=true;};
        </script>`);
      const result = await attachReferenceFiles(page, null, [file], {timeoutMs: 3000});
      expect(result.fileChooserSeen).toBe(true);
      expect(result.verified, JSON.stringify(result)).toBe(true);
      expect(result.acknowledged[0].assetId).toBe('abc-123');
      expect(await page.locator('flow-prompt-box flow-ingredient-chip').count()).toBe(1);
    } finally { await page.close(); }
  }, 15000);

  it('never verifies a library upload without the same asset in the composer', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<flow-add-menu-asset-item><span class="asset-title">pending.png</span><span>Uploading</span></flow-add-menu-asset-item>');
      expect((await attachUploadedPickerAssets(page, ['pending.png'], {timeoutMs: 1})).verified).toBe(false);
    } finally { await page.close(); }
  });

  it('downloads original media through its submenu, correcting a misleading transport extension', async () => {
    const page = await browser.newPage({acceptDownloads: true});
    try {
      await page.setContent(`<flow-image-tile><img data-media-id="abc-123" src="data:image/png;base64,${png.toString('base64')}">
        <button aria-label="More options" onclick="document.querySelector('#menu').hidden=false">More</button></flow-image-tile>
        <div role="menu" id="menu" hidden><button role="menuitem" aria-haspopup="menu" onmouseover="document.querySelector('#original').hidden=false">Download</button>
        <a role="menuitem" id="original" hidden download="transport.bin" href="data:image/png;base64,${png.toString('base64')}">1K Original size</a>
        <button role="menuitem" onclick="window.upscaled=true">2K Upscaled</button></div>`);
      const result = await handleDownloadWithPage(page, {asset_id: 'abc-123'}, {
        takeScreenshotFn: async () => null, getOutputDirFn: () => dir,
      });
      expect(result.status).toBe('downloaded');
      expect(result.path).toMatch(/\.png$/);
      expect(result.verification.mime).toBe('image/png');
      expect(result.latest_verified).toBe(false);
      expect(fs.readFileSync(result.path)).toEqual(png);
      expect(await page.evaluate(() => window.upscaled)).toBeUndefined();
    } finally { await page.close(); }
  });

  it('failed uploads, unknown slots, partial ingredients and settings never mean ready', () => {
    const base = {settingsVerified: true, attachVerified: true};
    expect(isVideoPreparationVerified(base)).toBe(true);
    expect(isVideoPreparationVerified({...base, attachVerified: false})).toBe(false);
    expect(isVideoPreparationVerified({...base, frames: {start: {upload_verified: true, verified: false}}})).toBe(false);
    expect(isVideoPreparationVerified({...base, failedMentions: ['missing']})).toBe(false);
    expect(isVideoPreparationVerified({...base, failedSettings: ['quality']})).toBe(false);
  });
});
