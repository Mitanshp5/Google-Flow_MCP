import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { ensureProjectLibrary, navigateToSidebar, getActiveSidebarSection } from '../navigation/project-navigator.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';
import { escapeRegExp } from '../utils/sanitize.js';
import { isErrorHtml } from '../browser/app-state.js';

/** Extract tool cards (`<flow-applet-card>`) rendered inside the Flow Tools gallery. */
export async function extractGalleryToolCards(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('flow-applet-card')];
    return cards.map((card) => {
      const raw = (card.innerText || card.textContent || '').trim();
      const lines = raw.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const name = lines[0] || raw.slice(0, 80);
      return { name, summary: lines.filter((l) => l !== 'more_vert').join(' - ').slice(0, 180) };
    }).filter((c) => c.name);
  }).catch(() => []);
}

/** Locate and click a tool card or link from the Flow Tools gallery tabs (`My Tools`, `Templates`, `Community`). */
export async function openGalleryToolByName(page, name) {
  const exactRe = new RegExp(`^${escapeRegExp(name)}$`, 'i');
  const tryClickCardOnCurrentTab = async () => {
    const cards = page.locator('flow-applet-card');
    const count = await cards.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const text = await card.innerText().catch(() => '');
      const firstLine = text.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || '';
      if (exactRe.test(firstLine) && await card.isVisible().catch(() => false)) {
        await card.click();
        await page.waitForTimeout(2500);
        return true;
      }
    }
    return false;
  };

  const directLink = page.locator('a, button').filter({ hasText: exactRe });
  if (await directLink.count().catch(() => 0) === 1 && await directLink.first().isVisible().catch(() => false)) {
    await directLink.first().click();
    await page.waitForTimeout(2500);
    await page.locator('flow-applet-view-page .loading-overlay').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    return true;
  }

  if (await tryClickCardOnCurrentTab()) return true;

  for (const tabLabel of ['Templates', 'Community', 'My Tools']) {
    const tab = page.locator('button, [role="tab"]').filter({ hasText: new RegExp(`^${tabLabel}$`, 'i') }).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(1500);
      if (await tryClickCardOnCurrentTab()) return true;
    }
  }
  return false;
}

export async function handleOpenToolsGallery() {
  const page = getPage();
  await ensureProjectLibrary(page);
  const nav = await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  const active = await getActiveSidebarSection(page);
  const elements = await detectPageElements(page);
  const tools = await extractGalleryToolCards(page);
  const screenshot = await takeScreenshot(page, 'tools-section');

  // navigateToSidebar returns a boolean, not an object with .ok.
  if (!nav || (active && active.toLowerCase().includes('media'))) {
    return {
      status: 'blocked',
      reason: 'tools_gallery_not_opened',
      message: 'Failed to navigate to Tools gallery; remains in All media or unverified section.',
      activeSection: active,
      url: page.url(),
      tools: [],
      elements,
      screenshot,
    };
  }

  return {
    status: 'opened',
    url: page.url(),
    title: await page.title(),
    tools,
    elements,
    screenshot,
  };
}

export async function handleListTools() {
  const page = getPage();
  await ensureProjectLibrary(page);
  const nav = await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  const active = await getActiveSidebarSection(page);
  const elements = await detectPageElements(page);
  const tools = await extractGalleryToolCards(page);

  if (!nav || (active && active.toLowerCase().includes('media'))) {
    return {
      status: 'blocked',
      reason: 'tools_not_found',
      message: 'Failed to navigate to Tools section; remains in All media or unverified section.',
      activeSection: active,
      tools: [],
      tools_found: [],
      screenshot: await takeScreenshot(page, 'tools-section-blocked'),
    };
  }

  return {
    status: 'opened',
    tools,
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

  await ensureProjectLibrary(page);
  await navigateToSidebar(page, 'Tools');
  await page.waitForTimeout(2000);

  // Try to find and click the tool within the project's tools section or gallery tabs.
  const openedFromGallery = await openGalleryToolByName(page, safeName);
  if (!openedFromGallery) {
    logger.warn('Tool not found in sidebar or gallery tabs, trying direct URL');
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
