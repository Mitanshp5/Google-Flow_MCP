import { describe, it, expect } from 'vitest';

// W05-T2 (corrected): the common policy is authoritative. This adapter adds
// only the lease-epoch check; every freshness/binding/quote/approval
// decision (including negative / future / unbound evidence) is delegated to
// evaluateSubmissionPolicy. No duplicate optimistic checks, no fallback.
function freshPolicy(over = {}) {
  const now = Date.now();
  const child = {
    id: 'c1', nonce: 'n1', requestDigest: 'd', consumed: false, revoked: false,
    expiresAt: now + 60_000, accountKey: 'a@gmail.com', projectId: 'p1', model: 'M', quoteTotal: 0,
  };
  return {
    now,
    account: { expected: 'a@gmail.com', observed: 'a@gmail.com', verified: true, observedAt: now },
    project: { requiredId: 'p1', observedId: 'p1' },
    verification: {
      account: { status: 'verified', observedAt: now, origin: 'ev' },
      settings: { status: 'verified', observedAt: now, origin: 'ev' },
      quote: { status: 'verified', observedAt: now, origin: 'ev' },
      capabilities: { status: 'verified', observedAt: now, origin: 'ev' },
    },
    quote: { total: 0, unit: 'total', model: 'M', feature: 'image', quantity: 1, observedAt: now, expiresAt: now + 30_000 },
    capabilities: { supported: true, model: 'M', feature: 'image', observedAt: now },
    approval: child,
    requestDigest: 'd',
    policy: null,
    leaseEpoch: 7,
    expectedEpoch: 7,
    ...over,
  };
}

describe('W05-T2 common-policy-authoritative pre-click gate + epoch', () => {
  it('exposes evaluatePreClickFreshness + assertPreClickFresh', async () => {
    const ops = await import('../src/domain/operations.js');
    expect(typeof ops.evaluatePreClickFreshness).toBe('function');
    expect(typeof ops.assertPreClickFresh).toBe('function');
  });

  it('allows only the full-fresh bound match', async () => {
    const { evaluatePreClickFreshness } = await import('../src/domain/operations.js');
    const v = evaluatePreClickFreshness(freshPolicy());
    expect(v.decision).toBe('allow');
    expect(v.reasons).toEqual([]);
  });

  it('denies negative quote, future evidence, and unbound approval (no optimistic allow)', async () => {
    const { evaluatePreClickFreshness } = await import('../src/domain/operations.js');
    const now = Date.now();
    expect(evaluatePreClickFreshness(freshPolicy({
      quote: { total: -5, unit: 'total', model: 'M', feature: 'image', quantity: 1, observedAt: now, expiresAt: now + 30_000 },
      approval: { id: 'c1', nonce: 'n1', requestDigest: 'd', consumed: false, revoked: false, expiresAt: now + 60_000, accountKey: 'a@gmail.com', projectId: 'p1', model: 'M', quoteTotal: -5 },
    })).decision).toBe('deny');
    expect(evaluatePreClickFreshness(freshPolicy({
      account: { expected: 'a@gmail.com', observed: 'a@gmail.com', verified: true, observedAt: now + 60_000 },
    })).decision).toBe('deny');
    expect(evaluatePreClickFreshness(freshPolicy({
      quote: { total: 0, unit: 'total', model: 'M', feature: 'image', quantity: 1, observedAt: now + 60_000, expiresAt: now + 120_000 },
    })).decision).toBe('deny');
    expect(evaluatePreClickFreshness(freshPolicy({
      approval: { id: 'c1', nonce: 'n1', requestDigest: 'd', consumed: false, revoked: false, expiresAt: now + 60_000 },
    })).decision).toBe('deny');
  });

  it('denies stale bindings, epoch mismatch, and missing fields', async () => {
    const { evaluatePreClickFreshness, assertPreClickFresh } = await import('../src/domain/operations.js');
    const now = Date.now();
    const stale = (o) => ({ ...o, observedAt: now - 120_000 });
    expect(evaluatePreClickFreshness(freshPolicy({ account: stale({ expected: 'a@gmail.com', observed: 'a@gmail.com', verified: true }) })).decision).toBe('deny');
    expect(evaluatePreClickFreshness(freshPolicy({ quote: { total: 0, unit: 'total', model: 'M', feature: 'image', quantity: 1, observedAt: now - 120_000, expiresAt: now - 90_000 } })).decision).toBe('deny');
    const epochMismatch = evaluatePreClickFreshness(freshPolicy({ expectedEpoch: 8, leaseEpoch: 7 }));
    expect(epochMismatch.decision).toBe('deny');
    expect(epochMismatch.reasons.join(' ')).toMatch(/epoch/i);
    expect(evaluatePreClickFreshness(freshPolicy({ verification: null })).decision).toBe('deny');
    expect(() => assertPreClickFresh(freshPolicy({ project: { requiredId: 'p1', observedId: 'p2' } }))).toThrow(/mismatch|deni/i);
  });

  it('denies consumed/revoked/expired/digest-mismatched approval', async () => {
    const { evaluatePreClickFreshness } = await import('../src/domain/operations.js');
    const now = Date.now();
    const base = { id: 'c', nonce: 'n', requestDigest: 'd', accountKey: 'a@gmail.com', projectId: 'p1', model: 'M', quoteTotal: 0 };
    for (const approval of [
      { ...base, consumed: true, revoked: false, expiresAt: now + 60_000 },
      { ...base, consumed: false, revoked: true, expiresAt: now + 60_000 },
      { ...base, consumed: false, revoked: false, expiresAt: now - 1_000 },
      { ...base, consumed: false, revoked: false, expiresAt: now + 60_000, requestDigest: 'other' },
    ]) {
      expect(evaluatePreClickFreshness(freshPolicy({ approval, now })).decision).toBe('deny');
    }
  });
});
