import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { insertMentionReferences } from '../navigation/mentions.js';
import { get } from '../utils/config.js';
import { ensureManualMode, configurePromptBar, setPromptBarModel, readToolState, attachReferenceFiles } from '../browser/safe-actions.js';
import { resolveModel, getUniverse } from '../utils/models.js';

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
    return requested || get('defaultRatio', '16:9');
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
    ratio: args.ratio || '16:9',
    auto_confirm: autoConfirm,
    quantity: qty,
    outputFolder: args.output_folder,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    useTool: args.use_tool,
    references: args.references,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // STEP 1: Ensure we're in a project context
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

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
    // match aria-labels first, text only as fallback.
    const hasGenerateBtn = await page.locator(
      'button[aria-label*="Start generation" i], button[aria-label*="Generate" i], button[aria-label*="Create" i], button[aria-label*="Send" i], button[type="submit"], button:has-text("Generate"), button:has-text("Create")'
    ).first().isVisible().catch(() => false);
    if (!hasGenerateBtn) {
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
    await promptInput.fill('');
    await page.waitForTimeout(200);
    await promptInput.type(prompt, { delay: 15 });
    logger.info('Prompt filled', { promptLength: prompt.length });
    await page.waitForTimeout(500);
    const filledText = await promptInput.textContent().catch(() => '')
      || await promptInput.inputValue().catch(() => '');
    if (!filledText || !filledText.includes(prompt.slice(0, 40))) {
      await takeScreenshot(page, 'prompt-fill-unverified');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Prompt fill could not be verified in the input (read-back mismatch). Refusing to continue.',
        { expectedHead: prompt.slice(0, 40), actualHead: String(filledText).slice(0, 80) });
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
      attached: refAttach.inputAccepted,
      verified: refAttach.verified,
      notes: refAttach.notes,
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
    const mentionNames = Array.isArray(args.ingredients) ? args.ingredients : [];
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

    // ⚠️ STEP 7: DECISION POINT — auto_confirm determines if we click Generate
    if (!autoConfirm) {
      // SAFE MODE: Setup only, no click. Return "ready_for_confirmation".
      const setupScreenshot = await takeScreenshot(page, 'image-ready-for-confirmation');
      const result = {
        status: 'ready_for_confirmation',
        type: 'image',
        message: '✅ Prompt, model and ratio are ready. No credits consumed. ' +
          'To generate and consume credits, call again with auto_confirm=true.',
        model_used: model,
        ratio,
        prompt,
        ingredients_inserted: mentionResults.inserted,
        ingredients_failed: mentionResults.failed,
        references,
        account: get('expectedAccount'),
        screenshot: setupScreenshot,
        jobId: job.id,
      };
      jobQueue.completeJob(job.id, result);
      return result;
    }

    // 🛡️ SAFETY: Pre-generation screenshot verification
    logger.info('⚠️ auto_confirm=true — running safety checks before clicking Generate');
    const preGenScreenshot = await takeScreenshot(page, 'pre-generate-verification');

    // STEP 8: Find generate button
    const generateBtnLocator = page.locator(
      'button[aria-label*="Start generation" i], ' +
      'button[aria-label*="Generate" i], ' +
      'button[aria-label*="Create" i], ' +
      'button[aria-label*="Send" i], ' +
      'button[type="submit"], ' +
      'button:has-text("Generate")'
    ).first();
    const generateBtnVisible = await generateBtnLocator.isVisible().catch(() => false);
    if (!generateBtnVisible) {
      await takeScreenshot(page, 'no-generate-btn');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not found');
    }

    const isDisabled = await generateBtnLocator.isDisabled().catch(() => false);
    if (isDisabled) {
      await takeScreenshot(page, 'generate-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled');
    }

    // STEP 10: Click generate ⚠️ CREDITS WILL BE CONSUMED
    logger.info('⚠️⚠️⚠️ Clicking Generate — credits will be consumed');
    await generateBtnLocator.click();

    // STEP 11: Handle two possible generation flows:
    //   A) Agent-mediated: Agent asks "Accept?" before generating (when switching modes)
    //   B) Direct: generation starts immediately (most common)
    // Try Agent first (short wait), fall through to direct if not detected

    let flowMode = 'direct';
    logger.info('Checking for Agent confirmation dialog (5s window)...');
    const acceptTimeoutMs = get('agentResponseTimeoutMs', get('generationPollIntervalMs', 5000));
    const acceptStart = Date.now();

    while (Date.now() - acceptStart < acceptTimeoutMs) {
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (pageText.includes('Accept') || pageText.includes('Approve')) {
        logger.info('Agent confirmation dialog detected — switching to Agent flow');
        const acceptBtn = page.locator('button').filter({ hasText: /Accept|Approve/ }).first();
        await acceptBtn.click();
        logger.info('Generation confirmed via Agent');
        flowMode = 'agent';
        break;
      }
      await page.waitForTimeout(500);
    }

    logger.info('Generation flow', { mode: flowMode });

    // STEP 12: Wait for images to appear in the DOM
    logger.info('Waiting for generated images...');
    let generatedImageUuids = [];
    const genTimeoutMs = get('generationTimeoutMs', get('jobTimeoutMs', 120000));
    const genStart = Date.now();
    let lastProgressLog = 0;

    while (Date.now() - genStart < genTimeoutMs) {
      await page.waitForTimeout(2000);

      const imageUuids = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const uuids = [];
        imgs.forEach(img => {
          const src = img.src || '';
          const match = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
          if (match && img.width > 100) {
            uuids.push(match[1]);
          }
        });
        return [...new Set(uuids)];
      });

      if (imageUuids.length > 0) {
        generatedImageUuids = imageUuids;
        logger.info('Generated images detected in DOM', { count: imageUuids.length });
        break;
      }

      const hasDownload = await page.locator(
        'text=Download, [aria-label*="download" i]'
      ).first().isVisible().catch(() => false);
      if (hasDownload) {
        logger.info('Download button appeared after generation');
        break;
      }

      if (Date.now() - lastProgressLog >= 30000) {
        lastProgressLog = Date.now();
        logger.info('Still waiting for images...', { elapsed: Date.now() - genStart });
        await takeScreenshot(page, `gen-wait-${Math.round((Date.now() - genStart) / 1000)}s`);
      }
    }

    if (generatedImageUuids.length === 0) {
      await takeScreenshot(page, 'no-images-detected');
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT,
        'Generation completed but no images were detected in the DOM. ' +
        'Check the Flow project content library.');
    }

    // STEP 13: Images are in the project — no download needed.
    // Return the project URL and image UUIDs so the user can view them in the browser.
    const projectUrl = page.url();
    const imageUrls = generatedImageUuids.map(
      uuid => `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${uuid}`
    );

    saveMetadata(job.id, {
      type: 'image',
      model,
      ratio,
      auto_confirm: true,
      quantity: qty,
      prompt,
      ingredients_requested: mentionNames,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      references,
      jobId: job.id,
      imageUuids: generatedImageUuids,
      projectUrl,
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'image',
      account: get('expectedAccount'),
      model_used: model,
      ratio,
      prompt,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      references,
      image_count: generatedImageUuids.length,
      image_uuids: generatedImageUuids,
      image_urls: imageUrls,
      project_url: projectUrl,
      credits_consumed: true,
      message: `${generatedImageUuids.length} image(s) generated. View them in the project: ${projectUrl}`,
    });

    return jobQueue.getJob(job.id).result;
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
