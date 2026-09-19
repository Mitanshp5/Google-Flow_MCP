import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import os from 'os';
import { getDefaultChromePath, getChromeProfileSourcePath } from '../utils/platform.js';
import { isFlowUrl } from '../utils/sanitize.js';

let browser = null;
let context = null;
let page = null;
let isConnected = false;
let selfLaunched = false;
// Serialize concurrent connect/launch calls (prevents double-launch on same port).
let connectPromise = null;

function isPageAlive(p) {
  try {
    return !!p && !p.isClosed();
  } catch {
    return false;
  }
}

export function isBrowserConnected() {
  try {
    if (!isConnected || !browser) return false;
    if (!browser.isConnected()) return false;
    return isPageAlive(page);
  } catch {
    return false;
  }
}

async function attachToExisting(cdpUrl) {
  const existing = await chromium.connectOverCDP(cdpUrl);
  const contexts = existing.contexts();
  let ctx = contexts[0] || null;
  // connectOverCDP to a real Chrome should always have a context; only
  // create one as a last resort (it would be incognito, no profile cookies).
  if (!ctx) {
    logger.warn('CDP has no contexts — creating a fresh one (no profile cookies)');
    ctx = await existing.newContext();
  }
  const pages = ctx.pages();
  // Prefer a Flow tab if one exists; avoid chrome:// / devtools pages.
  let pg = pages.find(p => {
    try {
      const u = p.url();
      return isFlowUrl(u);
    } catch { return false; }
  }) || pages.find(p => {
    try {
      const u = p.url();
      return u.startsWith('http') && !u.startsWith('chrome');
    } catch { return false; }
  }) || pages[0] || await ctx.newPage();
  return { browser: existing, context: ctx, page: pg, reused: true };
}

export async function connectToBrowser(options = {}) {
  if (isBrowserConnected()) {
    logger.info('Already connected to browser');
    return { browser, context, page };
  }
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const cdpPort = options.cdpPort || get('cdpPort', 9222);
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    try {
      // Try connecting to existing Chrome instance via CDP
      logger.info('Attempting CDP connection', { url: cdpUrl });
      const attached = await attachToExisting(cdpUrl);
      browser = attached.browser;
      context = attached.context;
      page = attached.page;
      isConnected = true;
      selfLaunched = false;
      wireDisconnectHandler();
      logger.info('Browser connected successfully');
      return { browser, context, page };
    } catch (err) {
      logger.warn('CDP connection failed, will launch new browser', { error: err.message });
      return await launchNewBrowser(cdpPort, options);
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

function wireDisconnectHandler() {
  try {
    browser?.on?.('disconnected', () => {
      logger.warn('Browser disconnected event — resetting connection state');
      browser = null;
      context = null;
      page = null;
      isConnected = false;
      selfLaunched = false;
    });
  } catch { /* ignore */ }
}

async function launchNewBrowser(cdpPort, options = {}) {
  const chromePath = options.chromePath || get('chromeExecutable') || getDefaultChromePath();
  const { getFlowHome } = await import('../utils/config.js');
  const profileDir = options.profileDir || path.join(getFlowHome(), 'chrome-profile-kiara');

  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
      `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
  }

  const headlessOpt = options.headless ?? get('headless', false);
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--window-size=1920,1080`,
  ];

  if (headlessOpt) {
    args.push('--headless=new');
  }

  // Do NOT kill a user's existing Chrome on this port. If something is already
  // listening, reuse it instead of closing it (closing kills all user tabs).
  try {
    const attached = await attachToExisting(`http://127.0.0.1:${cdpPort}`);
    browser = attached.browser;
    context = attached.context;
    page = attached.page;
    isConnected = true;
    selfLaunched = false;
    wireDisconnectHandler();
    logger.info('Reusing existing Chrome on CDP port instead of launching new');
    return { browser, context, page };
  } catch {
    // No existing instance, proceed to launch.
  }

  logger.info('Launching Chrome with Kiara profile', {
    chromePath,
    profileDir,
    cdpPort,
  });

  browser = await chromium.launch({
    executablePath: chromePath,
    args,
    headless: false,
  });
  selfLaunched = true;

  const contexts = browser.contexts();
  context = contexts[0] || await browser.newContext();
  const pages = context.pages();
  page = pages[0] || await context.newPage();
  isConnected = true;
  wireDisconnectHandler();

  logger.info('New browser launched successfully');
  return { browser, context, page };
}

/**
 * Launch Chrome DIRECTLY (not via Playwright) to avoid automation detection
 * (navigator.webdriver=false). Creates temp user-data-dir with Default cookies,
 * launches Chrome via shell, then connects Playwright via CDP.
 */
export async function launchChromeDirect(options = {}) {
  const chromePath = options.chromePath || get('chromeExecutable') || getDefaultChromePath();
  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const headless = options.headless ?? get('headless', false);
  const profileSource = options.profileSource
    || (get('chromeUserDataDir') && path.join(get('chromeUserDataDir'), get('chromeProfile', 'Default')))
    || getChromeProfileSourcePath(get('chromeProfile', 'Default'));

  if (isBrowserConnected()) {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    if (!chromePath || !fs.existsSync(chromePath)) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
        `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
    }

    // Prefer reusing a running Chrome (started via `npm run start-browser`).
    // Never kill the user's browser — closing the CDP browser kills all tabs.
    try {
      const attached = await attachToExisting(`http://127.0.0.1:${cdpPort}`);
      browser = attached.browser;
      context = attached.context;
      page = attached.page;
      isConnected = true;
      selfLaunched = false;
      wireDisconnectHandler();
      logger.info('Reusing running Chrome via CDP (no new launch needed)');
      return { browser, context, page };
    } catch {
      // Nothing listening — fall through to direct launch.
    }

    const { randomUUID } = await import('crypto');
    const tempDir = path.join(os.tmpdir(), `chrome-kiara-cdp-${Date.now()}-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // NOTE: copying a live Chrome profile (locked SQLite) can corrupt cookies.
    // Only copy when the source profile is NOT in use (i.e. Chrome closed for
    // that profile). If copy fails, continue with a fresh temp profile and let
    // the user sign in via the launched window.
    const localStateSrc = path.join(path.dirname(profileSource), 'Local State');
    try {
      if (fs.existsSync(profileSource)) {
        fs.cpSync(profileSource, path.join(tempDir, get('chromeProfile', 'Default')), { recursive: true });
      }
      if (fs.existsSync(localStateSrc)) {
        fs.cpSync(localStateSrc, path.join(tempDir, 'Local State'));
      } else {
        fs.writeFileSync(path.join(tempDir, 'Local State'), JSON.stringify({ profile: { info_cache: {} } }));
      }
      logger.info('Temp profile created with cookies', { tempDir });
    } catch (e) {
      logger.warn('Profile copy failed (profile may be locked) — using fresh temp profile', { error: e.message });
    }

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempDir}`,
      `--profile-directory=${get('chromeProfile', 'Default')}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ];
    if (headless) args.push('--headless=new');

    logger.info('Launching Chrome directly', { chromePath, cdpPort, headless });

    const chromeProcess = spawn(chromePath, args, { stdio: 'ignore', detached: true });
    chromeProcess.unref();
    global.__chromeProcess = chromeProcess;
    selfLaunched = true;

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    let attempts = 0;
    while (attempts < 20) {
      try {
        const resp = await fetch(`${cdpUrl}/json/version`);
        if (resp.ok) break;
      } catch { }
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
    if (attempts >= 20) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, 'Chrome CDP failed to start in time');
    }

    browser = await chromium.connectOverCDP(cdpUrl);
    const ctxs = browser.contexts();
    context = ctxs[0] || await browser.newContext();
    const pgs = context.pages();
    page = pgs[0] || await context.newPage();
    isConnected = true;
    global.__chromeTempDir = tempDir;
    wireDisconnectHandler();

    let webdriver = 'unknown';
    try {
      webdriver = await page.evaluate(() => navigator.webdriver);
    } catch (e) {
      logger.warn('webdriver probe failed — marking disconnected', { error: e.message });
      isConnected = false;
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `CDP page not usable: ${e.message}`);
    }

    logger.info('Chrome direct + CDP connected', { webdriver });
    return { browser, context, page };
  })();
  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function closeBrowser() {
  // Close CDP connection first, then kill self-launched Chrome, then clean temp dir
  // (rmSync fails on Windows while files are still locked).
  if (browser) {
    try {
      if (selfLaunched) {
        await browser.close();
      } else {
        // User-owned Chrome: just detach, do NOT close their tabs.
        await browser.close().catch(() => {});
      }
    } catch (err) {
      logger.warn('Error closing browser', { error: err.message });
    }
  }
  browser = null;
  context = null;
  page = null;
  isConnected = false;
  selfLaunched = false;
  if (global.__chromeProcess) {
    try { global.__chromeProcess.kill(); } catch (e) { }
    // Give Windows time to release file locks before rmSync.
    await new Promise(r => setTimeout(r, 500)).catch(() => {});
    global.__chromeProcess = null;
  }
  if (global.__chromeTempDir) {
    const dir = global.__chromeTempDir;
    global.__chromeTempDir = null;
    // Retry once on Windows (EBUSY/EPERM while Chrome shuts down).
    for (let i = 0; i < 2; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        logger.warn('Temp cleanup failed', { error: e.message, attempt: i + 1 });
        await new Promise(r => setTimeout(r, 1000)).catch(() => {});
      }
    }
  }
  logger.info('Browser disconnected');
}

export function getPage() {
  if (!isPageAlive(page) || !isConnected) {
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, 'Browser not connected or page was closed. Call flow_connect first.');
  }
  return page;
}

export function getContext() {
  return context;
}

export function setPage(newPage) {
  page = newPage;
}

export function getBrowser() {
  return browser;
}

export function setBrowser(b) {
  browser = b;
}

export function setConnected(connected) {
  isConnected = connected;
}

export function setContext(ctx) {
  context = ctx;
}

export function isSelfLaunched() {
  return selfLaunched;
}
