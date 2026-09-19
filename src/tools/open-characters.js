import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';

/**
 * Open the Characters page for the current/target project.
 *
 * NOTE: "{flowBase}/characters" (no project ID) is
 * NOT a valid page. The Characters page only exists scoped to a project:
 * "{flowBase}/project/{projectId}/characters"
 */
export async function handleOpenCharacters(args = {}) {
  const page = getPage();

  const project = await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  const projectId = extractProjectId(project.url);
  if (!projectId) {
    throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, `Could not determine project ID from URL: ${project.url}`);
  }

  const charactersUrl = `${buildProjectUrl(get('flowUrl', 'https://flow.google.com/'), projectId)}/characters`;
  logger.info('Opening Characters page', { charactersUrl });

  await page.goto(charactersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const elements = await detectPageElements();
  const screenshot = await takeScreenshot(page, 'characters-page');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}
