import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getOutputDir } from '../utils/file-manager.js';
import path from 'path';

export async function handleDownloadLatest(args = {}) {
  const page = getPage();
  logger.info('Attempting to download latest result');

  try {
    const downloadBtnLocator = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
    const downloadBtnVisible = await downloadBtnLocator.isVisible().catch(() => false);
    if (!downloadBtnVisible) {
      await takeScreenshot(page, 'download-btn-not-found');
      return { status: 'not_found', message: 'No download button found on current page' };
    }

    const dir = getOutputDir('image');
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await downloadBtnLocator.click();
    const download = await downloadPromise;
    if (!download) {
      // No download event (e.g. opens preview instead) — report honestly.
      await takeScreenshot(page, 'download-no-event');
      return { status: 'download_initiated', message: 'Download button clicked, but no download event was observed. Check the project page.' };
    }
    const suggested = download.suggestedFilename() || `flow-download-${Date.now()}`;
    const safe = suggested.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120);
    const savePath = path.join(dir, `${Date.now()}_${safe}`);
    await download.saveAs(savePath);
    logger.info('Download saved', { path: savePath });
    return { status: 'downloaded', message: 'Download saved.', path: savePath };
  } catch (err) {
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed: ${err.message}`);
  }
}
