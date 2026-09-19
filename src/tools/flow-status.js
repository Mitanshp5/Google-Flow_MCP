import { logger } from '../utils/logger.js';
import { getPage, isBrowserConnected } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { get } from '../utils/config.js';
import { isFlowUrl } from '../utils/sanitize.js';
import { readToolState } from '../browser/safe-actions.js';

export async function handleFlowStatus() {
  const expectedAccount = get('expectedAccount', 'your-email@gmail.com');
  const status = {
    browser: isBrowserConnected(),
    account: null,
    flowAccessible: false,
    oauthRequired: false,
    currentUrl: null,
    pageTitle: null,
    queue: jobQueue.getStatus(),
    // Live tool state: agent mode, image|video mode, model chip, ratio, quantity.
    toolState: null,
  };

  if (isBrowserConnected()) {
    try {
      const page = getPage();
      status.currentUrl = page.url();
      status.pageTitle = await page.title();
      status.flowAccessible = isFlowUrl(status.currentUrl || '');
      status.oauthRequired = status.currentUrl?.includes('accounts.google.com') || false;

      if (status.flowAccessible && !status.oauthRequired) {
        const accountEl = await page.$('[data-account-email], [aria-label*="gmail"]');
        if (accountEl) {
          status.account = await accountEl.textContent();
        }
        // Tool state is only meaningful inside a project (prompt bar present).
        if ((status.currentUrl || '').includes('/project/')) {
          status.toolState = await readToolState(page).catch(() => null);
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
