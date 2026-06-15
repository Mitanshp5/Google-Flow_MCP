import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { renameCharacterTitle } from '../navigation/character-rename.js';

export async function handleCreateCharacter(args) {
  const job = jobQueue.createJob('create_character', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    // Ensure we're inside a project
    await ensureProjectInContext(page, {
      name: args.project_name,
      campaign: args.campaign,
    });

    // Navigate to the Characters sidebar section
    // (this is a project-scoped page: /project/{id}/characters — when the
    // project has no characters yet, this page IS the "New character"
    // creation form directly, with a "Describe your character..." input,
    // sample prompt cards, Upload and "Add from Project" buttons.)
    await navigateToSidebar(page, 'Characters');
    await page.waitForTimeout(2000);

    await takeScreenshot(page, 'characters-section');

    // Are we already on the "New character" creation form?
    const onCreateForm = await page.locator(
      'textarea[placeholder*="Describe your character" i], [contenteditable][aria-label*="Describe your character" i]'
    ).first().isVisible().catch(() => false);

    if (!onCreateForm) {
      // Otherwise, the project already has characters — look for a button
      // to open the "New character" creation form.
      const newCharLocator = page.locator(
        'button:has-text("New Character"), button:has-text("New character"), button:has-text("Create"), button:has-text("New"), text=New Character'
      ).first();

      if (!await newCharLocator.isVisible().catch(() => false)) {
        const elements = await detectPageElements(page);
        return {
          status: 'ui_discovered',
          message: 'Characters section opened. Neither the character creation form nor a "New Character" button was auto-detected.',
          elements: {
            buttons: elements.buttons.map(b => b.text),
            inputs: elements.inputs,
          },
          screenshot: await takeScreenshot(page, 'characters-ui'),
        };
      }

      await newCharLocator.click();
      await page.waitForTimeout(1500);
    }

    // Fill character description
    const descLocator = page.locator(
      'textarea[placeholder*="Describe your character" i], textarea, [contenteditable="true"], input[placeholder*="Describe" i], input[placeholder*="description" i]'
    ).first();
    if (await descLocator.isVisible().catch(() => false)) {
      await descLocator.click();
      await descLocator.fill('');
      await page.waitForTimeout(200);
      await descLocator.type(args.description, { delay: 20 });
    }

    // Upload reference image(s) if provided — supports reference_images (array)
    // or the legacy reference_image (single string)
    const refImages = Array.isArray(args.reference_images) && args.reference_images.length > 0
      ? args.reference_images
      : (args.reference_image ? [args.reference_image] : []);

    if (refImages.length > 0) {
      const fileLocator = page.locator('input[type="file"]').first();
      if (await fileLocator.isVisible().catch(() => false)) {
        await fileLocator.setInputFiles(refImages);
        await page.waitForTimeout(2000);
        logger.info('Reference image(s) uploaded', { count: refImages.length });
      }
    }

    // Try to select model
    if (args.model) {
      try {
        const modelLocator = page.locator(`button:has-text("${args.model}")`).first();
        if (await modelLocator.isVisible().catch(() => false)) {
          await modelLocator.click();
          await page.waitForTimeout(500);
        }
      } catch { /* ok */ }
    }

    await takeScreenshot(page, 'character-ready');

    if (args.auto_confirm === false) {
      saveMetadata(job.id, {
        type: 'character',
        description: args.description,
        model: args.model,
        referenceImages: refImages,
        projectName: args.project_name,
        campaign: args.campaign,
        jobId: job.id,
        status: 'ready_for_confirmation',
      });

      jobQueue.completeJob(job.id, {
        status: 'ready_for_confirmation',
        type: 'character',
        description: args.description,
        message: 'Character setup complete. Manual confirmation needed to create.',
        screenshot: await takeScreenshot(page, 'character-ready'),
      });

      return jobQueue.getJob(job.id).result;
    }

    // STEP: Click the description textbox (ensure focus), then click the
    // small right-pointing arrow ("arrow_forward") to submit and create
    // the character.
    if (await descLocator.isVisible().catch(() => false)) {
      await descLocator.click();
      await page.waitForTimeout(200);
    }

    const submitBtn = page.locator(
      'button:has-text("arrow_forward"), button[aria-label*="Create" i], button[aria-label*="Send" i], button[aria-label*="Generate" i]'
    ).first();

    if (!await submitBtn.isVisible().catch(() => false)) {
      await takeScreenshot(page, 'character-submit-not-found');
      const elements = await detectPageElements(page);
      return {
        status: 'ui_discovered',
        message: 'Description filled, but the submit (arrow) button was not found.',
        elements: {
          buttons: elements.buttons.map(b => b.text),
          inputs: elements.inputs,
        },
        screenshot: await takeScreenshot(page, 'character-submit-not-found'),
      };
    }

    if (await submitBtn.isDisabled().catch(() => false)) {
      await takeScreenshot(page, 'character-submit-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Character submit (arrow) button is disabled');
    }

    await submitBtn.click();
    logger.info('Character creation submitted');
    await page.waitForTimeout(4000);

    // After submission, Flow navigates to /project/{id}/character/{characterId}
    // showing "Untitled Character" — rename it to args.name if provided.
    let renamed = false;
    if (args.name) {
      renamed = await renameCharacterTitle(page, args.name);
    }

    const characterUrl = page.url();
    await takeScreenshot(page, 'character-created');

    saveMetadata(job.id, {
      type: 'character',
      name: args.name,
      description: args.description,
      model: args.model,
      referenceImages: refImages,
      projectName: args.project_name,
      campaign: args.campaign,
      jobId: job.id,
      characterUrl,
      renamed,
      status: 'success',
    });

    jobQueue.completeJob(job.id, {
      status: 'success',
      type: 'character',
      name: args.name,
      renamed,
      description: args.description,
      character_url: characterUrl,
      message: 'Character created.' + (args.name ? (renamed ? ` Renamed to "${args.name}".` : ` Could not rename to "${args.name}" — still "Untitled Character".`) : ''),
      screenshot: await takeScreenshot(page, 'character-created'),
    });

    return jobQueue.getJob(job.id).result;
  } catch (err) {
    await takeScreenshot(getPage(), 'create-character-error');
    jobQueue.failJob(job.id, err);
    throw err;
  }
}

export async function handleListCharacters() {
  const page = getPage();
  await navigateToSidebar(page, 'Characters');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const characterCards = elements.buttons.filter(b =>
    !b.text.includes('New') && !b.text.includes('Create') && b.text.length > 2
  );

  return {
    status: 'success',
    characters_found: characterCards,
    raw_elements: elements,
    screenshot: await takeScreenshot(page, 'characters-list'),
  };
}
