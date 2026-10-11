/**
 * W00 real-DOM helper (additive; existing mock-page.js untouched).
 * Loads sanitized semantic fixtures from tests/fixtures into a real
 * Playwright page backed by headless Chrome (local setContent only —
 * never CDP to a live session, never navigated to Flow, no network).
 * Each test gets a scoped page; the live global browser state in
 * src/browser/connect.js is never touched.
 *
 * Chrome resolution order (portable, no hard requirement on one path):
 *   1. test-only $W00_CHROME_EXECUTABLE (must exist; a bogus value is
 *      rejected with a warning and resolution continues);
 *   2. platform system default via getDefaultChromePath();
 *   3. Playwright's own installed browser (launch without executablePath).
 * If all fail, launch throws an explicit W00 BLOCKER error (never a
 * silent skip-as-success).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { getDefaultChromePath } from '../../src/utils/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

let browser = null;

export function w00FixtureHtml(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

export function w00ResolveChrome() {
  const tried = [];
  const testOnly = (process.env.W00_CHROME_EXECUTABLE || '').trim();
  if (testOnly) {
    tried.push(`W00_CHROME_EXECUTABLE=${testOnly}`);
    if (fs.existsSync(testOnly)) return { executablePath: testOnly, via: 'W00_CHROME_EXECUTABLE', tried };
    console.warn(`[w00] ignoring missing W00_CHROME_EXECUTABLE=${testOnly}`);
  }
  let sys = null;
  try {
    sys = getDefaultChromePath();
  } catch {
    sys = null;
  }
  tried.push(`platform-default=${sys || '(none)'}`);
  if (sys && fs.existsSync(sys)) return { executablePath: sys, via: 'platform-default', tried };
  tried.push('playwright-bundled');
  return { executablePath: null, via: 'playwright-bundled', tried };
}

export async function w00LaunchBrowser() {
  if (browser) return browser;
  const { executablePath, via, tried } = w00ResolveChrome();
  try {
    browser = await chromium.launch(executablePath
      ? { headless: true, executablePath, args: ['--no-sandbox'] }
      : { headless: true, args: ['--no-sandbox'] });
  } catch (e) {
    throw new Error(
      `W00 BLOCKER: no fixture Chrome available (tried ${tried.join(' | ')}; via=${via}): ${e.message}`,
    );
  }
  browser.__w00LaunchVia = via;
  return browser;
}

export async function w00LoadFixture(name) {
  const b = await w00LaunchBrowser();
  const page = await b.newPage();
  await page.setContent(w00FixtureHtml(name));
  return page;
}

export async function w00CloseBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export function w00SystemChromeAvailable() {
  try {
    return w00ResolveChrome().executablePath != null;
  } catch {
    return false;
  }
}
