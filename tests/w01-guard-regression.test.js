import { describe, it, expect } from 'vitest';
import { digestRequest } from '../src/domain/contracts.js';
import { evaluateSubmissionPolicy } from '../src/domain/submission-policy.js';

function input() {
  const now = Date.now();
  const proof = () => ({ status: 'verified', required: true, observedAt: now, origin: 'fixture-readback' });
  return {
    now, requestDigest: 'd',
    account: { expected: 'a@example.com', observed: 'a@example.com', verified: true, observedAt: now },
    project: { requiredId: 'p', observedId: 'p' },
    verification: { account: proof(), settings: proof(), quote: proof(), capabilities: proof() },
    quote: { total: 5, unit: 'total', quantity: 1, model: 'M', feature: 'image', observedAt: now, expiresAt: now + 30000 },
    approval: { id: 'a', nonce: 'n', requestDigest: 'd', accountKey: 'a@example.com', projectId: 'p', model: 'M', maxCredits: 10, expiresAt: now + 60000 },
    capabilities: { model: 'M', feature: 'image', supported: true, observedAt: now },
  };
}

describe('parent foundation negative regressions', () => {
  it('rejects sparse array payloads instead of colliding with empty arrays', () => {
    expect(() => digestRequest({ references: new Array(1) })).toThrow(/sparse|hole/i);
  });
  it('cannot make mandatory settings proof optional to bypass verification', () => {
    const v = input();
    v.verification.settings = { status: 'unverified', required: false };
    expect(evaluateSubmissionPolicy(v).decision).toBe('deny');
  });
  it('paid submission requires a finite authorized cap', () => {
    const v = input();
    delete v.approval.maxCredits;
    expect(evaluateSubmissionPolicy(v).decision).toBe('deny');
  });
  it('enforces both parent and child caps, not only the larger child cap', () => {
    const v = input();
    v.policy = { maxCredits: 1 };
    expect(evaluateSubmissionPolicy(v).decision).toBe('deny');
  });
});
