// W01 parent-correction RED suite: exact counterexamples from actual parent
// probes, plus the itemized strict behaviors. Written BEFORE production
// repair; every `correction:` test must fail on the uncorrected code.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { createResult, canAuthorizeSpend } from '../src/domain/contracts.js';
import { evaluateSubmissionPolicy } from '../src/domain/submission-policy.js';
import { digestPayload, appendJournal, readJournal } from '../src/storage/journal.js';
import {
  atomicWriteJson,
  initRuntimeDirs,
  acquireLock,
} from '../src/storage/runtime-store.js';

const ev = (over = {}) => ({
  status: 'verified',
  required: true,
  observedAt: Date.now(),
  origin: 'ui-readback',
  ...over,
});

function fullPolicyInput(now, over = {}) {
  return {
    account: { expected: 'a@example.com', observed: 'a@example.com', verified: true, observedAt: now },
    project: { requiredId: 'p1', observedId: 'p1' },
    verification: {
      account: ev(),
      settings: ev(),
      quote: ev(),
      capabilities: ev(),
    },
    quote: {
      total: 0, unit: 'total', quantity: 1, model: 'M', feature: 'image',
      observedAt: now, expiresAt: now + 30_000,
    },
    approval: {
      id: 'appr-1', nonce: 'n-1', requestDigest: 'd',
      accountKey: 'a@example.com', projectId: 'p1', model: 'M',
      maxCredits: 0, expiresAt: now + 60_000, consumed: false, revoked: false,
    },
    capabilities: { model: 'M', feature: 'image', supported: true, observedAt: now },
    requestDigest: 'd',
    now,
    ...over,
  };
}

describe('parent correction 1: truthful ready authorizes nothing vacuous', () => {
  it('correction: empty verification + empty actual can never be ready/spendable', () => {
    // Exact parent probe: this returned true before the correction.
    expect(() =>
      createResult({ requested: { prompt: 'x' }, actual: {}, verification: {}, readiness: 'ready' }),
    ).toThrow();
  });

  it('correction: na on a required field is not spend proof', () => {
    const r = {
      v: 1,
      readiness: 'ready',
      requested: { prompt: 'x', feature: 'image' },
      actual: { prompt: 'x', feature: 'image' },
      verification: { model: { status: 'na', required: true } },
    };
    expect(canAuthorizeSpend(r)).toBe(false);
    expect(() =>
      createResult({ requested: r.requested, actual: r.actual, verification: r.verification, readiness: 'ready' }),
    ).toThrow();
  });

  it('correction: required verified proof needs origin/time metadata', () => {
    expect(() =>
      createResult({
        requested: { prompt: 'x', feature: 'image' },
        actual: { prompt: 'x', feature: 'image' },
        verification: { model: { status: 'verified', required: true } },
        readiness: 'ready',
      }),
    ).toThrow(/observ|origin|evidence/i);
  });

  it('correction: requested/actual echo without evidence is not spendable', () => {
    const r = {
      v: 1,
      readiness: 'ready',
      requested: { prompt: 'x', feature: 'image' },
      actual: { prompt: 'x', feature: 'image' },
      verification: { model: { status: 'verified', required: true } },
    };
    expect(canAuthorizeSpend(r)).toBe(false);
  });
});

describe('parent correction 2: policy denies every incomplete binding', () => {
  it('correction: negative cost + future quote + empty approval can never allow', () => {
    const now = Date.now();
    // Exact parent probe shape: this returned allow before the correction.
    const verdict = evaluateSubmissionPolicy({
      account: { verified: true, expected: 'a@example.com', observed: 'a@example.com', observedAt: now },
      quote: { total: -1, observedAt: now + 999999 },
      approval: {},
      now,
    });
    expect(verdict.decision).toBe('deny');
    const text = verdict.reasons.join(' ');
    expect(text).toMatch(/negativ/i);
    expect(text).toMatch(/future/i);
    expect(text).toMatch(/approval/i);
  });

  it('correction: missing project binding denies', () => {
    const now = Date.now();
    expect(evaluateSubmissionPolicy(fullPolicyInput(now, { project: undefined })).decision).toBe('deny');
    expect(evaluateSubmissionPolicy(fullPolicyInput(now, { project: null })).decision).toBe('deny');
  });

  it('correction: missing account timestamp denies; future account read denies', () => {
    const now = Date.now();
    const noTs = fullPolicyInput(now);
    delete noTs.account.observedAt;
    expect(evaluateSubmissionPolicy(noTs).decision).toBe('deny');
    const future = fullPolicyInput(now);
    future.account.observedAt = now + 60_000;
    expect(evaluateSubmissionPolicy(future).decision).toBe('deny');
  });

  it('correction: missing verification keys, null entries, arbitrary na deny', () => {
    const now = Date.now();
    const missing = fullPolicyInput(now);
    delete missing.verification.settings;
    expect(evaluateSubmissionPolicy(missing).decision).toBe('deny');
    const nulled = fullPolicyInput(now);
    nulled.verification.settings = null;
    expect(evaluateSubmissionPolicy(nulled).decision).toBe('deny');
    const na = fullPolicyInput(now);
    na.verification.settings = { status: 'na', required: true, observedAt: now, origin: 'ui' };
    expect(evaluateSubmissionPolicy(na).decision).toBe('deny');
  });

  it('correction: stale verification readback (>5s) denies', () => {
    const now = Date.now();
    const input = fullPolicyInput(now);
    input.verification.settings = ev({ observedAt: now - 30_000 });
    expect(evaluateSubmissionPolicy(input).decision).toBe('deny');
  });

  it('correction: quote without finite expiry denies; expiresAt cannot override 30s freshness', () => {
    const now = Date.now();
    const noExp = fullPolicyInput(now);
    delete noExp.quote.expiresAt;
    expect(evaluateSubmissionPolicy(noExp).decision).toBe('deny');
    const staleButLongExpiry = fullPolicyInput(now);
    staleButLongExpiry.quote.observedAt = now - 120_000;
    staleButLongExpiry.quote.expiresAt = now + 3600_000;
    const v = evaluateSubmissionPolicy(staleButLongExpiry);
    expect(v.decision).toBe('deny');
    expect(v.reasons.join(' ')).toMatch(/stale/i);
  });

  it('correction: unreadable unit and unbound quantity deny', () => {
    const now = Date.now();
    expect(evaluateSubmissionPolicy(fullPolicyInput(now, {
      quote: { total: 0, unit: 'credits???', quantity: 1, model: 'M', feature: 'image', observedAt: now, expiresAt: now + 30_000 },
    })).decision).toBe('deny');
    expect(evaluateSubmissionPolicy(fullPolicyInput(now, {
      quote: { total: 0, unit: 'total', model: 'M', feature: 'image', observedAt: now, expiresAt: now + 30_000 },
    })).decision).toBe('deny');
  });

  it('correction: approval without id/nonce/digest denies; legacy booleans never allow', () => {
    const now = Date.now();
    const v = evaluateSubmissionPolicy(fullPolicyInput(now, { approval: {}, requestDigest: 'd' }));
    expect(v.decision).toBe('deny');
    expect(v.reasons.join(' ')).toMatch(/nonce/i);
    const legacy = evaluateSubmissionPolicy({ confirm_generate: true, auto_confirm: true, now });
    expect(legacy.decision).toBe('deny');
  });

  it('correction: missing capabilities block; approval binding mismatch denies', () => {
    const now = Date.now();
    const noCaps = fullPolicyInput(now);
    delete noCaps.capabilities;
    expect(evaluateSubmissionPolicy(noCaps).decision).toBe('deny');
    const mismatch = fullPolicyInput(now);
    mismatch.approval.projectId = 'other-project';
    expect(evaluateSubmissionPolicy(mismatch).decision).toBe('deny');
  });

  it('correction: the fully-bound strict fixture still allows', () => {
    const now = Date.now();
    const v = evaluateSubmissionPolicy(fullPolicyInput(now));
    expect(v.decision).toBe('allow');
  });
});

describe('parent correction 3: digests and journal integrity', () => {
  it('correction: nested payload fields change the digest', () => {
    // Exact parent probe: these collided before the correction.
    expect(digestPayload({ refs: { id: 'one' } })).not.toBe(digestPayload({ refs: { id: 'two' } }));
  });

  it('correction: non-JSON values are rejected, not collided', () => {
    expect(() => digestPayload({ a: undefined })).toThrow();
    expect(() => digestPayload({ a: NaN })).toThrow();
    expect(() => digestPayload(null)).not.toThrow();
  });

  it('correction: journal records cannot override controlled v/kind/at', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-j-'));
    expect(() => appendJournal(dir, 'intent', { id: 'op-1', requestDigest: 'd', v: 99 })).toThrow(/reserv/i);
    expect(() => appendJournal(dir, 'intent', { id: 'op-1', requestDigest: 'd', kind: 'attempt' })).toThrow(/reserv/i);
  });

  it('correction: corrupt journal lines are backed up, never silently skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-jc-'));
    appendJournal(dir, 'intent', { id: 'op-1', requestDigest: 'd' });
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{broken json\n');
    const read = readJournal(dir);
    expect(read.corrupt).toBe(1);
    expect(read.records.length).toBe(1);
    const backups = fs.readdirSync(dir).filter((n) => n.includes('.corrupt.'));
    expect(backups.length).toBe(1);
  });
});

describe('parent correction 4/5: durable writes and lock ownership', () => {
  it('correction: init rejects a future runtime marker instead of ignoring it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-s-'));
    initRuntimeDirs(root);
    fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({ v: 999 }));
    expect(() => initRuntimeDirs(root)).toThrow(/version/i);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf-8')).v).toBe(999);
  });

  it('correction: storage IO errors are not reported as LOCK_HELD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-l-'));
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'file-not-dir');
    let code = null;
    try {
      acquireLock(path.join(blocker, 'x.lock'));
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe('STORAGE_IO_ERROR');
  });

  it('correction: releasing a foreign lock never deletes it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-lf-'));
    const lockFile = path.join(root, 'story.lock');
    const mine = acquireLock(lockFile);
    fs.writeFileSync(lockFile, JSON.stringify({ token: 'foreign-token' }));
    let code = null;
    try {
      mine.release();
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe('STORAGE_CONFLICT');
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('correction: atomic writes leave no temp residue and preserve the original', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-aw-'));
    const f = path.join(root, 'm.json');
    for (let i = 0; i < 5; i += 1) atomicWriteJson(f, { v: 1, revision: `r${i}` });
    const leftovers = fs.readdirSync(root).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(fs.readFileSync(f, 'utf-8')).revision).toBe('r4');
  });

  it('correction: cross-process lock race admits exactly one owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-xp-'));
    const lockFile = path.join(root, 'race.lock');
    const readyFile = path.join(root, 'holder.ready');
    const storeUrl = new URL('../src/storage/runtime-store.js', import.meta.url).href;
    // Holder signals readiness via a file (not timing), then holds the lock
    // for a long window so slow-starting racers still overlap the hold even
    // on saturated machines. Racers wait for the readiness signal before
    // attempting, so every attempt provably lands inside the hold window.
    const holderScript = `
      import fs from 'fs';
      import { acquireLock } from ${JSON.stringify(storeUrl)};
      const lock = acquireLock(${JSON.stringify(lockFile)});
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'held');
      console.log('HOLDER_WON ' + lock.token);
      await new Promise((r) => setTimeout(r, 20000));
      lock.release();
      console.log('HOLDER_RELEASED');
    `;
    const racerScript = `
      import { acquireLock } from ${JSON.stringify(storeUrl)};
      try {
        const lock = acquireLock(${JSON.stringify(lockFile)});
        console.log('RACER_WON');
        lock.release();
      } catch (e) {
        console.log('RACER_LOST ' + e.code);
      }
    `;
    const holder = execFile('node', ['--input-type=module', '-e', holderScript]);
    let holderOut = '';
    holder.stdout.on('data', (d) => { holderOut += d; });
    let holderStderr = '';
    holder.stderr.on('data', (d) => { holderStderr += d; });
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(readyFile)) {
      if (Date.now() > deadline) {
        try { holder.kill(); } catch { /* ignore */ }
        throw new Error(`holder never acquired the lock: ${holderStderr.slice(0, 500)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const racers = await Promise.all(
      [0, 1, 2].map(() => new Promise((resolve) => {
        execFile('node', ['--input-type=module', '-e', racerScript], { timeout: 60000 }, (err, stdout) => {
          resolve(String(stdout || ''));
        });
      })),
    );
    try { holder.kill(); } catch { /* ignore */ }
    await new Promise((resolve) => holder.on('close', resolve));
    expect(holderOut).toMatch(/HOLDER_WON/);
    for (const out of racers) {
      expect(out).toMatch(/RACER_LOST LOCK_HELD/);
    }
  }, 90000);
});

describe('parent correction 6: selectors and logger strictness', () => {
  it('correction: noteSelectors refuses to overwrite a corrupt map', async () => {
    const originalHome = process.env.FLOW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-sel-'));
    process.env.FLOW_HOME = home;
    try {
      const cfgDir = path.join(home, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'selectors.map.json'), '{broken');
      const { noteSelectors } = await import('../src/utils/selectors.js?corr6=1');
      expect(() => noteSelectors('submitButton', ['button[x="1"]'])).toThrow(/corrupt/i);
      expect(fs.readFileSync(path.join(cfgDir, 'selectors.map.json'), 'utf-8')).toBe('{broken');
      const backups = fs.readdirSync(cfgDir).filter((n) => n.includes('.corrupt.'));
      expect(backups.length).toBe(1);
    } finally {
      if (originalHome === undefined) delete process.env.FLOW_HOME;
      else process.env.FLOW_HOME = originalHome;
    }
  }, 30000);

  it('correction: logger switches roots without leaking into the old root', async () => {
    const originalHome = process.env.FLOW_HOME;
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-logA-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-corr-logB-'));
    process.env.FLOW_HOME = homeA;
    try {
      const mod = await import('../src/utils/logger.js?corr6log=1');
      mod.logger.info('message-for-A');
      process.env.FLOW_HOME = homeB;
      mod.logger.info('message-for-B');
      await mod.closeLogger();
      const filesB = fs.readdirSync(path.join(homeB, 'logs'));
      const contentB = filesB.map((f) => fs.readFileSync(path.join(homeB, 'logs', f), 'utf-8')).join('\n');
      expect(contentB).toMatch(/message-for-B/);
      const filesA = fs.readdirSync(path.join(homeA, 'logs'));
      const contentA = filesA.map((f) => fs.readFileSync(path.join(homeA, 'logs', f), 'utf-8')).join('\n');
      expect(contentA).not.toMatch(/message-for-B/);
    } finally {
      if (originalHome === undefined) delete process.env.FLOW_HOME;
      else process.env.FLOW_HOME = originalHome;
    }
  }, 30000);
});
