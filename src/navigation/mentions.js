import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';

// Typing "@" in a Flow prompt opens a large asset-picker PANEL — not a small
// inline dropdown. The panel has:
//  - a "Search assets" input to filter
//  - category tabs (All / Images / Characters / Avatar / Uploads)
//  - a list of result rows (thumbnail + title + type, e.g. "Cat wearing
//    space suit fl... / Image")
//  - a preview pane on the right
//  - an "Add to Prompt" button to confirm the selection

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
 * Returns { searchInput } if the panel opened, or null if it didn't
 * (and removes the stray "@" in that case).
 */
export async function openMentionPopup(page, inputLocator) {
  await inputLocator.click();
  await page.keyboard.press('End');
  await page.keyboard.type('@', { delay: 30 });
  await page.waitForTimeout(900);

  const searchInput = await findVisible(page, SEARCH_INPUT_SELECTORS);
  const addBtn = await findVisible(page, ADD_TO_PROMPT_SELECTORS);

  if (!searchInput && !addBtn) {
    await page.keyboard.press('Backspace');
    return null;
  }

  return { searchInput, addBtn };
}

/**
 * Close the asset-picker panel (if open) and remove the trailing "@" left
 * in the prompt input.
 */
export async function closeMentionPopup(page, inputLocator) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (inputLocator) {
    await inputLocator.click().catch(() => {});
    await page.keyboard.press('End');
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

  // Fallback: names are often truncated ("Cat wearing space suit fl...")
  // — if no exact match, click the first visible result row.
  if (!itemClicked) {
    for (const sel of RESULT_ITEM_SELECTORS) {
      const item = page.locator(sel).first();
      if (await item.isVisible().catch(() => false)) {
        await item.click();
        itemClicked = true;
        logger.warn('No exact match, clicked first result row', { name, selector: sel });
        break;
      }
    }
  }

  if (!itemClicked) {
    await takeScreenshot(page, 'mention-item-not-found');
    await closeMentionPopup(page, inputLocator);
    logger.warn('No matching asset found in @ panel', { name });
    return false;
  }

  await page.waitForTimeout(600);

  // Confirm the selection with "Add to Prompt"
  const addBtn = page.locator(ADD_TO_PROMPT_SELECTORS.join(', ')).first();
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(500);
    logger.info('Mention reference added to prompt', { name });
    return true;
  }

  await takeScreenshot(page, 'add-to-prompt-not-found');
  await closeMentionPopup(page, inputLocator);
  logger.warn('"Add to Prompt" button not found after selecting asset', { name });
  return false;
}

/**
 * Insert multiple "@name" references in sequence into the given input.
 * Returns { inserted: string[], failed: string[] }.
 */
export async function insertMentionReferences(page, inputLocator, names = []) {
  const inserted = [];
  const failed = [];
  for (const name of names) {
    if (!name) continue;
    const ok = await insertMentionReference(page, inputLocator, name);
    if (ok) inserted.push(name); else failed.push(name);
  }
  return { inserted, failed };
}
