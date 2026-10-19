import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), close: vi.fn() }));
vi.mock('../src/browser/composer-references.js', () => ({ readComposerReferences: mocks.read }));
vi.mock('../src/browser/safe-actions.js', () => ({ openBarSettings: mocks.open, closeSettingsPanel: mocks.close }));
import { setVideoReferenceMode } from '../src/browser/video-frames.js';

beforeEach(() => vi.clearAllMocks());

describe('video reference mode read-before-write', () => {
  it('verifies existing observable Start/End slots without requiring a radio', async () => {
    mocks.read.mockResolvedValue({ mode: 'frames', slotsObservable: true, slots: {} });
    expect(await setVideoReferenceMode({}, 'frames')).toMatchObject({ ok: true, verified: true });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('does not toggle away from populated observable frames', async () => {
    mocks.read.mockResolvedValue({ mode: 'frames', slotsObservable: true, slots: { start: { assetId: 'abc' } } });
    expect((await setVideoReferenceMode({}, 'frames')).verified).toBe(true);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('does not claim verification from unobservable slots or unknown mode', async () => {
    mocks.read.mockResolvedValue({ mode: 'frames', slotsObservable: false });
    mocks.open.mockResolvedValue({ panel: null, error: 'settings unavailable' });
    expect((await setVideoReferenceMode({}, 'frames')).verified).toBe(false);
    expect(mocks.open).toHaveBeenCalled();
  });

  it('accepts positively observed ingredient mode, not a different requested mode', async () => {
    mocks.read.mockResolvedValue({ mode: 'ingredients', chipsObservable: true });
    expect((await setVideoReferenceMode({}, 'ingredients')).verified).toBe(true);
    mocks.open.mockResolvedValue({ panel: null, error: 'settings unavailable' });
    expect((await setVideoReferenceMode({}, 'frames')).verified).toBe(false);
  });
});
