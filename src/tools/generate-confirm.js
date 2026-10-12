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
// - image models are ~0 credits; cheap video is Omni 1.1 Flash, NOT Veo Fast (~20)
export async function handleGenerateConfirm(args = {}) {
  const rawId = args.job_id ?? args.jobId ?? args.jobID;
  if (typeof rawId !== 'string' || !rawId.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'job_id is required (a prepared ready_for_confirmation job)');
  }
  const maxCredits = args.max_credits === undefined ? 2 : Number(args.max_credits);
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'max_credits must be a non-negative number');
  }
  const waitMs = Math.min(Math.max(Number(args.wait_ms) || 120000, 15000), 600000);

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

    const before = await page.evaluate(() => document.querySelectorAll('img,video').length).catch(() => null);
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
    await page.waitForTimeout(waitMs);
    await takeScreenshot(page, 'confirm-after');
    const after = await page.evaluate(() => document.querySelectorAll('img,video').length).catch(() => null);

    jobQueue.completeJob(job.id, { status: 'submitted', type: state.type, preparedJobId: rawId,
      model_used: state.model_used, quote, mediaBefore: before, mediaAfter: after,
      message: `Generate clicked (${quote.state === 'known' ? `${quote.total} credits` : 'unquoted, expected ~0 for images'}). Verify output in Flow.` });
    return jobQueue.getJob(job.id).result;
  } catch (err) {
    try { await takeScreenshot(getPage(), 'generate-confirm-error'); } catch { /* ok */ }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
