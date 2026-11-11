// W04 — real upload flow: Add ingredients → Upload media → filechooser,
// acknowledgement with identity, and separate slot verification.
// input.files acceptance alone never proves slot identity.
import fs from 'fs';
import path from 'path';
import { validateLocalImport, sha256Hex } from '../assets/catalog.js';
import { readComposerReferences } from './composer-references.js';
import { assetHashRegistry } from '../assets/catalog.js';
import { closeOwnedOverlays } from './overlay-manager.js';
export const ADD_INGREDIENTS_SELECTORS = [
  'button:has-text("Add ingredients")',
  '[aria-label*="Add ingredients" i]',
];
export const ASSET_ID_PATTERNS = {
  flowContentRe: '^https:\\/\\/flow-content\\.google\\/(?:image|video)\\/([a-f0-9-]+)(?:\\?|$)',
  redirectRe: 'media\\.getMediaUrlRedirect\\?name=([a-f0-9-]+)',
  asbRe: '^https:\\/\\/flow\\.google(?:\\.com)?\\/asb\\/([A-Za-z0-9_-]+)(?:=[A-Za-z0-9_-]+)?(?:\\?|$)',
};

export function extractFlowImageAssetId(src) {
  const s = String(src || '');
  const fc = s.match(new RegExp(ASSET_ID_PATTERNS.flowContentRe, 'i'));
  if (fc) return fc[1];
  const redir = s.match(new RegExp(ASSET_ID_PATTERNS.redirectRe, 'i'));
  if (redir) return redir[1];
  const asb = s.match(new RegExp(ASSET_ID_PATTERNS.asbRe, 'i'));
  if (asb) return `asb:${asb[1]}`;
  return null;
}

export const UPLOAD_MEDIA_SELECTORS = [
  'button:has-text("Upload media")',
  '[role="menuitem"]:has-text("Upload media")',
  '[aria-label*="Upload media" i]',
];
const UPLOAD_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

export function buildUploadPlan(files = []) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return { ok: false, reason: 'no files requested' };
  if (list.length > 8) return { ok: false, reason: 'too many files (max 8)' };
  for (const f of list) {
    const base = String(f).split(/[\\/]/).pop() || '';
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    if (!UPLOAD_EXTS.has(ext)) return { ok: false, reason: `unsupported extension "${base}"` };
  }
  return { ok: true, files: list };
}

// verified only when every requested file has an acknowledged identity
// (name + assetId/title). fileChooserSeen=false or missing identities fail.
export function summarizeUploadAck({ requested = [], fileChooserSeen = false, inputAccepted = 0, acknowledged = [] } = {}) {
  const names = [...requested];
  const notes = [];
  if (!fileChooserSeen) notes.push('no filechooser event observed');
  notes.push(`file input accepted ${inputAccepted}/${names.length}`);
  notes.push(`acknowledged identities: ${acknowledged.length}/${names.length}`);
  if (names.length === 0) return { requested: names, inputAccepted, acknowledged, verified: true, notes: ['no files requested'] };
  if (!fileChooserSeen) return { requested: names, inputAccepted, acknowledged, verified: false, notes };
  const byName = new Map(acknowledged.filter((a) => a && a.name).map((a) => [String(a.name).toLowerCase(), a]));
  for (const n of names) {
    const hit = byName.get(String(n).split(/[\\/]/).pop().toLowerCase());
    if (!hit || !(hit.assetId || hit.title)) {
      notes.push(`missing acknowledged identity for "${n}"`);
      return { requested: names, inputAccepted, acknowledged, verified: false, notes };
    }
  }
  return { requested: names, inputAccepted, acknowledged, verified: true, notes };
}

function roleOk(want, got, slotName = '') {
  if (!want) return { verified: true, skipped: true, slot: slotName };
  if (!got || !got.title || !got.assetId) {
    return { requested: want.title ?? null, slot_detected: 'unknown', assetId: got?.assetId ?? null, verified: false, slot: slotName };
  }
  const titleOk =
    String(got.title).trim().toLowerCase() === String(want.title ?? '').trim().toLowerCase();
  if (!titleOk) {
    return { requested: want.title, slot_detected: 'mismatch', assetId: got.assetId, verified: false, slot: slotName };
  }
  // Stable identity: when the expectation carries an asset id, the observed
  // id must be identical. Same-name wrong asset must NOT verify.
  if (want.assetId && got.assetId !== want.assetId) {
    return { requested: want.title, slot_detected: 'stable-id-mismatch', assetId: got.assetId, verified: false, slot: slotName, reason: 'same title but different stable id' };
  }
  // Explicit slot role: when the observed node exposes its slot, it must be
  // the expected role.
  if (got.slot && slotName && got.slot !== slotName) {
    return { requested: want.title, slot_detected: 'wrong-slot', assetId: got.assetId, verified: false, slot: slotName };
  }
  return { requested: want.title, slot_detected: 'verified', assetId: got.assetId, verified: true, slot: slotName };
}

// Separate slot verification. Detects start/end swap explicitly.
// Duplicate titles across roles without disambiguating stable ids block:
// title alone is not identity when the same name exists twice.
export function verifySlotAssignment(expected = {}, observed = {}) {
  const roles = {};
  roles.start = roleOk(expected.start, observed.start, 'start');
  roles.end = roleOk(expected.end, observed.end, 'end');
  const expIng = Array.isArray(expected.ingredients) ? expected.ingredients : [];
  const obsIng = Array.isArray(observed.ingredients) ? observed.ingredients : [];
  roles.ingredients = expIng.map((w, i) => roleOk(w, obsIng[i], `ingredients[${i}]`));
  const expStart = expected.start?.title?.toLowerCase?.().trim?.();
  const expEnd = expected.end?.title?.toLowerCase?.().trim?.();
  const obsStart = observed.start?.title?.toLowerCase?.().trim?.();
  const obsEnd = observed.end?.title?.toLowerCase?.().trim?.();
  const swapped = !!(expStart && expEnd && obsStart === expEnd && obsEnd === expStart);
  // Same-title duplicate across start/end without distinct stable ids is
  // ambiguous even when each role title-matches.
  let duplicateBlocked = false;
  if (expStart && expEnd && expStart === expEnd) {
    const wantA = expected.start?.assetId ?? null;
    const wantB = expected.end?.assetId ?? null;
    const gotA = observed.start?.assetId ?? null;
    const gotB = observed.end?.assetId ?? null;
    if (!wantA || !wantB || wantA === wantB || !gotA || !gotB || gotA === gotB) {
      duplicateBlocked = true;
    } else if (gotA !== wantA || gotB !== wantB) {
      duplicateBlocked = true;
    }
  }
  const verified =
    (expected.start ? roles.start.verified : true) &&
    (expected.end ? roles.end.verified : true) &&
    roles.ingredients.every((r) => r.verified) &&
    !swapped &&
    !duplicateBlocked;
  return { roles, verified, swapped, duplicateBlocked };
}

export function verifyFullReferenceSet({ required = [], actual = [] } = {}) {
  const need = required.map((s) => String(s).trim().toLowerCase());
  const have = new Set(actual.map((s) => String(s).trim().toLowerCase()));
  const missing = required.filter((_, i) => !have.has(need[i]));
  const extra = actual.filter((s) => !need.includes(String(s).trim().toLowerCase()));
  return { complete: missing.length === 0, missing, extra };
}

async function clickFirstVisible(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        return sel;
      }
    } catch { /* next */ }
  }
  return null;
}

// Real picker flow. The filechooser event fires synchronously with the
// Upload-media click, so the wait MUST be registered BEFORE the click and
// awaited together — waiting after the click loses the event.
// Never falls back to blind input[type=file].
export async function openUploadPicker(page, {entryLocator} = {}) {
  const addHit = entryLocator
    ? await entryLocator.click({timeout:3000}).then(()=>true).catch(()=>false)
    : await clickFirstVisible(page, ADD_INGREDIENTS_SELECTORS);
  if (!addHit) return { fileChooser: null, error: 'Add ingredients entry not found' };
  try {
    await page.waitForTimeout(800);
  } catch { /* ignore */ }
  // Locate (but do not yet click) the Upload media entry.
  let uploadEl = null;
  for (const sel of UPLOAD_MEDIA_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        uploadEl = el;
        break;
      }
    } catch { /* next */ }
  }
  if (!uploadEl) return { fileChooser: null, error: 'Upload media entry not found after Add ingredients' };
  // Snapshot already-present picker items before Upload media so repeat filenames stay unambiguous.
  const pickerBaselineIds = typeof page.evaluate === 'function'
    ? await page.evaluate((pats) => {
        const rFc = new RegExp(pats.flowContentRe, 'i');
        const rRedir = new RegExp(pats.redirectRe, 'i');
        const rAsb = new RegExp(pats.asbRe, 'i');
        return [...document.querySelectorAll('flow-add-menu-asset-item img, flow-image-tile img')].map((img) => {
          const s = img.src || '';
          const a = s.match(rAsb);
          return s.match(rFc)?.[1] || s.match(rRedir)?.[1] || (a ? `asb:${a[1]}` : null);
        }).filter(Boolean);
      }, ASSET_ID_PATTERNS).catch(() => [])
    : [];
  // Bounded wait registered BEFORE the click; cleanup on timeout.
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  try {
    await uploadEl.click();
  } catch (e) {
    return { fileChooser: null, error: `Upload media click failed: ${e.message}` };
  }
  const chooser = await chooserPromise;
  if (!chooser) return { fileChooser: null, error: 'filechooser event not observed after Upload media' };
  return { fileChooser: chooser, pickerBaselineIds };
}

// Scoped acknowledgement read: upload chips rendered by the app near the
// composer/picker, carrying name + stable asset identity. Never synthesized
// from input.files counts.
export async function readUploadAck(page, expectedNames = []) {
  try {
    const found = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(
        '.upload-ack, [data-upload-name], [data-chip-id], [data-asset-id]'
      )) {
        const name =
          el.getAttribute?.('data-upload-name') ||
          el.getAttribute?.('data-title') ||
          (el.textContent || '').trim();
        const assetId =
          el.getAttribute?.('data-asset-id') ||
          el.getAttribute?.('data-media-id') ||
          null;
        if (!name) continue;
        out.push({ name, assetId, title: el.getAttribute?.('data-title') || name });
      }
      return out;
    }).catch(() => []);
    if (!Array.isArray(expectedNames) || expectedNames.length === 0) return found;
    const want = new Set(expectedNames.map((n) => String(n).split(/[\\/]/).pop().toLowerCase()));
    return (Array.isArray(found) ? found : []).filter((a) => want.has(String(a.name).split(/[\\/]/).pop().toLowerCase()));
  } catch {
    return [];
  }
}

const COMPOSER_CHIP_IMG_SELECTOR = 'flow-prompt-box flow-ingredient-chip img, flow-ingredient-chip.reference-ingredient-chip img, flow-image-ingredient-chip img, flow-ingredient-chip img';

async function readComposerChipAssetIds(page) {
  if (typeof page.evaluate !== 'function') return [];
  return page.evaluate(({ sel, pats }) => {
    const rFc = new RegExp(pats.flowContentRe, 'i');
    const rRedir = new RegExp(pats.redirectRe, 'i');
    const rAsb = new RegExp(pats.asbRe, 'i');
    return [...document.querySelectorAll(sel)].map((img) => {
      const s = img.src || '';
      const a = s.match(rAsb);
      return s.match(rFc)?.[1] || s.match(rRedir)?.[1] || (a ? `asb:${a[1]}` : null);
    }).filter(Boolean);
  }, { sel: COMPOSER_CHIP_IMG_SELECTOR, pats: ASSET_ID_PATTERNS }).catch(() => []);
}

async function waitForComposerChipId(page, { id = null, excludeIds = [], timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await readComposerChipAssetIds(page);
    if (id) {
      if (current.includes(id)) return id;
    } else {
      const fresh = current.find((cid) => !excludeIds.includes(cid));
      if (fresh) return fresh;
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(300).catch(() => {});
  } while (Date.now() < deadline);
  return null;
}

// Current Flow picker exposes the upload filename and a stable CDN media ID.
// Preserve that mapping, then verify the SAME ID in the composer, not merely
// a matching library thumbnail or input.files (Flow removes its input).
// Note: In /character mode Flow clears the upload spinner to an icon placeholder
// without populating <img> inside flow-add-menu-asset-item until clicked into the
// composer; when that happens we still fail-closed unless a brand new CDN assetId
// appears in the composer chip after selection.
export async function attachUploadedPickerAssets(page, names, { timeoutMs = 90000, excludeAssetIds = [], slot = null, entryLocator = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  const baselineChipIds = slot ? [] : await readComposerChipAssetIds(page);
  let rawItems = [];
  let placeholderReadyAt = null;
  let resolvedMode = null; // 'id' | 'placeholder'
  do {
    if (await page.getByText('Rights to use this image', { exact: true }).isVisible().catch(() => false)) {
      return { verified: false, acknowledged: [], reason: 'rights_confirmation_required',
        message: 'Flow requires you to confirm rights to this image. Acknowledge the visible dialog, then prepare again; no generation was submitted.' };
    }
    rawItems = await page.evaluate((pats) => {
      const rFc = new RegExp(pats.flowContentRe, 'i');
      const rRedir = new RegExp(pats.redirectRe, 'i');
      const rAsb = new RegExp(pats.asbRe, 'i');
      let menuIdx = 0;
      return [...document.querySelectorAll('flow-add-menu-asset-item, flow-image-tile')].map((el) => {
        const isMenuItem = el.tagName?.toLowerCase() === 'flow-add-menu-asset-item';
        const menuIndex = isMenuItem ? menuIdx++ : -1;
        const name = el.querySelector('.asset-title, .footer-title')?.textContent?.trim();
        const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const hasSpinner = Boolean(el.querySelector('mat-spinner, [role="progressbar"]')) || /^Uploading/i.test(rawText);
        const src = el.querySelector('img')?.src || '';
        const a = src.match(rAsb);
        const assetId = src.match(rFc)?.[1] || src.match(rRedir)?.[1] || (a ? `asb:${a[1]}` : null);
        return { menuIndex, isMenuItem, name, title: name, assetId, hasSpinner };
      });
    }, ASSET_ID_PATTERNS).catch(() => []);

    const filteredWithIds = rawItems
      .filter((a) => !a.hasSpinner && a.assetId && !excludeAssetIds.includes(a.assetId))
      .filter((a, i, all) => all.findIndex((b) => b.name === a.name && b.assetId === a.assetId) === i);
    if (names.every((name) => filteredWithIds.filter((a) => a.name === name).length === 1)) {
      resolvedMode = 'id';
      break;
    }

    const anySpinner = rawItems.some((a) => a.hasSpinner && names.includes(a.name));
    const allHaveCompletedOrPlaceholder = !anySpinner && names.every((name) =>
      filteredWithIds.filter((a) => a.name === name).length === 1
      || rawItems.some((a) => a.isMenuItem && a.name === name && !a.hasSpinner && !a.assetId)
    );
    if (allHaveCompletedOrPlaceholder) {
      if (!placeholderReadyAt) placeholderReadyAt = Date.now();
      // Give /project composer up to 4s for thumbnail hydration before selecting the completed placeholder.
      if (timeoutMs >= 5000 && Date.now() - placeholderReadyAt >= 4000) {
        resolvedMode = 'placeholder';
        break;
      }
    } else {
      placeholderReadyAt = null;
    }
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);

  const reopen = async () => {
    const clicked = entryLocator
      ? await entryLocator.click({ timeout: 3000 }).then(() => true).catch(() => false)
      : await clickFirstVisible(page, ADD_INGREDIENTS_SELECTORS);
    if (!clicked) return false;
    await page.locator('flow-add-menu-asset-item').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(350).catch(() => {});
    return true;
  };

  const commitMenuItem = async (menuItem, { expectedId = null, excludeIds = [], name }) => {
    if (!await menuItem.isVisible().catch(() => false) && !await reopen()) {
      return { error: 'Cannot reopen ingredient picker', ack: null };
    }
    await menuItem.click();
    const add = page.getByRole('button', { name: 'Add to prompt', exact: true });
    await add.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    if (await add.isVisible()) await add.click({ timeout: 3000 });
    if (slot) {
      await page.locator('flow-base-prompt-box .frame-trigger').nth(slot === 'start' ? 0 : 1).locator('img').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const refs = await readComposerReferences(page);
      const slotId = refs?.mode === 'frames' && refs.slotsObservable ? refs.slots[slot]?.assetId : null;
      const valid = expectedId ? slotId === expectedId : (slotId && !excludeIds.includes(slotId));
      return { error: null, ack: valid ? { name, title: name, assetId: slotId, slot } : null };
    }
    const chipId = expectedId
      ? await waitForComposerChipId(page, { id: expectedId, timeoutMs: 5000 })
      : await waitForComposerChipId(page, { excludeIds, timeoutMs: 6000 });
    return { error: null, ack: chipId ? { name, title: name, assetId: chipId } : null };
  };

  if (resolvedMode === 'placeholder') {
    const usedMenuIndices = new Set();
    const seenChipIds = new Set([...baselineChipIds, ...excludeAssetIds]);
    const acknowledged = [];
    for (const name of names) {
      const idMatches = rawItems
        .filter((a) => !a.hasSpinner && a.assetId && !excludeAssetIds.includes(a.assetId) && a.name === name)
        .filter((a, i, all) => all.findIndex((b) => b.name === a.name && b.assetId === a.assetId) === i);
      if (idMatches.length === 1) {
        const picked = idMatches[0];
        if (!slot && (await readComposerChipAssetIds(page)).includes(picked.assetId)) {
          acknowledged.push(picked);
          continue;
        }
        const srcFrag = picked.assetId.startsWith('asb:') ? `/asb/${picked.assetId.slice(4)}` : `/image/${picked.assetId}`;
        const item = page.locator('flow-add-menu-asset-item').filter({ has: page.locator(`img[src*="${srcFrag}"]`) }).first();
        const committed = await commitMenuItem(item, { expectedId: picked.assetId, name });
        if (committed.error) {
          await closeOwnedOverlays(page, { preserveRights: true });
          return { verified: false, acknowledged: [], reason: committed.error };
        }
        if (committed.ack) {
          seenChipIds.add(committed.ack.assetId);
          acknowledged.push(committed.ack);
        }
        continue;
      }

      const candidate = rawItems.find((a) =>
        a.isMenuItem && a.menuIndex >= 0 && a.name === name && !a.hasSpinner && !a.assetId && !usedMenuIndices.has(a.menuIndex)
      );
      if (!candidate) {
        await closeOwnedOverlays(page, { preserveRights: true });
        return { verified: false, acknowledged: [], reason: `Upload still pending or ambiguous: ${name}` };
      }
      usedMenuIndices.add(candidate.menuIndex);
      const committed = await commitMenuItem(page.locator('flow-add-menu-asset-item').nth(candidate.menuIndex), { excludeIds: [...seenChipIds], name });
      if (committed.error) {
        await closeOwnedOverlays(page, { preserveRights: true });
        return { verified: false, acknowledged: [], reason: committed.error };
      }
      if (committed.ack) {
        seenChipIds.add(committed.ack.assetId);
        acknowledged.push(committed.ack);
      }
    }
    await closeOwnedOverlays(page, { preserveRights: true });
    return {
      verified: acknowledged.length === names.length,
      acknowledged,
      reason: acknowledged.length === names.length ? null : 'Uploaded assets not all present in the composer',
    };
  }

  const identities = rawItems
    .filter((a) => !a.hasSpinner && (!a.assetId || !excludeAssetIds.includes(a.assetId)))
    .filter((a, i, all) => all.findIndex((b) => b.name === a.name && b.assetId === a.assetId) === i);
  const selected = [];
  for (const name of names) {
    const matches = identities.filter((a) => a.name === name && a.assetId);
    if (matches.length !== 1) {
      await closeOwnedOverlays(page, { preserveRights: true });
      return { verified: false, acknowledged: [], reason: `Upload still pending or ambiguous: ${name}` };
    }
    selected.push(matches[0]);
  }
  for (let i = 0; i < selected.length; i++) {
    const currentChipIds = await readComposerChipAssetIds(page);
    const alreadyAttached = !slot && currentChipIds.includes(selected[i].assetId);
    if (alreadyAttached) continue;
    // Filename alone is ambiguous after retrying an upload. Select the newly
    // observed stable ID, not an older same-named asset in the picker.
    const srcFrag = selected[i].assetId.startsWith('asb:')
      ? `/asb/${selected[i].assetId.slice(4)}`
      : `/image/${selected[i].assetId}`;
    const item = page.locator('flow-add-menu-asset-item').filter({ has: page.locator(`img[src*="${srcFrag}"]`) });
    if (!await item.first().isVisible().catch(() => false)) {
      if (!await reopen()) {
        await closeOwnedOverlays(page, { preserveRights: true });
        return { verified: false, acknowledged: [], reason: 'Cannot reopen ingredient picker' };
      }
      await item.first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    }
    if (await item.count() !== 1) {
      await closeOwnedOverlays(page, { preserveRights: true });
      return { verified: false, acknowledged: [], reason: 'Uploaded item is ambiguous or missing' };
    }
    await item.click();
    // Some picker versions insert directly on selection; others require the
    // preview confirmation. In either case the composer ID/slot below is proof.
    const add = page.getByRole('button', { name: 'Add to prompt', exact: true });
    await add.waitFor({state:'visible',timeout:2000}).catch(()=>{});
    if (await add.isVisible()) await add.click({timeout:3000});
  }
  const acknowledged = [];
  for (const identity of selected) {
    if (slot) {
      await page.locator('flow-base-prompt-box .frame-trigger').nth(slot === 'start' ? 0 : 1).locator('img').waitFor({state:'visible',timeout:5000}).catch(()=>{});
      const refs = await readComposerReferences(page);
      if (refs?.mode === 'frames' && refs.slotsObservable && refs.slots[slot]?.assetId === identity.assetId) {
        acknowledged.push({...identity, slot});
      }
      continue;
    }
    const matchedId = await waitForComposerChipId(page, { id: identity.assetId, timeoutMs: 5000 });
    if (matchedId) acknowledged.push(identity);
  }
  await closeOwnedOverlays(page, { preserveRights: true });
  return { verified: acknowledged.length === names.length, acknowledged,
    reason: acknowledged.length === names.length ? null : 'Uploaded assets not all present in the composer' };
}

// End-to-end upload: local validation/hash → real chooser.setFiles →
// acknowledgement with stable identity scoped to picker/composer.
// Uncertain acknowledgement stays unverified; no fake mock identity.
export async function uploadReferences(page, inputLocator, files = [], opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const requested = list.map((f) => String(f).split(/[\\/]/).pop());
  const plan = buildUploadPlan(list);
  if (!plan.ok) {
    return { requested, verified: false, reason: plan.reason, localRecords: [], inputAccepted: 0, acknowledged: [] };
  }
  // Local validation + hash per file (real fs, no substitutes).
  const localRecords = [];
  for (const abs of list) {
    const base = String(abs).split(/[\\/]/).pop() || '';
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { requested, verified: false, reason: `local file not found: ${base}`, localRecords, inputAccepted: 0, acknowledged: [] };
    }
    const check = validateLocalImport({ absPath: abs, sizeBytes: stat.size, ext });
    if (!check.ok) {
      return { requested, verified: false, reason: `local import invalid (${base}): ${check.reason}`, localRecords, inputAccepted: 0, acknowledged: [] };
    }
    let bytes = null;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      return { requested, verified: false, reason: `local file unreadable: ${base}`, localRecords, inputAccepted: 0, acknowledged: [] };
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
  const baselineIds = typeof page.evaluate === 'function'
    ? await page.evaluate((pats) => {
        const rFc = new RegExp(pats.flowContentRe, 'i');
        const rRedir = new RegExp(pats.redirectRe, 'i');
        const rAsb = new RegExp(pats.asbRe, 'i');
        return [...document.images].map(img => {
          const s = img.src || '';
          const a = s.match(rAsb);
          return s.match(rFc)?.[1] || s.match(rRedir)?.[1] || (a ? `asb:${a[1]}` : null);
        }).filter(Boolean);
      }, ASSET_ID_PATTERNS).catch(() => [])
    : [];
  const opened = await openUploadPicker(page, opts);
  if (!opened.fileChooser) {
    await closeOwnedOverlays(page, { preserveRights: true });
    return { requested, verified: false, reason: opened.error, localRecords, inputAccepted: 0, acknowledged: [], fileChooserSeen: false };
  }
  try {
    await opened.fileChooser.setFiles(list);
  } catch (e) {
    await closeOwnedOverlays(page, { preserveRights: true });
    return { requested, verified: false, reason: `chooser.setFiles failed: ${e.message}`, localRecords, inputAccepted: 0, acknowledged: [], fileChooserSeen: true };
  }
  try {
    await page.waitForTimeout(600);
  } catch { /* ignore */ }
  let inputAccepted = 0;
  try {
    inputAccepted = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      let n = 0;
      for (const el of inputs) n = Math.max(n, el.files ? el.files.length : 0);
      return n;
    }).catch(() => 0);
  } catch {
    inputAccepted = 0;
  }
  void inputLocator;
  let acknowledged = await readUploadAck(page, requested);
  if (!acknowledged.length && await page.locator('flow-add-menu, flow-add-menu-asset-item').count().catch(() => 0)) {
    const excludeIds = [...new Set([...(opts.excludeAssetIds || []), ...baselineIds, ...(opened.pickerBaselineIds || [])])];
    const attached = await attachUploadedPickerAssets(page, requested, { ...opts, excludeAssetIds: excludeIds });
    acknowledged = attached.acknowledged;
    if (!attached.verified) return { requested, localRecords, inputAccepted, acknowledged,
      fileChooserSeen: true, verified: false, reason: attached.reason, notes: [attached.reason] };
  }
  const ack = summarizeUploadAck({ requested, fileChooserSeen: true, inputAccepted, acknowledged });
  await closeOwnedOverlays(page, { preserveRights: true });
  if (ack.verified && Array.isArray(acknowledged)) {
    for (const a of acknowledged) {
      const rec = localRecords.find(r => r.base.toLowerCase() === String(a.name).toLowerCase());
      if (rec && a.assetId) {
        assetHashRegistry.register({
          account: opts.account,
          projectId: opts.projectId,
          hash: rec.hash,
          assetId: a.assetId,
          title: a.title || a.name,
          byteSize: rec.sizeBytes,
          mime: rec.mime,
        });
      }
    }
  }
  return { requested, localRecords, inputAccepted, acknowledged, fileChooserSeen: true, verified: ack.verified, notes: ack.notes };
}
