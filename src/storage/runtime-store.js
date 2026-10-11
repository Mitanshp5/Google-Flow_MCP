// W01: protected runtime storage primitives.
// Plan refs: Sec 7.1 (durable layout under runtime root, not debug-metadata),
// Sec 7.4 (atomic writes, CAS, migrations, corruption backup), K46/K47.
// Parent correction: durability is explicit — unique same-volume temp files
// created exclusively (wx), fd write + fsync + close before rename, temp
// cleanup on failure with the original preserved; CAS holds an exclusive
// lock across the whole read/validate/write; init validates the existing
// runtime marker (future versions rejected) and prepares config dirs;
// migrations are explicit and validated. Full content-addressed bible/story
// DAG store is deferred to W08.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { getFlowHome } from '../utils/config.js';

export const RUNTIME_SCHEMA_VERSION = 1;

// Protected story state lives here. Disposable debug/metadata
// (logs, screenshots-debug, outputs/metadata) must never be treated as
// durable story state and retention sweeps must not touch these paths.
export const PROTECTED_SUBDIRS = Object.freeze(['stories', 'journal']);
export const RUNTIME_MARKER_FILE = 'runtime.json';

let tmpCounter = 0;

export function getRuntimeRoot() {
  return getFlowHome();
}

export function initRuntimeDirs(root = getRuntimeRoot()) {
  const created = [];
  for (const sub of [...PROTECTED_SUBDIRS, 'debug', 'config']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(sub);
    }
  }
  const marker = path.join(root, RUNTIME_MARKER_FILE);
  if (!fs.existsSync(marker)) {
    atomicWriteJson(marker, {
      v: RUNTIME_SCHEMA_VERSION,
      initializedAt: new Date().toISOString(),
    });
    created.push(RUNTIME_MARKER_FILE);
  } else {
    // An existing marker is authoritative: validate it, never overwrite it
    // with a fresh default. Future (or otherwise unsupported) schema
    // versions are rejected for an explicit migration, not silently adopted.
    let raw;
    try {
      raw = fs.readFileSync(marker, 'utf-8');
    } catch (e) {
      throw new FlowError('STORAGE_IO_ERROR', `runtime marker unreadable: ${marker}`, {
        file: marker,
        error: e.message,
      });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const backup = backupCorrupt(marker, raw);
      throw new FlowError('STORAGE_CORRUPT', `runtime marker corrupt; backed up, not overwritten: ${backup}`, {
        file: marker,
        backup,
        error: e.message,
      });
    }
    const version = data?.v ?? data?.version ?? null;
    if (version !== RUNTIME_SCHEMA_VERSION) {
      throw new FlowError('STORAGE_VERSION_UNSUPPORTED', `unsupported runtime version: ${version}`, {
        file: marker,
        version,
        supported: [RUNTIME_SCHEMA_VERSION],
      });
    }
  }
  return { root, created };
}

function ensureParent(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Durable atomic write: unique same-volume temp created exclusively, fd
// write + fsync + close, then atomic rename. Any failure removes the temp,
// preserves the original, and raises STORAGE_IO_ERROR (a storage error —
// never a lock error, never swallowed).
export function atomicWriteJson(file, data) {
  try {
    ensureParent(file);
  } catch (e) {
    throw new FlowError('STORAGE_IO_ERROR', `cannot prepare parent dir for: ${file}`, {
      file,
      error: e.message,
    });
  }
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const text = JSON.stringify(data, null, 2);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    try {
      const dirFd = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory-entry durability is best-effort (unsupported on some
      // platforms); the file itself was fsynced above.
    }
  } catch (e) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch { /* ignore */ }
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* ignore */ }
    if (e instanceof FlowError) throw e;
    throw new FlowError('STORAGE_IO_ERROR', `durable write failed (original preserved): ${file}`, {
      file,
      error: e.message,
    });
  }
  return file;
}

function backupCorrupt(file, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt.${stamp}.bak`;
  try {
    fs.writeFileSync(backup, raw);
  } catch {
    // Backup best-effort; original corrupt file is still preserved.
  }
  return backup;
}

// Reads versioned JSON. Corrupt files are backed up (never overwritten with
// empty defaults). Unsupported future versions are rejected with the file
// left intact for an explicit migration.
export function readVersionedJson(file, { supported = [RUNTIME_SCHEMA_VERSION] } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `storage file unreadable: ${file}`, { file, error: e.message });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const backup = backupCorrupt(file, raw);
    throw new FlowError('STORAGE_CORRUPT', `storage file corrupt; backed up, not overwritten: ${backup}`, {
      file,
      backup,
      error: e.message,
    });
  }
  const version = data?.v ?? data?.version ?? null;
  if (version === null || !supported.includes(version)) {
    throw new FlowError('STORAGE_VERSION_UNSUPPORTED', `unsupported storage version: ${version}`, {
      file,
      version,
      supported,
    });
  }
  return data;
}

// Revision compare-and-swap under an exclusive lock held across the whole
// read/validate/write: the root pointer moves only when the caller proves
// it saw the current revision. Concurrent writers serialize on the lock;
// stale revisions raise STORAGE_CONFLICT without touching the file.
export function compareAndSwapJson(file, expectedRevision, nextData) {
  const lock = acquireLock(`${file}.lock`);
  try {
    const current = readVersionedJson(file, { supported: [nextData?.v ?? RUNTIME_SCHEMA_VERSION] });
    if (current.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', 'revision mismatch; refusing to overwrite concurrent update', {
        file,
        expected: expectedRevision,
        actual: current.revision,
      });
    }
    atomicWriteJson(file, nextData);
  } finally {
    lock.release();
  }
  return nextData;
}

// Explicit validated migration: reads (any supported current version),
// applies migrateFn to a copy, verifies the result targets exactly
// targetVersion, then atomically commits. Corrupt originals are backed up
// and preserved, never overwritten.
export function migrateStorageJson(file, targetVersion, migrateFn, { supported = [RUNTIME_SCHEMA_VERSION] } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `storage file unreadable: ${file}`, { file, error: e.message });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const backup = backupCorrupt(file, raw);
    throw new FlowError('STORAGE_CORRUPT', `storage file corrupt; backed up, not migrated: ${backup}`, {
      file,
      backup,
      error: e.message,
    });
  }
  const current = data?.v ?? data?.version ?? null;
  if (current === targetVersion) return data;
  if (current === null || !supported.includes(current)) {
    throw new FlowError('STORAGE_VERSION_UNSUPPORTED', `cannot migrate from unsupported version: ${current}`, {
      file,
      version: current,
      supported,
      targetVersion,
    });
  }
  if (typeof migrateFn !== 'function') {
    throw new FlowError('STORAGE_VERSION_UNSUPPORTED', 'migration requires an explicit migrate function', {
      file,
      version: current,
      targetVersion,
    });
  }
  const next = migrateFn(JSON.parse(raw));
  if (!next || typeof next !== 'object' || (next.v ?? next.version) !== targetVersion) {
    throw new FlowError('STORAGE_CORRUPT', 'migration must produce exactly the target version', {
      file,
      targetVersion,
    });
  }
  atomicWriteJson(file, next);
  return next;
}

// Exclusive advisory lock with an owner token. Creation races resolve in the
// filesystem (wx): exactly one creator wins; losers get LOCK_HELD.
// Filesystem/permission failures are STORAGE_IO_ERROR — never LOCK_HELD.
// release() verifies the token still owns the file before removing it, so a
// stale/foreign holder can never delete another owner's lock (fence). There
// is deliberately no TTL: expiry alone never proves the old actor stopped,
// and there is no TTL-based takeover path.
export function acquireLock(lockFile) {
  try {
    ensureParent(lockFile);
  } catch (e) {
    throw new FlowError('STORAGE_IO_ERROR', `cannot prepare lock parent dir: ${lockFile}`, {
      lockFile,
      error: e.message,
    });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(lockFile, payload, { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      throw new FlowError('LOCK_HELD', `exclusive lock already held: ${lockFile}`, { lockFile });
    }
    throw new FlowError('STORAGE_IO_ERROR', `cannot create lock file: ${lockFile}`, {
      lockFile,
      error: e.message,
    });
  }
  let released = false;
  return {
    token,
    lockFile,
    release() {
      if (released) return false;
      let raw;
      try {
        raw = fs.readFileSync(lockFile, 'utf-8');
      } catch {
        // Our lock vanished without our release: another actor interfered.
        // Fence — do not silently pretend a clean release.
        released = true;
        throw new FlowError('STORAGE_CONFLICT', `lock file vanished before release: ${lockFile}`, { lockFile });
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.token !== token) {
        throw new FlowError('STORAGE_CONFLICT', `lock owned by another token; refusing to release: ${lockFile}`, {
          lockFile,
        });
      }
      fs.rmSync(lockFile, { force: true });
      released = true;
      return true;
    },
  };
}
