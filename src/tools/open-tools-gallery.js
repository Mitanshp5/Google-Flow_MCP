import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { navigateToSidebar, getActiveSidebarSection } from '../navigation/project-navigator.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { escapeRegExp } from '../utils/sanitize.js';
import { isErrorHtml } from '../browser/app-state.js';

export async function handleOpenToolsGallery() {
  const page = getPage();
  const nav = await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  const active = await getActiveSidebarSection(page);
  const elements = await detectPageElements(page);
  const screenshot = await takeScreenshot(page, 'tools-section');

  // F01/F03: Reject if sidebar navigation failed or UI remains in All media
  if (!nav.ok || (active && active.toLowerCase().includes('media'))) {
    return {
      status: 'blocked',
      reason: 'tools_gallery_not_opened',
      message: 'Failed to navigate to Tools gallery; remains in All media or unverified section.',
      activeSection: active,
      url: page.url(),
      elements,
      screenshot,
    };
  }

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
  const nav = await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  const active = await getActiveSidebarSection(page);
  const elements = await detectPageElements(page);

  if (!nav.ok || (active && active.toLowerCase().includes('media'))) {
    return {
      status: 'blocked',
      reason: 'tools_not_found',
      message: 'Failed to navigate to Tools section; remains in All media or unverified section.',
      activeSection: active,
      tools_found: [],
      screenshot: await takeScreenshot(page, 'tools-section-blocked'),
    };
  }

  return {
    status: 'opened',
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

  const currentUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');

  // F02: Check 404 error
  if (isErrorHtml({ title, bodyText, url: currentUrl })) {
    return {
      status: 'blocked',
      reason: 'tool_not_found',
      tool: safeName,
      message: `Tool "${safeName}" route returned 404 or page not found.`,
      url: currentUrl,
      screenshot: await takeScreenshot(page, `tool-${safeName}-not-found`),
    };
  }

  const elements = await detectPageElements(page);
  const shot = sanitizeFileName(`tool-${safeName}`);
  return {
    status: 'opened',
    tool: safeName,
    url: currentUrl,
    elements,
    screenshot: await takeScreenshot(page, shot),
  };
}
