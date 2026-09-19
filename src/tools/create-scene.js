import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, ensureManualMode } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { jobQueue } from '../queue/job-queue.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { insertMentionReferences } from '../navigation/mentions.js';
import { resolveSafePath } from '../utils/sanitize.js';
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

    await navigateToSidebar(page, 'Scenes');
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'scenes-section');

    const elements = await detectPageElements(page);
    const newSceneLocator = page.locator(
      'button:has-text("New Scene"), button:has-text("Create"), button:has-text("New")'
    ).first();

    if (await newSceneLocator.isVisible().catch(() => false)) {
      // Scene creation mutates the project — require explicit opt-in.
      if (!autoConfirm) {
        const result = {
          status: 'ready_for_confirmation',
          message: 'Scene creation prepared. No scene was created (auto_confirm=false). Call again with auto_confirm=true to create.',
          prompt: description,
          elements,
          screenshot: await takeScreenshot(page, 'scene-ready'),
          jobId: job.id,
        };
        jobQueue.completeJob(job.id, result);
        return result;
      }
      await newSceneLocator.click();
      await page.waitForTimeout(1500);

      const inputLocator = page.locator('textarea, [contenteditable="true"]').first();
      if (await inputLocator.isVisible().catch(() => false)) {
        await inputLocator.click();
        await inputLocator.fill('');
        await page.waitForTimeout(200);
        await inputLocator.type(description, { delay: 20 });

        // Insert "@" references for any characters to include in the scene.
        // Flow opens a popup when "@" is typed, listing project images and characters.
        if (Array.isArray(args.characters) && args.characters.length > 0) {
          const mentionResults = await insertMentionReferences(page, inputLocator, args.characters);
          if (mentionResults.failed.length > 0) {
            logger.warn('Some character @ mentions could not be inserted', {
              failed: mentionResults.failed,
            });
          }
          await page.waitForTimeout(300);
        }
      }
    }

    if (args.reference_image) {
      try {
        const abs = resolveSafePath(args.reference_image);
        if (fs.existsSync(abs)) {
          // File inputs are usually hidden — don't gate on isVisible().
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
    jobQueue.completeJob(job.id, out);
    return out;
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
