// W01: positive account state + common submission DENIAL policy.
// Plan refs: Sec 3.3 (request-bound approvals, zero-cost policy, freshness),
// R01 (account guarded at spend), failure K05/K13/K14.
// Pure default-deny: ONLY an explicitly fully-bound evidence set allows a
// submit — positive fresh account, bound project, all required verification
// keys verified with fresh readback timestamps + evidence, readable exact
// quote (non-negative, unit/quantity bound, fresh ≤30s, finite expiry),
// bound single-use approval (id/nonce/digest/account/project/model, finite
// expiry, unconsumed), and current exact capabilities. Legacy booleans
// (confirm_generate/auto_confirm), missing bindings, future/stale
// timestamps, null entries, arbitrary na, and absent digests all deny.
// W05 consumes approvals/reservations durably; no live click in this lane.
import { FlowError } from '../utils/errors.js';

export const QUOTE_FRESHNESS_MS_DEFAULT = 30_000;
export const ACCOUNT_FRESHNESS_MS_DEFAULT = 5_000;
export const VERIFICATION_READBACK_MS_DEFAULT = 5_000;
export const CAPABILITIES_FRESHNESS_MS_DEFAULT = 30_000;
export const CLOCK_SKEW_MS_DEFAULT = 1_000;

export const REQUIRED_VERIFICATION_KEYS = Object.freeze(['account', 'settings', 'quote', 'capabilities']);
export const QUOTE_UNITS = Object.freeze(['total', 'per-generation']);

export function isAccountPositive(account, now = Date.now()) {
  if (!account || typeof account !== 'object') return false;
  if (account.verified !== true) return false;
  if (typeof account.expected !== 'string' || account.expected.length === 0) return false;
  if (typeof account.observed !== 'string' || account.observed.length === 0) return false;
  // Exact positive identity: no substring/case-insensitive shortcuts.
  if (account.observed !== account.expected) return false;
  // A readback without a timestamp is not positive proof, and future reads
  // (beyond clock skew) indicate tampered evidence.
  if (typeof account.observedAt !== 'number' || !Number.isFinite(account.observedAt)) return false;
  if (account.observedAt > now + CLOCK_SKEW_MS_DEFAULT) return false;
  if (now - account.observedAt > ACCOUNT_FRESHNESS_MS_DEFAULT) return false;
  return true;
}

export function createZeroOnlyPolicy({ models = [], maxCandidates = 4, deadline = null } = {}) {
  return { kind: 'zero-only', models: [...models], maxCandidates, deadline, zeroOnly: true };
}

function checkVerification(verification, now, reasons) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    reasons.push('verification-missing');
    return;
  }
  const keys = Object.keys(verification);
  if (keys.length === 0) {
    reasons.push('verification-missing');
    return;
  }
  for (const required of REQUIRED_VERIFICATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(verification, required)) {
      reasons.push(`verification-key-missing:${required}`);
    }
  }
  for (const [k, v] of keys.map((k) => [k, verification[k]])) {
    if (v === null || v === undefined) {
      reasons.push(`verification-null:${k}`);
      continue;
    }
    if (typeof v !== 'object' || Array.isArray(v)) {
      reasons.push(`invalid-verification:${k}`);
      continue;
    }
    if (!['verified', 'unverified', 'na'].includes(v.status)) {
      reasons.push(`invalid-verification:${k}`);
      continue;
    }
    const isMandatory = REQUIRED_VERIFICATION_KEYS.includes(k);
    if (isMandatory && v.required === false) {
      reasons.push(`mandatory-verification-optional:${k}`);
    } else if (v.required === false) {
      continue; // optional enhancement: any valid status
    }
    if (v.status !== 'verified') {
      reasons.push(v.status === 'na' ? `arbitrary-na:${k}` : `unverified-required:${k}`);
      continue;
    }
    if (typeof v.observedAt !== 'number' || !Number.isFinite(v.observedAt)) {
      reasons.push(`verification-timestamp-missing:${k}`);
      continue;
    }
    if (v.observedAt > now + CLOCK_SKEW_MS_DEFAULT) {
      reasons.push(`verification-timestamp-future:${k}`);
      continue;
    }
    if (now - v.observedAt > VERIFICATION_READBACK_MS_DEFAULT) {
      reasons.push(`verification-readback-stale:${k}`);
      continue;
    }
    const origin = v.origin ?? v.evidence ?? v.ref;
    if (typeof origin !== 'string' || origin.trim().length === 0) {
      reasons.push(`verification-evidence-missing:${k}`);
    }
  }
}

function checkQuote(quote, now, reasons) {
  if (!quote || typeof quote !== 'object') {
    reasons.push('quote-missing-or-unreadable');
    return null;
  }
  if (typeof quote.total !== 'number' || !Number.isFinite(quote.total)) {
    reasons.push('quote-missing-or-unreadable');
    return null;
  }
  if (quote.total < 0) {
    reasons.push('quote-negative');
  }
  if (typeof quote.unit !== 'string' || !QUOTE_UNITS.includes(quote.unit)) {
    reasons.push('quote-unit-unreadable');
  }
  if (typeof quote.model !== 'string' || quote.model.trim().length === 0) {
    reasons.push('quote-feature-unreadable');
  }
  if (typeof quote.feature !== 'string' || quote.feature.trim().length === 0) {
    reasons.push('quote-feature-unreadable');
  }
  if (typeof quote.quantity !== 'number' || !Number.isInteger(quote.quantity) || quote.quantity < 1) {
    reasons.push('quote-quantity-unbound');
  }
  if (
    quote.unit === 'per-generation' &&
    quote.quantity >= 1 &&
    (typeof quote.perGeneration !== 'number' ||
      !Number.isFinite(quote.perGeneration) ||
      quote.perGeneration < 0 ||
      quote.total !== quote.perGeneration * quote.quantity)
  ) {
    reasons.push('quote-total-mismatch');
  }
  if (typeof quote.observedAt !== 'number' || !Number.isFinite(quote.observedAt)) {
    reasons.push('quote-timestamp-missing');
  } else {
    if (quote.observedAt > now + CLOCK_SKEW_MS_DEFAULT) {
      reasons.push('quote-future');
    }
    // Freshness floor: a far-future expiresAt never overrides the 30s
    // readback requirement (service-side prices can change any time).
    if (now - quote.observedAt > QUOTE_FRESHNESS_MS_DEFAULT) {
      reasons.push('quote-stale');
    }
  }
  if (typeof quote.expiresAt !== 'number' || !Number.isFinite(quote.expiresAt)) {
    reasons.push('quote-expiry-missing');
  } else if (now > quote.expiresAt) {
    reasons.push('quote-expired');
  }
  return quote;
}

function checkApproval(approval, { account, project, quote, requestDigest, now, reasons }) {
  if (!approval || typeof approval !== 'object') {
    reasons.push('approval-missing');
    return null;
  }
  if (typeof approval.id !== 'string' || approval.id.length === 0) {
    reasons.push('approval-unbound');
  }
  // The nonce is the single-use child token: one concrete attempt, one child.
  if (typeof approval.nonce !== 'string' || approval.nonce.length === 0) {
    reasons.push('approval-nonce-invalid');
  }
  if (approval.consumed === true) reasons.push('approval-already-consumed');
  if (approval.revoked === true) reasons.push('approval-revoked');
  if (typeof approval.expiresAt !== 'number' || !Number.isFinite(approval.expiresAt)) {
    reasons.push('approval-expiry-missing');
  } else if (now > approval.expiresAt) {
    reasons.push('approval-expired');
  }
  const digest = approval.requestDigest ?? approval.digest ?? null;
  if (typeof requestDigest !== 'string' || requestDigest.length === 0) {
    reasons.push('request-digest-absent');
  } else if (typeof digest !== 'string' || digest.length === 0) {
    reasons.push('approval-digest-absent');
  } else if (digest !== requestDigest) {
    reasons.push('approval-digest-mismatch');
  }
  if (typeof approval.accountKey !== 'string' || approval.accountKey !== account?.observed) {
    reasons.push('approval-account-mismatch');
  }
  if (typeof approval.projectId !== 'string' || approval.projectId !== project?.observedId) {
    reasons.push('approval-project-mismatch');
  }
  if (typeof approval.model !== 'string' || approval.model.length === 0 || approval.model !== quote?.model) {
    reasons.push('approval-model-mismatch');
  }
  if (approval.quoteTotal !== undefined && approval.quoteTotal !== quote?.total) {
    reasons.push('approval-quote-mismatch');
  }
  return approval;
}

export function evaluateSubmissionPolicy(input = {}) {
  const {
    account = null,
    project = null,
    verification = null,
    quote = null,
    approval = null,
    requestDigest = null,
    policy = null,
    capabilities = null,
    now = Date.now(),
  } = input;
  const reasons = [];

  if (!isAccountPositive(account, now)) {
    if (!account || typeof account !== 'object') {
      reasons.push('account-binding-missing');
    } else if (account.verified !== true) {
      reasons.push('account-not-positively-verified');
    } else if (typeof account.expected !== 'string' || typeof account.observed !== 'string' || account.observed !== account.expected) {
      reasons.push('account-mismatch');
    } else if (typeof account.observedAt !== 'number' || !Number.isFinite(account.observedAt)) {
      reasons.push('account-timestamp-missing');
    } else if (account.observedAt > now + CLOCK_SKEW_MS_DEFAULT) {
      reasons.push('account-timestamp-future');
    } else {
      reasons.push('account-readback-stale');
    }
  }
  if (!project || typeof project !== 'object') {
    reasons.push('project-binding-missing');
  } else if (
    typeof project.requiredId !== 'string' ||
    project.requiredId.length === 0 ||
    typeof project.observedId !== 'string' ||
    project.observedId.length === 0
  ) {
    reasons.push('project-binding-missing');
  } else if (project.observedId !== project.requiredId) {
    reasons.push('project-binding-mismatch');
  }

  checkVerification(verification, now, reasons);
  const checkedQuote = checkQuote(quote, now, reasons);
  checkApproval(approval, { account, project, quote: checkedQuote, requestDigest, now, reasons });

  if (!capabilities || typeof capabilities !== 'object') {
    reasons.push('capabilities-missing');
  } else {
    if (capabilities.supported !== true) {
      reasons.push('capabilities-unsupported');
    }
    if (
      typeof capabilities.model !== 'string' ||
      capabilities.model !== checkedQuote?.model ||
      typeof capabilities.feature !== 'string' ||
      capabilities.feature !== checkedQuote?.feature
    ) {
      reasons.push('capabilities-mismatch');
    }
    if (typeof capabilities.observedAt !== 'number' || !Number.isFinite(capabilities.observedAt)) {
      reasons.push('capabilities-timestamp-missing');
    } else {
      if (capabilities.observedAt > now + CLOCK_SKEW_MS_DEFAULT) {
        reasons.push('capabilities-timestamp-future');
      }
      if (now - capabilities.observedAt > CAPABILITIES_FRESHNESS_MS_DEFAULT) {
        reasons.push('capabilities-stale');
      }
    }
  }

  const hasApprovalCap = approval && typeof approval.maxCredits === 'number' && Number.isFinite(approval.maxCredits);
  const hasPolicyCap = policy && typeof policy.maxCredits === 'number' && Number.isFinite(policy.maxCredits);

  if (checkedQuote && checkedQuote.total > 0) {
    if (!hasApprovalCap && !hasPolicyCap) {
      reasons.push('paid-quote-cap-missing');
    } else if (!hasApprovalCap) {
      reasons.push('approval-cap-missing');
    }
  }

  if (hasApprovalCap && approval.maxCredits < 0) {
    reasons.push('approval-cap-invalid');
  }
  if (hasPolicyCap && policy.maxCredits < 0) {
    reasons.push('policy-cap-invalid');
  }

  if (hasApprovalCap && checkedQuote && checkedQuote.total > approval.maxCredits) {
    reasons.push('quote-cap-exceeded');
  }
  if (hasPolicyCap && checkedQuote && checkedQuote.total > policy.maxCredits) {
    reasons.push('quote-cap-exceeded');
  }
  if (hasApprovalCap && hasPolicyCap && approval.maxCredits > policy.maxCredits) {
    reasons.push('child-cap-exceeds-parent-policy');
  }

  if (policy && typeof policy === 'object') {
    if (policy.zeroOnly === true && checkedQuote && checkedQuote.total !== 0) {
      reasons.push('zero-only-policy-nonzero-quote');
    }
    if (policy.kind === 'zero-only' && Array.isArray(policy.models) && policy.models.length > 0) {
      if (checkedQuote && checkedQuote.model && !policy.models.includes(checkedQuote.model)) {
        reasons.push('zero-only-policy-model-not-eligible');
      }
    }
    if (typeof policy.candidateCount === 'number' && typeof policy.maxCandidates === 'number') {
      if (policy.candidateCount > policy.maxCandidates) {
        reasons.push('zero-only-policy-candidates-exceeded');
      }
    }
    if (policy.deadline !== null && policy.deadline !== undefined) {
      if (typeof policy.deadline !== 'number' || !Number.isFinite(policy.deadline)) {
        reasons.push('zero-only-policy-deadline-unreadable');
      } else if (now > policy.deadline) {
        reasons.push('zero-only-policy-deadline-passed');
      }
    }
  }

  if (reasons.length > 0) {
    return {
      decision: 'deny',
      reasons,
      next_action: 'Resolve all denial reasons, reverify account/settings/quote, and obtain a fresh matching approval before any submit.',
    };
  }
  return { decision: 'allow', reasons: [], next_action: null };
}

export function assertCanSubmit(policyInput) {
  const verdict = evaluateSubmissionPolicy(policyInput);
  if (verdict.decision !== 'allow') {
    throw new FlowError('POLICY_DENIED', 'Submission denied by common policy', {
      reasons: verdict.reasons,
    });
  }
  return verdict;
}
