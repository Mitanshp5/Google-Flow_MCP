import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverDownloadBytes, saveMediaDownload } from '../src/utils/media-download.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Buffer.from('test image')]);
let browser;
const directories = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('download recovery after CDP reconnect', () => {
  it('recovers the exact observed blob after saveAs loses its temp file', async () => {
    const page = await browser.newPage();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-download-recovery-'));
    directories.push(directory);
    try {
      await page.route('https://flow.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<body>Fixture</body>' }));
      await page.goto('https://flow.google.com/project/test');
      const event = page.waitForEvent('download');
      await page.evaluate(bytes => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        link.download = 'original.png';
        document.body.append(link);
        link.click();
      }, [...png]);
      const download = await event;
      const result = await saveMediaDownload({
        saveAs: async () => { throw Object.assign(new Error('download.saveAs: ENOENT missing temp file'), { code: 'ENOENT' }); },
        url: () => download.url(), suggestedFilename: () => download.suggestedFilename(),
      }, kind => path.join(directory, kind), { page });
      expect(result.transport).toBe('browser-fetch-recovery');
      expect(result.verification.verified).toBe(true);
      expect(fs.readFileSync(result.path)).toEqual(png);
      expect(fs.readdirSync(path.join(directory, 'other'))).toEqual([]);
    } finally { await page.close(); }
  });

  it('creates missing output directories for ordinary downloads', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-download-direct-'));
    directories.push(directory);
    const result = await saveMediaDownload({
      saveAs: async file => fs.writeFileSync(file, png), suggestedFilename: () => 'original.png',
    }, kind => path.join(directory, kind));
    expect(result.transport).toBe('playwright-download');
    expect(fs.readFileSync(result.path)).toEqual(png);
  });

  it('does not retry permission failures or hide them with cleanup errors', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-download-error-'));
    directories.push(directory);
    const evaluate = vi.fn();
    await expect(saveMediaDownload({
      saveAs: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
    }, kind => path.join(directory, kind), { page: { evaluate } })).rejects.toThrow('permission denied');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example/file', 'file:///secret', 'blob:https://evil.example/id', 'http://flow.google.com/file', 'https://flow.google.com:8443/file'])('rejects untrusted recovery URL %s', async url => {
    const page = { url: () => 'https://flow.google.com/project/test', evaluate: vi.fn() };
    await expect(recoverDownloadBytes(page, { url: () => url })).rejects.toThrow('untrusted');
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects an expired signed URL instead of saving its HTML error response', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://flow.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<body>Fixture</body>' }));
      await page.goto('https://flow.google.com/project/test');
      await page.route('https://flow-content.google/**', route => route.fulfill({
        status: 403, headers: { 'access-control-allow-origin': '*' }, body: '<html>Expired</html>',
      }));
      await expect(recoverDownloadBytes(page, { url: () => 'https://flow-content.google/image/test?signature=expired' })).rejects.toThrow('HTTP 403');
    } finally { await page.close(); }
  });
});
