import { isFlowUrl } from '../utils/sanitize.js';

// W02 session ownership: pure helpers + serialized UI lease.
// No CDP, no launch, no DOM here — callers wire these to Playwright.

export function selectFlowTab(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  for (let i = 0; i < list.length; i++) {
    try {
      if (isFlowUrl(list[i]?.url || '')) return { action: 'reuse', index: i, reason: 'flow-tab' };
    } catch { /* ignore */ }
  }
  // Never repurpose a personal tab (mail, other http pages).
  // Caller must open a dedicated new tab instead.
  return { action: 'create', index: null, reason: list.length ? 'no-flow-tab' : 'no-tabs' };
}

export function checkHeadlessOption(headless) {
  if (headless === true) {
    return {
      supported: false,
      blocker: 'headless unsupported: Flow automation requires a headed Chrome session; headless mode is explicitly unsupported in W02',
    };
  }
  return { supported: true, blocker: null };
}

export function classifyCdpError(err) {
  const msg = String(err?.message || err || '');
  if (/ECONNREFUSED|absent|failed to connect|connect/i.test(msg)) return { kind: 'absent', message: msg };
  if (/EADDRINUSE|already.*use|port.*conflict|listening/i.test(msg)) return { kind: 'port-conflict', message: msg };
  if (/::|0\.0\.0\.0|remote.*bind|forbidden/i.test(msg)) return { kind: 'remote-binding', message: msg };
  return { kind: 'unknown', message: msg };
}

// Attach-first launch plan: a reachable CDP wins even when the configured
// source profile is missing (K03). Profile validation applies only to the
// authorized cold-launch path.
export function describeLaunchPlan({ cdpReachable, profileExists, headless = false, port = 9222 } = {}) {
  const headlessCheck = checkHeadlessOption(headless);
  if (!headlessCheck.supported) return { path: 'blocked', reason: headlessCheck.blocker };
  if (cdpReachable) return { path: 'attach', reason: 'cdp-reachable' };
  if (profileExists === false) {
    return { path: 'blocked', reason: `cold-launch-blocked: no CDP on 127.0.0.1:${port} and source profile missing` };
  }
  return { path: 'cold-launch', reason: 'no-cdp-launch-authorized' };
}

// Navigation-scoped serialized UI lease with epoch fencing.
//
// W02 owns same-process *navigation* serialization only. Durable
// operations, queue fencing and cross-process leases belong to W05:
// fence()/abort() below are LOCAL-ONLY — they never claim remote render
// cancellation, credit refund, or cross-process mutual exclusion.
//
// Handler rule: nested run() calls join the enclosing transaction (same
// epoch, executed inline) instead of re-queueing, so nested navigation
// helpers cannot deadlock against their own outer transaction.
import { AsyncLocalStorage } from 'node:async_hooks';

export function createUiLease() {
  const owner = new AsyncLocalStorage();
  let epoch = 1;
  let tail = Promise.resolve();
  let depth = 0;
  let aborted = false;
  let abortReason = null;
  const staleError = (captured) => {
    const err = new Error(`stale-epoch: captured ${captured} != current ${epoch}`);
    err.code = 'STALE_EPOCH';
    err.captured = captured;
    err.current = epoch;
    return err;
  };
  const lease = {
    getEpoch: () => epoch,
    isCurrent: (e) => (e !== undefined ? e === epoch : true) && !aborted,
    // Throw when a captured epoch is no longer current. Call immediately
    // before every consequential UI action and before trusting a read-back.
    assertCurrent: (e) => {
      if ((e !== undefined && e !== epoch) || aborted) throw staleError(e);
      return true;
    },
    // Non-throwing pre-action gate: true only while the epoch is current
    // and no local abort was requested.
    checkpoint: (e) => (e !== undefined ? e === epoch : true) && !aborted,
    isAborted: () => aborted,
    getAbortReason: () => abortReason,
    fence: () => {
      epoch += 1;
      aborted = false;
      abortReason = null;
      return epoch;
    },
    // Local abort request: fences the epoch and marks this lease aborted.
    // Stale workers must not click or publish success afterwards.
    abort: (reason = 'abort-requested') => {
      aborted = true;
      abortReason = reason;
      epoch += 1;
      return epoch;
    },
    clearAbort: () => {
      aborted = false;
      abortReason = null;
      return epoch;
    },
    reset: () => {
      aborted = false;
      abortReason = null;
      epoch += 1;
      return epoch;
    },
    run: (fn, opts = {}) => {
      // Nested call inside an active transaction joins it (same epoch).
      const enclosing = owner.getStore();
      if (enclosing) {
        const captured = opts.epoch ?? enclosing.epoch;
        return (async () => {
          lease.assertCurrent(captured);
          depth += 1;
          try {
            return await fn({ epoch: captured });
          } finally {
            depth -= 1;
          }
        })();
      }
      const task = tail.then(async () => {
        // If aborted from a prior reset/abort, a fresh top-level transaction starts clean.
        if (depth === 0 && aborted) {
          aborted = false;
          abortReason = null;
        }
        const currentEpoch = opts.epoch ?? epoch;
        lease.assertCurrent(currentEpoch);
        depth += 1;
        try {
          return await owner.run({ epoch: currentEpoch }, () => fn({ epoch: currentEpoch }));
        } finally {
          depth -= 1;
        }
      });
      // Keep the chain alive after rejections.
      tail = task.catch(() => {});
      return task;
    },
  };
  return lease;
}
