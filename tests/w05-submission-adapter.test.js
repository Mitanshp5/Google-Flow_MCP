import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getUiLease, withUiTransaction, assertUiCurrent, checkpointUi } from '../src/browser/ui-transaction.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { createOperationStore, mintChildApproval } from '../src/domain/operations.js';
import { readJournal } from '../src/storage/journal.js';
import { executeDurableSubmission } from '../src/domain/submission-adapter.js';

function tmpDir(prefix = 'w05-adapter-test') {
  const base = process.env.TEMP || process.env.TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

// Fully populated LOCAL fixture evidence, never live verification.
function localPolicyEvidence(now, requestPayload, observedAccount, observedProjectId, child, total) {
  const quote = {
    total, unit: 'total', model: requestPayload.model, feature: requestPayload.type,
    quantity: requestPayload.quantity, observedAt: now, expiresAt: now + 30_000,
  };
  return {
    quote,
    policyContext: {
      account: { expected: observedAccount, observed: observedAccount, verified: true, observedAt: now },
      project: { requiredId: observedProjectId, observedId: observedProjectId },
      verification: Object.fromEntries(['account', 'settings', 'quote', 'capabilities'].map(key => [key, {
        status: 'verified', observedAt: now, origin: 'local-fixture:' + key,
      }])),
      quote,
      capabilities: { supported: true, model: requestPayload.model, feature: requestPayload.type, observedAt: now },
      requestDigest: child.requestDigest,
      approval: child,
    },
  };
}

describe('W05/W06 Submission Adapter & Lease Fencing Integration', () => {
  let rootDir;
  let opStore;

  beforeEach(() => {
    jobQueue.reset();
    rootDir = tmpDir();
    opStore = createOperationStore(rootDir);
  });

  // =========================================================================
  // 1. Reset/Abort during a handler & UI Ownership Coordination
  // =========================================================================
  describe('Reset and Abort Fencing Coordinator', () => {
    it('calling jobQueue.reset() inside withUiTransaction fences UI lease epoch and queue epoch in lockstep', async () => {
      await withUiTransaction(async ({ epoch }) => {
        expect(epoch).toBeGreaterThan(0);
        const capturedEpoch = epoch;
        expect(getUiLease().getEpoch()).toBe(capturedEpoch);
        expect(jobQueue.getLeaseEpoch()).toBe(capturedEpoch);
        expect(getUiLease().isCurrent(capturedEpoch)).toBe(true);

        // Reset occurs mid-transaction
        jobQueue.reset('mid-flight-test-reset');

        const postResetEpoch = getUiLease().getEpoch();
        const postResetQueueEpoch = jobQueue.getLeaseEpoch();

        expect(postResetEpoch).toBe(capturedEpoch + 1);
        expect(postResetQueueEpoch).toBe(postResetEpoch);
        expect(getUiLease().isCurrent(capturedEpoch)).toBe(false);
        expect(checkpointUi(capturedEpoch)).toBe(false);
        expect(() => assertUiCurrent(capturedEpoch)).toThrow(/stale-epoch/i);
      });
    });

    it('calling flow_queue_reset through actual dispatcher fences UI lease epoch and queue epoch in lockstep', async () => {
      const { handleToolCall } = await import('../src/index.js');
      await withUiTransaction(async ({ epoch }) => {
        expect(epoch).toBeGreaterThan(0);
        const capturedUiEpoch = epoch;
        expect(getUiLease().getEpoch()).toBe(capturedUiEpoch);
        expect(jobQueue.getLeaseEpoch()).toBe(capturedUiEpoch);
        expect(getUiLease().isCurrent(capturedUiEpoch)).toBe(true);

        // Call flow_queue_reset through the actual MCP dispatcher
        const res = await handleToolCall('flow_queue_reset', {});
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.status).toBe('success');

        const postResetUiEpoch = getUiLease().getEpoch();
        const postResetQueueEpoch = jobQueue.getLeaseEpoch();

        expect(postResetUiEpoch).toBe(capturedUiEpoch + 1);
        expect(postResetQueueEpoch).toBe(capturedUiEpoch + 1);
        expect(getUiLease().isCurrent(capturedUiEpoch)).toBe(false);
        expect(checkpointUi(capturedUiEpoch)).toBe(false);
        expect(() => assertUiCurrent(capturedUiEpoch)).toThrow(/stale-epoch/i);
      });
    });

    it('stale actor cannot complete a job after reset occurs', async () => {
      const job = jobQueue.createJob('image_generation', {});
      jobQueue.startJob(job.id);

      await withUiTransaction(async ({ epoch }) => {
        const actorEpoch = epoch;

        // Reset queue while handler is working
        jobQueue.reset('abort-running');

        // Checkpoint before publish fails
        expect(checkpointUi(actorEpoch)).toBe(false);
        expect(() => assertUiCurrent(actorEpoch)).toThrow(/stale-epoch/i);

        // Attempting to complete the job with stale actor epoch is rejected
        const res = jobQueue.completeJob(job.id, { success: true }, { actorEpoch });
        expect(res).not.toMatchObject({ status: 'completed' });
      });
    });

    it('jobQueue.requestAbort fences the UI lease and aborts the signal', () => {
      const initialEpoch = getUiLease().getEpoch();
      jobQueue.requestAbort('user-cancel');

      expect(getUiLease().getEpoch()).toBe(initialEpoch + 1);
      expect(jobQueue.getLeaseEpoch()).toBe(initialEpoch + 1);
      expect(getUiLease().isCurrent(initialEpoch)).toBe(false);
      expect(getUiLease().isAborted()).toBe(true);

      // Clearing abort restores live generation
      jobQueue.clearAbort();
      expect(getUiLease().isAborted()).toBe(false);
    });
  });

  // =========================================================================
  // 2. Verified Bindings & Baselines Enforcement
  // =========================================================================
  describe('Verified Bindings Enforcement', () => {
    it('denies submission when observed account is missing or not an email', async () => {
      await withUiTransaction(async ({ epoch }) => {
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload: { prompt: 'a cat', type: 'image' },
          observedAccount: null,
          observedProjectId: 'proj-123',
          verifiedSettings: { model: 'Nano Banana Pro', ratio: '1:1', quantity: 1 },
          baseline: { ids: [], observedAt: Date.now() },
          quote: { total: 0, unit: 'free' },
        })).rejects.toThrow(/account identity is unavailable/i);
      });
    });

    it('denies submission when observed project ID is missing', async () => {
      await withUiTransaction(async ({ epoch }) => {
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload: { prompt: 'a cat', type: 'image' },
          observedAccount: 'user@gmail.com',
          observedProjectId: null,
          verifiedSettings: { model: 'Nano Banana Pro', ratio: '1:1', quantity: 1 },
          baseline: { ids: [], observedAt: Date.now() },
          quote: { total: 0, unit: 'free' },
        })).rejects.toThrow(/project ID is unavailable/i);
      });
    });

    it('denies submission when verified settings are missing', async () => {
      await withUiTransaction(async ({ epoch }) => {
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload: { prompt: 'a cat', type: 'image' },
          observedAccount: 'user@gmail.com',
          observedProjectId: 'proj-123',
          verifiedSettings: null,
          baseline: { ids: [], observedAt: Date.now() },
          quote: { total: 0, unit: 'free' },
        })).rejects.toThrow(/settings binding is unavailable/i);
      });
    });

    it('denies submission when observed baseline is missing', async () => {
      await withUiTransaction(async ({ epoch }) => {
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload: { prompt: 'a cat', type: 'image' },
          observedAccount: 'user@gmail.com',
          observedProjectId: 'proj-123',
          verifiedSettings: { model: 'Nano Banana Pro', ratio: '1:1', quantity: 1 },
          baseline: null,
          quote: { total: 0, unit: 'free' },
        })).rejects.toThrow(/baseline is unavailable/i);
      });
    });

    it('denies submission when cost quote is missing or non-finite', async () => {
      await withUiTransaction(async ({ epoch }) => {
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload: { prompt: 'a cat', type: 'image' },
          observedAccount: 'user@gmail.com',
          observedProjectId: 'proj-123',
          verifiedSettings: { model: 'Nano Banana Pro', ratio: '1:1', quantity: 1 },
          baseline: { ids: [], observedAt: Date.now() },
          quote: null,
        })).rejects.toThrow(/quote is unavailable/i);
      });
    });

    it('denies submission when approval child is missing without spend authorization', async () => {
      await withUiTransaction(async ({ epoch }) => {
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload: { prompt: 'a cat', type: 'image' },
          observedAccount: 'user@gmail.com',
          observedProjectId: 'proj-123',
          verifiedSettings: { model: 'Nano Banana Pro', ratio: '1:1', quantity: 1 },
          baseline: { ids: ['existing-img-1'], observedAt: Date.now() },
          quote: { total: 1, unit: 'credits' },
          approvalChild: null,
        })).rejects.toThrow(/approval child and credit ledger/i);
      });
    });
  });

  // =========================================================================
  // 3. Durable Commit, Approval Ordering & Journal Records
  // =========================================================================
  describe('Durable Commit, Ordering & Failure Rollback', () => {
    it('orders approval consumption, credit reservation, CAS write, and journal appends', async () => {
      await withUiTransaction(async ({ epoch }) => {
        const now = Date.now();
        const requestPayload = { prompt: 'sunset over lake', model: 'Imagen 4', ratio: '16:9', quantity: 1, type: 'image' };
        const observedAccount = 'creator@gmail.com';
        const observedProjectId = 'proj-999';

        const { digestRequest } = await import('../src/domain/contracts.js');
        const digest = digestRequest(requestPayload);

        const child = mintChildApproval(
          { policyId: 'policy-main', maxCredits: 20 },
          { index: 0, requestDigest: digest, accountKey: observedAccount, projectId: observedProjectId, model: 'Imagen 4', quoteTotal: 5 },
        );
        const approvals = new Map([[child.id, child]]);
        const ledger = { reserved: 0, maxAuthorized: 20 };

        let remoteClicked = false;
        const fakeSubmit = async ({ operationId, bounded }) => {
          remoteClicked = true;
          return { ack: true, operationId, status: bounded.status };
        };

        const result = await executeDurableSubmission({
          executionMode: 'local-fixture',
          epoch,
          opStore,
          requestPayload,
          observedAccount,
          observedProjectId,
          verifiedSettings: { model: 'Imagen 4', ratio: '16:9', quantity: 1 },
          refs: ['ref1.png'],
          baseline: { ids: ['old-img-1', 'old-img-2'], observedAt: now },
          ...localPolicyEvidence(now, requestPayload, observedAccount, observedProjectId, child, 5),
          approvalChild: child,
          approvals,
          ledger,
          remoteSubmitFn: fakeSubmit,
        });

        expect(result.status).toBe('submitted');
        expect(remoteClicked).toBe(true);

        // Verify in-memory state: approval consumed, ledger reserved
        expect(child.consumed).toBe(true);
        expect(ledger.reserved).toBe(5);

        // Verify durable storage: operation CAS updated, status submission_unknown
        const savedOp = opStore.getOperation(result.operationId);
        expect(savedOp.status).toBe('submission_unknown');
        expect(savedOp.approvalChildId).toBe(child.id);
        expect(savedOp.reservationAmount).toBe(5);
        expect(savedOp.accountRef).toBe(observedAccount);
        expect(savedOp.projectRef).toBe(observedProjectId);

        // Verify durable child marker exists on disk
        expect(opStore.isChildConsumed(child.id)).toBe(true);

        // Verify journal entries recorded in exact order: intent -> attempt -> approval -> reservation
        const { records } = readJournal(opStore.journalDir);
        const kinds = records.map(e => e.kind);
        expect(kinds).toEqual(['intent', 'attempt', 'approval', 'reservation']);

        // Verify double-spend is blocked: second invocation with same child throws POLICY_DENIED / APPROVAL_CONSUMED
        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          epoch,
          opStore,
          requestPayload,
          observedAccount,
          observedProjectId,
          verifiedSettings: { model: 'Imagen 4', ratio: '16:9', quantity: 1 },
          refs: ['ref1.png'],
          baseline: { ids: ['old-img-1'], observedAt: now },
          ...localPolicyEvidence(now, requestPayload, observedAccount, observedProjectId, child, 5),
          approvalChild: child,
          approvals,
          ledger,
          remoteSubmitFn: fakeSubmit,
        })).rejects.toThrow(/denied|consumed/i);
      });
    });

    it('rolls back in-memory flags and markers when commit is denied', async () => {
      await withUiTransaction(async ({ epoch }) => {
        const now = Date.now();
        const requestPayload = { prompt: 'robot dog', model: 'Imagen 4', ratio: '1:1', quantity: 1, type: 'image' };
        const observedAccount = 'creator@gmail.com';
        const observedProjectId = 'proj-999';

        const { digestRequest } = await import('../src/domain/contracts.js');
        const digest = digestRequest(requestPayload);

        // Child authorizes only 2 credits, but quote requires 10
        const child = mintChildApproval(
          { policyId: 'policy-main', maxCredits: 2 },
          { index: 0, requestDigest: digest, accountKey: observedAccount, projectId: observedProjectId, model: 'Imagen 4', quoteTotal: 2 },
        );
        const approvals = new Map([[child.id, child]]);
        const ledger = { reserved: 0, maxAuthorized: 10 };

        await expect(executeDurableSubmission({
          executionMode: 'local-fixture',
          remoteSubmitFn: async () => ({ local: true }),
          epoch,
          opStore,
          requestPayload,
          observedAccount,
          observedProjectId,
          verifiedSettings: { model: 'Imagen 4', ratio: '1:1', quantity: 1 },
          baseline: { ids: [], observedAt: now },
          ...localPolicyEvidence(now, requestPayload, observedAccount, observedProjectId, child, 10),
          approvalChild: child,
          approvals,
          ledger,
        })).rejects.toThrow(/denied|exceeds/i);

        // Rollback verified: child is NOT consumed, ledger is NOT reserved
        expect(child.consumed).toBeFalsy();
        expect(ledger.reserved).toBe(0);
        expect(opStore.isChildConsumed(child.id)).toBe(false);
      });
    });

    it('production baseline without remoteSubmitFn blocks before consumption or invocation', async () => {
      await withUiTransaction(async ({ epoch }) => {
        const now = Date.now();
        const requestPayload = { prompt: 'mountain sunset', model: 'Imagen 4', ratio: '1:1', quantity: 1, type: 'image' };
        const observedAccount = 'user@gmail.com';
        const observedProjectId = 'p-proj';

        const { digestRequest } = await import('../src/domain/contracts.js');
        const digest = digestRequest(requestPayload);

        const child = mintChildApproval(
          { policyId: 'policy-local', maxCredits: 10 },
          { index: 0, requestDigest: digest, accountKey: observedAccount, projectId: observedProjectId, model: 'Imagen 4', quoteTotal: 2 },
        );
        const approvals = new Map([[child.id, child]]);
        const ledger = { reserved: 0, maxAuthorized: 10 };

        // Disabled production must leave durable state untouched.
        let caughtErr = null;
        try {
          await executeDurableSubmission({
            epoch,
            opStore,
            requestPayload,
            observedAccount,
            observedProjectId,
            verifiedSettings: { model: 'Imagen 4', ratio: '1:1', quantity: 1 },
            baseline: { ids: ['existing-1'], observedAt: now },
            ...localPolicyEvidence(now, requestPayload, observedAccount, observedProjectId, child, 2),
            approvalChild: child,
            approvals,
            ledger,
            executionMode: 'production',
            remoteSubmitFn: null, // Production default
          });
        } catch (err) {
          caughtErr = err;
        }

        expect(caughtErr).not.toBeNull();
        expect(caughtErr.code).toBe('MANUAL_VERIFICATION_REQUIRED');
        expect(caughtErr.details).toMatchObject({ status: 'blocked', invocation: 'not-invoked' });

        expect(child.consumed).toBe(false);
        expect(ledger.reserved).toBe(0);
        expect(opStore.isChildConsumed(child.id)).toBe(false);
        expect(opStore.listOperations()).toEqual([]);
        expect(readJournal(opStore.journalDir).records).toEqual([]);
      });
    });
  });
});
