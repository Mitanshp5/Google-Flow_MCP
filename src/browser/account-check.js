import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';
import { extractObservedAccount, verifyAccountState } from './app-state.js';

export async function verifyAccount(page) {
  const activePage = page || getPage();
  const expectedAccount = get('expectedAccount', null);

  logger.info('Verifying Google account on Flow', { expectedAccount });

  try {
    const observed = extractObservedAccount(await activePage.content());
    const state = verifyAccountState({ expected: expectedAccount, observed });
    if (state.state === 'verified') {
      return { verified: true, account: observed, method: 'ui-chip' };
    }
    if (state.state === 'mismatch') {
      await takeScreenshot(activePage, 'wrong-account');
      throw new FlowError(ErrorCodes.WRONG_GOOGLE_ACCOUNT,
        `Wrong Google account detected. Expected ${expectedAccount}, found ${observed}`);
    }
    // Do not guess from arbitrary text or hidden page data. A missing or
    // ambiguous active account must remain unverified.
    return {
      verified: false, account: null, method: 'unverified',
      reason: 'No unambiguous signed-in account found. Sign in to Google Flow.',
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
