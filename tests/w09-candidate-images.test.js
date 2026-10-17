// W09 local candidate media — vertical TDD. SYNTHETIC/LOCAL fixtures only.
// Cycle 1: probeImage decodes real local PNG/JPEG/WebP.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { probeImage, __w09Internals } from '../src/media/candidate-images.js';
import { ensureFixture } from './helpers/w09-image-fixtures.js';

describe('W09 C1 probeImage decodes real local images', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-c1-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('probes a real synthetic PNG with measured dimensions and hash', async () => {
    const png = await ensureFixture(dir, 'c1.png', { width: 64, height: 48, format: 'png', color: 'red' });
    const probe = await probeImage(png, { minWidth: 1, minHeight: 1, timeoutMs: 15000 });
    expect(probe.decoded).toBe(true);
    expect(probe.mime).toBe('image/png');
    expect(probe.ext).toBe('png');
    expect(probe.width).toBe(64);
    expect(probe.height).toBe(48);
    expect(probe.size).toBeGreaterThan(0);
    expect(probe.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('probes a real synthetic JPEG with measured dimensions', async () => {
    const jpg = await ensureFixture(dir, 'c1.jpg', { width: 80, height: 60, format: 'mjpeg', color: 'blue' });
    const probe = await probeImage(jpg, { timeoutMs: 15000 });
    expect(probe.decoded).toBe(true);
    expect(probe.mime).toBe('image/jpeg');
    expect(probe.width).toBe(80);
    expect(probe.height).toBe(60);
  });

  it('probes a real synthetic WebP with measured dimensions', async () => {
    const webp = await ensureFixture(dir, 'c1.webp', { width: 48, height: 32, format: 'webp', color: 'green' });
    const probe = await probeImage(webp, { timeoutMs: 15000 });
    expect(probe.decoded).toBe(true);
    expect(probe.mime).toBe('image/webp');
    expect(probe.width).toBe(48);
    expect(probe.height).toBe(32);
  });
});

describe('W09 C2 probeImage rejects bad bytes and enforces bounds', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-c2-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };

  it('rejects HTML error-body bytes, not as an image', async () => {
    const f = path.join(dir, 'err.png');
    fs.writeFileSync(f, '<html><body>expired</body></html>');
    expect(await codes(() => probeImage(f))).toMatch(/MEDIA_HTML_REJECTED|MEDIA_UNRECOGNIZED/);
  });

  it('rejects random corrupt bytes', async () => {
    const f = path.join(dir, 'corrupt.png');
    fs.writeFileSync(f, Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb]));
    expect(await codes(() => probeImage(f))).toBe('MEDIA_UNRECOGNIZED');
  });

  it('rejects PNG signature-only bytes (no invented verification)', async () => {
    const f = path.join(dir, 'sigonly.png');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const code = await codes(() => probeImage(f));
    expect(['MEDIA_PROBE_FAILED', 'MEDIA_DECODE_FAILED', 'MEDIA_UNRECOGNIZED']).toContain(code);
  });

  it('rejects truncated PNG bytes via real decode failure', async () => {
    const src = await ensureFixture(dir, 'full.png', { width: 64, height: 48, format: 'png' });
    const bytes = fs.readFileSync(src);
    const f = path.join(dir, 'trunc.png');
    fs.writeFileSync(f, bytes.slice(0, Math.floor(bytes.length / 2)));
    const code = await codes(() => probeImage(f));
    expect(['MEDIA_PROBE_FAILED', 'MEDIA_DECODE_FAILED']).toContain(code);
  });

  it('uses observed bytes, not filename, for spoofed extensions', async () => {
    const src = await ensureFixture(dir, 'real.png', { width: 64, height: 48, format: 'png' });
    const spoof = path.join(dir, 'spoof.jpg');
    fs.copyFileSync(src, spoof);
    const probe = await probeImage(spoof);
    expect(probe.mime).toBe('image/png');
    expect(probe.ext).toBe('png');
    const jsrc = await ensureFixture(dir, 'real2.png', { width: 64, height: 48, format: 'mjpeg' });
    const spoof2 = path.join(dir, 'spoof2.png');
    fs.copyFileSync(jsrc, spoof2);
    const probe2 = await probeImage(spoof2);
    expect(probe2.mime).toBe('image/jpeg');
  });

  it('enforces min dimensions and exact aspect with explicit tolerance', async () => {
    const png = await ensureFixture(dir, 'dims.png', { width: 64, height: 48, format: 'png' });
    expect(await codes(() => probeImage(png, { minWidth: 100 }))).toBe('MEDIA_DIMENSIONS_TOO_SMALL');
    expect(await codes(() => probeImage(png, { expectedRatio: 16 / 9 }))).toBe('MEDIA_ASPECT_MISMATCH');
    const ok = await probeImage(png, { expectedRatio: '4:3' });
    expect(ok.decoded).toBe(true);
  });

  it('rejects remote media URLs and missing/empty/oversize inputs', async () => {
    expect(await codes(() => probeImage('https://example.com/x.png'))).toBe('MEDIA_URL_REJECTED');
    expect(await codes(() => probeImage('data:image/png;base64,AAAA'))).toBe('MEDIA_URL_REJECTED');
    expect(await codes(() => probeImage(path.join(dir, 'nope.png')))).toBe('MEDIA_NOT_FOUND');
    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect(await codes(() => probeImage(empty))).toBe('MEDIA_EMPTY');
    const png = await ensureFixture(dir, 'big.png', { width: 64, height: 48, format: 'png' });
    expect(await codes(() => probeImage(png, { maxBytes: 10 }))).toBe('MEDIA_TOO_LARGE');
  });

  it('reads orientation as exposed value or explicit unknown (never invented)', async () => {
    const png = await ensureFixture(dir, 'orient.png', { width: 64, height: 48, format: 'png' });
    const probe = await probeImage(png);
    expect(probe.orientation).toBeDefined();
    expect(typeof probe.orientation === 'string' || typeof probe.orientation === 'number').toBe(true);
  });

  it('fails explicitly when the local tool is missing', async () => {
    const { runTool } = __w09Internals();
    expect(await codes(() => runTool('__w09-definitely-missing-tool__', [], { timeoutMs: 5000 }))).toBe('MEDIA_TOOL_MISSING');
  });

  it('fails explicitly on tool timeout', async () => {
    const { runTool } = __w09Internals();
    const code = await codes(() => runTool(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 300 }));
    expect(code).toBe('MEDIA_TIMEOUT');
  }, 15000);
});

describe('W09 C3 retainImage immutable content-addressed retention', () => {
  let dir;
  let root;
  let assetsDir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-c3-'));
    root = path.join(dir, 'flow-home');
    fs.mkdirSync(root, { recursive: true });
    assetsDir = path.join(root, 'assets', 'originals');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };
  const load = async () => {
    const mod = await import('../src/media/candidate-images.js');
    expect(typeof mod.retainImage, 'C3 RED: retainImage must exist').toBe('function');
    return mod;
  };

  it('retains original bytes at assetsDir/<full-sha256>.<actual-ext>', async () => {
    const { retainImage } = await load();
    const src = await ensureFixture(dir, 'src.png', { width: 64, height: 48, format: 'png' });
    const before = fs.readFileSync(src);
    const ret = await retainImage(src, { assetsDir, root });
    expect(ret.path).toBe(path.join(assetsDir, `${ret.hash}.${ret.ext}`));
    expect(ret.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(ret.path).equals(before)).toBe(true);
    expect(ret.probe.decoded).toBe(true);
    // source inputs are never destroyed
    expect(fs.readFileSync(src).equals(before)).toBe(true);
  });

  it('duplicate retention is idempotent: same bytes, same path, no overwrite', async () => {
    const { retainImage } = await load();
    const src = await ensureFixture(dir, 'dup.png', { width: 48, height: 32, format: 'webp', color: 'blue' });
    const a = await retainImage(src, { assetsDir, root });
    const mtime1 = fs.statSync(a.path).mtimeMs;
    const b = await retainImage(src, { assetsDir, root });
    expect(b.path).toBe(a.path);
    expect(b.hash).toBe(a.hash);
    expect(fs.statSync(b.path).mtimeMs).toBe(mtime1);
  });

  it('modified source bytes produce a different addressed target (no false equality)', async () => {
    const { retainImage } = await load();
    const src = path.join(dir, 'mut.png');
    await ensureFixture(dir, 'mut.png', { width: 64, height: 48, format: 'png', color: 'red' });
    const a = await retainImage(src, { assetsDir, root });
    await ensureFixture(dir, 'mut2.png', { width: 64, height: 48, format: 'png', color: 'blue' });
    fs.copyFileSync(path.join(dir, 'mut2.png'), src);
    const b = await retainImage(src, { assetsDir, root });
    expect(b.hash).not.toBe(a.hash);
    expect(b.path).not.toBe(a.path);
  });

  it('conflicting existing target bytes fail without overwrite', async () => {
    const { retainImage, probeImage } = await load();
    const src = await ensureFixture(dir, 'c.png', { width: 64, height: 48, format: 'png' });
    const probe = await probeImage(src);
    fs.mkdirSync(assetsDir, { recursive: true });
    const dest = path.join(assetsDir, `${probe.hash}.${probe.ext}`);
    fs.writeFileSync(dest, Buffer.from('conflicting-bytes-not-the-image'));
    const code = await codes(() => retainImage(src, { assetsDir, root }));
    expect(code).toBe('MEDIA_CONFLICT');
    expect(fs.readFileSync(dest).toString()).toBe('conflicting-bytes-not-the-image');
  });

  it('reverifies existing target bytes on second retain (tampered store fails)', async () => {
    const { retainImage } = await load();
    const src = await ensureFixture(dir, 't.png', { width: 64, height: 48, format: 'png' });
    const a = await retainImage(src, { assetsDir, root });
    fs.writeFileSync(a.path, Buffer.from('tampered-after-retain'));
    expect(await codes(() => retainImage(src, { assetsDir, root }))).toBe('MEDIA_CONFLICT');
  });

  it('requires assetsDir/root and rejects dest outside root before any side effect', async () => {
    const { retainImage } = await load();
    const src = await ensureFixture(dir, 'r.png', { width: 64, height: 48, format: 'png' });
    expect(await codes(() => retainImage(src, {}))).toMatch(/INVALID_PARAMS/);
    const outside = path.join(dir, 'outside-assets');
    expect(await codes(() => retainImage(src, { assetsDir: outside, root }))).toMatch(/INVALID_STORY_ID/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('rejects a junction escape inside the dest before writing outside bytes', async () => {
    const { retainImage } = await load();
    const src = await ensureFixture(dir, 'j.png', { width: 64, height: 48, format: 'png' });
    const linkBase = path.join(root, 'assets');
    fs.mkdirSync(linkBase, { recursive: true });
    const outside = path.join(dir, 'outside-j');
    fs.mkdirSync(outside, { recursive: true });
    const linkPath = path.join(linkBase, 'originals');
    fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const code = await codes(() => retainImage(src, { assetsDir: linkPath, root }));
    expect(code).toMatch(/INVALID_STORY_ID/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('W09 C4 createContactSheet labelled local review aid', () => {
  let dir;
  let root;
  let assetsDir;
  let outputDir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-c4-'));
    root = path.join(dir, 'flow-home');
    fs.mkdirSync(root, { recursive: true });
    assetsDir = path.join(root, 'assets', 'originals');
    outputDir = path.join(root, 'reviews');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };
  const load = async () => {
    const mod = await import('../src/media/candidate-images.js');
    expect(typeof mod.createContactSheet, 'C4 RED: createContactSheet must exist').toBe('function');
    return mod;
  };
  const retainTwo = async (mod) => {
    const s1 = await ensureFixture(dir, 'a.png', { width: 64, height: 48, format: 'png', color: 'red' });
    const s2 = await ensureFixture(dir, 'b.jpg', { width: 80, height: 60, format: 'mjpeg', color: 'blue' });
    const r1 = await mod.retainImage(s1, { assetsDir, root });
    const r2 = await mod.retainImage(s2, { assetsDir, root });
    return { r1, r2 };
  };

  it('builds a self-contained labelled sheet plus versioned manifest', async () => {
    const mod = await load();
    const { r1, r2 } = await retainTwo(mod);
    const out = await mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, label: 'hero close-up', provenance: 'synthetic-local-fixture' },
      { candidateId: 'cand-002', path: r2.path, hash: r2.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root, title: 'Shot 1 review' });
    expect(out.path).toBe(path.join(outputDir, out.reviewId, 'contact-sheet.html'));
    expect(out.manifestPath).toBe(path.join(outputDir, out.reviewId, 'contact-sheet.manifest.json'));
    expect(out.reviewId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const html = fs.readFileSync(out.path, 'utf8');
    expect(html).toContain('cand-001');
    expect(html).toContain(r1.hash);
    expect(html).toContain('Shot 1 review');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    const manifest = JSON.parse(fs.readFileSync(out.manifestPath, 'utf8'));
    expect(manifest.v).toBe(1);
    expect(manifest.candidates).toHaveLength(2);
    expect(manifest.candidates[0].candidateId).toBe('cand-001');
    expect(manifest.candidates[0].hash).toBe(r1.hash);
    // export hash is actual sheet bytes
    const { sha256Hex } = await import('../src/assets/catalog.js');
    expect(out.hash).toBe(sha256Hex(Buffer.from(html, 'utf8')));
  });

  it('escapes label/path HTML injection and keeps no remote URLs or JS', async () => {
    const mod = await load();
    const { r1 } = await retainTwo(mod);
    const evil = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
    const out = await mod.createContactSheet([
      { candidateId: 'cand-<b>evil</b>', path: r1.path, hash: r1.hash, label: evil, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root });
    const html = fs.readFileSync(out.path, 'utf8');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('cand-&lt;b&gt;evil&lt;/b&gt;');
    expect(html).not.toContain(evil);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('refuses hash-mismatched candidates before writing any sheet', async () => {
    const mod = await load();
    const { r1 } = await retainTwo(mod);
    const code = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: '0'.repeat(64), provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(code).toBe('MEDIA_HASH_MISMATCH');
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('refuses corrupt candidates (no screenshot promoted as original)', async () => {
    const mod = await load();
    const bad = path.join(root, 'stale.png');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(bad, '<html>stale tile</html>');
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const code = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-001', path: bad, hash: sha256Hex(fs.readFileSync(bad)), provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(['MEDIA_HTML_REJECTED', 'MEDIA_UNRECOGNIZED', 'MEDIA_PROBE_FAILED', 'MEDIA_DECODE_FAILED']).toContain(code);
    expect(fs.existsSync(path.join(outputDir, 'contact-sheet.html'))).toBe(false);
  });

  it('caps candidate count and total bytes', async () => {
    const mod = await load();
    const { r1 } = await retainTwo(mod);
    const many = Array.from({ length: 21 }, (_, i) => ({ candidateId: `cand-${i}`, path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' }));
    expect(await codes(() => mod.createContactSheet(many, { outputDir, root }))).toBe('MEDIA_SHEET_LIMIT');
    const one = [{ candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' }];
    expect(await codes(() => mod.createContactSheet(one, { outputDir, root, maxTotalBytes: 1 }))).toBe('MEDIA_SHEET_LIMIT');
    expect(fs.existsSync(path.join(outputDir, 'contact-sheet.html'))).toBe(false);
  });

  it('keeps identical bytes once but candidate IDs as separate domain records', async () => {
    const mod = await load();
    const { r1 } = await retainTwo(mod);
    const out = await mod.createContactSheet([
      { candidateId: 'cand-A', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
      { candidateId: 'cand-B', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root });
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0].candidateId).toBe('cand-A');
    expect(out.candidates[1].candidateId).toBe('cand-B');
    expect(out.candidates[0].path).toBe(out.candidates[1].path);
    const dup = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-A', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
      { candidateId: 'cand-A', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(dup).toBe('INVALID_PARAMS');
  });

  it('signals fixture/local provenance with derived-preview labels and usable full-size links', async () => {
    const mod = await load();
    const { r1 } = await retainTwo(mod);
    const out = await mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root });
    const html = fs.readFileSync(out.path, 'utf8');
    expect(html).toMatch(/synthetic-local|local fixture/i);
    expect(html).toMatch(/NOT Flow-generated/i);
    expect(html).toMatch(/derived local preview/i);
    expect(html).toMatch(/NOT (the )?original/i);
    expect(html).toContain(r1.path);
  });

  it('requires outputDir/root containment for reviews and candidates', async () => {
    const mod = await load();
    const { r1 } = await retainTwo(mod);
    const cands = [{ candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' }];
    expect(await codes(() => mod.createContactSheet(cands, {}))).toBe('INVALID_PARAMS');
    const outsideOut = path.join(dir, 'outside-reviews');
    expect(await codes(() => mod.createContactSheet(cands, { outputDir: outsideOut, root }))).toBe('INVALID_STORY_ID');
    expect(fs.existsSync(outsideOut)).toBe(false);
    const outsideSrc = await ensureFixture(dir, 'ext.png', { width: 32, height: 32, format: 'png' });
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const extCands = [{ candidateId: 'cand-ext', path: outsideSrc, hash: sha256Hex(fs.readFileSync(outsideSrc)), provenance: 'synthetic-local-fixture' }];
    expect(await codes(() => mod.createContactSheet(extCands, { outputDir, root }))).toBe('INVALID_STORY_ID');
  });

  it('fails closed when the containment root does not exist', async () => {
    const mod = await load();
    const src = await ensureFixture(dir, 'nr.png', { width: 32, height: 32, format: 'png' });
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const cands = [{ candidateId: 'cand-001', path: src, hash: sha256Hex(fs.readFileSync(src)), provenance: 'synthetic-local-fixture' }];
    const missingRoot = path.join(dir, 'no-such-root');
    expect(await codes(() => mod.createContactSheet(cands, { outputDir: path.join(missingRoot, 'reviews'), root: missingRoot }))).toBe('INVALID_STORY_ID');
    expect(fs.existsSync(missingRoot)).toBe(false);
  });
});

describe('W09 R2 controlled concurrent retention (no raced overwrite)', () => {
  let dir;
  let root;
  let assetsDir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-r2-'));
    root = path.join(dir, 'flow-home');
    fs.mkdirSync(root, { recursive: true });
    assetsDir = path.join(root, 'assets', 'originals');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };
  const strayFiles = (d) => fs.readdirSync(d).filter((f) => !/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(f));

  it('parallel retains of one source all land on identical bytes, no stray task temp', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const src = await ensureFixture(dir, 'par.png', { width: 64, height: 48, format: 'png', color: 'red' });
    const results = await Promise.all(Array.from({ length: 6 }, () => mod.retainImage(src, { assetsDir, root })));
    const paths = new Set(results.map((r) => r.path));
    const hashes = new Set(results.map((r) => r.hash));
    expect(paths.size).toBe(1);
    expect(hashes.size).toBe(1);
    const { sha256Hex } = await import('../src/assets/catalog.js');
    expect(sha256Hex(fs.readFileSync(results[0].path))).toBe(results[0].hash);
    expect(strayFiles(assetsDir)).toEqual([]);
  });

  it('parallel retains against a conflicting precreated target never replace different bytes', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const src = await ensureFixture(dir, 'con.png', { width: 64, height: 48, format: 'png', color: 'green' });
    const probe = await mod.probeImage(src);
    fs.mkdirSync(assetsDir, { recursive: true });
    const dest = path.join(assetsDir, `${probe.hash}.${probe.ext}`);
    fs.writeFileSync(dest, Buffer.from('conflicting-bytes-not-the-image'));
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => codes(() => mod.retainImage(src, { assetsDir, root }))));
    expect(outcomes).toEqual(['MEDIA_CONFLICT', 'MEDIA_CONFLICT', 'MEDIA_CONFLICT', 'MEDIA_CONFLICT']);
    expect(fs.readFileSync(dest).toString()).toBe('conflicting-bytes-not-the-image');
    expect(strayFiles(assetsDir).filter((f) => f !== path.basename(dest))).toEqual([]);
  });

  it('parallel retains over an identical precreated target stay idempotent', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const src = await ensureFixture(dir, 'idem.png', { width: 48, height: 32, format: 'webp', color: 'blue' });
    const first = await mod.retainImage(src, { assetsDir, root });
    const results = await Promise.all(Array.from({ length: 4 }, () => mod.retainImage(src, { assetsDir, root })));
    for (const r of results) {
      expect(r.path).toBe(first.path);
      expect(r.hash).toBe(first.hash);
    }
    expect(strayFiles(assetsDir)).toEqual([]);
  });
});

describe('W09 R1 immutable sheet history (no overwrite)', () => {
  let dir;
  let root;
  let assetsDir;
  let outputDir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-r1-'));
    root = path.join(dir, 'flow-home');
    fs.mkdirSync(root, { recursive: true });
    assetsDir = path.join(root, 'assets', 'originals');
    outputDir = path.join(root, 'reviews');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };
  const reviewDirs = (out) => (fs.existsSync(out)
    ? fs.readdirSync(out).filter((f) => { try { return fs.statSync(path.join(out, f)).isDirectory(); } catch { return false; } })
    : []);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const setupRetained = async (mod) => {
    const s1 = await ensureFixture(dir, 'r1a.png', { width: 64, height: 48, format: 'png', color: 'red' });
    const s2 = await ensureFixture(dir, 'r1b.jpg', { width: 80, height: 60, format: 'mjpeg', color: 'blue' });
    const r1 = await mod.retainImage(s1, { assetsDir, root });
    const r2 = await mod.retainImage(s2, { assetsDir, root });
    return { r1, r2 };
  };

  it('two sheets in one outputDir keep independent immutable history with digest binding', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { r1, r2 } = await setupRetained(mod);
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const first = await mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, label: 'one', provenance: 'synthetic-local-fixture' },
    ], { outputDir, root, title: 'review one' });
    expect(first.reviewId).toMatch(UUID_RE);
    expect(first.path).toBe(path.join(outputDir, first.reviewId, 'contact-sheet.html'));
    expect(first.manifestPath).toBe(path.join(outputDir, first.reviewId, 'contact-sheet.manifest.json'));
    const html1 = fs.readFileSync(first.path);
    const manifestRaw1 = fs.readFileSync(first.manifestPath);
    const second = await mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
      { candidateId: 'cand-002', path: r2.path, hash: r2.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root, title: 'review two' });
    expect(second.reviewId).toMatch(UUID_RE);
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(second.path).not.toBe(first.path);
    // First history bytes + manifest unchanged and digest-bound.
    expect(fs.readFileSync(first.path).equals(html1)).toBe(true);
    expect(fs.readFileSync(first.manifestPath).equals(manifestRaw1)).toBe(true);
    const manifest1 = JSON.parse(manifestRaw1.toString('utf8'));
    expect(manifest1.reviewId).toBe(first.reviewId);
    expect(manifest1.sheetHash).toBe(sha256Hex(html1));
    expect(first.hash).toBe(sha256Hex(html1));
    // Both full-size originals retained and linked.
    const manifest2 = JSON.parse(fs.readFileSync(second.manifestPath, 'utf8'));
    expect(manifest2.candidates).toHaveLength(2);
    for (const m of [manifest1, manifest2]) {
      for (const c of m.candidates) {
        expect(fs.existsSync(c.path)).toBe(true);
        expect(sha256Hex(fs.readFileSync(c.path))).toBe(c.hash);
      }
    }
    expect(reviewDirs(outputDir)).toHaveLength(2);
  });

  it('a failing second sheet preserves the first approved history', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { r1 } = await setupRetained(mod);
    const first = await mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root });
    const html1 = fs.readFileSync(first.path);
    const manifestRaw1 = fs.readFileSync(first.manifestPath);
    const code = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-bad', path: r1.path, hash: 'f'.repeat(64), provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(code).toBe('MEDIA_HASH_MISMATCH');
    expect(fs.readFileSync(first.path).equals(html1)).toBe(true);
    expect(fs.readFileSync(first.manifestPath).equals(manifestRaw1)).toBe(true);
    expect(reviewDirs(outputDir)).toEqual([first.reviewId]);
  });

  it('outputDir as a preexisting file fails without touching it', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { r1 } = await setupRetained(mod);
    fs.writeFileSync(outputDir, 'approved-unrelated-bytes');
    const code = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(code).toBe('STORAGE_IO_ERROR');
    expect(fs.readFileSync(outputDir, 'utf8')).toBe('approved-unrelated-bytes');
  });

  it('planted junction at outputDir fails closed with zero outside writes', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { r1 } = await setupRetained(mod);
    const outside = path.join(dir, 'outside-r1');
    fs.mkdirSync(outside, { recursive: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.symlinkSync(outside, outputDir, process.platform === 'win32' ? 'junction' : 'dir');
    const code = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-001', path: r1.path, hash: r1.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(code).toMatch(/INVALID_STORY_ID/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('candidate file symlink escaping root is rejected before decode', async (context) => {
    const mod = await import('../src/media/candidate-images.js');
    const outsideSrc = await ensureFixture(dir, 'r1ext.png', { width: 32, height: 32, format: 'png' });
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const outsideHash = sha256Hex(fs.readFileSync(outsideSrc));
    const linkPath = path.join(root, 'linked.png');
    try {
      fs.symlinkSync(outsideSrc, linkPath, 'file');
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) context.skip();
      throw e;
    }
    const code = await codes(() => mod.createContactSheet([
      { candidateId: 'cand-ext', path: linkPath, hash: outsideHash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root }));
    expect(code).toMatch(/INVALID_STORY_ID/);
    expect(reviewDirs(outputDir)).toEqual([]);
  });
});

describe('W09 R3 frozen-snapshot single-still probe', () => {
  it('recognizes RIFF animation chunks, not strings inside still-image payloads', async () => {
    const {hasWebpAnimation} = await import('../src/media/candidate-images.js');
    const riff = (tag, payload) => {
      const header = Buffer.alloc(20);
      header.write('RIFF'); header.writeUInt32LE(12 + payload.length + payload.length % 2, 4);
      header.write('WEBP', 8); header.write(tag, 12); header.writeUInt32LE(payload.length, 16);
      return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
    };
    expect(hasWebpAnimation(riff('ANIM', Buffer.alloc(6)))).toBe(true);
    expect(hasWebpAnimation(riff('ANMF', Buffer.alloc(17)))).toBe(true);
    expect(hasWebpAnimation(riff('VP8 ', Buffer.from('ANIM ANMF')))).toBe(false);
    expect(hasWebpAnimation(riff('ANIM', Buffer.alloc(6)).subarray(0, 22))).toBe(false);
    expect(hasWebpAnimation(Buffer.from('ANIM'))).toBe(false);
  });
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-r3-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };

  it('rejects animated WebP although its signature is valid webp', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { generateAnimatedWebp } = await import('./helpers/w09-image-fixtures.js');
    const anim = path.join(dir, 'anim.webp');
    await generateAnimatedWebp(anim, { width: 64, height: 48, frames: 6 });
    expect(await codes(() => mod.probeImage(anim, { timeoutMs: 15000 }))).toBe('MEDIA_MULTI_FRAME');
  });

  it('rejects APNG although its signature is valid png', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { generateApng } = await import('./helpers/w09-image-fixtures.js');
    const anim = path.join(dir, 'anim.png');
    await generateApng(anim, { width: 64, height: 48, frames: 3 });
    expect(await codes(() => mod.probeImage(anim, { timeoutMs: 15000 }))).toBe('MEDIA_MULTI_FRAME');
  });

  it('rejects unbounded/invalid resource bounds before any read or process', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const png = await ensureFixture(dir, 'bounds.png', { width: 64, height: 48, format: 'png' });
    expect(await codes(() => mod.probeImage(png, { maxBytes: Infinity }))).toBe('INVALID_PARAMS');
    expect(await codes(() => mod.probeImage(png, { maxBytes: NaN }))).toBe('INVALID_PARAMS');
    expect(await codes(() => mod.probeImage(png, { maxBytes: 0 }))).toBe('INVALID_PARAMS');
    expect(await codes(() => mod.probeImage(png, { timeoutMs: 0 }))).toBe('INVALID_PARAMS');
    expect(await codes(() => mod.probeImage(png, { timeoutMs: Infinity }))).toBe('INVALID_PARAMS');
    expect(await codes(() => mod.probeImage(png, { timeoutMs: -1 }))).toBe('INVALID_PARAMS');
    // Bounds validation fires before file reads: missing file + bad bounds is still INVALID_PARAMS.
    expect(await codes(() => mod.probeImage(path.join(dir, 'nope.png'), { maxBytes: Infinity }))).toBe('INVALID_PARAMS');
  });

  it('stdin tool transport fails explicitly when the binary is missing', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const runToolStdin = mod.__w09Internals().runToolStdin;
    expect(typeof runToolStdin, 'R3 RED: stdin transport must exist').toBe('function');
    expect(await codes(() => runToolStdin('__w09-definitely-missing-tool__', [], Buffer.from('x'), { timeoutMs: 5000 }))).toBe('MEDIA_TOOL_MISSING');
  });

  it('probe results always describe exact frozen bytes under concurrent source mutation', async () => {    const mod = await import('../src/media/candidate-images.js');
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const fileA = await ensureFixture(dir, 'raceA.png', { width: 64, height: 48, format: 'png', color: 'red' });
    const fileB = await ensureFixture(dir, 'raceB.png', { width: 80, height: 60, format: 'png', color: 'blue' });
    const bytesA = fs.readFileSync(fileA);
    const bytesB = fs.readFileSync(fileB);
    const hashA = sha256Hex(bytesA);
    const hashB = sha256Hex(bytesB);
    const target = path.join(dir, 'race.png');
    fs.writeFileSync(target, bytesA);
    let stop = false;
    const mutator = (async () => {
      let flip = false;
      while (!stop) {
        fs.writeFileSync(target, flip ? bytesA : bytesB);
        flip = !flip;
        await new Promise((r) => setImmediate(r));
      }
    })();
    let settled;
    try {
      settled = await Promise.allSettled(Array.from({ length: 8 }, () => mod.probeImage(target, { timeoutMs: 15000 })));
    } finally {
      stop = true;
      await mutator;
    }
    const fulfilled = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    expect(fulfilled.length).toBeGreaterThan(0);
    for (const p of fulfilled) {
      const matchA = p.hash === hashA && p.width === 64 && p.height === 48 && p.size === bytesA.length;
      const matchB = p.hash === hashB && p.width === 80 && p.height === 60 && p.size === bytesB.length;
      expect(matchA || matchB, `inconsistent probe: hash ${p.hash} vs ${p.width}x${p.height}`).toBe(true);
    }
  }, 90000);
});

describe('W09 R4 file: URL and literal path identity', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-r4-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };

  it('resolves proper file: URLs including escaped spaces (no broken drive paths)', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { pathToFileURL } = await import('url');
    const spaced = await ensureFixture(dir, 'sp ace.png', { width: 64, height: 48, format: 'png', color: 'red' });
    expect(spaced).toContain('sp ace.png');
    const viaUrl = await mod.probeImage(pathToFileURL(spaced).href, { timeoutMs: 15000 });
    expect(viaUrl.decoded).toBe(true);
    expect(viaUrl.width).toBe(64);
    expect(viaUrl.height).toBe(48);
    const { sha256Hex } = await import('../src/assets/catalog.js');
    expect(viaUrl.hash).toBe(sha256Hex(fs.readFileSync(spaced)));
  });

  it('accepts localhost file: URLs as local identity', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const png = await ensureFixture(dir, 'local.png', { width: 48, height: 32, format: 'png' });
    const { pathToFileURL } = await import('url');
    const href = pathToFileURL(png).href.replace('file:///', 'file://localhost/');
    const probe = await mod.probeImage(href, { timeoutMs: 15000 });
    expect(probe.decoded).toBe(true);
    expect(probe.width).toBe(48);
  });

  it('rejects remote-host file: URLs and UNC network paths (no network reads)', async () => {
    const mod = await import('../src/media/candidate-images.js');
    expect(await codes(() => mod.probeImage('file://remotehost/x/y.png'))).toBe('MEDIA_URL_REJECTED');
    expect(await codes(() => mod.probeImage('file://%zz'))).toBe('MEDIA_URL_REJECTED');
    expect(await codes(() => mod.probeImage('\\\\server\\share\\f.png'))).toBe('MEDIA_URL_REJECTED');
    expect(await codes(() => mod.probeImage('https://example.com/x.png'))).toBe('MEDIA_URL_REJECTED');
    expect(await codes(() => mod.probeImage('data:image/png;base64,AAAA'))).toBe('MEDIA_URL_REJECTED');
  });

  it('never trim-repairs literal paths into other file identities', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const png = await ensureFixture(dir, 'pad.png', { width: 32, height: 32, format: 'png' });
    expect(await codes(() => mod.probeImage(`${png} `))).toBe('MEDIA_NOT_FOUND');
    expect(await codes(() => mod.probeImage(` ${png}`))).toBe('MEDIA_NOT_FOUND');
    const ok = await mod.probeImage(png, { timeoutMs: 15000 });
    expect(ok.decoded).toBe(true);
  });
});

describe('W09 R5 sheet provenance, active-content limits and absolute caps', () => {
  let dir;
  let root;
  let assetsDir;
  let outputDir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-r5-'));
    root = path.join(dir, 'flow-home');
    fs.mkdirSync(root, { recursive: true });
    assetsDir = path.join(root, 'assets', 'originals');
    outputDir = path.join(root, 'reviews');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const codes = async (fn) => {
    try { await fn(); } catch (e) { return e.code || String(e); }
    return 'NO_THROW';
  };

  it('requires explicit per-candidate SOURCE provenance (no silent default)', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const src = await ensureFixture(dir, 'prov.png', { width: 64, height: 48, format: 'png' });
    const ret = await mod.retainImage(src, { assetsDir, root });
    expect(await codes(() => mod.createContactSheet([
      { candidateId: 'cand-001', path: ret.path, hash: ret.hash },
    ], { outputDir, root }))).toBe('INVALID_PARAMS');
    const ok = await mod.createContactSheet([
      { candidateId: 'cand-001', path: ret.path, hash: ret.hash, label: 'hero', provenance: 'local_import' },
    ], { outputDir, root });
    const manifest = JSON.parse(fs.readFileSync(ok.manifestPath, 'utf8'));
    expect(manifest.candidates[0].provenance).toBe('local_import');
    // Top level is a local review aid; SOURCE provenance lives per candidate.
    const html = fs.readFileSync(ok.path, 'utf8');
    expect(html).toMatch(/local candidate review aid/i);
    expect(html).toContain('local_import');
  });

  it('treats escaped https user text as harmless DATA under CSP with no remote loads', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const src = await ensureFixture(dir, 'note.png', { width: 64, height: 48, format: 'png' });
    const ret = await mod.retainImage(src, { assetsDir, root });
    const out = await mod.createContactSheet([
      { candidateId: 'cand-001', path: ret.path, hash: ret.hash, label: 'see https://notes.example/x for ref', provenance: 'synthetic-local-fixture' },
    ], { outputDir, root });
    const html = fs.readFileSync(out.path, 'utf8');
    expect(html).toContain('https://notes.example/x');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="http/i);
    expect(html).not.toMatch(/href="http/i);
    expect(html).toMatch(/Content-Security-Policy/);
  });

  it('count cap is absolute regardless of override arguments', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const src = await ensureFixture(dir, 'cap.png', { width: 32, height: 32, format: 'png' });
    const ret = await mod.retainImage(src, { assetsDir, root });
    const many = Array.from({ length: 21 }, (_, i) => ({
      candidateId: `cand-${i}`, path: ret.path, hash: ret.hash, provenance: 'synthetic-local-fixture',
    }));
    expect(await codes(() => mod.createContactSheet(many, { outputDir, root, maxCandidates: 50 }))).toBe('MEDIA_SHEET_LIMIT');
  }, 60000);

  it('total-bytes cap is absolute regardless of override arguments', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { generateNoisePng } = await import('./helpers/w09-image-fixtures.js');
    const big = path.join(dir, 'big.png');
    await generateNoisePng(big, { size: 2048 });
    const ret = await mod.retainImage(big, { assetsDir, root });
    const total = ret.size * 20;
    expect(total).toBeGreaterThan(100 * 1024 * 1024);
    const cands = Array.from({ length: 20 }, (_, i) => ({
      candidateId: `cand-${i}`, path: ret.path, hash: ret.hash, provenance: 'synthetic-local-fixture',
    }));
    expect(await codes(() => mod.createContactSheet(cands, { outputDir, root, maxTotalBytes: 200 * 1024 * 1024 }))).toBe('MEDIA_SHEET_LIMIT');
  }, 180000);

  it('derived previews fit a 320 box and full-size originals read back unchanged', async () => {
    const mod = await import('../src/media/candidate-images.js');
    const { sha256Hex } = await import('../src/assets/catalog.js');
    const tall = await ensureFixture(dir, 'tall.png', { width: 16, height: 2048, format: 'png', color: 'green' });
    const ret = await mod.retainImage(tall, { assetsDir, root });
    const before = sha256Hex(fs.readFileSync(ret.path));
    const out = await mod.createContactSheet([
      { candidateId: 'cand-tall', path: ret.path, hash: ret.hash, provenance: 'synthetic-local-fixture' },
    ], { outputDir, root });
    expect(sha256Hex(fs.readFileSync(ret.path))).toBe(before);
    const html = fs.readFileSync(out.path, 'utf8');
    const m = html.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/);
    expect(m, 'tall-image preview must render (not unavailable)').not.toBeNull();
    const previewFile = path.join(dir, 'preview-check.jpg');
    fs.writeFileSync(previewFile, Buffer.from(m[1], 'base64'));
    const previewProbe = await mod.probeImage(previewFile, { timeoutMs: 15000 });
    expect(previewProbe.width).toBeLessThanOrEqual(320);
    expect(previewProbe.height).toBeLessThanOrEqual(320);
  }, 120000);
});
