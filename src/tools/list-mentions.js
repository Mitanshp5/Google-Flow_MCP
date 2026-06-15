import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { listMentionOptions } from '../navigation/mentions.js';

/**
 * List the names available in Google Flow's "@" reference popup —
 * i.e. the images and characters in the current project that can be
 * used as ingredients via @name in an image/video prompt.
 */
export async function handleListMentionOptions(args = {}) {
  const page = getPage();

  await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  // Find a prompt input to open the "@" popup from
  const promptCandidates = [
    page.locator('[contenteditable="true"]:visible').first(),
    page.locator('textarea:visible').first(),
  ];

  let promptInput = null;
  for (const candidate of promptCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      promptInput = candidate;
      break;
    }
  }

  if (!promptInput) {
    await takeScreenshot(page, 'no-prompt-input-for-mentions');
    return {
      status: 'error',
      message: 'Could not find a prompt input to open the @ reference popup from.',
      screenshot: await takeScreenshot(page, 'list-mentions-error'),
    };
  }

  const names = await listMentionOptions(page, promptInput);
  logger.info('Listed @ mention options', { count: names.length });

  return {
    status: 'success',
    references: names,
    message: names.length > 0
      ? `Found ${names.length} reference(s) available via @name.`
      : 'No references found — the @ popup may not have opened, or the project has no images/characters yet.',
    screenshot: await takeScreenshot(page, 'mention-options'),
  };
}
