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
    'input[aria-label="Character name"]',
    'input[placeholder*="Character Name" i]',
    'input[placeholder="Character Name"]',
    'input[value*="Character" i]',
  ];

  for (const sel of inputSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      const nativeName = sel === 'input[aria-label="Character name"]';
      let saved = null;
      if (nativeName) {
        if (await el.inputValue() === newName) return true;
        const pencil = page.getByRole('button', { name: 'Edit name', exact: true });
        if (await pencil.isVisible().catch(() => false)) {
          await pencil.click();
          // Flow debounces the actual title update. Leaving/reloading before
          // its response cancels the save even though inputValue is correct.
          saved = page.waitForResponse(response => {
            if (!response.url().startsWith('https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute')) return false;
            const payload = new URLSearchParams(response.request().postData() || '').get('f.req') || '';
            return response.ok() && payload.includes(newName);
          }, { timeout: 10000 }).then(async response => {
            await response.finished();
            return (await response.text()).includes(newName);
          }).catch(() => false);
        }
      }

      await el.click();
      await page.waitForTimeout(200);
      await el.fill(newName);
      await page.waitForTimeout(200);
      // The native name field saves on leaving edit mode. Enter is not its
      // commit action and can leave the old persisted title unchanged.
      if (nativeName) await el.press('Tab');
      else await page.keyboard.press('Enter');
      await el.blur();
      if (saved && !(await saved)) return false;
      await page.waitForTimeout(600);

      const verified = await el.inputValue() === newName;
      logger.info('Character rename read-back', { newName, selector: sel, verified });
      return verified;
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
