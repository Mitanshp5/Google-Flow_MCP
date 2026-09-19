import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, ensureManualMode } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { escapeRegExp, resolveSafePath } from '../utils/sanitize.js';
import fs from 'fs';

export async function handleUseGridArchitect(args) {
  if (!args.theme_prompt || typeof args.theme_prompt !== 'string' || !args.theme_prompt.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'theme_prompt is required and must be a non-empty string');
  }
  const job = jobQueue.createJob('grid_architect', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
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

    // Navigate to Tools sidebar section
    await navigateToSidebar(page, 'Tools');
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'tools-section');

    // Find and click Grid Architect within tools
    const gaLocator = page.locator(
      'a:has-text("Grille"), a:has-text("Grid"), button:has-text("Grille"), button:has-text("Grid"), text=Architect'
    ).first();
    if (await gaLocator.isVisible().catch(() => false)) {
      await gaLocator.click();
      await page.waitForTimeout(3000);
    }

    await takeScreenshot(page, 'grid-architect-loaded');

    // Detect all UI elements
    const elements = await detectPageElements(page);

    // Set engine if specified (escaped exact match — no injection)
    if (args.engine) {
      try {
        const engineLocator = page.locator('button').filter({ hasText: new RegExp(`^${escapeRegExp(args.engine)}$`, 'i') }).first();
        if (await engineLocator.isVisible().catch(() => false)) {
          await engineLocator.click();
          await page.waitForTimeout(500);
        }
      } catch (e) { logger.debug('Engine select failed', { error: e.message }); }
    }

    // Set ratio if specified
    if (args.ratio) {
      try {
        const ratioLocator = page.locator('button').filter({ hasText: new RegExp(`^${escapeRegExp(args.ratio)}$`, 'i') }).first();
        if (await ratioLocator.isVisible().catch(() => false)) {
          await ratioLocator.click();
          await page.waitForTimeout(500);
        }
      } catch (e) { logger.debug('Ratio select failed', { error: e.message }); }
    }

    // Set visual logic
    if (args.visual_logic) {
      try {
        const vlLocator = page.locator('button').filter({ hasText: new RegExp(`^${escapeRegExp(args.visual_logic)}$`, 'i') }).first();
        if (await vlLocator.isVisible().catch(() => false)) {
          await vlLocator.click();
          await page.waitForTimeout(500);
        }
      } catch (e) { logger.debug('Visual-logic select failed', { error: e.message }); }
    }

    // Fill theme prompt
    if (args.theme_prompt) {
      const themeLocator = page.locator('textarea, [contenteditable="true"]').first();
      if (await themeLocator.isVisible().catch(() => false)) {
        await themeLocator.click();
        await themeLocator.fill('');
        await page.waitForTimeout(200);
        await themeLocator.type(args.theme_prompt, { delay: 15 });
        await page.waitForTimeout(500);
      }
    }

    // Fill shot prompts if provided
    if (args.shot_prompts && Array.isArray(args.shot_prompts)) {
      for (let i = 0; i < args.shot_prompts.length; i++) {
        const shotLabel = `Shot ${i + 1}`;
        const shotLocator = page.locator(`text="${shotLabel}"`).first();
        const shotInput = await shotLocator.isVisible().catch(() => false) ? shotLocator : null;
        if (shotInput) {
          await shotInput.click();
          await page.waitForTimeout(200);
          const nearestTextarea = page.locator('textarea').first();
          if (await nearestTextarea.isVisible().catch(() => false)) {
            await nearestTextarea.fill('');
            await page.waitForTimeout(200);
            await nearestTextarea.type(args.shot_prompts[i], { delay: 15 });
            await page.waitForTimeout(500);
          }
        }
      }
    }

    // Upload references (validate + don't swallow errors silently)
    if (args.references && Array.isArray(args.references)) {
      for (const ref of args.references) {
        try {
          const abs = resolveSafePath(ref);
          if (!fs.existsSync(abs)) {
            logger.warn('Grid reference not found, skipping', { ref: String(ref).slice(0, 120) });
            continue;
          }
          const fileLocator = page.locator('input[type="file"]').first();
          await fileLocator.setInputFiles(abs);
          await page.waitForTimeout(2000);
        } catch (e) { logger.warn('Grid reference upload failed', { error: e.message }); }
      }
    }

    await takeScreenshot(page, 'grid-architect-ready');

    saveMetadata(job.id, {
      type: 'grid_architect',
      engine: args.engine,
      ratio: args.ratio,
      themePrompt: args.theme_prompt,
      shotCount: args.shot_prompts?.length || 0,
      projectName: args.project_name,
      campaign: args.campaign,
      status: 'ready_for_confirmation',
    });

    jobQueue.completeJob(job.id, {
      status: 'ready_for_confirmation',
      type: 'grid_architect',
      engine: args.engine || 'Nano Banana 2',
      ratio: args.ratio || '16:9',
      elements_detected: {
        buttons: elements.buttons.map(b => b.text),
        inputs: elements.inputs,
      },
      message: 'Grid Architect setup complete. Manual confirmation needed to generate (uses credits).',
      screenshot: await takeScreenshot(page, 'grid-architect-ready'),
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'grid-architect-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}
