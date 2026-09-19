import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { get } from '../utils/config.js';
import { assertFlowUrl, clampWaitFor, isFlowUrl } from '../utils/sanitize.js';

export async function handleFlowOpen(args) {
  const rawUrl = args.url || get('flowUrl', 'https://flow.google.com/');
  const url = assertFlowUrl(rawUrl);
  const waitFor = clampWaitFor(args.waitFor, 3000, 15000);
  const page = getPage();

  logger.info('Opening Flow page', { url: url.substring(0, 80) });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(waitFor);

    const currentUrl = page.url();
    const pageTitle = await page.title();

    await takeScreenshot(page, 'flow-opened');

    // Detect if we're on a login page or the actual Flow
    const pageContent = await page.textContent('body') || '';
    const isLoggedIn = !pageContent.includes('Sign in') && !currentUrl.includes('SignOut');
    const isFlowPage = isFlowUrl(currentUrl);

    return {
      status: isLoggedIn && isFlowPage ? 'connected' : 'needs_login',
      url: currentUrl,
      title: pageTitle,
      isLoggedIn,
      isFlowPage,
    };
  } catch (err) {
    await takeScreenshot(page, 'flow-open-error');
    throw new FlowError(
      ErrorCodes.FLOW_PAGE_NOT_FOUND,
      `Failed to open Flow: ${err.message}`,
      { url }
    );
  }
}
