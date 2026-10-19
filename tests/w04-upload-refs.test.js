// W04 behavioral: real Playwright fixture DOM/event execution for upload.
// No live CDP/Flow, no real uploads to Flow — local fixture page only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  openUploadPicker,
  uploadReferences,
  verifySlotAssignment,
  attachUploadedPickerAssets,
} from '../src/browser/upload.js';

const UPLOAD_FIXTURE = `
<button id="add">Add ingredients</button>
<button id="upload" style="display:none">Upload media</button>
<input type="file" id="fi" multiple style="display:none" />
<div id="uploads"></div>
<div id="composer" data-account="qa@example.com" data-project="p1"></div>
<script>
document.getElementById('add').addEventListener('click', () => {
  document.getElementById('upload').style.display = 'block';
});
document.getElementById('upload').addEventListener('click', () => {
  document.getElementById('fi').click();
});
document.getElementById('fi').addEventListener('change', (e) => {
  const host = document.getElementById('uploads');
  host.innerHTML = '';
  for (const f of e.target.files) {
    const d = document.createElement('div');
    d.className = 'upload-ack';
    d.dataset.uploadName = f.name;
    d.dataset.assetId = 'ack-' + f.name;
    d.dataset.title = f.name;
    d.textContent = f.name;
    host.appendChild(d);
  }
});
</script>`;

function makePng(name) {
  const p = path.join(os.tmpdir(), name);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('w04-fixture-' + name),
  ]);
  fs.writeFileSync(p, bytes);
  return p;
}

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('W04 behavioral upload filechooser race', () => {
  it('captures the real filechooser fired by the Upload click and accepts files', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(UPLOAD_FIXTURE);
      const out = await openUploadPicker(page);
      expect(out.error ?? null).toBe(null);
      expect(out.fileChooser).toBeTruthy();
      const f = makePng('w04-race-a.png');
      await out.fileChooser.setFiles([f]);
      await page.waitForTimeout(400);
      const accepted = await page.evaluate(() => document.getElementById('fi').files.length);
      expect(accepted).toBe(1);
      const ack = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.upload-ack')).map((d) => ({
          name: d.dataset.uploadName,
          assetId: d.dataset.assetId,
        }))
      );
      expect(ack).toHaveLength(1);
      expect(ack[0].assetId).toBe('ack-w04-race-a.png');
    } finally {
      await page.close();
    }
  }, 20000);
});

describe('W04 behavioral uploadReferences end to end', () => {
  it('selects the new stable ID when frame upload retries have identical filenames', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://flow-content.google/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=', 'base64') }));
      await page.setContent(`
        <flow-base-prompt-box style="display:block;width:600px">
          <flow-ingredient-bar><div class="ingredient-bar-container">
            <div class="frame-trigger"><button>Start</button></div>
            <button aria-label="Swap first and last frames">Swap</button>
            <div class="frame-trigger"><button>End</button></div>
          </div></flow-ingredient-bar>
        </flow-base-prompt-box>
        <flow-add-menu-asset-item id="old" style="display:block"><img width="20" height="20" src="https://flow-content.google/image/aaaa-1111"><span class="asset-title">hero.jpg</span></flow-add-menu-asset-item>
        <flow-add-menu-asset-item id="new" style="display:block"><img width="20" height="20" src="https://flow-content.google/image/bbbb-2222"><span class="asset-title">hero.jpg</span></flow-add-menu-asset-item>
        <script>
          document.querySelectorAll('flow-add-menu-asset-item').forEach(item => item.onclick = () => {
            window.selectedItem = item.id;
            document.querySelector('.frame-trigger').innerHTML = '<flow-image-ingredient-chip>' + item.querySelector('img').outerHTML + '</flow-image-ingredient-chip>';
          });
        </script>
      `);
      const result = await attachUploadedPickerAssets(page, ['hero.jpg'], { excludeAssetIds: ['aaaa-1111'], slot: 'start', timeoutMs: 1000 });
      expect(result.verified).toBe(true);
      expect(result.acknowledged[0]).toMatchObject({ assetId: 'bbbb-2222', slot: 'start' });
      expect(await page.evaluate(() => window.selectedItem)).toBe('new');
    } finally {
      await page.close();
    }
  }, 15000);

  it('validates+hashes local files, setFiles via chooser, acks stable identity', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(UPLOAD_FIXTURE);
      const input = page.locator('#composer');
      const f1 = makePng('w04-e2e-hero.png');
      const out = await uploadReferences(page, input, [f1], {
        account: 'qa@example.com',
        projectId: 'p1',
      });
      expect(out.verified).toBe(true);
      expect(out.localRecords).toHaveLength(1);
      expect(out.localRecords[0].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(out.acknowledged[0]).toMatchObject({ name: 'w04-e2e-hero.png' });
      expect(out.acknowledged[0].assetId).toBeTruthy();
    } finally {
      await page.close();
    }
  }, 20000);

  it('uncertain acknowledgement (no ack DOM) stays unverified', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button>Add ingredients</button>
        <button>Upload media</button>
        <input type="file" id="fi2" style="display:none" />
        <div id="composer"></div>
        <script>
          document.querySelectorAll('button')[1].addEventListener('click', () => document.getElementById('fi2').click());
        </script>`);
      const input = page.locator('#composer');
      const f1 = makePng('w04-e2e-uncertain.png');
      const out = await uploadReferences(page, input, [f1], {
        account: 'qa@example.com',
        projectId: 'p1',
      });
      expect(out.verified).toBe(false);
    } finally {
      await page.close();
    }
  }, 20000);
});

describe('W04 behavioral slot stable identity', () => {
  it('same title with different stable IDs does NOT verify', () => {
    const r = verifySlotAssignment(
      { start: { title: 'hero.png', assetId: 'expect-A' } },
      { start: { title: 'hero.png', assetId: 'observed-B', slot: 'start' } }
    );
    expect(r.verified).toBe(false);
    expect(r.roles.start.verified).toBe(false);
  });
  it('swapped stable IDs do NOT verify even though titles are swapped consistently', () => {
    const r = verifySlotAssignment(
      {
        start: { title: 'hero.png', assetId: 'id-start' },
        end: { title: 'end.png', assetId: 'id-end' },
      },
      {
        start: { title: 'end.png', assetId: 'id-end', slot: 'start' },
        end: { title: 'hero.png', assetId: 'id-start', slot: 'end' },
      }
    );
    expect(r.verified).toBe(false);
    expect(r.swapped).toBe(true);
  });
});
