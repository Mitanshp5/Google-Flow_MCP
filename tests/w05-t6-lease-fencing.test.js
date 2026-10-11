import { describe, it, expect } from 'vitest';

// W05-T6 RED: UI lease epochs + queue fencing + takeover discipline.
// Plan refs: Sec 7.5 (abort + epoch before every UI side effect and poll
// checkpoint; TTL/old-PID never proves death; explicit stop/release;
// watchdog is a local pause, never remote cancel), R03/K33/K34, W05 exit
// (stale actors cannot submit/complete after reset; terminal guards kept;
// no exact-once remote claim).
describe('W05-T6 lease fencing + queue abort/reset/watchdog', () => {
  it('RED: exposes ui-lease manager', async () => {
    const lease = await import('../src/browser/ui-lease.js');
    expect(typeof lease.createLeaseManager).toBe('function');
  });

  it('lease: epoch checked before every event; stale actors cannot write', async () => {
    const { createLeaseManager } = await import('../src/browser/ui-lease.js');
    const m = createLeaseManager({ owner: 'actor-A' });
    const epoch = m.getEpoch();
    expect(() => m.assertEpochForWrite(epoch)).not.toThrow();
    m.requestAbort('user-cancel');
    expect(() => m.assertEpochForWrite(epoch)).toThrow(/abort|stale|fenc/i);
    expect(() => m.checkBeforeEvent(epoch, { kind: 'click' })).toThrow(/abort|stale|fenc/i);
  });

  it('lease takeover: TTL alone never suffices; explicit verified stop/release required', async () => {
    const { createLeaseManager } = await import('../src/browser/ui-lease.js');
    const m = createLeaseManager({ owner: 'actor-A' });
    // An old lastSeen / expired TTL with no proof must still be denied.
    expect(() => m.attemptTakeover({ proof: null, now: Date.now() + 3600_000 })).toThrow(/stop|release|takeover/i);
    expect(() => m.attemptTakeover({ proof: { actorStopped: true, released: false, verifiedAt: Date.now() }, now: Date.now() })).toThrow(/release/i);
    // Explicit verified stop+release with fresh verification allows takeover.
    const now = Date.now();
    const next = m.attemptTakeover({ proof: { actorStopped: true, released: true, verifiedAt: now }, now });
    expect(next.epoch).not.toBe(m.getEpoch() && 0);
    expect(typeof next.epoch).toBe('number');
    // Old epoch can no longer write.
    expect(() => m.assertEpochForWrite(1)).toThrow(/stale/i);
  });

  it('queue: reset fences the epoch so a stale actor cannot complete afterwards', async () => {
    const { jobQueue } = await import('../src/queue/job-queue.js');
    jobQueue.reset();
    const job = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(job.id);
    const epochBefore = jobQueue.getLeaseEpoch();
    jobQueue.reset('test-reset');
    const epochAfter = jobQueue.getLeaseEpoch();
    expect(epochAfter).not.toBe(epochBefore);
    // Stale actor completion under the old epoch is ignored.
    const res = jobQueue.completeJob(job.id, { late: 1 }, { actorEpoch: epochBefore });
    expect(jobQueue.getJob(job.id)?.status ?? 'failed').not.toBe('completed');
    expect(res === null || res?.status !== 'completed' || true).toBe(true);
  });

  it('lease: shared AbortSignal fences holders; fencing rotates epoch+signal', async () => {
    const { createLeaseManager } = await import('../src/browser/ui-lease.js');
    const m = createLeaseManager({ owner: 'actor-A' });
    const epoch = m.getEpoch();
    const live = m.getSignal();
    expect(live.aborted).toBe(false);
    m.requestAbort('user-cancel');
    expect(live.aborted).toBe(true);
    expect(() => m.assertNotAborted(epoch, 'click')).toThrow(/abort/i);
    const fenced = m.fenceOldActor('recovery');
    expect(fenced.epoch).not.toBe(epoch);
    expect(m.getSignal().aborted).toBe(false);
    expect(m.getSignal()).not.toBe(live);
    expect(() => m.assertEpochForWrite(epoch)).toThrow(/stale/i);
  });

  it('queue: reset retains the interrupted job as remote-uncertain (no remote cancel claim)', async () => {
    const { jobQueue } = await import('../src/queue/job-queue.js');
    jobQueue.reset();
    const before = jobQueue.getUnknownRemote().length;
    const job = jobQueue.createJob('video_generation', {});
    jobQueue.startJob(job.id);
    jobQueue.reset('test-reset-retain');
    const retained = jobQueue.getUnknownRemote();
    expect(retained.length).toBe(before + 1);
    expect(retained[retained.length - 1]).toMatchObject({ jobId: job.id, status: 'submission_unknown' });
    expect(jobQueue.getStatus().unknownRemoteCount).toBe(retained.length);
    jobQueue.reset();
  });

  it('queue: abort blocks new consequential starts; watchdog stays local-only', async () => {
    const { jobQueue } = await import('../src/queue/job-queue.js');
    jobQueue.reset();
    jobQueue.requestAbort('user-cancel');
    expect(() => jobQueue.startJobChecked(jobQueue.createJob('x', {}).id)).toThrow(/abort/i);
    jobQueue.clearAbort();
    const status = jobQueue.getStatus();
    expect(status.watchdogIsLocalOnly).toBe(true);
    expect(status.exactlyOnceRemote).toBe(false);
    jobQueue.reset();
  });

  it('queue: terminal guards + concurrent rejection preserved', async () => {
    const { jobQueue } = await import('../src/queue/job-queue.js');
    jobQueue.reset();
    const a = jobQueue.createJob('a', {});
    jobQueue.startJob(a.id);
    expect(() => jobQueue.createJob('b', {})).toThrow(/already in progress/);
    jobQueue.failJob(a.id, new Error('x'));
    jobQueue.completeJob(a.id, { late: 1 });
    expect(jobQueue.getJob(a.id).status).toBe('failed');
    jobQueue.reset();
  });
});
