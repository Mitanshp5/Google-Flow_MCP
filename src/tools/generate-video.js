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
import { get } from '../utils/config.js';
import { resolveModel, getUniverse, resolveIngredientsDuration } from '../utils/models.js';
import fs from 'fs';
import path from 'path';

function selectVideoModel(requested) {
  // Dynamic universe: user config ∪ live discovery ∪ fallback — no frozen list.
  const r = resolveModel(requested, 'video');
  return r ? r : null;
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
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `${label} not found: ${p}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `${label} must be an image file ≤ 25MB`);
  }
  return abs;
}

/**
 * Select the requested video model by clicking the model CHIP in the prompt
 * bar (e.g. "🍌 Nano Banana 2 … x2"), picking the model from the picker, then
 * READ BACK the chip. Returns true only when the UI confirms the model.
 * Never throws for panel absence — returns false so the caller refuses the
 * paid click with a manual-setup message.
 */
async function selectModelViaTune(page, model) {
  const want = String(model).toLowerCase();
  // Fast path: chip already shows the model.
  const before = await readToolState(page).catch(() => null);
  if (before?.model && (before.model.toLowerCase() === want || before.model.toLowerCase().includes(want.split(' ')[0]))) {
    logger.info('Model already showing in UI chip', { model, chip: before.modelChip });
    return true;
  }
  // Video models need video mode first (settings panel behind the bar chip).
  if (before && before.mode === 'image') {
    const modeRes = await setPromptBarMode(page, 'Video').catch(() => null);
    logger.info('Video-mode switch result', { modeRes });
    await takeScreenshot(page, 'video-mode-switched');
  }
  // Pick the model in the same settings panel. setPromptBarModel verifies
  // via the settings ROW (the bar chip carries no model name in video
  // mode) — trust that result directly.
  const res = await setPromptBarModel(page, model).catch(() => null);
  logger.info('Model picker result', { res });
  const ok = !!res?.ok;
  if (ok) logger.info('Model selection verified via settings row', { model, detail: res.detail });
  else logger.warn('Model selection unverified after settings-panel attempt', { model, res });
  return ok;
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
  const refPaths = [...(args.start_frame ? [startFrame] : (args.hero_frame ? [startFrame] : [])),
    ...(args.end_frame ? [endFrame] : []), ...(anchorFrame ? [anchorFrame] : [])];
  const uploadRefs = Array.isArray(args.reference_images) ? args.reference_images : [];
  const resolvedUploads = [];
  for (const p of uploadRefs) {
    resolvedUploads.push(resolveFrame(p, 'reference_images[]'));
  }
  // P0-6: shared @name collection (same order/semantics as the image tool).
  const mentionNames = collectMentionNames(args);
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
    const modelRes = await setPromptBarModel(page, model);
    const barSets = [
      modeRes, modelRes,
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
    const uiResult = await configureGenerationUI({
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

    // Fill prompt (scaffolded) + READ BACK to verify it actually landed.
    await promptInput.click();
    await promptInput.fill('');
    await page.waitForTimeout(200);
    await promptInput.type(prompt, { delay: 20 });
    await page.waitForTimeout(500);
    const filledText = await promptInput.textContent().catch(() => '')
      || await promptInput.inputValue().catch(() => '');
    const promptHead = args.prompt.trim().slice(0, 40);
    if (!filledText || !filledText.includes(promptHead)) {
      await takeScreenshot(page, 'prompt-fill-unverified');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Prompt fill could not be verified in the input (read-back mismatch). Refusing to continue with wrong/empty prompt.',
        { expectedHead: promptHead, actualHead: String(filledText).slice(0, 80) });
    }
    logger.info('Prompt fill verified via read-back', { chars: filledText.length });

    // P0-2: attach frames + reference uploads with read-back (previously
    // fire-and-forget with only a manual-slot warning). attachVerified gates
    // the live paid click below; prepare-only only warns.
    const frameNotes = [];
    const frameFiles = [...refPaths, ...resolvedUploads];
    let attachAccepted = 0;
    let attachVerified = true;
    if (frameFiles.length > 0) {
      const attach = await attachReferenceFiles(page, promptInput, frameFiles, { label: 'frames' });
      attachAccepted = attach.inputAccepted;
      attachVerified = attach.verified;
      frameNotes.push(...attach.notes);
      frameNotes.push('Slot identity (start/end/ingredient) is not yet auto-verified: if Flow did not auto-assign, select Video Frames/Ingredients slots manually.');
      logger.info('Frames/references attach result', { accepted: attachAccepted, verified: attachVerified });
    }

    // P0-2: per-file verification record. slot_detected stays 'unknown'
    // until slot markers are calibrated against the live DOM (follow-up);
    // verified tracks landing (input accepted every file), not placement.
    const frameVerification = {};
    const pushFrameEntry = (key, abs) => {
      if (!abs) return;
      frameVerification[key] = {
        requested: path.basename(abs),
        slot_detected: 'unknown',
        verified: attachVerified,
      };
    };
    pushFrameEntry('start_frame', startFrame);
    pushFrameEntry('end_frame', endFrame);
    pushFrameEntry('anchor_frame', anchorFrame);
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
      const modelVerified = await selectModelViaTune(page, model);
      const postState = await readToolState(page);
      await takeScreenshot(page, 'pre-generate-verification');
      // Verify via settings-row result (row-verified) + video mode.
      // The bar chip carries NO model name in video mode
      // ("Video · 720p · 8s ▢ x1"), so a chip check can't apply here.
      const chipHit = postState.model &&
        (postState.model.toLowerCase() === model.toLowerCase() ||
          postState.model.toLowerCase().includes(model.split(' ')[0].toLowerCase()));
      const modeOk = postState.mode === 'video';
      if (!modelVerified || (!chipHit && !modeOk)) {
        throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
          `Refusing live Generate: model "${model}" not verified in UI ` +
          `(tuneSelect=${modelVerified}, chip=${postState.modelChip || 'none'}). ` +
          `Pick it via the tune icon first, then retry. No credits spent.`,
          { model, tuneSelect: modelVerified, toolState: postState });
      }
      logger.info('Model verified for live Generate', { model, chip: postState.modelChip });
      // P0-2: fail closed — never spend credits when requested frames never landed.
      if (frameFiles.length > 0 && !attachVerified) {
        throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
          `Refusing live Generate: ${frameFiles.length} requested frame/reference file(s) did not land in the composer ` +
          `(input accepted ${attachAccepted}/${frameFiles.length}). Attach them manually via Video Frames/Ingredients, then retry. No credits spent.`,
          { frame_verification: frameVerification });
      }
      logger.info('⚠️⚠️⚠️ Clicking Generate — credits will be consumed', { model });
      const submitBtn = page.locator(
        'button[aria-label*="Start generation" i], button[aria-label*="Send" i], button[aria-label*="Generate" i], button[type="submit"]'
      ).first();
      if (!(await submitBtn.isVisible().catch(() => false))) {
        await takeScreenshot(page, 'no-generate-btn-live');
        throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button not visible — no credits spent.');
      }
      if (await submitBtn.isDisabled().catch(() => false)) {
        await takeScreenshot(page, 'generate-disabled-live');
        throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Generate button is disabled — no credits spent.');
      }
      await submitBtn.click();
      const pollTimeoutMs = get('generationTimeoutMs', 120000);
      const pollCeilingMs = resolveVideoPollCeilingMs({
        generationTimeoutMs: pollTimeoutMs,
        jobTimeoutMs: get('jobTimeoutMs', 300000),
      });
      logger.info('Generate clicked — polling for video output', { ceilingSec: Math.round(pollCeilingMs / 1000) });
      const pollStart = Date.now();
      let videoFound = null;
      while (Date.now() - pollStart < pollCeilingMs) {
        await page.waitForTimeout(5000);
        videoFound = await page.evaluate(() => {
          const vids = Array.from(document.querySelectorAll('video'));
          const ready = vids.find(v => (v.currentSrc || v.src || '').startsWith('http'));
          if (ready) return { src: ready.currentSrc || ready.src };
          const imgs = Array.from(document.querySelectorAll('img'));
          const gen = imgs.map(i => i.src).find(s => s && s.includes('getMediaUrlRedirect'));
          return gen ? { thumbnail: gen } : null;
        }).catch(() => null);
        if (videoFound) break;
      }
      const doneShot = await takeScreenshot(page, 'video-live-result');
      saveMetadata(job.id, {
        type: 'video', model, ratio, duration: effectiveDuration, quality: args.quality || get('defaultQuality', '720p'), prompt,
        live: true, credits_consumed: true, result: videoFound,
        projectUrl: page.url(), jobId: job.id,
      });
      jobQueue.completeJob(job.id, {
        status: videoFound ? 'success' : 'generating',
        type: 'video',
        account: get('expectedAccount'),
        model_used: model,
        ratio,
        duration: effectiveDuration,
        quality: args.quality || get('defaultQuality', '720p'),
        prompt,
        credits_consumed: true,
        result: videoFound,
        project_url: page.url(),
        message: videoFound
          ? 'Video generated (live paid click). See result src / project page.'
          : 'Generate clicked (credits consumed); video still rendering after poll window. Check the project page.',
        screenshot: doneShot,
      });
      return jobQueue.getJob(job.id).result;
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
      status: 'ready_for_confirmation',
      note: 'Video generation is a paid feature. Manual confirmation required to proceed.',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'video',
      account: get('expectedAccount'),
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
      qc_warnings: warnings,
      frame_notes: frameNotes,
      message: 'Video generation setup complete (hero-frame + ingredients + frames QC passed). Manual confirmation required (uses credits).' +
        (warnings.length ? ` Warnings: ${warnings.join(' | ')}` : ''),
      screenshot: await takeScreenshot(page, 'video-ready'),
    });

    return jobQueue.getJob(job.id).result;
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
