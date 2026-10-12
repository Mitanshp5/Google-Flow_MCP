import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext, navigateToSidebar, extractProjectId } from '../navigation/project-navigator.js';

// Rename a character inside its detail page (/character/{id}): open the
// Characters section, open the card matching name/character_id, pencil the
// title, Done. Never touches the project top-bar title.
export async function handleRenameCharacter(args = {}) {
  const want = typeof args.name === 'string' && args.name.trim() ? args.name.trim()
    : typeof args.character_id === 'string' && args.character_id.trim() ? args.character_id.trim() : null;
  const next = typeof args.new_name === 'string' ? args.new_name.trim().slice(0, 200) : '';
  if (!want) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'name (or character_id) is required');
  if (!next) throw new FlowError(ErrorCodes.INVALID_PARAMS, 'new_name is required');

  const page = getPage();
  await ensureProjectInContext(page, { name: args.project_name, campaign: args.campaign, project_url: args.project_url });
  // The sidebar is absent on /character* routes — step back to the project
  // root first so section navigation has a sidebar to click.
  if (/\/character(\/|$)/.test(page.url())) {
    const root = page.url().split('/character')[0];
    await page.goto(root, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const navOk = await navigateToSidebar(page, 'Characters').catch(() => false);
  if (!navOk) throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, 'Characters section did not open');
  await page.waitForTimeout(3000);

  const card = page.locator(`text=${want}`).first();
  if (!(await card.isVisible().catch(() => false))) {
    await takeScreenshot(page, 'rename-character-not-found');
    throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, `Character "${want}" not found in Characters section`);
  }
  await card.click().catch(() => {});
  await page.waitForTimeout(5000);
  const detailUrl = page.url();
  if (!/\/character\//.test(detailUrl)) {
    await takeScreenshot(page, 'rename-character-no-detail');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Character card did not open a detail page');
  }

  const pencil = page.locator('[aria-label*="edit" i]').first();
  if (!(await pencil.isVisible().catch(() => false))) {
    await takeScreenshot(page, 'rename-character-no-pencil');
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Rename control not found on character detail page');
  }
  await pencil.click().catch(() => {});
  await page.waitForTimeout(800);
  const nameInput = page.locator('input[type="text"]').first();
  if (!(await nameInput.isVisible().catch(() => false))) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Character name input did not open');
  }
  await nameInput.fill('').catch(() => {});
  await nameInput.type(next, { delay: 10 }).catch(() => {});
  await page.waitForTimeout(800);
  const done = page.locator('button:has-text("Done")').first();
  if (await done.isVisible().catch(() => false)) await done.click().catch(() => {});
  else await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(2500);

  // The detail UI can lag behind the saved name — reload once and re-check.
  let bodyHas = await page.evaluate((n) => {
    if (document.body.innerText.includes(n)) return true;
    const heads = [...document.querySelectorAll('h1, h2, [role="heading"]')].map(h => (h.innerText || '').trim());
    return heads.some(h => h.includes(n));
  }, next).catch(() => false);
  if (!bodyHas) {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    bodyHas = await page.evaluate((n) => {
      if (document.body.innerText.includes(n)) return true;
      const heads = [...document.querySelectorAll('h1, h2, [role="heading"]')].map(h => (h.innerText || '').trim());
      return heads.some(h => h.includes(n));
    }, next).catch(() => false);
  }
  logger.info('Character renamed', { from: want, to: next, verified: bodyHas });
  if (!bodyHas) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Rename unverified by read-back');
  return { status: 'renamed', from: want, to: next, characterId: extractProjectId(detailUrl) ? detailUrl : detailUrl,
    screenshot: await takeScreenshot(page, 'character-renamed').catch(() => null) };
}
