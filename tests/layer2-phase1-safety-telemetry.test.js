import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAccountActive,
  clearAccountCooldown,
  detectSafetySignal,
  getAccountCooldown,
  getCooldownStorePath,
  tripAccountCooldown,
  UNUSUAL_ACTIVITY_COOLDOWN_SEC,
} from '../src/domain/account-circuit-breaker.js';
import { evaluateSubmissionPolicy } from '../src/domain/submission-policy.js';
import {
  createLiveAuthorization,
  extractBatchTelemetry,
  FLOW_RPC_CATALOG,
  observeVideoSubmission,
} from '../src/domain/live-submission.js';
import { handleFlowStatus } from '../src/tools/flow-status.js';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';
import { withUiTransaction } from '../src/browser/ui-transaction.js';
import { buildHandlerSubmissionContext } from '../src/domain/handler-submission-context.js';
import { executeDurableSubmission } from '../src/domain/submission-adapter.js';
import { jobQueue } from '../src/queue/job-queue.js';

describe('Layer 2 Phase 1A: Account Safety Circuit Breaker', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cb-test-'));
    vi.stubEnv('FLOW_HOME', tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('persists cooldown across restarts and enforces assertAccountActive fail-closed', () => {
    const t0 = 1_794_000_000_000;
    const state = tripAccountCooldown('Creator@Example.com', {
      durationSec: 1800,
      reason: 'unusual_activity',
      rpc: 'eb1hJf',
      details: 'PUBLIC_ERROR_UNUSUAL_ACTIVITY',
      home: tmpHome,
      now: t0,
    });
    expect(state.active).toBe(true);
    expect(state.accountKey).toBe('creator@example.com');
    expect(state.remainingSec).toBe(1800);

    // Simulate process restart by reading directly from disk with updated clock
    const loaded = getAccountCooldown('creator@example.com', { home: tmpHome, now: t0 + 60_000 });
    expect(loaded.active).toBe(true);
    expect(loaded.remainingSec).toBe(1740);
    expect(loaded.reason).toBe('unusual_activity');

    expect(() => assertAccountActive('creator@example.com', { home: tmpHome, now: t0 + 60_000 }))
      .toThrowError(/safety cooldown/i);

    // Expires cleanly past heldUntil
    const expired = getAccountCooldown('creator@example.com', { home: tmpHome, now: t0 + 1_800_001 });
    expect(expired.active).toBe(false);
    expect(() => assertAccountActive('creator@example.com', { home: tmpHome, now: t0 + 1_800_001 }))
      .not.toThrow();
  });

  it('maintains monotonicity so shorter holds cannot truncate longer active holds', () => {
    const t0 = 1_794_000_000_000;
    tripAccountCooldown('user@example.com', {
      durationSec: 1800,
      reason: 'unusual_activity',
      home: tmpHome,
      now: t0,
    });
    const second = tripAccountCooldown('user@example.com', {
      durationSec: 300,
      reason: 'rate_limit',
      home: tmpHome,
      now: t0 + 1000,
    });
    expect(second.remainingSec).toBe(1799);
    expect(second.reason).toBe('unusual_activity');
  });

  it('fails closed if cooldown store on disk is corrupt', () => {
    const file = getCooldownStorePath(tmpHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{corrupt json', 'utf8');

    expect(() => getAccountCooldown('user@example.com', { home: tmpHome })).toThrow();
    expect(() => assertAccountActive('user@example.com', { home: tmpHome })).toThrow();
  });

  it('clears cooldown explicitly on clearAccountCooldown', () => {
    tripAccountCooldown('user@example.com', { durationSec: 900, home: tmpHome });
    expect(getAccountCooldown('user@example.com', { home: tmpHome }).active).toBe(true);
    const cleared = clearAccountCooldown('user@example.com', { home: tmpHome });
    expect(cleared.cleared).toBe(true);
    expect(getAccountCooldown('user@example.com', { home: tmpHome }).active).toBe(false);
  });

  it('detects unusual activity, HTTP 429, and CAPTCHA challenge iframes accurately without false positives', () => {
    expect(detectSafetySignal({ status: 200, body: 'normal ok response' }).tripped).toBe(false);
    expect(detectSafetySignal({
      status: 200,
      html: '<html><script src="https://www.google.com/recaptcha/enterprise.js"></script><div>Composer</div></html>',
    }).tripped).toBe(false);

    const unusual = detectSafetySignal({ status: 200, body: '["er", "PUBLIC_ERROR_UNUSUAL_ACTIVITY"]' });
    expect(unusual).toMatchObject({ tripped: true, reason: 'unusual_activity', durationSec: UNUSUAL_ACTIVITY_COOLDOWN_SEC });

    const rateLimit = detectSafetySignal({ status: 429, body: 'Too Many Requests' });
    expect(rateLimit).toMatchObject({ tripped: true, reason: 'rate_limit' });

    const captcha = detectSafetySignal({
      status: 200,
      html: '<iframe src="https://www.google.com/recaptcha/enterprise/bframe?hl=en"></iframe>',
    });
    expect(captcha).toMatchObject({ tripped: true, reason: 'captcha_gate' });
  });

  it('integrates into evaluateSubmissionPolicy and still permits read-only flow_status', async () => {
    const now = Date.now();
    tripAccountCooldown('creator@example.com', { durationSec: 1200, reason: 'unusual_activity', home: tmpHome, now });

    const verdict = evaluateSubmissionPolicy({
      account: { verified: true, expected: 'creator@example.com', observed: 'creator@example.com', observedAt: now },
      project: { requiredId: 'proj-1', observedId: 'proj-1' },
      verification: {
        account: { status: 'verified', observedAt: now, origin: 'dom' },
        settings: { status: 'verified', observedAt: now, origin: 'dom' },
        quote: { status: 'verified', observedAt: now, origin: 'dom' },
        capabilities: { status: 'verified', observedAt: now, origin: 'dom' },
      },
      quote: { total: 1, unit: 'total', quantity: 1, model: 'Veo 3.1 - Fast', feature: 'video', observedAt: now, expiresAt: now + 60_000 },
      approval: {
        id: 'appr-1',
        nonce: 'nonce-1',
        requestDigest: 'deg-1',
        accountKey: 'creator@example.com',
        projectId: 'proj-1',
        model: 'Veo 3.1 - Fast',
        quoteTotal: 1,
        maxCredits: 10,
        expiresAt: now + 60_000,
        consumed: false,
      },
      requestDigest: 'deg-1',
      capabilities: { supported: true, model: 'Veo 3.1 - Fast', feature: 'video', observedAt: now },
      cooldownHome: tmpHome,
      now,
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reasons).toContain('account-cooldown-active');

    // Read-only flow_status continues working cleanly and exposes accountCooldown
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', 'creator@example.com');
    const status = await handleFlowStatus();
    expect(status.accountCooldown).toMatchObject({
      active: true,
      accountKey: 'creator@example.com',
      reason: 'unusual_activity',
    });
  });
});

describe('Layer 2 Phase 1B: Passive Video RPC Telemetry & Live Cooldown Integration', { timeout: 30000 }, () => {
  it('extractBatchTelemetry extracts operationIds, mediaIds, and video URLs from batchexecute envelopes', () => {
    const opUuid = '11111111-2222-4333-8444-555555555555';
    const projUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const sceneUuid = '99999999-8888-4777-8666-555555555555';
    const mediaUuid = '77777777-6666-4555-8444-333333333333';

    const innerOp = JSON.stringify([null, 50, [[opUuid, projUuid, sceneUuid, 'PENDING']]]);
    const innerT2v = JSON.stringify([null, null, null, [[mediaUuid, projUuid, opUuid, 'PENDING']], 'https://flow-content.google/video/' + mediaUuid]);
    const envelope = ")]}'\n123\n" + JSON.stringify([
      ['wrb.fr', FLOW_RPC_CATALOG.GEN_VIDEO_I2V, innerOp],
      ['wrb.fr', FLOW_RPC_CATALOG.GEN_VIDEO_T2V, innerT2v],
    ]);

    const telemetry = extractBatchTelemetry(envelope);
    expect(telemetry.rpcIds).toEqual([FLOW_RPC_CATALOG.GEN_VIDEO_I2V, FLOW_RPC_CATALOG.GEN_VIDEO_T2V]);
    expect(telemetry.operationIds).toContain(opUuid);
    expect(telemetry.mediaIds).toContain(mediaUuid);
    expect(telemetry.urls).toContain('https://flow-content.google/video/' + mediaUuid);
    expect(telemetry.hasErrorFrame).toBe(false);
  });

  it('observeVideoSubmission recognizes all 4 video RPCs and ignores unrelated RPCs', async () => {
    const opUuid = '12345678-1234-4123-8123-1234567890ab';
    for (const rpcId of [
      FLOW_RPC_CATALOG.GEN_VIDEO_I2V,
      FLOW_RPC_CATALOG.GEN_VIDEO_T2V,
      FLOW_RPC_CATALOG.GEN_VIDEO_FIRST_LAST,
      FLOW_RPC_CATALOG.GEN_VIDEO_REFS,
    ]) {
      const response = (id) => ({
        url: () => `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${id}`,
        request: () => ({ method: () => 'POST', postData: () => new URLSearchParams({ 'f.req': 'camera dollies forward' }).toString() }),
        finished: async () => {},
        status: () => 200,
        ok: () => true,
        text: async () => JSON.stringify([['wrb.fr', id, JSON.stringify([null, 50, [[opUuid, 'proj', 'scene', 'PENDING']]])]]),
      });

      const observed = await observeVideoSubmission({
        waitForResponse: async (predicate) => {
          expect(predicate(response('WuwhI'))).toBe(false);
          expect(predicate(response(rpcId))).toBe(true);
          return response(rpcId);
        },
      }, 'camera dollies forward');

      expect(observed.acknowledged).toBe(true);
      expect(observed.rpc).toBe(rpcId);
      expect(observed.telemetry.operationIds).toContain(opUuid);
    }
  });

  it('observeVideoSubmission trips circuit breaker on PUBLIC_ERROR_UNUSUAL_ACTIVITY and persists cooldown', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-vid-cb-'));
    vi.stubEnv('FLOW_HOME', tmpHome);
    try {
      const badResp = {
        url: () => 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=eb1hJf',
        request: () => ({ method: () => 'POST', postData: () => new URLSearchParams({ 'f.req': 'a knight riding' }).toString() }),
        finished: async () => {},
        status: () => 200,
        ok: () => true,
        text: async () => '["er", "PUBLIC_ERROR_UNUSUAL_ACTIVITY"]',
      };

      const observed = await observeVideoSubmission({
        waitForResponse: async (predicate) => {
          expect(predicate(badResp)).toBe(true);
          return badResp;
        },
      }, 'a knight riding', { expectedAccount: 'director@example.com' });

      expect(observed.acknowledged).toBe(false);
      expect(observed.safetyTripped).toBe(true);
      expect(getAccountCooldown('director@example.com', { home: tmpHome }).active).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('observeVideoSubmission falls back to independent DOM video tile detection when RPC IDs change', async () => {
    const res = await observeVideoSubmission({
      url: () => 'https://flow.google.com/project/test',
      evaluate: async () => ['old-vid-tile'],
      waitForResponse: async () => { throw new Error('RPC timeout or changed'); },
      waitForFunction: async (fn, args) => {
        expect(args.ids).toEqual(['old-vid-tile']);
        expect(String(fn)).toContain('flow-video-tile');
        return {};
      },
    }, 'cinematic drone shot');
    expect(res).toMatchObject({ acknowledged: true, source: 'new-rendered-project-video' });
  });

  describe('Live Browser Integration with Circuit Breaker', () => {
    let page;
    let tmpHome;
    const videoPayload = {
      prompt: 'waves crash slowly on rocks',
      model: 'Veo 3.1 - Fast',
      ratio: '16:9',
      quantity: 1,
      type: 'video',
    };
    const html = `<!doctype html><meta charset="utf-8"><body>
      <span data-account-email="director@example.com">director@example.com</span>
      <div id="composer" data-account="director@example.com" data-project="cb-proj">
        <div contenteditable="true">waves crash slowly on rocks</div>
        <div id="chips"></div><div id="slots"></div><div id="uploads"></div>
        <button aria-label="Settings trigger" onclick="openPanel()">Veo 3.1 - Fast 16:9 x1</button>
        <button aria-pressed="false">Agent</button>
        <button aria-label="Generate" onclick="window.clicks=(window.clicks||0)+1;fetch('/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=YhhmEf',{method:'POST',body:new URLSearchParams({'f.req':'waves crash slowly on rocks'})})">Generate</button>
      </div>
      <div role="dialog" id="panel">
        <button class="mat-mdc-menu-trigger">Veo 3.1 - Fast arrow_drop_down</button>
        <button>Image</button><button aria-pressed="true">Video</button>
        <button aria-pressed="true">16:9</button><button aria-pressed="true">x1</button>
        <p>Generating will use 2 credits total</p>
      </div>
      <script>
        const panel=document.getElementById('panel');const markup=panel.innerHTML;
        function openPanel(){panel.innerHTML=markup;panel.style.display='block'}
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.innerHTML='';panel.style.display='none'}});
      </script></body>`;

    beforeEach(async () => {
      jobQueue.reset();
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-live-cb-'));
      vi.stubEnv('FLOW_EXPECTED_ACCOUNT', 'director@example.com');
      vi.stubEnv('FLOW_HOME', tmpHome);
      const browser = await w00LaunchBrowser();
      page = await browser.newPage();
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.includes('/_/AiSandboxAngularFrontend/data/batchexecute')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: ")]}'\n10\n[[\"wrb.fr\",\"YhhmEf\",\"[null,null,null,[[\\\"11111111-1111-4111-8111-111111111111\\\",\\\"cb-proj\\\",\\\"22222222-2222-4222-8222-222222222222\\\",\\\"PENDING\\\"]]]\"]]",
          });
        }
        return route.fulfill({ contentType: 'text/html', body: html });
      });
      await page.goto('https://flow.google.com/project/cb-proj');
      page.waitForTimeout = async () => {};
    });

    afterEach(async () => {
      await page.close();
      vi.unstubAllEnvs();
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    afterAll(w00CloseBrowser);

    it('observes YhhmEf video RPC and captures operationId telemetry on valid live submission', async () => {
      await withUiTransaction(async ({ epoch }) => {
        const ctx = await buildHandlerSubmissionContext({
          page,
          epoch,
          requestPayload: videoPayload,
          inputLocator: page.locator('[contenteditable]'),
          liveAuthorization: await createLiveAuthorization({ page, confirmed: true, maxCredits: 10 }),
        });
        const out = await executeDurableSubmission({ page, epoch, ...ctx });
        expect(out.status).toBe('submitted');
        expect(out.result.remoteStatus).toBe('pending');
        expect(out.result.submissionAcknowledged).toBe(true);
        expect(out.result.rpc).toBe('YhhmEf');
        expect(out.result.telemetry.operationIds).toContain('22222222-2222-4222-8222-222222222222');
      });
    });

    it('blocks submission BEFORE clicking or spending credits when account circuit breaker is active', async () => {
      tripAccountCooldown('director@example.com', { durationSec: 1800, reason: 'unusual_activity', home: tmpHome });
      await expect(createLiveAuthorization({ page, confirmed: true, maxCredits: 10 }))
        .rejects.toMatchObject({ code: 'ACCOUNT_COOLDOWN_ACTIVE' });
      expect(await page.evaluate(() => window.clicks || 0)).toBe(0);
    });
  });
});
