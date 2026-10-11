import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// W05-T1 (corrected): durable aggregate operation store + atomic
// pre-invocation commit + invocation-boundary crash semantics + restart.
// Commits go through the common policy with fully-bound children; CAS guards
// the boundary; restart restores ledger sums from durable state.
function laneTmp(prefix) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

function boundChild(ops, digest, over = {}) {
  return ops.mintChildApproval(
    { policyId: 'zp-1', maxCredits: 100 },
    { index: 0, requestDigest: digest, accountKey: 'a@gmail.com', projectId: 'p1', model: 'm', quoteTotal: 0, ...over },
  );
}

function policyFor(child, digest, over = {}) {
  const now = Date.now();
  return {
    now,
    account: { verified: true, expected: 'a@gmail.com', observed: 'a@gmail.com', observedAt: now },
    project: { requiredId: 'p1', observedId: 'p1' },
    verification: {
      account: { status: 'verified', observedAt: now, origin: 'ev' },
      settings: { status: 'verified', observedAt: now, origin: 'ev' },
      quote: { status: 'verified', observedAt: now, origin: 'ev' },
      capabilities: { status: 'verified', observedAt: now, origin: 'ev' },
    },
    quote: { total: 0, unit: 'total', model: 'm', feature: 'image', quantity: 1, observedAt: now, expiresAt: now + 30_000 },
    capabilities: { supported: true, model: 'm', feature: 'image', observedAt: now },
    approval: child,
    requestDigest: digest,
    policy: null,
    ...over,
  };
}

describe('W05-T1 durable pre-invocation commit + crash boundary + restart', () => {
  it('exposes durable store + atomic commit + boundary helpers', async () => {
    const ops = await import('../src/domain/operations.js');
    expect(typeof ops.createOperationStore).toBe('function');
    expect(typeof ops.commitPreInvocation).toBe('function');
    expect(typeof ops.recordInvocationBoundary).toBe('function');
    expect(typeof ops.classifyCrash).toBe('function');
    expect(typeof ops.recoverAfterRestart).toBe('function');
    const root = laneTmp('w05-t1-api');
    const store = ops.createOperationStore(root);
    expect(typeof store.writeOperationCAS).toBe('function');
    expect(typeof store.isChildConsumed).toBe('function');
    expect(typeof store.restoreLedger).toBe('function');
  });

  it('atomically commits child+reservation+intent+attempt+baseline+epoch before invocation', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05-t1');
    const store = ops.createOperationStore(root);
    const child = boundChild(ops, 'd-t1');
    const approvals = new Map([[child.id, child]]);
    const ledger = { reserved: 0, maxAuthorized: 100 };
    const op = store.createBoundOperation({
      requestDigest: 'd-t1',
      accountRef: 'a@gmail.com',
      projectRef: 'p1',
      settingsRef: 's1',
      refs: ['r1'],
      quote: { total: 0 },
      baseline: { ids: ['old-1'], observedAt: Date.now() },
      leaseEpoch: 1,
    });
    const committed = ops.commitPreInvocation({
      store,
      approvals,
      ledger,
      operationId: op.id,
      childId: child.id,
      reservationAmount: 4,
      journalDir: path.join(root, 'journal'),
      policyInput: policyFor(child, 'd-t1'),
    });
    expect(approvals.get(child.id).consumed).toBe(true);
    expect(ledger.reserved).toBe(4);
    expect(store.isChildConsumed(child.id)).toBe(true);
    const reloaded = store.getOperation(op.id);
    expect(reloaded.requestDigest).toBe('d-t1');
    expect(reloaded.baseline.ids).toContain('old-1');
    expect(reloaded.leaseEpoch).toBe(1);
    expect(reloaded.approvalChildId).toBe(child.id);
    expect(reloaded.status).toBe('prepared');
    expect(reloaded.attempts.length).toBe(1);
    expect(committed.status).toBe('prepared');
    const store2 = ops.createOperationStore(root);
    expect(store2.getOperation(op.id).id).toBe(op.id);
    expect(store2.isChildConsumed(child.id)).toBe(true);
  });

  it('mandatory stable baseline: commit without baseline is denied', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05-t1-nobase');
    const store = ops.createOperationStore(root);
    expect(() => store.createBoundOperation({
      requestDigest: 'd',
      accountRef: 'a',
      projectRef: 'p',
      settingsRef: 's',
      refs: [],
      quote: { total: 0 },
      baseline: null,
      leaseEpoch: 1,
    })).toThrow(/baseline/i);
  });

  it('crash before boundary may resume same attempt; crash at/after boundary is UNKNOWN never safe retry', async () => {
    const ops = await import('../src/domain/operations.js');
    expect(ops.classifyCrash({ boundaryRecorded: false })).toBe('safe-resume-same-attempt');
    const root = laneTmp('w05-t1-crash');
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd-c',
      accountRef: 'a',
      projectRef: 'p',
      settingsRef: 's',
      refs: [],
      quote: { total: 0 },
      baseline: { ids: [], observedAt: Date.now() },
      leaseEpoch: 3,
    });
    const bounded = store.markInvocationBoundary(op.id);
    expect(bounded.status).toBe('submission_unknown');
    expect(typeof bounded.invocationBoundaryAt).toBe('string');
    expect(ops.classifyCrash({ boundaryRecorded: true })).toBe('unknown-never-safe-retry');
    const rec = ops.recoverAfterRestart(store);
    expect(rec.uncertain.map((u) => u.id)).toContain(op.id);
  });

  it('unique operation handles: restart retains reservations (no auto-release)', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05-t1-restart');
    const store = ops.createOperationStore(root);
    const child = boundChild(ops, 'd-r');
    const approvals = new Map([[child.id, child]]);
    const ledger = { reserved: 0, maxAuthorized: 100 };
    const op = store.createBoundOperation({
      requestDigest: 'd-r',
      accountRef: 'a',
      projectRef: 'p',
      settingsRef: 's',
      refs: [],
      quote: { total: 0 },
      baseline: { ids: [], observedAt: Date.now() },
      leaseEpoch: 1,
    });
    ops.commitPreInvocation({
      store, approvals, ledger, operationId: op.id, childId: child.id,
      reservationAmount: 6, journalDir: path.join(root, 'journal'),
      policyInput: policyFor(child, 'd-r'),
    });
    store.markInvocationBoundary(op.id);
    const store2 = ops.createOperationStore(root);
    const rec = ops.recoverAfterRestart(store2);
    expect(rec.reservationsRetained).toBeGreaterThanOrEqual(6);
    expect(store2.getOperation(op.id).status).toBe('submission_unknown');
    const rewired = { reserved: 0, maxAuthorized: 100 };
    store2.restoreLedger(rewired);
    expect(rewired.reserved).toBe(6);
  });
});
