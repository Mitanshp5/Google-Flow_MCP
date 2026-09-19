import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { launchChromeDirect, setPage, setContext, setConnected, setBrowser, isBrowserConnected } from './connect.js';
import { getDefaultChromePath, getChromeProfileSourcePath } from '../utils/platform.js';

export async function launchKiaraProfile(headless = false) {
  if (isBrowserConnected()) {
    logger.info('Browser already connected, reusing');
    return { success: true, message: 'Already connected' };
  }

  const cdpPort = get('cdpPort', 9222);
  const chromePath = get('chromeExecutable') || getDefaultChromePath();
  const profileName = get('chromeProfile', 'Default');
  const profileSource = (get('chromeUserDataDir') && path.join(get('chromeUserDataDir'), profileName))
    || getChromeProfileSourcePath(profileName);

  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
      `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
  }

  if (!fs.existsSync(profileSource)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR,
      `Chrome profile "${profileName}" not found at ${profileSource}. Set "chromeUserDataDir" and "chromeProfile" in config/flow.config.json, and make sure this Chrome profile is signed in with your Google account.`);
  }

  logger.info('Launching Chrome via direct+CDP method (anti-detection)', { chromePath, profileSource });

  try {
    // Try connecting to existing Chrome instance first (non-destructive reuse)
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    logger.info('Found existing Chrome instance, reusing');
    const ctxs = existing.contexts();
    const ctx = ctxs[0] || await existing.newContext();
    const pgs = ctx.pages();
    const pg = pgs.find(p => {
      try { return p.url().startsWith('http') && !p.url().startsWith('chrome'); } catch { return false; }
    }) || pgs[0];
    setBrowser(existing);
    setContext(ctx);
    setConnected(true);
    if (pg) { setPage(pg); return { browser: existing, context: ctx, page: pg }; }
    const newPage = await ctx.newPage();
    setPage(newPage);
    return { browser: existing, context: ctx, page: newPage };
  } catch {
    // Launch Chrome directly (not via Playwright) for anti-detection
    return await launchChromeDirect({
      chromePath,
      cdpPort,
      headless,
      profileSource,
    });
  }
}

export async function navigateToFlow(page, toolPage) {
  const flowUrl = get('flowUrl', 'https://flow.google.com/');
  const targetUrl = toolPage === true
    ? 'https://flow.google.com/'
    : flowUrl;

  logger.info('Navigating to Google Flow', { url: targetUrl });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for app shell instead of networkidle (Flow SPA streams and never idles).
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  logger.info('Flow page loaded', { url: currentUrl.substring(0, 100) });

  if (currentUrl.includes('accounts.google.com')) {
    return { authenticated: false, url: currentUrl,
      message: 'OAuth blocked — Google detects automation. Use Chrome direct+CDP launch method.' };
  }

  return { authenticated: true, url: currentUrl };
}
