import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withUiTransaction } from '../src/browser/ui-transaction.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { createOperationStore, mintChildApproval } from '../src/domain/operations.js';
import { digestRequest } from '../src/domain/contracts.js';
import { readJournal } from '../src/storage/journal.js';
import { executeDurableSubmission } from '../src/domain/submission-adapter.js';

// Explicit LOCAL fixture evidence only. These objects are not live verification.
function localFixture(epoch) {
  const now = Date.now();
  const tempBase = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
  const opStore = createOperationStore(fs.mkdtempSync(path.join(tempBase, 'w05-regression-')));
  const requestPayload = { prompt: 'local fixture cat', type: 'image', model: 'Imagen 4', ratio: '1:1', quantity: 1 };
  const child = mintChildApproval({ policyId: 'local-fixture', maxCredits: 20 }, {
    requestDigest: digestRequest(requestPayload), accountKey: 'fixture@example.com', projectId: 'fixture-project', model: 'Imagen 4', quoteTotal: 5,
  });
  const quote = { total: 5, unit: 'total', model: 'Imagen 4', feature: 'image', quantity: 1, observedAt: now, expiresAt: now + 30_000 };
  const policyContext = {
    account: { expected: 'fixture@example.com', observed: 'fixture@example.com', verified: true, observedAt: now },
    project: { requiredId: 'fixture-project', observedId: 'fixture-project' },
    verification: Object.fromEntries(['account', 'settings', 'quote', 'capabilities'].map(key => [key, {
      status: 'verified', observedAt: now, origin: `local-fixture:${key}`,
    }])),
    quote,
    capabilities: { supported: true, model: 'Imagen 4', feature: 'image', observedAt: now },
    approval: child,
    requestDigest: digestRequest(requestPayload),
  };
  let calls = 0;
  const args = {
    epoch, opStore, requestPayload, observedAccount: 'fixture@example.com', observedProjectId: 'fixture-project',
    verifiedSettings: { model: 'Imagen 4', ratio: '1:1', quantity: 1 },
    baseline: { ids: ['existing-local-id'], observedAt: now }, quote,
    approvalChild: child, approvals: new Map([[child.id, child]]), ledger: { reserved: 0, maxAuthorized: 20 },
    policyContext, executionMode: 'local-fixture', remoteSubmitFn: async () => { calls++; return { local: true }; },
  };
  return { args, calls: () => calls };
}

function expectUntouched(fixture) {
  const { args } = fixture;
  expect(fixture.calls()).toBe(0);
  expect(args.approvalChild.consumed).toBe(false);
  expect(args.ledger.reserved).toBe(0);
  expect(args.opStore.isChildConsumed(args.approvalChild.id)).toBe(false);
  expect(readJournal(args.opStore.journalDir).records).toEqual([]);
  for (const op of args.opStore.listOperations()) {
    expect(op.status).toBe('prepared');
    expect(op.attempts).toEqual([]);
    expect(op.reservationAmount).toBe(0);
  }
}

function rebindRequest(args) {
  const digest = digestRequest(args.requestPayload);
  args.approvalChild.requestDigest = digest;
  args.approvalChild.digest = digest;
  args.policyContext.requestDigest = digest;
}

beforeEach(() => jobQueue.reset());

describe('repair A: require actual bound evidence before local invocation', () => {
  const negatives = [
    ['observed counterexample: empty settings and bare quote without policy context', a => { a.verifiedSettings = {}; a.quote = { total: 5 }; delete a.policyContext; }],
    ['missing policy context despite complete observations', a => { delete a.policyContext; }],
    ['missing quote unit', a => { delete a.quote.unit; }],
    ['missing quote observedAt', a => { delete a.quote.observedAt; }],
    ['missing quote expiresAt', a => { delete a.quote.expiresAt; }],
    ['missing quote model', a => { delete a.quote.model; }],
    ['missing quote feature', a => { delete a.quote.feature; }],
    ['missing quote quantity', a => { delete a.quote.quantity; }],
    ['null capability evidence', a => { a.policyContext.capabilities = null; }],
    ['unsupported capability', a => { a.policyContext.capabilities.supported = false; }],
    ['unknown capability', a => { delete a.policyContext.capabilities.supported; }],
    ['wrong capability model', a => { a.policyContext.capabilities.model = 'wrong'; }],
    ['empty settings', a => { a.verifiedSettings = {}; }],
    ['wrong settings model', a => { a.verifiedSettings.model = 'wrong'; }],
    ['wrong settings ratio', a => { a.verifiedSettings.ratio = '16:9'; }],
    ['wrong settings quantity', a => { a.verifiedSettings.quantity = 2; }],
    ['requested duration missing in settings', a => { a.requestPayload.duration = 8; rebindRequest(a); }],
    ['requested quality differs in settings', a => { a.requestPayload.quality = '1080p'; a.verifiedSettings.quality = '720p'; rebindRequest(a); }],
    ['wrong expected account', a => { a.policyContext.account.expected = 'other@example.com'; }],
    ['policy account observation differs from actual', a => { a.observedAccount = 'other@example.com'; }],
    ['wrong required project', a => { a.policyContext.project.requiredId = 'other-project'; }],
    ['policy project observation differs from actual', a => { a.observedProjectId = 'other-project'; }],
    ['quote model differs from request', a => { a.quote.model = 'wrong'; }],
    ['quote feature differs from request', a => { a.quote.feature = 'video'; }],
    ['quote quantity differs from request', a => { a.quote.quantity = 2; }],
    ['policy quote differs from observed quote', a => { a.policyContext.quote = { ...a.quote, total: 0 }; }],
    ['stale quote cannot be revived by caller now', a => { a.quote.observedAt -= 120_000; a.policyContext.now = a.quote.observedAt; }],
    ['future quote cannot be revived by caller now', a => { a.quote.observedAt += 120_000; a.policyContext.now = a.quote.observedAt; }],
    ['stale account readback', a => { a.policyContext.account.observedAt -= 60_000; }],
    ['future verification readback', a => { a.policyContext.verification.settings.observedAt += 60_000; }],
    ['null required verification', a => { a.policyContext.verification.quote = null; }],
    ['missing evidence origin', a => { delete a.policyContext.verification.settings.origin; }],
    ['actual prompt changed after approval', a => { a.requestPayload.prompt = 'changed'; }],
    ['substituted policy approval', a => { a.policyContext.approval = { ...a.approvalChild, nonce: 'substituted' }; }],
    ['approval registry scope differs', a => { a.approvals.set(a.approvalChild.id, { ...a.approvalChild, accountKey: 'other@example.com' }); }],
  ];
  it.each(negatives)('denies %s without consumption or invocation', async (_name, mutate) => {
    await withUiTransaction(async ({ epoch }) => {
      const fixture = localFixture(epoch);
      mutate(fixture.args);
      let error;
      try { await executeDurableSubmission(fixture.args); } catch (caught) { error = caught; }
      expect(error).toBeDefined();
      expect(error.code).toMatch(/POLICY_DENIED|BINDING_UNAVAILABLE/);
      expectUntouched(fixture);
    });
  });

  it('retains exact durable ordering and single use for complete local fixture evidence', async () => {
    await withUiTransaction(async ({ epoch }) => {
      const fixture = localFixture(epoch);
      const { args } = fixture;
      let invocations = 0;
      args.remoteSubmitFn = async ({ operationId, bounded }) => {
        invocations++;
        expect(args.approvalChild.consumed).toBe(true);
        expect(args.ledger.reserved).toBe(5);
        expect(args.opStore.isChildConsumed(args.approvalChild.id)).toBe(true);
        expect(readJournal(args.opStore.journalDir).records.map(r => r.kind)).toEqual(['intent', 'attempt', 'approval', 'reservation']);
        expect(bounded.status).toBe('submission_unknown');
        expect(args.opStore.getOperation(operationId).status).toBe('submission_unknown');
        return { local: true };
      };
      const result = await executeDurableSubmission(args);
      expect(result.status).toBe('submitted');
      expect(invocations).toBe(1);
      await expect(executeDurableSubmission(args)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(args.ledger.reserved).toBe(5);
      expect(args.opStore.listOperations()).toHaveLength(1);
      expect(invocations).toBe(1);
    });
  });

  it('retains unknown status and reservation when enabled local callback fails', async () => {
    await withUiTransaction(async ({ epoch }) => {
      const fixture = localFixture(epoch);
      fixture.args.remoteSubmitFn = async () => { throw new Error('local callback failure'); };
      await expect(executeDurableSubmission(fixture.args)).rejects.toThrow('local callback failure');
      expect(fixture.args.approvalChild.consumed).toBe(true);
      expect(fixture.args.ledger.reserved).toBe(5);
      expect(fixture.args.opStore.listOperations()[0].status).toBe('submission_unknown');
      expect(fixture.args.opStore.isChildConsumed(fixture.args.approvalChild.id)).toBe(true);
    });
  });
});

function storeFiles(store) {
  return Object.fromEntries(fs.readdirSync(store.rootDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      return [path.relative(store.rootDir, file), fs.readFileSync(file, 'hex')];
    }));
}

describe('repair B: production is known not invoked before any durable side effect', () => {
  it.each([
    ['default mode without callback', args => { delete args.executionMode; args.remoteSubmitFn = null; }],
    ['callback alone in default mode', args => { delete args.executionMode; }],
    ['explicit production with callback', args => { args.executionMode = 'production'; }],
    ['unknown mode with callback', args => { args.executionMode = 'allow-live'; }],
    ['fixture mode without callback', args => { args.remoteSubmitFn = null; }],
  ])('blocks %s with valid approval and untouched storage', async (_name, mutate) => {
    await withUiTransaction(async ({ epoch }) => {
      const fixture = localFixture(epoch);
      const before = storeFiles(fixture.args.opStore);
      mutate(fixture.args);
      await expect(executeDurableSubmission(fixture.args)).rejects.toMatchObject({
        code: 'MANUAL_VERIFICATION_REQUIRED', details: { status: 'blocked', invocation: 'not-invoked' },
      });
      expectUntouched(fixture);
      expect(fixture.args.opStore.listOperations()).toEqual([]);
      expect(storeFiles(fixture.args.opStore)).toEqual(before);
    });
  });

  it('preserves an existing unknown reservation and journal when production is blocked', async () => {
    await withUiTransaction(async ({ epoch }) => {
      const fixture = localFixture(epoch);
      fixture.args.remoteSubmitFn = async () => { throw new Error('local unknown'); };
      await expect(executeDurableSubmission(fixture.args)).rejects.toThrow('local unknown');
      const before = storeFiles(fixture.args.opStore);
      delete fixture.args.executionMode;
      fixture.args.remoteSubmitFn = null;
      await expect(executeDurableSubmission(fixture.args)).rejects.toMatchObject({
        code: 'MANUAL_VERIFICATION_REQUIRED', details: { status: 'blocked', invocation: 'not-invoked' },
      });
      expect(fixture.args.ledger.reserved).toBe(5);
      expect(fixture.args.approvalChild.consumed).toBe(true);
      expect(fixture.args.opStore.listOperations()).toHaveLength(1);
      expect(fixture.args.opStore.listOperations()[0].status).toBe('submission_unknown');
      expect(storeFiles(fixture.args.opStore)).toEqual(before);
    });
  });
});
