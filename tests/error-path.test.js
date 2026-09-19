import { describe, it, expect, beforeEach } from 'vitest';
import { jobQueue } from '../src/queue/job-queue.js';
import { handleGenerateImage } from '../src/tools/generate-image.js';
import { handleGenerateVideo } from '../src/tools/generate-video.js';

// P0-4: with no browser connected, getPage() throws inside the error
// handler's own takeScreenshot(getPage(), ...) call. failJob must still
// run so the job ends 'failed' instead of stuck 'running' until the
// 5-minute watchdog. (Pre-fix, the same BROWSER_NOT_CONNECTED error was
// rethrown but the job stayed 'running' with an empty history.)
describe('P0-4 error-path job accounting (no browser connected)', () => {
  beforeEach(() => {
    jobQueue.reset();
  });

  it('generate-image fails the job instead of leaving it running', async () => {
    await expect(handleGenerateImage({ prompt: 'P0-4 probe image' })).rejects.toMatchObject({
      code: 'BROWSER_NOT_CONNECTED',
    });
    const status = jobQueue.getStatus();
    expect(status.hasActiveJob).toBe(false);
    expect(status.history[0]?.status).toBe('failed');
    expect(status.history[0]?.type).toBe('image_generation');
  });

  it('generate-video fails the job instead of leaving it running', async () => {
    await expect(handleGenerateVideo({ prompt: 'P0-4 probe video' })).rejects.toMatchObject({
      code: 'BROWSER_NOT_CONNECTED',
    });
    const status = jobQueue.getStatus();
    expect(status.hasActiveJob).toBe(false);
    expect(status.history[0]?.status).toBe('failed');
    expect(status.history[0]?.type).toBe('video_generation');
  });
});
