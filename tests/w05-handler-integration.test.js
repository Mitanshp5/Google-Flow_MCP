import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withSession } from '../src/browser/session-scope.js';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';
import { handleToolCall } from '../src/index.js';
import { createOperationStore, mintChildApproval } from '../src/domain/operations.js';
import { digestRequest } from '../src/domain/contracts.js';
import { readJournal } from '../src/storage/journal.js';
import { jobQueue } from '../src/queue/job-queue.js';

const request = { prompt: 'a quiet lake', model: 'Nano Banana Pro', ratio: '1:1', quantity: 1, type: 'image' };
const html = `<!doctype html><body><span data-account-email="creator@example.com">creator@example.com</span>
<div id="composer" data-account="creator@example.com" data-project="fixture-project">
<div contenteditable="true" aria-label="Image prompt"></div><div id="chips"></div><div id="slots"></div><div id="uploads"></div>
<button aria-label="Settings trigger" onclick="openPanel()">Nano Banana Pro 1:1 x1</button>
<button aria-pressed="false">Agent</button><button aria-label="Generate">Generate</button></div>
<div role="dialog" id="panel"><button class="mat-mdc-menu-trigger">Nano Banana Pro arrow_drop_down</button>
<button aria-pressed="true">Image</button><button>Video</button><button aria-pressed="true">1:1</button><button aria-pressed="true">x1</button>
<p>Generating will use 0 credits total</p></div>
<script>const panel=document.getElementById('panel');const markup=panel.innerHTML;function openPanel(){panel.innerHTML=markup;panel.style.display='block'}document.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.innerHTML='';panel.style.display='none'}})</script></body>`;
const previousFlowHome = process.env.FLOW_HOME;
const runtimeRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir(), 'w05-handler-'));
let serial = 0;
async function fixture(payload = request, fixtureHtml = html) {
  const root = path.join(runtimeRoot, `case-${++serial}`);
  fs.mkdirSync(root, { recursive: true });
  const opStore = createOperationStore(root);
  const approvalChild = mintChildApproval({ policyId: 'local-image', maxCredits: 0 }, {
    requestDigest: digestRequest(payload), accountKey: 'creator@example.com', projectId: 'fixture-project', model: payload.model, quoteTotal: 0,
  });
  const approvals = new Map([[approvalChild.id, approvalChild]]);
  const ledger = { reserved: 0, maxAuthorized: 0 };
  const browser = await w00LaunchBrowser();
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
  await page.goto('http://127.0.0.1/project/fixture-project');
  page.waitForTimeout = async () => {};
  const calls = [];
  const handlerSubmission = { page, expectedAccount: 'creator@example.com', intendedProjectId: 'fixture-project',
    approvalChild, approvals, ledger, opStore, origin: 'local-fixture:w05-handler',
    submit: async ({ operationId, bounded }) => {
      calls.push(operationId);
      expect(bounded.status).toBe('submission_unknown');
      expect(approvalChild.consumed).toBe(true);
      expect(opStore.isChildConsumed(approvalChild.id)).toBe(true);
      expect(readJournal(opStore.journalDir).records.map(x => x.kind)).toEqual(['intent', 'attempt', 'approval', 'reservation']);
      return { local: true };
    } };
  return { page, handlerSubmission, opStore, approvalChild, approvals, ledger, calls };
}
async function dispatch(f, args = {}) {
  return withSession({ page: f.page, handlerSubmission: f.handlerSubmission }, () => handleToolCall('flow_generate_image', {
    prompt: request.prompt, model: request.model, ratio: request.ratio, quantity: 1, auto_confirm: true, ...args,
  }));
}
describe('W05 actual handler policy integration', { timeout: 30000 }, () => {
  beforeEach(() => { jobQueue.reset(); process.env.FLOW_HOME = path.join(runtimeRoot, 'home'); });
  afterAll(async () => { if (previousFlowHome === undefined) delete process.env.FLOW_HOME; else process.env.FLOW_HOME = previousFlowHome; await w00CloseBrowser(); });
  afterEach(() => { vi.useRealTimers(); });
  it('dispatches image through observed local composer, policy, durable commit and scoped transport', async () => {
    const f = await fixture();
    try {
      let response;
      let error;
      try { response = await dispatch(f); } catch (e) { error = e; }
      expect(error?.code, error?.message).toBeUndefined();
      expect(JSON.parse(response.content[0].text).status).toBe('submitted');
      expect(f.calls).toHaveLength(1);
      expect(f.opStore.listOperations()).toHaveLength(1);
    } finally { await f.page.close(); }
  });
  const negatives = [
    ['wrong expected account', f => { f.handlerSubmission.expectedAccount = 'other@example.com'; }],
    ['missing expected account', f => { delete f.handlerSubmission.expectedAccount; }],
    ['wrong intended project', f => { f.handlerSubmission.intendedProjectId = 'other-project'; }],
    ['missing intended project', f => { delete f.handlerSubmission.intendedProjectId; }],
    ['expired approval', f => { f.approvalChild.expiresAt = Date.now() - 1; }],
    ['consumed approval', f => { f.approvalChild.consumed = true; }],
    ['unregistered approval', f => { f.approvals.clear(); }],
    ['substituted registry child', f => { f.approvals.set(f.approvalChild.id, { ...f.approvalChild, nonce: 'substitute' }); }],
    ['wrong approved prompt digest', f => { f.approvalChild.requestDigest = digestRequest({ ...request, prompt: 'other' }); }],
    ['wrong required reference set', f => { f.handlerSubmission.referenceBindings = [{ assetId: 'wrong', title: 'wrong', role: 'ingredient' }]; }],
    ['changed prompt readback', f => mutateAtRead(f, () => { document.querySelector('[contenteditable]').textContent += ' changed'; })],
    ['unexpected reference chip', f => mutateAtRead(f, () => { document.querySelector('#chips').innerHTML = '<span data-chip-id="unexpected" data-asset-id="asset-unapproved" data-title="wrong">wrong</span>'; })],
    ['unreadable quote', f => mutateAtRead(f, () => { const open = window.openPanel; window.openPanel = () => { open(); document.querySelector('#panel p').textContent = '10 credits'; }; })],
    ['missing quote', f => mutateAtRead(f, () => { const open = window.openPanel; window.openPanel = () => { open(); document.querySelector('#panel p').remove(); }; })],
    ['unsupported model control', f => mutateAtRead(f, () => { const open = window.openPanel; window.openPanel = () => { open(); document.querySelector('#panel button').disabled = true; }; })],
    ['missing capability selection', f => mutateAtRead(f, () => { const open = window.openPanel; window.openPanel = () => { open(); document.querySelector('#panel button:nth-child(2)').removeAttribute('aria-pressed'); }; })],
    ['changed actual ratio', f => mutateAtRead(f, () => { document.querySelector('[aria-label="Settings trigger"]').textContent = 'Nano Banana Pro 9:16 x1'; })],
    ['unobservable reference slots', f => mutateAtRead(f, () => { document.querySelector('#slots').remove(); })],
    ['pending upload', f => mutateAtRead(f, () => { document.querySelector('#uploads').innerHTML = '<div data-pending-upload data-name="pending" data-status="uploading"></div>'; })],
    ['reset before common boundary', f => mutateAtRead(f, null, () => jobQueue.reset('during-readback'))],
    ['store create failure', f => { f.opStore.createBoundOperation = () => { throw new Error('store-create-failure'); }; }],
    ['elapsed quote/readback', f => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.now();
      mutateAtRead(f, null, () => vi.setSystemTime(now + 31_000), 2);
    }],
  ];
  for (const [name, arrange] of negatives) {
    it(`denies ${name} before invocation and consumption`, async () => {
      const f = await fixture();
      try {
        const initiallyConsumed = f.approvalChild.consumed;
        await arrange(f);
        const arrangedConsumed = f.approvalChild.consumed;
        await expect(dispatch(f)).rejects.toBeTruthy();
        expect(f.calls).toHaveLength(0);
        expect(f.approvalChild.consumed).toBe(arrangedConsumed || initiallyConsumed);
        expect(f.ledger.reserved).toBe(0);
        expect(f.opStore.isChildConsumed(f.approvalChild.id)).toBe(false);
        expect(f.opStore.listOperations()).toEqual([]);
      } finally { await f.page.close(); }
    });
  }
  for (const kind of ['callback-failure', 'reset-after-callback', 'reset-before-callback']) {
    it(`retains durable uncertainty/reservation for ${kind} and prevents stale publication`, async () => {
      const f = await fixture();
      try {
        f.approvalChild.maxCredits = 5;
        f.approvalChild.quoteTotal = 5;
        f.ledger.maxAuthorized = 5;
        await mutateAtRead(f, () => { const open = window.openPanel; window.openPanel = () => { open(); document.querySelector('#panel p').textContent = '5 credits total'; }; });
        const original = f.handlerSubmission.submit;
        f.handlerSubmission.submit = async info => {
          const result = await original(info);
          if (kind === 'callback-failure') throw new Error('callback-failure');
          jobQueue.reset('after-callback');
          return result;
        };
        if (kind === 'reset-before-callback') {
          const mark = f.opStore.markInvocationBoundary;
          f.opStore.markInvocationBoundary = id => { const record = mark(id); jobQueue.reset('before-callback'); return record; };
        }
        await expect(dispatch(f)).rejects.toBeTruthy();
        expect(f.calls).toHaveLength(kind === 'reset-before-callback' ? 0 : 1);
        expect(f.approvalChild.consumed).toBe(true);
        expect(f.ledger.reserved).toBe(5);
        expect(f.opStore.listOperations()[0].status).toBe('submission_unknown');
        expect(f.opStore.isChildConsumed(f.approvalChild.id)).toBe(true);
      } finally { await f.page.close(); }
    });
  }
  it('MCP execution-shaped arguments cannot select the internal local transport', async () => {
    const f = await fixture();
    try {
      const enabled = f.handlerSubmission;
      f.handlerSubmission = undefined;
      await expect(dispatch(f, { executionMode: 'local-fixture', _remoteSubmitFn: enabled.submit, _approvalChild: f.approvalChild, handlerSubmission: enabled })).rejects.toMatchObject({ code: 'MANUAL_VERIFICATION_REQUIRED' });
      expect(f.calls).toHaveLength(0);
      expect(f.approvalChild.consumed).toBe(false);
      expect(f.opStore.listOperations()).toEqual([]);
    } finally { await f.page.close(); }
  });
  it('dispatches video through the same observer/policy boundary with actual duration, quality and scaffolded prompt', async () => {
    const payload = { prompt: 'a quiet lake Camera move: pan. Style: natural.', model: 'Veo 3.1 - Fast', ratio: '16:9', duration: '4s', quality: '720p', quantity: 1, type: 'video' };
    const videoHtml = html.replaceAll('Nano Banana Pro', payload.model).replaceAll('1:1', '16:9')
      .replace('Veo 3.1 - Fast 16:9 x1</button>', 'Video 720p 4s 16:9 x1</button>')
      .replace('<button aria-pressed="true">Image</button><button>Video</button>', '<button>Image</button><button aria-pressed="true">Video</button>')
      .replace('<p>Generating', '<button aria-pressed="true">4s</button><button aria-pressed="true">720p</button><p>Generating');
    const f = await fixture(payload, videoHtml);
    try {
      const response = await withSession({ page: f.page, handlerSubmission: f.handlerSubmission }, () => handleToolCall('flow_generate_video', {
        prompt: 'a quiet lake', camera: 'pan', style: 'natural', model: payload.model, ratio: payload.ratio, duration: payload.duration, quality: payload.quality, confirm_generate: true,
      }));
      expect(JSON.parse(response.content[0].text).status).toBe('submitted');
      expect(f.calls).toHaveLength(1);
      expect(f.opStore.listOperations()[0].requested).toEqual(payload);
    } finally { await f.page.close(); }
  });
  for (const type of ['scene', 'character']) {
    it(`blocks confirmed native ${type} with an existing form before mutating it or claiming success`, async () => {
      const nativeHtml = html.replace('</body>', `<nav class="sidebar"><button aria-current="page">${type === 'scene' ? 'Scenes' : 'Characters'}</button></nav><textarea aria-label="Describe your ${type}">original native draft</textarea><button type="submit" aria-label="Create ${type}">Create</button></body>`);
      const f = await fixture(request, nativeHtml);
      try {
        await expect(withSession({ page: f.page, handlerSubmission: f.handlerSubmission }, () => handleToolCall(`flow_create_${type}`, {
          name: 'fixture', description: 'new native description', prompt: 'new native description', auto_confirm: true,
        }))).rejects.toMatchObject({ code: 'MANUAL_VERIFICATION_REQUIRED' });
        expect(await f.page.locator('textarea').inputValue()).toBe('original native draft');
        expect(f.calls).toHaveLength(0);
        expect(f.approvalChild.consumed).toBe(false);
      } finally { await f.page.close(); }
    });
  }
  it('denies submission when actual account control mismatches approved account despite unrelated asset label', async () => {
    const mismatchedHtml = html
      .replace('<span data-account-email="creator@example.com">creator@example.com</span>',
               '<div aria-label="Asset title: creator@example.com">Asset</div><button aria-label="Google Account: other@example.com">Avatar</button>');
    const f = await fixture(request, mismatchedHtml);
    try {
      await expect(dispatch(f)).rejects.toBeTruthy();
      expect(f.calls).toHaveLength(0);
      expect(f.approvalChild.consumed).toBe(false);
      expect(f.ledger.reserved).toBe(0);
      expect(f.opStore.isChildConsumed(f.approvalChild.id)).toBe(false);
      expect(f.opStore.listOperations()).toEqual([]);
    } finally { await f.page.close(); }
  });
  it('denies submission when account evidence is contradictory or ambiguous', async () => {
    const contradictoryHtml = html
      .replace('</body>', '<button aria-label="Google Account: other@example.com">Avatar</button></body>');
    const f = await fixture(request, contradictoryHtml);
    try {
      await expect(dispatch(f)).rejects.toBeTruthy();
      expect(f.calls).toHaveLength(0);
      expect(f.approvalChild.consumed).toBe(false);
      expect(f.ledger.reserved).toBe(0);
      expect(f.opStore.isChildConsumed(f.approvalChild.id)).toBe(false);
      expect(f.opStore.listOperations()).toEqual([]);
    } finally { await f.page.close(); }
  });
  it('denies submission when account label contains conflicting emails', async () => {
    const conflictingLabelHtml = html
      .replace('<span data-account-email="creator@example.com">creator@example.com</span>',
               '<button aria-label="Google Account: creator@example.com (other@example.com)">Avatar</button>');
    const f = await fixture(request, conflictingLabelHtml);
    try {
      await expect(dispatch(f)).rejects.toBeTruthy();
      expect(f.calls).toHaveLength(0);
      expect(f.approvalChild.consumed).toBe(false);
      expect(f.ledger.reserved).toBe(0);
      expect(f.opStore.isChildConsumed(f.approvalChild.id)).toBe(false);
      expect(f.opStore.listOperations()).toEqual([]);
    } finally { await f.page.close(); }
  });
  it('denies submission when data-account-email attribute is malformed', async () => {
    const malformedAttrHtml = html
      .replace('<span data-account-email="creator@example.com">creator@example.com</span>',
               '<span data-account-email="creator@example.com malformed">creator@example.com</span>');
    const f = await fixture(request, malformedAttrHtml);
    try {
      await expect(dispatch(f)).rejects.toBeTruthy();
      expect(f.calls).toHaveLength(0);
      expect(f.approvalChild.consumed).toBe(false);
      expect(f.ledger.reserved).toBe(0);
      expect(f.opStore.isChildConsumed(f.approvalChild.id)).toBe(false);
      expect(f.opStore.listOperations()).toEqual([]);
    } finally { await f.page.close(); }
  });
});

function mutateAtRead(f, domMutation, localMutation = null, targetRead = 1) {
  const content = f.page.content.bind(f.page);
  let reads = 0;
  f.page.content = async () => {
    if (++reads === targetRead) {
      if (domMutation) await f.page.evaluate(domMutation);
      localMutation?.();
    }
    return content();
  };
}
