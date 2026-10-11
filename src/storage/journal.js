// W01: minimal durable journal primitives for intent/approval/attempt/
// reservation records. Plan refs: Sec 3.3/3.4 (persist intent + approval
// digest + baseline before any consequential UI event), Sec 7.1/7.4
// (protected journal separate from debug metadata, atomic durable writes).
// Scope is deliberately minimal: validated append + validated read.
// Corrupt lines are counted AND the original file is backed up; readers must
// treat corrupt > 0 as blocking (assertJournalClean) — corruption stops
// submission, it is never skipped into a default success. Locking, CAS
// linkage, multi-file commit ordering, and W05 submit-path integration
// (polling/reconciliation/unknown-retry) are deferred, not guessed here.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { canonicalStringify } from '../domain/contracts.js';

export const JOURNAL_VERSION = 1;
export const JOURNAL_KINDS = Object.freeze(['intent', 'approval', 'attempt', 'reservation']);

// Controlled envelope fields. A record carrying these would silently
// override version/kind/time on spread — rejected, never merged.
export const RESERVED_JOURNAL_KEYS = Object.freeze(['v', 'kind', 'at']);

const KIND_REQUIRED = {
  intent: ['id', 'requestDigest'],
  approval: ['id', 'requestDigest'],
  attempt: ['id', 'operationId'],
  reservation: ['id', 'operationId'],
};

function journalFile(dir) {
  return path.join(dir, 'journal.jsonl');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function validateJournalRecord(kind, record, { allowControlled = false } = {}) {
  if (!JOURNAL_KINDS.includes(kind)) {
    throw new FlowError('JOURNAL_INVALID', `unknown journal kind: ${kind}`, { kind });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new FlowError('JOURNAL_INVALID', 'journal record must be an object', { kind });
  }
  if (!allowControlled) {
    for (const reserved of RESERVED_JOURNAL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(record, reserved)) {
        throw new FlowError('JOURNAL_INVALID', `journal record reserves key "${reserved}" (controlled envelope)`, {
          kind,
          key: reserved,
        });
      }
    }
  }
  for (const field of KIND_REQUIRED[kind]) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new FlowError('JOURNAL_INVALID', `journal ${kind} record requires string field "${field}"`, {
        kind,
        field,
      });
    }
  }
  return true;
}

// Durable append: validated first, single appendFileSync (atomic for small
// records on local filesystems), then an explicit fsync whose failure is an
// explicit STORAGE_IO_ERROR — never swallowed for this consequential path.
// Never overwrites history.
export function appendJournal(dir, kind, record) {
  validateJournalRecord(kind, record);
  ensureDir(dir);
  const file = journalFile(dir);
  const entry = {
    v: JOURNAL_VERSION,
    kind,
    at: new Date().toISOString(),
    ...record,
  };
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(file, line);
  try {
    // Sync via a writable handle: Windows rejects fsync on read-only
    // handles (EPERM), so 'a' — never 'r' — is required here.
    const fd = fs.openSync(file, 'a');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    throw new FlowError('STORAGE_IO_ERROR', 'journal durability sync failed after append', {
      file,
      kind,
      error: e.message,
    });
  }
  return { path: file, bytes: Buffer.byteLength(line) };
}

function backupJournal(file, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupt.${stamp}.bak`;
  try {
    fs.writeFileSync(backup, raw);
  } catch {
    // Backup best-effort; the original file is still preserved untouched.
  }
  return backup;
}

function validateReadEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.v !== JOURNAL_VERSION) return false;
  if (!JOURNAL_KINDS.includes(entry.kind)) return false;
  try {
    validateJournalRecord(entry.kind, entry, { allowControlled: true });
  } catch {
    return false;
  }
  return true;
}

export function readJournal(dir) {
  const file = journalFile(dir);
  if (!fs.existsSync(file)) return { records: [], corrupt: 0, backup: null };
  const raw = fs.readFileSync(file, 'utf-8');
  const records = [];
  let corrupt = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!validateReadEntry(entry)) {
      corrupt += 1;
      continue;
    }
    records.push(entry);
  }
  // Preserve the original for forensics; never delete or repair in place.
  const backup = corrupt > 0 ? backupJournal(file, raw) : null;
  return { records, corrupt, backup };
}

// Corruption stops submission: call after readJournal wherever a submit,
// approval, or release decision depends on journal contents.
export function assertJournalClean(readResult) {
  if (readResult && typeof readResult.corrupt === 'number' && readResult.corrupt > 0) {
    throw new FlowError('STORAGE_CORRUPT', 'journal contains corrupt records; submission blocked pending reconciliation', {
      corrupt: readResult.corrupt,
      backup: readResult.backup ?? null,
    });
  }
  return readResult;
}

// Recursive canonical hash: nested fields/arrays/types all change the
// digest; non-JSON values throw instead of colliding.
export function digestPayload(payload) {
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}
