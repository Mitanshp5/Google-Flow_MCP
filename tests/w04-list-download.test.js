import { describe, it, expect } from 'vitest';
import { classifyMentionListing } from '../src/tools/list-mentions.js';
import {
  selectExplicitDownloadTarget,
  verifySavedDownload,
  ASSET_MENU_STEPS,
} from '../src/tools/download-latest.js';

// W04 slice 5 — truthful list (empty vs failed) + explicit/newest-eligible
// download with byte/signature/hash verification. Headless, no CDP.
describe('W04 list-mentions empty vs failed truthful', () => {
  it('picker ok with names is success', () => {
    const r = classifyMentionListing({ pickerStatus: 'ok', names: ['qa-reference.png'] });
    expect(r.toolStatus).toBe('success');
    expect(r.picker).toBe('ok');
  });
  it('picker opened with zero rows is empty, not failed', () => {
    const r = classifyMentionListing({ pickerStatus: 'empty', names: [] });
    expect(r.toolStatus).toBe('success');
    expect(r.picker).toBe('empty');
  });
  it('picker that never opened is blocked, never success-empty', () => {
    const r = classifyMentionListing({ pickerStatus: 'failed', names: [] });
    expect(r.toolStatus).toBe('blocked');
    expect(r.picker).toBe('failed');
  });
});

describe('W04 download explicit mapping + newest eligible', () => {
  it('explicit asset id selects that asset', () => {
    const cands = [
      { id: 'a1', title: 'a.png', kind: 'image', projectId: 'p1', createdAtMs: 100 },
      { id: 'a2', title: 'b.png', kind: 'image', projectId: 'p1', createdAtMs: 200 },
    ];
    const r = selectExplicitDownloadTarget({ explicitAssetId: 'a1', candidates: cands, projectId: 'p1', kind: 'image' });
    expect(r.status).toBe('selected');
    expect(r.asset.id).toBe('a1');
  });
  it('explicit id missing is not_found, never silent first', () => {
    const r = selectExplicitDownloadTarget({ explicitAssetId: 'zz', candidates: [], projectId: 'p1' });
    expect(r.status).toBe('not_found');
  });
  it('no explicit id with unordered multiples is ambiguous and blocks', () => {
    const cands = [
      { id: 'u1', title: 'a.png', kind: 'image', projectId: 'p1' },
      { id: 'u2', title: 'b.png', kind: 'image', projectId: 'p1' },
    ];
    expect(selectExplicitDownloadTarget({ candidates: cands, projectId: 'p1', kind: 'image' }).status).toBe('ambiguous');
  });
  it('documents the actual asset menu format', () => {
    expect(ASSET_MENU_STEPS.join(' ')).toMatch(/More/);
    expect(ASSET_MENU_STEPS.join(' ')).toMatch(/Download/);
  });
});

describe('W04 download byte verification is complete, not filename alone', () => {
  it('real JPEG bytes verify with hash', () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
    const r = verifySavedDownload({ bytes: jpg, expectedKind: 'image', savedPath: '/tmp/x.jpg' });
    expect(r.verified).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('HTML error body never verifies', () => {
    const r = verifySavedDownload({ bytes: Buffer.from('<html>nope</html>'), expectedKind: 'image', savedPath: '/tmp/x.jpg' });
    expect(r.verified).toBe(false);
  });
});
