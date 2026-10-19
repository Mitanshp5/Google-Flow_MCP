import { assertUiCurrent } from '../browser/ui-transaction.js';
import { commitPreInvocation } from './operations.js';
import { digestRequest, deepEqual } from './contracts.js';
import { assertCanSubmit } from './submission-policy.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * W05/W06 Submission Adapter.
 *
 * Bridges MCP generation/mutation tools to the durable operations boundary:
 * 1. Checks UI transaction fencing before any consequential step.
 * 2. Blocks disabled production before any durable side effects.
 * 3. Requires explicit caller evidence bound to actual request/settings/observations.
 * 4. Evaluates the common submission policy and executes atomic durable commit (commitPreInvocation)
 *    covering approval consumption, ledger reservation, CAS write, and journal recording.
 * 5. Marks the invocation boundary (submission_unknown).
 * 6. Governs remote execution: disabled by default; explicit live-browser and
 *    internal local-fixture callbacks both require the full common policy.
 */
export async function executeDurableSubmission({
  page,
  epoch,
  opStore,
  requestPayload,
  observedAccount = null,
  observedProjectId = null,
  verifiedSettings = null,
  refs = [],
  baseline = null,
  quote = null,
  approvalChild = null,
  approvals = null,
  ledger = null,
  remoteSubmitFn = null,
  policyContext = null,
  executionMode = 'production',
} = {}) {
  // Gate 0: UI lease fencing check before submission entry
  assertUiCurrent(epoch);

  if (page && typeof page.isClosed === 'function' && page.isClosed()) {
    throw new FlowError(ErrorCodes.PAGE_CLOSED, 'Browser page is closed; submission refused', {});
  }

  // Unconfigured production remains disabled. Explicit live confirmations use
  // the same evidence, approval, reservation and durable invocation gates.
  if (!['local-fixture', 'live-browser'].includes(executionMode) || typeof remoteSubmitFn !== 'function') {
    throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
      'Remote submission is disabled in Gate A; no invocation or approval consumption occurred.',
      { status: 'blocked', invocation: 'not-invoked' }
    );
  }

  if (!opStore || typeof opStore.createBoundOperation !== 'function') {
    throw new FlowError(ErrorCodes.INTERNAL_ERROR, 'Operation store is required for durable submission', {});
  }
  if (!requestPayload || typeof requestPayload !== 'object') {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Request payload is required for durable submission', {});
  }

  // Gate 1: Enforce verified bindings from actual observations (no unverified placeholders)
  if (!observedAccount || typeof observedAccount !== 'string' || !observedAccount.includes('@')) {
    throw new FlowError('BINDING_UNAVAILABLE', 'Observed account identity is unavailable or unverified; submission denied', {
      binding: 'account',
      observedAccount,
    });
  }
  if (!observedProjectId || typeof observedProjectId !== 'string' || observedProjectId.trim() === '') {
    throw new FlowError('BINDING_UNAVAILABLE', 'Observed project ID is unavailable or unverified; submission denied', {
      binding: 'projectId',
      observedProjectId,
    });
  }
  if (!verifiedSettings || typeof verifiedSettings !== 'object') {
    throw new FlowError('BINDING_UNAVAILABLE', 'Verified settings binding is unavailable; submission denied', {
      binding: 'settings',
      verifiedSettings,
    });
  }
  if (!baseline || !Array.isArray(baseline.ids) || typeof baseline.observedAt !== 'number' || !Number.isFinite(baseline.observedAt)) {
    throw new FlowError('BINDING_UNAVAILABLE', 'Observed media baseline is unavailable; submission denied', {
      binding: 'baseline',
      baseline,
    });
  }
  if (!quote || typeof quote.total !== 'number' || !Number.isFinite(quote.total) || quote.total < 0) {
    throw new FlowError('BINDING_UNAVAILABLE', 'Observed cost quote is unavailable or non-finite; submission denied', {
      binding: 'quote',
      quote,
    });
  }

  if (!approvalChild || !approvals || !ledger) {
    throw new FlowError('APPROVAL_REQUIRED', 'Submission requires authorized approval child and credit ledger for commitPreInvocation', {});
  }

  // The trusted caller supplies evidence; the adapter binds it to the actual
  // request/observations. It never manufactures verification or defaults.
  const requestDigest = digestRequest(requestPayload);
  const denyBinding = (binding) => {
    throw new FlowError('POLICY_DENIED', 'Submission denied: policy evidence does not bind actual request/observations', { binding });
  };
  if (!policyContext || typeof policyContext !== 'object' || Array.isArray(policyContext)) denyBinding('policyContext');
  if (policyContext.requestDigest !== requestDigest) denyBinding('requestDigest');
  if (policyContext.account?.observed !== observedAccount) denyBinding('account');
  if (policyContext.project?.observedId !== observedProjectId) denyBinding('project');
  if (!deepEqual(policyContext.quote, quote)) denyBinding('quote');
  const registeredChild = approvals?.get?.(approvalChild.id) ?? approvals?.[approvalChild.id];
  if (!deepEqual(policyContext.approval, approvalChild) || !deepEqual(registeredChild, approvalChild)) denyBinding('approval');

  if (typeof requestPayload.prompt !== 'string' || !requestPayload.prompt.trim()) denyBinding('prompt');
  for (const dimension of ['type', 'model', 'ratio']) {
    if (typeof requestPayload[dimension] !== 'string' || !requestPayload[dimension].trim()) denyBinding(dimension);
  }
  if (!Number.isInteger(requestPayload.quantity) || requestPayload.quantity < 1) denyBinding('quantity');
  for (const dimension of ['model', 'ratio', 'quantity', 'duration', 'quality']) {
    if (['duration', 'quality'].includes(dimension) && !Object.hasOwn(requestPayload, dimension)) continue;
    if (requestPayload[dimension] == null || !deepEqual(verifiedSettings[dimension], requestPayload[dimension])) denyBinding(dimension);
  }
  if (quote.model !== requestPayload.model || quote.feature !== requestPayload.type || quote.quantity !== requestPayload.quantity) denyBinding('quote-request');

  // Common policy remains authoritative, using the checking clock rather
  // than caller-supplied now. Denial precedes even a draft store write.
  const policyInput = { ...policyContext, approval: registeredChild, now: Date.now() };
  assertCanSubmit(policyInput);

  const op = opStore.createBoundOperation({
    requestDigest,
    requested: requestPayload,
    accountRef: observedAccount,
    projectRef: observedProjectId,
    settingsRef: JSON.stringify(verifiedSettings),
    refs: Array.isArray(refs) ? refs : [],
    quote: { ...quote },
    baseline: { ids: [...baseline.ids], observedAt: baseline.observedAt },
    leaseEpoch: epoch,
  });

  // Pre-action check before durable commit
  assertUiCurrent(epoch);

  policyInput.now = Date.now();

  // Gate 4: Atomic durable commit (commitPreInvocation)
  const committed = commitPreInvocation({
    store: opStore,
    approvals,
    ledger,
    operationId: op.id,
    childId: approvalChild.id,
    reservationAmount: quote.total,
    policyInput,
  });

  logger.info('W05: Pre-invocation commit succeeded', {
    operationId: op.id,
    childId: approvalChild.id,
    reservationAmount: quote.total,
  });

  // Gate 5: Mark invocation boundary (sets status: 'submission_unknown')
  assertUiCurrent(epoch);
  const bounded = opStore.markInvocationBoundary(op.id);

  logger.info('W05: Invocation boundary recorded', {
    operationId: op.id,
    status: bounded.status,
    nonce: bounded.nonce,
  });

  // Pre-action check before consequential submission click
  assertUiCurrent(epoch);

  logger.info('Executing authorized submission callback', { operationId: op.id, executionMode });
  const result = await remoteSubmitFn({ operationId: op.id, epoch, bounded });
  return {
    status: result?.remoteStatus === 'submission_unknown' ? 'submission_unknown' : 'submitted',
    operationId: op.id,
    committed,
    bounded,
    result,
  };
}
