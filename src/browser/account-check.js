import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';

export async function verifyAccount(page) {
  const activePage = page || getPage();
  const expectedAccount = get('expectedAccount', 'your-email@gmail.com');
  const currentUrl = activePage.url();

  logger.info('Verifying Google account on Flow', { expectedAccount });

  try {
    // Check the page for account indicators — scan ALL matching elements,
    // not just the first (the first hit is often a generic "Account details"
    // button while the email lives in a sibling chip).
    const chips = await activePage.$$('[data-account-email], [aria-label*="gmail" i], [data-test-id*="account"], [aria-label*="Google Account" i]');
    for (const chip of chips) {
      let text = '';
      try {
        text = (await chip.textContent()) || '';
        if (!text.trim()) {
          text = (await chip.getAttribute('aria-label')) || '';
        }
      } catch { continue; }
      if (text && text.includes(expectedAccount)) {
        logger.info('Account verified via UI chip', { account: expectedAccount });
        return { verified: true, account: expectedAccount, method: 'ui-chip' };
      }
      // Any other account (gmail OR workspace domain) is a mismatch — fail closed.
      const emailMatch = text && text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (emailMatch && !text.includes(expectedAccount)) {
        await takeScreenshot(activePage, 'wrong-account');
        throw new FlowError(
          ErrorCodes.WRONG_GOOGLE_ACCOUNT,
          `Wrong Google account detected. Expected ${expectedAccount}, found account with: ${text.trim().slice(0, 120)}`
        );
      }
    }

    // Method 2: Check page title/header for account indicator
    const title = await activePage.title();
    if (title) {
      logger.debug('Page title', { title });
    }

    // Method 3: Try to find Google account selector
    const accountSelector = await activePage.$('[role="button"][aria-haspopup], .account-chooser, [jsname*="account"]');
    if (accountSelector) {
      const selText = await accountSelector.textContent();
      logger.debug('Account selector found', { text: selText?.substring(0, 50) });
    }

    // Method 4: Read localStorage / session for account info
    try {
      const gaiaInfo = await activePage.evaluate(() => {
        // Try to get account info from various sources
        const flowData = document.getElementById('__NEXT_DATA__')?.textContent;
        if (flowData) {
          try {
            const parsed = JSON.parse(flowData);
            return parsed?.props?.pageProps?.user?.email || null;
          } catch { return null; }
        }
        return null;
      });
      if (gaiaInfo) {
        logger.debug('Account info from page context', { gaiaInfo });
        if (typeof gaiaInfo === 'string' && gaiaInfo !== expectedAccount) {
          await takeScreenshot(activePage, 'wrong-account');
          throw new FlowError(
            ErrorCodes.WRONG_GOOGLE_ACCOUNT,
            `Wrong Google account detected. Expected ${expectedAccount}, page reports ${gaiaInfo}`
          );
        }
        if (gaiaInfo === expectedAccount) {
          return { verified: true, account: expectedAccount, method: 'page-context' };
        }
      }
    } catch (e) {
      if (e instanceof FlowError) throw e;
      // Cross-origin restrictions may prevent this
      logger.debug('Could not read page internals for account', { error: e.message });
    }

    // FAIL CLOSED: without positive evidence we must NOT claim verified.
    // Previously this returned {verified:true, method:'assumed'} — a false positive.
    logger.warn('Account verification inconclusive — no positive evidence found', {
      expectedAccount,
      currentUrl: currentUrl?.substring(0, 80),
    });

    return {
      verified: false,
      account: expectedAccount,
      method: 'unverified',
      reason: 'No account chip or page-context email matched expectedAccount. Open Flow manually and confirm the signed-in account.',
      needsManualCheck: true,
    };
  } catch (err) {
    if (err instanceof FlowError) throw err;
    throw new FlowError(
      ErrorCodes.PLAYWRIGHT_ERROR,
      `Failed to verify account: ${err.message}`
    );
  }
}
