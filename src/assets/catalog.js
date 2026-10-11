// W04 asset/reference lane — stable local/remote asset mapping, import
// validation, byte/signature/hash verification, explicit newest selection.
// Pure Node (no browser/CDP). Browser adapters live in
// src/browser/upload.js + src/browser/composer-state.js.
import { createHash } from 'crypto';

export const MAX_LOCAL_BYTES = 25 * 1024 * 1024;
const LOCAL_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

export function normalizeTitle(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

function normEq(a, b) {
  return normalizeTitle(a).toLowerCase() === normalizeTitle(b).toLowerCase();
}

// Exact title/asset identity. Never substring, never first-word fallback.
// available: [{title, assetId?, id?, kind?}]
export function resolveMentionTarget(requested, available = []) {
  const want = normalizeTitle(requested);
  if (!want) return { status: 'not_found', requested: want, candidates: [] };
  const hits = (Array.isArray(available) ? available : []).filter(
    (a) => a && typeof a.title === 'string' && normEq(a.title, want)
  );
  if (hits.length === 0) return { status: 'not_found', requested: want, candidates: [] };
  if (hits.length > 1) return { status: 'ambiguous', requested: want, candidates: hits };
  const hit = hits[0];
  return {
    status: 'matched',
    requested: want,
    asset: { title: hit.title, assetId: hit.assetId ?? hit.id ?? null, kind: hit.kind ?? null },
  };
}

// Detects the forbidden first-word fallback: actual holds only the head word.
export function isFirstWordOnlyMatch(requested, actualText) {
  const want = normalizeTitle(requested);
  const actual = normalizeTitle(actualText);
  if (!want || !actual) return false;
  if (normEq(want, actual)) return false;
  const head = want.split(' ')[0];
  return head.length > 2 && actual.toLowerCase() === head.toLowerCase();
}

export function validateLocalImport({ absPath = '', sizeBytes = 0, ext = '' } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof absPath !== 'string' || !absPath.trim()) return fail('empty path');
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return fail('empty file');
  if (sizeBytes > MAX_LOCAL_BYTES) return fail('file exceeds 25MB');
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (!LOCAL_IMAGE_EXTS.has(e)) return fail(`unsupported extension "${ext}"`);
  return { ok: true, reason: 'valid' };
}

export function sha256Hex(bytes) {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return createHash('sha256').update(buf).digest('hex');
}

// Byte-signature detection — filename extension is never truth.
export function detectMediaSignature(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png', kind: 'image' };
  }
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp', kind: 'image' };
  }
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  }
  const head = b.slice(0, 64).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<html') || head.startsWith('<!doctype') || head.includes('<html')) {
    return { mime: 'text/html', ext: null, kind: 'error-body' };
  }
  return { mime: 'application/octet-stream', ext: null, kind: 'unknown' };
}

// Verify actual saved bytes: signature + size + hash. Complete, not filename.
export function verifyDownloadedBytes({ bytes, expectedKind = null } = {}) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length === 0) return { ok: false, reason: 'empty download', size: 0, hash: null, mime: null };
  const sig = detectMediaSignature(b);
  if (sig.kind === 'error-body' || sig.kind === 'unknown') {
    return { ok: false, reason: `unrecognized bytes (${sig.mime})`, size: b.length, hash: sha256Hex(b), mime: sig.mime };
  }
  if (expectedKind && sig.kind !== expectedKind) {
    return { ok: false, reason: `kind mismatch: bytes are ${sig.kind}, expected ${expectedKind}`, size: b.length, hash: sha256Hex(b), mime: sig.mime };
  }
  return { ok: true, reason: 'verified', size: b.length, hash: sha256Hex(b), mime: sig.mime, ext: sig.ext, kind: sig.kind };
}

export function buildLocalRecord({ absPath = '', hash = null, sizeBytes = 0, mime = null } = {}) {
  if (!absPath || !hash || !sizeBytes) return { ok: false, reason: 'local import requires path+hash+size' };
  return { ok: true, record: { kind: 'local_import', absPath, hash, sizeBytes, mime, validated: true } };
}

// Remote records must carry account/project identity — never title alone.
export function buildRemoteRecord({ assetId = null, title = '', kind = null, account = null, projectId = null } = {}) {
  if (!assetId) return { ok: false, reason: 'remote record requires stable asset id' };
  if (!title) return { ok: false, reason: 'remote record requires title' };
  if (!account) return { ok: false, reason: 'remote record requires account identity' };
  if (!projectId) return { ok: false, reason: 'remote record requires project identity' };
  return { ok: true, record: { kind: kind || 'remote', assetId, title, account, projectId } };
}

// Explicit newest-eligible mapping. Ambiguous latest blocks — never first.
export function selectNewestEligible(assets = [], { projectId = null, kind = null } = {}) {
  const list = (Array.isArray(assets) ? assets : []).filter(
    (a) => a && (!projectId || a.projectId === projectId) && (!kind || a.kind === kind)
  );
  if (list.length === 0) return { status: 'not_found', reason: 'no eligible assets', choices: [] };
  if (list.length === 1) return { status: 'selected', asset: list[0] };
  const withTime = list.filter((a) => Number.isFinite(a.createdAtMs));
  if (withTime.length === 0) {
    return { status: 'ambiguous', reason: 'multiple eligible assets without ordering identity', choices: list };
  }
  // Only timestamped assets participate in newest ordering; untimestamped
  // peers make the choice ambiguous rather than silently ignored.
  if (withTime.length !== list.length) {
    return { status: 'ambiguous', reason: 'partial ordering identity', choices: list };
  }
  const max = Math.max(...withTime.map((a) => a.createdAtMs));
  const top = withTime.filter((a) => a.createdAtMs === max);
  if (top.length !== 1) return { status: 'ambiguous', reason: 'tied newest timestamps', choices: top };
  return { status: 'selected', asset: top[0] };
}

// Signed-URL expiry / incomplete / failure — never fabricates an identity.
export function classifyDownloadError(err) {
  const msg = String(err?.message || err || '');
  if (/expir/i.test(msg)) return { code: 'SIGNED_URL_EXPIRED', message: msg, assetId: null, retryable: 'reacquire' };
  if (/incomplete|truncat|chunked|ERR_INCOMPLETE|ECONNRESET|EPIPE/i.test(msg)) {
    return { code: 'DOWNLOAD_INCOMPLETE', message: msg, assetId: null, retryable: 'reacquire' };
  }
  return { code: 'DOWNLOAD_FAILED', message: msg, assetId: null, retryable: 'manual' };
}
