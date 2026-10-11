import { describe, it, expect } from 'vitest';
import { createUiLease } from '../src/browser/session.js';

describe('W02 navigation lease (epoch discipline, local-only)', () => {
  it('assertCurrent throws STALE_EPOCH on a fenced epoch', () => {
    const lease = createUiLease();
    const epoch = lease.getEpoch();
    lease.fence();
    expect(() => lease.assertCurrent(epoch)).toThrow(/stale-epoch/i);
  });

  it('checkpoint reports false after abort without throwing', () => {
    const lease = createUiLease();
    const epoch = lease.getEpoch();
    lease.abort();
    expect(lease.checkpoint(epoch)).toBe(false);
    expect(lease.isAborted()).toBe(true);
  });

  it('nested transactions join the enclosing transaction (no deadlock)', async () => {
    const lease = createUiLease();
    const res = await Promise.race([
      lease.run(async () => lease.run(async () => 'inner')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 3000)),
    ]);
    expect(res).toBe('inner');
  });
});
