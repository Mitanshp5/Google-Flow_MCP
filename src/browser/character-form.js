import fs from 'fs';
import path from 'path';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { validateLocalImport, sha256Hex, assetHashRegistry } from '../assets/catalog.js';
import { closeOwnedOverlays } from './overlay-manager.js';
import { buildUploadPlan } from './upload.js';


export async function readCharacterReferences(page) {
  try {
    return await page.evaluate(() => {
      const refs = [];
      const chips = document.querySelectorAll(
        '.character-reference, [data-testid="character-reference"], flow-character-form img, .reference-preview img, flow-prompt-box flow-ingredient-chip img, [aria-label*="Describe your character" i] ~ * img'
      );
      chips.forEach((img) => {
        const src = img.src || '';
        const match = src.match(/(?:media\.getMediaUrlRedirect\?name=|flow-content\.google\/image\/)([a-f0-9-]+)/i);
        const name = img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('data-title') || '';
        if (match && !refs.some(r => r.assetId === match[1])) {
          refs.push({ assetId: match[1], name, committed: true });
        }
      });
      return refs;
    });
  } catch {
    return [];
  }
}

export async function attachCharacterReferenceFiles(page, descLocator, files = [], opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const requested = list.map((f) => path.basename(String(f)));
  const plan = buildUploadPlan(list);
  if (!plan.ok) {
    return { requested, verified: false, attached: 0, reason: plan.reason, acknowledged: [], notes: [plan.reason] };
  }

  const localRecords = [];
  for (const abs of list) {
    const base = path.basename(String(abs));
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    let stat = null;
    try { stat = fs.statSync(abs); } catch {
      return { requested, verified: false, attached: 0, reason: `local file not found: ${base}`, acknowledged: [], notes: [`local file not found: ${base}`] };
    }
    const check = validateLocalImport({ absPath: abs, sizeBytes: stat.size, ext });
    if (!check.ok) {
      return { requested, verified: false, attached: 0, reason: `local import invalid (${base}): ${check.reason}`, acknowledged: [], notes: [check.reason] };
    }
    let bytes = null;
    try { bytes = fs.readFileSync(abs); } catch {
      return { requested, verified: false, attached: 0, reason: `local file unreadable: ${base}`, acknowledged: [], notes: [`unreadable: ${base}`] };
    }
    localRecords.push({
      absPath: path.resolve(abs),
      base,
      sizeBytes: stat.size,
      mime: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
      hash: sha256Hex(bytes),
      account: opts.account ?? null,
      projectId: opts.projectId ?? null,
    });
  }

  // Check if all requested files already have known asset IDs in cache and are committed to the form
  const existingRefs = await readCharacterReferences(page);
  const cachedIdentities = [];
  for (const r of localRecords) {
    const cached = assetHashRegistry.lookup({ account: opts.account, projectId: opts.projectId, hash: r.hash });
    if (cached?.assetId && existingRefs.some(ref => ref.assetId === cached.assetId)) {
      cachedIdentities.push({ name: r.base, title: cached.title || r.base, assetId: cached.assetId, selectedInNativeCharacterForm: true, committedToCharacterForm: true });
    }
  }
  if (cachedIdentities.length === localRecords.length) {
    return {
      requested,
      uploaded: true,
      attached: cachedIdentities.length,
      verified: true,
      acknowledged: cachedIdentities,
      notes: ['Reused already committed native character references from verified cache'],
    };
  }

  // Find native character form upload button
  const uploadBtnCandidates = [
    page.getByRole('button', { name: /^Upload$/i }).first(),
    page.locator('button:has-text("Upload")').first(),
    page.locator('button[aria-label*="Upload" i]').first(),
    page.getByRole('button', { name: /Add from Project/i }).first(),
    page.locator('button:has-text("Add ingredients")').first(),
    page.locator('[aria-label*="Add ingredients" i]').first(),
  ];

  let uploadBtn = null;
  for (const cand of uploadBtnCandidates) {
    if (await cand.isVisible().catch(() => false)) {
      uploadBtn = cand;
      break;
    }
  }

  if (!uploadBtn) {
    return { requested, verified: false, attached: 0, reason: 'Character form Upload button not found', acknowledged: [], notes: ['Upload button not visible on character form'] };
  }

  try {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
    await uploadBtn.click();
    const chooser = await chooserPromise;

    if (!chooser) {
      await closeOwnedOverlays(page, { preserveRights: true });
      return { requested, verified: false, attached: 0, reason: 'filechooser event not observed after character form Upload click', acknowledged: [], notes: ['No filechooser event'] };
    }

    await chooser.setFiles(list);
    await page.waitForTimeout(1000);

    // Check for rights confirmation
    if (await page.getByText('Rights to use this image', { exact: true }).isVisible().catch(() => false)) {
      return {
        requested,
        verified: false,
        attached: 0,
        reason: 'rights_confirmation_required',
        message: 'Flow requires you to confirm rights to this image. Acknowledge the visible dialog, then prepare again; no generation was submitted.',
        acknowledged: [],
        notes: ['rights_confirmation_required'],
      };
    }

    // If an "Add to prompt" or "Add" button is visible in the character preview/picker, commit it
    const addToPromptBtn = page.getByRole('button', { name: /Add to prompt/i, exact: true })
      .or(page.locator('button:has-text("Add to prompt")'))
      .or(page.getByRole('button', { name: /^Add$/i }));

    if (await addToPromptBtn.first().isVisible().catch(() => false)) {
      await addToPromptBtn.first().click().catch(() => {});
      await page.waitForTimeout(800);
    }

    // Read back committed references from the native form
    await page.waitForTimeout(500);
    const postRefs = await readCharacterReferences(page);
    const acknowledged = [];

    for (const rec of localRecords) {
      // Find matching committed reference by asset ID or recent arrival
      const hit = postRefs.find(r => r.assetId && !acknowledged.some(a => a.assetId === r.assetId));
      if (hit) {
        acknowledged.push({
          name: rec.base,
          title: rec.base,
          assetId: hit.assetId,
          selectedInNativeCharacterForm: true,
          committedToCharacterForm: true,
        });
        assetHashRegistry.register({
          account: opts.account,
          projectId: opts.projectId,
          hash: rec.hash,
          assetId: hit.assetId,
          title: rec.base,
          byteSize: rec.sizeBytes,
          mime: rec.mime,
        });
      }
    }

    await closeOwnedOverlays(page, { preserveRights: true });

    const verified = acknowledged.length === requested.length;
    return {
      requested,
      uploaded: true,
      attached: acknowledged.length,
      verified,
      acknowledged,
      notes: verified ? ['References successfully committed to native character form'] : ['Not all references could be verified in native character form'],
      reason: verified ? null : 'Character references not all verified in character form',
    };
  } catch (err) {
    await closeOwnedOverlays(page, { preserveRights: true });
    return {
      requested,
      verified: false,
      attached: 0,
      reason: `Character reference attachment failed: ${err.message}`,
      acknowledged: [],
      notes: [err.message],
    };
  }
}

export async function fillCharacterDescription(page, editor, description, archetype) {
  if (archetype) {
    const card = page.getByRole('button').filter({ hasText: archetype }).first();
    if (!(await card.isVisible())) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Requested character archetype is not visible');
    const before = await editor.textContent();
    await card.click();
    // The preset writes asynchronously. A fixed sleep followed by fill races
    // its late response and lets it replace the authored description.
    await page.waitForFunction(({label, before, archetype}) => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')]
        .find(e => e.getAttribute('aria-label') === label);
      const preset = [...document.querySelectorAll('button')].find(e => e.textContent.includes(archetype));
      const generating = preset && /Generating(?:…|\.{3})/i.test(preset.textContent);
      const submit = document.querySelector('button[aria-label="Start generation"]');
      return el && el.textContent !== before && el.textContent.trim().length > 0
        && !generating && (!submit || !submit.disabled);
    }, {label:await editor.getAttribute('aria-label'),before,archetype}, {timeout:120000});
  }
  await editor.fill(description);
  const actual = await editor.inputValue().catch(() => null) ?? await editor.textContent();
  if (actual.replace(/\s+/g,' ').trim() !== description.replace(/\s+/g,' ').trim()) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Character description read-back mismatch. No generation submitted.');
  }
}

export async function waitForCharacterPortrait(page, timeoutMs = 120000) {
  await page.waitForURL(/\/character\/[^/?#]+$/, {timeout:timeoutMs});
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-media-id], img[src*="flow-content.google/image/"], img[src*="media.getMediaUrlRedirect"]')]
    .some(img => img.getBoundingClientRect().width > 0 && img.complete && img.naturalWidth > 0), null, {timeout:timeoutMs});
  return page.evaluate(() => {
    const image = [...document.querySelectorAll('img[data-media-id], img[src*="flow-content.google/image/"], img[src*="media.getMediaUrlRedirect"]')]
      .find(img => img.getBoundingClientRect().width > 0 && img.complete && img.naturalWidth > 0);
    return { assetId:image.getAttribute('data-media-id'), width:image.naturalWidth, height:image.naturalHeight, verified:true };
  });
}
