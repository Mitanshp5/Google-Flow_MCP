// W05 isolated lane: UI session lease (ownership, epochs, abort/fencing,
// takeover). Plan refs: story-production-plan Sec 7.5 + W05 (abort + epoch
// before every consequential event and poll checkpoint; TTL/old-PID never
// proves death; explicit verified actor stop/release before takeover;
// stale actors cannot write). No browser import: pure epoch/abort logic so
// tests run with fake callbacks only. This module never claims remote
// render cancellation.
import { FlowError } from '../utils/errors.js';

export const LEASE_TAKEOVER_PROOF_FRESHNESS_MS = 30_000;

function stale(message = 'stale actor: epoch mismatch or fenced; write refused', details = {}) {
  throw new FlowError('STALE_ACTOR', message, details);
}

export function createLeaseManager({ owner = 'unknown-actor' } = {}) {
  let epoch = 1;
  let currentOwner = owner;
  let abortRequested = false;
  let abortReason = null;
  let lastSeenAt = Date.now();
  // One shared AbortSignal per lease generation: aborting fences every
  // holder of this generation's signal at once (poll loops, click guards).
  // Fencing/takeover rotates both the epoch AND the signal — a stale actor
  // holding the old signal observes abort and can never invoke or record.
  let controller = new AbortController();

  function getEpoch() {
    return epoch;
  }

  function getOwner() {
    return currentOwner;
  }

  function isAborted() {
    return abortRequested || controller.signal.aborted;
  }

  function getSignal() {
    return controller.signal;
  }

  // Throwing guard for consequential callbacks: epoch AND shared signal.
  function assertNotAborted(sawEpoch, kind) {
    if (controller.signal.aborted || abortRequested) {
      throw new FlowError('LEASE_ABORTED', `aborted before ${kind}; stale actor cannot invoke`, { epoch, sawEpoch, kind, abortReason });
    }
    return true;
  }

  function recordHeartbeat(sawEpoch = epoch) {
    if (sawEpoch === epoch) lastSeenAt = Date.now();
    return lastSeenAt;
  }

  function assertEpochForWrite(sawEpoch) {
    assertNotAborted(sawEpoch, 'write');
    if (sawEpoch !== epoch) {
      stale('stale actor cannot write (epoch mismatch)', { epoch, sawEpoch });
    }
    return true;
  }

  function checkBeforeEvent(sawEpoch, { kind = 'event' } = {}) {
    // Called before EVERY consequential UI event and at poll checkpoints.
    assertNotAborted(sawEpoch, kind);
    if (sawEpoch !== epoch) {
      stale(`stale epoch before ${kind}; refusing consequential event`, { epoch, sawEpoch, kind });
    }
    return true;
  }

  function requestAbort(reason = 'abort-requested') {
    abortRequested = true;
    abortReason = reason;
    // Fence every signal holder of this generation immediately.
    try {
      controller.abort(reason);
    } catch {
      // AbortController.abort never throws for string reasons; defensive.
    }
    return { epoch, abortRequested, abortReason };
  }

  function clearAbort() {
    // Clearing starts a fresh signal for this epoch: holders of the aborted
    // signal stay fenced (their signal remains aborted); only new holders
    // of getSignal() observe the live generation.
    abortRequested = false;
    abortReason = null;
    controller = new AbortController();
    return { epoch, abortRequested };
  }

  function rotateGeneration() {
    epoch += 1;
    abortRequested = false;
    abortReason = null;
    controller = new AbortController();
    lastSeenAt = Date.now();
  }

  function fenceOldActor(reason = 'fenced') {
    // Fencing rotates the epoch AND the shared signal; the old epoch can
    // never write again and old signal holders observe abort.
    rotateGeneration();
    return { epoch, owner: currentOwner, reason };
  }

  function attemptTakeover({ proof = null, now = Date.now() } = {}) {
    // TTL/lastSeen alone NEVER authorizes takeover: require an explicit
    // verified actor stop + release acknowledgement with fresh verification.
    if (!proof || typeof proof !== 'object') {
      throw new FlowError('TAKEOVER_DENIED', 'takeover requires explicit verified actor stop/release proof (TTL alone insufficient)', {});
    }
    if (proof.actorStopped !== true) {
      throw new FlowError('TAKEOVER_DENIED', 'takeover denied: no verified actor stop', {});
    }
    if (proof.released !== true) {
      throw new FlowError('TAKEOVER_DENIED', 'takeover denied: no verified ownership release', {});
    }
    if (typeof proof.verifiedAt !== 'number' || !Number.isFinite(proof.verifiedAt)) {
      throw new FlowError('TAKEOVER_DENIED', 'takeover denied: verification timestamp missing', {});
    }
    if (now - proof.verifiedAt > LEASE_TAKEOVER_PROOF_FRESHNESS_MS) {
      throw new FlowError('TAKEOVER_DENIED', 'takeover denied: stop/release proof stale; re-verify', {});
    }
    epoch += 1;
    currentOwner = typeof proof.newOwner === 'string' ? proof.newOwner : currentOwner;
    abortRequested = false;
    abortReason = null;
    controller = new AbortController();
    lastSeenAt = now;
    return { epoch, owner: currentOwner };
  }

  return {
    getEpoch,
    getOwner,
    isAborted,
    getSignal,
    assertNotAborted,
    recordHeartbeat,
    assertEpochForWrite,
    checkBeforeEvent,
    requestAbort,
    clearAbort,
    fenceOldActor,
    attemptTakeover,
  };
}
