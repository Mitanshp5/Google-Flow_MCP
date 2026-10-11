import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendJournal, readJournal, JOURNAL_KINDS } from '../src/storage/journal.js';
import {
  createIntent,
  mintChildApproval,
  consumeChildApproval,
  reserveCredits,
} from '../src/domain/operations.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w01-journal-'));
}

describe('W01 journal + single-use approval/reservation foundations', () => {
  it('exposes the four minimal journal kinds', () => {
    for (const k of ['intent', 'approval', 'attempt', 'reservation']) {
      expect(JOURNAL_KINDS).toContain(k);
    }
  });

  it('persists validated intent records durably and reads them back', () => {
    const dir = tmpDir();
    const intent = createIntent({ operationId: 'op-1', requestDigest: 'd1', leaseEpoch: 7 });
    const res = appendJournal(dir, 'intent', intent);
    expect(res.path).toContain('journal');
    const { records } = readJournal(dir);
    expect(records.length).toBe(1);
    expect(records[0].kind).toBe('intent');
    expect(records[0].id).toBe('op-1');
  });

  it('rejects invalid journal records without writing', () => {
    const dir = tmpDir();
    expect(() => appendJournal(dir, 'intent', { bogus: true })).toThrow(/journal/i);
    expect(() => appendJournal(dir, 'nope', { id: 'x' })).toThrow(/journal|kind/i);
    const { records } = readJournal(dir);
    expect(records.length).toBe(0);
  });

  it('minted approval children are single-use (concurrent consume denied)', () => {
    const parent = { policyId: 'zp-1', maxCredits: 0, scopeDigest: 's' };
    const approvals = new Map();
    const child = mintChildApproval(parent, { index: 0, requestDigest: 'd1' });
    approvals.set(child.id, child);
    consumeChildApproval(approvals, child.id);
    expect(approvals.get(child.id).consumed).toBe(true);
    expect(() => consumeChildApproval(approvals, child.id)).toThrow(/consumed|single-use/i);
  });

  it('reservation ledger holds the upper bound until reconciled (no auto-release)', () => {
    const ledger = { reserved: 0, maxAuthorized: 10 };
    reserveCredits(ledger, 8);
    expect(ledger.reserved).toBe(8);
    expect(() => reserveCredits(ledger, 5)).toThrow(/exceed/i);
    // Partial landing does NOT release the bound: releasing is explicit only.
    expect(ledger.reserved).toBe(8);
  });
});
