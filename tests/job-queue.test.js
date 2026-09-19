import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jobQueue } from '../src/queue/job-queue.js';
import { resolveVideoPollCeilingMs } from '../src/tools/generate-video.js';

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

  it('P1-1: completeJob after failJob is ignored (one history entry)', () => {
    // The exact watchdog-vs-poll race: watchdog fails at t≈300s, the still-
    // polling handler calls completeJob later. Status must stay failed with
    // a single history entry for the job id.
    const job = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(job.id);
    jobQueue.failJob(job.id, new Error('timed out'));
    jobQueue.completeJob(job.id, { late: 1 });
    expect(jobQueue.getJob(job.id).status).toBe('failed');
    expect(jobQueue.getJob(job.id).result).toBe(null);
    expect(jobQueue.getStatus(50).history.filter((h) => h.id === job.id).length).toBe(1);
  });

  it('P1-1: failJob after completeJob is ignored (no double history)', () => {
    const job = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(job.id);
    jobQueue.completeJob(job.id, { ok: 1 });
    jobQueue.failJob(job.id, new Error('late watchdog'));
    expect(jobQueue.getJob(job.id).status).toBe('completed');
    expect(jobQueue.getStatus(50).history.filter((h) => h.id === job.id).length).toBe(1);
  });

  it('P1-1: poll ceiling stays under an active watchdog', () => {
    // Defaults: floor max(120000, 360000)=360000, watchdog 300000 → 270000.
    expect(resolveVideoPollCeilingMs()).toBe(270000);
    // Disabled watchdog (0/non-finite): legacy floor stands alone.
    expect(resolveVideoPollCeilingMs({ jobTimeoutMs: 0 })).toBe(360000);
    expect(resolveVideoPollCeilingMs({ jobTimeoutMs: Number.NaN })).toBe(360000);
    // Small watchdog: handler still settles strictly first (30s margin).
    expect(resolveVideoPollCeilingMs({ jobTimeoutMs: 60000 })).toBe(30000);
    // Huge watchdog: floor binds, never exceeded.
    expect(resolveVideoPollCeilingMs({ jobTimeoutMs: 3600000 })).toBe(360000);
    expect(resolveVideoPollCeilingMs({ generationTimeoutMs: 600000, jobTimeoutMs: 900000 })).toBe(600000);
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
