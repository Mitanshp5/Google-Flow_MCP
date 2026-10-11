// W04 — rich composer snapshot/restore-or-invalidate.
// Snapshot: text + mention-chip asset IDs + slot assignment + pending
// uploads + settings + account/project. Restore must verify chips/slots;
// raw innerHTML/text equality alone is never a valid restore claim.
function attr(html, name) {
  const m = String(html).match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

export function parseComposerHtml(html = '') {
  const src = String(html || '');
  const composerOpen = src.match(/<div[^>]*class="[^"]*composer[^"]*"[^>]*>/i)?.[0] || '';
  const account = attr(composerOpen, 'data-account');
  const projectId = attr(composerOpen, 'data-project');
  const textM = src.match(/<div[^>]*class="[^"]*prompt-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const text = textM ? textM[1].replace(/<[^>]+>/g, '').trim() : '';
  const chips = [];
  const chipRe = /<span[^>]*class="[^"]*mention-chip[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = chipRe.exec(src))) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    chips.push({
      id: attr(open, 'data-chip-id'),
      assetId: attr(open, 'data-asset-id'),
      title: attr(open, 'data-title') ?? m[1].trim(),
    });
  }
  const slots = {};
  const slotRe = /<div[^>]*class="[^"]*slot[^"]*"[^>]*>(?:[\s\S]*?)<\/div>/gi;
  while ((m = slotRe.exec(src))) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    const slot = attr(open, 'data-slot');
    if (!slot) continue;
    slots[slot] = { assetId: attr(open, 'data-asset-id'), title: attr(open, 'data-title') };
  }
  const pendingUploads = [];
  const upRe = /<div[^>]*class="[^"]*pending-upload[^"]*"[^>]*>(?:[\s\S]*?)<\/div>/gi;
  while ((m = upRe.exec(src))) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    pendingUploads.push({ name: attr(open, 'data-name'), status: attr(open, 'data-status') });
  }
  const settingsOpen = src.match(/<div[^>]*class="[^"]*composer-settings[^"]*"[^>]*>/i)?.[0] || '';
  const settings = settingsOpen
    ? {
        mode: attr(settingsOpen, 'data-mode'),
        model: attr(settingsOpen, 'data-model'),
        ratio: attr(settingsOpen, 'data-ratio'),
        quantity: attr(settingsOpen, 'data-quantity'),
      }
    : {};
  const has = (re) => re.test(src);
  const chipsObservable =
    chips.length > 0 || has(/id="chips"/i) || has(/data-chips/i) || has(/data-chip-id/i);
  const slotsObservable =
    Object.keys(slots).length > 0 || has(/id="slots"/i) || has(/data-slots/i) || has(/data-slot="/i);
  const uploadsObservable =
    pendingUploads.length > 0 || has(/data-pending-upload/i) || has(/data-upload-name/i) || has(/upload-ack/i);
  const settingsObservable = settingsOpen !== '' || has(/data-mode="/i);
  const bindingObservable = account != null || projectId != null;
  return { text, chips, slots, pendingUploads, settings, account, projectId,
    chipsObservable, slotsObservable, uploadsObservable, settingsObservable, bindingObservable };
}

export function snapshotComposerFromHtml(html = '') {
  return { ...parseComposerHtml(html), takenAt: Date.now() };
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function compareComposerSnapshots(a = {}, b = {}) {
  const textEqual = (a.text || '') === (b.text || '');
  const chipsEqual = eq(a.chips || [], b.chips || []);
  const slotsEqual = eq(a.slots || {}, b.slots || {});
  const uploadsEqual = eq(a.pendingUploads || [], b.pendingUploads || []);
  const settingsEqual = eq(a.settings || {}, b.settings || {});
  const accountEqual = (a.account ?? null) === (b.account ?? null);
  const projectEqual = (a.projectId ?? null) === (b.projectId ?? null);
  const bindingObservable = !!a.bindingObservable && !!b.bindingObservable;
  const equal = textEqual && chipsEqual && slotsEqual && uploadsEqual && settingsEqual && accountEqual && projectEqual;
  return { textEqual, chipsEqual, slotsEqual, uploadsEqual, settingsEqual, accountEqual, projectEqual, bindingObservable, equal };
}

// Failure (or unverified rich state) invalidates prep — never silent success.
export function decideRestoreOrInvalidate({ before = {}, afterAttempt = {}, restoreOk = false } = {}) {
  const cmp = compareComposerSnapshots(before, afterAttempt);
  if (restoreOk && cmp.equal) return { restored: true, mustInvalidatePrep: false, comparison: cmp };
  return {
    restored: false,
    mustInvalidatePrep: true,
    reason: restoreOk ? 'rich state mismatch after restore attempt' : 'restore not verified',
    comparison: cmp,
  };
}

// Strict restore claim: ALL observed rich state must compare equal —
// text, chips, slots, uploads, settings, account/project binding — and
// chip/slot observation must be positive (unknown denies preservation).
// The caller string alone never verifies; innerHTML/text-only never counts.
const VERIFIED_CLAIMERS = new Set(['chip-slot-verify', 'ui-verified', 'restore-verified']);
export function isValidRestoreClaim({ before = {}, after = {}, claimedBy = '' } = {}) {
  if (!VERIFIED_CLAIMERS.has(claimedBy)) return false;
  const cmp = compareComposerSnapshots(before, after);
  if (!cmp.textEqual || !cmp.chipsEqual || !cmp.slotsEqual) return false;
  if (!cmp.uploadsEqual || !cmp.settingsEqual) return false;
  if (!cmp.accountEqual || !cmp.projectEqual) return false;
  if (!cmp.bindingObservable) return false;
  if (before.chipsObservable === false || after.chipsObservable === false) return false;
  if (before.slotsObservable === false || after.slotsObservable === false) return false;
  return true;
}

// F07: a separating space is required before "@" unless the prompt is
// empty or already ends with whitespace. Punctuation endings need it.
export function needsTriggerSpace(promptText = '') {
  const t = String(promptText ?? '');
  if (!t) return false;
  return !/\s$/.test(t);
}

export function hasStrayAt(text = '') {
  return /@\s*$/.test(String(text ?? ''));
}

// Real browser snapshot: text/value plus observed chip IDs, slots, pending
// uploads, settings and account/project binding. Anything not observable is
// flagged explicitly — unknown chip/slot observation denies any positive
// preservation claim downstream.
export async function readComposerSnapshot(page, inputLocator) {
  let text = '';
  try {
    text = (await inputLocator.textContent().catch(() => null))
      ?? (await inputLocator.inputValue?.().catch(() => null))
      ?? '';
  } catch {
    text = '';
  }
  let dom = null;
  try {
    dom = await page.evaluate(() => {
      const chips = [];
      const chipsContainer = document.querySelectorAll('#chips, [data-chips], .chips').length > 0;
      for (const el of document.querySelectorAll('[data-chip-id], .mention-chip')) {
        if (el.id === 'chips') continue;
        chips.push({
          id: el.getAttribute?.('data-chip-id') || null,
          assetId: el.getAttribute?.('data-asset-id') || el.getAttribute?.('data-media-id') || null,
          title: (el.getAttribute?.('data-title') || el.textContent || '').trim(),
        });
      }
      const slots = {};
      const slotsContainer = document.querySelectorAll('#slots, [data-slots]').length > 0;
      for (const el of document.querySelectorAll('[data-slot]')) {
        const name = el.getAttribute('data-slot');
        if (!name) continue;
        slots[name] = {
          assetId: el.getAttribute('data-asset-id') || el.getAttribute('data-media-id') || null,
          title: el.getAttribute('data-title') || (el.textContent || '').trim() || null,
          slot: name,
        };
      }
      const pendingUploads = [];
      const uploadsContainer = document.querySelectorAll('#pending, [data-pending], #uploads').length > 0;
      for (const el of document.querySelectorAll('[data-pending-upload], [data-upload-name], .upload-ack, .pending-upload')) {
        if (el.id === 'pending' || el.id === 'uploads') continue;
        pendingUploads.push({
          name: el.getAttribute?.('data-name') || el.getAttribute?.('data-upload-name') || (el.textContent || '').trim(),
          status: el.getAttribute?.('data-status') || 'unknown',
        });
      }
      const settingsEl = document.querySelector('#settings, [data-mode], .composer-settings');
      const settings = settingsEl
        ? {
            mode: settingsEl.getAttribute?.('data-mode') || null,
            model: settingsEl.getAttribute?.('data-model') || null,
            ratio: settingsEl.getAttribute?.('data-ratio') || null,
            quantity: settingsEl.getAttribute?.('data-quantity') || null,
          }
        : {};
      const scope =
        document.querySelector('#composer, [data-account], [data-project]') || document.body;
      const account = scope?.getAttribute?.('data-account') || null;
      const projectId = scope?.getAttribute?.('data-project') || null;
      return {
        chips,
        chipsContainer,
        slots,
        slotsContainer,
        pendingUploads,
        uploadsContainer,
        settings,
        settingsEl: !!settingsEl,
        account,
        projectId,
      };
    }).catch(() => null);
  } catch {
    dom = null;
  }
  if (!dom) {
    return { text: String(text ?? ''), chips: [], slots: {}, pendingUploads: [], settings: {},
      account: null, projectId: null, chipsObservable: false, slotsObservable: false,
      uploadsObservable: false, settingsObservable: false, bindingObservable: false, takenAt: Date.now() };
  }
  const chipsObservable = dom.chips.length > 0 || dom.chipsContainer;
  const slotsObservable = Object.keys(dom.slots).length > 0 || dom.slotsContainer;
  const uploadsObservable = dom.pendingUploads.length > 0 || dom.uploadsContainer;
  return {
    text: String(text ?? ''),
    chips: dom.chips,
    slots: dom.slots,
    pendingUploads: dom.pendingUploads,
    settings: dom.settings,
    account: dom.account,
    projectId: dom.projectId,
    chipsObservable,
    slotsObservable,
    uploadsObservable,
    settingsObservable: dom.settingsEl,
    bindingObservable: dom.account != null || dom.projectId != null,
    takenAt: Date.now(),
  };
}

// Restore-or-invalidate via verified UI actions: Escape closes the picker,
// focus returns to the composer, then ONLY the exact trigger delta
// ('@' or ' @') is removed. Full rich state is re-read and strictly
// compared — text-only equality never restores.
export async function restoreComposerAfterPicker(page, inputLocator, before, { triggerDelta = '@' } = {}) {
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  } catch { /* ignore */ }
  try {
    await inputLocator.click().catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    await page.waitForTimeout(150);
  } catch { /* ignore */ }
  const delta = String(triggerDelta || '@');
  try {
    const cur = (await inputLocator.textContent().catch(() => null))
      ?? (await inputLocator.inputValue?.().catch(() => null)) ?? '';
    if (typeof cur === 'string') {
      // Remove exactly what we introduced; fall back to a single trailing
      // '@' so text-only mock surfaces still clean picker residue.
      const target = delta && cur.endsWith(delta) ? delta : cur.endsWith('@') ? '@' : '';
      for (let i = 0; i < target.length; i++) {
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout(80);
      }
    }
  } catch { /* non-fatal */ }
  try {
    await inputLocator.click().catch(() => {});
    await page.waitForTimeout(150);
  } catch { /* ignore */ }
  const after = await readComposerSnapshot(page, inputLocator);
  const comparison = compareComposerSnapshots(before, after);
  const ok = isValidRestoreClaim({ before, after, claimedBy: 'restore-verified' });
  if (ok) return { restored: true, mustInvalidatePrep: false, comparison, after };
  return {
    restored: false,
    mustInvalidatePrep: true,
    reason: 'rich composer state differs after picker close',
    comparison,
    after,
  };
}
