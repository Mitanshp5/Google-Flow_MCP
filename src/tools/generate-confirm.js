import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { findActionButton, GENERATE_BUTTON_SELECTORS } from '../browser/safe-actions.js';
import { parseCostLabel } from '../browser/cost-quote.js';

// Live Generate click for a prepared job. Fail-closed by design:
// - only jobs in verified ready_for_confirmation state (never prepared_unverified)
// - image/video/character preparations (character portraits are image-class, ~0 credits)
// - spends nothing above max_credits (default 2; pass higher to allow Veo-class models)
// - image models are ~0 credits; cheap video is Omni 1.1 Flash (default), NOT Veo Fast (~20)
// Short-wait + poll pattern (fix for long-block caller waits):
// flow_generate_confirm never holds the MCP call for the full render.
// It clicks Generate, watches briefly (20-30s) with early exit on the
// first new-output signal, completes the local queue job immediately, and
// returns. The caller then polls flow_queue_status until
// hasActiveJob=false + history status=completed, then calls
// flow_download_latest. Long wait_ms values (e.g. 120000) are clamped to
// the short ceiling — the queue record (not the blocked caller) is the
// source of truth for completion (image job 838d4ab3 completed at
// 05:56:26 while its caller was still blocked in the old full-window poll).
export const GENERATE_CONFIRM_DEFAULT_WAIT_MS = 2000;
export const GENERATE_CONFIRM_MIN_WAIT_MS = 1000;
export const GENERATE_CONFIRM_MAX_WAIT_MS = 30000;
export const GENERATE_CONFIRM_POLL_STEP_MS = 2000;

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
      const count = document.querySelectorAll('img,video').length;
      const ids = [...new Set(
        [...document.querySelectorAll('img')].map((img) => {
          const m = String(img.src || '').match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
          return m ? m[1] : null;
        }).filter(Boolean)
          .concat([...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src || '').filter(Boolean)),
      )];
      const tiles = [...new Set(
        [...document.querySelectorAll('[data-asset-id]')].map((el) => el.getAttribute('data-asset-id')).filter(Boolean),
      )];
      return { count, ids, tiles };
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
  const maxCredits = args.max_credits === undefined ? 2 : Number(args.max_credits);
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

  const job = jobQueue.createJob(state.type === 'image' ? 'image_confirm' : state.type === 'video' ? 'video_confirm' : 'character_confirm', {
    preparedJobId: rawId.trim(), model: state.model_used, max_credits: maxCredits,
  });
  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    const before = await snapshotMedia(page);
    const costText = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      for (const el of els) {
        const text = (el.innerText || el.textContent || '').trim();
        if (/generating will use \d+ credits|\d+\s*credits?/i.test(text) && text.length < 60) return text;
      }
      return null;
    }).catch(() => null);
    let quote = { total: 0, state: 'unquoted', raw: costText };
    if (costText) {
      const parsed = parseCostLabel(costText, { quantity: state.quantity || 1 });
      if (parsed.state === 'known') quote = { total: parsed.totalUpperBound, state: 'known', raw: costText };
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
    await found.locator.click({ timeout: 8000 });
    logger.info('Generate clicked', { jobId: job.id, preparedJobId: rawId, quote });
    // Short-wait + poll: watch briefly with early exit on the FIRST
    // new-output signal (count, media id, or gallery tile). Never holds the
    // full render — the local queue job completes immediately on return and
    // the caller polls flow_queue_status (hasActiveJob=false +
    // history status) then flow_download_latest. No auto-download here.
    // Character titles are editable during rendering; allow immediate rename.
    const deadline = Date.now() + (state.type === 'character' ? 0 : waitMs);
    let after = before;
    let detected = false;
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

    const quoteLabel = quote.state === 'known' ? `${quote.total} credits` : 'unquoted, expected ~0 for images';
    const pollHint = 'Poll flow_queue_status until hasActiveJob=false, then check history status=completed for this job id, then call flow_download_latest. Do not re-click Generate.';
    jobQueue.completeJob(job.id, { status: detected ? 'completed' : 'submitted', type: state.type, preparedJobId: rawId,
      jobId: job.id, model_used: state.model_used, quote,
      mediaBefore: before, mediaAfter: after, detected,
      waitMs, requestedWaitMs, waitClamped,
      pollHint,
      next: detected
        ? { poll: 'flow_queue_status', until: 'hasActiveJob=false and history status=completed', then: 'flow_download_latest' }
        : { poll: 'flow_queue_status', until: 'hasActiveJob=false and history status=completed', then: 'flow_download_latest', note: 'No new output within the short window; the Flow render may still be running — poll before downloading, never re-click blindly.' },
      message: `Generate clicked (${quoteLabel}). ${detected ? 'New output detected — poll flow_queue_status until hasActiveJob=false + status=completed, then flow_download_latest.' : `No new output within the short ${waitMs}ms window${waitClamped ? ` (requested ${requestedWaitMs}ms clamped to the ${GENERATE_CONFIRM_MAX_WAIT_MS}ms short ceiling)` : ''}; the render may still be running — ${pollHint}`} `});
    return jobQueue.getJob(job.id).result;
  } catch (err) {
    try { await takeScreenshot(getPage(), 'generate-confirm-error'); } catch { /* ok */ }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
