import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneDir, runRetentionSweep, RETENTION_DEFAULTS } from '../src/utils/file-manager.js';

// P2-4: retention uses real fs in tmp dirs (mirrors file-manager tests).
// The default sweep (real repo logs/screenshots/metadata) is never invoked
// here — only explicit tmp dirs.
describe('pruneDir', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-retention-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function aged(name, daysAgo) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, 'x');
    const t = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
    fs.utimesSync(full, t, t);
    return full;
  }

  it('deletes files older than maxAge, keeps fresh ones', () => {
    const old = aged('old.log', 10);
    const fresh = aged('new.log', 1);
    const out = pruneDir(dir, { maxAgeMs: 7 * 24 * 3600 * 1000 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(out).toMatchObject({ deleted: 1, kept: 1 });
  });

  it('caps count by deleting oldest first', () => {
    for (let i = 0; i < 5; i += 1) aged(`f${i}.png`, 0);
    const out = pruneDir(dir, { maxCount: 3 });
    expect(fs.readdirSync(dir)).toHaveLength(3);
    expect(out).toMatchObject({ deleted: 2, kept: 3 });
  });

  it('leaves subdirectories alone and survives missing dirs', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'keep.txt'), 'x');
    const out = pruneDir(dir, { maxAgeMs: 0 });
    expect(fs.existsSync(path.join(dir, 'sub', 'keep.txt'))).toBe(true);
    expect(out.deleted).toBe(0);
    expect(pruneDir(path.join(dir, 'nope'), {})).toMatchObject({ deleted: 0, kept: 0, errors: [] });
  });

  it('runRetentionSweep aggregates explicit dirs and never throws', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-retention-2-'));
    try {
      aged('a.log', 10);
      const summary = runRetentionSweep([
        { dir, policy: { maxAgeMs: 7 * 24 * 3600 * 1000 }, label: 't1' },
        { dir: d2, policy: { maxCount: 0 }, label: 't2' },
        { dir: path.join(dir, 'missing'), policy: {}, label: 't3' },
      ]);
      expect(summary.deleted).toBe(1);
      expect(summary.errors).toEqual([]);
      expect(summary.dirs.t1).toMatchObject({ deleted: 1 });
    } finally {
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it('defaults look sane', () => {
    expect(RETENTION_DEFAULTS.screenshots.maxAgeMs).toBe(7 * 24 * 3600 * 1000);
    expect(RETENTION_DEFAULTS.logs.maxCount).toBeGreaterThan(0);
  });
});
