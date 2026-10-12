import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';
import { isErrorHtml } from '../browser/app-state.js';

/**
 * Open the Character page for the current/target project.
 *
 * NOTE: F02 route correction: Flow uses singular "/project/{projectId}/character".
 */
export async function handleOpenCharacters(args = {}) {
  const page = getPage();

  const project = await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
    project_url: args.project_url,
  });

  const projectId = extractProjectId(project.url);
  if (!projectId) {
    throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, `Could not determine project ID from URL: ${project.url}`);
  }

  const characterUrl = `${buildProjectUrl(get('flowUrl', 'https://flow.google.com/'), projectId)}/character`;
  logger.info('Opening Character page', { characterUrl });

  await page.goto(characterUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');

  // F02: Check if route redirected to 404 or an error page
  if (isErrorHtml({ title, bodyText, url: currentUrl })) {
    return {
      status: 'blocked',
      reason: 'page_not_found',
      url: currentUrl,
      title,
      message: 'Character route returned 404 or page not found.',
      screenshot: await takeScreenshot(page, 'characters-404'),
    };
  }

  const elements = await detectPageElements();
  const screenshot = await takeScreenshot(page, 'characters-page');

  const feature = await page.getByRole('heading', { name: /^characters?$/i }).first().isVisible().catch(() => false)
    || await page.locator('[placeholder*="Describe your character" i], [aria-label*="Describe your character" i]').first().isVisible().catch(() => false)
    || /build and reuse characters|the eccentric|the professional|the wildcard|the familiar|the wicked|the fantastical/i.test(bodyText);
  if (!feature) {
    return { status: 'blocked', reason: 'character_feature_unverified', url: currentUrl,
      message: 'Character feature identity could not be verified.', elements, screenshot };
  }

  return {
    status: 'opened',
    url: currentUrl,
    title,
    elements,
    screenshot,
  };
}
