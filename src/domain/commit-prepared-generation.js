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
import { observeImageSubmission, observeVideoSubmission } from './live-submission.js';
import {
  assertAccountActive,
  detectSafetySignal,
  tripAccountCooldown,
  RATE_LIMIT_COOLDOWN_SEC,
} from './account-circuit-breaker.js';
import { projectCreditCap, reserveProjectCredits } from '../utils/project-credit-budget.js';
import { extractProjectId } from '../navigation/project-navigator.js';
import { waitForCharacterPortrait } from '../browser/character-form.js';

export const COMMIT_DEFAULT_WAIT_MS = 2000;
export const COMMIT_MIN_WAIT_MS = 1000;
export const COMMIT_MAX_WAIT_MS = 30000;
export const COMMIT_POLL_STEP_MS = 2000;

export function parseConfirmationQuote(labels, quantity = 1) {
  const unique = [...new Set(labels || [])];
  if (unique.length !== 1) return { total: null, state: 'unquoted', raw: null };
  if (/\bremaining|balance|available|spent|used\b/i.test(unique[0])) return { total: null, state: 'unquoted', raw: unique[0] };
  const parsed = parseCostLabel(unique[0], { quantity });
  const single = quantity === 1 && parsed.unit === 'unknown-ambiguous' && Number.isFinite(parsed.amount)
    && /^(?:Generating will use\s+)?\d+(?:\.\d+)?\s*credits?$/i.test(unique[0]);
  return {
    total: parsed.state === 'known' || single ? parsed.totalUpperBound : null,
    state: parsed.state === 'known' || single ? 'known' : 'unquoted',
    raw: unique[0],
  };
}

export function characterImagePolicyQuote({ policy, account, model, type, url, labels = [] }) {
  if (type !== 'character' || !/^https:\/\/flow\.google\.com\/project\/[^/?#]+\/character\/?$/.test(url || '')
    || !account || policy?.account !== account || !policy.models?.includes(model) || labels.length) return null;
  return { total: 0, state: 'known', raw: null, source: 'account-owner-free-image-policy', model };
}

export async function readCommitQuote(page, quantity, state = {}) {
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

export async function snapshotMedia(page) {
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

export function resolveConfirmWaitMs(raw) {
  const requested = Number(raw);
  const parsed = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : COMMIT_DEFAULT_WAIT_MS;
  const waitMs = Math.min(
    Math.max(parsed, COMMIT_MIN_WAIT_MS),
    COMMIT_MAX_WAIT_MS,
  );
  return { waitMs, requested: Number.isFinite(requested) ? Math.floor(requested) : null, clamped: waitMs !== parsed };
}

/**
 * Single authoritative commit service for ALL paid generation requests
 * (Image, Video, Character).
 *
 * Enforces:
 * 1. Prepared job must be ready_for_confirmation (prepared_unverified is NEVER confirmable).
 * 2. Idempotency: a prepared job can be submitted at most once.
 * 3. Fresh UI verification matching prepared snapshot.
 * 4. Credit quote verification & budget reservation.
 * 5. Exactly one click on the Generate button.
 * 6. Post-click output verification and honest remote status reporting.
 */
export async function commitPreparedGeneration(args = {}) {
  const rawId = args.job_id ?? args.jobId ?? args.jobID;
  if (typeof rawId !== 'string' || !rawId.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'job_id is required (a prepared ready_for_confirmation job)');
  }
  const maxCredits = args.max_credits === undefined ? projectCreditCap() : Number(args.max_credits);
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'max_credits must be a non-negative number');
  }
  const { waitMs, requested: requestedWaitMs, clamped: waitClamped } = resolveConfirmWaitMs(args.wait_ms);

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

  const jobType = state.type === 'image' ? 'image_confirm' : state.type === 'video' ? 'video_confirm' : 'character_confirm';
  const job = jobQueue.createJob(jobType, {
    preparedJobId: rawId.trim(),
    model: state.model_used,
    max_credits: maxCredits,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();
    const pageUrl = page.url() || '';
    let isFlow = false;
    try { isFlow = new URL(pageUrl).origin === 'https://flow.google.com'; } catch { /* ignore */ }
    if (!isFlow) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, 'Live generation requires a connected Google Flow project on https://flow.google.com');
    }

    const pageHtml = await page.content().catch(() => '');
    const observedAccount = extractObservedAccount(pageHtml) || state.account || get('expectedAccount', null);
    if (observedAccount) {
      assertAccountActive(observedAccount);
    }

    const preClickSafetySignal = detectSafetySignal({ html: pageHtml });
    if (preClickSafetySignal.tripped) {
      if (observedAccount) {
        tripAccountCooldown(observedAccount, {
          ...preClickSafetySignal,
          details: preClickSafetySignal.details || 'PRE_CLICK_SAFETY_SIGNAL',
        });
      }
      const blockedResult = {
        status: 'blocked',
        reason: preClickSafetySignal.reason,
        safetySignal: preClickSafetySignal,
        type: state.type,
        jobId: job.id,
        preparedJobId: rawId,
        clicked: false,
        remoteStatus: 'blocked',
        message: `Flow returned safety hold signal (${preClickSafetySignal.details}); generation halted to protect the account. Do not retry automatically.`,
      };
      jobQueue.completeJob(job.id, blockedResult);
      return blockedResult;
    }

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
      if (existingBlocker === 'rate_limited' && observedAccount) {
        tripAccountCooldown(observedAccount, {
          durationSec: RATE_LIMIT_COOLDOWN_SEC,
          reason: 'rate_limit',
          details: 'PRE_CLICK_RATE_LIMITED',
        });
      }
      const result = {
        status: 'blocked',
        reason: existingBlocker,
        type: state.type,
        jobId: job.id,
        preparedJobId: rawId,
        clicked: false,
        remoteStatus: 'blocked',
        message: 'Flow reports a credit or quota blocker. No Generate click made; resolve the account limit before retrying.',
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    const quote = await readCommitQuote(page, state.quantity || 1, state);
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
      const prepAgeMs = prep.createdAt ? Date.now() - new Date(prep.createdAt).getTime() : null;
      const isStale = prepAgeMs !== null && prepAgeMs > 60000;
      const msg = isStale
        ? 'Generate button is disabled for stale preparation ' + rawId + ' (' + Math.round(prepAgeMs / 1000) + 's old). Re-run prepare tool before confirming.'
        : 'Generate button is disabled; composer state may have changed. Re-run preparation.';
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, msg, { prepAgeMs, isStale });
    }

    await takeScreenshot(page, 'confirm-before-click');
    const currentAccount = extractObservedAccount(await page.content().catch(() => '')) || observedAccount;
    if (currentAccount) {
      assertAccountActive(currentAccount);
    }
    reserveProjectCredits({
      account: currentAccount,
      projectId: extractProjectId(page.url()),
      operationId: `confirm:${rawId.trim()}`,
      credits: quote.total,
    });
    state.confirmationJobId = job.id;

    const canObserveRpc = typeof page.waitForResponse === 'function';
    const submissionPrompt = state.prompt || state.description || '';
    const submissionAcknowledgement = canObserveRpc && submissionPrompt
      ? (state.type === 'image'
          ? observeImageSubmission(page, submissionPrompt, { expectedAccount: currentAccount })
          : state.type === 'video'
            ? observeVideoSubmission(page, submissionPrompt, { expectedAccount: currentAccount })
            : null)
      : null;

    await found.locator.click({ timeout: 8000 });

    const observedAck = submissionAcknowledgement ? await submissionAcknowledgement : null;
    if (observedAck && !observedAck.acknowledged) {
      const result = {
        status: observedAck.safetyTripped ? 'blocked' : 'submission_unknown',
        ...(observedAck.safetyTripped
          ? {
              reason: observedAck.safetySignal?.reason || 'unusual_activity',
              safetyTripped: true,
              safetySignal: observedAck.safetySignal,
            }
          : {}),
        type: state.type,
        jobId: job.id,
        preparedJobId: rawId,
        clicked: true,
        remoteStatus: observedAck.safetyTripped ? 'blocked' : 'submission_unknown',
        submissionAcknowledged: false,
        message: observedAck.safetyTripped
          ? `Generate was clicked and Flow returned safety hold (${observedAck.safetySignal?.details}); account cooldown activated. Do not retry automatically.`
          : `Generate was clicked but no ${state.type}-generation acknowledgement was observed. Inspect the project; do not automatically resubmit.`,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    logger.info('Generate clicked via shared commit service', { jobId: job.id, preparedJobId: rawId, quote });

    let naming = null;
    let portrait = null;
    if (state.type === 'character' && state.name) {
      try {
        portrait = await waitForCharacterPortrait(page);
        naming = { requested: state.name, verified: await renameCharacterTitle(page, state.name), portrait_verified: true, url: page.url() };
      } catch (error) {
        naming = { requested: state.name, verified: false, portrait_verified: false, url: page.url(), reason: error.message };
        const pending = {
          status: 'pending',
          type: 'character',
          jobId: job.id,
          preparedJobId: rawId,
          clicked: true,
          remoteStatus: 'pending',
          quote,
          naming,
          message: 'Character entry exists but its portrait is not verified. Keep this page open; do not create another character or resubmit.',
        };
        jobQueue.completeJob(job.id, pending);
        return pending;
      }
    }

    const deadline = Date.now() + (state.type === 'character' ? 0 : waitMs);
    let after = before;
    let detected = !!portrait?.verified;
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(COMMIT_POLL_STEP_MS, Math.max(500, deadline - Date.now())));
      const snap = await snapshotMedia(page);
      if (snap) after = snap;
      if (before && after && detectNewMedia(before, after)) {
        detected = true;
        break;
      }
      if (!before && after && (Number(after.count) > 0 || (after.ids || []).length > 0 || (after.tiles || []).length > 0)) {
        detected = true;
        break;
      }
    }
    await takeScreenshot(page, 'confirm-after');

    const promptCleared = typeof before?.promptText === 'string' && before.promptText.length > 0 && after?.promptText === '';
    const postHtml = await page.content().catch(() => '');
    const postSafetySignal = detectSafetySignal({ html: postHtml });
    if (!detected && !promptCleared && postSafetySignal.tripped) {
      if (currentAccount) {
        tripAccountCooldown(currentAccount, postSafetySignal);
      }
      const result = {
        status: 'blocked',
        reason: postSafetySignal.reason,
        safetySignal: postSafetySignal,
        type: state.type,
        jobId: job.id,
        preparedJobId: rawId,
        clicked: true,
        remoteStatus: 'blocked',
        quote,
        message: `Generate was clicked, but Flow returned safety hold signal (${postSafetySignal.details}); account cooldown activated.`,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    const remoteBlocker = !detected && !promptCleared ? await readRemoteBlocker(page) : null;
    if (remoteBlocker) {
      if (remoteBlocker === 'rate_limited' && currentAccount) {
        tripAccountCooldown(currentAccount, {
          durationSec: RATE_LIMIT_COOLDOWN_SEC,
          reason: 'rate_limit',
          details: 'POST_CLICK_RATE_LIMITED',
        });
      }
      const result = {
        status: 'blocked',
        reason: remoteBlocker,
        type: state.type,
        jobId: job.id,
        preparedJobId: rawId,
        clicked: true,
        remoteStatus: 'blocked',
        quote,
        message: 'Generate was clicked, but Flow reports a credit or quota blocker. Rendering is not confirmed. Do not automatically resubmit or upgrade.',
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    const quoteLabel = `${quote.total} credits`;
    const pollHint = 'Local queue completion only means the submission handler finished, not that Flow finished rendering. Verify the new remote asset is ready before calling flow_download_latest. Do not re-click Generate.';
    const finalResult = {
      status: portrait?.verified ? 'completed' : detected ? 'output_detected' : 'submitted',
      type: state.type,
      preparedJobId: rawId,
      jobId: job.id,
      model_used: state.model_used,
      quote,
      ...(observedAck ? {
        submissionAcknowledged: true,
        rpc: observedAck.rpc || null,
        source: observedAck.source || null,
        telemetry: observedAck.telemetry || null,
      } : {}),
      ...(naming ? { naming } : {}),
      ...(portrait ? { portrait } : {}),
      mediaBefore: before,
      mediaAfter: after,
      detected,
      remoteStatus: portrait?.verified ? 'completed' : detected ? 'output_detected' : 'pending',
      waitMs,
      requestedWaitMs,
      waitClamped,
      pollHint,
      next: {
        inspect: 'flow_screenshot',
        until: 'new remote asset visibly ready (not local queue completion)',
        then: 'flow_download_latest',
        note: pollHint,
      },
      message: portrait?.verified
        ? `Native character portrait decoded and verified (${portrait.width}x${portrait.height}); name save verified=${naming?.verified}.`
        : `Generate clicked (${quoteLabel}). ${detected ? 'New output signal detected; remote render readiness still requires verification.' : `No new output within the short ${waitMs}ms window.`} ${pollHint}`,
    };

    jobQueue.completeJob(job.id, finalResult);
    return finalResult;
  } catch (err) {
    try { await takeScreenshot(getPage(), 'generate-confirm-error'); } catch { /* ok */ }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
