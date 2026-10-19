import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, configureGenerationUI, configurePromptBar, ensureManualMode, readToolState, attachReferenceFiles, setPromptBarMode, setPromptBarModel } from '../browser/safe-actions.js';
import { saveMetadata, getOutputDir } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { insertMentionReferences, collectMentionNames } from '../navigation/mentions.js';
import { buildVideoPrompt, checkPromptContradictions, normalizeDuration } from '../utils/prompt.js';
import { resolveSafePath } from '../utils/sanitize.js';
import { getSelectors } from '../utils/selectors.js';
import { get, getFlowHome } from '../utils/config.js';
import { resolveModel, getUniverse, resolveIngredientsDuration } from '../utils/models.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';
import { createOperationStore } from '../domain/operations.js';
import { extractProjectId } from '../navigation/project-navigator.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { parseCostLabel } from '../browser/cost-quote.js';
import { executeDurableSubmission } from '../domain/submission-adapter.js';
import { buildHandlerSubmissionContext } from '../domain/handler-submission-context.js';
import { createLiveAuthorization } from '../domain/live-submission.js';
import {setVideoReferenceMode, attachVideoFrame} from '../browser/video-frames.js';
import fs from 'fs';
import path from 'path';

function selectVideoModel(requested) {
  // Dynamic universe: user config ∪ live discovery ∪ fallback — no frozen list.
  const r = resolveModel(requested, 'video');
  return r ? r : null;
}

export function isVideoPreparationVerified({ settingsVerified, attachVerified, frames = {}, failedMentions = [], failedSettings = [] }) {
  return settingsVerified === true && attachVerified === true
    && Object.values(frames).every(frame => frame.verified === true)
    && failedMentions.length === 0 && failedSettings.length === 0;
}

/**
 * Pure live-poll ceiling (P1-1), unit-tested. The job watchdog
 * (jobTimeoutMs) fires on its own timer while the handler polls, so the
 * ceiling stays strictly under an active watchdog (30s margin): the handler
 * always settles first and the terminal-state guards stay a backstop.
 * No config defaults are changed here — this only reads them.
 */
export function resolveVideoPollCeilingMs({ generationTimeoutMs = 120000, jobTimeoutMs = 300000 } = {}) {
  const floor = Math.max(Number(generationTimeoutMs) || 0, 360000);
  if (!Number.isFinite(Number(jobTimeoutMs)) || Number(jobTimeoutMs) <= 0) return floor;
  return Math.max(0, Math.min(floor, Number(jobTimeoutMs) - 30000));
}

function resolveFrame(p, label) {
  if (!p) return null;
  const abs = resolveSafePath(p);
  if (!fs.existsSync(abs)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `${label} not found: ${p}. In JSON or JavaScript tool calls, use forward slashes (C:/folder/image.jpg) or escape each backslash.`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `${label} must be an image file ≤ 25MB`);
  }
  return abs;
}


export async function handleGenerateVideo(args) {
  if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt is required and must be a non-empty string');
  }
  if (args.prompt.trim().length > 8000) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt must be ≤ 8000 characters');
  }
  // Prompt scaffold: scene+action only, optics in UI selectors.
  const prompt = buildVideoPrompt({ prompt: args.prompt, camera: args.camera, style: args.style });
  const durations = get('durations', ['4s', '6s', '8s', '10s']);
  const rawDuration = args.duration ?? '4s';
  const requestedDuration = typeof rawDuration === 'number' ? `${rawDuration}s` : String(rawDuration);
  const durationOk = normalizeDuration(requestedDuration, durations);
  // Frames + ingredients planning before job creation (fail fast, no browser needed).
  const startFrame = resolveFrame(args.start_frame || args.hero_frame, 'start_frame');
  const endFrame = resolveFrame(args.end_frame, 'end_frame');
  const anchorFrame = args.anchor_frame ? resolveFrame(args.anchor_frame, 'anchor_frame') : null;
  const frameStart = startFrame || anchorFrame;
  const hasFrames = Boolean(frameStart || endFrame);
  const refPaths = [frameStart, endFrame].filter(Boolean);
  const uploadRefs = Array.isArray(args.reference_images) ? args.reference_images : [];
  const resolvedUploads = [];
  for (const p of uploadRefs) {
    resolvedUploads.push(resolveFrame(p, 'reference_images[]'));
  }
  // P0-6: shared @name collection (same order/semantics as the image tool).
  const mentionNames = collectMentionNames(args);
  if (hasFrames && (resolvedUploads.length || mentionNames.length)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Flow Frames and Ingredients are separate modes. Use start/end frames OR reference_images/ingredients, not both.');
  }
  if (startFrame && anchorFrame && startFrame !== anchorFrame) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'anchor_frame is a fallback start frame; it cannot differ from an explicit start_frame.');
  }
  if (mentionNames.length > 3) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Flow supports max 3 ingredients per prompt; got ${mentionNames.length}. Trim to the 3 strongest (face + location + prop/style).`);
  }
  const job = jobQueue.createJob('video_generation', {
    prompt,
    raw_prompt: args.prompt.trim(),
    camera: args.camera,
    style: args.style,
    model: args.model || 'auto',
    ratio: args.ratio || '16:9',
    duration: requestedDuration,
    quality: args.quality || get('defaultQuality', '720p'),
    quantity: args.quantity || 1,
    useCharacter: args.use_character,
    useScene: args.use_scene,
    references: args.references,
    reference_images: resolvedUploads,
    ingredients: mentionNames,
    start_frame: startFrame,
    end_frame: endFrame,
    anchor_frame: anchorFrame,
    shots: Array.isArray(args.shots) ? args.shots : null,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    return await withUiTransaction(async ({ epoch }) => {
    assertUiCurrent(epoch);

    // Ensure we're in a project context
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
      project_url: args.project_url,
    });

    // Agent mode hijacks the prompt box — turn it OFF every run, verified.
    try {
      await ensureManualMode(page);
    } catch (e) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, e.message);
    }
    const preState = await readToolState(page);
    logger.info('Tool state before video prep', preState);

    // Select model + capability gate (dynamic universe; unknown models get
    // conservative caps and fail closed on ingredients).
    const resolved = selectVideoModel(args.model);
    if (!resolved) {
      const available = getUniverse().videoModels;
      throw new FlowError(ErrorCodes.MODEL_NOT_AVAILABLE,
        `Video model "${args.model}" not available. Available: ${available.join(', ')} (or auto; refresh via flow_list_models)`,
        { requested: args.model, available });
    }
    const model = resolved.name;
    const caps = resolved.caps;
    if (mentionNames.length > 0 && !caps.ingredients) {
      // No static caps table for brand-new models (e.g. Omni 1.1 Flash) —
      // the live UI is the arbiter. Attempt the @-insert, which fails closed
      // on its own (zero inserts block before any paid click).
      logger.warn('Model caps say no ingredients — attempting anyway, UI decides', { model, ingredients: mentionNames });
    }
    logger.info('Using video model (dynamic universe)', { model, requested: args.model || 'auto', from: resolved.from });
    const liveRun = args.confirm_generate === true;

    // Try to find video UI — look for textarea, selectors, etc.
    const elements = await detectPageElements(page);
    logger.info('Page elements in project for video', {
      buttons: elements.buttons.length,
      inputs: elements.inputs.length,
    });

    // Find prompt input from the dynamic selector registry — try current view
    // first, then navigate sidebar.
    let promptInput = null;
    const promptCandidates = getSelectors('promptInput').map(sel => page.locator(sel).first());

    for (const candidate of promptCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        promptInput = candidate;
        break;
      }
    }

    if (!promptInput) {
      logger.info('No prompt found on current view, trying sidebar navigation');
      await navigateToSidebar(page, 'Tools');
      await page.waitForTimeout(2000);

      for (const candidate of promptCandidates) {
        if (await candidate.isVisible().catch(() => false)) {
          promptInput = candidate;
          break;
        }
      }
    }

    if (!promptInput) {
      await takeScreenshot(page, 'no-prompt-input-video');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Could not find prompt input for video');
    }

    // Select ratio
    const ratios = get('videoRatios', ['9:16', '16:9']);
    const ratio = args.ratio || '16:9';
    if (!ratios.includes(ratio)) {
      throw new FlowError(ErrorCodes.RATIO_NOT_AVAILABLE, `Ratio ${ratio} not available for video`);
    }

    // Select duration: Ingredients to Video requires 8s; duration mismatch fails fast.
    if (!durationOk) {
      const allowed = get('durations', ['4s', '6s', '8s', '10s']);
      throw new FlowError(ErrorCodes.INVALID_PARAMS,
        `Duration "${requestedDuration}" not available. Available: ${allowed.join(', ')}`,
        { requested: requestedDuration, available: allowed });
    }
    // P1-2: ingredients duration gate lives in the capability system, not a
    // hardcoded model-blind check. Every model still resolves to the
    // conservative '8s' force today (identical behavior); P1-3 discovery may
    // relax per-model values once verified against the live UI.
    const durationDecision = resolveIngredientsDuration(caps, requestedDuration, mentionNames.length > 0);
    const effectiveDuration = durationDecision.duration;
    if (durationDecision.forced) {
      logger.warn('Ingredients to Video requires 8s for this model — overriding duration', { requested: requestedDuration, model });
    }

    const qty = Math.min(Math.max(Number(args.quantity) || 1, 1), 4);
    const warnings = checkPromptContradictions({ prompt: args.prompt, ingredients: mentionNames, startFrame, endFrame });
    for (const w of warnings) logger.warn('Prompt QC', { warning: w });

    // Drive the bottom prompt bar directly (user-verified map: Image/Video,
    // ratios, model row, x1..x4, 360p/720p, 4s/6s/8s/10s). ORDER MATTERS:
    // mode first (switching resets the model), then model (it determines
    // which option rows the panel shows), then the rest in one batch.
    // Strict in the live path (paid click), warn-only in prepare-only.
    // Before prompt fill (open pickers block the input).
    const liveQualities = getUniverse().qualities || [];
    const wantQuality = args.quality || get('defaultQuality', '720p');
    const quality = liveQualities.find(q => String(q).toLowerCase() === String(wantQuality).toLowerCase());
    const modeRes = await setPromptBarMode(page, 'Video');
    const referenceModeRes = hasFrames || resolvedUploads.length || mentionNames.length
      ? await setVideoReferenceMode(page, hasFrames ? 'frames' : 'ingredients') : null;
    const modelRes = await setPromptBarModel(page, model);
    const barSets = [
      modeRes, ...(referenceModeRes ? [referenceModeRes] : []), modelRes,
      ...(quality ? [] : [{ ok: false, verified: false, kind: 'quality', detail: `quality "${wantQuality}" not in live list (${liveQualities.join('/')})` }]),
      ...await configurePromptBar(page, {
        ratio, quantity: qty,
        ...(quality ? { quality } : {}),
        duration: effectiveDuration,
      }),
    ];
    logger.info('Prompt-bar setup results', { barSets: barSets.map(s => `${s.kind}=${s.detail}`) });
    const barFailed = barSets.filter(s => !s.ok);
    if (barFailed.length > 0) {
      await takeScreenshot(page, 'bar-setup-mismatch');
      const msg = `Prompt-bar setup failed: ${barFailed.map(s => `${s.kind} (${s.detail})`).join('; ')}. Set them manually in Flow's bottom bar, then retry. No credits spent.`;
      if (liveRun) throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, msg, { barSets });
      logger.warn(`Bar setup unverified — continuing prepare-only. ${msg}`);
    }

    // Enforce the settings actively in the UI — warn (not throw) in prepare-only
    // mode: no credits are spent, and the new Flow chat UI may not expose
    // classic mode/ratio/duration tabs until a prompt is entered. Live
    // generation (auto_confirm=true) must throw on mismatch instead.
    // The current prompt-bar driver already read back every setting. Do not
    // run the obsolete tab driver over a verified radio-button UI and emit
    // false "tab not found" errors (or mutate the settings a second time).
    const uiResult = barSets.every(s => s.ok && s.verified)
      ? {ok:true, verified:barSets.map(s=>s.kind), failures:[]}
      : await configureGenerationUI({
      mode: 'Video',
      ratio,
      model,
      duration: effectiveDuration,
      quantity: qty
    });
    const uiSkipped = uiResult && uiResult.ok === false ? uiResult.failures : [];
    if (uiSkipped.length > 0) {
      await takeScreenshot(page, 'video-ui-mismatch');
      logger.warn('Generation UI settings unverified — continuing prepare-only', { failures: uiSkipped });
    }

    // F04: Read back tool settings from UI and verify requested vs actual
    const postToolState = await readToolState(page).catch(() => null);
    const settingsVerification = {
      requested: { duration: effectiveDuration, quality: wantQuality, ratio, quantity: qty },
      actual: {
        duration: postToolState?.duration || null,
        quality: postToolState?.quality || null,
        ratio: postToolState?.ratio || null,
        quantity: postToolState?.quantity || null,
      },
      verified: true,
    };
    if (postToolState?.duration !== effectiveDuration) {
      settingsVerification.verified = false;
      warnings.push(`Duration read-back mismatch: requested ${effectiveDuration}, UI shows ${postToolState?.duration || 'none'}`);
    }
    if (wantQuality && postToolState?.quality !== wantQuality.toLowerCase()) {
      settingsVerification.verified = false;
      warnings.push(`Quality read-back mismatch: requested ${wantQuality}, UI shows ${postToolState?.quality || 'none'}`);
    }
    if (postToolState?.ratio !== ratio) {
      settingsVerification.verified = false;
      warnings.push(`Ratio read-back mismatch: requested ${ratio}, UI shows ${postToolState?.ratio || 'none'}`);
    }
    if (postToolState?.quantity !== qty) {
      settingsVerification.verified = false;
      warnings.push(`Quantity read-back mismatch: requested ${qty}, UI shows ${postToolState?.quantity || 'none'}`);
    }

    // Fill prompt (scaffolded) + READ BACK to verify it actually landed.
    await promptInput.click();
    await promptInput.fill(prompt);
    await page.waitForTimeout(500);
    const filledText = await promptInput.textContent().catch(() => '')
      || await promptInput.inputValue().catch(() => '');
    const normalizedExpected = prompt.replace(/\s+/g, ' ').trim();
    const normalizedActual = String(filledText).replace(/\s+/g, ' ').trim();
    if (!normalizedActual || normalizedActual !== normalizedExpected) {
      await takeScreenshot(page, 'prompt-fill-unverified');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Prompt fill could not be verified in the input (read-back mismatch). Refusing to continue with wrong/empty prompt.',
        { expected: prompt, actual: String(filledText) });
    }
    logger.info('Prompt fill verified via read-back', { chars: filledText.length });

    // P0-2: attach frames + reference uploads with read-back (previously
    // fire-and-forget with only a manual-slot warning). attachVerified gates
    // the live paid click below; prepare-only only warns.
    const frameNotes = [];
    const frameFiles = [...refPaths, ...resolvedUploads];
    let attachAccepted = 0;
    let attachVerified = true;
    const attachmentResults = {};
    if (hasFrames) {
      for (const [slot, file] of [['start', frameStart], ['end', endFrame]]) {
        if (!file) continue;
        const attach = referenceModeRes?.verified
          ? await attachVideoFrame(page, file, slot)
          : {verified:false, notes:['Frames mode selection failed; no frame upload attempted'], acknowledged:[]};
        attachmentResults[slot] = attach;
        attachAccepted += attach.inputAccepted || 0;
        attachVerified = attachVerified && attach.verified;
        frameNotes.push(...(attach.notes || []));
      }
    } else if (frameFiles.length > 0) {
      const attach = await attachReferenceFiles(page, promptInput, frameFiles, { label: 'frames' });
      attachmentResults.ingredients = attach;
      attachAccepted = attach.inputAccepted;
      attachVerified = attach.verified;
      frameNotes.push(...attach.notes);
      logger.info('Frames/references attach result', { accepted: attachAccepted, verified: attachVerified });
    }

    // Per-file stable identity AND placement proof. An uploaded ingredient
    // never counts as a start/end frame without its explicit slot acknowledgement.
    const frameVerification = {};
    const pushFrameEntry = (key, abs, slot = 'ingredients') => {
      if (!abs) return;
      const result = attachmentResults[slot];
      const ack = result?.acknowledged?.find(a => a.name === path.basename(abs));
      const verified = result?.verified === true && !!ack?.assetId && (slot === 'ingredients' || ack.slot === slot);
      frameVerification[key] = {
        requested: path.basename(abs),
        slot_detected: verified ? (slot === 'ingredients' ? 'ingredient' : slot) : 'unknown',
        assetId: ack?.assetId || null,
        upload_verified: result?.verified === true,
        verified,
      };
    };
    pushFrameEntry('start_frame', startFrame, 'start');
    pushFrameEntry('end_frame', endFrame, 'end');
    pushFrameEntry('anchor_frame', anchorFrame, 'start');
    resolvedUploads.forEach((f, i) => pushFrameEntry(`reference_images[${i}]`, f));

    // Insert "@" references — fail closed: zero inserts with required names blocks.
    let mentionResults = { inserted: [], failed: [] };
    if (mentionNames.length > 0) {
      mentionResults = await insertMentionReferences(page, promptInput, mentionNames);
      if (mentionResults.inserted.length === 0) {
        await takeScreenshot(page, 'mention-all-failed');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          `None of the ${mentionNames.length} ingredient(s) could be inserted (${mentionNames.join(', ')}). Use flow_list_mention_options to discover exact @names; refusing mismatched paid generation.`,
          { requested: mentionNames, failed: mentionResults.failed });
      }
      if (mentionResults.failed.length > 0) {
        logger.warn('Some @ mention references could not be inserted', { failed: mentionResults.failed });
      }
      await page.waitForTimeout(300);
    }

    // Multi-shot plan (prepare-only): scaffold per-shot prompts, carry anchor forward.
    let shotPlan = null;
    if (Array.isArray(args.shots) && args.shots.length > 0) {
      if (args.shots.length > 6) {
        throw new FlowError(ErrorCodes.INVALID_PARAMS, 'shots supports max 6 per plan (Kling-style storyboard cap).');
      }
      shotPlan = args.shots.map((s, i) => ({
        index: i + 1,
        prompt: buildVideoPrompt({ prompt: s.prompt, camera: args.camera, style: args.style }),
        duration: s.duration ? (typeof s.duration === 'number' ? `${s.duration}s` : String(s.duration)) : effectiveDuration,
        anchor: i === 0 ? (anchorFrame || startFrame) : `shot-${i}-strongest-frame (carry forward)`,
      }));
    }

    // Ensure output dir exists for eventual downloads.
    let outputDir = null;
    try {
      outputDir = getOutputDir('video');
    } catch { /* ignore */ }

    // Video generation is paid — setup only, no click (unless explicitly confirmed)
    logger.info('Video generation setup complete — not clicking generate (paid feature)');
    await takeScreenshot(page, 'video-ready-to-generate');

    // LIVE PATH: explicit paid click. Preconditions (fail closed):
    // 1. confirm_generate === true (separate from auto_confirm, never defaulted)
    // 2. model selected via tune panel + read back, or already showing
    // 3. prompt read-back already passed above
    if (args.confirm_generate === true) {
      if (!attachVerified || Object.values(frameVerification).some(frame => !frame.verified)
        || !settingsVerification.verified || mentionResults.failed.length || barFailed.length) {
        throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
          'Video preparation is unverified (settings, uploads, frame slots or ingredients). No Generate click made.',
          { frameVerification, settingsVerification });
      }
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
        const vids = Array.from(document.querySelectorAll('video'));
        const ids = [];
        vids.forEach(v => {
          const src = v.currentSrc || v.src || '';
          if (src) ids.push(src);
        });
        const imgs = Array.from(document.querySelectorAll('img'));
        imgs.forEach(i => {
          const src = i.src || '';
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

      const requestPayload = {
        prompt,
        model,
        ratio,
        duration: effectiveDuration,
        quality: wantQuality,
        quantity: qty,
        type: 'video',
      };
      const submissionContext = await buildHandlerSubmissionContext({
        page,
        epoch,
        requestPayload,
        inputLocator: promptInput,
        refs: frameFiles,
        mentionNames,
        liveAuthorization: await createLiveAuthorization({ page, confirmed: args.confirm_generate === true, maxCredits: args.max_credits }),
      });

      const submitted = await executeDurableSubmission({
        page,
        epoch,
        opStore: createOperationStore(getFlowHome()),
        requestPayload,
        observedAccount,
        observedProjectId,
        verifiedSettings,
        refs: frameFiles,
        baseline,
        quote,
        ...submissionContext,
      });
      jobQueue.completeJob(job.id, submitted);
      return { ...submitted, jobId: job.id };
    }

    const qc = {
      prompt_scaffold: 'scene+action (+camera/style lines); optics in UI selectors',
      prompt_warnings: warnings,
      model_routing: `requested ${args.model || 'auto'} → ${model} (dynamic universe, from=${resolved.from})`,
      capability: caps,
      tool_state_before: preState,
      ui_verified: uiResult?.verified || [],
      ui_unverified: uiSkipped,
      frames: { start_frame: startFrame, end_frame: endFrame, anchor_frame: anchorFrame, uploads: resolvedUploads, notes: frameNotes },
      frame_verification: frameVerification,
      ingredients_qc: 'plain/segmented bg preferred; no extra subjects in location/style refs; prompt names each ingredient',
      shots: shotPlan,
      output_dir: outputDir,
    };

    const preparationVerified = isVideoPreparationVerified({ settingsVerified: settingsVerification.verified,
      attachVerified, frames: frameVerification, failedMentions: mentionResults.failed, failedSettings: barFailed });
    if (!preparationVerified) warnings.push('Preparation is unverified. Correct settings, reference uploads and slot assignments before generating.');

    saveMetadata(job.id, {
      type: 'video',
      model,
      ratio,
      duration: effectiveDuration,
      requested_duration: requestedDuration,
      quality: args.quality || get('defaultQuality', '720p'),
      quantity: qty,
      prompt,
      raw_prompt: args.prompt.trim(),
      camera: args.camera,
      style: args.style,
      ingredients_requested: mentionNames,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      qc,
      status: preparationVerified ? 'ready_for_confirmation' : 'prepared_unverified',
      note: 'Video generation is a paid feature. Manual confirmation required to proceed.',
    });

    jobQueue.completeJob(job.id, {
      status: preparationVerified ? 'ready_for_confirmation' : 'prepared_unverified',
      type: 'video',
      jobId: job.id,
      account: extractObservedAccount(await page.content()),
      model_used: model,
      ratio,
      duration: effectiveDuration,
      requested_duration: requestedDuration,
      quantity: qty,
      prompt,
      camera: args.camera,
      style: args.style,
      ingredients_inserted: mentionResults.inserted,
      ingredients_failed: mentionResults.failed,
      frames: { start_frame: startFrame, end_frame: endFrame, anchor_frame: anchorFrame },
      frame_verification: frameVerification,
      shots: shotPlan,
      shots_plan_only: Boolean(shotPlan && shotPlan.length > 0),
      shots_notice: (shotPlan && shotPlan.length > 0)
        ? 'Legacy shots[] parameter is plan-only metadata. Individual shot takes are not executed in this handler.'
        : null,
      settings_verification: settingsVerification,
      qc_warnings: warnings,
      frame_notes: frameNotes,
      message: (preparationVerified
        ? 'Video prompt and settings verified. Not submitted; confirmation uses credits.'
        : 'Video prompt prepared, but verification is incomplete. Do not generate until the reported issues are corrected.') +
        (warnings.length ? ` Warnings: ${warnings.join(' | ')}` : ''),
      screenshot: await takeScreenshot(page, 'video-ready'),
    });

    assertUiCurrent(epoch);
    return jobQueue.getJob(job.id).result;
    }); // end withUiTransaction
  } catch (err) {
    try {
      await takeScreenshot(getPage(), 'generate-video-error');
    } catch (screenshotErr) {
      logger.warn('Could not take error screenshot (browser likely disconnected)', { error: screenshotErr.message });
    }
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
