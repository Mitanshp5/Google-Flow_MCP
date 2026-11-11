import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withSession } from '../src/browser/session-scope.js';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';
import { handleToolCall } from '../src/index.js';
import { jobQueue } from '../src/queue/job-queue.js';
import {
  clearAccountCooldown,
  getAccountCooldown,
  tripAccountCooldown,
} from '../src/domain/account-circuit-breaker.js';
import { FLOW_RPC_CATALOG } from '../src/domain/live-submission.js';
import { getRuntimeRoot } from '../src/storage/runtime-store.js';

function makeVideoComposerHtml({
  model = 'Veo 3.1 - Fast',
  account = 'director@example.com',
  projectId = 'l2-proj',
  creditCost = 2,
} = {}) {
  return `<!doctype html><meta charset="utf-8"><body>
    <span data-account-email="${account}">${account}</span>
    <div id="composer" data-account="${account}" data-project="${projectId}">
      <div contenteditable="true" aria-label="Video prompt"></div>
      <div id="chips"></div>
      <div id="slots"></div>
      <div id="uploads"></div>
      <button aria-label="Settings trigger" onclick="openPanel()">Video 720p 4s 16:9 x1</button>
      <button aria-pressed="false">Agent</button>
      <button aria-label="Generate" onclick="
        window.__clicks = (window.__clicks || 0) + 1;
        var el = document.querySelector('[contenteditable]');
        var txt = (el && (el.innerText || el.textContent)) || '';
        fetch('/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=YhhmEf', {
          method: 'POST',
          body: new URLSearchParams({ 'f.req': JSON.stringify([txt]) })
        });
      ">Generate</button>
    </div>
    <div role="dialog" id="panel">
      <button class="mat-mdc-menu-trigger">${model} arrow_drop_down</button>
      <button>Image</button>
      <button aria-pressed="true">Video</button>
      <button aria-pressed="true">16:9</button>
      <button aria-pressed="true">x1</button>
      <button aria-pressed="true">4s</button>
      <button aria-pressed="true">720p</button>
      <p>Generating will use ${creditCost} credits total</p>
    </div>
    <script>
      const panel = document.getElementById('panel');
      const markup = panel.innerHTML;
      function openPanel() { panel.innerHTML = markup; panel.style.display = 'block'; }
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { panel.innerHTML = ''; panel.style.display = 'none'; }
      });
    </script>
  </body>`;
}

async function callJson(name, args) {
  const res = await handleToolCall(name, args);
  return JSON.parse(res.content[0].text);
}

describe('Layer 2 End-to-End Integration: Circuit Breaker, RPC Telemetry, Prompt Gating & Scene Chaining', { timeout: 45000 }, () => {
  const previousFlowHome = process.env.FLOW_HOME;
  const previousExpectedAccount = process.env.FLOW_EXPECTED_ACCOUNT;
  let tmpHome;
  let page;
  let rpcResponder;

  async function mountPage(html) {
    if (page) {
      await page.close();
      page = null;
    }
    const browser = await w00LaunchBrowser();
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('/_/AiSandboxAngularFrontend/data/batchexecute')) {
        const res = rpcResponder ? rpcResponder(route.request()) : {
          status: 200,
          contentType: 'application/json',
          body: ")]}'\n10\n[]",
        };
        return route.fulfill(res);
      }
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('https://flow.google.com/project/l2-proj');
    page.waitForTimeout = async () => {};
    return page;
  }

  beforeEach(() => {
    jobQueue.reset();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-l2-e2e-'));
    vi.stubEnv('FLOW_HOME', tmpHome);
    vi.stubEnv('FLOW_EXPECTED_ACCOUNT', 'director@example.com');
    rpcResponder = null;
  });

  afterEach(async () => {
    jobQueue.reset();
    if (page) {
      await page.close();
      page = null;
    }
    vi.unstubAllEnvs();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  afterAll(async () => {
    if (previousFlowHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = previousFlowHome;
    if (previousExpectedAccount === undefined) delete process.env.FLOW_EXPECTED_ACCOUNT;
    else process.env.FLOW_EXPECTED_ACCOUNT = previousExpectedAccount;
    await w00CloseBrowser();
  });

  describe('1. flow_generate_video -> flow_generate_confirm Commit Path (Circuit Breaker + YhhmEf Telemetry)', () => {
    it('blocks flow_generate_confirm before clicking when cooldown is active while keeping flow_status operational', async () => {
      await mountPage(makeVideoComposerHtml({ model: 'Veo 3.1 - Fast' }));

      const prepared = await withSession({ page }, () => callJson('flow_generate_video', {
        prompt: 'Detective Vance whispers into his wrist radio',
        subject: 'Detective Vance',
        setting: 'Rain-slicked back alley at night',
        camera: 'slow push-in',
        style: 'neo-noir film grain',
        model: 'Veo 3.1 - Fast',
        ratio: '16:9',
        duration: '4s',
        quality: '720p',
        audio: {
          sfx: 'steady rain pattering on asphalt',
          allowMusic: false,
          allowVoice: true,
          voiceProfiles: [{ name: 'Vance', voiceDescription: 'low gravelly baritone' }],
        },
        negative: 'subtitles, watermark',
      }));

      expect(prepared.status).toBe('ready_for_confirmation');
      expect(prepared.prompt).toContain('Character voices: Vance: low gravelly baritone.');
      expect(prepared.prompt).toContain('SFX: steady rain pattering on asphalt.');
      expect(prepared.prompt).toContain('Audio: no background music.');
      expect(prepared.prompt).toContain('Negative: subtitles, watermark.');

      tripAccountCooldown('director@example.com', {
        durationSec: 1800,
        reason: 'unusual_activity',
        details: 'MANUAL_TEST_HOLD',
        home: tmpHome,
      });

      await expect(
        withSession({ page }, () => handleToolCall('flow_generate_confirm', {
          job_id: prepared.jobId,
          max_credits: 10,
          wait_ms: 1000,
        })),
      ).rejects.toMatchObject({ code: 'ACCOUNT_COOLDOWN_ACTIVE' });

      expect(await page.evaluate(() => window.__clicks || 0)).toBe(0);

      // Read-only status continues to succeed and reports the active cooldown
      const status = await withSession({ page }, () => callJson('flow_status', {}));
      expect(status.browser).toBe(true);
      expect(status.account).toBe('director@example.com');
      expect(status.accountCooldown).toMatchObject({
        active: true,
        accountKey: 'director@example.com',
        reason: 'unusual_activity',
      });
    });

    it('captures YhhmEf RPC telemetry (operationIds + mediaIds) on valid confirm and trips cooldown on PUBLIC_ERROR_UNUSUAL_ACTIVITY', async () => {
      await mountPage(makeVideoComposerHtml({ model: 'Veo 3.1 - Fast' }));

      const opUuid = '33333333-3333-4333-8333-333333333333';
      const mediaUuid = '44444444-4444-4444-8444-444444444444';
      const innerT2v = JSON.stringify([null, null, null, [[mediaUuid, 'l2-proj', opUuid, 'PENDING']]]);
      rpcResponder = () => ({
        status: 200,
        contentType: 'application/json',
        body: `)]}'\n10\n${JSON.stringify([['wrb.fr', FLOW_RPC_CATALOG.GEN_VIDEO_T2V, innerT2v]])}`,
      });

      const prep1 = await withSession({ page }, () => callJson('flow_generate_video', {
        prompt: 'Lantern sways in wind',
        model: 'Veo 3.1 - Fast',
        ratio: '16:9',
        duration: '4s',
        quality: '720p',
      }));
      expect(prep1.status).toBe('ready_for_confirmation');

      const confirm1 = await withSession({ page }, () => callJson('flow_generate_confirm', {
        job_id: prep1.jobId,
        max_credits: 10,
        wait_ms: 1000,
      }));
      expect(confirm1.status).toBe('submitted');
      expect(confirm1.submissionAcknowledged).toBe(true);
      expect(confirm1.rpc).toBe('YhhmEf');
      expect(confirm1.telemetry.operationIds).toContain(opUuid);
      expect(confirm1.telemetry.mediaIds).toContain(mediaUuid);

      // Next request encounters PUBLIC_ERROR_UNUSUAL_ACTIVITY in batchexecute response
      rpcResponder = () => ({
        status: 200,
        contentType: 'application/json',
        body: '["er", "PUBLIC_ERROR_UNUSUAL_ACTIVITY"]',
      });

      const prep2 = await withSession({ page }, () => callJson('flow_generate_video', {
        prompt: 'Storm clouds gather over canyon',
        model: 'Veo 3.1 - Fast',
        ratio: '16:9',
        duration: '4s',
        quality: '720p',
      }));
      expect(prep2.status).toBe('ready_for_confirmation');

      const confirm2 = await withSession({ page }, () => callJson('flow_generate_confirm', {
        job_id: prep2.jobId,
        max_credits: 10,
        wait_ms: 1000,
      }));
      expect(confirm2).toMatchObject({
        status: 'blocked',
        reason: 'unusual_activity',
        safetyTripped: true,
        clicked: true,
        remoteStatus: 'blocked',
        submissionAcknowledged: false,
      });

      const persistedCooldown = getAccountCooldown('director@example.com', { home: tmpHome });
      expect(persistedCooldown.active).toBe(true);
      expect(persistedCooldown.reason).toBe('unusual_activity');

      // Follow-up confirmed submission attempt is blocked before clicking
      const clicksBeforeBlockedAttempt = await page.evaluate(() => window.__clicks || 0);
      await expect(
        withSession({ page }, () => handleToolCall('flow_generate_video', {
          prompt: 'Third clip should be halted',
          model: 'Veo 3.1 - Fast',
          ratio: '16:9',
          duration: '4s',
          quality: '720p',
          confirm_generate: true,
        })),
      ).rejects.toMatchObject({ code: 'ACCOUNT_COOLDOWN_ACTIVE' });
      expect(await page.evaluate(() => window.__clicks || 0)).toBe(clicksBeforeBlockedAttempt);

      clearAccountCooldown('director@example.com', { home: tmpHome });
    });
  });

  describe('2. flow_generate_video Selective Model-Aware Audio Gating via MCP Dispatch', () => {
    const sharedAudio = {
      sfx: 'distant thunder roll',
      ambient: 'quiet library room tone',
      allowMusic: false,
      allowVoice: true,
      voiceProfiles: [{ name: 'Elena', voiceDescription: 'calm alto' }],
    };

    it('strips experimental audio tags for non-Veo models (Omni 1.1 Flash) unless forced', async () => {
      await mountPage(makeVideoComposerHtml({ model: 'Omni 1.1 Flash' }));

      const omniPrepared = await withSession({ page }, () => callJson('flow_generate_video', {
        prompt: 'Elena whispers a secret over the desk',
        subject: 'Dr. Elena Vance',
        setting: 'Candlelit archive room',
        camera: 'slow dolly',
        style: 'warm tungsten',
        model: 'Omni 1.1 Flash',
        ratio: '16:9',
        duration: '4s',
        quality: '720p',
        audio: sharedAudio,
        include_standard_negative: true,
      }));

      expect(omniPrepared.status).toBe('ready_for_confirmation');
      expect(omniPrepared.model_used).toBe('Omni 1.1 Flash');
      expect(omniPrepared.prompt).toContain('Dr. Elena Vance.');
      expect(omniPrepared.prompt).toContain('Setting: Candlelit archive room.');
      expect(omniPrepared.prompt).toContain('Camera move: slow dolly.');
      expect(omniPrepared.prompt).toContain('Negative: subtitles, captions');
      expect(omniPrepared.prompt).not.toContain('Character voices:');
      expect(omniPrepared.prompt).not.toContain('SFX:');
      expect(omniPrepared.prompt).not.toContain('Audio:');
    });

    it('permits prepare-only workflow with cooldown warning while blocking confirm_generate=true', async () => {
      tripAccountCooldown('director@example.com', {
        durationSec: 600,
        reason: 'rate_limit',
        home: tmpHome,
      });

      await mountPage(makeVideoComposerHtml({ model: 'Veo 3.1 - Fast' }));
      const preparedWhileCooled = await withSession({ page }, () => callJson('flow_generate_video', {
        prompt: 'Elena whispers while examining amber slides',
        model: 'Veo 3.1 - Fast',
        ratio: '16:9',
        duration: '4s',
        quality: '720p',
        audio: sharedAudio,
      }));

      expect(preparedWhileCooled.status).toBe('ready_for_confirmation');
      expect(preparedWhileCooled.prompt).toContain('Character voices: Elena: calm alto.');
      expect(preparedWhileCooled.prompt).toContain('SFX: distant thunder roll.');
      expect(preparedWhileCooled.accountCooldown).toMatchObject({
        active: true,
        reason: 'rate_limit',
      });
      expect(preparedWhileCooled.qc_warnings.some((w) => /safety cooldown/i.test(w))).toBe(true);

      await expect(
        withSession({ page }, () => handleToolCall('flow_generate_video', {
          prompt: 'Blocked confirm attempt during active rate_limit cooldown',
          model: 'Veo 3.1 - Fast',
          ratio: '16:9',
          duration: '4s',
          quality: '720p',
          confirm_generate: true,
        })),
      ).rejects.toMatchObject({ code: 'ACCOUNT_COOLDOWN_ACTIVE' });
      expect(await page.evaluate(() => window.__clicks || 0)).toBe(0);
    });
  });

  describe('3. Script DAG Scene Chaining End-to-End via flow_script_* MCP Tools', () => {
    const chainScriptSpec = {
      scriptId: 'chain_e2e_v1',
      binding: { accountKey: 'director@example.com', projectId: 'l2-proj' },
      policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
      governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
      brief: { title: 'Continuous Corridor Sequence', aspectRatio: '16:9', fps: 24, targetDurationSec: 16 },
      bible: {
        characters: [
          {
            id: 'elena',
            name: 'Dr. Elena Vance',
            entityType: 'character',
            voiceDescription: 'steady measured alto',
            prompt: 'Elena Vance in damp trenchcoat',
          },
        ],
        locations: [
          { id: 'corridor', name: 'Substation Corridor', entityType: 'location', prompt: 'Concrete corridor' },
          { id: 'rooftop', name: 'Helipad Roof', entityType: 'location', prompt: 'Rainy rooftop' },
        ],
        props: [
          { id: 'keycard', name: 'Brass Keycard', entityType: 'visual_asset', prompt: 'Scratched brass keycard' },
        ],
      },
      scenes: [
        { id: 'sc1', title: 'Corridor Breach', locationId: 'corridor' },
        { id: 'sc2', title: 'Rooftop Extraction', locationId: 'rooftop' },
      ],
      shots: [
        {
          id: 'sh1',
          sceneId: 'sc1',
          chainType: 'ROOT',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
          entities: { characters: ['elena'], props: ['keycard'] },
          prompt: 'Elena approaches the bulkhead door holding the brass keycard',
          expected_state_after: { props: { keycard: { holder: 'elena', state: 'ready' } } },
        },
        {
          id: 'sh2',
          sceneId: 'sc1',
          chainType: 'CONTINUATION',
          parentShotId: 'sh1',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
          entities: { characters: ['elena'], props: ['keycard'] },
          prompt: 'Elena swipes the brass keycard and pulls the bulkhead open',
          continuity: {
            startFrameSource: 'sh1.lastFrame',
            transitionPrompt: 'Continue Elena hand motion straight to card reader',
            verifiedContinuity: false,
          },
          expected_state_before: { props: { keycard: { holder: 'elena', state: 'ready' } } },
          expected_state_after: { props: { keycard: { holder: 'elena', state: 'used' } } },
        },
        {
          id: 'sh3',
          sceneId: 'sc1',
          chainType: 'CONTINUATION',
          parentShotId: 'sh2',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
          entities: { characters: ['elena'], props: ['keycard'] },
          prompt: 'Elena slips through the bulkhead into steam',
          continuity: {
            startFrameSource: 'sh2.lastFrame',
            transitionPrompt: 'Step smoothly through doorway without cut',
            verifiedContinuity: true,
          },
          expected_state_before: { props: { keycard: { holder: 'elena', state: 'used' } } },
        },
        {
          id: 'sh4',
          sceneId: 'sc2',
          chainType: 'ROOT',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
          entities: { characters: ['elena'] },
          prompt: 'Wide establishing shot on rainy helipad rooftop',
        },
      ],
    };

    it('tracks sceneChains through create -> review -> update with continuity-aware selective invalidation', async () => {
      // Ensure runtime root aligns with tmpHome
      expect(getRuntimeRoot()).toBe(tmpHome);

      const created = await callJson('flow_script_create', chainScriptSpec);
      expect(created.scriptId).toBe('chain_e2e_v1');
      expect(created.revision).toBe(1);

      let rev = created.revision;
      let nodeStates = created.nodeStates;

      const nodesToApprove = [
        'char:elena',
        'loc:corridor',
        'loc:rooftop',
        'prop:keycard',
        'scene:sc1',
        'scene:sc2',
        'shot:sh1',
        'shot:sh2',
        'shot:sh3',
        'shot:sh4',
      ];
      for (const nodeId of nodesToApprove) {
        const reviewed = await callJson('flow_script_review', {
          scriptId: 'chain_e2e_v1',
          expectedRevision: rev,
          nodeId,
          nodeDigest: nodeStates[nodeId].nodeDigest,
          reviewer: 'director@example.com',
          decision: 'approve',
        });
        rev = reviewed.story.revision;
        nodeStates = reviewed.story.nodeStates;
      }

      const statusBeforeVerify = await callJson('flow_script_status', { scriptId: 'chain_e2e_v1' });
      expect(statusBeforeVerify.sceneChains).toHaveLength(2);
      expect(statusBeforeVerify.sceneChains[0]).toMatchObject({
        segmentIndex: 0,
        isChain: true,
        verifiedChain: false,
        shotIds: ['sh1', 'sh2', 'sh3'],
      });
      expect(statusBeforeVerify.sceneChains[1]).toMatchObject({
        segmentIndex: 1,
        isChain: false,
        verifiedChain: false,
        shotIds: ['sh4'],
      });
      const sh2Summary = statusBeforeVerify.shotsSummary.find((s) => s.shotId === 'sh2');
      expect(sh2Summary).toMatchObject({
        chainType: 'CONTINUATION',
        parentShotId: 'sh1',
        verifiedContinuity: false,
      });

      // 1. Metadata-only toggle of continuity.verifiedContinuity MUST NOT invalidate downstream shots
      const verifiedPatchShots = chainScriptSpec.shots.map((s) => (
        s.id === 'sh2'
          ? { ...s, continuity: { ...s.continuity, verifiedContinuity: true } }
          : s
      ));
      const afterVerifyUpdate = await callJson('flow_script_update', {
        scriptId: 'chain_e2e_v1',
        expectedRevision: rev,
        patch: { shots: verifiedPatchShots },
      });
      rev = afterVerifyUpdate.revision;

      expect(afterVerifyUpdate.invalidations.invalidatedNodeIds).toEqual([]);
      expect(afterVerifyUpdate.invalidations.affectedShots).toEqual([]);
      expect(afterVerifyUpdate.nodeStates['shot:sh3'].status).toBe('approved');
      expect(afterVerifyUpdate.nodeStates['shot:sh4'].status).toBe('approved');

      const statusAfterVerify = await callJson('flow_script_status', { scriptId: 'chain_e2e_v1' });
      expect(statusAfterVerify.sceneChains[0].verifiedChain).toBe(true);
      expect(statusAfterVerify.shotsSummary.find((s) => s.shotId === 'sh2').verifiedContinuity).toBe(true);

      // 2. Semantic continuity change on sh2 (transitionPrompt) MUST invalidate sh2 + downstream sh3, leaving sh1 & sh4 approved
      const editedTransitionShots = verifiedPatchShots.map((s) => (
        s.id === 'sh2'
          ? {
              ...s,
              continuity: {
                ...s.continuity,
                transitionPrompt: 'Quick rack-focus onto card reader LED as door unlatches',
              },
            }
          : s
      ));
      const afterTransitionEdit = await callJson('flow_script_update', {
        scriptId: 'chain_e2e_v1',
        expectedRevision: rev,
        patch: { shots: editedTransitionShots },
      });

      expect(afterTransitionEdit.invalidations.affectedShots).toContain('sh2');
      expect(afterTransitionEdit.invalidations.affectedShots).toContain('sh3');
      expect(afterTransitionEdit.invalidations.affectedShots).not.toContain('sh1');
      expect(afterTransitionEdit.invalidations.affectedShots).not.toContain('sh4');
      expect(afterTransitionEdit.nodeStates['shot:sh1'].status).toBe('approved');
      expect(afterTransitionEdit.nodeStates['shot:sh2'].status).toBe('stale');
      expect(afterTransitionEdit.nodeStates['shot:sh3'].status).toBe('stale');
      expect(afterTransitionEdit.nodeStates['shot:sh4'].status).toBe('approved');
    });
  });
});
