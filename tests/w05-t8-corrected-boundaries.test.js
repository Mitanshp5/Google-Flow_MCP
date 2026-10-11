import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// W05 resume R0: boundary reproduction through ACTUAL public methods and the
// CORRECTED W01 foundation. Each case encodes a parent-probe counterexample
// (C1-C8): the corrected behavior is denial / conflict / durability with NO
// in-memory side effects on failure. Against pre-repair code these RED.
function laneTmp(prefix) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

function validPolicyContext(over = {}) {
  const now = Date.now();
  const quote = {
    total: 10, unit: 'total', model: 'm', feature: 'f', quantity: 1,
    observedAt: now, expiresAt: now + 60_000,
  };
  const ctx = {
    now,
    account: { verified: true, expected: 'a@x', observed: 'a@x', observedAt: now },
    project: { requiredId: 'p1', observedId: 'p1' },
    verification: {
      account: { status: 'verified', observedAt: now, origin: 'ev' },
      settings: { status: 'verified', observedAt: now, origin: 'ev' },
      quote: { status: 'verified', observedAt: now, origin: 'ev' },
      capabilities: { status: 'verified', observedAt: now, origin: 'ev' },
    },
    quote,
    capabilities: { supported: true, model: 'm', feature: 'f', observedAt: now },
    requestDigest: 'd',
    policy: null,
    ...over,
  };
  return ctx;
}

describe('W05-R0 corrected-boundary reproduction (must RED pre-repair)', () => {
  it('C1 lock handle releases: two sequential commits share one lock file', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05r0-lock');
    const store = ops.createOperationStore(root);
    for (const digest of ['d-a', 'd-b']) {
      const op = store.createBoundOperation({
        requestDigest: digest, baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
      });
      const child = ops.mintChildApproval(
        { policyId: 'zp', maxCredits: 100 },
        { index: 0, requestDigest: digest, accountKey: 'a@x', projectId: 'p1', model: 'm', quoteTotal: 10 },
      );
      const approvals = new Map([[child.id, child]]);
      const ledger = { reserved: 0, maxAuthorized: 100 };
      const ctx = validPolicyContext({ requestDigest: digest, approval: child });
      ops.commitPreInvocation({
        store, approvals, ledger, operationId: op.id, childId: child.id,
        reservationAmount: 10, journalDir: path.join(root, 'journal'), policyInput: ctx,
      });
    }
    expect(store.listOperations().length).toBe(2);
  });

  it('C2/C3/C5 policy-boundary denials leave zero side effects', async () => {
    const ops = await import('../src/domain/operations.js');
    const cases = {
      'negative-quote': (ctx, child) => {
        ctx.quote = { ...ctx.quote, total: -5 };
        child.quoteTotal = -5;
        ctx.approval = child;
      },
      'future-account': (ctx) => {
        ctx.account = { ...ctx.account, observedAt: ctx.now + 60_000 };
      },
      'future-quote': (ctx) => {
        ctx.quote = { ...ctx.quote, observedAt: ctx.now + 60_000, expiresAt: ctx.now + 120_000 };
      },
      'unbound-approval': (ctx, child) => {
        delete child.accountKey;
        delete child.projectId;
        delete child.model;
        ctx.approval = child;
      },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const root = laneTmp(`w05r0-${name}`);
      const store = ops.createOperationStore(root);
      const op = store.createBoundOperation({
        requestDigest: 'd', baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
      });
      const child = ops.mintChildApproval(
        { policyId: 'zp', maxCredits: 100 },
        { index: 0, requestDigest: 'd', accountKey: 'a@x', projectId: 'p1', model: 'm', quoteTotal: 10 },
      );
      const approvals = new Map([[child.id, child]]);
      const ledger = { reserved: 0, maxAuthorized: 100 };
      const ctx = validPolicyContext({ approval: child });
      mutate(ctx, child);
      let code = '';
      try {
        ops.commitPreInvocation({
          store, approvals, ledger, operationId: op.id, childId: child.id,
          reservationAmount: 10, journalDir: path.join(root, 'journal'), policyInput: ctx,
        });
      } catch (e) {
        code = e?.code || '';
      }
      expect([name, code]).toEqual([name, expect.stringMatching(/POLICY_DENIED|RESERVATION_EXCEEDED|APPROVAL|OPERATION_DENIED/)]);
      expect(child.consumed).toBe(false);
      expect(ledger.reserved).toBe(0);
      expect(store.getOperation(op.id).reservationAmount).toBe(0);
      expect(store.getOperation(op.id).approvalChildId).toBe(null);
    }
  });

  it('C4 child cap binds: maxCredits 1 refuses reservation 25', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05r0-cap');
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd', baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    const child = ops.mintChildApproval(
      { policyId: 'zp', maxCredits: 1 },
      { index: 0, requestDigest: 'd', accountKey: 'a@x', projectId: 'p1', model: 'm', quoteTotal: 25 },
    );
    const approvals = new Map([[child.id, child]]);
    const ledger = { reserved: 0, maxAuthorized: 100 };
    const ctx = validPolicyContext({
      approval: child,
      quote: { total: 25, unit: 'total', model: 'm', feature: 'f', quantity: 1, observedAt: ctx_now(), expiresAt: Date.now() + 60_000 },
    });
    function ctx_now() { return Date.now(); }
    let code = '';
    try {
      ops.commitPreInvocation({
        store, approvals, ledger, operationId: op.id, childId: child.id,
        reservationAmount: 25, journalDir: path.join(root, 'journal'), policyInput: ctx,
      });
    } catch (e) {
      code = e?.code || '';
    }
    expect(code).toMatch(/POLICY_DENIED|RESERVATION_EXCEEDED/);
    expect(child.consumed).toBe(false);
    expect(ledger.reserved).toBe(0);
  });

  it('C6 stale CAS write cannot clobber submission_unknown', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = laneTmp('w05r0-cas');
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd', baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    const staleCopy = { ...op };
    const boundary = store.markInvocationBoundary(op.id);
    expect(boundary.status).toBe('submission_unknown');
    let code = '';
    try {
      store.writeOperationCAS(staleCopy, staleCopy.revision);
    } catch (e) {
      code = e?.code || '';
    }
    expect(code).toMatch(/STORAGE_CONFLICT/);
    expect(store.getOperation(op.id).status).toBe('submission_unknown');
    expect(ops.recoverAfterRestart(store).uncertain.map((u) => u.id)).toContain(op.id);
  });

  it('C7 held-lock commit denies with zero side effects', async () => {
    const ops = await import('../src/domain/operations.js');
    const { acquireLock } = await import('../src/storage/runtime-store.js');
    const root = laneTmp('w05r0-held');
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd', baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    const child = ops.mintChildApproval(
      { policyId: 'zp', maxCredits: 100 },
      { index: 0, requestDigest: 'd', accountKey: 'a@x', projectId: 'p1', model: 'm', quoteTotal: 10 },
    );
    const approvals = new Map([[child.id, child]]);
    const ledger = { reserved: 0, maxAuthorized: 100 };
    const ctx = validPolicyContext({ approval: child });
    const held = acquireLock(store.lockFile);
    let code = '';
    try {
      ops.commitPreInvocation({
        store, approvals, ledger, operationId: op.id, childId: child.id,
        reservationAmount: 25, journalDir: path.join(root, 'journal'), policyInput: ctx,
      });
    } catch (e) {
      code = e?.code || '';
    } finally {
      held.release();
    }
    expect(code).toBe('LOCK_HELD');
    expect(child.consumed).toBe(false);
    expect(ledger.reserved).toBe(0);
    expect(store.getOperation(op.id).reservationAmount).toBe(0);
  });

  it('C8 commit persists attempt journal + durable child marker + restorable ledger', async () => {
    const ops = await import('../src/domain/operations.js');
    const { readJournal, assertJournalClean } = await import('../src/storage/journal.js');
    const root = laneTmp('w05r0-durable');
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd', baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    const child = ops.mintChildApproval(
      { policyId: 'zp', maxCredits: 100 },
      { index: 0, requestDigest: 'd', accountKey: 'a@x', projectId: 'p1', model: 'm', quoteTotal: 10 },
    );
    const approvals = new Map([[child.id, child]]);
    const ledger = { reserved: 0, maxAuthorized: 100 };
    const ctx = validPolicyContext({ approval: child });
    const committed = ops.commitPreInvocation({
      store, approvals, ledger, operationId: op.id, childId: child.id,
      reservationAmount: 10, journalDir: path.join(root, 'journal'), policyInput: ctx,
    });
    expect(committed.attempts.length).toBeGreaterThanOrEqual(1);
    const jr = readJournal(path.join(root, 'journal'));
    assertJournalClean(jr);
    expect(jr.records.map((r) => r.kind)).toContain('attempt');
    // Independent process view: fresh store instance over the same root.
    const store2 = ops.createOperationStore(root);
    expect(store2.isChildConsumed(child.id)).toBe(true);
    const ledger2 = { reserved: 0, maxAuthorized: 100 };
    store2.restoreLedger(ledger2);
    expect(ledger2.reserved).toBe(10);
  });
});
