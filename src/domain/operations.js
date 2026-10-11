// W01: single-use atomic approval + intent reservation foundations.
// Plan refs: Sec 3.3 (unique nonce + single-use approval child per submit
// attempt; reservation ledger holds the verified upper bound until
// reconciled), Sec 3.4 (no blind retry).
//
// Resume correction: the prefix APIs below implement the CORRECTED W01
// binding contract (child carries id/nonce/requestDigest + accountKey /
// projectId / model / quoteTotal bindings and a NUMERIC ms expiry) so the
// common policy can bind every submit. In-memory single-use only; durable
// one-shot consumption across processes is the W05 store below, which holds
// one exclusive lock across re-read + marker + CAS + journal.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FlowError } from '../utils/errors.js';
import {
  atomicWriteJson,
  acquireLock,
  compareAndSwapJson,
  readVersionedJson,
} from '../storage/runtime-store.js';
import { appendJournal } from '../storage/journal.js';
import { evaluateSubmissionPolicy, CLOCK_SKEW_MS_DEFAULT } from './submission-policy.js';
import { digestRequest } from './contracts.js';

function uid(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function createIntent({ operationId, requestDigest, leaseEpoch = null, baseline = null } = {}) {
  if (!operationId || !requestDigest) {
    throw new FlowError('JOURNAL_INVALID', 'intent requires operationId + requestDigest', {});
  }
  return {
    id: operationId,
    operationId,
    requestDigest,
    leaseEpoch,
    baseline,
    createdAt: new Date().toISOString(),
  };
}

// Mint one single-use child approval for a concrete authorized attempt.
// Finite sets enumerate children/counters; there is no reusable blanket token.
// Corrected binding contract: the child carries the account/project/model/
// quote bindings the common policy checks, plus a NUMERIC ms expiry. Binding
// values may be null at mint time (unbound); the submit path then denies via
// the common policy (approval-account/project/model-mismatch) — minting never
// authorizes spend by itself.
export function mintChildApproval(parent = {}, { index = 0, requestDigest, accountKey, projectId, model, quoteTotal, maxCredits, ttlMs } = {}) {
  if (!requestDigest) {
    throw new FlowError('JOURNAL_INVALID', 'child approval requires requestDigest', {});
  }
  return {
    id: uid('appr'),
    parentPolicyId: parent.policyId ?? null,
    childIndex: index,
    nonce: crypto.randomBytes(12).toString('hex'),
    digest: requestDigest,
    requestDigest,
    scopeDigest: parent.scopeDigest ?? null,
    accountKey: accountKey ?? parent.accountKey ?? null,
    projectId: projectId ?? parent.projectId ?? null,
    model: model ?? parent.model ?? null,
    quoteTotal: quoteTotal ?? parent.quoteTotal ?? null,
    maxCredits: maxCredits ?? parent.maxCredits ?? 0,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + (ttlMs ?? parent.ttlMs ?? 60_000),
    consumed: false,
    revoked: false,
  };
}

// Atomic single-use consumption: concurrent requests cannot consume the same
// child. A proven pre-click recovery resumes the same journalled attempt; it
// does not mint a second child.
export function consumeChildApproval(approvals, childId) {
  const child = approvals?.get?.(childId) ?? approvals?.[childId];
  if (!child) {
    throw new FlowError('APPROVAL_EXPIRED', `unknown approval child: ${childId}`, { childId });
  }
  if (child.consumed === true) {
    throw new FlowError('APPROVAL_CONSUMED', 'approval child already consumed (single-use)', { childId });
  }
  if (child.revoked === true) {
    throw new FlowError('APPROVAL_EXPIRED', 'approval child revoked', { childId });
  }
  child.consumed = true;
  child.consumedAt = new Date().toISOString();
  return child;
}

// Reserve the verified upper bound (incl. quantity) before submission.
// Unknown outcomes keep their reservation until reconciled; no automatic
// refund or zero-spend booking. Balance deltas alone are not attribution.
export function reserveCredits(ledger, amount) {
  if (!ledger || typeof ledger !== 'object') {
    throw new FlowError('JOURNAL_INVALID', 'reservation requires a ledger object', {});
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new FlowError('JOURNAL_INVALID', 'reservation amount must be a finite non-negative number', { amount });
  }
  const reserved = ledger.reserved ?? 0;
  const max = ledger.maxAuthorized ?? Infinity;
  if (reserved + amount > max) {
    throw new FlowError('RESERVATION_EXCEEDED', 'reservation exceeds authorized maximum', {
      reserved,
      amount,
      maxAuthorized: max,
    });
  }
  ledger.reserved = reserved + amount;
  return ledger;
}

// Explicit settlement only, with attributable evidence. Never called
// automatically on partial landing (see partial-variant-ledger regression).
export function settleReservation(ledger, amount, { evidence = null } = {}) {
  if (!evidence) {
    throw new FlowError('JOURNAL_INVALID', 'settlement requires attributable charge/refund evidence', {});
  }
  ledger.reserved = Math.max(0, (ledger.reserved ?? 0) - amount);
  return ledger;
}

// ---------------------------------------------------------------------------
// W05 durable adapter + operation aggregate.
// ---------------------------------------------------------------------------

export const OPERATION_SCHEMA_VERSION = 1;
// Freshness bounds mirror submission-policy defaults; checked locally so a
// missing/stale read denies even if the policy module is unavailable.
export const ACCOUNT_PRECLICK_FRESHNESS_MS = 5_000;
export const QUOTE_FRESHNESS_MS = 30_000;

function failBlocked(message, details = {}) {
  throw new FlowError('OPERATION_STORE_BLOCKED', message, {
    dependency: 'src/storage/runtime-store.js + src/storage/journal.js (unmodified W01 foundations)',
    ...details,
  });
}

// Durability delegates to the corrected foundation: atomicWriteJson already
// does exclusive-temp + fd write + fsync + close + atomic rename (verified
// runtime-store.js:92-137). Failures raise STORAGE_IO_ERROR and are wrapped
// here as OPERATION_STORE_BLOCKED so the submit path cannot proceed on a
// half-persisted aggregate.
export function durableWriteJson(file, data) {
  try {
    return atomicWriteJson(file, data);
  } catch (e) {
    if (e instanceof FlowError) {
      throw new FlowError('OPERATION_STORE_BLOCKED', `durable write refused: ${e.message}`, {
        cause: e.code,
        file,
      });
    }
    failBlocked(`durable write failed; submit path blocked: ${e.message}`, { file });
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function opFile(opsDir, id) {
  return path.join(opsDir, `${id}.json`);
}

function assertBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new FlowError('OPERATION_INVALID', 'commit requires a mandatory stable baseline (ids + observedAt)', {});
  }
  if (!Array.isArray(baseline.ids)) {
    throw new FlowError('OPERATION_INVALID', 'baseline.ids must be an array of stable remote IDs', {});
  }
  if (typeof baseline.observedAt !== 'number' || !Number.isFinite(baseline.observedAt)) {
    throw new FlowError('OPERATION_INVALID', 'baseline.observedAt must be a finite timestamp', {});
  }
  return true;
}

// Corrected lock shape: acquireLock returns { token, lockFile, release() },
// NOT a function. Release errors are load-bearing (foreign/vanished lock =
// STORAGE_CONFLICT fence) and are never swallowed: a failed release throws
// OPERATION_STORE_BLOCKED so a leaked lock can never silently livelock the
// next commit. LOCK_HELD / STORAGE_IO_ERROR propagate unchanged — lock
// errors are storage errors, never UI errors.
function withStoreLock(lockFile, fn) {
  let handle;
  try {
    handle = acquireLock(lockFile);
  } catch (e) {
    if (e instanceof FlowError && (e.code === 'LOCK_HELD' || e.code === 'STORAGE_IO_ERROR')) throw e;
    throw new FlowError('LOCK_HELD', `operation store busy; refusing concurrent commit: ${e.message}`, { lockFile });
  }
  let result;
  let fnError = null;
  try {
    result = fn(handle);
  } catch (e) {
    fnError = e;
  }
  try {
    const released = handle.release();
    if (released === false) {
      throw new FlowError('OPERATION_STORE_BLOCKED', `lock release reported already-released: ${lockFile}`, { lockFile });
    }
  } catch (releaseError) {
    if (fnError) {
      throw new FlowError('OPERATION_STORE_BLOCKED', `commit failed and lock release failed: ${releaseError.message}`, {
        lockFile,
        commitError: fnError.code ?? String(fnError.message ?? fnError),
      });
    }
    if (releaseError instanceof FlowError) throw releaseError;
    throw new FlowError('OPERATION_STORE_BLOCKED', `lock release failed: ${releaseError.message}`, { lockFile });
  }
  if (fnError) throw fnError;
  return result;
}

// Aggregate reads are validated: version-checked (future v rejected),
// corrupt files backed up and rejected (never defaulted). Corruption stops
// submission — it is never skipped into a success.
function readOpFile(file) {
  let data;
  try {
    data = readVersionedJson(file, { supported: [OPERATION_SCHEMA_VERSION] });
  } catch (e) {
    if (e instanceof FlowError && (e.code === 'STORAGE_CORRUPT' || e.code === 'STORAGE_VERSION_UNSUPPORTED')) {
      throw e;
    }
    throw new FlowError('OPERATION_NOT_FOUND', `operation record unreadable: ${file}`, { file });
  }
  if (!data || typeof data.id !== 'string' || typeof data.revision !== 'string') {
    throw new FlowError('STORAGE_CORRUPT', `operation record missing id/revision; refusing to guess: ${file}`, { file });
  }
  return data;
}

// Pure boundary mutation shared by the store method and crash tests: the
// returned record MUST be durably persisted BEFORE the click. Anything at
// or after this point is UNKNOWN, never a safe retry.
export function recordInvocationBoundary(operation) {
  if (!operation || typeof operation !== 'object' || !operation.id) {
    throw new FlowError('OPERATION_INVALID', 'invocation boundary requires a bound operation', {});
  }
  return {
    ...operation,
    status: 'submission_unknown',
    invocationBoundaryAt: new Date().toISOString(),
  };
}

export function classifyCrash({ boundaryRecorded } = {}) {
  return boundaryRecorded === true ? 'unknown-never-safe-retry' : 'safe-resume-same-attempt';
}

export function createOperationStore(rootDir) {
  if (!rootDir || typeof rootDir !== 'string') {
    throw new FlowError('OPERATION_INVALID', 'operation store requires a root directory', {});
  }
  const opsDir = path.join(rootDir, 'operations');
  const journalDir = path.join(rootDir, 'journal');
  const consumedDir = path.join(rootDir, 'consumed-children');
  ensureDir(opsDir);
  ensureDir(journalDir);
  ensureDir(consumedDir);
  const lockFile = path.join(rootDir, 'operations.lock');

  function consumedMarkerFile(childId) {
    return path.join(consumedDir, `${childId}.json`);
  }

  function getOperation(id) {
    if (!id || typeof id !== 'string') {
      throw new FlowError('OPERATION_INVALID', 'getOperation requires an operation id', {});
    }
    const file = opFile(opsDir, id);
    if (!fs.existsSync(file)) {
      throw new FlowError('OPERATION_NOT_FOUND', `unknown operation id: ${id}`, { id });
    }
    return readOpFile(file);
  }

  function bumpRevision(expectedRevision) {
    const n = Number.parseInt(String(expectedRevision ?? '').slice(1), 10);
    if (!Number.isInteger(n) || n < 0) {
      throw new FlowError('STORAGE_CORRUPT', `operation revision unreadable: ${expectedRevision}`, {
        expectedRevision,
      });
    }
    return `r${n + 1}`;
  }

  // The ONLY mutation path after create: revision-checked CAS. A stale
  // in-memory copy (e.g. r1/prepared written after r2/submission_unknown)
  // raises STORAGE_CONFLICT without touching the file — the invocation
  // boundary can never be silently overwritten back to prepared.
  function writeOperationCAS(record, expectedRevision) {
    if (!record || typeof record.id !== 'string') {
      throw new FlowError('OPERATION_INVALID', 'CAS write requires a bound operation record', {});
    }
    if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
      throw new FlowError('OPERATION_INVALID', 'CAS write requires the expected revision you read', {});
    }
    const next = { ...record, revision: bumpRevision(expectedRevision) };
    try {
      compareAndSwapJson(opFile(opsDir, record.id), expectedRevision, next);
    } catch (e) {
      if (e instanceof FlowError && (e.code === 'STORAGE_CONFLICT' || e.code === 'STORAGE_CORRUPT' || e.code === 'STORAGE_VERSION_UNSUPPORTED')) {
        throw e;
      }
      failBlocked(`CAS write refused: ${e.message}`, { id: record.id });
    }
    return next;
  }

  function createBoundOperation(input = {}) {
    const {
      requestDigest,
      requested = null,
      nonce = crypto.randomBytes(12).toString('hex'),
      accountRef = null,
      projectRef = null,
      settingsRef = null,
      refs = [],
      quote = null,
      baseline = null,
      leaseEpoch = null,
    } = input;
    if (typeof requestDigest !== 'string' || requestDigest.length === 0) {
      throw new FlowError('OPERATION_INVALID', 'bound operation requires requestDigest', {});
    }
    // Canonical digest binding: when the caller supplies the canonical
    // payload, the digest must be the corrected contracts digest of it —
    // never a hand-typed string that collides with another request.
    if (requested !== null && requested !== undefined) {
      let canonical;
      try {
        canonical = digestRequest(requested);
      } catch (e) {
        throw new FlowError('CONTRACT_INVALID', `cannot bind non-canonical requested payload: ${e.message}`, {});
      }
      if (canonical !== requestDigest) {
        throw new FlowError('OPERATION_INVALID', 'requestDigest does not match the canonical requested payload', {});
      }
    }
    assertBaseline(baseline);
    if (baseline.observedAt > Date.now() + CLOCK_SKEW_MS_DEFAULT) {
      throw new FlowError('OPERATION_INVALID', 'baseline observedAt is in the future; refusing to bind', {});
    }
    if (typeof leaseEpoch !== 'number' || !Number.isFinite(leaseEpoch)) {
      throw new FlowError('OPERATION_INVALID', 'bound operation requires a finite leaseEpoch', {});
    }
    const id = `op-${crypto.randomBytes(8).toString('hex')}`;
    const file = opFile(opsDir, id);
    if (fs.existsSync(file)) {
      throw new FlowError('OPERATION_INVALID', `operation id collision; refusing to overwrite: ${id}`, { id });
    }
    const record = {
      v: OPERATION_SCHEMA_VERSION,
      id,
      operationId: id,
      revision: 'r1',
      requestDigest,
      requested,
      nonce,
      accountRef,
      projectRef,
      settingsRef,
      refs: Array.isArray(refs) ? [...refs] : [],
      quote,
      baseline: { ids: [...baseline.ids], observedAt: baseline.observedAt },
      leaseEpoch,
      approvalChildId: null,
      reservationAmount: 0,
      settledAmount: 0,
      status: 'prepared',
      createdAt: new Date().toISOString(),
      attempts: [],
      variants: { expected: 0, landed: [] },
    };
    durableWriteJson(file, record);
    return { ...record };
  }

  function markInvocationBoundary(operationId) {
    const current = getOperation(operationId);
    const next = recordInvocationBoundary(current);
    return writeOperationCAS(next, current.revision);
  }

  function listOperations() {
    if (!fs.existsSync(opsDir)) return [];
    return fs.readdirSync(opsDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => readOpFile(path.join(opsDir, n)));
  }

  // Durable one-shot record: written under the same exclusive lock as the
  // op commit, so independent process stores agree on consumption.
  function isChildConsumed(childId) {
    if (typeof childId !== 'string' || childId.length === 0) return false;
    return fs.existsSync(consumedMarkerFile(childId));
  }

  function listConsumedChildren() {
    if (!fs.existsSync(consumedDir)) return [];
    return fs.readdirSync(consumedDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length));
  }

  // Restores an in-memory ledger from durable per-operation reservations —
  // the store owns the authoritative sum; callers rewire it after restart
  // instead of resuming from zero.
  function restoreLedger(ledger) {
    if (!ledger || typeof ledger !== 'object') {
      throw new FlowError('JOURNAL_INVALID', 'restoreLedger requires a ledger object', {});
    }
    const sum = listOperations().reduce(
      (total, o) => total + (Number.isFinite(o.reservationAmount) ? o.reservationAmount : 0),
      0,
    );
    ledger.reserved = sum;
    return ledger;
  }

  return {
    rootDir, opsDir, journalDir, consumedDir, lockFile,
    createBoundOperation, getOperation, markInvocationBoundary, listOperations,
    writeOperationCAS, isChildConsumed, listConsumedChildren, restoreLedger,
    _consumedMarkerFile: consumedMarkerFile,
  };
}

// Atomic durable commit: the common policy decides FIRST (zero side effects
// on deny), then ONE exclusive lock covers re-read + revision check +
// in-memory consume/reserve + durable child marker + CAS op write + journal
// (intent + attempt + approval + reservation). Any failure before the CAS
// write rolls back the in-memory flags and the marker; a failure after the
// CAS write leaves the durable record as the truth (caller must treat the
// attempt as unknown, never silently retry).
export function commitPreInvocation({
  store, approvals, ledger, operationId, childId,
  reservationAmount, journalDir = null, policyInput = null,
} = {}) {
  if (!store || typeof store.getOperation !== 'function' || typeof store.writeOperationCAS !== 'function') {
    throw new FlowError('OPERATION_INVALID', 'commit requires an operation store', {});
  }
  if (typeof reservationAmount !== 'number' || !Number.isFinite(reservationAmount) || reservationAmount < 0) {
    throw new FlowError('JOURNAL_INVALID', 'reservation amount must be a finite non-negative number', {});
  }
  // The common policy is authoritative. No policy input (or a permissive
  // local fallback) can ever report allow — fail closed without fallback.
  if (!policyInput || typeof policyInput !== 'object') {
    throw new FlowError('POLICY_DENIED', 'commit requires a full common-policy input; no permissive fallback', {});
  }
  const operation = store.getOperation(operationId);
  assertBaseline(operation.baseline);
  if (typeof operation.leaseEpoch !== 'number' || !Number.isFinite(operation.leaseEpoch)) {
    throw new FlowError('OPERATION_INVALID', 'operation missing leaseEpoch; refusing commit', {});
  }
  if (policyInput.requestDigest !== operation.requestDigest) {
    throw new FlowError('POLICY_DENIED', 'policy requestDigest does not bind this operation', {
      reasons: ['approval-digest-mismatch'],
    });
  }
  if (!policyInput.approval || policyInput.approval.id !== childId) {
    throw new FlowError('POLICY_DENIED', 'policy approval must be the submitted child (no substituted authorization)', {
      reasons: ['approval-unbound'],
    });
  }
  const verdict = evaluateSubmissionPolicy(policyInput);
  if (verdict.decision !== 'allow') {
    throw new FlowError('POLICY_DENIED', 'Submission denied by common policy', {
      reasons: verdict.reasons,
    });
  }
  const child = approvals?.get?.(childId) ?? approvals?.[childId];
  if (!child) {
    throw new FlowError('APPROVAL_EXPIRED', `unknown approval child: ${childId}`, { childId });
  }
  if (child !== policyInput.approval && child.nonce !== policyInput.approval.nonce) {
    throw new FlowError('POLICY_DENIED', 'submitted child does not match the authorized approval', {
      reasons: ['approval-unbound'],
    });
  }
  // Child cap binds the reservation: a 1-credit child never authorizes 25.
  if (typeof child.maxCredits === 'number' && Number.isFinite(child.maxCredits) && reservationAmount > child.maxCredits) {
    throw new FlowError('RESERVATION_EXCEEDED', 'reservation exceeds the approval child credit cap', {
      childId,
      reservationAmount,
      maxCredits: child.maxCredits,
    });
  }
  const reserved = ledger?.reserved ?? 0;
  const max = ledger?.maxAuthorized ?? Infinity;
  if (typeof reserved !== 'number' || reserved + reservationAmount > max) {
    throw new FlowError('RESERVATION_EXCEEDED', 'reservation exceeds authorized maximum', {});
  }

  const preLockRevision = operation.revision;
  return withStoreLock(store.lockFile, () => {
    const current = store.getOperation(operationId);
    if (current.revision !== preLockRevision) {
      throw new FlowError('STORAGE_CONFLICT', 'operation changed before commit; refusing stale commit', {
        expected: preLockRevision,
        actual: current.revision,
      });
    }
    if (store.isChildConsumed(childId)) {
      throw new FlowError('APPROVAL_CONSUMED', 'approval child already consumed (durable one-shot record)', { childId });
    }
    // In-memory single-use first (throws APPROVAL_CONSUMED on double use),
    // then the ledger. Both are rolled back below on any later failure.
    consumeChildApproval(approvals, childId);
    const prevReserved = ledger.reserved ?? 0;
    let markerWritten = false;
    try {
      reserveCredits(ledger, reservationAmount);
      const attemptNo = (current.attempts?.length ?? 0) + 1;
      const attemptId = `${current.id}:attempt-${attemptNo}`;
      const updated = {
        ...current,
        approvalChildId: childId,
        nonce: child.nonce ?? current.nonce,
        reservationAmount: (current.reservationAmount ?? 0) + reservationAmount,
        status: 'prepared',
        attempts: [
          ...(current.attempts ?? []),
          { kind: 'commit', id: attemptId, childId, reservationAmount, at: new Date().toISOString() },
        ],
      };
      const persisted = store.writeOperationCAS(updated, current.revision);
      durableWriteJson(store._consumedMarkerFile(childId), {
        v: OPERATION_SCHEMA_VERSION,
        childId,
        operationId: current.id,
        attemptId,
        nonce: child.nonce ?? null,
        consumedAt: new Date().toISOString(),
      });
      markerWritten = true;
      const jd = journalDir ?? store.journalDir;
      try {
        appendJournal(jd, 'intent', {
          id: current.operationId ?? current.id,
          operationId: current.operationId ?? current.id,
          requestDigest: current.requestDigest,
          leaseEpoch: current.leaseEpoch,
        });
        appendJournal(jd, 'attempt', { id: attemptId, operationId: current.id });
        appendJournal(jd, 'approval', { id: childId, requestDigest: current.requestDigest });
        appendJournal(jd, 'reservation', {
          id: `${current.id}:res-${attemptNo}`,
          operationId: current.id,
        });
      } catch (e) {
        failBlocked(`journal failed after durable commit; attempt is recorded but submit is blocked: ${e.message}`, {
          operationId: current.id,
          attemptId,
        });
      }
      return persisted;
    } catch (e) {
      try {
        child.consumed = false;
        delete child.consumedAt;
      } catch {
        // ignore
      }
      try {
        if (ledger && typeof ledger === 'object') ledger.reserved = prevReserved;
      } catch {
        // ignore
      }
      if (markerWritten) {
        try {
          fs.rmSync(store._consumedMarkerFile(childId), { force: true });
        } catch {
          // ignore
        }
      }
      throw e;
    }
  });
}

export function recoverAfterRestart(store) {
  if (!store || typeof store.listOperations !== 'function') {
    throw new FlowError('OPERATION_INVALID', 'recovery requires an operation store', {});
  }
  const all = store.listOperations();
  const uncertain = all.filter((o) => o.status === 'submission_unknown' || o.status === 'submitted');
  const reservationsRetained = all.reduce(
    (sum, o) => sum + (Number.isFinite(o.reservationAmount) ? o.reservationAmount : 0),
    0,
  );
  return { uncertain, reservationsRetained, total: all.length };
}

// ---------------------------------------------------------------------------
// W05 pre-click freshness + epoch gates (Sec 3.3 / 7.5).
// Immediate read-back: account/project/settings/refs/capability <=5s,
// quote <=30s, lease epoch must match before EVERY consequential event and
// at poll checkpoints. Any missing field denies (fail closed).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W05 pre-click gate (Sec 3.3 / 7.5): the CORRECTED common policy is
// authoritative. This adapter only adds the UI-lease epoch check (which the
// policy does not own) and then delegates every freshness / binding /
// quote / approval decision to evaluateSubmissionPolicy. There is deliberately
// NO local duplicate check and NO permissive fallback: legacy observation
// shapes (settingsDigest/refs/capability wrappers) are not accepted and deny.
// ---------------------------------------------------------------------------

export function evaluatePreClickFreshness(input = {}) {
  const {
    account = null,
    project = null,
    verification = null,
    quote = null,
    approval = null,
    requestDigest = null,
    policy = null,
    capabilities = null,
    leaseEpoch = null,
    expectedEpoch = null,
    now = Date.now(),
  } = input;
  const reasons = [];

  // Epoch: must match before every consequential event and poll checkpoint.
  if (typeof leaseEpoch !== 'number' || typeof expectedEpoch !== 'number') {
    reasons.push('epoch-missing');
  } else if (leaseEpoch !== expectedEpoch) {
    reasons.push('epoch-mismatch');
  }

  // Everything else is the common policy's decision — including negative /
  // future / unbound evidence, which the old duplicate gate wrongly allowed.
  const verdict = evaluateSubmissionPolicy({
    account,
    project,
    verification,
    quote,
    approval,
    requestDigest,
    policy,
    capabilities,
    now,
  });
  if (verdict.decision !== 'allow') {
    reasons.push(...verdict.reasons);
  }

  if (reasons.length > 0) {
    return { decision: 'deny', reasons, next_action: verdict.next_action };
  }
  return { decision: 'allow', reasons: [], next_action: null };
}

export function assertPreClickFresh(input) {
  const verdict = evaluatePreClickFreshness(input);
  if (verdict.decision !== 'allow') {
    throw new FlowError('OPERATION_DENIED', 'Pre-click freshness gate denied submit', { reasons: verdict.reasons });
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// W05 poll correlation (Sec 3.4 / R02 / K30).
// Automatic linkage requires ALL of: stable observable remote asset ID,
// pre-submit baseline proving newness, expected media type, and positive
// attempt-to-result evidence actually exposed by the UI. New ID alone,
// time/order, prompt match, or one plausible thumbnail alone is NOT
// positive attribution. Multiple plausibles / missing IDs / baselines stay
// uncertain (unknown/ambiguous) for a user choice. Manual adoption never
// rewrites the original spend uncertainty.
// ---------------------------------------------------------------------------

export function correlatePollResult({ operation = null, baseline = null, expectedType = null, candidates = [] } = {}) {
  const reasons = [];
  if (!operation || typeof operation.id !== 'string') reasons.push('operation-missing');
  if (!baseline || !Array.isArray(baseline.ids) || typeof baseline.observedAt !== 'number') {
    reasons.push('baseline-missing');
  }
  if (typeof expectedType !== 'string' || expectedType.length === 0) reasons.push('expected-type-missing');
  if (!Array.isArray(candidates) || candidates.length === 0) reasons.push('no-candidates');
  if (reasons.length > 0) return { verdict: 'unknown', asset: null, reasons };

  const opIds = new Set([operation.id, operation.operationId, operation.nonce].filter((x) => typeof x === 'string'));
  const eligible = [];
  const perCandidate = [];
  for (const c of candidates) {
    const cReasons = [];
    if (!c || typeof c.id !== 'string' || c.id.length === 0) cReasons.push('no-stable-id');
    else if (baseline.ids.includes(c.id)) cReasons.push('not-new-vs-baseline');
    if (typeof c?.observedAt !== 'number' || !(c.observedAt > baseline.observedAt)) {
      cReasons.push('not-newer-than-baseline');
    }
    if (c?.type !== expectedType) cReasons.push('type-mismatch');
    // Positive exposed attempt attribution: the UI must expose a link back
    // to this exact attempt (operation id or nonce). Prompt text, timing, or
    // ordering alone never counts.
    if (typeof c?.attribution !== 'string' || !opIds.has(c.attribution)) {
      cReasons.push('no-positive-attempt-attribution');
    }
    if (cReasons.length === 0) eligible.push(c);
    else perCandidate.push({ id: c?.id ?? null, reasons: cReasons });
  }
  if (eligible.length === 1) {
    return { verdict: 'linked', asset: eligible[0], reasons: [] };
  }
  if (eligible.length > 1) {
    return { verdict: 'ambiguous', asset: null, reasons: ['multiple-plausible-results'], candidates: eligible.map((c) => c.id) };
  }
  const flat = perCandidate.flatMap((p) => p.reasons);
  return { verdict: 'unknown', asset: null, reasons: [...new Set(flat)] };
}

// ---------------------------------------------------------------------------
// W05 partial/multi-variant ledger (Sec 3.3).
// A landed/missing/duplicate-by-content/rejected variant never establishes
// its charge or refund. Uncertainty keeps the full reservation. Attempt and
// variant charges are never double-booked: once an attempt total is settled
// from batch-level evidence, per-variant settlement for the same spend is
// refused, and settlement never exceeds the reservation.
// ---------------------------------------------------------------------------

export function recordVariantLanding(operation, variant = {}) {
  if (!operation || typeof operation !== 'object' || !operation.id) {
    throw new FlowError('OPERATION_INVALID', 'variant landing requires an operation', {});
  }
  if (!variant || typeof variant.id !== 'string' || variant.id.length === 0) {
    throw new FlowError('OPERATION_INVALID', 'variant requires a stable id', {});
  }
  const variants = operation.variants && typeof operation.variants === 'object'
    ? { expected: operation.variants.expected ?? 0, landed: [...(operation.variants.landed ?? [])] }
    : { expected: 0, landed: [] };
  // Preserve separate remote attempt records even when bytes deduplicate.
  variants.landed.push({
    id: variant.id,
    contentHash: variant.contentHash ?? null,
    observedAt: variant.observedAt ?? Date.now(),
  });
  // Reservation is untouched: partial landing releases nothing.
  return { ...operation, variants };
}

export function settleOperationReservation(operation, amount, { evidence = null } = {}) {
  if (!operation || typeof operation !== 'object') {
    throw new FlowError('OPERATION_INVALID', 'settlement requires an operation', {});
  }
  if (!evidence || typeof evidence !== 'object' || typeof evidence.kind !== 'string' || evidence.kind.trim().length === 0) {
    throw new FlowError('JOURNAL_INVALID', 'settlement requires attributable charge/refund evidence (empty evidence never allows)', {});
  }
  if (evidence.amount !== undefined && evidence.amount !== amount) {
    throw new FlowError('JOURNAL_INVALID', 'settlement evidence amount must match the settled amount', {});
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new FlowError('JOURNAL_INVALID', 'settlement amount must be a positive finite number', {});
  }
  const reserved = Number.isFinite(operation.reservationAmount) ? operation.reservationAmount : 0;
  const settled = Number.isFinite(operation.settledAmount) ? operation.settledAmount : 0;
  if (settled + amount > reserved) {
    throw new FlowError('RESERVATION_EXCEEDED', 'settlement would exceed the reservation (no double-book)', {
      reserved, settled, amount,
    });
  }
  return { ...operation, settledAmount: settled + amount, lastSettlement: evidence };
}

// ---------------------------------------------------------------------------
// W05 unknown retry + cross-process guarded single-use (Sec 3.3/3.4).
// An UNKNOWN outcome never auto-retries: the caller must present a FRESH
// unconsumed child plus an explicit duplication-risk acknowledgment. Both
// attempts stay in the ledger. Consumption goes through the store lock so
// concurrent contenders serialize and exactly one wins.
// ---------------------------------------------------------------------------

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function consumeChildApprovalGuarded(approvals, childId, { lockFile, retries = 100, delayMs = 5 } = {}) {
  if (!lockFile || typeof lockFile !== 'string') {
    throw new FlowError('OPERATION_INVALID', 'guarded consumption requires a lockFile', {});
  }
  let handle = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      handle = acquireLock(lockFile);
      break;
    } catch (e) {
      // Only lock contention retries; I/O failures fail closed immediately.
      if (!(e instanceof FlowError) || e.code !== 'LOCK_HELD') throw e;
      if (i === retries - 1) throw e;
      await sleepMs(delayMs);
    }
  }
  try {
    return consumeChildApproval(approvals, childId);
  } finally {
    // Release failure is load-bearing: never swallow a fence signal.
    handle.release();
  }
}

function assertFreshChild(child, childId, requestDigest) {
  if (!child) {
    throw new FlowError('APPROVAL_EXPIRED', `unknown approval child: ${childId}`, { childId });
  }
  if (child.consumed === true) {
    throw new FlowError('APPROVAL_CONSUMED', 'retry requires a fresh unconsumed child (single-use)', { childId });
  }
  if (child.revoked === true) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child revoked', { childId });
  }
  const now = Date.now();
  if (typeof child.expiresAt !== 'number' || !Number.isFinite(child.expiresAt)) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child requires a numeric expiry (corrected binding)', { childId });
  }
  if (now > child.expiresAt) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child expired', { childId });
  }
  if (typeof child.id !== 'string' || typeof child.nonce !== 'string' || child.nonce.length === 0) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child requires id + nonce binding', { childId });
  }
  const digest = child.requestDigest ?? child.digest ?? null;
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child requires a digest binding', { childId });
  }
  if (requestDigest !== null && digest !== requestDigest) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child digest mismatch', { childId });
  }
  return true;
}

export async function prepareUnknownRetry({
  store, approvals, operationId, freshChildId, ackDuplicationRisk = false,
} = {}) {
  if (!store || typeof store.getOperation !== 'function' || typeof store.writeOperationCAS !== 'function') {
    throw new FlowError('OPERATION_INVALID', 'retry requires an operation store', {});
  }
  const operation = store.getOperation(operationId);
  if (operation.status !== 'submission_unknown') {
    throw new FlowError('OPERATION_DENIED', 'only submission_unknown operations may retry (never auto-retry safe/terminal states)', {
      status: operation.status,
    });
  }
  if (ackDuplicationRisk !== true) {
    throw new FlowError('OPERATION_DENIED', 'unknown retry requires explicit duplication-risk acknowledgment', {});
  }
  if (typeof freshChildId !== 'string' || freshChildId.length === 0) {
    throw new FlowError('OPERATION_DENIED', 'unknown retry requires a fresh approval child id', {});
  }
  if (freshChildId === operation.approvalChildId) {
    throw new FlowError('APPROVAL_CONSUMED', 'retry requires a NEW child, not the consumed unknown-attempt child', {});
  }
  const child = approvals?.get?.(freshChildId) ?? approvals?.[freshChildId];
  assertFreshChild(child, freshChildId, operation.requestDigest);
  // The fresh child must bind the SAME operation scope — a child authorized
  // for another account/project/digest authorizes nothing here.
  if (typeof operation.accountRef === 'string' && typeof child.accountKey === 'string' && child.accountKey !== operation.accountRef) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child binds a different account', { freshChildId });
  }
  if (typeof operation.projectRef === 'string' && typeof child.projectId === 'string' && child.projectId !== operation.projectRef) {
    throw new FlowError('APPROVAL_EXPIRED', 'retry child binds a different project', { freshChildId });
  }

  const preLockRevision = operation.revision;
  await consumeChildApprovalGuarded(approvals, freshChildId, { lockFile: store.lockFile });
  try {
    return withStoreLock(store.lockFile, () => {
      const current = store.getOperation(operationId);
      if (current.revision !== preLockRevision && current.approvalChildId !== operation.approvalChildId) {
        throw new FlowError('STORAGE_CONFLICT', 'operation changed before retry; refusing stale retry', {
          expected: preLockRevision,
          actual: current.revision,
        });
      }
      if (store.isChildConsumed(freshChildId)) {
        throw new FlowError('APPROVAL_CONSUMED', 'fresh child already consumed (durable one-shot record)', { freshChildId });
      }
      const retryNo = (current.retryCount ?? 0) + 1;
      const updated = {
        ...current,
        approvalChildId: freshChildId,
        nonce: child.nonce ?? current.nonce,
        status: 'prepared',
        retryCount: retryNo,
        attempts: [
          ...(current.attempts ?? []),
          {
            kind: 'unknown-retry',
            id: `${current.id}:retry-${retryNo}`,
            previousChild: current.approvalChildId,
            freshChild: freshChildId,
            ackDuplicationRisk: true,
            at: new Date().toISOString(),
          },
        ],
      };
      const persisted = store.writeOperationCAS(updated, current.revision);
      durableWriteJson(store._consumedMarkerFile(freshChildId), {
        v: OPERATION_SCHEMA_VERSION,
        childId: freshChildId,
        operationId: current.id,
        attemptId: `${current.id}:retry-${retryNo}`,
        nonce: child.nonce ?? null,
        consumedAt: new Date().toISOString(),
      });
      try {
        appendJournal(store.journalDir, 'approval', { id: freshChildId, requestDigest: current.requestDigest });
        appendJournal(store.journalDir, 'attempt', { id: `${current.id}:retry-${retryNo}`, operationId: current.id });
      } catch (e) {
        failBlocked(`journal foundation failed on unknown retry; submit blocked: ${e.message}`, {});
      }
      return persisted;
    });
  } catch (e) {
    try {
      child.consumed = false;
      delete child.consumedAt;
    } catch {
      // ignore
    }
    try {
      fs.rmSync(store._consumedMarkerFile(freshChildId), { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}
