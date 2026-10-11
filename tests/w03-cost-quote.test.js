import { describe, it, expect } from 'vitest';

// W03: cost-unit parsing per generation vs total, quantity upper bound,
// unknown cost, freshness/entitlement/rate signals.
// Evidence: "Generating will use 0 credits" / "0 credits" (072, manual-live-image-models).
// Sources: official-source-1 "costs below are per generation, not per request".

import {
  parseCostLabel,
  isQuoteFresh,
  detectEntitlement,
  detectRateSignal,
  QUOTE_MAX_AGE_MS,
} from '../src/browser/cost-quote.js';

describe('W03 cost quote parsing (parent #3 strict)', () => {
  it('parses zero-credit label as known zero (binding+freshness still required at integration)', () => {
    const q = parseCostLabel('Generating will use 0 credits', { quantity: 1 });
    expect(q.state).toBe('known');
    expect(q.amount).toBe(0);
    expect(q.totalUpperBound).toBe(0);
    expect(q.isZero).toBe(true);
  });

  it('explicit per-generation scales; explicit total does not double-multiply', () => {
    const perGen = parseCostLabel('20 credits per generation', { quantity: 4 });
    expect(perGen.unit).toBe('per-generation');
    expect(perGen.state).toBe('known');
    expect(perGen.totalUpperBound).toBe(80);
    const total = parseCostLabel('20 credits total', { quantity: 4 });
    expect(total.unit).toBe('total');
    expect(total.state).toBe('known');
    expect(total.totalUpperBound).toBe(20);
  });

  it('ambiguous nonzero unit blocks (no spend), conservative upper bound reported', () => {
    const amb = parseCostLabel('10 credits', { quantity: 4 });
    expect(amb.state).toBe('unknown');
    expect(amb.totalUpperBound).toBe(40);
    const ambGen = parseCostLabel('Generating will use 5 credits', { quantity: 2 });
    expect(ambGen.state).toBe('unknown');
  });

  it('rejects negative, commas, multiple/conflicting amounts, unrelated/non-credit units', () => {
    expect(parseCostLabel('-5 credits', { quantity: 1 }).state).toBe('unknown');
    expect(parseCostLabel('1,000 credits total', { quantity: 1 }).state).toBe('unknown');
    expect(parseCostLabel('10 credits (was 20 credits) total', { quantity: 1 }).state).toBe('unknown');
    expect(parseCostLabel('10 tokens', { quantity: 1 }).state).toBe('unknown');
    expect(parseCostLabel('10 dollars total', { quantity: 1 }).state).toBe('unknown');
    expect(parseCostLabel('', { quantity: 1 }).state).toBe('unknown');
    expect(parseCostLabel(null, { quantity: 1 }).state).toBe('unknown');
    expect(() => parseCostLabel('5 credits total', { quantity: 99 })).toThrow();
  });

  it('freshness TTL 30s; entitlement/rate signals detected', () => {
    expect(QUOTE_MAX_AGE_MS).toBe(30 * 1000);
    expect(isQuoteFresh(new Date().toISOString(), Date.now())).toBe(true);
    expect(isQuoteFresh(new Date(Date.now() - 60 * 1000).toISOString(), Date.now())).toBe(false);
    expect(detectEntitlement('Upgrade to remix').entitlement).toBe('upgrade_required');
    expect(detectEntitlement('Generating will use 0 credits').entitlement).toBe('none');
    expect(detectRateSignal('GOOGLE_LIMIT_REACHED try later').rateLimited).toBe(true);
    expect(detectRateSignal('Generating will use 0 credits').rateLimited).toBe(false);
  });
});
