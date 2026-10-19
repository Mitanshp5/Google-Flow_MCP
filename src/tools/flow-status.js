import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { get } from '../utils/config.js';
import { isFlowUrl } from '../utils/sanitize.js';
import { readToolState } from '../browser/safe-actions.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { extractObservedAccount, verifyAccountState, classifyAppState } from '../browser/app-state.js';

export async function handleFlowStatus(args = {}) {
  const expectedAccount = get('expectedAccount', null);
  const status = {
    browser: isBrowserConnected(),
    account: null,
    accountVerified: null,
    flowAccessible: false,
    oauthRequired: false,
    currentUrl: null,
    pageTitle: null,
    appState: 'unknown',
    queue: jobQueue.getStatus(),
    toolState: null,
    screenshot: null,
  };

  if (isBrowserConnected()) {
    try {
      const page = getPage();
      const currentUrl = page.url() || '';
      status.currentUrl = currentUrl;
      const title = await page.title().catch(() => '');
      status.pageTitle = title;

      const html = await page.content().catch(() => '');
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

      const classified = classifyAppState({ url: currentUrl, title, bodyText, html });
      status.appState = classified.app;

      // F10: 404 or auth interstitial is not flowAccessible
      status.flowAccessible = isFlowUrl(currentUrl) && classified.app !== 'error_404' && classified.app !== 'auth_needed';
      status.oauthRequired = classified.app === 'auth_needed' || currentUrl.includes('accounts.google.com');

      // F09: Positive account extraction via app-state helper with element fallback
      let observed = extractObservedAccount(html);
      if (!observed && !html) {
        try {
          const fallbackHtml = await page.evaluate(() => document.documentElement?.outerHTML || '').catch(() => '');
          observed = extractObservedAccount(fallbackHtml);
        } catch { /* ignore */ }
      }
      status.account = observed || null;
      status.accountVerified = verifyAccountState({ expected: expectedAccount, observed: status.account });

      if (status.flowAccessible && !status.oauthRequired) {
        // Tool state inside project
        if (currentUrl.includes('/project/')) {
          status.toolState = await readToolState(page).catch(() => null);
        }
      }

      // F09: full screenshot handling
      if (args?.full === true) {
        try {
          status.screenshot = await takeScreenshot(page, 'flow-status-full');
        } catch (e) {
          logger.warn('Failed to capture full status screenshot', { error: e.message });
        }
      }
    } catch (err) {
      status.browserError = err.message;
    }
  }

  status.expectedAccount = expectedAccount;

  logger.info('Status check', status);
  return status;
}
