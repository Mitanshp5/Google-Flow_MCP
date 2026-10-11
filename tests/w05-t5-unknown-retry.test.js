import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// W05-T5 (corrected): unknown retry needs a DISTINCT freshly approved child
// (corrected bindings + numeric expiry) + explicit duplication-risk
// acknowledgment; consumption is durable (marker) + CAS-backed. Concurrency
// through the guarded lock allows exactly one winner.
function laneTmp(prefix) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

function boundChild(ops, digest, over = {}) {
  return ops.mintChildApproval(
    { policyId: 'zp', maxCredits: 100 },
    { index: 0, requestDigest: digest, accountKey: 'a@gmail.com', projectId: 'p1', model: 'm', quoteTotal: 10, ...over },
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
    quote: { total: 10, unit: 'total', model: 'm', feature: 'f', quantity: 1, observedAt: now, expiresAt: now + 60_000 },
    capabilities: { supported: true, model: 'm', feature: 'f', observedAt: now },
    approval: child,
    requestDigest: digest,
    policy: null,
    ...over,
  };
}

describe('W05-T5 unknown retry + guarded single-use concurrency', () => {
  it('exposes prepareUnknownRetry + consumeChildApprovalGuarded', async () => {
    const ops = await import('../src/domain/operations.js');
    expect(typeof ops.prepareUnknownRetry).toBe('function');
    expect(typeof ops.consumeChildApprovalGuarded).toBe('function');
  });

  async function unknownOp() {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05-t5');
    const store = ops.createOperationStore(root);
    const first = boundChild(ops, 'd-u');
    const approvals = new Map([[first.id, first]]);
    const ledger = { reserved: 0, maxAuthorized: 100 };
    const op = store.createBoundOperation({
      requestDigest: 'd-u', accountRef: 'a@gmail.com', projectRef: 'p1', settingsRef: 's',
      refs: [], quote: { total: 10 }, baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    ops.commitPreInvocation({
      store, approvals, ledger, operationId: op.id, childId: first.id,
      reservationAmount: 10, journalDir: path.join(root, 'journal'),
      policyInput: policyFor(first, 'd-u'),
    });
    store.markInvocationBoundary(op.id);
    return { ops, root, store, approvals, ledger, opId: op.id, firstId: first.id };
  }

  it('unknown retry requires explicit duplication-risk ack + a distinct fresh child', async () => {
    const { ops, store, approvals, opId, firstId } = await unknownOp();
    const fresh = boundChild(ops, 'd-u');
    approvals.set(fresh.id, fresh);
    await expect(ops.prepareUnknownRetry({
      store, approvals, operationId: opId, freshChildId: fresh.id, ackDuplicationRisk: false,
    })).rejects.toMatchObject({ code: 'OPERATION_DENIED' });
    expect(approvals.get(fresh.id).consumed).not.toBe(true);
    expect(store.isChildConsumed(fresh.id)).toBe(false);
    await expect(ops.prepareUnknownRetry({
      store, approvals, operationId: opId, freshChildId: firstId, ackDuplicationRisk: true,
    })).rejects.toMatchObject({ code: expect.stringMatching(/APPROVAL|OPERATION/) });
    const retried = await ops.prepareUnknownRetry({
      store, approvals, operationId: opId, freshChildId: fresh.id, ackDuplicationRisk: true,
    });
    expect(approvals.get(fresh.id).consumed).toBe(true);
    expect(store.isChildConsumed(fresh.id)).toBe(true);
    expect(retried.approvalChildId).toBe(fresh.id);
    expect(retried.attempts.length).toBeGreaterThanOrEqual(2);
    expect(store.getOperation(opId).reservationAmount).toBe(10);
  });

  it('retry on a non-unknown operation is denied', async () => {
    const ops = (await import('../src/domain/operations.js'));
    const root = laneTmp('w05-t5-fresh');
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd', accountRef: 'a', projectRef: 'p', settingsRef: 's',
      refs: [], quote: { total: 0 }, baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    const fresh = boundChild(ops, 'd');
    const approvals = new Map([[fresh.id, fresh]]);
    await expect(ops.prepareUnknownRetry({
      store, approvals, operationId: op.id, freshChildId: fresh.id, ackDuplicationRisk: true,
    })).rejects.toMatchObject({ code: 'OPERATION_DENIED' });
  });

  it('concurrent guarded consumption allows exactly one winner', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05-t5-lock');
    const lockFile = path.join(root, 'commit.lock');
    const child = boundChild(ops, 'd');
    const approvals = new Map([[child.id, child]]);
    const results = await Promise.allSettled([
      ops.consumeChildApprovalGuarded(approvals, child.id, { lockFile }),
      ops.consumeChildApprovalGuarded(approvals, child.id, { lockFile }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    expect(String(lost[0].reason?.code ?? lost[0].reason?.message ?? '')).toMatch(/CONSUMED|LOCK|single-use/i);
  });
});
