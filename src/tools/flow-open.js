import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { get } from '../utils/config.js';
import { assertFlowUrl, clampWaitFor, isFlowUrl } from '../utils/sanitize.js';
import { withUiTransaction } from '../browser/ui-transaction.js';
import {
  classifyAppState,
  shellReadyFromHtml,
  extractObservedAccount,
  verifyAccountState,
} from '../browser/app-state.js';

export async function handleFlowOpen(args) {
  const rawUrl = args.url || get('flowUrl', 'https://flow.google.com/');
  const url = assertFlowUrl(rawUrl);
  const waitFor = clampWaitFor(args.waitFor, 3000, 15000);
  const page = getPage();

  logger.info('Opening Flow page', { url: url.substring(0, 80) });

  try {
    // Serialize navigation so a locked preparation is not silently destroyed.
    // W06 integrates the lease epoch with the operation journal.
    return await withUiTransaction(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(waitFor);

      const currentUrl = page.url();
      const pageTitle = await page.title().catch(() => '');

      await takeScreenshot(page, 'flow-opened').catch(() => {});

      const pageContent = await page.textContent('body').catch(() => '') || '';
      let html = '';
      try {
        if (typeof page.content === 'function') html = await page.content().catch(() => '');
      } catch { html = ''; }

      // W02 F10: allowed origin, verified account and app usability are
      // three INDEPENDENT dimensions. isLoggedIn is true ONLY on positive
      // exact account verification — never from shell presence or absence
      // of a sign-in string. Error/loading pages report account unverified
      // (null), never flipping an independently verified account to false.
      const appState = classifyAppState({ url: currentUrl, title: pageTitle, bodyText: pageContent, html });
      const allowedUrl = isFlowUrl(currentUrl);
      const shellReady = shellReadyFromHtml(html);
      const isAuth = appState.app === 'auth_needed' || currentUrl.includes('accounts.google.com');
      const isError = appState.app === 'error_404';
      const isLoading = appState.app === 'loading';
      const expectedAccount = get('expectedAccount', null);
      const observedAccount = isError || isAuth ? null : extractObservedAccount(html);
      const account = verifyAccountState({ expected: expectedAccount, observed: observedAccount });
      const accountVerified = account.state === 'verified';
      // Logged in == positively verified on THIS page. Unknown stays false.
      const isLoggedIn = accountVerified && !isAuth && !isError && allowedUrl && appState.app === 'ready';
      const isFlowPage = allowedUrl && !isError && shellReady;

      if (isError) {
        return {
          status: 'blocked', url: currentUrl, title: pageTitle,
          isLoggedIn: false, isFlowPage: false,
          allowedUrl, app: 'error_404', account,
          blocker: 'app-error-404: Flow error page; allowed URL is not usable app state',
        };
      }
      if (isAuth) {
        return {
          status: 'needs_login', url: currentUrl, title: pageTitle,
          isLoggedIn: false, isFlowPage: false,
          allowedUrl, app: 'auth_needed', account,
          blocker: 'auth-interstitial-blocked: sign-in/MFA/consent requires manual action',
        };
      }
      if (isLoading || !shellReady) {
        return {
          status: 'loading', url: currentUrl, title: pageTitle,
          isLoggedIn: false, isFlowPage: false,
          allowedUrl, app: 'loading', account,
          blocker: 'app-loading: shell not hydrated; not ready',
        };
      }
      if (account.state === 'mismatch') {
        return {
          status: 'blocked', url: currentUrl, title: pageTitle,
          isLoggedIn: false, isFlowPage,
          allowedUrl, app: 'ready', account,
          blocker: `wrong-account: observed ${observedAccount} does not exactly match expected ${expectedAccount}`,
        };
      }
      if (!accountVerified) {
        return {
          status: 'account_unverified', url: currentUrl, title: pageTitle,
          isLoggedIn: false, isFlowPage,
          allowedUrl, app: 'ready', account,
          blocker: 'account-unverified: no positive exact account token on this page; not logged in',
        };
      }

      return {
        status: 'connected',
        url: currentUrl,
        title: pageTitle,
        isLoggedIn,
        isFlowPage,
        allowedUrl, app: 'ready', account,
        blocker: null,
      };
    });
  } catch (err) {
    await takeScreenshot(page, 'flow-open-error').catch(() => {});
    throw new FlowError(
      ErrorCodes.FLOW_PAGE_NOT_FOUND,
      `Failed to open Flow: ${err.message}`,
      { url }
    );
  }
}
