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
    // The form has a textarea/contenteditable with a placeholder or aria-label about character description.
    // Note: some versions use a plain <p> with placeholder text as a styling trick.
    const onCreateForm = await page.locator(
      '[placeholder*="Describe your character" i], ' +
      '[data-placeholder*="Describe your character" i], ' +
      '[aria-label*="Describe your character" i], ' +
      '[contenteditable="true"]:visible'
    ).first().isVisible().catch(() => false);

    if (!onCreateForm) {
      // Otherwise, the project already has characters — look for a button
      // to open the "New character" creation form.
      // Common labels: "New character", "New Character", "Create character", "add" FAB
      const newCharLocator = page.locator(
        'button:has-text("New character"), ' +
        'button:has-text("New Character"), ' +
        'button[aria-label*="new character" i], ' +
        'button[aria-label*="create character" i], ' +
        'a:has-text("New character")'
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
      await page.waitForTimeout(2000);
    }

    // Fill character description
    // Try specific selectors first, then fall back to any visible text input
    const descCandidates = [
      page.locator('[placeholder*="Describe your character" i]').first(),
      page.locator('[data-placeholder*="Describe your character" i]').first(),
      page.locator('[aria-label*="Describe" i]').first(),
      page.locator('[contenteditable="true"]:visible').first(),
      page.locator('textarea:visible').first(),
    ];
    let descLocator = null;
    for (const candidate of descCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        descLocator = candidate;
        break;
      }
    }
    if (descLocator) {
      await descLocator.click();
      // Use fill for textarea, type for contenteditable
      try { await descLocator.fill(''); } catch { /* contenteditable may not support fill */ }
      await page.waitForTimeout(200);
      await descLocator.type(args.description, { delay: 20 });
    } else {
      logger.warn('Could not find character description input');
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
    // submit/send button to create the character.
    // NOTE: The arrow button in Flow uses a Material icon FONT GLYPH (U+E5C8),
    // NOT the text "arrow_forward". We must use aria-label or positional selectors.
    if (descLocator && await descLocator.isVisible().catch(() => false)) {
      await descLocator.click();
      await page.waitForTimeout(200);
    }

    // Find the submit button — try aria-label first, then JS evaluation to find
    // a button near the text input that looks like a send/submit button.
    let submitBtn = null;
    const submitSelectors = [
      'button:has-text("arrow_forward")',
      'button[aria-label*="Create character" i]',
      'button[aria-label*="create" i]',
      'button:has-text("Create")',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Generate" i]',
      'button[type="submit"]',
    ];
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        submitBtn = btn;
        logger.info('Found submit button via selector', { sel });
        break;
      }
    }

    // JS fallback: find any button that contains a right-arrow SVG or material icon
    if (!submitBtn) {
      const submitBtnHandle = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Look for buttons with an SVG containing a right-pointing path, or
        // a span/mat-icon with text content that is the arrow glyph (font render)
        return buttons.find(btn => {
          if (!btn.offsetParent) return false; // not visible
          // aria-label fallback
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('send') || label.includes('create') || label.includes('submit') || label.includes('generate')) return true;
          // Check for material icon span inside button
          const spans = Array.from(btn.querySelectorAll('span, mat-icon, [class*="icon"]'));
          return spans.some(s => {
            const txt = s.textContent || '';
            // arrow_forward glyph in material icon font
            return txt.includes('\uE5C8') || txt.trim() === 'arrow_forward' ||
                   txt.includes('send') || txt.includes('chevron_right');
          });
        }) || null;
      }).catch(() => null);

      if (submitBtnHandle) {
        submitBtn = page.locator('button').filter({ has: page.locator('[class*="icon"], mat-icon, span') }).first();
        // More reliable: use the element directly
        try {
          const el = submitBtnHandle.asElement();
          if (el) {
            submitBtn = { click: () => el.click(), isDisabled: async () => false, isVisible: async () => true };
          }
        } catch { /* keep Playwright locator */ }
      }
    }

    if (!submitBtn) {
      await takeScreenshot(page, 'character-submit-not-found');
      const elements = await detectPageElements(page);
      return {
        status: 'ui_discovered',
        message: 'Description filled, but the submit button was not found. Check screenshot.',
        elements: {
          buttons: elements.buttons.map(b => b.text),
          inputs: elements.inputs,
        },
        screenshot: await takeScreenshot(page, 'character-submit-not-found'),
      };
    }

    const isDisabled = typeof submitBtn.isDisabled === 'function'
      ? await submitBtn.isDisabled().catch(() => false)
      : false;
    if (isDisabled) {
      await takeScreenshot(page, 'character-submit-disabled');
      throw new FlowError(ErrorCodes.GENERATION_BUTTON_DISABLED, 'Character submit button is disabled');
    }

    await submitBtn.click();
    logger.info('Character creation submitted — waiting for navigation to character page');

    // Poll for navigation to /character/{id} URL (up to 30s)
    const submitStart = Date.now();
    let navigated = false;
    while (Date.now() - submitStart < 30000) {
      await page.waitForTimeout(1500);
      const currentUrl = page.url();
      if (currentUrl.includes('/character/')) {
        logger.info('Navigated to character page', { url: currentUrl });
        navigated = true;
        break;
      }
      // Also check if an error dialog appeared
      const hasError = await page.locator('[role="alert"], [class*="error"], [class*="Error"]')
        .first().isVisible().catch(() => false);
      if (hasError) {
        const errorText = await page.locator('[role="alert"], [class*="error"]')
          .first().textContent().catch(() => 'Unknown error');
        logger.warn('Error dialog appeared after submit', { errorText });
        await takeScreenshot(page, 'character-submit-error-dialog');
        break;
      }
    }
    await page.waitForTimeout(1000);

    const characterUrl = page.url();
    if (!navigated && !characterUrl.includes('/character/')) {
      throw new FlowError(ErrorCodes.GENERATION_TIMEOUT, 'Character generation timed out or failed to navigate to the character page.');
    }

    // After submission, Flow navigates to /project/{id}/character/{characterId}
    // showing "Untitled Character" — rename it to args.name if provided.
    let renamed = false;
    if (args.name) {
      renamed = await renameCharacterTitle(page, args.name);
    }

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
    try { await takeScreenshot(getPage(), 'create-character-error'); } catch { /* ok */ }
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
