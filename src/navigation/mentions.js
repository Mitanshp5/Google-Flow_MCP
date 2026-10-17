import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { needsTriggerSpace, readComposerSnapshot, restoreComposerAfterPicker } from '../browser/composer-state.js';
import { normalizeTitle } from '../assets/catalog.js';

// Typing "@" in a Flow prompt opens a large asset-picker PANEL — not a small
// inline dropdown. The panel has:
//  - a "Search assets" input to filter
//  - category tabs (All / Images / Characters / Avatar / Uploads)
//  - a list of result rows (thumbnail + title + type, e.g. "Cat wearing
//    space suit fl... / Image")
//  - (sometimes) a preview pane on the right + an "Add to Prompt" button
//
// ⚠️  Two insertion behaviours exist depending on the project/UI version:
//  A) DIRECT INSERT (default): clicking a result item immediately inserts
//     the reference as a chip/tag and closes the panel.
//  B) PREVIEW + CONFIRM: clicking selects a preview; a separate
//     "Add to Prompt" click is required to confirm.
//  insertMentionReference() handles both automatically.

const SEARCH_INPUT_SELECTORS = [
  'input[placeholder*="Search assets" i]',
  'input[placeholder*="Search" i]:visible',
];

const ADD_TO_PROMPT_SELECTORS = [
  'button:has-text("Add to Prompt")',
  'button:has-text("Add to prompt")',
];

const RESULT_ITEM_SELECTORS = [
  '[role="listitem"]',
  '[role="option"]',
  '[role="button"]',
  '[class*="asset-item"]',
  '[class*="media-item"]',
  '[class*="grid"] > div',
  'li',
];

// W04: scoped real picker roots. Searches/selections must run INSIDE the
// asset-picker panel, never as page-wide hasText scans.
export const PICKER_ROOT_SELECTORS = [
  '[role="dialog"]:has(input[placeholder*="Search assets" i])',
  '[role="dialog"]:has(input[placeholder*="Search" i])',
  '.cdk-overlay-pane:has(input[placeholder*="Search" i])',
];

// W04: picker query is always the full normalized title — never first word.
export function buildPickerQuery(name) {
  return normalizeTitle(name);
}

// W04: exact title identity. Row text has the trailing type label stripped
// first ("Cow in spaceImage" -> "Cow in space"); then requires full
// case-insensitive equality. Substring/prefix/first-word never matches.
export function isExactRowMatch(rowText, requested) {
  const row = normalizeTitle(stripTypeLabelSuffix(String(rowText ?? ''))).toLowerCase();
  const want = normalizeTitle(requested).toLowerCase();
  if (!row || !want) return false;
  if (row === want) return true;
  // Wrapped titles can break mid-word across lines ("Bob the astr\naut"):
  // spaceless full-string equality still proves identity, never a prefix.
  return row.replace(/\s+/g, '') === want.replace(/\s+/g, '');
}

// W04: insert verification with no first-word fallback. Verified only when
// the full title is present in composer text OR a chip carries the exact
// title plus a stable asset identity.
export function verifyMentionInsert({ requested = '', composerText = '', chips = [] } = {}) {
  const want = normalizeTitle(requested);
  const text = String(composerText ?? '');
  if (want && text.includes(want)) return { verified: true, reason: 'full title in composer text' };
  for (const c of Array.isArray(chips) ? chips : []) {
    if (!c) continue;
    if (normalizeTitle(c.title).toLowerCase() === want.toLowerCase() && (c.assetId || c.id)) {
      return { verified: true, reason: 'exact chip identity' };
    }
  }
  const head = want.split(/\s+/)[0] || '';
  if (head.length > 2 && text.includes(head)) {
    return { verified: false, reason: 'first-word-only text is not exact identity' };
  }
  return { verified: false, reason: 'exact title/asset identity not observed' };
}

// W04: punctuation/boundary-aware trigger. A separating space is typed
// before "@" unless the prompt is empty or already ends with whitespace
// (F07: "normal prompt ending in punctuation" failed without the space).
export async function ensureMentionTriggerSpace(page, inputLocator) {
  try {
    const text = (await inputLocator.textContent().catch(() => null))
      ?? (await inputLocator.inputValue?.().catch(() => null)) ?? '';
    if (needsTriggerSpace(text)) {
      await inputLocator.click().catch(() => {});
      await page.keyboard.press('ControlOrMeta+End').catch(() => {});
      await page.keyboard.type(' ', { delay: 20 }).catch(() => {});
      await page.waitForTimeout(200);
      return { typedSpace: true };
    }
  } catch { /* non-fatal */ }
  return { typedSpace: false };
}

async function findPickerRoot(page) {
  for (const sel of PICKER_ROOT_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) return el;
    } catch { /* next */ }
  }
  return null;
}

// Result rows render as "<title><type label>" concatenated with no
// separator in textContent (e.g. "Cow in spaceImage"). Strip the trailing
// type label so the returned name matches the actual asset title.
const TYPE_LABEL_SUFFIXES = ['Image', 'Character', 'Video', 'Scene', 'Avatar', 'Audio', 'Upload'];

export function stripTypeLabelSuffix(text) {
  for (const suffix of TYPE_LABEL_SUFFIXES) {
    if (text.length > suffix.length && text.endsWith(suffix)) {
      return text.slice(0, -suffix.length).trim();
    }
  }
  return text;
}

async function findVisible(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/**
 * Type "@" at the end of the given input to open Flow's asset-picker panel.
 * Returns { searchInput } if the panel opened, or null if it didn't.
 * On failure, restores the input to its original text (no data loss).
 */
export async function openMentionPopup(page, inputLocator) {
  // Rich snapshot before touching the composer (F08-style preservation).
  let beforeSnapshot = null;
  try {
    beforeSnapshot = await readComposerSnapshot(page, inputLocator);
  } catch {
    beforeSnapshot = null;
  }
  // Snapshot current text so we can restore it if the panel fails to open.
  let before = beforeSnapshot?.text ?? null;
  if (typeof before !== 'string') {
    try {
      before = await inputLocator.textContent().catch(() => null)
        ?? await inputLocator.inputValue?.().catch(() => null);
    } catch { /* ignore */ }
  }
  await inputLocator.click();
  await page.keyboard.press('ControlOrMeta+End');
  // W04 F07: punctuation/boundary-aware trigger — a separating space before
  // "@" is required when the prompt does not already end with whitespace.
  const trigger = await ensureMentionTriggerSpace(page, inputLocator);
  const triggerDelta = trigger.typedSpace ? ' @' : '@';
  await page.keyboard.type('@', { delay: 30 });
  await page.waitForTimeout(900);

  const searchInput = await findVisible(page, SEARCH_INPUT_SELECTORS);
  const addBtn = await findVisible(page, ADD_TO_PROMPT_SELECTORS);

  if (!searchInput && !addBtn) {
    // Panel didn't open — restore the EXACT trigger delta via verified UI
    // actions and refocus the composer.
    if (beforeSnapshot) {
      await restoreComposerAfterPicker(page, inputLocator, beforeSnapshot, { triggerDelta }).catch(() => null);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
      try {
        await inputLocator.click().catch(() => {});
        await page.keyboard.press('End').catch(() => {});
        const after = await inputLocator.textContent().catch(() => null)
          ?? await inputLocator.inputValue?.().catch(() => null);
        if (typeof after === 'string') {
          const target = triggerDelta && after.endsWith(triggerDelta)
            ? triggerDelta
            : after.endsWith('@') && !(before ?? '').endsWith('@') ? '@' : '';
          for (let i = 0; i < target.length; i++) {
            await page.keyboard.press('Backspace').catch(() => {});
          }
          if (target) await inputLocator.click().catch(() => {});
        }
      } catch { /* non-fatal */ }
    }
    return null;
  }

  return { searchInput, addBtn, triggerDelta, before, beforeSnapshot };
}

/**
 * Close the asset-picker panel (if open) and remove the exact trigger delta
 * left in the prompt input — '@' or ' @' when we added the separating space.
 * Focus returns to the composer.
 */
export async function closeMentionPopup(page, inputLocator, triggerDelta = '@') {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const delta = String(triggerDelta || '@');
  if (inputLocator) {
    try {
      const text = await inputLocator.textContent().catch(() => null)
        ?? await inputLocator.inputValue?.().catch(() => null);
      if (typeof text === 'string' && !text.endsWith('@')) return;
    } catch { /* fall through to delta guard below */ }
    await inputLocator.click().catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    // Re-check after focus — only delete the exact delta we introduced.
    try {
      const text2 = await inputLocator.textContent().catch(() => null)
        ?? await inputLocator.inputValue?.().catch(() => null);
      if (typeof text2 === 'string' && delta && text2.endsWith(delta)) {
        for (let i = 0; i < delta.length; i++) {
          await page.keyboard.press('Backspace').catch(() => {});
        }
        await inputLocator.click().catch(() => {});
        return;
      }
      if (typeof text2 === 'string' && !text2.endsWith('@')) return;
    } catch { return; }
  }
  await page.keyboard.press('Backspace');
}

// Success-path residue: '@' is consumed when the chip is inserted, but the
// separating space we typed stays. Remove exactly one trailing '@'.
async function cleanSuccessAtResidue(page, inputLocator) {
  try {
    await inputLocator.click().catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    const text = await inputLocator.textContent().catch(() => null)
      ?? await inputLocator.inputValue?.().catch(() => null);
    if (typeof text === 'string' && text.endsWith('@')) {
      await page.keyboard.press('Backspace').catch(() => {});
      await inputLocator.click().catch(() => {});
    }
  } catch { /* non-fatal */ }
}

/**
 * Open the asset-picker panel on the given input and return the list of
 * available reference names (project images, characters, etc.), without
 * selecting anything. Leaves the input as it was.
 * W04: truthful empty-vs-failed — use listMentionOptionsDetailed when the
 * distinction matters (empty picker vs panel that never opened).
 */
export async function listMentionOptions(page, inputLocator) {
  const detailed = await listMentionOptionsDetailed(page, inputLocator);
  return detailed.names;
}

/**
 * W04 detailed listing: { status, names, reason }.
 * - ok: picker opened, rows found.
 * - empty: picker opened, zero rows (project genuinely has no references).
 * - failed: picker never opened (unknown UI, trigger failure).
 */
export async function listMentionOptionsDetailed(page, inputLocator) {
  const popup = await openMentionPopup(page, inputLocator);
  if (!popup) {
    logger.warn('@ asset panel did not open — could not list references');
    return { status: 'failed', names: [], reason: 'picker did not open' };
  }

  const rawNames = await page.evaluate((sels) => {
    for (const sel of sels) {
      const items = Array.from(document.querySelectorAll(sel));
      const texts = items
        .map(i => (i.textContent || '').trim())
        .filter(t => t.length > 1 && t.length < 200);
      if (texts.length) return texts;
    }
    return [];
  }, RESULT_ITEM_SELECTORS);

  const names = rawNames.map((t) => stripTypeLabelSuffix(normalizeTitle(t))).filter(Boolean);

  if (popup.beforeSnapshot) {
    await restoreComposerAfterPicker(page, inputLocator, popup.beforeSnapshot, {triggerDelta:popup.triggerDelta || '@'});
  } else {
    await closeMentionPopup(page, inputLocator, popup.triggerDelta || '@');
  }
  if (names.length === 0) return { status: 'empty', names, reason: 'picker opened with no rows' };
  return { status: 'ok', names, reason: 'picker opened' };
}

/**
 * Insert an "@name" reference (an existing project image, character, etc.)
 * into the given input via Flow's asset-picker panel.
 *
 * Flow flow: type "@" -> asset panel opens -> type the name into "Search
 * assets" -> click the matching result row -> click "Add to Prompt".
 *
 * Returns true if a reference was inserted, false otherwise.
 */
export async function insertMentionReference(page, inputLocator, name) {
  if (!name) return false;
  logger.info('Inserting @ mention reference', { name });

  const popup = await openMentionPopup(page, inputLocator);
  if (!popup) {
    await takeScreenshot(page, 'mention-panel-not-found');
    logger.warn('@ asset panel did not open', { name });
    return false;
  }

  // Filter results via the panel's "Search assets" box (full title query).
  if (popup.searchInput) {
    await popup.searchInput.click();
    await popup.searchInput.fill('');
    await page.waitForTimeout(200);
    await popup.searchInput.type(buildPickerQuery(name), { delay: 30 });
    await page.waitForTimeout(900);
  }

  // W04: scoped exact row match inside the picker root. Never page-wide
  // substring, never first-row fallback.
  const pickerRoot = await findPickerRoot(page);
  const scope = pickerRoot || page;
  let itemClicked = false;
  for (const sel of RESULT_ITEM_SELECTORS) {
    const candidates = await scope.locator(sel).all().catch(() => []);
    for (const cand of candidates) {
      if (!(await cand.isVisible().catch(() => false))) continue;
      const rowText = ((await cand.textContent().catch(() => '')) || '').trim();
      if (isExactRowMatch(rowText, name)) {
        await cand.click();
        itemClicked = true;
        logger.info('Matched asset row by exact title', { name });
        break;
      }
    }
    if (itemClicked) break;
  }

  // FAIL CLOSED: never click the first row as a fallback. Names are truncated
  // ("Cat wearing space suit fl...") but clicking an unrelated asset would
  // insert the wrong paid reference. Return false so the caller can warn.

  if (!itemClicked) {
    await takeScreenshot(page, 'mention-item-not-found');
    // Rich rollback of the exact trigger delta with focus; chips/slots are
    // never rebuilt from text.
    if (popup.beforeSnapshot) {
      await restoreComposerAfterPicker(page, inputLocator, popup.beforeSnapshot, {
        triggerDelta: popup.triggerDelta || '@',
      }).catch(() => null);
    } else {
      await closeMentionPopup(page, inputLocator, popup.triggerDelta || '@');
    }
    logger.warn('No matching asset found in @ panel', { name });
    return false;
  }

  // Wait briefly for the UI to respond to the click
  await page.waitForTimeout(600);

  // ── UI Behaviour Detection ──────────────────────────────────────────────
  // There are two possible behaviours after clicking a result item:
  //
  //  A) DIRECT INSERT (current default UI):
  //     Clicking the item immediately inserts it as a chip/tag into the
  //     prompt input AND closes the popup.  No further action needed.
  //
  //  B) PREVIEW + CONFIRM (older / alternate UI):
  //     Clicking the item selects it for preview on the right pane and
  //     keeps the panel open.  A separate "Add to Prompt" click is required.
  //
  // We detect which behaviour occurred by checking whether the panel is
  // still visible.  If it closed → insertion already succeeded (A).
  // If still open → we need to click "Add to Prompt" (B).
  // ────────────────────────────────────────────────────────────────────────

  // Check if the popup is still open by looking for the search input or Add to Prompt button
  const panelStillOpen = await findVisible(page, [...SEARCH_INPUT_SELECTORS, ...ADD_TO_PROMPT_SELECTORS]);

  if (!panelStillOpen) {
    // Behaviour A: popup closed automatically → reference chip was inserted.
    // The '@' trigger is consumed; clean the residue, keep the space.
    await cleanSuccessAtResidue(page, inputLocator);
    logger.info('Mention reference inserted directly (popup closed after click)', { name });
    return true;
  }

  // Behaviour B: panel still open → look for "Add to Prompt" button
  const addBtn = page.locator(ADD_TO_PROMPT_SELECTORS.join(', ')).first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(500);
    await cleanSuccessAtResidue(page, inputLocator);
    logger.info('Mention reference added to prompt via "Add to Prompt" button', { name });
    return true;
  }

  // Panel is open but no "Add to Prompt" found — close it gracefully
  await takeScreenshot(page, 'add-to-prompt-not-found');
  if (popup.beforeSnapshot) {
    await restoreComposerAfterPicker(page, inputLocator, popup.beforeSnapshot, {
      triggerDelta: popup.triggerDelta || '@',
    }).catch(() => null);
  } else {
    await closeMentionPopup(page, inputLocator, popup.triggerDelta || '@');
  }
  logger.warn('Panel still open but "Add to Prompt" not found; closed panel', { name });
  return false;
}

/**
 * Insert multiple "@name" references in sequence into the given input.
 * Each insert is READ BACK: the input must contain the name afterwards,
 * else it counts as failed (never silently assume success).
 * Returns { inserted: string[], failed: string[] }.
 */
export async function insertMentionReferences(page, inputLocator, names = []) {
  const inserted = [];
  const failed = [];
  for (const name of names) {
    if (!name) continue;
    const ok = await insertMentionReference(page, inputLocator, name);
    if (!ok) {
      failed.push(name);
      continue;
    }
    // Read-back: exact title/asset identity must be present in the input now.
    // W04: no first-word fallback — truncated chip text without identity fails.
    await page.waitForTimeout(300);
    const after = await inputLocator.textContent().catch(() => '')
      || await inputLocator.inputValue().catch(() => '');
    // Best-effort chip identity read-back (stable asset ids where exposed).
    let chips = [];
    try {
      chips = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-chip-id], [data-asset-id], [data-media-id]')) {
          out.push({
            title: (el.getAttribute('data-title') || el.textContent || '').trim(),
            assetId: el.getAttribute('data-asset-id') || el.getAttribute('data-media-id') || null,
          });
        }
        return out;
      }).catch(() => []);
    } catch { chips = []; }
    const check = verifyMentionInsert({ requested: name, composerText: after, chips });
    if (check.verified) {
      // Consume any leftover trigger '@' (keep the separating space).
      await cleanSuccessAtResidue(page, inputLocator);
      inserted.push(name);
    } else {
      logger.warn('Mention insert unverified by exact read-back', { name, reason: check.reason, actualHead: String(after).slice(0, 80) });
      // W04 rich rollback: remove the exact trigger delta we introduced
      // ('@' or ' @') with focus; chip/slot state cannot be rebuilt from
      // text — caller must invalidate prep when required refs are missing.
      try {
        const delta = typeof after === 'string' && after.endsWith(' @') ? ' @' : '@';
        await page.keyboard.press('Escape').catch(() => {});
        await inputLocator.click().catch(() => {});
        await page.keyboard.press('End').catch(() => {});
        const again = await inputLocator.textContent().catch(() => null)
          ?? await inputLocator.inputValue?.().catch(() => null);
        if (typeof again === 'string' && delta && again.endsWith(delta)) {
          for (let i = 0; i < delta.length; i++) {
            await page.keyboard.press('Backspace').catch(() => {});
          }
          await inputLocator.click().catch(() => {});
        }
      } catch { /* non-fatal */ }
      failed.push(name);
    }
  }
  return { inserted, failed };
}

/**
 * Collect every @name reference source into one ordered list (P0-6):
 * ingredients + references arrays, then the single use_character/use_scene
 * names. Shared by the image and video handlers so both resolve names the
 * same way. Blank/non-string entries are dropped (they could never insert).
 */
export function collectMentionNames({ ingredients, references, use_character, use_scene } = {}) {
  const names = [];
  for (const list of [ingredients, references]) {
    if (!Array.isArray(list)) continue;
    for (const n of list) {
      if (typeof n === 'string' && n.trim()) names.push(n);
    }
  }
  for (const single of [use_character, use_scene]) {
    if (typeof single === 'string' && single.trim()) names.push(single);
  }
  return names;
}
