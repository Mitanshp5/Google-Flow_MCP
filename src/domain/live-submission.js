// Explicit image/video confirmation is the authorization boundary. Evidence is
// still collected by the common handler observers and checked by common policy.
import { get, getFlowHome } from '../utils/config.js';
import { extractProjectId } from '../navigation/project-navigator.js';
import { findActionButton, GENERATE_BUTTON_SELECTORS } from '../browser/safe-actions.js';
import { assertUiCurrent } from '../browser/ui-transaction.js';
import { createOperationStore, mintChildApproval } from './operations.js';
import { digestRequest } from './contracts.js';
import { FlowError } from '../utils/errors.js';
import { getSessionScope } from '../browser/session-scope.js';

export function createLiveAuthorization({ page, confirmed, maxCredits = 2 }) {
  if (confirmed !== true) return null;
  if (getSessionScope()?.handlerSubmission) return null;
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new FlowError('INVALID_PARAMS', 'max_credits must be a finite non-negative number');
  }
  const expectedAccount = get('expectedAccount');
  const intendedProjectId = extractProjectId(page.url());
  if (!expectedAccount || !intendedProjectId || new URL(page.url()).origin !== 'https://flow.google.com') {
    throw new FlowError('MANUAL_VERIFICATION_REQUIRED', 'Live generation requires a configured account and a Google Flow project');
  }
  return {
    page, origin: 'live-browser', expectedAccount, intendedProjectId,
    maxCredits, approvals: new Map(), ledger: { reserved: 0, maxAuthorized: maxCredits },
    opStore: createOperationStore(getFlowHome()),
    approve(payload, quote) {
      const child = mintChildApproval({}, {
        requestDigest: digestRequest(payload), accountKey: expectedAccount,
        projectId: intendedProjectId, model: payload.model,
        quoteTotal: quote?.total, maxCredits,
      });
      this.approvals.set(child.id, child);
      this.approvalChild = child;
    },
    async submit({ epoch }) {
      assertUiCurrent(epoch);
      const found = await findActionButton(page, GENERATE_BUTTON_SELECTORS);
      if (!found || await found.locator.isDisabled()) {
        throw new FlowError('GENERATION_BUTTON_DISABLED', 'Generate button is unavailable; do not automatically retry this operation');
      }
      assertUiCurrent(epoch);
      await found.locator.click({ timeout: 8000 });
      return { remoteStatus: 'pending', message: 'Submitted to Flow. Rendering is not yet complete; inspect the project before downloading. Do not submit again.' };
    },
  };
}
