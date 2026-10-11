import { createUiLease } from './session.js';

// W02 UI transaction serialization foundation (navigation-scoped).
// W05 owns durable operations / queue / cross-process fencing; this shared
// lease serializes same-process navigation/config mutations only. Local
// abort/fence here never implies remote cancellation or refund.
let shared = null;

export function getUiLease() {
  if (!shared) shared = createUiLease();
  return shared;
}

export async function withUiTransaction(fn, opts = {}) {
  return getUiLease().run(fn, opts);
}

// Pre-action gate: check immediately before every consequential UI action
// and before trusting a read-back. Returns false (no throw) when stale.
export function checkpointUi(epoch) {
  return getUiLease().checkpoint(epoch);
}

// Throwing variant for places where proceeding stale is unsafe.
export function assertUiCurrent(epoch) {
  return getUiLease().assertCurrent(epoch);
}

// Local-only navigation abort (fences epoch, marks aborted).
export function abortUiNavigation(reason = 'navigation-aborted') {
  return getUiLease().abort(reason);
}

export function fenceUiLease() {
  return getUiLease().fence();
}

export function resetUiLease(reason = 'reset') {
  return getUiLease().abort(reason);
}
