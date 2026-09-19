import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { escapeRegExp } from '../utils/sanitize.js';

export async function handleOpenToolsGallery() {
  const page = getPage();
  await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);
  const screenshot = await takeScreenshot(page, 'tools-section');

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    elements,
    screenshot,
  };
}

export async function handleListTools() {
  const page = getPage();
  await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  const elements = await detectPageElements(page);

  return {
    tools_found: elements,
    screenshot: await takeScreenshot(page, 'tools-section'),
  };
}

export async function handleOpenTool(args) {
  const page = getPage();
  const toolName = args.name || args.tool_name;

  if (!toolName || typeof toolName !== 'string' || !toolName.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Tool name is required');
  }
  const safeName = toolName.trim().slice(0, 100);

  logger.info('Opening tool', { toolName: safeName, projectName: args.project_name });

  await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  // Try to find and click the tool within the project's tools section.
  // Use escaped exact text to avoid selector injection via `"`.
  const toolLocator = page.locator('a, button').filter({ hasText: new RegExp(`^${escapeRegExp(safeName)}$`, 'i') }).first();
  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(3000);
  } else {
    logger.warn('Tool not found in sidebar, trying direct URL');
    const toolSlug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'grid-architect';
    const base = get('flowUrl', 'https://flow.google.com/').replace(/\/+$/, '');
    await page.goto(`${base}/tools/${toolSlug}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
  }

  const elements = await detectPageElements(page);
  const shot = sanitizeFileName(`tool-${safeName}`);
  return {
    status: 'opened',
    tool: safeName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, shot),
  };
}
