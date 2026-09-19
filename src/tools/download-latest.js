import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getOutputDir } from '../utils/file-manager.js';
import { jobQueue } from '../queue/job-queue.js';
import path from 'path';

// Extension sets from the P0-3 plan (.mp4/.webm → video; .png/.jpg/.webp
// → image; .jpeg included as the same format as .jpg). Anything else
// falls through to job-type routing, then to the neutral other/ bucket.
const VIDEO_EXTS = new Set(['mp4', 'webm']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

/**
 * Pure routing decision for a download (P0-3), exported for unit tests.
 * Precedence: filename extension (ground truth about the bytes) →
 * originating job type → neutral 'other' fallback (never images/).
 */
export function resolveDownloadKind({ suggestedFilename = '', jobType = null } = {}) {
  const base = String(suggestedFilename).split('?')[0].split('#')[0];
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', detectedFrom: 'filename' };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', detectedFrom: 'filename' };
  if (jobType === 'video_generation') return { kind: 'video', detectedFrom: 'job' };
  if (jobType === 'image_generation') return { kind: 'image', detectedFrom: 'job' };
  return { kind: 'other', detectedFrom: 'fallback' };
}

export async function handleDownloadLatest() {
  const page = getPage();
  logger.info('Attempting to download latest result');

  try {
    const downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
    const downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
    if (!downloadBtnVisible) {
      await takeScreenshot(page, 'download-btn-not-found');
      return { status: 'not_found', message: 'No download button found on current page' };
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await downloadBtnLocator.click();
    const download = await downloadPromise;
    if (!download) {
      // No download event (e.g. opens preview instead) — report honestly.
      await takeScreenshot(page, 'download-no-event');
      return { status: 'download_initiated', message: 'Download button clicked, but no download event was observed. Check the project page.' };
    }
    const suggested = download.suggestedFilename() || `flow-download-${Date.now()}`;
    // P0-3: route by actual filename/job type instead of hardcoded images/.
    const jobType = jobQueue.getCurrentJob()?.type
      ?? jobQueue.getStatus(1).history[0]?.type
      ?? null;
    const { kind, detectedFrom } = resolveDownloadKind({ suggestedFilename: suggested, jobType });
    const dir = getOutputDir(kind);
    const safe = suggested.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120);
    const savePath = path.join(dir, `${Date.now()}_${safe}`);
    await download.saveAs(savePath);
    logger.info('Download saved', { path: savePath, kind, detectedFrom });
    return { status: 'downloaded', message: 'Download saved.', path: savePath, kind, detectedFrom };
  } catch (err) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
