// Explicit image/video confirmation is the authorization boundary. Evidence is
// still collected by the common handler observers and checked by common policy.
import { get, getFlowHome } from '../utils/config.js';
import { extractProjectId } from '../navigation/project-navigator.js';
import { findActionButton, GENERATE_BUTTON_SELECTORS } from '../browser/safe-actions.js';
import { assertUiCurrent } from '../browser/ui-transaction.js';
import { createOperationStore, mintChildApproval } from './operations.js';
import { digestRequest } from './contracts.js';
import { FlowError } from '../utils/errors.js';
import { getSessionScope } from '../browser/session-scope.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { projectCreditCap, reserveProjectCredits } from '../utils/project-credit-budget.js';
import { assertAccountActive, detectSafetySignal, tripAccountCooldown } from './account-circuit-breaker.js';

// Known Google Flow batchexecute RPC catalog (passively observed only — never invoked directly).
export const FLOW_RPC_CATALOG = Object.freeze({
  GEN_IMAGE: 'ogiZ0b',            // Image generation (Imagen 3 / Nano Banana)
  GEN_VIDEO_I2V: 'eb1hJf',        // First-frame I2V (abra_i2v_*)
  GEN_VIDEO_T2V: 'YhhmEf',        // Text-to-video (abra_t2v_*)
  GEN_VIDEO_FIRST_LAST: 'nprQif', // First + Last frames (omni_flash_i2v_*_first_last)
  GEN_VIDEO_REFS: 'MZZa6b',       // Reference-to-video / ingredients (abra_r2v_*)
  OPERATION_POLL: 'jwpduf',       // Generation operation status poll
  CREATE_PROJECT: 'jHPbke',       // Project creation
  PROJECT_MEDIA: 'Zzl0ze',        // Project media gallery listing
  MEDIA_DETAILS: 'as29s',         // Media item details & signed CDN links
  UPLOAD_IMAGE: 'maseQ',          // Base64 image upload
  UPSCALE_IMAGE: 'SPrCad',        // 2K / 4K image upsampling
});

export const VIDEO_GENERATION_RPCS = Object.freeze([
  FLOW_RPC_CATALOG.GEN_VIDEO_I2V,
  FLOW_RPC_CATALOG.GEN_VIDEO_T2V,
  FLOW_RPC_CATALOG.GEN_VIDEO_FIRST_LAST,
  FLOW_RPC_CATALOG.GEN_VIDEO_REFS,
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractBatchTelemetry(body) {
  const result = {
    rpcIds: [],
    operationIds: [],
    mediaIds: [],
    urls: [],
    hasErrorFrame: false,
  };
  if (typeof body !== 'string' || !body.trim()) return result;

  const rpcSet = new Set();
  const opSet = new Set();
  const mediaSet = new Set();
  const urlSet = new Set();

  // Check raw error markers
  if (/\["er",/.test(body)) {
    result.hasErrorFrame = true;
  }

  const walkNode = (node, depth = 0) => {
    if (depth > 10 || node == null) return;
    if (typeof node === 'string') {
      if (node.startsWith('https://flow-content.google/image/') || node.startsWith('https://flow-content.google/video/')) {
        urlSet.add(node);
        const match = node.match(/flow-content\.google\/(?:image|video)\/([^/?]+)/i);
        if (match && match[1]) mediaSet.add(match[1]);
      } else if (node.trim().startsWith('[') || node.trim().startsWith('{')) {
        try { walkNode(JSON.parse(node), depth + 1); } catch { /* ignore */ }
      }
      return;
    }
    if (Array.isArray(node)) {
      if (node[0] === 'wrb.fr' && typeof node[1] === 'string') {
        rpcSet.add(node[1]);
        if (typeof node[2] === 'string') {
          try {
            const inner = JSON.parse(node[2]);
            // Shape 1: operation record [null, 50, [[opId, projectId, sceneId, status, ...]]]
            if (Array.isArray(inner?.[2]?.[0]) && typeof inner[2][0][0] === 'string' && UUID_RE.test(inner[2][0][0])) {
              opSet.add(inner[2][0][0]);
            }
            // Shape 2: text-video submit [..., [[mediaId, projectId, workflowId, status]]]
            if (Array.isArray(inner?.[3]?.[0]) && typeof inner[3][0][0] === 'string' && UUID_RE.test(inner[3][0][0])) {
              mediaSet.add(inner[3][0][0]);
              if (typeof inner[3][0][2] === 'string' && UUID_RE.test(inner[3][0][2])) {
                opSet.add(inner[3][0][2]);
              }
            }
            walkNode(inner, depth + 1);
          } catch { /* ignore */ }
        }
      } else if (node[0] === 'er') {
        result.hasErrorFrame = true;
      }
      for (const item of node) {
        walkNode(item, depth + 1);
      }
    }
  };

  // Strip batchexecute XSSI prefix )]}' and parse line-by-line JSON arrays
  const cleaned = body.replace(/^\)\]\}'\s*\n?/, '');
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    try {
      walkNode(JSON.parse(trimmed), 0);
    } catch { /* ignore unparseable frame line */ }
  }

  // Fallback regex extraction for escaped UUIDs right inside operation slots if JSON structure varied
  if (opSet.size === 0 && mediaSet.size === 0) {
    const uuidMatches = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (uuidMatches) {
      for (const u of uuidMatches.slice(0, 6)) {
        opSet.add(u);
      }
    }
  }

  result.rpcIds = [...rpcSet];
  result.operationIds = [...opSet];
  result.mediaIds = [...mediaSet];
  result.urls = [...urlSet];
  return result;
}

// Observed native image-generation RPC (2026-10-18). Prompt-save RPCs also
// contain the prompt, but do NOT acknowledge a generation. Keep the browser
// lease until the generation response finishes so the next tool cannot
// navigate away and abort an otherwise "submitted" image.
export function observeImageSubmission(page, prompt, { expectedAccount = null } = {}) {
  const timeout = get('generationTimeoutMs', 120000);
  const baseline = typeof page.evaluate === 'function' ? page.evaluate(() => [...document.querySelectorAll('flow-image-tile img[data-media-id]')]
    .map(img => img.getAttribute('data-media-id')).filter(Boolean)).catch(() => []) : null;
  const rpc = page.waitForResponse(response => {
    const url = new URL(response.url());
    if (url.origin !== 'https://flow.google.com'
      || url.pathname !== '/_/AiSandboxAngularFrontend/data/batchexecute'
      || !url.searchParams.get('rpcids')?.split(',').includes(FLOW_RPC_CATALOG.GEN_IMAGE)) return false;
    const request = response.request();
    const payload = new URLSearchParams(request.postData() || '').get('f.req') || '';
    return request.method() === 'POST' && rpcContainsPrompt(payload, prompt);
  }, { timeout }).then(async response => {
    await response.finished();
    const body = await response.text();
    const status = typeof response.status === 'function' ? response.status() : 200;
    const signal = detectSafetySignal({ status, body });
    if (signal.tripped) {
      if (expectedAccount) {
        tripAccountCooldown(expectedAccount, { ...signal, rpc: FLOW_RPC_CATALOG.GEN_IMAGE });
      }
      return {
        acknowledged: false,
        safetyTripped: true,
        safetySignal: signal,
        rpc: FLOW_RPC_CATALOG.GEN_IMAGE,
        reason: `Flow returned safety hold signal (${signal.details}); account cooldown activated.`,
      };
    }
    const telemetry = extractBatchTelemetry(body);
    if (!response.ok() || telemetry.hasErrorFrame || /\["er",|RESOURCE_EXHAUSTED|PERMISSION_DENIED|INVALID_ARGUMENT/.test(body)) {
      throw new Error('Flow did not acknowledge the image-generation request');
    }
    return {
      acknowledged: true,
      rpc: FLOW_RPC_CATALOG.GEN_IMAGE,
      telemetry,
    };
  });
  // Flow RPC IDs can change. A NEW, fully decoded image in the project
  // library is independent completion evidence, unlike an empty tile/count.
  const rendered = baseline && typeof page.waitForFunction === 'function' ? baseline.then(ids => page.waitForFunction(({ids,url}) => {
    if (location.href !== url) return false;
    return [...document.querySelectorAll('flow-image-tile img[data-media-id]')].some(img =>
      !ids.includes(img.getAttribute('data-media-id')) && img.getAttribute('data-media-id')
      && img.getBoundingClientRect().width > 0 && img.complete && img.naturalWidth > 0);
  }, {ids,url:page.url()}, {timeout})).then(() => ({acknowledged:true,source:'new-rendered-project-image'})) : null;
  return (rendered ? Promise.any([rpc, rendered]) : rpc)
    .catch(error => ({ acknowledged: false, reason: error.errors?.map(e => e.message).join('; ') || error.message }));
}

// Passively observe video-generation RPCs (eb1hJf, YhhmEf, nprQif, MZZa6b).
// Never invokes RPCs directly; correlates DOM click intent with server responses
// and falls back to independent browser DOM tile observation.
export function observeVideoSubmission(page, prompt, { expectedAccount = null } = {}) {
  const timeout = get('generationTimeoutMs', 120000);
  const baseline = typeof page.evaluate === 'function' ? page.evaluate(() => {
    const out = [];
    for (const tile of document.querySelectorAll('flow-video-tile')) {
      const id = tile.getAttribute('data-asset-id')
        || tile.querySelector('[data-media-id]')?.getAttribute('data-media-id')
        || tile.querySelector('video')?.getAttribute('src')
        || tile.querySelector('img')?.getAttribute('src');
      if (id) out.push(id);
    }
    return out;
  }).catch(() => []) : null;

  let matchedRpc = null;
  const rpc = page.waitForResponse(response => {
    const url = new URL(response.url());
    if (url.origin !== 'https://flow.google.com'
      || url.pathname !== '/_/AiSandboxAngularFrontend/data/batchexecute') return false;
    const rpcIds = url.searchParams.get('rpcids')?.split(',') || [];
    const hit = rpcIds.find(id => VIDEO_GENERATION_RPCS.includes(id));
    if (!hit) return false;
    const request = response.request();
    const payload = new URLSearchParams(request.postData() || '').get('f.req') || '';
    if (request.method() === 'POST' && rpcContainsPrompt(payload, prompt)) {
      matchedRpc = hit;
      return true;
    }
    return false;
  }, { timeout }).then(async response => {
    await response.finished();
    const body = await response.text();
    const status = typeof response.status === 'function' ? response.status() : 200;
    const signal = detectSafetySignal({ status, body });
    if (signal.tripped) {
      if (expectedAccount) {
        tripAccountCooldown(expectedAccount, { ...signal, rpc: matchedRpc || 'video_rpc' });
      }
      return {
        acknowledged: false,
        safetyTripped: true,
        safetySignal: signal,
        rpc: matchedRpc,
        reason: `Flow returned safety hold signal (${signal.details}); account cooldown activated.`,
      };
    }
    const telemetry = extractBatchTelemetry(body);
    if (!response.ok() || telemetry.hasErrorFrame || /\["er",|RESOURCE_EXHAUSTED|PERMISSION_DENIED|INVALID_ARGUMENT/.test(body)) {
      throw new Error(`Flow did not acknowledge the video-generation request (${matchedRpc || 'unknown rpc'})`);
    }
    return {
      acknowledged: true,
      rpc: matchedRpc || telemetry.rpcIds[0] || FLOW_RPC_CATALOG.GEN_VIDEO_I2V,
      telemetry,
    };
  });

  // Independent DOM fallback: detects a newly inserted video tile in the project gallery
  const rendered = baseline && typeof page.waitForFunction === 'function' ? baseline.then(ids => page.waitForFunction(({ids,url}) => {
    if (location.href !== url) return false;
    return [...document.querySelectorAll('flow-video-tile')].some(tile => {
      const id = tile.getAttribute('data-asset-id')
        || tile.querySelector('[data-media-id]')?.getAttribute('data-media-id')
        || tile.querySelector('video')?.getAttribute('src')
        || tile.querySelector('img')?.getAttribute('src');
      const rect = tile.getBoundingClientRect();
      return id && !ids.includes(id) && rect.width > 0 && rect.height > 0;
    });
  }, {ids,url:page.url()}, {timeout})).then(() => ({acknowledged:true,source:'new-rendered-project-video'})) : null;

  return (rendered ? Promise.any([rpc, rendered]) : rpc)
    .catch(error => ({ acknowledged: false, reason: error.errors?.map(e => e.message).join('; ') || error.message }));
}

export function rpcContainsPrompt(payload, prompt) {
  if (typeof payload !== 'string') return false;
  if (payload.includes(prompt)) return true;
  // batchexecute nests JSON strings inside arrays; matching the raw escaped
  // body once misses Unicode and multiline prompts after double encoding.
  function visit(value, depth) {
    if (depth > 8) return false;
    if (typeof value === 'string') {
      if (value.includes(prompt)) return true;
      try { return visit(JSON.parse(value), depth + 1); } catch { return false; }
    }
    return Array.isArray(value) && value.some(v => visit(v, depth + 1));
  }
  try { return visit(JSON.parse(payload), 0); } catch { return false; }
}

export async function createLiveAuthorization({ page, confirmed, maxCredits = projectCreditCap() }) {
  if (confirmed !== true) return null;
  if (getSessionScope()?.handlerSubmission) return null;
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new FlowError('INVALID_PARAMS', 'max_credits must be a finite non-negative number');
  }
  // With no optional email pin, bind this approval to the current live account.
  // Common submission policy re-observes it before permitting a paid click.
  const pageHtml = await page.content().catch(() => '');
  const expectedAccount = get('expectedAccount') || extractObservedAccount(pageHtml);
  const intendedProjectId = extractProjectId(page.url());
  if (!expectedAccount || !intendedProjectId || new URL(page.url()).origin !== 'https://flow.google.com') {
    throw new FlowError('MANUAL_VERIFICATION_REQUIRED', 'Live generation requires an identified signed-in account and a Google Flow project');
  }
  assertAccountActive(expectedAccount);
  const preCheckSignal = detectSafetySignal({ html: pageHtml });
  if (preCheckSignal.tripped) {
    tripAccountCooldown(expectedAccount, preCheckSignal);
    assertAccountActive(expectedAccount);
  }
  return {
    page, origin: 'live-browser', expectedAccount, intendedProjectId,
    maxCredits, approvals: new Map(), ledger: { reserved: 0, maxAuthorized: maxCredits },
    opStore: createOperationStore(getFlowHome()),
    approve(payload, quote) {
      const child = mintChildApproval({}, {
        requestDigest: digestRequest(payload), accountKey: expectedAccount,
        projectId: intendedProjectId, model: payload.model,
        quoteTotal: quote?.total, maxCredits,
      });
      this.approvals.set(child.id, child);
      this.approvalChild = child;
    },
    async submit({ epoch, bounded }) {
      assertUiCurrent(epoch);
      assertAccountActive(expectedAccount);
      const found = await findActionButton(page, GENERATE_BUTTON_SELECTORS);
      if (!found || await found.locator.isDisabled()) {
        throw new FlowError('GENERATION_BUTTON_DISABLED', 'Generate button is unavailable; do not automatically retry this operation');
      }
      assertUiCurrent(epoch);
      if (bounded?.requested?.type === 'video') {
        reserveProjectCredits({ account: expectedAccount, projectId: intendedProjectId,
          operationId: bounded.operationId, credits: bounded.quote.total });
      }
      const reqType = bounded?.requested?.type;
      const acknowledgement = reqType === 'image'
        ? observeImageSubmission(page, bounded.requested.prompt, { expectedAccount })
        : reqType === 'video'
          ? observeVideoSubmission(page, bounded.requested.prompt, { expectedAccount })
          : null;
      await found.locator.click({ timeout: 8000 });
      const observed = acknowledgement ? await acknowledgement : null;
      if (observed && !observed.acknowledged) {
        return {
          remoteStatus: 'submission_unknown',
          submissionAcknowledged: false,
          ...(observed.safetyTripped ? { safetyTripped: true, safetySignal: observed.safetySignal } : {}),
          message: observed.safetyTripped
            ? `Safety hold triggered (${observed.safetySignal?.details}); account is on cooldown. Do not retry automatically.`
            : 'Generate was clicked, but Flow acknowledgement was not observed. Do not resubmit; inspect this operation before continuing.',
          reason: observed.reason,
        };
      }
      return {
        remoteStatus: 'pending',
        ...(observed ? {
          submissionAcknowledged: true,
          rpc: observed.rpc || null,
          source: observed.source || null,
          telemetry: observed.telemetry || null,
        } : {}),
        message: 'Submitted to Flow. Rendering is not yet complete; inspect the project before downloading. Do not submit again.',
      };
    },
  };
}
