import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { findActionButton, GENERATE_BUTTON_SELECTORS, openBarSettings, closeSettingsPanel, isVerifiedSettingsPanel } from '../browser/safe-actions.js';
import { parseCostLabel } from '../browser/cost-quote.js';
import { get } from '../utils/config.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { decontaminateModelField } from '../browser/capabilities.js';
import { renameCharacterTitle } from '../navigation/character-rename.js';
import { observeImageSubmission } from '../domain/live-submission.js';
import { projectCreditCap, reserveProjectCredits } from '../utils/project-credit-budget.js';
import { extractProjectId } from '../navigation/project-navigator.js';
import { waitForCharacterPortrait } from '../browser/character-form.js';

// Live Generate click for a prepared job. Fail-closed by design:
// - only jobs in verified ready_for_confirmation state (never prepared_unverified)
// - image/video/character preparations (character portraits are image-class, ~0 credits)
// - optional max_credits per-click ceiling; persistent project budget defaults to 50 total
// - image models are ~0 credits; cheap video is Omni 1.1 Flash (default), NOT Veo Fast (~20)
// Watches briefly after submission. Local job completion is NOT remote
// render completion; inspect the new remote asset before downloading.
export const GENERATE_CONFIRM_DEFAULT_WAIT_MS = 2000;
export const GENERATE_CONFIRM_MIN_WAIT_MS = 1000;
export const GENERATE_CONFIRM_MAX_WAIT_MS = 30000;
export const GENERATE_CONFIRM_POLL_STEP_MS = 2000;

async function readRemoteBlocker(page) {
  const signals = [
    ['insufficient_credits', /Not enough credits|Insufficient credits/i],
    ['rate_limited', /Too many requests|Rate limit exceeded|Quota exceeded/i],
  ];
  for (const [reason, text] of signals) {
    if (await page.getByText(text).first().isVisible().catch(() => false)) return reason;
  }
  return null;
}

export function parseConfirmationQuote(labels, quantity = 1) {
  const unique = [...new Set(labels || [])];
  if (unique.length !== 1) return { total: null, state: 'unquoted', raw: null };
  if (/\bremaining|balance|available|spent|used\b/i.test(unique[0])) return { total: null, state: 'unquoted', raw: unique[0] };
  const parsed = parseCostLabel(unique[0], { quantity });
  // For exactly one output, per-output and total amounts are identical.
  // Never infer units for batches or substitute a configured/model price.
  const single = quantity === 1 && parsed.unit === 'unknown-ambiguous' && Number.isFinite(parsed.amount)
    && /^(?:Generating will use\s+)?\d+(?:\.\d+)?\s*credits?$/i.test(unique[0]);
  return {
    total: parsed.state === 'known' || single ? parsed.totalUpperBound : null,
    state: parsed.state === 'known' || single ? 'known' : 'unquoted',
    raw: unique[0],
  };
}

export function characterImagePolicyQuote({ policy, account, model, type, url, labels = [] }) {
  // Explicit account-owner pricing policy, NOT a fabricated UI quote. Only
  // the native character image form and exact allowlisted image model qualify.
  if (type !== 'character' || !/^https:\/\/flow\.google\.com\/project\/[^/?#]+\/character\/?$/.test(url || '')
    || !account || policy?.account !== account || !policy.models?.includes(model) || labels.length) return null;
  return { total: 0, state: 'known', raw: null, source: 'account-owner-free-image-policy', model };
}

async function readConfirmationQuote(page, quantity, state = {}) {
  // Character creation has a model-family dropdown, not the regular
  // composer settings panel. Never open it looking for a credit quote.
  const characterForm = state.type === 'character'
    && await page.locator('[aria-label*="Describe your character" i]').first().isVisible().catch(() => false);
  if (characterForm) {
    await page.keyboard.press('Escape');
    const button = page.locator('button[aria-label="Start generation"]').first();
    await button.hover({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
    const labels = await page.locator('[role="tooltip"]:visible').allTextContents();
    const creditLabels = labels.filter(text => /credits?/i.test(text)).map(text => text.trim());
    const quote = parseConfirmationQuote(creditLabels, quantity);
    if (quote.state === 'known') return quote;
    const model = decontaminateModelField(await page.locator('button[aria-label="Select model family"]').innerText().catch(() => ''));
    const account = extractObservedAccount(await page.content());
    return characterImagePolicyQuote({ policy: get('freeCharacterImages'), account, model,
      type: state.type, url: page.url(), labels: creditLabels }) || quote;
  }
  const { panel } = await openBarSettings(page);
  if (!panel) return parseConfirmationQuote([], quantity);
  try {
    if (!(await isVerifiedSettingsPanel(panel))?.isSettings) return parseConfirmationQuote([], quantity);
    const labels = await panel.evaluate(root => [...root.querySelectorAll('*')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.children.length === 0;
      })
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(text => /credits?/i.test(text)));
    return parseConfirmationQuote(labels, quantity);
  } finally {
    if (!(await closeSettingsPanel(page))) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, 'Could not close generation settings after reading credit cost. No Generate click made.');
    }
  }
}

/**
 * Pure short-wait resolver (unit-tested). Long windows clamp to the short
 * ceiling so callers use poll-queue-then-download instead of blocking.
 * Returns { waitMs, requested, clamped }.
 */
export function resolveConfirmWaitMs(raw) {
  const requested = Number(raw);
  const parsed = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : GENERATE_CONFIRM_DEFAULT_WAIT_MS;
  const waitMs = Math.min(
    Math.max(parsed, GENERATE_CONFIRM_MIN_WAIT_MS),
    GENERATE_CONFIRM_MAX_WAIT_MS,
  );
  return { waitMs, requested: Number.isFinite(requested) ? Math.floor(requested) : null, clamped: waitMs !== parsed };
}

/**
 * Pure new-output detector (unit-tested). Any positive signal counts:
 * higher media count, a media id unseen in the baseline, or a new gallery
 * tile id. Baseline/newness (not timing alone) proves output landed.
 */
export function detectNewMedia(before = {}, after = {}) {
  const bCount = Number(before?.count);
  const aCount = Number(after?.count);
  if (Number.isFinite(bCount) && Number.isFinite(aCount) && aCount > bCount) return true;
  const bIds = new Set([...(before?.ids || []), ...(before?.tiles || [])].filter((x) => typeof x === 'string' && x));
  if (bIds.size > 0 || Array.isArray(after?.ids) || Array.isArray(after?.tiles)) {
    for (const id of [...(after?.ids || []), ...(after?.tiles || [])]) {
      if (typeof id === 'string' && id && !bIds.has(id)) return true;
    }
  }
  return false;
}

async function snapshotMedia(page) {
  try {
    return await page.evaluate(() => {
      const media = [...document.querySelectorAll('flow-image-tile img, flow-video-tile video, img[data-media-id], video[data-media-id]')];
      const count = media.length;
      const ids = [...new Set(
        media.filter(el => el.tagName === 'IMG').map((img) => {
          const m = String(img.src || '').match(/(?:media\.getMediaUrlRedirect\?name=|flow-content\.google\/image\/)([a-f0-9-]+)/);
          return m ? m[1] : null;
        }).filter(Boolean)
          .concat(media.filter(el => el.tagName === 'VIDEO').map((v) => v.currentSrc || v.src || '').filter(Boolean)),
      )];
      const tiles = [...new Set(
        [...document.querySelectorAll('[data-asset-id]')].map((el) => el.getAttribute('data-asset-id')).filter(Boolean),
      )];
       const editor = document.querySelector('flow-base-prompt-box [role="textbox"], flow-base-prompt-box textarea');
       const promptText = editor ? (editor.value ?? editor.textContent ?? '').trim() : null;
       return { count, ids, tiles, promptText };
    });
  } catch {
    return null;
  }
}
export async function handleGenerateConfirm(args = {}) {
  const rawId = args.job_id ?? args.jobId ?? args.jobID;
  if (typeof rawId !== 'string' || !rawId.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'job_id is required (a prepared ready_for_confirmation job)');
  }
  const maxCredits = args.max_credits === undefined ? projectCreditCap() : Number(args.max_credits);
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'max_credits must be a non-negative number');
  }
  const { waitMs, requested: requestedWaitMs, clamped: waitClamped } = resolveConfirmWaitMs(args.wait_ms);
  if (waitClamped && requestedWaitMs !== null && requestedWaitMs > GENERATE_CONFIRM_MAX_WAIT_MS) {
    logger.info('Confirm wait clamped to short ceiling; poll queue then download', {
      requestedWaitMs, waitMs,
    });
  }

  const prep = jobQueue.getJob(rawId.trim());
  const state = prep?.result || null;
  if (!prep || !state || state.status !== 'ready_for_confirmation') {
    throw new FlowError(ErrorCodes.INVALID_PARAMS,
      `Job ${rawId} is not a verified ready_for_confirmation preparation (prepare-only tools return it; prepared_unverified can never confirm)`);
  }
  if (state.type !== 'image' && state.type !== 'video' && state.type !== 'character') {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Job ${rawId} is type ${state.type}; only image/video/character preparations confirm`);
  }
  if (state.settings_verification && state.settings_verification.verified === false) {
    throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, `Job ${rawId} settings unverified; refusing paid click`);
  }
  if (state.confirmationJobId) {
    throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, `Preparation already submitted by ${state.confirmationJobId}; inspect the existing output, do not resubmit.`);
  }
  if (Object.values(state.frame_verification || {}).some(frame => frame.verified !== true)
    || state.references?.verified === false || state.ingredients_failed?.length) {
    throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, `Job ${rawId} references or frame slots unverified; refusing paid click`);
  }

  const job = jobQueue.createJob(state.type === 'image' ? 'image_confirm' : state.type === 'video' ? 'video_confirm' : 'character_confirm', {
    preparedJobId: rawId.trim(), model: state.model_used, max_credits: maxCredits,
  });
  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    const before = await snapshotMedia(page);
    if (state.type === 'character') {
      const editor = page.locator('[contenteditable="true"][aria-label*="Describe your character" i]').first();
      const text = await editor.textContent().catch(() => null);
      const model = decontaminateModelField(await page.locator('button[aria-label="Select model family"]').innerText().catch(() => ''));
      if (!state.project_url || page.url() !== state.project_url
        || !text || text.replace(/\s+/g, ' ').trim() !== String(state.prompt || state.description || '').replace(/\s+/g, ' ').trim()
        || !state.model_used || model !== state.model_used) {
        throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, 'Prepared character project, description or image model changed. Prepare again; no Generate click made.');
      }
    }
    const existingBlocker = await readRemoteBlocker(page);
    if (existingBlocker) {
      const result = { status: 'blocked', reason: existingBlocker, type: state.type,
        jobId: job.id, preparedJobId: rawId, clicked: false, remoteStatus: 'blocked',
        message: 'Flow reports a credit or quota blocker. No Generate click made; resolve the account limit before retrying.' };
      jobQueue.completeJob(job.id, result);
      return result;
    }
    const quote = await readConfirmationQuote(page, state.quantity || 1, state);
    if (quote.state !== 'known') {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
        'Credit cost could not be verified. No Generate click made; an unknown quote is not zero credits.', { quote });
    }
    if (quote.total > maxCredits) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
        `Quoted ${quote.total} credits exceeds max_credits ${maxCredits} (pass a higher max_credits to allow, e.g. Veo-class video)`, { quote });
    }

    const found = await findActionButton(page, GENERATE_BUTTON_SELECTORS);
    if (!found) {
      await takeScreenshot(page, 'confirm-no-generate-btn');
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, 'Generate button not visible; composer state may have changed since preparation');
    }
    if (await found.locator.isDisabled().catch(() => true)) {
      await takeScreenshot(page, 'confirm-generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
    }
    await takeScreenshot(page, 'confirm-before-click');
    reserveProjectCredits({
      account: extractObservedAccount(await page.content()),
      projectId: extractProjectId(page.url()), operationId: `confirm:${rawId.trim()}`,
      credits: quote.total,
    });
    state.confirmationJobId = job.id;
    const imageAcknowledgement = state.type === 'image' && state.prompt
      ? observeImageSubmission(page, state.prompt) : null;
    await found.locator.click({ timeout: 8000 });
    if (imageAcknowledgement && !(await imageAcknowledgement).acknowledged) {
      const result = {status:'submission_unknown', type:state.type, jobId:job.id, preparedJobId:rawId,
        clicked:true, remoteStatus:'submission_unknown', submissionAcknowledged:false,
        message:'Generate was clicked but no image-generation acknowledgement was observed. Inspect the project; do not automatically resubmit.'};
      jobQueue.completeJob(job.id, result);
      return result;
    }
    logger.info('Generate clicked', { jobId: job.id, preparedJobId: rawId, quote });
    let naming = null;
    let portrait = null;
    if (state.type === 'character' && state.name) {
      try {
        // Entry creation is NOT portrait completion. Do not rename/navigate
        // while the portrait request is still rendering.
        portrait = await waitForCharacterPortrait(page);
        naming = { requested: state.name, verified: await renameCharacterTitle(page, state.name), portrait_verified:true, url: page.url() };
      } catch (error) {
        naming = { requested: state.name, verified: false, portrait_verified: false, url: page.url(), reason: error.message };
        const pending = {status:'pending', type:'character', jobId:job.id, preparedJobId:rawId,
          clicked:true, remoteStatus:'pending', quote, naming,
          message:'Character entry exists but its portrait is not verified. Keep this page open; do not create another character or resubmit.'};
        jobQueue.completeJob(job.id,pending);
        return pending;
      }
    }
    // Short-wait + poll: watch briefly with early exit on the FIRST
    // new-output signal (count, media id, or gallery tile). Never holds the
    // full render. Local queue completion releases the handler only;
    // verify remote readiness before download. No auto-download here.
    // Character titles are editable during rendering; allow immediate rename.
    const deadline = Date.now() + (state.type === 'character' ? 0 : waitMs);
    let after = before;
    let detected = !!portrait?.verified;
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(GENERATE_CONFIRM_POLL_STEP_MS, Math.max(500, deadline - Date.now())));
      const snap = await snapshotMedia(page);
      if (snap) after = snap;
      if (before && after && detectNewMedia(before, after)) {
        detected = true;
        break;
      }
      // No baseline (empty gallery): any observed media is new output.
      if (!before && after && (Number(after.count) > 0 || (after.ids || []).length > 0 || (after.tiles || []).length > 0)) {
        detected = true;
        break;
      }
    }
    await takeScreenshot(page, 'confirm-after');

    // Flow can debit successfully, clear the draft, then warn that the NEXT
    // generation exceeds the remaining balance. That is not a rejected job.
    const promptCleared = typeof before?.promptText === 'string' && before.promptText.length > 0 && after?.promptText === '';
    const remoteBlocker = !detected && !promptCleared ? await readRemoteBlocker(page) : null;
    if (remoteBlocker) {
      const result = { status: 'blocked', reason: remoteBlocker, type: state.type,
        jobId: job.id, preparedJobId: rawId, clicked: true, remoteStatus: 'blocked', quote,
        message: 'Generate was clicked, but Flow reports a credit or quota blocker. Rendering is not confirmed. Do not automatically resubmit or upgrade.' };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    const quoteLabel = `${quote.total} credits`;
    const pollHint = 'Local queue completion only means the submission handler finished, not that Flow finished rendering. Verify the new remote asset is ready before calling flow_download_latest. Do not re-click Generate.';
    jobQueue.completeJob(job.id, { status: portrait?.verified ? 'completed' : detected ? 'output_detected' : 'submitted', type: state.type, preparedJobId: rawId,
      jobId: job.id, model_used: state.model_used, quote,
      ...(naming ? { naming } : {}),
      ...(portrait ? { portrait } : {}),
      mediaBefore: before, mediaAfter: after, detected,
      remoteStatus: portrait?.verified ? 'completed' : detected ? 'output_detected' : 'pending',
      waitMs, requestedWaitMs, waitClamped,
      pollHint,
      next: { inspect: 'flow_screenshot', until: 'new remote asset visibly ready (not local queue completion)', then: 'flow_download_latest', note: pollHint },
      message: portrait?.verified ? `Native character portrait decoded and verified (${portrait.width}x${portrait.height}); name save verified=${naming?.verified}.` : `Generate clicked (${quoteLabel}). ${detected ? 'New output signal detected; remote render readiness still requires verification.' : `No new output within the short ${waitMs}ms window.`} ${pollHint}` });
    return jobQueue.getJob(job.id).result;
  } catch (err) {
    try { await takeScreenshot(getPage(), 'generate-confirm-error'); } catch { /* ok */ }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
