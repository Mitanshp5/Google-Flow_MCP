import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// W05-T7 (corrected) vertical slice: full safe-submit flow with an injected
// fake click (never a live browser). Gate = common policy (fully bound) +
// lease epoch; commit = atomic durable; boundary BEFORE click; poll link
// needs positive attribution; crash at boundary is UNKNOWN; old results
// never satisfy new renders; no exact-once remote claim.
function laneTmp(prefix) {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

describe('W05-T7 vertical fake-click submit flow', () => {
  async function setup(digest = 'd-flow') {
    const ops = await import('../src/domain/operations.js');
    const { createLeaseManager } = await import('../src/browser/ui-lease.js');
    const root = laneTmp('w05-t7');
    const store = ops.createOperationStore(root);
    const lease = createLeaseManager({ owner: 'test-actor' });
    const now = Date.now();
    const child = ops.mintChildApproval(
      { policyId: 'zp', maxCredits: 10 },
      { index: 0, requestDigest: digest, accountKey: 'a@gmail.com', projectId: 'p1', model: 'm', quoteTotal: 4 },
    );
    const approvals = new Map([[child.id, child]]);
    const ledger = { reserved: 0, maxAuthorized: 10 };
    const op = store.createBoundOperation({
      requestDigest: digest, accountRef: 'a@gmail.com', projectRef: 'p1', settingsRef: 's1',
      refs: ['r1'], quote: { total: 4 }, baseline: { ids: ['old-1'], observedAt: now }, leaseEpoch: lease.getEpoch(),
    });
    const policyInput = {
      now,
      account: { expected: 'a@gmail.com', observed: 'a@gmail.com', verified: true, observedAt: now },
      project: { requiredId: 'p1', observedId: 'p1' },
      verification: {
        account: { status: 'verified', observedAt: now, origin: 'ev' },
        settings: { status: 'verified', observedAt: now, origin: 'ev' },
        quote: { status: 'verified', observedAt: now, origin: 'ev' },
        capabilities: { status: 'verified', observedAt: now, origin: 'ev' },
      },
      quote: { total: 4, unit: 'total', model: 'm', feature: 'f', quantity: 1, observedAt: now, expiresAt: now + 30_000 },
      capabilities: { supported: true, model: 'm', feature: 'f', observedAt: now },
      approval: child,
      requestDigest: digest,
      policy: null,
      leaseEpoch: lease.getEpoch(),
      expectedEpoch: lease.getEpoch(),
    };
    return { ops, store, lease, approvals, ledger, root, now, opId: op.id, childId: child.id, policyInput };
  }

  it('happy path: gate -> commit -> boundary -> fake click -> linked poll result', async () => {
    const s = await setup();
    const { ops, store, lease } = s;
    expect(ops.evaluatePreClickFreshness(s.policyInput).decision).toBe('allow');
    lease.checkBeforeEvent(lease.getEpoch(), { kind: 'submit-click' });
    const committed = ops.commitPreInvocation({
      store, approvals: s.approvals, ledger: s.ledger, operationId: s.opId,
      childId: s.childId, reservationAmount: 4, journalDir: path.join(s.root, 'journal'),
      policyInput: s.policyInput,
    });
    expect(committed.approvalChildId).toBe(s.childId);
    const bounded = store.markInvocationBoundary(s.opId);
    expect(bounded.status).toBe('submission_unknown');
    // Fake click: test callback only, no browser.
    let clicked = 0;
    const fakeClick = async () => { clicked += 1; return { acknowledged: true }; };
    await fakeClick();
    expect(clicked).toBe(1);
    const linked = ops.correlatePollResult({
      operation: { id: s.opId, nonce: bounded.nonce },
      baseline: bounded.baseline, expectedType: 'video',
      candidates: [{ id: 'new-1', type: 'video', observedAt: s.now + 5_000, attribution: s.opId }],
    });
    expect(linked.verdict).toBe('linked');
  });

  it('crash between boundary and click leaves UNKNOWN with reservation held', async () => {
    const s = await setup();
    const { ops, store } = s;
    ops.commitPreInvocation({
      store, approvals: s.approvals, ledger: s.ledger, operationId: s.opId,
      childId: s.childId, reservationAmount: 4, journalDir: path.join(s.root, 'journal'),
      policyInput: s.policyInput,
    });
    store.markInvocationBoundary(s.opId);
    // Simulated crash: no click acknowledgement ever arrives.
    expect(ops.classifyCrash({ boundaryRecorded: true })).toBe('unknown-never-safe-retry');
    const rec = ops.recoverAfterRestart(store);
    expect(rec.uncertain.map((u) => u.id)).toContain(s.opId);
    expect(rec.reservationsRetained).toBe(4);
    expect(s.ledger.reserved).toBe(4);
  });

  it('old result cannot satisfy a new render (baseline newness enforced)', async () => {
    const s = await setup();
    const { ops, store } = s;
    const bounded = store.markInvocationBoundary(s.opId);
    const r = ops.correlatePollResult({
      operation: { id: s.opId, nonce: bounded.nonce },
      baseline: bounded.baseline, expectedType: 'video',
      candidates: [{ id: 'old-1', type: 'video', observedAt: s.now + 1_000, attribution: s.opId }],
    });
    expect(r.verdict).toBe('unknown');
  });
});
