import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { createNewProject } from '../navigation/project-navigator.js';

// Mint a brand-new Flow project via the "New project" button (never reuses
// or renames an existing one). Name is applied at creation; campaign is
// stored in the local registry for later matching.
export async function handleCreateProject(args = {}) {
  const page = getPage();
  const name = typeof args.name === 'string' && args.name.trim()
    ? args.name.trim().slice(0, 200)
    : `Project ${new Date().toLocaleDateString('en-US')}`;
  const campaign = typeof args.campaign === 'string' && args.campaign.trim()
    ? args.campaign.trim().slice(0, 200)
    : null;
  const created = await createNewProject(page, name, campaign);
  logger.info('Project created via tool', { name: created.name, url: created.url });
  return {
    status: 'created',
    name: created.name,
    url: created.url,
    id: created.id,
    screenshot: await takeScreenshot(page, 'new-project').catch(() => null),
  };
}
