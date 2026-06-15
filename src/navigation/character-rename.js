import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';

/**
 * After a character is created, Flow navigates to
 * /project/{id}/character/{characterId}, showing a large "Untitled Character"
 * heading. Click it to edit in-place, select all, type the new name, confirm.
 */
export async function renameCharacterTitle(page, newName) {
  if (!newName) return false;
  logger.info('Renaming character...', { newName });

  const titleSelectors = [
    'h1[contenteditable]',
    'h2[contenteditable]',
    'h1:has-text("Untitled Character")',
    'h2:has-text("Untitled Character")',
    '[contenteditable]:has-text("Untitled Character")',
    'text=Untitled Character',
  ];

  for (const sel of titleSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      await el.click({ clickCount: 3 });
      await page.waitForTimeout(400);

      const activeInput = page.locator('input:focus, [contenteditable]:focus').first();
      const target = (await activeInput.isVisible().catch(() => false)) ? activeInput : el;
      void target;

      await page.keyboard.press('Control+a');
      await page.waitForTimeout(100);
      await page.keyboard.type(newName, { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);

      logger.info('Character renamed', { newName, selector: sel });
      return true;
    } catch { /* try next */ }
  }

  await takeScreenshot(page, 'character-rename-failed');
  logger.warn('Could not rename character — title element not found');
  return false;
}
