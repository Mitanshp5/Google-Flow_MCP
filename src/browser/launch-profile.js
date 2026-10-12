import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { launchChromeDirect, setPage, setContext, setConnected, setBrowser, isBrowserConnected } from './connect.js';
import { getDefaultChromePath, getChromeProfileSourcePath } from '../utils/platform.js';
import { checkHeadlessOption, selectFlowTab } from './session.js';
import { getUiLease, assertUiCurrent } from './ui-transaction.js';

export async function launchKiaraProfile(headless = false, opts = {}) {
  const epoch = getUiLease().getEpoch();
  assertUiCurrent(epoch);
  if (isBrowserConnected()) {
    logger.info('Browser already connected, reusing');
    return { success: true, message: 'Already connected' };
  }

  const cdpPort = Number(opts?.cdpPort) || get('cdpPort', 9222);
  const chromePath = get('chromeExecutable') || getDefaultChromePath();
  const profileName = get('chromeProfile', 'Default');
  const profileSource = (get('chromeUserDataDir') && path.join(get('chromeUserDataDir'), profileName))
    || getChromeProfileSourcePath(profileName);

  const headlessCheck = checkHeadlessOption(headless);
  if (!headlessCheck.supported) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, headlessCheck.blocker);
  }

  // W02 K03: attach to live CDP BEFORE failing for a missing source profile.
  // Profile validation applies only to the authorized cold-launch path.
  try {
    // Try connecting to existing Chrome instance first (non-destructive reuse)
    const existing = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    assertUiCurrent(epoch);
    logger.info('Found existing Chrome instance, reusing');
    const ctxs = existing.contexts();
    const ctx = ctxs[0] || await existing.newContext();
    assertUiCurrent(epoch);
    const pgs = ctx.pages();
    const urls = pgs.map((p) => { try { return { url: p.url() }; } catch { return { url: '' }; } });
    const sel = selectFlowTab(urls);
    const pg = (sel.action === 'reuse' && pgs[sel.index]) || null;
    const newPage = pg || await ctx.newPage();
    assertUiCurrent(epoch);
    setBrowser(existing);
    setContext(ctx);
    setConnected(true);
    setPage(newPage);
    return { browser: existing, context: ctx, page: newPage };
  } catch (error) {
    if (error.code === 'STALE_EPOCH') throw error;
    assertUiCurrent(epoch);
    // Cold-launch path only: validate executable + source profile here
    // (attach-first already attempted above, so a missing profile must not
    // block reuse of a live CDP session).
    if (!chromePath || !fs.existsSync(chromePath)) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
        `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
    }
    if (!fs.existsSync(profileSource)) {
      throw new FlowError(ErrorCodes.CONFIG_ERROR,
        `Chrome profile "${profileName}" not found at ${profileSource}. Set "chromeUserDataDir" and "chromeProfile" in config/flow.config.json, and make sure this Chrome profile is signed in with your Google account.`);
    }
    logger.info('Launching Chrome via direct+CDP method (anti-detection)', { chromePath, profileSource });
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
