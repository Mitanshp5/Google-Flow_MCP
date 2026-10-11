import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  resolveMentionTarget,
  isFirstWordOnlyMatch,
  validateLocalImport,
  sha256Hex,
  detectMediaSignature,
  verifyDownloadedBytes,
  buildLocalRecord,
  buildRemoteRecord,
  selectNewestEligible,
  classifyDownloadError,
} from '../src/assets/catalog.js';

// W04 slice 1 — asset identity, local validation+hash, byte/signature/hash
// verification, explicit newest mapping, ambiguous blocks, no fabricated
// identity. Pure headless tests, no browser/CDP/uploads.
describe('W04 catalog normalizeTitle', () => {
  it('trims and collapses whitespace, keeps full title', () => {
    expect(normalizeTitle('  qa-reference.png  ')).toBe('qa-reference.png');
    expect(normalizeTitle('Cow   in  space')).toBe('Cow in space');
  });
});

describe('W04 catalog resolveMentionTarget exact identity', () => {
  const avail = [
    { title: 'qa-reference.png', assetId: 'a1', kind: 'image' },
    { title: 'Cow in space', assetId: 'a2', kind: 'image' },
    { title: 'Cow in space suit', assetId: 'a3', kind: 'image' },
  ];
  it('matches exact full title', () => {
    const r = resolveMentionTarget('Cow in space', avail);
    expect(r.status).toBe('matched');
    expect(r.asset.assetId).toBe('a2');
  });
  it('never falls back to first-word match', () => {
    // "Cow" alone must NOT match "Cow in space".
    const r = resolveMentionTarget('Cow', avail);
    expect(r.status).toBe('not_found');
  });
  it('substring/prefix alone is not_found, not first row', () => {
    const r = resolveMentionTarget('Cow in', avail);
    expect(r.status).toBe('not_found');
  });
  it('duplicate exact titles are ambiguous, never first', () => {
    const dup = [...avail, { title: 'Cow in space', assetId: 'a9', kind: 'image' }];
    const r = resolveMentionTarget('Cow in space', dup);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
  });
  it('isFirstWordOnlyMatch flags the forbidden fallback', () => {
    expect(isFirstWordOnlyMatch('Cow in space', 'Cow')).toBe(true);
    expect(isFirstWordOnlyMatch('Cow in space', 'Cow in space')).toBe(false);
  });
});

describe('W04 catalog local import validation + hash', () => {
  it('accepts png/jpg/webp within 25MB', () => {
    expect(validateLocalImport({ absPath: '/tmp/a.png', sizeBytes: 100, ext: 'png' }).ok).toBe(true);
    expect(validateLocalImport({ absPath: '/tmp/b.JPG', sizeBytes: 100, ext: 'JPG' }).ok).toBe(true);
  });
  it('rejects empty/missing/oversize/exe', () => {
    expect(validateLocalImport({ absPath: '', sizeBytes: 10, ext: 'png' }).ok).toBe(false);
    expect(validateLocalImport({ absPath: '/tmp/a.png', sizeBytes: 0, ext: 'png' }).ok).toBe(false);
    expect(validateLocalImport({ absPath: '/tmp/a.png', sizeBytes: 26 * 1024 * 1024, ext: 'png' }).ok).toBe(false);
    expect(validateLocalImport({ absPath: '/tmp/a.exe', sizeBytes: 10, ext: 'exe' }).ok).toBe(false);
  });
  it('sha256Hex is stable hex', () => {
    const h = sha256Hex(Buffer.from('abc'));
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('local record requires hash; remote record requires account+project identity', () => {
    expect(buildLocalRecord({ absPath: '/t/a.png', hash: null, sizeBytes: 5, mime: 'image/png' }).ok).toBe(false);
    expect(buildLocalRecord({ absPath: '/t/a.png', hash: 'ab12', sizeBytes: 5, mime: 'image/png' }).ok).toBe(true);
    expect(buildRemoteRecord({ assetId: 'm1', title: 't', kind: 'image', account: null, projectId: 'p1' }).ok).toBe(false);
    expect(buildRemoteRecord({ assetId: 'm1', title: 't', kind: 'image', account: 'u@x', projectId: 'p1' }).ok).toBe(true);
    expect(buildRemoteRecord({ assetId: null, title: 't', kind: 'image', account: 'u@x', projectId: 'p1' }).ok).toBe(false);
  });
});

describe('W04 catalog byte/signature/hash verification', () => {
  it('verifies real PNG/JPEG signatures, not filename alone', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 9)]);
    expect(detectMediaSignature(png).ext).toBe('png');
    expect(detectMediaSignature(jpg).ext).toBe('jpg');
    expect(verifyDownloadedBytes({ bytes: png, expectedKind: 'image' }).ok).toBe(true);
    expect(verifyDownloadedBytes({ bytes: png, expectedKind: 'image' }).hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects empty/HTML-error bodies and kind mismatch', () => {
    expect(verifyDownloadedBytes({ bytes: Buffer.alloc(0), expectedKind: 'image' }).ok).toBe(false);
    expect(verifyDownloadedBytes({ bytes: Buffer.from('<html>Error 404</html>'), expectedKind: 'image' }).ok).toBe(false);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)]);
    expect(verifyDownloadedBytes({ bytes: png, expectedKind: 'video' }).ok).toBe(false);
  });
});

describe('W04 catalog selectNewestEligible explicit mapping', () => {
  it('selects newest by createdAtMs within project+kind', () => {
    const assets = [
      { id: 'old', title: 'a.png', kind: 'image', projectId: 'p1', createdAtMs: 100 },
      { id: 'new', title: 'b.png', kind: 'image', projectId: 'p1', createdAtMs: 200 },
      { id: 'other-proj', title: 'c.png', kind: 'image', projectId: 'p2', createdAtMs: 999 },
    ];
    const r = selectNewestEligible(assets, { projectId: 'p1', kind: 'image' });
    expect(r.status).toBe('selected');
    expect(r.asset.id).toBe('new');
  });
  it('empty eligible set is not_found, never first-control fallback', () => {
    expect(selectNewestEligible([], { projectId: 'p1' }).status).toBe('not_found');
    expect(selectNewestEligible([{ id: 'x', kind: 'video', projectId: 'p1' }], { projectId: 'p1', kind: 'image' }).status).toBe('not_found');
  });
  it('unordered multi-asset without timestamps is ambiguous and blocks', () => {
    const assets = [
      { id: 'u1', title: 'a.png', kind: 'image', projectId: 'p1' },
      { id: 'u2', title: 'b.png', kind: 'image', projectId: 'p1' },
    ];
    const r = selectNewestEligible(assets, { projectId: 'p1', kind: 'image' });
    expect(r.status).toBe('ambiguous');
    expect(r.choices).toHaveLength(2);
  });
  it('tied newest timestamps are ambiguous', () => {
    const assets = [
      { id: 't1', kind: 'image', projectId: 'p1', createdAtMs: 500 },
      { id: 't2', kind: 'image', projectId: 'p1', createdAtMs: 500 },
    ];
    expect(selectNewestEligible(assets, { projectId: 'p1' }).status).toBe('ambiguous');
  });
});

describe('W04 catalog download error classification never fabricates identity', () => {
  it('maps expiry/incomplete/failure without asset id', () => {
    expect(classifyDownloadError(new Error('signed url expired')).code).toBe('SIGNED_URL_EXPIRED');
    expect(classifyDownloadError(new Error('net::ERR_INCOMPLETE_CHUNKED_ENCODING')).code).toBe('DOWNLOAD_INCOMPLETE');
    const c = classifyDownloadError(new Error('boom'));
    expect(c.code).toBe('DOWNLOAD_FAILED');
    expect(c.assetId).toBe(null);
  });
});
