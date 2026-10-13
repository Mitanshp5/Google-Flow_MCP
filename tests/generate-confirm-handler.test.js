import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/browser/connect.js', () => ({
  getPage: () => globalThis.__confirmFakePage,
}));

vi.mock('../src/browser/safe-actions.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    findActionButton: async () => ({
      locator: {
        isDisabled: async () => false,
        click: async () => { globalThis.__confirmClicked = true; },
      },
    }),
  };
});

vi.mock('../src/utils/screenshots.js', () => ({
  takeScreenshot: async () => null,
}));

import { jobQueue } from '../src/queue/job-queue.js';
import { handleGenerateConfirm } from '../src/tools/generate-confirm.js';

function makeFakePage({ baseline, after, costText = null }) {
  let snapshotCalls = 0;
  return {
    evaluate: async (fn) => {
      const src = String(typeof fn === 'function' ? fn.toString() : fn);
      if (src.includes('credits')) return costText;
      snapshotCalls += 1;
      if (snapshotCalls === 1) return { ...baseline };
      return { ...after };
    },
    waitForTimeout: async () => {},
    url: () => 'https://flow.google.com/project/p1',
  };
}

describe('handleGenerateConfirm short-wait handler', () => {
  beforeEach(() => {
    jobQueue.reset();
    globalThis.__confirmClicked = false;
  });
  afterEach(() => {
    jobQueue.reset();
    delete globalThis.__confirmFakePage;
    delete globalThis.__confirmClicked;
  });

  it('detects a new media id on the first poll and completes promptly (no 120s block)', async () => {
    const prep = jobQueue.createJob('image_generation', { prompt: 'x' });
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {
      status: 'ready_for_confirmation', type: 'image', model_used: 'Nano Banana Pro',
      quantity: 1, settings_verification: { verified: true },
    });

    globalThis.__confirmFakePage = makeFakePage({
      baseline: { count: 3, ids: ['aaa'], tiles: ['t1'] },
      after: { count: 3, ids: ['aaa', 'new-838d4ab3'], tiles: ['t1'] },
    });

    const started = Date.now();
    const result = await handleGenerateConfirm({ job_id: prep.id, wait_ms: 120000 });
    const elapsed = Date.now() - started;

    expect(globalThis.__confirmClicked).toBe(true);
    expect(result.detected).toBe(true);
    expect(result.status).toBe('completed');
    // Long window clamped to the short ceiling.
    expect(result.waitMs).toBe(30000);
    expect(result.requestedWaitMs).toBe(120000);
    expect(result.waitClamped).toBe(true);
    // Caller contract: poll queue, then download.
    expect(result.next.poll).toBe('flow_queue_status');
    expect(result.next.then).toBe('flow_download_latest');
    expect(result.pollHint).toMatch(/flow_queue_status/);
    // Queue is free immediately — hasActiveJob=false, history completed.
    const qs = jobQueue.getStatus(5);
    expect(qs.hasActiveJob).toBe(false);
    expect(qs.history[0].id).toBe(result.jobId);
    expect(qs.history[0].status).toBe('completed');
    // Early exit: nowhere near the 120s (or even 30s) window.
    expect(elapsed).toBeLessThan(15000);
  });

  it('returns submitted (not completed) when nothing lands, still with the poll-then-download contract', async () => {
    const prep = jobQueue.createJob('image_generation', { prompt: 'y' });
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {
      status: 'ready_for_confirmation', type: 'image', model_used: 'Nano Banana Pro',
      quantity: 1, settings_verification: { verified: true },
    });
    const snap = { count: 3, ids: ['aaa'], tiles: ['t1'] };
    globalThis.__confirmFakePage = makeFakePage({ baseline: snap, after: { ...snap } });

    const result = await handleGenerateConfirm({ job_id: prep.id, wait_ms: 20000 });

    expect(result.detected).toBe(false);
    expect(result.status).toBe('submitted');
    expect(result.waitMs).toBe(20000);
    expect(result.waitClamped).toBe(false);
    expect(result.next.poll).toBe('flow_queue_status');
    expect(result.next.then).toBe('flow_download_latest');
    expect(jobQueue.getStatus(5).hasActiveJob).toBe(false);
  }, 30000);
});
