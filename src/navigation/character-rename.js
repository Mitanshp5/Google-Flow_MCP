import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { pressSelectAll } from '../browser/safe-actions.js';

/**
 * After a character is created, Flow navigates to
 * /project/{id}/character/{characterId}, showing a large "Untitled Character"
 * heading. Click it to edit in-place, select all, type the new name, confirm.
 */
export async function renameCharacterTitle(page, newName) {
  if (!newName) return false;
  logger.info('Renaming character...', { newName });

  const inputSelectors = [
    'input[placeholder*="Character Name" i]',
    'input[placeholder="Character Name"]',
    'input[value*="Character" i]',
  ];

  for (const sel of inputSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      await el.click();
      await page.waitForTimeout(200);
      await el.fill('');
      await page.waitForTimeout(200);
      await el.fill(newName);
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);

      logger.info('Character renamed via input', { newName, selector: sel });
      return true;
    } catch (e) {
      logger.warn('Failed rename attempt via input', { selector: sel, error: e.message });
    }
  }

  const titleSelectors = [
    'h1[contenteditable]',
    'h2[contenteditable]',
    'h1:has-text("Untitled Character")',
    'h2:has-text("Untitled Character")',
    '[contenteditable]:has-text("Untitled Character")',
  ];

  for (const sel of titleSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      await el.click({ clickCount: 3 });
      await page.waitForTimeout(400);

      await pressSelectAll(page);
      await page.waitForTimeout(100);
      await page.keyboard.type(newName, { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);

      // Read back to verify the rename actually applied.
      const after = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
      if (after && after.includes(newName)) {
        logger.info('Character renamed via heading (verified)', { newName, selector: sel });
        return true;
      }
      logger.info('Character rename attempted via heading (unverified)', { newName, selector: sel });
      return true;
    } catch { /* try next */ }
  }

  await takeScreenshot(page, 'character-rename-failed');
  logger.warn('Could not rename character — title element not found');
  return false;
}
