import { describe, it, expect } from 'vitest';
import {
  evaluateSubmissionPolicy,
  isAccountPositive,
  createZeroOnlyPolicy,
} from '../src/domain/submission-policy.js';

const proof = (over = {}) => ({
  status: 'verified',
  required: true,
  observedAt: Date.now(),
  origin: 'ui-readback',
  ...over,
});
const freshAccount = (over = {}) => ({
  expected: 'a@example.com',
  observed: 'a@example.com',
  verified: true,
  observedAt: Date.now(),
  ...over,
});
const boundProject = { requiredId: 'p1', observedId: 'p1' };
const verifiedMap = () => ({
  account: proof(),
  settings: proof(),
  quote: proof(),
  capabilities: proof(),
});
const freshQuote = (over = {}) => ({
  total: 0,
  unit: 'total',
  quantity: 1,
  model: 'M',
  feature: 'image',
  observedAt: Date.now(),
  expiresAt: Date.now() + 30_000,
  ...over,
});
const validApproval = (over = {}) => ({
  id: 'appr-1',
  nonce: 'n-1',
  requestDigest: 'd',
  accountKey: 'a@example.com',
  projectId: 'p1',
  model: 'M',
  maxCredits: 0,
  expiresAt: Date.now() + 60_000,
  consumed: false,
  revoked: false,
  ...over,
});
const fullInput = (now, over = {}) => ({
  account: freshAccount({ observedAt: now }),
  project: { ...boundProject },
  verification: {
    account: proof({ observedAt: now }),
    settings: proof({ observedAt: now }),
    quote: proof({ observedAt: now }),
    capabilities: proof({ observedAt: now }),
  },
  quote: freshQuote({ observedAt: now, expiresAt: now + 30_000 }),
  approval: validApproval({ expiresAt: now + 60_000 }),
  capabilities: { model: 'M', feature: 'image', supported: true, observedAt: now },
  requestDigest: 'd',
  now,
  ...over,
});

describe('W01 submission-policy: positive account + common DENIAL', () => {
  it('denies when account is not positively verified (wrong/unverified/stale)', () => {
    const now = Date.now();
    const bad = evaluateSubmissionPolicy(fullInput(now, { account: freshAccount({ observed: 'b@example.com', observedAt: now }) }));
    expect(bad.decision).toBe('deny');
    expect(bad.reasons.join(' ')).toMatch(/account/i);
    const unverified = evaluateSubmissionPolicy(fullInput(now, { account: freshAccount({ verified: false, observedAt: now }) }));
    expect(unverified.decision).toBe('deny');
    const noTs = fullInput(now);
    delete noTs.account.observedAt;
    expect(evaluateSubmissionPolicy(noTs).decision).toBe('deny');
  });

  it('denies on substring account match (exact positive identity only)', () => {
    expect(isAccountPositive({ expected: 'a@example.com', observed: 'xa@example.com', verified: true, observedAt: Date.now() })).toBe(false);
  });

  it('denies incomplete verification: prepared_unverified can never allow spend', () => {
    const now = Date.now();
    const r = evaluateSubmissionPolicy(fullInput(now, {
      verification: { ...verifiedMap(), settings: { status: 'unverified', required: true } },
    }));
    expect(r.decision).toBe('deny');
  });

  it('denies stale quote and enforces zero-only policy', () => {
    const now = Date.now();
    const stale = evaluateSubmissionPolicy(fullInput(now, {
      quote: freshQuote({ observedAt: now - 120_000, expiresAt: now - 90_000 }),
    }));
    expect(stale.decision).toBe('deny');
    const paidOnZero = evaluateSubmissionPolicy(fullInput(now, {
      quote: freshQuote({ total: 5 }),
      approval: validApproval({ maxCredits: 5 }),
      policy: createZeroOnlyPolicy({ models: ['M'] }),
    }));
    expect(paidOnZero.decision).toBe('deny');
  });

  it('denies consumed/expired/mismatched approval and allows only the full-pass case', () => {
    const now = Date.now();
    const consumed = evaluateSubmissionPolicy(fullInput(now, { approval: validApproval({ consumed: true }) }));
    expect(consumed.decision).toBe('deny');
    const ok = evaluateSubmissionPolicy(fullInput(now));
    expect(ok.decision).toBe('allow');
    expect(ok.reasons).toEqual([]);
  });
});
