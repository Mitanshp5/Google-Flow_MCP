import { describe, it, expect } from 'vitest';
import {
  CONTRACT_VERSION,
  READINESS,
  createResult,
  canAuthorizeSpend,
  digestRequest,
  canonicalStringify,
} from '../src/domain/contracts.js';

const proof = (over = {}) => ({
  status: 'verified',
  required: true,
  observedAt: Date.now(),
  origin: 'ui-readback',
  ...over,
});

describe('W01 contracts: truthful requested/actual/readiness', () => {
  it('exposes versioned contract with canonical readiness states', () => {
    expect(CONTRACT_VERSION).toBe(1);
    for (const s of ['ready', 'prepared_unverified', 'blocked', 'unsupported', 'manual_action_required']) {
      expect(READINESS).toContain(s);
    }
  });

  it('builds a typed prepared_unverified result carrying requested/actual/verification', () => {
    const r = createResult({
      requested: { prompt: 'a shot', feature: 'image', duration: '8s', quantity: 1 },
      actual: { prompt: 'a shot', feature: 'image', duration: '8s', quantity: 1 },
      verification: {
        model: { status: 'verified', required: true, observedAt: Date.now(), origin: 'ui' },
        duration: { status: 'unverified', required: true },
      },
      readiness: 'prepared_unverified',
    });
    expect(r.v).toBe(1);
    expect(r.requested.prompt).toBe('a shot');
    expect(r.readiness).toBe('prepared_unverified');
    expect(canAuthorizeSpend(r)).toBe(false);
  });

  it('refuses ready when a required field is unverified (no false ready)', () => {
    expect(() =>
      createResult({
        requested: { prompt: 'x', feature: 'image' },
        actual: { prompt: 'x', feature: 'image' },
        verification: { model: { status: 'unverified', required: true } },
        readiness: 'ready',
      }),
    ).toThrow(/ready/i);
  });

  it('accepts ready only with evidenced required proof and matching actual', () => {
    const r = createResult({
      requested: { prompt: 'x', feature: 'image' },
      actual: { prompt: 'x', feature: 'image' },
      verification: {
        model: proof(),
        settings: proof(),
        enhancement: { status: 'unverified', required: false },
      },
      readiness: 'ready',
    });
    expect(canAuthorizeSpend(r)).toBe(true);
  });

  it('denies vacuous, na-based, evidence-free, and mismatched ready claims', () => {
    expect(() =>
      createResult({ requested: { prompt: 'x', feature: 'image' }, actual: {}, verification: {}, readiness: 'ready' }),
    ).toThrow();
    expect(canAuthorizeSpend({
      v: 1,
      readiness: 'ready',
      requested: { prompt: 'x', feature: 'image' },
      actual: { prompt: 'x', feature: 'image' },
      verification: { model: { status: 'na', required: true } },
    })).toBe(false);
    expect(canAuthorizeSpend({
      v: 1,
      readiness: 'ready',
      requested: { prompt: 'x', feature: 'image' },
      actual: { prompt: 'x', feature: 'image' },
      verification: { model: { status: 'verified', required: true } },
    })).toBe(false);
  });

  it('rejects unknown readiness and bad verification statuses', () => {
    expect(() =>
      createResult({ requested: {}, actual: {}, verification: {}, readiness: 'all_good' }),
    ).toThrow();
    expect(() =>
      createResult({
        requested: {}, actual: {}, verification: { x: { status: 'maybe' } }, readiness: 'blocked',
      }),
    ).toThrow();
  });

  it('digests identical requests deterministically and rejects non-JSON', () => {
    const a = digestRequest({ b: 1, a: 2 });
    const b = digestRequest({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(16);
    expect(digestRequest({ nested: { x: [1, 2] } })).not.toBe(digestRequest({ nested: { x: [1, 3] } }));
    expect(() => canonicalStringify({ a: undefined })).toThrow();
    expect(() => canonicalStringify({ a: NaN })).toThrow();
  });
});
