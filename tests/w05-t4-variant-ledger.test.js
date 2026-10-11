import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// W05-T4 RED: partial/multi-variant ledger discipline.
// Plan refs: Sec 3.3 (unknown keeps reservation; balance deltas are not
// attribution; track expected vs landed; q4 keeps upper bound; never
// double-book attempt batch + per-variant charges; settle attempt total
// when only total-batch attribution exists).
describe('W05-T4 partial/multi-variant ledger', () => {
  it('RED: exposes recordVariantLanding + settleOperationReservation', async () => {
    const ops = await import('../src/domain/operations.js');
    expect(typeof ops.recordVariantLanding).toBe('function');
    expect(typeof ops.settleOperationReservation).toBe('function');
  });

  it('partial landing keeps the full reservation (no auto-release, no inferred refund)', async () => {
    const ops = await import('../src/domain/operations.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w05-t4-'));
    const store = ops.createOperationStore(root);
    const op = store.createBoundOperation({
      requestDigest: 'd', accountRef: 'a', projectRef: 'p', settingsRef: 's',
      refs: [], quote: { total: 8 }, baseline: { ids: [], observedAt: Date.now() }, leaseEpoch: 1,
    });
    const withExpected = { ...op, variants: { expected: 4, landed: [] }, reservationAmount: 8, settledAmount: 0 };
    const afterOne = ops.recordVariantLanding(withExpected, { id: 'v-1', contentHash: 'h1' });
    expect(afterOne.variants.landed.length).toBe(1);
    expect(afterOne.reservationAmount).toBe(8);
    expect(afterOne.settledAmount ?? 0).toBe(0);
  });

  it('duplicate-by-content keeps separate attempt records; never double-books', async () => {
    const ops = await import('../src/domain/operations.js');
    const base = { id: 'op-x', variants: { expected: 2, landed: [] }, reservationAmount: 4, settledAmount: 0 };
    const a = ops.recordVariantLanding(base, { id: 'v-1', contentHash: 'same' });
    const b = ops.recordVariantLanding(a, { id: 'v-2', contentHash: 'same' });
    expect(b.variants.landed.length).toBe(2);
    expect(b.variants.landed[0].id).not.toBe(b.variants.landed[1].id);
    // Settlement with batch-only evidence settles the attempt total once.
    const settled = ops.settleOperationReservation(b, 4, { evidence: { kind: 'batch-charge', amount: 4 } });
    expect(settled.settledAmount).toBe(4);
    // A second per-variant settlement for the same spend is refused (no double-book).
    expect(() => ops.settleOperationReservation(settled, 2, { evidence: { kind: 'variant-charge', amount: 2 } })).toThrow(/double|exceed|settle/i);
  });

  it('settlement requires attributable evidence and never exceeds the reservation', async () => {
    const ops = await import('../src/domain/operations.js');
    const base = { id: 'op-y', variants: { expected: 1, landed: [] }, reservationAmount: 4, settledAmount: 0 };
    expect(() => ops.settleOperationReservation(base, 2, {})).toThrow(/evidence/i);
    expect(() => ops.settleOperationReservation(base, 99, { evidence: { kind: 'x', amount: 99 } })).toThrow(/exceed|reservation/i);
  });
});
