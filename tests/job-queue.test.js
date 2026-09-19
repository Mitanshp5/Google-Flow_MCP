import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jobQueue } from '../src/queue/job-queue.js';

describe('jobQueue', () => {
  beforeEach(() => {
    jobQueue.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    jobQueue.reset();
  });

  it('creates, starts, completes and exposes history_limit', () => {
    const job = jobQueue.createJob('image_generation', { prompt: 'x' });
    expect(job.status).toBe('queued');
    jobQueue.startJob(job.id);
    expect(jobQueue.getStatus().hasActiveJob).toBe(true);
    jobQueue.completeJob(job.id, { ok: 1 });
    const s = jobQueue.getStatus(1);
    expect(s.hasActiveJob).toBe(false);
    expect(s.history.length).toBe(1);
    expect(s.history[0].id).toBe(job.id);
  });

  it('blocks concurrent jobs with JOB_IN_PROGRESS', () => {
    const a = jobQueue.createJob('a', {});
    jobQueue.startJob(a.id);
    expect(() => jobQueue.createJob('b', {})).toThrow(/already in progress/);
  });

  it('watchdog fails stuck running jobs', () => {
    const job = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(job.id);
    // jobTimeoutMs default 300000 — advance past it
    vi.advanceTimersByTime(300001);
    const s = jobQueue.getStatus(5);
    expect(s.hasActiveJob).toBe(false);
    expect(s.history[0].status).toBe('failed');
  });

  it('reset fails active job instead of hanging waiters', () => {
    const job = jobQueue.createJob('x', {});
    jobQueue.startJob(job.id);
    jobQueue.reset();
    expect(jobQueue.getStatus().hasActiveJob).toBe(false);
    expect(jobQueue.getStatus(10).history[0].status).toBe('failed');
  });

  it('completeJob ignores non-current id (no corrupt)', () => {
    const a = jobQueue.createJob('a', {});
    jobQueue.startJob(a.id);
    jobQueue.completeJob(a.id, { ok: 1 });
    const b = jobQueue.createJob('b', {});
    jobQueue.startJob(b.id);
    // stale complete for a should not clear b
    jobQueue.completeJob(a.id, { stale: 1 });
    expect(jobQueue.getStatus().currentJob.id).toBe(b.id);
  });
});
