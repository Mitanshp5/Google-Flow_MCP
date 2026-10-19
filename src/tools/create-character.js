import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { detectPageElements, ensureManualMode, attachReferenceFiles } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, ensureProjectLibrary, navigateToSidebar, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';

import { escapeRegExp, resolveSafePath } from '../utils/sanitize.js';
import { isErrorHtml, extractObservedAccount } from '../browser/app-state.js';
import { get, getFlowHome } from '../utils/config.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';
import { createOperationStore } from '../domain/operations.js';
import { executeDurableSubmission } from '../domain/submission-adapter.js';
import fs from 'fs';
import { decontaminateModelField } from '../browser/capabilities.js';
import { handleGenerateConfirm } from './generate-confirm.js';
import { fillCharacterDescription } from '../browser/character-form.js';

export async function handleCreateCharacter(args) {
  const autoConfirm = args.auto_confirm === true;
  // Both live and prepare-only requests use the same verified preparation.
  // The confirmation handler owns the credit policy and the single click.
  args = { ...args, auto_confirm: false };
  const job = jobQueue.createJob('create_character', {
    ...args,
    project_name: args.project_name,
    campaign: args.campaign,
  });

  try {
    jobQueue.startJob(job.id);
    const page = getPage();

    const prepared = await withUiTransaction(async ({ epoch }) => {
    assertUiCurrent(epoch);

    // Ensure we're inside a project
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

    // Navigate to the Characters sidebar section
    // (this is a project-scoped page: /project/{id}/characters — when the
    // project has no characters yet, this page IS the "New character"
    // creation form directly, with a "Describe your character..." input,
    // sample prompt cards, Upload and "Add from Project" buttons.)
    await ensureProjectLibrary(page);
    const nav = await navigateToSidebar(page, 'Characters');
    if (!nav) {
      // F02 fallback: try direct singular /character route
      const projectId = extractProjectId(page.url());
      if (projectId) {
        const charUrl = `${buildProjectUrl(get('flowUrl', 'https://flow.google.com/'), projectId)}/character`;
        await page.goto(charUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      }
    } else {
      await page.waitForTimeout(2000);
    }

    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');

    // F02: 404 error check
    if (isErrorHtml({ title, bodyText, url: currentUrl })) {
      const out = {
        status: 'blocked',
        reason: 'page_not_found',
        url: currentUrl,
        message: 'Character route returned 404 or page not found.',
        screenshot: await takeScreenshot(page, 'characters-404'),
        jobId: job.id,
      };
      jobQueue.failJob(job.id, new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, out.message));
      return out;
    }

    await takeScreenshot(page, 'characters-section');

    // Optional archetype starter (The Eccentric, The Professional,
    // The Wildcard, The Familiar, The Wicked, The Fantastical). Clicks the
    // exact card when visible, otherwise continues to the scratch composer.

    // F03: Require feature-specific character form evidence.
    // The ordinary prompt bar or generic contenteditable alone is NOT proof of a character form!
    // Live UI keeps "Describe your character..." as text while the editable
    // is an inner contenteditable — probe the real editables, not just placeholder attrs.
    const formSelector = '[placeholder*="Describe your character" i], [data-placeholder*="Describe your character" i], [aria-label*="Describe your character" i]';
    const onCreateForm = await page.locator(
      '[placeholder*="Describe your character" i], ' +
      '[data-placeholder*="Describe your character" i], ' +
      '[aria-label*="Describe your character" i]'
    ).first().isVisible().catch(() => false);

    if (!onCreateForm) {
      // Look for a button to open the "New character" creation form
      // Text-content matching also hits the sidebar's icon ligature
      // "accessibility_newCharacters". Its accessible name is Characters,
      // so use the actual New character action name instead.
      const newCharLocator = page.getByRole('button', { name: /^(?:New|Create) character$/i })
        .or(page.getByRole('link', { name: /^New character$/i })).first();

      if (await newCharLocator.isVisible().catch(() => false)) {
        await newCharLocator.click();
        await page.waitForTimeout(2000);
        if (!(await page.locator(formSelector).first().isVisible().catch(() => false))) {
          throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'New character did not open the native description form. No description entered.');
        }
      } else {
        // F03: Neither character form nor New Character button found.
        // Return explicit blocker instead of typing description into ordinary video composer!
        const elements = await detectPageElements(page);
        const out = {
          status: 'blocked',
          reason: 'character_form_not_found',
          message: 'Character creation form not found (ordinary composer or wrong view displayed). Refusing to type character description into composer.',
          elements: {
            buttons: elements.buttons.map(b => b.text),
            inputs: elements.inputs,
          },
          screenshot: await takeScreenshot(page, 'characters-form-missing'),
          jobId: job.id,
        };
        jobQueue.failJob(job.id, new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, out.message));
        return out;
      }
    }

    const refImages = Array.isArray(args.reference_images) && args.reference_images.length > 0
      ? args.reference_images
      : (args.reference_image ? [args.reference_image] : []);

    if (autoConfirm && !(await page.locator('button[aria-label="Select model family"]').isVisible().catch(() => false))) {
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, 'Native character image model control is unverified. No fields changed and no Generate click made.');
    }

    if (args.auto_confirm === true) {
      assertUiCurrent(epoch);

      const pageHtml = await page.content().catch(() => '');
      let observedAccount = extractObservedAccount(pageHtml);
      if (!observedAccount && !pageHtml) {
        try {
          const fallbackHtml = await page.evaluate(() => document.documentElement?.outerHTML || '').catch(() => '');
          observedAccount = extractObservedAccount(fallbackHtml);
        } catch { /* ignore */ }
      }

      const observedUrl = page.url() || '';
      const observedProjectId = extractProjectId(observedUrl);
      const baseline = { ids: [], observedAt: Date.now() };

      return await executeDurableSubmission({
        page,
        epoch,
        opStore: createOperationStore(getFlowHome()),
        requestPayload: { name: args.name || null, description: (args.description || args.prompt || '').trim(), type: 'character' },
        observedAccount,
        observedProjectId,
        verifiedSettings: null,
        refs: refImages || [],
        baseline,
        quote: null,
        approvalChild: null,
        approvals: null,
        ledger: null,
        remoteSubmitFn: null,
      });
    }

    // Fill character description into character-specific input ONLY.
    // The editable is an inner contenteditable inside the composer box.
    const descCandidates = [
      page.locator('[placeholder*="Describe your character" i]').first(),
      page.locator('[data-placeholder*="Describe your character" i]').first(),
      page.locator('[aria-label*="Describe your character" i]').first(),
      page.locator('form [placeholder*="Describe" i]').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('textarea').first(),
      page.locator('[role="textbox"]').first(),
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
      await fillCharacterDescription(page, descLocator, args.description, args.archetype?.trim());
    } else {
      const out = {
        status: 'blocked',
        reason: 'character_input_not_found',
        message: 'Character description input not found on character form.',
        screenshot: await takeScreenshot(page, 'character-input-missing'),
        jobId: job.id,
      };
      jobQueue.failJob(job.id, new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, out.message));
      return out;
    }

    // Upload reference image(s) if provided — supports reference_images (array)
    // or the legacy reference_image (single string)
    let references = { requested: [], verified: true };
    if (refImages.length > 0) {
      const resolved = [];
      for (const p of refImages) {
        try {
          const abs = resolveSafePath(p);
          if (!fs.existsSync(abs)) {
            logger.warn('Reference image not found, skipping', { path: p });
            continue;
          }
          resolved.push(abs);
        } catch (e) {
          logger.warn('Invalid reference image path, skipping', { path: String(p).slice(0, 120), error: e.message });
        }
      }
      if (resolved.length > 0) {
        references = await attachReferenceFiles(page, descLocator, resolved);
      }
      if (resolved.length !== refImages.length) references = { ...references, verified: false };
    }

    // Try to select model (escaped exact match — no selector injection)
    if (args.model) {
      try {
        const modelLocator = page.locator('button')
          .filter({ hasText: new RegExp(`^${escapeRegExp(args.model)}$`, 'i') }).first();
        if (await modelLocator.isVisible().catch(() => false)) {
          await modelLocator.click();
          await page.waitForTimeout(500);
        }
      } catch { /* ok */ }
    }

    await takeScreenshot(page, 'character-ready');
    const modelControl = page.locator('button[aria-label="Select model family"]');
    const observedModel = await modelControl.isVisible().catch(() => false)
      ? decontaminateModelField(await modelControl.innerText()) : '';
    const preparationVerified = references.verified && !!observedModel;
    const unapplied = [
      ...(!references.verified ? ['reference_images'] : []),
      ...(!observedModel ? ['name', 'model'] : []),
    ];

    if (args.auto_confirm === false) {
      saveMetadata(job.id, {
        type: 'character',
        name: args.name,
        model_used: observedModel,
        description: args.description,
        prompt: args.description,
        project_url: page.url(),
        model: args.model,
        referenceImages: refImages,
        projectName: args.project_name,
        campaign: args.campaign,
        jobId: job.id,
        status: preparationVerified ? 'ready_for_confirmation' : 'prepared_unverified',
      });

      jobQueue.completeJob(job.id, {
        status: preparationVerified ? 'ready_for_confirmation' : 'prepared_unverified',
        type: 'character',
        name: args.name,
        model_used: observedModel,
        jobId: job.id,
        description: args.description,
        prompt: args.description,
        project_url: page.url(),
        references,
        unapplied,
        naming: { requested: args.name, status: 'deferred_until_created' },
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
    // NOTE: The arrow button uses a Material icon FONT GLYPH (U+E5C8), NOT text —
    // do NOT match button:has-text("arrow_forward").
    let submitBtn = null;
    const submitSelectors = [
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

    // Live character creation path.
    // Must extract verified observed bindings from actual page state.
    assertUiCurrent(epoch);

    const pageHtml = await page.content().catch(() => '');
    let observedAccount = extractObservedAccount(pageHtml);
    if (!observedAccount && !pageHtml) {
      try {
        const fallbackHtml = await page.evaluate(() => document.documentElement?.outerHTML || '').catch(() => '');
        observedAccount = extractObservedAccount(fallbackHtml);
      } catch { /* ignore */ }
    }

    const observedUrl = page.url() || '';
    const observedProjectId = extractProjectId(observedUrl);
    const verifiedSettings = { type: 'character', name: args.name || null, description: args.description || null };
    const baseline = { ids: [], observedAt: Date.now() };
    const quote = { total: 0, unit: 'free', quantity: 1, observedAt: Date.now() };

    return await executeDurableSubmission({
      page,
      epoch,
      opStore: createOperationStore(getFlowHome()),
      requestPayload: { description: (args.description || args.name || '').trim(), project_name: args.project_name || null, type: 'character' },
      observedAccount,
      observedProjectId,
      verifiedSettings,
      refs: refImages || [],
      baseline,
      quote,
      approvalChild: args._approvalChild || null,
      approvals: args._approvals || null,
      ledger: args._ledger || null,
      remoteSubmitFn: args._remoteSubmitFn || null,
    });
    }); // end withUiTransaction
    if (autoConfirm && prepared.status === 'ready_for_confirmation') {
      return await handleGenerateConfirm({ job_id: prepared.jobId, max_credits: args.max_credits, wait_ms: 2000 });
    }
    return prepared;
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
