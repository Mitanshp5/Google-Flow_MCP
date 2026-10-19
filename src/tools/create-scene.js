import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, ensureManualMode } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { jobQueue } from '../queue/job-queue.js';
import { ensureProjectInContext, ensureProjectLibrary, navigateToSidebar, extractProjectId } from '../navigation/project-navigator.js';
import { insertMentionReferences } from '../navigation/mentions.js';
import { resolveSafePath } from '../utils/sanitize.js';
import { getFlowHome } from '../utils/config.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';
import { createOperationStore } from '../domain/operations.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { executeDurableSubmission } from '../domain/submission-adapter.js';
import fs from 'fs';

export async function handleOpenScenes() {
  const page = getPage();
  await navigateToSidebar(page, 'Scenes');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const screenshot = await takeScreenshot(page, 'scenes-section');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}

export async function handleCreateScene(args) {
  const description = (args.description || args.prompt || '').trim();
  if (!description) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt (or description) is required and must be a non-empty string');
  }
  const autoConfirm = args.auto_confirm === true;
  const job = jobQueue.createJob('create_scene', {
    prompt: description,
    characters: args.characters,
    project_name: args.project_name,
    campaign: args.campaign,
    auto_confirm: autoConfirm,
  });
  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    return await withUiTransaction(async ({ epoch }) => {
    assertUiCurrent(epoch);

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

    await ensureProjectLibrary(page);
    const nav = await navigateToSidebar(page, 'Scenes');
    if (!nav) {
      if (autoConfirm) throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, 'Scenes library could not be verified. No scene setup performed.');
      const blocked = {status:'blocked',reason:'scene_form_not_found',navigation_verified:false,jobId:job.id,
        message:'Scenes library could not be verified. No scene setup performed.'};
      jobQueue.failJob(job.id,new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,blocked.message));
      return blocked;
    }
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'scenes-section');

    const elements = await detectPageElements(page);
    const newSceneLocator = page.locator(
      'button:has-text("New Scene"), button:has-text("New scene"), button:has-text("Create scene")'
    ).first();
    const hasNewBtn = await newSceneLocator.isVisible().catch(() => false);
    const sceneFormLocator = page.locator(
      '[placeholder*="Describe your scene" i], [aria-label*="Describe your scene" i], [data-placeholder*="scene" i]'
    ).first();
    const hasSceneForm = await sceneFormLocator.isVisible().catch(() => false);

    // F03: If neither New Scene button nor Scene form is visible, do not report ready!
    if (!hasNewBtn && !hasSceneForm) {
      const out = {
        status: 'blocked',
        reason: 'scene_form_not_found',
        message: 'Scene creation form not found (ordinary composer or wrong screen displayed). Refusing to report scene setup complete.',
        jobId: job.id,
        elements: {
          buttons: elements.buttons.map(b => b.text),
          inputs: elements.inputs,
        },
        screenshot: await takeScreenshot(page, 'scene-form-missing'),
      };
      jobQueue.failJob(job.id, new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, out.message));
      return out;
    }

    if (autoConfirm) {
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
      const baseline = { ids: [], observedAt: Date.now() };

      return await executeDurableSubmission({
        page,
        epoch,
        opStore: createOperationStore(getFlowHome()),
        requestPayload: { description, project_name: args.project_name || null, type: 'scene' },
        observedAccount,
        observedProjectId,
        verifiedSettings: null,
        refs: args.reference_image ? [args.reference_image] : [],
        baseline,
        quote: null,
        approvalChild: null,
        approvals: null,
        ledger: null,
        remoteSubmitFn: null,
      });
    }

    if (hasNewBtn && !hasSceneForm) {
      await newSceneLocator.click();
      await page.waitForTimeout(1000);
      const opened = await sceneFormLocator.isVisible().catch(() => false);
      if (!opened) {
        const out = {
          status: 'blocked',
          reason: 'scene_form_not_found',
          message: 'Scene creation form not opened after clicking New Scene.',
          jobId: job.id,
          elements,
          screenshot: await takeScreenshot(page, 'scene-form-missing'),
        };
        jobQueue.failJob(job.id, new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, out.message));
        return out;
      }
    }

    const inputLocator = page.locator('[placeholder*="Describe your scene" i], [aria-label*="Describe your scene" i], form textarea, form [contenteditable="true"]').first();
    if (await inputLocator.isVisible().catch(() => false)) {
      await inputLocator.click();
      try { await inputLocator.fill(''); } catch { /* ignore */ }
      await page.waitForTimeout(200);
      await inputLocator.type(description, { delay: 20 });

      // Insert "@" references for any characters to include in the scene
      if (Array.isArray(args.characters) && args.characters.length > 0) {
        const mentionResults = await insertMentionReferences(page, inputLocator, args.characters);
        if (mentionResults.failed.length > 0) {
          logger.warn('Some character @ mentions could not be inserted', {
            failed: mentionResults.failed,
          });
        }
        await page.waitForTimeout(300);
      }
    } else {
      const out = {
        status: 'blocked',
        reason: 'scene_input_not_found',
        message: 'Scene description input not found after navigating to Scenes.',
        jobId: job.id,
        screenshot: await takeScreenshot(page, 'scene-input-missing'),
      };
      jobQueue.failJob(job.id, new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, out.message));
      return out;
    }

    if (args.reference_image) {
      try {
        const abs = resolveSafePath(args.reference_image);
        if (fs.existsSync(abs)) {
          const fileInputLocator = page.locator('input[type="file"]').first();
          await fileInputLocator.setInputFiles(abs).catch(() => {});
          await page.waitForTimeout(2000);
        } else {
          logger.warn('Scene reference image not found, skipping', { path: args.reference_image });
        }
      } catch (e) {
        logger.warn('Invalid scene reference image path', { error: e.message });
      }
    }

    saveMetadata(job.id, {
      type: 'scene',
      description,
      referenceImage: args.reference_image,
      projectName: args.project_name,
      campaign: args.campaign,
    });

    const out = {
      status: autoConfirm ? 'success' : 'ready_for_confirmation',
      elements,
      prompt: description,
      jobId: job.id,
      screenshot: await takeScreenshot(page, 'scene-ready'),
    };
    assertUiCurrent(epoch);
    jobQueue.completeJob(job.id, out);
    return out;
    }); // end withUiTransaction
  } catch (err) {
    try { await takeScreenshot(getPage(), 'create-scene-error'); } catch { /* ignore */ }
    try { jobQueue.failJob(job.id, err); } catch { /* ignore */ }
    throw err;
  }
}

export async function handleListScenes() {
  const page = getPage();
  await navigateToSidebar(page, 'Scenes');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const sceneCards = elements.buttons.filter(b =>
    !b.text.includes('New') && !b.text.includes('Create') && b.text.length > 2
  );

  return {
    scenes_found: sceneCards,
    screenshot: await takeScreenshot(page, 'scenes-list'),
  };
}
