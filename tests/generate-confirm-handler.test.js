import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/browser/connect.js', () => ({
  getPage: () => globalThis.__confirmFakePage,
}));

vi.mock('../src/browser/safe-actions.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    openBarSettings: async () => ({ panel: { evaluate: async () => globalThis.__confirmCostText ? [globalThis.__confirmCostText] : [] } }),
    isVerifiedSettingsPanel: async () => ({ isSettings: true }),
    closeSettingsPanel: async () => true,
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

vi.mock('../src/utils/project-credit-budget.js', async (importOriginal) => ({
  ...await importOriginal(),
  reserveProjectCredits: vi.fn(() => ({ cap: 50, reserved: 1, remaining: 49 })),
}));

import { jobQueue } from '../src/queue/job-queue.js';
import { handleGenerateConfirm } from '../src/tools/generate-confirm.js';

function makeFakePage({ baseline, after, costText = '1 credits total', blocked = false, blockedAfterClick = false }) {
  globalThis.__confirmCostText = costText;
  let snapshotCalls = 0;
  return {
    content: async () => '',
    getByText: () => ({ first: () => ({ isVisible: async () => blocked || (blockedAfterClick && globalThis.__confirmClicked) }) }),
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
    delete globalThis.__confirmCostText;
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
    expect(result.status).toBe('output_detected');
    // Long window clamped to the short ceiling.
    expect(result.waitMs).toBe(30000);
    expect(result.requestedWaitMs).toBe(120000);
    expect(result.waitClamped).toBe(true);
    // Caller contract: poll queue, then download.
    expect(result.next.inspect).toBe('flow_screenshot');
    expect(result.next.then).toBe('flow_download_latest');
    expect(result.pollHint).toMatch(/not that Flow finished rendering/);
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

    const result = await handleGenerateConfirm({ job_id: prep.id, wait_ms: 1000 });

    expect(result.detected).toBe(false);
    expect(result.status).toBe('submitted');
    expect(result.waitMs).toBe(1000);
    expect(result.waitClamped).toBe(false);
    expect(result.next.inspect).toBe('flow_screenshot');
    expect(result.next.then).toBe('flow_download_latest');
    expect(jobQueue.getStatus(5).hasActiveJob).toBe(false);
  }, 30000);

  it('refuses an unknown quote instead of treating it as zero credits', async () => {
    const prep = jobQueue.createJob('image_generation', {});
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {status: 'ready_for_confirmation', type: 'image'});
    globalThis.__confirmFakePage = makeFakePage({baseline: {}, after: {}, costText: null});
    await expect(handleGenerateConfirm({job_id: prep.id})).rejects.toThrow(/unknown quote is not zero/);
    expect(globalThis.__confirmClicked).toBe(false);
  });

  it('does not click when Flow already reports insufficient credits', async () => {
    const prep = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {status: 'ready_for_confirmation', type: 'video'});
    globalThis.__confirmFakePage = makeFakePage({baseline: {}, after: {}, blocked: true});
    const result = await handleGenerateConfirm({job_id: prep.id});
    expect(result).toMatchObject({status: 'blocked', reason: 'insufficient_credits', clicked: false});
    expect(globalThis.__confirmClicked).toBe(false);
  });

  it('reports a post-click credit rejection as blocked, never submitted', async () => {
    const prep = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {status: 'ready_for_confirmation', type: 'video'});
    globalThis.__confirmFakePage = makeFakePage({baseline: {}, after: {}, blockedAfterClick: true});
    const result = await handleGenerateConfirm({job_id: prep.id, wait_ms: 1000});
    expect(result).toMatchObject({status: 'blocked', remoteStatus: 'blocked', clicked: true});
    expect(result.message).toMatch(/not confirmed/);
  });

  it('does not mistake an exhausted NEXT-generation balance for a rejected cleared draft', async () => {
    const prep = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {status: 'ready_for_confirmation', type: 'video'});
    globalThis.__confirmFakePage = makeFakePage({baseline: {promptText: 'Create video'}, after: {promptText: ''}, blockedAfterClick: true});
    const result = await handleGenerateConfirm({job_id: prep.id, wait_ms: 1000});
    expect(result.status).toBe('submitted');
    expect(result.remoteStatus).toBe('pending');
  });

  it('refuses unverified frame slots even on an old ready preparation', async () => {
    const prep = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(prep.id);
    jobQueue.completeJob(prep.id, {status: 'ready_for_confirmation', type: 'video', frame_verification: {start_frame: {verified: false}}});
    await expect(handleGenerateConfirm({job_id: prep.id})).rejects.toThrow(/frame slots unverified/);
    expect(globalThis.__confirmClicked).toBe(false);
  });
});
