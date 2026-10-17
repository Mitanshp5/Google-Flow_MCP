// W09 independent local candidate media lane.
// Real decoded local image validation -> immutable retention -> labelled sheet.
// Synthetic/local fixtures only. No Flow generation, no remote media URLs.
// Only png/jpeg/webp single stills. Filename extension is never media truth.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import { FlowError } from '../utils/errors.js';
import { MAX_LOCAL_BYTES, sha256Hex, verifyDownloadedBytes } from '../assets/catalog.js';
// Reuse the single accepted containment + lock implementations. This lane owns
// no parallel containment/policy stack and never modifies store.js.
import { assertDirContained, assertFileContained } from '../script/store.js';
import { acquireLock } from '../storage/runtime-store.js';

export const W09_MAX_LOCAL_BYTES = MAX_LOCAL_BYTES;
export const W09_MAX_PIXELS = 64 * 1024 * 1024;
export const W09_MAX_DIMENSION = 16384;
export const W09_ASPECT_TOLERANCE = 0.01;
// Absolute ceilings: caller overrides can tighten but never loosen these.
export const W09_MAX_BYTES_CAP = 100 * 1024 * 1024;
export const W09_MAX_TIMEOUT_MS = 120000;
export const W09_ALLOWED_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const W09_MIME_TO_EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });

function runTool(cmd, args, { timeoutMs = 15000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { shell: false, timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new FlowError('MEDIA_TOOL_MISSING', `required local tool missing in PATH: ${cmd}`, { tool: cmd }));
          return;
        }
        if (err.killed || /timed out|ETIMEDOUT/i.test(String(err.message))) {
          reject(new FlowError('MEDIA_TIMEOUT', `local media tool timed out: ${cmd}`, { tool: cmd, timeoutMs }));
          return;
        }
        reject(new FlowError('MEDIA_DECODE_FAILED', `local media tool failed: ${cmd}: ${String(stderr || err.message).slice(0, 500)}`, {
          tool: cmd,
          exitCode: err.code ?? null,
          stderr: String(stderr || '').slice(0, 1000),
        }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Scoped stdin transport: feeds the SAME frozen snapshot bytes to the actual
// tool over pipe:0 (array args, shell:false, bounded time/output). The tool
// never receives a path — no live re-read, no network-protocol input surface.
// (execFile `input:` hangs ffprobe/pipe:0 on this toolchain; explicit spawn
// with manual stdin write + end is used instead.)
function runToolStdin(cmd, args, bytes, { timeoutMs = 15000, maxStdout = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child = null;
    try {
      child = spawn(cmd, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new FlowError('MEDIA_TOOL_MISSING', `required local tool missing in PATH: ${cmd}`, { tool: cmd }));
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch { /* ignore */ }
      fail(new FlowError('MEDIA_TIMEOUT', `local media tool timed out: ${cmd}`, { tool: cmd, timeoutMs }));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', (e) => {
      if (e?.code === 'ENOENT') {
        fail(new FlowError('MEDIA_TOOL_MISSING', `required local tool missing in PATH: ${cmd}`, { tool: cmd }));
      } else {
        fail(new FlowError('MEDIA_DECODE_FAILED', `local media tool failed to start: ${cmd}: ${e?.message || e}`, { tool: cmd, error: e?.message || String(e) }));
      }
    });
    const chunks = [];
    let outBytes = 0;
    child.stdout.on('data', (c) => {
      outBytes += c.length;
      if (outBytes > maxStdout) {
        try {
          child.kill('SIGTERM');
        } catch { /* ignore */ }
        fail(new FlowError('MEDIA_PROBE_FAILED', `local media tool output exceeded bound: ${cmd}`, { tool: cmd }));
        return;
      }
      chunks.push(c);
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      if (stderr.length < 4000) stderr += c.toString('utf8').slice(0, 4000 - stderr.length);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr });
      } else {
        reject(new FlowError('MEDIA_DECODE_FAILED', `local media tool failed: ${cmd} (exit ${code}): ${stderr.slice(0, 500)}`, {
          tool: cmd,
          exitCode: code,
          stderr: stderr.slice(0, 1000),
        }));
      }
    });
    try {
      // EPIPE when the tool exits early on bad input is fine: exit code decides.
      child.stdin.on('error', () => {});
      child.stdin.write(bytes);
      child.stdin.end();
    } catch (e) {
      fail(new FlowError('MEDIA_DECODE_FAILED', `local media tool stdin failed: ${cmd}: ${e.message}`, { tool: cmd, error: e.message }));
    }
  });
}

function assertResourceBounds({ maxBytes, timeoutMs }) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > W09_MAX_BYTES_CAP) {
    throw new FlowError('INVALID_PARAMS', `maxBytes must be a finite positive byte bound (<= ${W09_MAX_BYTES_CAP}): ${maxBytes}`, { maxBytes });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > W09_MAX_TIMEOUT_MS) {
    throw new FlowError('INVALID_PARAMS', `timeoutMs must be a finite positive timeout (<= ${W09_MAX_TIMEOUT_MS}ms): ${timeoutMs}`, { timeoutMs });
  }
}

// Some FFmpeg builds recognize WebP but cannot count animated WebP frames.
// Reject a well-formed animation container from the SAME frozen bytes before
// invoking the decoder. This never accepts a still or replaces full decoding.
export function hasWebpAnimation(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  const end = bytes.readUInt32LE(4) + 8;
  if (end !== bytes.length) return false;
  let animated = false;
  let offset = 12;
  while (offset + 8 <= end) {
    const tag = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + size + (size % 2);
    if (next > end) return false;
    if (tag === 'ANIM' || tag === 'ANMF'
      || (tag === 'VP8X' && size === 10 && (bytes[offset + 8] & 0x02))) animated = true;
    offset = next;
  }
  return offset === end && animated;
}

// Local path identity: file: URLs resolve via fileURLToPath (correct drive
// letters and percent escapes); remote file hosts and UNC network paths are
// rejected (no network reads/uploads). Literal paths are used EXACTLY as
// supplied — never trim-repaired into a different file identity.
function toLocalPath(file) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new FlowError('MEDIA_NOT_FOUND', 'probeImage requires a non-empty local file path', { file });
  }
  if (/^file:/i.test(file)) {
    let host = '';
    try {
      host = new URL(file).hostname.toLowerCase();
    } catch {
      throw new FlowError('MEDIA_URL_REJECTED', 'unparseable file: URL', { file: String(file).slice(0, 200) });
    }
    if (host !== '' && host !== 'localhost') {
      throw new FlowError('MEDIA_URL_REJECTED', 'file: URLs with remote hosts are never accepted (no network reads)', {
        file: String(file).slice(0, 200), host,
      });
    }
    let local = '';
    try {
      local = fileURLToPath(file);
    } catch {
      throw new FlowError('MEDIA_URL_REJECTED', 'unparseable file: URL', { file: String(file).slice(0, 200) });
    }
    if (local.startsWith('\\\\')) {
      throw new FlowError('MEDIA_URL_REJECTED', 'UNC network paths are never accepted (no network reads)', {
        file: String(file).slice(0, 200),
      });
    }
    return local;
  }
  // Windows drive-letter paths (C:\, C:/) are local, not URL schemes.
  if (/^[a-zA-Z]:[\\/]/.test(file)) return file;
  if (file.startsWith('\\\\')) {
    throw new FlowError('MEDIA_URL_REJECTED', 'UNC network paths are never accepted (no network reads)', {
      file: file.slice(0, 200),
    });
  }
  const scheme = file.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme) {
    throw new FlowError('MEDIA_URL_REJECTED', `remote media URLs are never accepted: ${scheme[1].toLowerCase()}:`, {
      file: file.slice(0, 200), protocol: scheme[1].toLowerCase(),
    });
  }
  return file;
}

function normalizeRatio(expectedRatio) {
  if (expectedRatio === null || expectedRatio === undefined) return null;
  if (typeof expectedRatio === 'number' && Number.isFinite(expectedRatio) && expectedRatio > 0) return expectedRatio;
  if (typeof expectedRatio === 'string') {
    const m = expectedRatio.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > 0 && h > 0) return w / h;
    }
    const n = Number(expectedRatio);
    if (Number.isFinite(n) && n > 0) return n;
    throw new FlowError('INVALID_PARAMS', `expectedRatio must be a positive number or "W:H": ${expectedRatio}`, { expectedRatio });
  }
  if (typeof expectedRatio === 'object' && expectedRatio !== null) {
    const w = Number(expectedRatio.width ?? expectedRatio.w);
    const h = Number(expectedRatio.height ?? expectedRatio.h);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
    throw new FlowError('INVALID_PARAMS', 'expectedRatio object requires positive width/height', { expectedRatio });
  }
  throw new FlowError('INVALID_PARAMS', 'expectedRatio must be a positive number or "W:H"', { expectedRatio });
}

// Agreed API: probe real local image bytes via signature + ffprobe + ffmpeg decode.
// The frozen bounded snapshot is hashed, then the SAME bytes are fed to both
// tools over stdin — digest and dimensions always describe the exact bytes.
export async function probeImage(file, { minWidth = 1, minHeight = 1, expectedRatio = null, maxBytes = W09_MAX_LOCAL_BYTES, timeoutMs = 15000 } = {}) {
  assertResourceBounds({ maxBytes, timeoutMs });
  if (!Number.isInteger(minWidth) || !Number.isInteger(minHeight) || minWidth < 1 || minHeight < 1) {
    throw new FlowError('INVALID_PARAMS', 'minWidth/minHeight must be positive integers', { minWidth, minHeight });
  }
  const localPath = toLocalPath(file);
  let stat;
  try {
    stat = fs.statSync(localPath);
  } catch (e) {
    throw new FlowError('MEDIA_NOT_FOUND', `local image not found: ${localPath}`, { file: localPath, error: e.message });
  }
  if (!stat.isFile()) {
    throw new FlowError('MEDIA_NOT_FOUND', `local image is not a regular file: ${localPath}`, { file: localPath });
  }
  if (stat.size <= 0) {
    throw new FlowError('MEDIA_EMPTY', `local image is empty: ${localPath}`, { file: localPath });
  }
  if (stat.size > maxBytes) {
    throw new FlowError('MEDIA_TOO_LARGE', `local image exceeds ${maxBytes} bytes: ${stat.size}`, { file: localPath, size: stat.size, maxBytes });
  }

  // Validate size before reading; read bounded bytes.
  const bytes = fs.readFileSync(localPath);
  if (bytes.length !== stat.size) {
    throw new FlowError('MEDIA_SOURCE_MUTATED', 'source file mutated between stat and read; refusing to probe', { file: localPath });
  }
  if (bytes.length > maxBytes) {
    throw new FlowError('MEDIA_TOO_LARGE', `local image exceeds ${maxBytes} bytes`, { file: localPath, size: bytes.length, maxBytes });
  }
  const verified = verifyDownloadedBytes({ bytes, expectedKind: 'image' });
  if (!verified.ok) {
    const code = /html/i.test(verified.reason || '') ? 'MEDIA_HTML_REJECTED' : 'MEDIA_UNRECOGNIZED';
    throw new FlowError(code, `local bytes are not a verifiable image: ${verified.reason}`, {
      file: localPath, size: bytes.length, mime: verified.mime ?? null,
    });
  }
  if (!W09_ALLOWED_MIMES.includes(verified.mime)) {
    throw new FlowError('MEDIA_KIND_MISMATCH', `single-image formats png/jpeg/webp only; observed ${verified.mime}`, {
      file: localPath, mime: verified.mime,
    });
  }
  const hash = sha256Hex(bytes);
  const size = bytes.length;
  const mime = verified.mime;
  const ext = W09_MIME_TO_EXT[mime];

  if (mime === 'image/webp' && hasWebpAnimation(bytes)) {
    throw new FlowError('MEDIA_MULTI_FRAME', 'animated WebP container rejected; exactly one still required', {
      file: localPath, codec: 'webp', evidence: 'RIFF animation chunks',
    });
  }

  // Real probe over the SAME frozen bytes: single video stream, exactly one
  // counted frame (full decode via -count_frames), then a full-file ffmpeg
  // decode with -xerror. Missing frame counts are never proof of single still.
  const ffArgs = [
    '-v', 'error',
    '-protocol_whitelist', 'pipe',
    '-count_frames',
    '-show_entries', 'stream=width,height,codec_name,nb_read_frames:stream_tags=rotate,orientation',
    '-show_entries', 'format=format_name',
    '-of', 'json',
    'pipe:0',
  ];
  let probeJson;
  try {
    const { stdout } = await runToolStdin('ffprobe', ffArgs, bytes, { timeoutMs });
    if (stdout.length > 256 * 1024) {
      throw new FlowError('MEDIA_PROBE_FAILED', 'ffprobe output exceeded bound', { file: localPath });
    }
    probeJson = JSON.parse(stdout);
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError('MEDIA_PROBE_FAILED', `ffprobe could not parse image: ${e.message}`, { file: localPath, error: e.message });
  }
  const streams = Array.isArray(probeJson?.streams) ? probeJson.streams : [];
  if (streams.length !== 1) {
    throw new FlowError('MEDIA_PROBE_FAILED', `expected exactly one stream; observed ${streams.length}`, { file: localPath });
  }
  const stream = streams[0];
  if (stream.nb_read_frames === undefined || stream.nb_read_frames === null) {
    throw new FlowError('MEDIA_PROBE_FAILED', 'frame count unverifiable; refusing to assume a single still', { file: localPath });
  }
  if (String(stream.nb_read_frames) !== '1') {
    throw new FlowError('MEDIA_MULTI_FRAME', `animated/multi-frame image rejected; exactly one still required (frames: ${stream.nb_read_frames})`, {
      file: localPath, frames: String(stream.nb_read_frames), codec: stream.codec_name ?? 'unknown',
    });
  }
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new FlowError('MEDIA_PROBE_FAILED', 'ffprobe reported non-positive dimensions', { file: localPath, width, height });
  }
  if (width > W09_MAX_DIMENSION || height > W09_MAX_DIMENSION) {
    throw new FlowError('MEDIA_TOO_LARGE', `image dimensions exceed ${W09_MAX_DIMENSION}px bound`, { file: localPath, width, height });
  }
  const pixels = width * height;
  if (pixels > W09_MAX_PIXELS) {
    throw new FlowError('MEDIA_TOO_LARGE', `image pixel count exceeds bomb bound (${pixels} > ${W09_MAX_PIXELS})`, { file: localPath, width, height, pixels });
  }
  // Full-file decode with -xerror over the same frozen bytes: rejects
  // truncated/signature-only/corrupt data (first-frame-only is not enough).
  await runToolStdin('ffmpeg', ['-xerror', '-v', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-f', 'null', '-'], bytes, { timeoutMs, maxStdout: 1024 * 1024 });
  const tags = stream.tags || {};
  const orientation = tags.rotate ?? tags.orientation ?? 'unknown';

  if (width < minWidth || height < minHeight) {
    throw new FlowError('MEDIA_DIMENSIONS_TOO_SMALL', `image ${width}x${height} below minimum ${minWidth}x${minHeight}`, {
      file: localPath, width, height, minWidth, minHeight,
    });
  }
  const wantRatio = normalizeRatio(expectedRatio);
  const measuredRatio = width / height;
  if (wantRatio !== null) {
    const rel = Math.abs(measuredRatio - wantRatio) / wantRatio;
    if (rel > W09_ASPECT_TOLERANCE) {
      throw new FlowError('MEDIA_ASPECT_MISMATCH', `aspect ${measuredRatio.toFixed(4)} differs from expected ${wantRatio.toFixed(4)} beyond tolerance ${W09_ASPECT_TOLERANCE}`, {
        file: localPath, width, height, measuredRatio, expectedRatio: wantRatio, tolerance: W09_ASPECT_TOLERANCE,
      });
    }
  }

  return {
    hash, size, mime, ext, width, height,
    orientation, format: probeJson?.format?.format_name ?? stream.codec_name ?? 'unknown',
    codec: stream.codec_name ?? 'unknown',
    pixels, ratio: measuredRatio, decoded: true,
  };
}

// ---- Durable promotion: fs lock + atomic no-replace link.
// Writers on one dest serialize on the accepted advisory lock (bounded wait);
// creation itself uses link (EEXIST on race) so a raced different target is
// never replaced. Lock files are task-owned temp, always released.
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDestLock(dest, fn, { tries = 200, delayMs = 10 } = {}) {
  let lock = null;
  for (let i = 0; ; i += 1) {
    try {
      lock = acquireLock(`${dest}.lock`);
      break;
    } catch (e) {
      if (e?.code !== 'LOCK_HELD' || i >= tries) throw e;
      await sleepMs(delayMs);
    }
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

let tmpCounter = 0;

function fsyncDirOf(file) {
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch { /* directory-entry durability is best-effort */ }
}

// Write-once exclusive promotion. Returns 'created' or 'identical'.
// Throws MEDIA_CONFLICT when dest holds different bytes; never overwrites.
function exclusivePromoteBytes(dest, bytes) {
  tmpCounter += 1;
  const tmp = `${dest}.${process.pid}.${Date.now()}.${tmpCounter}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, dest);
    } catch (e) {
      if (!fs.existsSync(dest)) throw e;
      // A concurrent writer won the race: compare, never replace.
      const existing = fs.readFileSync(dest);
      if (existing.equals(bytes)) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch { /* ignore */ }
        return 'identical';
      }
      throw new FlowError('MEDIA_CONFLICT', 'promotion raced a different target; refusing to overwrite', { file: dest });
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* ignore */ }
    fsyncDirOf(dest);
    return 'created';
  } catch (e) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch { /* ignore */ }
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* ignore */ }
    if (e instanceof FlowError) throw e;
    throw new FlowError('STORAGE_IO_ERROR', `durable write failed (original preserved): ${dest}`, { file: dest, error: e.message });
  }
}

// Agreed API: immutable content-addressed retention of original probed bytes.
export async function retainImage(file, { assetsDir, root, minWidth = 1, minHeight = 1, expectedRatio = null, maxBytes = W09_MAX_LOCAL_BYTES, timeoutMs = 15000 } = {}) {
  if (typeof assetsDir !== 'string' || !assetsDir.trim() || typeof root !== 'string' || !root.trim()) {
    throw new FlowError('INVALID_PARAMS', 'retainImage requires assetsDir and root', { assetsDir, root });
  }
  assertResourceBounds({ maxBytes, timeoutMs });
  const resolvedAssets = path.resolve(assetsDir);
  const resolvedRoot = path.resolve(root);
  // Containment BEFORE any read/mkdir/write side effect.
  assertDirContained(resolvedAssets, resolvedRoot, 'candidate-assets');
  if (!fs.existsSync(resolvedAssets)) {
    fs.mkdirSync(resolvedAssets, { recursive: true });
  }
  assertDirContained(resolvedAssets, resolvedRoot, 'candidate-assets');

  const probe = await probeImage(file, { minWidth, minHeight, expectedRatio, maxBytes, timeoutMs });
  // Source-mutation guard: bounded stat, then the snapshot (not a re-read)
  // is what gets copied, and it must still match the probe exactly.
  const localPath = toLocalPath(file);
  let snapStat = null;
  try {
    snapStat = fs.statSync(localPath);
  } catch (e) {
    throw new FlowError('MEDIA_SOURCE_MUTATED', 'source vanished between probe and copy; refusing to retain', { file: localPath, error: e.message });
  }
  if (!snapStat.isFile() || snapStat.size !== probe.size || snapStat.size > maxBytes) {
    throw new FlowError('MEDIA_SOURCE_MUTATED', 'source file mutated between probe and copy; refusing to retain', { file: localPath });
  }
  const snapshot = fs.readFileSync(localPath);
  if (snapshot.length !== probe.size || sha256Hex(snapshot) !== probe.hash) {
    throw new FlowError('MEDIA_SOURCE_MUTATED', 'source file mutated between probe and copy; refusing to retain', { file: localPath });
  }
  const dest = path.join(resolvedAssets, `${probe.hash}.${probe.ext}`);
  assertFileContained(dest, resolvedRoot, 'candidate-assets');
  const done = (probeOut) => ({ hash: probe.hash, path: dest, size: probe.size, mime: probe.mime, ext: probe.ext, probe: probeOut ?? probe });
  return withDestLock(dest, () => {
    if (fs.existsSync(dest)) {
      const existing = fs.readFileSync(dest);
      if (existing.length === probe.size && sha256Hex(existing) === probe.hash) {
        const reverify = verifyDownloadedBytes({ bytes: existing, expectedKind: 'image' });
        if (!reverify.ok) {
          throw new FlowError('MEDIA_CONFLICT', 'existing retained bytes no longer verify; refusing to conflate', { file: dest, reason: reverify.reason });
        }
        return done();
      }
      throw new FlowError('MEDIA_CONFLICT', 'content-addressed target holds different bytes; refusing to overwrite', { file: dest });
    }
    exclusivePromoteBytes(dest, snapshot);
    return done();
  });
}

export function __w09Internals() {
  return { runTool, runToolStdin, toLocalPath, normalizeRatio };
}

export const W09_MAX_SHEET_CANDIDATES = 20;
export const W09_MAX_SHEET_TOTAL_BYTES = 100 * 1024 * 1024;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Derived thumbnail preview: boxed ≤320px JPEG bytes for inline display only,
// always labelled derived/local-preview, never the original. The 320x320 box
// with aspect decrease bounds tall/narrow inputs (320:-1 alone explodes).
function makePreviewDataUrl(absPath, timeoutMs) {
  return new Promise((resolve) => {
    execFile('ffmpeg',
      ['-xerror', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', absPath, '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-frames:v', '1', '-vcodec', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
      { shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err || !stdout || stdout.length === 0) {
          resolve(null);
          return;
        }
        resolve(`data:image/jpeg;base64,${Buffer.from(stdout).toString('base64')}`);
      });
  });
}

// Agreed API: labelled self-contained local contact sheet + versioned manifest.
// Each sheet is immutable history: a unique full-UUID review directory holding
// a write-once sheet/manifest pair, digest-bound. Re-running never overwrites
// an approved review; the domain lane persists the returned handle.
// Verifies each original (containment, hash, real decode) BEFORE display.
// No scoring, no JS, no remote URLs. Base64 previews are derived, not originals.
export async function createContactSheet(candidates, { outputDir, root, title = 'Candidate review', maxCandidates = W09_MAX_SHEET_CANDIDATES, maxTotalBytes = W09_MAX_SHEET_TOTAL_BYTES, maxBytes = W09_MAX_LOCAL_BYTES, timeoutMs = 15000 } = {}) {
  assertResourceBounds({ maxBytes, timeoutMs });
  if (typeof outputDir !== 'string' || !outputDir.trim() || typeof root !== 'string' || !root.trim()) {
    throw new FlowError('INVALID_PARAMS', 'createContactSheet requires outputDir and root', { outputDir, root });
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new FlowError('INVALID_PARAMS', 'createContactSheet requires at least one candidate', { count: Array.isArray(candidates) ? candidates.length : null });
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) {
    throw new FlowError('INVALID_PARAMS', 'maxCandidates must be a positive integer', { maxCandidates });
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new FlowError('INVALID_PARAMS', 'maxTotalBytes must be a finite positive byte bound', { maxTotalBytes });
  }
  // Absolute ceilings hold regardless of caller overrides (overrides tighten only).
  const effectiveMaxCandidates = Math.min(maxCandidates, W09_MAX_SHEET_CANDIDATES);
  const effectiveMaxTotalBytes = Math.min(maxTotalBytes, W09_MAX_SHEET_TOTAL_BYTES);
  if (candidates.length > effectiveMaxCandidates) {
    throw new FlowError('MEDIA_SHEET_LIMIT', `candidate count ${candidates.length} exceeds absolute cap ${effectiveMaxCandidates}`, { count: candidates.length, maxCandidates: effectiveMaxCandidates });
  }
  const resolvedOut = path.resolve(outputDir);
  const resolvedRoot = path.resolve(root);
  // Containment BEFORE any read/mkdir/write side effect.
  assertDirContained(resolvedOut, resolvedRoot, 'candidate-reviews');

  const seenIds = new Set();
  for (const c of candidates) {
    if (!c || typeof c.candidateId !== 'string' || !c.candidateId.trim()) {
      throw new FlowError('INVALID_PARAMS', 'each candidate requires a non-empty candidateId', { candidateId: c?.candidateId ?? null });
    }
    if (seenIds.has(c.candidateId)) {
      throw new FlowError('INVALID_PARAMS', `duplicate candidateId in one sheet: ${c.candidateId}`, { candidateId: c.candidateId });
    }
    seenIds.add(c.candidateId);
    if (typeof c.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(c.hash)) {
      throw new FlowError('INVALID_PARAMS', 'each candidate requires a full 64-hex sha256 hash', { candidateId: c.candidateId });
    }
    // SOURCE provenance is explicit per candidate and never defaulted: later
    // actual originals arrive as local_import/Flow-derived, fixtures as
    // synthetic-local-fixture. The sheet must not hardcode one for all inputs.
    if (typeof c.provenance !== 'string' || !c.provenance.trim()) {
      throw new FlowError('INVALID_PARAMS', 'each candidate requires an explicit SOURCE provenance', { candidateId: c.candidateId });
    }
  }

  // Verify every original BEFORE any sheet/manifest write.
  const verified = [];
  let totalBytes = 0;
  for (const c of candidates) {
    const absPath = path.resolve(c.path);
    assertFileContained(absPath, resolvedRoot, 'candidate-reviews');
    const probe = await probeImage(absPath, { maxBytes, timeoutMs });
    if (probe.hash.toLowerCase() !== String(c.hash).toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `candidate bytes do not match claimed hash: ${c.candidateId}`, { candidateId: c.candidateId });
    }
    totalBytes += probe.size;
    verified.push({ input: c, absPath, probe });
  }
  if (totalBytes > effectiveMaxTotalBytes) {
    throw new FlowError('MEDIA_SHEET_LIMIT', `sheet total bytes ${totalBytes} exceeds absolute cap ${effectiveMaxTotalBytes}`, { totalBytes, maxTotalBytes: effectiveMaxTotalBytes });
  }

  // Verified originals only from here on; directories are prepared
  // alongside the immutable review pair below (history preserved on failure).
  const figures = [];
  const manifestCandidates = [];
  const emittedActives = [];
  for (const { input, absPath, probe } of verified) {
    const previewUrl = await makePreviewDataUrl(absPath, timeoutMs);
    // Read-back: the immutable full-size original must be unchanged after derivation.
    const afterDerivation = fs.readFileSync(absPath);
    if (afterDerivation.length !== probe.size || sha256Hex(afterDerivation) !== probe.hash) {
      throw new FlowError('MEDIA_SOURCE_MUTATED', `retained original changed during preview derivation: ${input.candidateId}`, { candidateId: input.candidateId });
    }
    const fileUrl = pathToFileURL(absPath).href;
    emittedActives.push(fileUrl);
    if (previewUrl) emittedActives.push(previewUrl);
    const label = input.label ?? '';
    const provenance = input.provenance;
    manifestCandidates.push({
      candidateId: input.candidateId, hash: probe.hash, path: absPath,
      size: probe.size, mime: probe.mime, ext: probe.ext,
      width: probe.width, height: probe.height,
      label, provenance,
    });
    figures.push(
      `<figure>\n` +
      `<figcaption>candidate <b>${escapeHtml(input.candidateId)}</b> — ${escapeHtml(label)}<br>` +
      `hash <code>${escapeHtml(probe.hash)}</code><br>` +
      `full-size original: <code>${escapeHtml(absPath)}</code> ` +
      `<a href="${escapeHtml(fileUrl)}">open local full-size original</a><br>` +
      `${probe.width}x${probe.height} ${escapeHtml(probe.mime)} provenance: ${escapeHtml(provenance)}</figcaption>\n` +
      (previewUrl
        ? `<img src="${previewUrl}" alt="derived local preview for ${escapeHtml(input.candidateId)} — NOT the original">\n<p>derived local preview — NOT the original. Judge from the full-size original link above.</p>`
        : `<p>derived local preview unavailable — see the full-size original link above (NOT the original).</p>`) +
      `\n</figure>`
    );
  }
  const safeTitle = escapeHtml(title);
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline';";
  const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<title>${safeTitle}</title>\n` +
    `<style>body{font-family:sans-serif;max-width:960px;margin:auto}figure{border:1px solid #999;padding:8px}img{max-width:100%}.provenance{background:#ffe;border:1px solid #990;padding:8px}</style>\n` +
    `</head>\n<body>\n<h1>${safeTitle}</h1>\n` +
    `<p class="provenance">Local candidate review aid. NOT Flow-generated acceptance. ` +
    `Base64 thumbnails below are derived local previews — NOT the originals. Each candidate lists its retained SOURCE provenance explicitly. ` +
    `No automatic scoring is applied; selection is a manual/client decision. Review each full-size original via its local link.</p>\n` +
    `${figures.join('\n')}\n</body>\n</html>\n`;
  // Active content allowlist: the sheet may only load local file: targets and
  // inline data: previews. Escaped user TEXT containing https is harmless data
  // and stays; only loaded URLs are constrained.
  for (const u of emittedActives) {
    if (!u.startsWith('file:') && !u.startsWith('data:')) {
      throw new FlowError('MEDIA_SHEET_LIMIT', 'sheet must not load remote content', {});
    }
  }
  const htmlBytes = Buffer.from(html, 'utf8');
  const sheetHash = sha256Hex(htmlBytes);
  const reviewId = crypto.randomUUID();
  const reviewDir = path.join(resolvedOut, reviewId);
  try {
    if (!fs.existsSync(resolvedOut)) {
      fs.mkdirSync(resolvedOut, { recursive: true });
    }
    assertDirContained(resolvedOut, resolvedRoot, 'candidate-reviews');
    fs.mkdirSync(reviewDir, { recursive: true });
    assertDirContained(reviewDir, resolvedRoot, 'candidate-reviews');
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError('STORAGE_IO_ERROR', `cannot prepare immutable review directory (approved history preserved): ${reviewDir}`, { file: reviewDir, error: e.message });
  }
  const sheetPath = path.join(reviewDir, 'contact-sheet.html');
  const manifestPath = path.join(reviewDir, 'contact-sheet.manifest.json');
  assertFileContained(sheetPath, resolvedRoot, 'candidate-reviews');
  assertFileContained(manifestPath, resolvedRoot, 'candidate-reviews');
  const manifest = {
    v: 1, reviewId, title, createdAt: new Date().toISOString(),
    provenance: 'local review aid — NOT Flow-generated acceptance; per-candidate SOURCE provenance recorded per entry',
    sheetFile: 'contact-sheet.html', sheetHash,
    candidates: manifestCandidates,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  // Children complete before the returned handle; write-once, never overwrite.
  await withDestLock(sheetPath, () => exclusivePromoteBytes(sheetPath, htmlBytes));
  await withDestLock(manifestPath, () => exclusivePromoteBytes(manifestPath, manifestBytes));
  return {
    reviewId, path: sheetPath, manifestPath, hash: sheetHash,
    candidates: manifestCandidates.map((m) => ({ ...m })),
  };
}
