import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { detectPageElements, ensureManualMode } from '../browser/safe-actions.js';
import { saveMetadata } from '../utils/file-manager.js';
import { ensureProjectInContext, ensureProjectLibrary, navigateToSidebar, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';
import { escapeRegExp, resolveSafePath } from '../utils/sanitize.js';
import { isErrorHtml, extractObservedAccount } from '../browser/app-state.js';
import { get } from '../utils/config.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';
import fs from 'fs';
import { decontaminateModelField } from '../browser/capabilities.js';
import { handleGenerateConfirm } from './generate-confirm.js';
import { fillCharacterDescription, attachCharacterReferenceFiles } from '../browser/character-form.js';

export async function handleCreateCharacter(args) {
  const autoConfirm = args.auto_confirm === true;
  // Preparation always runs as a verified pre-check first.
  const job = jobQueue.createJob('create_character', {
    ...args,
    auto_confirm: false,
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
      await ensureProjectLibrary(page);
      const nav = await navigateToSidebar(page, 'Characters');
      if (!nav) {
        // Fallback: try direct singular /character route
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

      // 404 error check
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

      const formSelector = '[placeholder*="Describe your character" i], [data-placeholder*="Describe your character" i], [aria-label*="Describe your character" i]';
      const onCreateForm = await page.locator(formSelector).first().isVisible().catch(() => false);

      if (!onCreateForm) {
        // Look for a button to open the "New character" creation form
        const newCharLocator = page.getByRole('button', { name: /^(?:New|Create) character$/i })
          .or(page.getByRole('link', { name: /^New character$/i })).first();

        if (await newCharLocator.isVisible().catch(() => false)) {
          await newCharLocator.click();
          await page.waitForTimeout(2000);
          if (!(await page.locator(formSelector).first().isVisible().catch(() => false))) {
            throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'New character did not open the native description form. No description entered.');
          }
        } else {
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

      // Fill character description into character-specific input ONLY.
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

      const pageHtml = await page.content().catch(() => '');
      const observedAccount = extractObservedAccount(pageHtml);
      const observedProjectId = extractProjectId(page.url());

      // Dedicated native character reference attachment adapter
      let references = { requested: [], attached: 0, verified: true, acknowledged: [], notes: [] };
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
          references = await attachCharacterReferenceFiles(page, descLocator, resolved, {
            account: observedAccount,
            projectId: observedProjectId,
          });
        }
        if (resolved.length !== refImages.length) {
          references = { ...references, verified: false, notes: [...references.notes, 'Some requested reference images could not be resolved on disk'] };
        }
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

      const blockers = [];
      if (!references.verified) {
        blockers.push({
          field: 'references',
          code: 'CHARACTER_REFERENCE_UNVERIFIED',
          message: references.reason || 'Character reference attachment unverified in native character form',
          requested: references.requested,
          observed: references.acknowledged,
        });
      }
      if (!observedModel) {
        blockers.push({
          field: 'model',
          code: 'MODEL_CONTROL_UNVERIFIED',
          message: 'Native character image model control unverified',
          requested: args.model || null,
          observed: null,
        });
      }

      const preparationVerified = blockers.length === 0;
      const unapplied = [
        ...(!references.verified ? ['reference_images'] : []),
        ...(!observedModel ? ['model'] : []),
      ];

      const diagnostics = {
        requested: {
          name: args.name || null,
          description: args.description,
          model: args.model || null,
          reference_images: refImages,
        },
        actual: {
          name: args.name || null,
          model: observedModel || null,
          references,
        },
        verified: preparationVerified,
        blockers,
        warnings: references.notes || [],
        screenshot: await takeScreenshot(page, 'character-ready'),
      };

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
        diagnostics,
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
        blockers,
        diagnostics,
        naming: { requested: args.name, status: 'deferred_until_created' },
        message: preparationVerified
          ? 'Character setup complete. Manual confirmation needed to create.'
          : `Character setup unverified (${blockers.map(b => b.message).join('; ')}). Do not confirm until corrected.`,
        screenshot: diagnostics.screenshot,
      });

      return jobQueue.getJob(job.id).result;
    }); // end withUiTransaction

    // Single guarded confirmation boundary: only confirmed if ready_for_confirmation
    if (autoConfirm) {
      if (prepared.status === 'ready_for_confirmation') {
        return await handleGenerateConfirm({ job_id: prepared.jobId, max_credits: args.max_credits, wait_ms: 2000 });
      }
      throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
        `Character preparation is unverified (${prepared.blockers?.map(b => b.message).join('; ') || 'unverified'}). No fields changed and no Generate click made.`,
        { prepared });
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
