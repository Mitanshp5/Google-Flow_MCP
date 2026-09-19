import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';

function jobTimeoutMs() {
  return get('jobTimeoutMs', 300000);
}

function maxHistory() {
  return get('jobHistoryLimit', 50);
}

/**
 * Simple single-job queue. Only one job can run at a time.
 * Enforces JOB_TIMEOUT via watchdog; keeps bounded history.
 */
class JobQueue {
  constructor() {
    this.currentJob = null;
    this.jobs = new Map();
    this.history = [];
    this.listeners = new Map();
    this.timers = new Map();
  }

  generateId() {
    return crypto.randomUUID().slice(0, 8);
  }

  /**
   * Create a new job. Returns job ID.
   * Throws JOB_IN_PROGRESS if another job is already active.
   */
  createJob(type, params = {}) {
    if (this.currentJob && (this.currentJob.status === 'running' || this.currentJob.status === 'queued')) {
      throw new FlowError(
        ErrorCodes.JOB_IN_PROGRESS,
        `A job is already in progress: ${this.currentJob.id} (${this.currentJob.type}). Wait for it to complete or call flow_queue_reset.`,
        { currentJobId: this.currentJob.id }
      );
    }

    const id = this.generateId();
    const job = {
      id,
      type,
      params,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      progress: 0,
    };

    this.jobs.set(id, job);
    this.currentJob = job;
    logger.info('Job created', { jobId: id, type });

    return job;
  }

  armWatchdog(id) {
    this.clearWatchdog(id);
    const timeout = jobTimeoutMs();
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    const t = setTimeout(() => {
      const job = this.jobs.get(id);
      if (job && job.status === 'running' && this.currentJob?.id === id) {
        logger.error('Job timed out via watchdog', { jobId: id, timeoutMs: timeout });
        this.failJob(id, new FlowError(
          ErrorCodes.GENERATION_TIMEOUT,
          `Job ${id} timed out after ${timeout}ms. Call flow_queue_reset if the queue stays blocked.`
        ));
      }
    }, timeout);
    // Don't keep the process alive just for the watchdog.
    t.unref?.();
    this.timers.set(id, t);
  }

  clearWatchdog(id) {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  startJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (this.currentJob && this.currentJob.id !== id &&
      (this.currentJob.status === 'running' || this.currentJob.status === 'queued')) {
      throw new FlowError(ErrorCodes.JOB_IN_PROGRESS, `Another job is active: ${this.currentJob.id}`);
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.currentJob = job;
    this.armWatchdog(id);
    this.emit('start', job);
    return job;
  }

  completeJob(id, result) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    // P1-1: never mutate a terminal job — the watchdog may have already
    // failed it while a handler was still polling (independent timers).
    if (job.status === 'completed' || job.status === 'failed') {
      logger.warn('completeJob for terminal job ignored', { jobId: id, status: job.status });
      return job;
    }
    if (this.currentJob && this.currentJob.id !== id) {
      logger.warn('completeJob for non-current job ignored', { jobId: id, current: this.currentJob.id });
      return job;
    }
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    job.progress = 100;
    if (this.currentJob?.id === id) this.currentJob = null;
    this.clearWatchdog(id);
    this.pushHistory(job);
    this.emit('complete', job);
    logger.info('Job completed', { jobId: id, type: job.type });
    return job;
  }

  failJob(id, error) {
    const job = this.jobs.get(id);
    if (!job) {
      logger.error('Cannot fail unknown job', { jobId: id });
      return null;
    }
    // P1-1: symmetric with completeJob — a second terminal transition would
    // otherwise push a duplicate history entry for the same job id.
    if (job.status === 'completed' || job.status === 'failed') {
      logger.warn('failJob for terminal job ignored', { jobId: id, status: job.status });
      return job;
    }
    if (this.currentJob && this.currentJob.id !== id && job.status !== 'running' && job.status !== 'queued') {
      logger.warn('failJob for non-active job ignored', { jobId: id });
      return job;
    }
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? { message: error.message, code: error.code, stack: error.stack } : { message: String(error) };
    if (this.currentJob?.id === id) this.currentJob = null;
    this.clearWatchdog(id);
    this.pushHistory(job);
    this.emit('failed', job);
    logger.error('Job failed', { jobId: id, type: job.type, error: job.error.message });
    return job;
  }

  pushHistory(job) {
    this.history.unshift({
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error?.message || null,
    });
    const cap = maxHistory();
    if (this.history.length > cap) this.history.length = cap;
    // Bound the jobs map too (keep current + history).
    if (this.jobs.size > cap + 5) {
      const keep = new Set(this.history.map(h => h.id));
      if (this.currentJob) keep.add(this.currentJob.id);
      for (const key of [...this.jobs.keys()]) {
        if (!keep.has(key)) this.jobs.delete(key);
      }
    }
  }

  setManualAction(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'manual_action_required';
    this.emit('manual', job);
  }

  updateProgress(id, progress) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = Math.min(100, Math.max(0, progress));
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  getCurrentJob() {
    return this.currentJob;
  }

  reset() {
    // Fail the active job so waiters/listeners don't hang, then clear.
    if (this.currentJob && (this.currentJob.status === 'running' || this.currentJob.status === 'queued')) {
      try {
        this.failJob(this.currentJob.id, new Error('Job queue was forcefully reset'));
      } catch { /* ignore */ }
    }
    for (const id of [...this.timers.keys()]) this.clearWatchdog(id);
    this.currentJob = null;
    this.jobs.clear();
    logger.info('Job queue has been forcibly reset.');
  }

  getStatus(historyLimit = 5) {
    const limit = Math.min(Math.max(Number(historyLimit) || 5, 1), 100);
    return {
      hasActiveJob: this.currentJob?.status === 'running' || this.currentJob?.status === 'queued',
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        type: this.currentJob.type,
        status: this.currentJob.status,
        progress: this.currentJob.progress,
        createdAt: this.currentJob.createdAt,
      } : null,
      totalJobs: this.jobs.size,
      history: this.history.slice(0, limit),
      jobTimeoutMs: jobTimeoutMs(),
    };
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => {
      try { cb(data); } catch (err) { logger.error('Job queue listener error', { event, error: err.message }); }
    });
  }
}

export const jobQueue = new JobQueue();
export default jobQueue;
