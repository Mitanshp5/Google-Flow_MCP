import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';

import { ensureProjectInContext, extractProjectId } from '../navigation/project-navigator.js';
import { insertMentionReferences, collectMentionNames } from '../navigation/mentions.js';
import { get, getFlowHome } from '../utils/config.js';
import { ensureManualMode, configurePromptBar, setPromptBarModel, readToolState, attachReferenceFiles, findActionButton, GENERATE_BUTTON_SELECTORS } from '../browser/safe-actions.js';
import { resolveModel, getUniverse, isModelLiveVerified } from '../utils/models.js';
import { resolveSafePath } from '../utils/sanitize.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';
import { createOperationStore } from '../domain/operations.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { parseCostLabel } from '../browser/cost-quote.js';
import { executeDurableSubmission } from '../domain/submission-adapter.js';
import { buildHandlerSubmissionContext } from '../domain/handler-submission-context.js';
import { createLiveAuthorization } from '../domain/live-submission.js';
import fs from 'fs';

function selectModel(requested) {
  // Dynamic universe: user config ∪ live discovery ∪ fallback — no frozen list.
  const r = resolveModel(requested, 'image');
  return r ? r.name : null;
}

function availableImageModels() {
  return getUniverse().imageModels;
}

function selectRatio(requested) {
  const ratios = getUniverse().ratios;
  if (!requested || ratios.map(r => r.toLowerCase()).includes(String(requested).toLowerCase())) {
    return requested || get('defaultImageRatio', '1:1');
  }
  return null;
}

export async function handleGenerateImage(args) {
  if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt is required and must be a non-empty string');
  }
  const prompt = args.prompt.trim();
  if (prompt.length > 8000) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt must be ≤ 8000 characters');
  }
  const qty = Math.min(Math.max(Number(args.quantity) || 1, 1), 4);
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('image_generation', {
    prompt,
    model: args.model || 'auto',
    ratio: args.ratio || get('defaultImageRatio', '1:1'),
    auto_confirm: autoConfirm,
    quantity: qty,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    references: args.references,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    return await withUiTransaction(async ({ epoch }) => {
    assertUiCurrent(epoch);

    // STEP 1: Ensure we're in a project context
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
      project_url: args.project_url,
    });
    const liveAuthorization = await createLiveAuthorization({ page, confirmed: autoConfirm, maxCredits: args.max_credits });

    // Agent mode hijacks the prompt box — turn it OFF every run, verified.
    try {
      await ensureManualMode(page);
    } catch (e) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, e.message);
    }

    // STEP 2: Model selection (dynamic universe, before UI interaction)
    const model = selectModel(args.model);
    if (!model) {
      const available = availableImageModels();
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Model "${args.model}" not available. Available: ${available.join(', ')} (or auto; refresh via flow_list_models)`,
        { requested: args.model, available });
    }
    logger.info('Using model', { model });

    // 🛡️ SAFETY: Verify model is an IMAGE model, NOT a video model
    const universe = getUniverse();
    if (!universe.imageModels.map(m => m.toLowerCase()).includes(model.toLowerCase())) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 SAFETY BLOCK: "${model}" is a VIDEO model, not an IMAGE model. ` +
        `Use flow_generate_video for videos. Image models: ${universe.imageModels.join(', ')}`);
    }
    if (universe.videoModels.map(m => m.toLowerCase()).includes(model.toLowerCase())) {
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `🚨 SAFETY BLOCK: "${model}" is also a VIDEO model. ` +
        `Refusing to generate to avoid consuming video credits. Image models: ${universe.imageModels.join(', ')}`);
    }

    // STEP 3: Ratio selection
    const ratio = selectRatio(args.ratio);
    if (!ratio) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE,
        `Ratio "${args.ratio}" not available. Available: ${get('ratios', []).join(', ')}`);
    }

    // STEP 4: Drive the bottom prompt bar with the proven primitives
    // (one-open batch + settings-row model verify). Warn-only in
    // prepare-only (no spend); strict on the paid path.
    const liveRun = autoConfirm === true;
    const barSets = await configurePromptBar(page, { mode: 'Image', ratio, quantity: qty });
    const modelRes = await setPromptBarModel(page, model);
    const barAll = [...barSets, modelRes];
    logger.info('Prompt-bar setup results', { barSets: barAll.map(s => `${s.kind}=${s.detail}`) });
    const barFailed = barAll.filter(s => !s.ok);
    if (barFailed.length > 0) {
      await takeScreenshot(page, 'image-bar-setup-mismatch');
      const msg = `Prompt-bar setup failed: ${barFailed.map(s => `${s.kind} (${s.detail})`).join('; ')}. Set them manually in Flow's bottom bar, then retry. No credits spent.`;
      if (liveRun) throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, msg, { barSets: barAll });
      logger.warn(`Bar setup unverified — continuing prepare-only. ${msg}`);
    }
    const postState = await readToolState(page);
    logger.info('Tool state after image bar setup', postState);

    // SAFETY: refuse the paid click unless the UI confirms IMAGE mode
    // (never spend video credits from the image tool).
    if (liveRun && postState.mode !== 'image') {
      await takeScreenshot(page, 'image-mode-unverified');
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
        `Refusing live Generate: UI is not in image mode (mode=${postState.mode}, chip=${postState.modelChip || 'none'}). Switch to Image in the bottom bar, then retry. No credits spent.`,
        { toolState: postState });
    }

    // Also verify the generate button exists (confirms the toolbar is active).
    // NOTE: Flow's submit uses a Material icon glyph, not literal text —
    // aria-first ordered lookup (P1-4); warn-only here, the live path below
    // fails closed on a miss.
    const foundBtn = await findActionButton(page, GENERATE_BUTTON_SELECTORS);
    if (!foundBtn) {
      logger.warn('Generate button not visible on project page');
    }

    // STEP 5: Find the prompt input (contenteditable div at bottom toolbar)
    let promptInput = null;

    const promptCandidates = [
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ];

    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        logger.info('Found prompt input on page');
        break;
      }
    }

    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find prompt input field inside the project. ' +
        'The Flow UI may have changed. Expected [contenteditable] or textarea.'
      );
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // STEP 6: Fill the prompt + READ BACK to verify it landed.
    await promptInput.click();
    await promptInput.fill(prompt);
    logger.info('Prompt filled', { promptLength: prompt.length });
    await page.waitForTimeout(500);
    const filledText = await promptInput.textContent().catch(() => '')
      || await promptInput.inputValue().catch(() => '');
    const normalizedExpected = prompt.replace(/\s+/g, ' ').trim();
    const normalizedActual = String(filledText).replace(/\s+/g, ' ').trim();
    if (!normalizedActual || normalizedActual !== normalizedExpected) {
      await takeScreenshot(page, 'prompt-fill-unverified');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Prompt fill could not be verified in the input (read-back mismatch). Refusing to continue.',
        { expected: prompt, actual: String(filledText) });
    }

    // P0-1: upload local reference_images BEFORE @ mentions (previously a
    // silent no-op: the schema advertised them but the handler never read them).
    // Missing/unreadable paths throw here (fail fast) rather than being ignored.
    const refPaths = [];
    if (Array.isArray(args.reference_images) && args.reference_images.length > 0) {
      for (const p of args.reference_images) {
        let abs;
        try {
          abs = resolveSafePath(p);
        } catch (e) {
          throw new FlowError(ErrorCodes.INVALID_PARAMS, `reference_images[] invalid path: ${p} (${e.message})`);
        }
        let stat = null;
        try {
          stat = fs.statSync(abs);
        } catch {
          stat = null;
        }
        if (!stat || !stat.isFile()) {
          throw new FlowError(ErrorCodes.INVALID_PARAMS, `reference_images[] not found: ${p}`);
        }
        if (stat.size > 25 * 1024 * 1024) {
          throw new FlowError(ErrorCodes.INVALID_PARAMS, `reference_images[] must be an image file ≤ 25MB: ${p}`);
        }
        refPaths.push(abs);
      }
    }
    const refAttach = await attachReferenceFiles(page, promptInput, refPaths, { label: 'reference_images' });
    const references = {
      requested: refAttach.requested,
      attached: refAttach.attached,
      input_accepted: refAttach.inputAccepted,
      verified: refAttach.verified,
      notes: refAttach.notes,
      ...(refAttach.reason ? { reason: refAttach.reason } : {}),
    };
    if (refPaths.length > 0 && !refAttach.verified) {
      const msg = `Reference images requested but not all landed in the composer (input accepted ${refAttach.inputAccepted}/${refPaths.length}). No credits spent.`;
      if (liveRun) {
        throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
          `${msg} Attach them manually in Flow, then retry with auto_confirm=true.`,
          { references });
      }
      logger.warn(`Continuing prepare-only with unverified references. ${msg}`, { references });
    }

    // Insert "@" references for any existing images/characters to use as ingredients.
    // Flow opens a popup when "@" is typed, listing project images and characters.
    // P0-6: use_character/use_scene/references resolve exactly like ingredients.
    const mentionNames = collectMentionNames(args);
    let mentionResults = { inserted: [], failed: [] };
    if (mentionNames.length > 0) {
      mentionResults = await insertMentionReferences(page, promptInput, mentionNames);
      if (mentionResults.failed.length > 0) {
        logger.warn('Some @ mention references could not be inserted', {
          failed: mentionResults.failed,
        });
      }
      await page.waitForTimeout(300);
    }

    // Positive evidence required for every required field
    const modelVerified = Boolean(
      postState?.model &&
      (postState.model.toLowerCase() === model.toLowerCase() || isModelLiveVerified(model, postState.model))
    );
    const ratioVerified = Boolean(postState?.ratio && postState.ratio === ratio);
    const quantityVerified = Boolean(postState?.quantity && postState.quantity === qty);

    // Failed required references must prevent readiness
    const refImagesOk = refPaths.length === 0 || Boolean(refAttach?.verified);
    const mentionsOk = mentionNames.length === 0 || (mentionResults.failed.length === 0 && mentionResults.inserted.length >= mentionNames.length);
    const referencesVerified = refImagesOk && mentionsOk;

    const isReady = modelVerified && ratioVerified && quantityVerified && referencesVerified;

    const settingsVerification = {
      requested: { model, ratio, quantity: qty },
      actual: {
        model: postState?.model || null,
        ratio: postState?.ratio || null,
        quantity: postState?.quantity || null,
      },
      verified: isReady,
      references_verified: referencesVerified,
    };

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: isReady ? 'ready_for_confirmation' : 'prepared_unverified',
        type: 'image',
        message: isReady
          ? '✅ Prompt, model and ratio are prepared. No credits consumed. ' +
            'To generate and consume credits, call again with auto_confirm=true.'
          : '⚠️ Image setup completed with unverified settings or references. Review UI state before confirming.',
        model_used: model,
        ratio,
        quantity: qty,
        prompt,
        settings_verification: settingsVerification,
        ingredients_inserted: mentionResults.inserted,
        ingredients_failed: mentionResults.failed,
        references: {
          ...references,
          verified: referencesVerified,
        },
        account: extractObservedAccount(await page.content()),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      assertUiCurrent(epoch);
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // Live submission path: auto_confirm=true requested.
    // Must extract verified observed bindings from actual page state.
    // Unverified or missing bindings fail closed (denied).
    assertUiCurrent(epoch);

    const pageHtml = await page.content().catch(() => '');
    let observedAccount = extractObservedAccount(pageHtml);
    if (!observedAccount && !pageHtml) {
      try {
        const fallbackHtml = await page.evaluate(() => document.documentElement?.outerHTML || '').catch(() => '');
        observedAccount = extractObservedAccount(fallbackHtml);
      } catch { /* ignore */ }
    }

    const currentUrl = page.url() || '';
    const observedProjectId = extractProjectId(currentUrl);
    const verifiedSettings = settingsVerification?.verified ? settingsVerification.actual : null;

    const baselineIds = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const ids = [];
      imgs.forEach(img => {
        const src = img.src || '';
        const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
        if (match) ids.push(match[1]);
      });
      return [...new Set(ids)];
    }).catch(() => []);
    const baseline = { ids: baselineIds, observedAt: Date.now() };

    const costText = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      for (const el of els) {
        const text = (el.innerText || el.textContent || '').trim();
        if (/generating will use \d+ credits|\d+\s*credits?/i.test(text) && text.length < 60) {
          return text;
        }
      }
      return null;
    }).catch(() => null);

    let quote = null;
    if (costText) {
      const parsed = parseCostLabel(costText, { quantity: qty });
      if (parsed.state === 'known') {
        quote = {
          total: parsed.totalUpperBound,
          unit: parsed.unit,
          quantity: parsed.quantity,
          raw: parsed.raw,
          observedAt: Date.now(),
        };
      }
    }

    // Delegate to W05 submission adapter: enforces verified bindings,
    // checks UI transaction epoch, runs atomic durable commit (commitPreInvocation),
    // records the invocation boundary before an explicitly authorized click.
    const requestPayload = { prompt, model, ratio, quantity: qty, type: 'image' };
    const submissionContext = await buildHandlerSubmissionContext({ page, epoch, requestPayload, inputLocator: promptInput, refs: refPaths, mentionNames, liveAuthorization });
    const submitted = await executeDurableSubmission({
      page,
      epoch,
      opStore: createOperationStore(getFlowHome()),
      requestPayload,
      observedAccount,
      observedProjectId,
      verifiedSettings,
      refs: refPaths,
      baseline,
      quote,
      ...submissionContext,
    });
    jobQueue.completeJob(job.id, submitted);
    return { ...submitted, jobId: job.id };
    }); // end withUiTransaction
  } catch (err) {
    try {
      await takeScreenshot(getPage(), 'generate-image-error');
    } catch (screenshotErr) {
      logger.warn('Could not take error screenshot (browser likely disconnected)', { error: screenshotErr.message });
    }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
