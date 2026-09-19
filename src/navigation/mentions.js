import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';

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

// Result rows render as "<title><type label>" concatenated with no
// separator in textContent (e.g. "Cow in spaceImage"). Strip the trailing
// type label so the returned name matches the actual asset title.
const TYPE_LABEL_SUFFIXES = ['Image', 'Character', 'Video', 'Scene', 'Avatar', 'Audio', 'Upload'];

function stripTypeLabelSuffix(text) {
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
  // Snapshot current text so we can restore it if the panel fails to open.
  let before = null;
  try {
    before = await inputLocator.textContent().catch(() => null)
      ?? await inputLocator.inputValue?.().catch(() => null);
  } catch { /* ignore */ }
  await inputLocator.click();
  await page.keyboard.press('End');
  await page.keyboard.type('@', { delay: 30 });
  await page.waitForTimeout(900);

  const searchInput = await findVisible(page, SEARCH_INPUT_SELECTORS);
  const addBtn = await findVisible(page, ADD_TO_PROMPT_SELECTORS);

  if (!searchInput && !addBtn) {
    // Panel didn't open — remove ONLY the "@" we just typed, without
    // touching user text. Prefer Escape + selective delete over Backspace
    // (Backspace on failure previously deleted the last prompt char).
    await page.keyboard.press('Escape').catch(() => {});
    try {
      // If the input ends with "@", delete exactly one char; otherwise restore.
      const after = await inputLocator.textContent().catch(() => null);
      if (typeof after === 'string' && typeof before === 'string' && after === `${before}@`) {
        await page.keyboard.press('Backspace');
      } else if (typeof before === 'string' && typeof after === 'string' && after !== before) {
        // Best-effort restore via select-all + retype (only when we have a snapshot).
        await inputLocator.click().catch(() => {});
        await page.keyboard.press('End').catch(() => {});
        // Do not attempt destructive restore for contenteditable with chips — just remove trailing @.
        if (after.endsWith('@') && !before.endsWith('@')) {
          await page.keyboard.press('Backspace');
        }
      }
    } catch { /* non-fatal */ }
    return null;
  }

  return { searchInput, addBtn };
}

/**
 * Close the asset-picker panel (if open) and remove the trailing "@" left
 * in the prompt input — but only if it is actually a trailing "@".
 */
export async function closeMentionPopup(page, inputLocator) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (inputLocator) {
    try {
      const text = await inputLocator.textContent().catch(() => null);
      if (typeof text === 'string' && !text.endsWith('@')) return;
    } catch { /* fall through to single backspace guard below */ }
    await inputLocator.click().catch(() => {});
    await page.keyboard.press('End').catch(() => {});
    // Re-check after focus — only delete when trailing @ is present.
    try {
      const text2 = await inputLocator.textContent().catch(() => null);
      if (typeof text2 === 'string' && !text2.endsWith('@')) return;
    } catch { return; }
  }
  await page.keyboard.press('Backspace');
}

/**
 * Open the asset-picker panel on the given input and return the list of
 * available reference names (project images, characters, etc.), without
 * selecting anything. Leaves the input as it was.
 */
export async function listMentionOptions(page, inputLocator) {
  const popup = await openMentionPopup(page, inputLocator);
  if (!popup) {
    logger.warn('@ asset panel did not open — could not list references');
    return [];
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

  const names = rawNames.map(stripTypeLabelSuffix).filter(Boolean);

  await closeMentionPopup(page, inputLocator);
  return names;
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

  // Filter results via the panel's "Search assets" box
  if (popup.searchInput) {
    await popup.searchInput.click();
    await popup.searchInput.fill('');
    await page.waitForTimeout(200);
    await popup.searchInput.type(name, { delay: 30 });
    await page.waitForTimeout(900);
  }

  // Click the result row whose text matches the requested name
  let itemClicked = false;
  for (const sel of RESULT_ITEM_SELECTORS) {
    const item = page.locator(sel).filter({ hasText: name }).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      itemClicked = true;
      logger.info('Matched asset row by name', { name, selector: sel });
      break;
    }
  }

  // FAIL CLOSED: never click the first row as a fallback. Names are truncated
  // ("Cat wearing space suit fl...") but clicking an unrelated asset would
  // insert the wrong paid reference. Return false so the caller can warn.

  if (!itemClicked) {
    await takeScreenshot(page, 'mention-item-not-found');
    await closeMentionPopup(page, inputLocator);
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
    // Behaviour A: popup closed automatically → reference chip was inserted
    logger.info('Mention reference inserted directly (popup closed after click)', { name });
    return true;
  }

  // Behaviour B: panel still open → look for "Add to Prompt" button
  const addBtn = page.locator(ADD_TO_PROMPT_SELECTORS.join(', ')).first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(500);
    logger.info('Mention reference added to prompt via "Add to Prompt" button', { name });
    return true;
  }

  // Panel is open but no "Add to Prompt" found — close it gracefully
  await takeScreenshot(page, 'add-to-prompt-not-found');
  await closeMentionPopup(page, inputLocator);
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
    // Read-back: name (or its chip) must be present in the input now.
    await page.waitForTimeout(300);
    const after = await inputLocator.textContent().catch(() => '')
      || await inputLocator.inputValue().catch(() => '');
    if (after && after.includes(name)) {
      inserted.push(name);
    } else {
      // Chip may render truncated — accept first-word match as fallback.
      const head = String(name).split(/\s+/)[0];
      if (head.length > 2 && after && after.includes(head)) {
        logger.info('Mention verified via truncated chip text', { name, head });
        inserted.push(name);
      } else {
        logger.warn('Mention insert unverified by read-back', { name, actualHead: String(after).slice(0, 80) });
        failed.push(name);
      }
    }
  }
  return { inserted, failed };
}
