// W04 behavioral: download DOM enumeration + menu targeting + saved bytes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import fs from 'fs';
import {
  handleDownloadWithPage,
  enumerateAssetTiles,
} from '../src/tools/download-latest.js';

const DL_FIXTURE = `
<div id="library" data-account="qa@example.com" data-project="p1">
  <div class="asset-tile" data-asset-id="a-old" data-title="old.png" data-kind="image" data-project="p1" data-account="qa@example.com" data-created-at="100">
    <span>old.png</span>
    <button class="more">More options</button>
    <div class="menu" style="display:none"><button class="dl">Download</button></div>
  </div>
  <div class="asset-tile" data-asset-id="a-new" data-title="new.png" data-kind="image" data-project="p1" data-account="qa@example.com" data-created-at="200">
    <span>new.png</span>
    <button class="more">More options</button>
    <div class="menu" style="display:none"><button class="dl">Download</button></div>
  </div>
</div>
<script>
for (const tile of document.querySelectorAll('.asset-tile')) {
  tile.querySelector('.more').addEventListener('click', () => {
    tile.querySelector('.menu').style.display = 'block';
  });
  tile.querySelector('.dl').addEventListener('click', () => {
    const magic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tail = new TextEncoder().encode('DL-BYTES:' + tile.dataset.assetId);
    const bytes = new Uint8Array([...magic, ...tail]);
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = tile.dataset.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}
</script>`;

const AMBIG_FIXTURE = `
<div id="library" data-account="qa@example.com" data-project="p1">
  <div class="asset-tile" data-asset-id="u1" data-title="a.png" data-kind="image" data-project="p1" data-account="qa@example.com">
    <span>a.png</span><button class="more">More options</button>
    <div class="menu" style="display:none"><button class="dl">Download</button></div>
  </div>
  <div class="asset-tile" data-asset-id="u2" data-title="b.png" data-kind="image" data-project="p1" data-account="qa@example.com">
    <span>b.png</span><button class="more">More options</button>
    <div class="menu" style="display:none"><button class="dl">Download</button></div>
  </div>
</div>`;

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('W04 behavioral download enumeration + menu + bytes', () => {
  it('enumerates DOM tiles and downloads the verified newest via its menu', async () => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    try {
      await page.setContent(DL_FIXTURE);
      const tiles = await enumerateAssetTiles(page);
      expect(tiles).toHaveLength(2);
      const res = await handleDownloadWithPage(page, {}, {
        takeScreenshotFn: async () => null,
      });
      expect(res.status).toBe('downloaded');
      expect(res.latest_verified).toBe(true);
      expect(res.asset?.assetId || res.asset?.id).toBe('a-new');
      const bytes = fs.readFileSync(res.path);
      expect(bytes.toString().includes('a-new')).toBe(true);
      expect(res.verification?.verified).toBe(true);
      expect(res.verification?.hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await page.close();
      await ctx.close();
    }
  }, 25000);

  it('ambiguous multi-asset ordering without timestamps blocks with choices', async () => {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    try {
      await page.setContent(AMBIG_FIXTURE);
      const res = await handleDownloadWithPage(page, {}, {
        takeScreenshotFn: async () => null,
      });
      expect(res.status).toBe('ambiguous');
      expect(res.choices).toHaveLength(2);
    } finally {
      await page.close();
      await ctx.close();
    }
  }, 25000);
});
