import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  RUNTIME_SCHEMA_VERSION,
  initRuntimeDirs,
  atomicWriteJson,
  readVersionedJson,
  compareAndSwapJson,
  acquireLock,
  PROTECTED_SUBDIRS,
} from '../src/storage/runtime-store.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w01-store-'));
}

describe('W01 storage: protected runtime, atomic CAS/lock, corruption/migration', () => {
  it('inits fresh runtime dirs with protected stories+journal separate from debug', () => {
    const root = tmpRoot();
    const out = initRuntimeDirs(root);
    expect(out.root).toBe(root);
    for (const d of PROTECTED_SUBDIRS) {
      expect(fs.existsSync(path.join(root, d))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'stories'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'journal'))).toBe(true);
    // Must not create legacy debug-metadata inside protected area as story state.
    expect(path.join(root, 'stories')).not.toContain('metadata');
  });

  it('atomically writes and reads versioned JSON', () => {
    const root = tmpRoot();
    initRuntimeDirs(root);
    const f = path.join(root, 'stories', 'manifest.json');
    atomicWriteJson(f, { v: RUNTIME_SCHEMA_VERSION, revision: 'r1' });
    const got = readVersionedJson(f, { supported: [RUNTIME_SCHEMA_VERSION] });
    expect(got.revision).toBe('r1');
  });

  it('rejects future versions without overwriting the file', () => {
    const root = tmpRoot();
    initRuntimeDirs(root);
    const f = path.join(root, 'stories', 'manifest.json');
    atomicWriteJson(f, { v: 999, revision: 'future' });
    expect(() => readVersionedJson(f, { supported: [RUNTIME_SCHEMA_VERSION] })).toThrow(/version/i);
    expect(JSON.parse(fs.readFileSync(f, 'utf-8')).v).toBe(999);
  });

  it('backs up corrupt JSON instead of overwriting with defaults', () => {
    const root = tmpRoot();
    initRuntimeDirs(root);
    const f = path.join(root, 'stories', 'manifest.json');
    fs.writeFileSync(f, '{not json');
    expect(() => readVersionedJson(f, { supported: [RUNTIME_SCHEMA_VERSION] })).toThrow(/corrupt/i);
    const dir = path.dirname(f);
    const backups = fs.readdirSync(dir).filter((n) => n.includes('.corrupt.'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(f, 'utf-8')).toBe('{not json');
  });

  it('enforces revision CAS and exclusive lock', () => {
    const root = tmpRoot();
    initRuntimeDirs(root);
    const f = path.join(root, 'stories', 'manifest.json');
    atomicWriteJson(f, { v: 1, revision: 'r1', n: 1 });
    expect(() => compareAndSwapJson(f, 'r0', { v: 1, revision: 'r2' })).toThrow(/conflict|revision/i);
    compareAndSwapJson(f, 'r1', { v: 1, revision: 'r2', n: 2 });
    expect(readVersionedJson(f, { supported: [1] }).revision).toBe('r2');
    expect(fs.existsSync(`${f}.lock`)).toBe(false);
    const lockFile = path.join(root, 'journal', 'story.lock');
    const lock = acquireLock(lockFile);
    expect(typeof lock.token).toBe('string');
    expect(() => acquireLock(lockFile)).toThrow(/already held/i);
    expect(lock.release()).toBe(true);
    const lock2 = acquireLock(lockFile);
    expect(lock2.release()).toBe(true);
  });
});
