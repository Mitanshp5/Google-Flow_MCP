import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { escapeRegExp } from '../utils/sanitize.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';

export async function handleUseFlowTool(args) {
  const page = getPage();
  const toolName = args.tool_name || args.name;

  if (!toolName || typeof toolName !== 'string' || !toolName.trim()) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Tool name is required');
  }
  const safeName = toolName.trim().slice(0, 100);

  await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  // Navigate to Tools sidebar
  await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  // Find the tool in the tools section (escaped exact match — no injection)
  const toolLocator = page.locator('a, button')
    .filter({ hasText: new RegExp(`^${escapeRegExp(safeName)}$`, 'i') }).first();

  if (await toolLocator.isVisible().catch(() => false)) {
    await toolLocator.click();
    await page.waitForTimeout(3000);
  } else {
    // Fallback: try direct URL (sanitized slug)
    const toolSlug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'grid-architect';
    const base = get('flowUrl', 'https://flow.google.com/').replace(/\/+$/, '');
    const toolUrl = `${base}/tools/${toolSlug}`;
    await page.goto(toolUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  const elements = await detectPageElements(page);

  if (args.params && typeof args.params === 'object') {
    for (const [key, value] of Object.entries(args.params)) {
      if (typeof value === 'string') {
        const input = await page.$(
          `[name="${key}"], [placeholder="${key}"], [aria-label="${key}"]`
        );
        if (input) {
          await input.click();
          await input.fill('');
          await page.waitForTimeout(200);
          await input.type(value, { delay: 10 });
        }
      }
    }
  }

  const shotBase = sanitizeFileName(`tool-${safeName}`);

  await takeScreenshot(page, `${shotBase}-setup`);

  return {
    status: 'tool_opened',
    tool: safeName,
    url: page.url(),
    elements,
    screenshot: await takeScreenshot(page, shotBase),
  };
}
