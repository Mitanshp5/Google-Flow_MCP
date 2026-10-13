import { describe, it, expect } from 'vitest';
import {
  resolveConfirmWaitMs,
  detectNewMedia,
  GENERATE_CONFIRM_DEFAULT_WAIT_MS,
  GENERATE_CONFIRM_MIN_WAIT_MS,
  GENERATE_CONFIRM_MAX_WAIT_MS,
} from '../src/tools/generate-confirm.js';
import { resolveModel } from '../src/utils/models.js';
import { get } from '../src/utils/config.js';
import { schemas } from '../src/utils/validate.js';

describe('flow_generate_confirm short-wait + poll pattern', () => {
  it('exposes a 20-30s short window (default 25s, ceiling 30s)', () => {
    expect(GENERATE_CONFIRM_DEFAULT_WAIT_MS).toBe(2000);
    expect(GENERATE_CONFIRM_MIN_WAIT_MS).toBe(1000);
    expect(GENERATE_CONFIRM_MAX_WAIT_MS).toBe(30000);
  });

  it('defaults to the short wait when omitted/invalid', () => {
    expect(resolveConfirmWaitMs(undefined).waitMs).toBe(2000);
    expect(resolveConfirmWaitMs(null).waitMs).toBe(2000);
    expect(resolveConfirmWaitMs(0).waitMs).toBe(2000);
    expect(resolveConfirmWaitMs(Number.NaN).waitMs).toBe(2000);
  });

  it('clamps the old 120s full-window wait to the 30s short ceiling', () => {
    const r = resolveConfirmWaitMs(120000);
    expect(r.waitMs).toBe(30000);
    expect(r.clamped).toBe(true);
    expect(r.requested).toBe(120000);
  });

  it('keeps in-range short waits untouched (20-30s)', () => {
    for (const ms of [20000, 25000, 30000]) {
      const r = resolveConfirmWaitMs(ms);
      expect(r.waitMs).toBe(ms);
      expect(r.clamped).toBe(false);
    }
  });

  it('floors tiny waits to the minimum', () => {
    const r = resolveConfirmWaitMs(100);
    expect(r.waitMs).toBe(1000);
    expect(r.clamped).toBe(true);
  });

  it('schema default is the short 25s watch', () => {
    const parsed = schemas.flow_generate_confirm.parse({ job_id: 'abc123' });
    expect(parsed.wait_ms).toBe(2000);
  });
});

describe('confirm new-output detection (early exit signals)', () => {
  it('fires on media count growth (old signal still works)', () => {
    expect(detectNewMedia({ count: 3, ids: [], tiles: [] }, { count: 4, ids: [], tiles: [] })).toBe(true);
  });

  it('fires on a new media id even when the count is unchanged (the missed-completion case)', () => {
    // Image job 838d4ab3 class: remote completed (new id) while a
    // count-only poll would have kept waiting the full window.
    const before = { count: 3, ids: ['aaa'], tiles: ['t1'] };
    const after = { count: 3, ids: ['aaa', 'new-838d4ab3'], tiles: ['t1'] };
    expect(detectNewMedia(before, after)).toBe(true);
  });

  it('fires on a new gallery tile id', () => {
    expect(detectNewMedia({ count: 2, ids: [], tiles: ['a'] }, { count: 2, ids: [], tiles: ['a', 'b'] })).toBe(true);
  });

  it('stays quiet with no new signal', () => {
    const snap = { count: 3, ids: ['aaa'], tiles: ['t1'] };
    expect(detectNewMedia(snap, { ...snap })).toBe(false);
    expect(detectNewMedia(snap, { count: 3, ids: ['aaa'], tiles: ['t1'] })).toBe(false);
  });
});

describe('Omni 1.1 Flash is the video default', () => {
  it('config defaultVideoModel is Omni 1.1 Flash', () => {
    expect(get('defaultVideoModel', 'Omni 1.1 Flash')).toBe('Omni 1.1 Flash');
  });

  it("resolveModel('auto', 'video') returns Omni 1.1 Flash", () => {
    const r = resolveModel('auto', 'video');
    expect(r.name).toBe('Omni 1.1 Flash');
  });

  it("resolveModel(undefined, 'video') returns Omni 1.1 Flash", () => {
    expect(resolveModel(undefined, 'video').name).toBe('Omni 1.1 Flash');
  });
});
