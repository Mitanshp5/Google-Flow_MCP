import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getOutputDir } from '../utils/file-manager.js';
import { selectNewestEligible, verifyDownloadedBytes, classifyDownloadError } from '../assets/catalog.js';
import { saveMediaDownload } from '../utils/media-download.js';

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

// W04: actual asset menu format (Google documented flow): hover/select the
// asset → More options → Download. First-download-control alone never proves
// newest identity.
export const ASSET_MENU_STEPS = ['hover/select asset', 'More options', 'Download'];

// W04: explicit asset mapping (pure helper, supplementary). The browser flow
// below never treats caller-supplied candidates as observed truth — it
// enumerates the live DOM (enumerateAssetTiles) instead.
export function selectExplicitDownloadTarget({ explicitAssetId = null, candidates = [], projectId = null, kind = null } = {}) {
  if (explicitAssetId) {
    const hit = (candidates || []).find((a) => (a.id || a.assetId) === explicitAssetId);
    if (!hit) return { status: 'not_found', reason: `explicit asset "${explicitAssetId}" not in candidates`, choices: [] };
    return { status: 'selected', asset: hit, selection: 'explicit' };
  }
  const r = selectNewestEligible(candidates, { projectId, kind });
  if (r.status === 'selected') return { ...r, selection: 'newest-eligible' };
  return { ...r, selection: r.status === 'ambiguous' ? 'blocked-ambiguous' : 'none' };
}

// W04: verify actual saved bytes — signature + size + hash. Complete, not
// filename alone. Never fabricates an asset identity on failure.
export function verifySavedDownload({ bytes, expectedKind = null, savedPath = '' } = {}) {
  const v = verifyDownloadedBytes({ bytes, expectedKind });
  return { verified: v.ok, hash: v.hash ?? null, size: v.size ?? 0, mime: v.mime ?? null, reason: v.reason, path: savedPath };
}

export { classifyDownloadError };

// Enumerate actually visible asset tiles with stable identities from the
// live DOM — the ONLY source of truth for newest selection. Caller-supplied
// candidate lists are never consulted here.
export async function enumerateAssetTiles(page) {
  try {
    const tiles = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-asset-id], flow-image-tile [data-media-id], flow-video-tile [data-media-id]')) {
        const tile = el.closest('flow-image-tile, flow-video-tile, .asset-tile, [data-asset-tile], li, [role="listitem"]') || el;
        const assetId = el.getAttribute('data-asset-id') || el.getAttribute('data-media-id');
        if (!assetId) continue;
        const title = el.getAttribute('data-title') || tile.getAttribute?.('data-title') || tile.querySelector?.('.footer-title')?.textContent?.trim() || (tile.textContent || '').trim().slice(0, 120);
        const kind = el.getAttribute('data-kind') || tile.getAttribute?.('data-kind') || (tile.tagName === 'FLOW-IMAGE-TILE' ? 'image' : tile.tagName === 'FLOW-VIDEO-TILE' ? 'video' : null);
        const projectId = el.getAttribute('data-project') || tile.getAttribute?.('data-project') || null;
        const account = el.getAttribute('data-account') || tile.getAttribute?.('data-account') || null;
        const createdRaw = el.getAttribute('data-created-at') || tile.getAttribute?.('data-created-at')
          || el.getAttribute('data-timestamp') || tile.getAttribute?.('data-timestamp');
        const createdAtMs = createdRaw != null && createdRaw !== '' && Number.isFinite(Number(createdRaw))
          ? Number(createdRaw)
          : undefined;
        const rect = tile.getBoundingClientRect?.();
        const visible = rect ? rect.width > 0 && rect.height > 0 : true;
        out.push({ id: assetId, assetId, title, kind, projectId, account, createdAtMs, visible });
      }
      // De-dupe by asset id, keep first.
      const seen = new Map();
      for (const t of out) {
        if (!seen.has(t.assetId)) seen.set(t.assetId, t);
      }
      return [...seen.values()].filter((t) => t.visible !== false);
    }).catch(() => []);
    return Array.isArray(tiles) ? tiles : [];
  } catch {
    return [];
  }
}

function tileLocator(page, assetId) {
  const id = String(assetId).replace(/["\\]/g, '\\$&');
  return page.locator(`flow-image-tile:has([data-media-id="${id}"]), flow-video-tile:has([data-media-id="${id}"]), [data-asset-id="${id}"]`).first();
}

// Target the verified tile: hover/select → More options → Download, with the
// download event pre-registered BEFORE the Download click (same race as the
// filechooser: awaiting after the click loses the event).
async function exposeAndDownloadTile(page, asset) {
  const id = asset.assetId || asset.id;
  const tile = tileLocator(page, id);
  try {
    await tile.hover({ timeout: 3000 }).catch(() => {});
  } catch { /* hover best-effort */ }
  const more = tile.locator('button:has-text("More options"), [aria-label*="More" i], .more').first();
  if (await more.isVisible().catch(() => false)) {
    await more.click({ timeout: 3000 });
    await page.waitForTimeout(400);
  }
  // Scope the Download click to the tile/menu — never a page-wide first
  // download control belonging to another asset.
  let dlBtn = tile.locator('button:has-text("Download"), [aria-label*="download" i], .dl').first();
  if (!(await dlBtn.isVisible().catch(() => false))) {
    const menuDl = page.locator('.menu:visible button:has-text("Download"), [role="menu"]:visible button:has-text("Download"), [role="menuitem"]:visible:has-text("Download")').first();
    if (await menuDl.isVisible().catch(() => false)) dlBtn = menuDl;
  }
  if (await dlBtn.getAttribute('aria-haspopup').catch(() => null) === 'menu') {
    await dlBtn.hover();
    const original = page.locator('[role="menu"]:visible [role="menuitem"]').filter({ hasText: /Original size/i }).first();
    await original.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (!(await original.isVisible().catch(() => false))) {
      return { download: null, error: 'Original-size download option not available; refusing upscale or paid actions' };
    }
    dlBtn = original;
  }
  if (!(await dlBtn.isVisible().catch(() => false))) {
    return { download: null, error: `Download affordance not exposed for asset "${id}" (hover→More→Download)` };
  }
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await dlBtn.click().catch(() => {});
  const download = await downloadPromise;
  if (!download) return { download: null, error: `no download event for asset "${id}"` };
  return { download };
}

export async function handleDownloadWithPage(page, args = {}, deps = {}) {
  const shotFn = deps.takeScreenshotFn || takeScreenshot;
  const outDirFn = deps.getOutputDirFn || getOutputDir;
  logger.info('Attempting to download latest result');

  try {
    // 1. Enumerate live DOM identities FIRST — mapping before any click.
    const tiles = await enumerateAssetTiles(page);
    const explicitId = args.assetId ?? args.asset_id ?? null;

    if (tiles.length === 0) {
      // Honest conditional path: the already-open-menu working state (QA
      // single-client retest) with no enumerable tiles. Download the visible
      // context WITHOUT claiming latest identity.
      const openDl = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
      if (!(await openDl.isVisible().catch(() => false))) {
        await shotFn(page, 'download-btn-not-found').catch(() => null);
        return { status: 'not_found', message: 'No download button found on current page' };
      }
      const dp = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      await openDl.click().catch(() => {});
      const download = await dp;
      if (!download) {
        await shotFn(page, 'download-no-event').catch(() => null);
        return { status: 'not_downloaded', reason: 'download_event_missing', retryable: true, message: 'No file was downloaded. The render may still be running or the download control may open a menu. Verify the asset before retrying.' };
      }
      const saved = await saveMediaDownload(download, outDirFn);
      return { status: 'downloaded', message: 'Verified media saved with format extensions (current selection; latest identity not verified).', ...saved, latest_verified: false, asset: null };
    }

    // 2. Choose the verified newest eligible (or explicit id within the DOM).
    let chosen = null;
    if (explicitId) {
      chosen = tiles.find((t) => (t.assetId || t.id) === explicitId) || null;
      if (!chosen) {
        await shotFn(page, 'download-explicit-not-found').catch(() => null);
        return { status: 'not_found', reason: `explicit asset "${explicitId}" not present in the live library`, choices: tiles.map((t) => t.assetId) };
      }
    } else {
      // Newest eligible scoped to a single project/kind where observable;
      // mixed scopes without a filter block as ambiguous.
      const projects = [...new Set(tiles.map((t) => t.projectId).filter(Boolean))];
      const scopeProject = projects.length === 1 ? projects[0] : null;
      const kinds = [...new Set(tiles.map((t) => t.kind).filter(Boolean))];
      const scopeKind = kinds.length === 1 ? kinds[0] : null;
      const mapped = selectNewestEligible(tiles, { projectId: scopeProject, kind: scopeKind });
      if (mapped.status !== 'selected') {
        await shotFn(page, 'download-ambiguous-latest').catch(() => null);
        return {
          status: mapped.status === 'ambiguous' ? 'ambiguous' : 'not_found',
          reason: mapped.reason || 'no eligible asset mapping',
          choices: (mapped.choices || []).map((c) => c.assetId || c.id),
          message: 'Download blocked: no unambiguous latest asset identity.',
        };
      }
      chosen = mapped.asset;
    }

    // 3. Mapping validated BEFORE the click — now target its real menu.
    const { download, error } = await exposeAndDownloadTile(page, chosen);
    if (!download) {
      await shotFn(page, 'download-no-event').catch(() => null);
      return { status: 'not_downloaded', reason: 'download_event_missing', retryable: true, message: error || 'Download menu did not produce a download event. No file saved.', asset: { assetId: chosen.assetId || chosen.id, title: chosen.title } };
    }
    const saved = await saveMediaDownload(download, outDirFn);
    return { status: 'downloaded', message: 'Verified media saved with format extensions.', ...saved, asset_verified: true, latest_verified: !explicitId, asset: { assetId: chosen.assetId || chosen.id, title: chosen.title, projectId: chosen.projectId, account: chosen.account } };
  } catch (err) {
    // Signed-URL expiry / incomplete / failure — no fabricated identity.
    const classified = classifyDownloadError(err);
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed (${classified.code}): ${classified.message}`, { code: classified.code, retryable: classified.retryable });
  }
}

export async function handleDownloadLatest(args = {}) {
  const page = getPage();
  return handleDownloadWithPage(page, args);
}
