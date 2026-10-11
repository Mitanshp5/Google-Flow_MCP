// W04 — real upload flow: Add ingredients → Upload media → filechooser,
// acknowledgement with identity, and separate slot verification.
// input.files acceptance alone never proves slot identity.
import fs from 'fs';
import path from 'path';
import { validateLocalImport, sha256Hex } from '../assets/catalog.js';
export const ADD_INGREDIENTS_SELECTORS = [
  'button:has-text("Add ingredients")',
  '[aria-label*="Add ingredients" i]',
];
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
export async function openUploadPicker(page) {
  const addHit = await clickFirstVisible(page, ADD_INGREDIENTS_SELECTORS);
  if (!addHit) return { fileChooser: null, error: 'Add ingredients entry not found' };
  try {
    await page.waitForTimeout(300);
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
  // Bounded wait registered BEFORE the click; cleanup on timeout.
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
  try {
    await uploadEl.click();
  } catch (e) {
    return { fileChooser: null, error: `Upload media click failed: ${e.message}` };
  }
  const chooser = await chooserPromise;
  if (!chooser) return { fileChooser: null, error: 'filechooser event not observed after Upload media' };
  return { fileChooser: chooser };
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
  const opened = await openUploadPicker(page);
  if (!opened.fileChooser) {
    return { requested, verified: false, reason: opened.error, localRecords, inputAccepted: 0, acknowledged: [], fileChooserSeen: false };
  }
  try {
    await opened.fileChooser.setFiles(list);
  } catch (e) {
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
  const acknowledged = await readUploadAck(page, requested);
  const ack = summarizeUploadAck({ requested, fileChooserSeen: true, inputAccepted, acknowledged });
  return { requested, localRecords, inputAccepted, acknowledged, fileChooserSeen: true, verified: ack.verified, notes: ack.notes };
}
