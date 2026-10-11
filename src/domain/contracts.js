// W01 foundation lane: versioned truthful requested/actual/readiness contract.
// Plan refs: story-production-plan Sec 3.1 (result contract), Sec 11/W01.
// Minimal + pure (no browser/queue/tools imports). Durable/submission
// integration lands in W05; this module only types early results so
// incomplete verification can never be mistaken for spendable readiness.
//
// Parent correction (strict): readiness=ready authorizes spend ONLY with
// nonempty explicit required fields, required entries positively verified
// with origin/time evidence, actual matching requested on every requested
// dimension, and a positive prompt + feature/model binding. Vacuous
// verification ({}), na/unverified required proof, evidence-free echoes,
// and actual mismatches all deny by default.
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';

export const CONTRACT_VERSION = 1;

export const READINESS = Object.freeze([
  'ready',
  'prepared_unverified',
  'blocked',
  'unsupported',
  'manual_action_required',
  'pending',
  'submitted',
  'submission_unknown',
  'completed',
  'failed',
  'cancelled',
]);

const VERIFICATION_STATUSES = new Set(['verified', 'unverified', 'na']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Recursive canonical JSON: sorted keys, array order preserved, types
// preserved (1 vs '1' vs true vs null hash differently). Anything that
// JSON.stringify would silently drop or collapse (undefined, functions,
// symbols, bigints, NaN/±Infinity, holes, class instances) is rejected
// so distinct payloads can never collide to one digest.
export function canonicalStringify(value) {
  if (value === undefined) {
    throw new FlowError('CONTRACT_INVALID', 'cannot digest undefined (collides with a missing field)', {});
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new FlowError('CONTRACT_INVALID', `cannot digest ${typeof value} (not JSON)`, {});
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FlowError('CONTRACT_INVALID', 'cannot digest NaN/±Infinity (collides with null)', {});
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = Array.from(value, (el, i) => {
      if (!(i in value)) {
        throw new FlowError('CONTRACT_INVALID', 'cannot digest sparse arrays (holes collide with null)', {});
      }
      return canonicalStringify(el);
    });
    return `[${parts.join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  throw new FlowError('CONTRACT_INVALID', 'cannot digest non-plain objects (no stable JSON form)', {
    kind: Object.prototype.toString.call(value),
  });
}

export function digestRequest(requested) {
  return crypto.createHash('sha256').update(canonicalStringify(requested ?? null)).digest('hex');
}

export function deepEqual(a, b) {
  if (Object.is(a, b)) return a !== undefined;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((el, i) => deepEqual(el, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function assertVerificationEntry(name, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new FlowError('CONTRACT_INVALID', `verification["${name}"] must be an object`, { field: name });
  }
  if (!VERIFICATION_STATUSES.has(entry.status)) {
    throw new FlowError('CONTRACT_INVALID', `verification["${name}"].status must be verified|unverified|na`, {
      field: name,
      status: entry.status,
    });
  }
}

// Positive spend binding: the request must name what to generate and on
// which feature — a bare {} or prompt-only echo is not authorizable.
function assertSpendableRequest(requested) {
  if (typeof requested?.prompt !== 'string' || requested.prompt.trim().length === 0) {
    throw new FlowError('CONTRACT_INVALID', 'readiness=ready requires a positive non-empty requested.prompt', {});
  }
  const feature = requested.feature ?? requested.model;
  if (typeof feature !== 'string' || feature.trim().length === 0) {
    throw new FlowError('CONTRACT_INVALID', 'readiness=ready requires a positive requested.feature/model', {});
  }
}

// Every required entry must carry positive proof: status verified plus
// origin/time evidence. Metadata-free echoes are review data, not proof.
function assertRequiredEvidence(verification) {
  for (const [name, entry] of Object.entries(verification)) {
    if (entry.required === false) continue;
    if (entry.status !== 'verified') {
      throw new FlowError(
        'CONTRACT_INVALID',
        `readiness=ready requires verification["${name}"] verified (missing/null/na proof cannot authorize spend)`,
        { field: name, status: entry.status },
      );
    }
    if (typeof entry.observedAt !== 'number' || !Number.isFinite(entry.observedAt)) {
      throw new FlowError(
        'CONTRACT_INVALID',
        `readiness=ready requires verification["${name}"].observedAt (evidence time)`,
        { field: name },
      );
    }
    const origin = entry.origin ?? entry.evidence ?? entry.ref;
    if (typeof origin !== 'string' || origin.trim().length === 0) {
      throw new FlowError(
        'CONTRACT_INVALID',
        `readiness=ready requires verification["${name}"].origin/evidence (evidence reference)`,
        { field: name },
      );
    }
  }
}

function assertActualMatchesRequested(requested, actual) {
  for (const key of Object.keys(requested)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key) || !deepEqual(actual[key], requested[key])) {
      throw new FlowError(
        'CONTRACT_INVALID',
        `readiness=ready requires actual["${key}"] to match requested (observed values, not echoes)`,
        { field: key },
      );
    }
  }
}

export function createResult(input = {}) {
  const {
    requested,
    actual,
    verification = {},
    readiness,
    cost_quote = null,
    assets = [],
    side_effects = [],
    warnings = [],
    errors = [],
    next_action = null,
    operation_id = null,
    story_id = null,
    shot_id = null,
    project_id = null,
  } = input;

  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new FlowError('CONTRACT_INVALID', 'requested must be an object (exact validated caller intent)', {});
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new FlowError('CONTRACT_INVALID', 'actual must be an object (observed UI/asset values)', {});
  }
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    throw new FlowError('CONTRACT_INVALID', 'verification must be an object map', {});
  }
  if (!READINESS.includes(readiness)) {
    throw new FlowError('CONTRACT_INVALID', `readiness must be one of: ${READINESS.join(', ')}`, { readiness });
  }
  for (const [k, v] of Object.entries(verification)) assertVerificationEntry(k, v);

  if (readiness === 'ready') {
    const requiredNames = Object.entries(verification)
      .filter(([, v]) => v.required !== false)
      .map(([k]) => k);
    if (requiredNames.length === 0) {
      throw new FlowError(
        'CONTRACT_INVALID',
        'readiness=ready requires nonempty verification with explicit required fields (vacuous proof cannot authorize spend)',
        {},
      );
    }
    assertSpendableRequest(requested);
    assertRequiredEvidence(verification);
    assertActualMatchesRequested(requested, actual);
  }

  return {
    v: CONTRACT_VERSION,
    operation_id,
    story_id,
    shot_id,
    project_id,
    requested,
    actual,
    verification,
    readiness,
    cost_quote,
    assets,
    side_effects,
    warnings,
    errors,
    next_action,
    request_digest: digestRequest(requested),
  };
}

// Internal denial guard foundation: only a fully-evidenced ready result may
// authorize a live submit. Everything else denies, including hand-built
// objects that bypass createResult. W05 wires this to the durable
// approval/intent path; W01 only guarantees the predicate.
export function canAuthorizeSpend(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.v !== CONTRACT_VERSION) return false;
  if (result.readiness !== 'ready') return false;
  const { verification, requested, actual } = result;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false;
  const entries = Object.entries(verification);
  if (entries.length === 0) return false;
  if (!entries.some(([, v]) => v && typeof v === 'object' && v.required !== false)) return false;
  for (const [, v] of entries) {
    if (!v || typeof v !== 'object') return false;
    if (v.required === false) {
      if (!VERIFICATION_STATUSES.has(v.status)) return false;
      continue;
    }
    if (v.status !== 'verified') return false;
    if (typeof v.observedAt !== 'number' || !Number.isFinite(v.observedAt)) return false;
    const origin = v.origin ?? v.evidence ?? v.ref;
    if (typeof origin !== 'string' || origin.trim().length === 0) return false;
  }
  if (!requested || typeof requested !== 'object') return false;
  if (typeof requested.prompt !== 'string' || requested.prompt.trim().length === 0) return false;
  const feature = requested.feature ?? requested.model;
  if (typeof feature !== 'string' || feature.trim().length === 0) return false;
  if (!actual || typeof actual !== 'object') return false;
  for (const key of Object.keys(requested)) {
    try {
      if (!Object.prototype.hasOwnProperty.call(actual, key) || !deepEqual(actual[key], requested[key])) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function isTerminalReadiness(readiness) {
  return ['completed', 'failed', 'cancelled'].includes(readiness);
}
