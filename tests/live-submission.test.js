import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';
import { createLiveAuthorization } from '../src/domain/live-submission.js';
import { buildHandlerSubmissionContext } from '../src/domain/handler-submission-context.js';
import { executeDurableSubmission } from '../src/domain/submission-adapter.js';
import { withUiTransaction } from '../src/browser/ui-transaction.js';
import { jobQueue } from '../src/queue/job-queue.js';

const payload = { prompt: 'a quiet lake', model: 'Nano Banana Pro', ratio: '9:16', quantity: 1, type: 'image' };
const html = `<!doctype html><meta charset="utf-8"><body><span data-account-email="creator@example.com">creator@example.com</span>
<div id="composer" data-account="creator@example.com" data-project="live-test">
<div contenteditable="true">a quiet lake</div><div id="chips"></div><div id="slots"></div><div id="uploads"></div>
<button aria-label="Settings trigger" onclick="openPanel()">Nano Banana Pro 9:16 x1</button>
<button aria-pressed="false">Agent</button><button aria-label="Generate" onclick="window.clicks=(window.clicks||0)+1">Generate</button></div>
<div role="dialog" id="panel"><button class="mat-mdc-menu-trigger">Nano Banana Pro arrow_drop_down</button>
<button aria-pressed="true">Image</button><button>Video</button><button aria-pressed="true">9:16</button><button aria-pressed="true">x1</button>
<p>Generating will use 1 credits total</p></div>
<script>const panel=document.getElementById('panel');const markup=panel.innerHTML;function openPanel(){panel.innerHTML=markup;panel.style.display='block'}document.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.innerHTML='';panel.style.display='none'}})</script></body>`;

describe('explicit live-browser submission (intercepted browser; no remote spend)', { timeout: 30000 }, () => {
  let page;
  beforeEach(async () => {
    jobQueue.reset();
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', 'creator@example.com');
    vi.stubEnv('FLOW_HOME', fs.mkdtempSync(path.join(os.tmpdir(), 'flow-live-test-')));
    const browser = await w00LaunchBrowser();
    page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://flow.google.com/project/live-test');
    page.waitForTimeout = async () => {};
  });
  afterEach(async () => { await page.close(); vi.unstubAllEnvs(); });
  afterAll(w00CloseBrowser);

  async function context(epoch, maxCredits = 2) {
    return buildHandlerSubmissionContext({ page, epoch, requestPayload: payload,
      inputLocator: page.locator('[contenteditable]'),
      liveAuthorization: createLiveAuthorization({ page, confirmed: true, maxCredits }) });
  }
  async function replaceFixture(body) {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body }));
    await page.reload();
  }
  it('does not authorize prepare-only requests', () => {
    expect(createLiveAuthorization({ page, confirmed: false })).toBeNull();
  });
  it('submits once after common policy and durable approval consumption', async () => {
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await context(epoch);
      const result = await executeDurableSubmission({ page, epoch, ...ctx });
      expect(result.status).toBe('submitted');
      expect(result.result.remoteStatus).toBe('pending');
      expect(ctx.opStore.isChildConsumed(ctx.approvalChild.id)).toBe(true);
      expect(ctx.ledger.reserved).toBe(1);
      await expect(executeDurableSubmission({ page, epoch, ...ctx })).rejects.toBeTruthy();
      expect(await page.evaluate(() => window.clicks)).toBe(1);
    });
  });
  it('refuses a quote above the caller credit limit without a click or durable write', async () => {
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await context(epoch, 0);
      await expect(executeDurableSubmission({ page, epoch, ...ctx })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(ctx.opStore.listOperations()).toEqual([]);
      expect(await page.evaluate(() => window.clicks || 0)).toBe(0);
    });
  });
  it('reads live-style icon labels and binds an observed ambiguous zero quote', async () => {
    await replaceFixture(html
      .replace('>Nano Banana Pro arrow_drop_down</button>', '>🍌 Nano Banana Pro <mat-icon aria-hidden="true">arrow_drop_down</mat-icon></button>')
      .replace('aria-pressed="true">Image', 'aria-checked="true"><mat-icon aria-hidden="true">image</mat-icon>Image')
      .replace('aria-pressed="true">9:16', 'aria-selected="true"><mat-icon aria-hidden="true">crop_9_16</mat-icon>9:16')
      .replace('Generating will use 1 credits total', '0 credits'));
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await context(epoch, 0);
      expect(ctx.quote).toMatchObject({ total: 0, unit: 'total', model: payload.model, feature: 'image', raw: '0 credits' });
      expect((await executeDurableSubmission({ page, epoch, ...ctx })).status).toBe('submitted');
      expect(await page.evaluate(() => window.clicks)).toBe(1);
    });
  });
  it('does not reinterpret an ambiguous multi-output credit label as an authorized price', async () => {
    await replaceFixture(html.replaceAll('x1', 'x2').replace('Generating will use 1 credits total', '1 credits'));
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await buildHandlerSubmissionContext({ page, epoch, requestPayload: { ...payload, quantity: 2 },
        inputLocator: page.locator('[contenteditable]'), liveAuthorization: createLiveAuthorization({ page, confirmed: true }) });
      expect(ctx.quote).toBeNull();
      await expect(executeDurableSubmission({ page, epoch, ...ctx })).rejects.toBeTruthy();
      expect(await page.evaluate(() => window.clicks || 0)).toBe(0);
    });
  });
  it('binds a single-output price without guessing a multi-output pricing unit', async () => {
    await replaceFixture(html.replace('Generating will use 1 credits total', '1 credits'));
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await context(epoch);
      expect(ctx.quote).toMatchObject({ total: 1, quantity: 1, unit: 'total', raw: '1 credits' });
      expect((await executeDurableSubmission({ page, epoch, ...ctx })).status).toBe('submitted');
    });
  });
  it('checks prompt prose separately from approved ingredient chip labels', async () => {
    await page.locator('[contenteditable]').evaluate(root => {
      root.insertAdjacentHTML('beforeend', ' <span class="mention-chip" data-chip-id="chip-1" data-asset-id="asset-1" data-title="Reference">Reference</span> ');
    });
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await buildHandlerSubmissionContext({ page, epoch, requestPayload: payload,
        inputLocator: page.locator('[contenteditable]'), mentionNames: ['Reference'],
        liveAuthorization: createLiveAuthorization({ page, confirmed: true }) });
      expect(ctx.requestPayload.references).toEqual([{ assetId: 'asset-1', title: 'Reference', role: 'ingredient' }]);
      expect((await executeDurableSubmission({ page, epoch, ...ctx })).status).toBe('submitted');
    });
  });
  it('refuses an account mismatch before clicking', async () => {
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', 'other@example.com');
    await withUiTransaction(async ({ epoch }) => {
      const ctx = await context(epoch);
      await expect(executeDurableSubmission({ page, epoch, ...ctx })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(await page.evaluate(() => window.clicks || 0)).toBe(0);
    });
  });
  it('rejects invalid credit limits', () => {
    for (const maxCredits of [-1, NaN, Infinity]) {
      expect(() => createLiveAuthorization({ page, confirmed: true, maxCredits })).toThrow();
    }
  });
});
