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

// Observed native image-generation RPC (2026-10-18). Prompt-save RPCs also
// contain the prompt, but do NOT acknowledge a generation. Keep the browser
// lease until the generation response finishes so the next tool cannot
// navigate away and abort an otherwise "submitted" image.
export function observeImageSubmission(page, prompt) {
  const timeout = get('generationTimeoutMs', 120000);
  const baseline = typeof page.evaluate === 'function' ? page.evaluate(() => [...document.querySelectorAll('flow-image-tile img[data-media-id]')]
    .map(img => img.getAttribute('data-media-id')).filter(Boolean)).catch(() => []) : null;
  const rpc = page.waitForResponse(response => {
    const url = new URL(response.url());
    if (url.origin !== 'https://flow.google.com'
      || url.pathname !== '/_/AiSandboxAngularFrontend/data/batchexecute'
      || !url.searchParams.get('rpcids')?.split(',').includes('ogiZ0b')) return false;
    const request = response.request();
    const payload = new URLSearchParams(request.postData() || '').get('f.req') || '';
    return request.method() === 'POST' && rpcContainsPrompt(payload, prompt);
  }, { timeout }).then(async response => {
    await response.finished();
    const body = await response.text();
    if (!response.ok() || /\["er",|RESOURCE_EXHAUSTED|PERMISSION_DENIED|INVALID_ARGUMENT/.test(body)) {
      throw new Error('Flow did not acknowledge the image-generation request');
    }
    return { acknowledged: true, rpc: 'ogiZ0b' };
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
  const expectedAccount = get('expectedAccount') || extractObservedAccount(await page.content());
  const intendedProjectId = extractProjectId(page.url());
  if (!expectedAccount || !intendedProjectId || new URL(page.url()).origin !== 'https://flow.google.com') {
    throw new FlowError('MANUAL_VERIFICATION_REQUIRED', 'Live generation requires an identified signed-in account and a Google Flow project');
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
      const found = await findActionButton(page, GENERATE_BUTTON_SELECTORS);
      if (!found || await found.locator.isDisabled()) {
        throw new FlowError('GENERATION_BUTTON_DISABLED', 'Generate button is unavailable; do not automatically retry this operation');
      }
      assertUiCurrent(epoch);
      reserveProjectCredits({ account: expectedAccount, projectId: intendedProjectId,
        operationId: bounded.operationId, credits: bounded.quote.total });
      const acknowledgement = bounded?.requested?.type === 'image'
        ? observeImageSubmission(page, bounded.requested.prompt) : null;
      await found.locator.click({ timeout: 8000 });
      const observed = acknowledgement ? await acknowledgement : null;
      if (observed && !observed.acknowledged) {
        return { remoteStatus: 'submission_unknown', submissionAcknowledged: false,
          message: 'Generate was clicked, but Flow acknowledgement was not observed. Do not resubmit; inspect this operation before continuing.', reason: observed.reason };
      }
      return { remoteStatus: 'pending', ...(observed ? {submissionAcknowledged:true} : {}), message: 'Submitted to Flow. Rendering is not yet complete; inspect the project before downloading. Do not submit again.' };
    },
  };
}
