import { describe, it, expect } from 'vitest';

// W05-T3 RED: poll correlation with strict attribution.
// Plan refs: Sec 3.4 (stable observable ID + pre-submit baseline proving
// newness + expected media type + positive attempt-to-result evidence;
// time/order/one thumbnail/new ID alone insufficient; missing
// IDs/baselines/multiple plausibles stay uncertain).
function op(id = 'op-1') {
  return { id, operationId: id, nonce: 'n-1' };
}
const base = { ids: ['old-1'], observedAt: 1_000 };

describe('W05-T3 poll correlation', () => {
  it('RED: exposes correlatePollResult', async () => {
    const ops = await import('../src/domain/operations.js');
    expect(typeof ops.correlatePollResult).toBe('function');
  });

  it('links only with stable ID + baseline newness + expected type + positive attribution', async () => {
    const { correlatePollResult } = await import('../src/domain/operations.js');
    const r = correlatePollResult({
      operation: op(), baseline: base, expectedType: 'video',
      candidates: [{ id: 'new-9', type: 'video', observedAt: 2_000, attribution: 'op-1' }],
    });
    expect(r.verdict).toBe('linked');
    expect(r.asset.id).toBe('new-9');
  });

  it('no-id-no-link: missing ID stays unknown even with attribution', async () => {
    const { correlatePollResult } = await import('../src/domain/operations.js');
    const r = correlatePollResult({
      operation: op(), baseline: base, expectedType: 'video',
      candidates: [{ id: null, type: 'video', observedAt: 2_000, attribution: 'op-1' }],
    });
    expect(r.verdict).toBe('unknown');
  });

  it('new-id-without-attribution stays unknown; time/order/prompt alone insufficient', async () => {
    const { correlatePollResult } = await import('../src/domain/operations.js');
    for (const c of [
      { id: 'new-1', type: 'video', observedAt: 2_000, attribution: null },
      { id: 'new-2', type: 'video', observedAt: 2_000, attribution: 'some-other-op' },
      { id: 'new-3', type: 'video', observedAt: 2_000, attribution: 'prompt-matches-but-no-attempt-link' },
    ]) {
      const r = correlatePollResult({ operation: op(), baseline: base, expectedType: 'video', candidates: [c] });
      expect(r.verdict).toBe('unknown');
    }
    // Old thumbnail (in baseline / not newer) never satisfies a new render.
    const old = correlatePollResult({
      operation: op(), baseline: base, expectedType: 'video',
      candidates: [{ id: 'old-1', type: 'video', observedAt: 2_000, attribution: 'op-1' }],
    });
    expect(old.verdict).toBe('unknown');
    // Wrong type never links.
    const wrongType = correlatePollResult({
      operation: op(), baseline: base, expectedType: 'video',
      candidates: [{ id: 'new-5', type: 'image', observedAt: 2_000, attribution: 'op-1' }],
    });
    expect(wrongType.verdict).toBe('unknown');
  });

  it('multiple plausible results are ambiguous (user choice), never auto-linked', async () => {
    const { correlatePollResult } = await import('../src/domain/operations.js');
    const r = correlatePollResult({
      operation: op(), baseline: base, expectedType: 'video',
      candidates: [
        { id: 'new-a', type: 'video', observedAt: 2_000, attribution: 'op-1' },
        { id: 'new-b', type: 'video', observedAt: 2_001, attribution: 'op-1' },
      ],
    });
    expect(r.verdict).toBe('ambiguous');
    expect(r.asset).toBe(null);
  });
});
