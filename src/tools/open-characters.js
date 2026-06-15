import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';

/**
 * Open the Characters page for the current/target project.
 *
 * NOTE: "https://labs.google/fx/tools/flow/characters" (no project ID) is
 * NOT a valid page — Flow shows "There doesn't seem to be anything here."
 * The Characters page only exists scoped to a project:
 * "https://labs.google/fx/tools/flow/project/{projectId}/characters"
 */
export async function handleOpenCharacters(args = {}) {
  const page = getPage();

  const project = await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  const projectId = extractProjectId(project.url);
  if (!projectId) {
    throw new Error(`Could not determine project ID from URL: ${project.url}`);
  }

  const charactersUrl = `${buildProjectUrl('https://labs.google/fx/tools/flow', projectId)}/characters`;
  logger.info('Opening Characters page', { charactersUrl });

  await page.goto(charactersUrl, { waitUntil: 'networkidle', timeout: 30000 });
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
