import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { handleToolCall, TOOL_DEFINITIONS } from '../src/index.js';
import { withPage } from '../src/browser/session-scope.js';
import { handleDownloadWithPage } from '../src/tools/download-latest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

async function fixturePage(url, html) {
  const page = await browser.newPage();
  await page.route('https://flow.google.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  return page;
}

describe('issue #5 download discovery recovery', () => {
  it('opens an explicitly targeted existing project and discovers asynchronously loaded media in one public call', async () => {
    const page = await fixturePage('https://flow.google.com/', '<main>Home</main>');
    await page.route('https://flow.google.com/project/target', route => route.fulfill({ contentType: 'text/html', body: `<main>Loading library</main><script>setTimeout(() => { document.body.innerHTML = '<flow-image-tile style="display:block" data-asset-id="target-a">First image</flow-image-tile><flow-image-tile style="display:block" data-asset-id="target-b">Second image</flow-image-tile>'; }, 400);</script>` }));
    try {
      const response = await withPage(page, () => handleToolCall('flow_download_latest', { project_url: 'https://flow.google.com/project/target' }));
      const result = JSON.parse(response.content[0].text);
      expect(page.url()).toBe('https://flow.google.com/project/target');
      expect(result).toMatchObject({ status: 'ambiguous', choices: ['target-a', 'target-b'] });
      expect(TOOL_DEFINITIONS.find(tool => tool.name === 'flow_download_latest').inputSchema.properties.project_url.type).toBe('string');
    } finally { await page.close(); }
  });

  it('waits for a delayed library in the current project without reloading its composer', async () => {
    const page = await fixturePage('https://flow.google.com/project/current', '<textarea>Keep this prompt</textarea><script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", \'<flow-image-tile style="display:block" data-asset-id="a">First</flow-image-tile><flow-image-tile style="display:block" data-asset-id="b">Second</flow-image-tile>\'); }, 400);</script>');
    try {
      const response = await withPage(page, () => handleToolCall('flow_download_latest', { project_url: 'https://flow.google.com/project/current' }));
      const result = JSON.parse(response.content[0].text);
      expect(result).toMatchObject({ status: 'ambiguous', choices: ['a', 'b'] });
      expect(await page.locator('textarea').inputValue()).toBe('Keep this prompt');
    } finally { await page.close(); }
  });

  it('downloads the requested existing asset directly from home using project_url', async () => {
    const page = await fixturePage('https://flow.google.com/', '<main>Home</main>');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-project-download-'));
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
    await page.route('https://flow.google.com/project/target', route => route.fulfill({ contentType: 'text/html', body: `<flow-image-tile style="display:block" data-asset-id="target-a" data-kind="image"><button aria-label="Download" onclick="const link=document.createElement('a');link.href='data:image/png;base64,${png}';link.download='existing.png';link.click()">Download</button></flow-image-tile>` }));
    try {
      const result = await handleDownloadWithPage(page, { project_url: 'https://flow.google.com/project/target', asset_id: 'target-a' }, { takeScreenshotFn: async () => null, getOutputDirFn: () => dir });
      expect(result).toMatchObject({ status: 'downloaded', asset: { assetId: 'target-a' }, latest_verified: false });
      expect(fs.readFileSync(result.path)).toEqual(Buffer.from(png, 'base64'));
    } finally { await page.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not download from another project after the target redirects', async () => {
    const page = await fixturePage('https://flow.google.com/', '<main>Home</main>');
    await page.route('https://flow.google.com/project/other', route => route.fulfill({ contentType: 'text/html', body: '<button aria-label="Download" onclick="window.downloadClicked=true">Download</button>' }));
    // Playwright routing only intercepts the first request in an HTTP
    // redirect chain. Model that navigation result without contacting Flow.
    const goto = page.goto.bind(page);
    page.goto = (url, options) => goto(url === 'https://flow.google.com/project/target' ? 'https://flow.google.com/project/other' : url, options);
    try {
      const response = await withPage(page, () => handleToolCall('flow_download_latest', { project_url: 'https://flow.google.com/project/target' }));
      expect(JSON.parse(response.content[0].text)).toMatchObject({ status: 'not_found', reason: 'project_unavailable' });
      expect(await page.evaluate(() => window.downloadClicked)).toBeUndefined();
    } finally { await page.close(); }
  });

  it('blocks a delayed redirect to another project during library hydration', async () => {
    const page = await fixturePage('https://flow.google.com/', '<main>Home</main>');
    let clicks = 0;
    await page.exposeFunction('recordDownloadClick', () => { clicks++; });
    await page.route('https://flow.google.com/project/target', route => route.fulfill({ contentType: 'text/html', body: '<main>Loading</main><script>setTimeout(() => location.href="https://flow.google.com/project/other", 350)</script>' }));
    await page.route('https://flow.google.com/project/other', route => route.fulfill({ contentType: 'text/html', body: '<flow-image-tile style="display:block" data-asset-id="other"><button aria-label="Download" onclick="recordDownloadClick()">Download</button></flow-image-tile>' }));
    const waitForEvent = page.waitForEvent.bind(page);
    page.waitForEvent = (event, options) => event === 'download' ? Promise.resolve(null) : waitForEvent(event, options);
    try {
      const response = await withPage(page, () => handleToolCall('flow_download_latest', { project_url: 'https://flow.google.com/project/target' }));
      expect(JSON.parse(response.content[0].text)).toMatchObject({ status: 'not_found', reason: 'project_unavailable' });
      expect(clicks).toBe(0);
    } finally { await page.close(); }
  });

  it('blocks a project change while the asset menu is opening', async () => {
    const page = await fixturePage('https://flow.google.com/project/target', `<flow-image-tile style="display:block" data-asset-id="same-id"><button aria-label="More options" onclick="history.replaceState(null,'','/project/other');document.querySelector('#menu').hidden=false">More</button></flow-image-tile><div role="menu" id="menu" hidden><button role="menuitem" onclick="window.downloadClicked=true">Download</button></div>`);
    const waitForEvent = page.waitForEvent.bind(page);
    page.waitForEvent = (event, options) => event === 'download' ? Promise.resolve(null) : waitForEvent(event, options);
    try {
      const response = await withPage(page, () => handleToolCall('flow_download_latest', { project_url: 'https://flow.google.com/project/target', asset_id: 'same-id' }));
      expect(JSON.parse(response.content[0].text)).toMatchObject({ status: 'not_found', reason: 'project_unavailable' });
      expect(await page.evaluate(() => window.downloadClicked)).toBeUndefined();
    } finally { await page.close(); }
  });

  it.each([
    'https://example.com/project/target',
    'https://flow.google.com/',
    'https://flow.google.com/project/target/tools',
    'https://flow.google.com@evil.example/project/target',
    'https://flow.google.com:8443/project/target',
    'http://flow.google.com/project/target',
  ])('rejects a non-project target before navigating: %s', async project_url => {
    const page = await fixturePage('https://flow.google.com/', '<main>Home</main>');
    try {
      await expect(withPage(page, () => handleToolCall('flow_download_latest', { project_url }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(page.url()).toBe('https://flow.google.com/');
    } finally { await page.close(); }
  });

  it('explains that the home page needs an existing project through public dispatch', async () => {
    const page = await fixturePage('https://flow.google.com/?pli=1', '<a href="/project/existing">Existing project</a><button>New project</button>');
    try {
      const response = await withPage(page, () => handleToolCall('flow_download_latest', {}));
      const result = JSON.parse(response.content[0].text);
      expect(result).toMatchObject({ status: 'not_found', reason: 'project_required', currentUrl: 'https://flow.google.com/' });
      expect(result.message).toMatch(/open an existing.*project/i);
      expect(result.next_action).toMatch(/flow_open/);
      expect(page.url()).toBe('https://flow.google.com/?pli=1');
    } finally { await page.close(); }
  });

  it('distinguishes a project without discoverable media from a home-page failure', async () => {
    const page = await fixturePage('https://flow.google.com/project/existing', '<main>No completed media</main>');
    try {
      const result = await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null });
      expect(result).toMatchObject({ status: 'not_found', reason: 'no_visible_assets', currentUrl: 'https://flow.google.com/project/existing' });
      expect(result.message).toMatch(/completed.*image|completed.*video/i);
      expect(result.next_action).toMatch(/visible/i);
    } finally { await page.close(); }
  });

  it('never clicks an unrelated open download menu when an explicit asset cannot be discovered', async () => {
    const page = await fixturePage('https://flow.google.com/project/existing', '<button aria-label="Download" onclick="window.downloadClicked=true">Download</button>');
    try {
      const originalWait = page.waitForEvent.bind(page);
      page.waitForEvent = (event, options) => event === 'download' ? Promise.resolve(null) : originalWait(event, options);
      const result = await handleDownloadWithPage(page, { asset_id: 'missing-id' }, { takeScreenshotFn: async () => null });
      expect(result).toMatchObject({ status: 'not_found', reason: 'explicit_asset_not_found', choices: [] });
      expect(await page.evaluate(() => window.downloadClicked)).toBeUndefined();
    } finally { await page.close(); }
  });

  it('preserves an already-open download without claiming latest identity when no asset was requested', async () => {
    const page = await fixturePage('https://flow.google.com/project/existing', `<button aria-label="Download" onclick="const link=document.createElement('a');link.href='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';link.download='existing.png';link.click()">Download</button>`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-download-discovery-'));
    try {
      const result = await handleDownloadWithPage(page, {}, { takeScreenshotFn: async () => null, getOutputDirFn: () => dir });
      expect(result).toMatchObject({ status: 'downloaded', latest_verified: false, asset: null, kind: 'image' });
      expect(fs.readFileSync(result.path).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    } finally { await page.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
