import { getPage } from '../browser/connect.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getOutputDir } from '../utils/file-manager.js';
import { selectNewestEligible, verifyDownloadedBytes, classifyDownloadError } from '../assets/catalog.js';
import { saveMediaDownload, captureMediaDownload } from '../utils/media-download.js';
import { createHash } from 'node:crypto';

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
      const pushTile = (tile, el) => {
        // Video tiles expose no data-media-id; the thumbnail's CDN media name
        // (flow-content.google/{image|video}/{id}) is the stable tile identity.
        const thumb = tile.querySelector?.('img') || tile.querySelector?.('video');
        const thumbId = String(thumb?.src || '').match(/flow-content\.google\/(?:image|video)\/([a-f0-9-]+)/i)?.[1] || null;
        const assetId = el?.getAttribute?.('data-asset-id') || el?.getAttribute?.('data-media-id') || thumbId;
        const thumbnailUrl = String(thumb?.src || thumb?.poster || '');
        // After reload, Flow may expose only an opaque authenticated thumbnail
        // URL. Retain that exact DOM identity; never infer a remote media UUID.
        const redirectedThumbnail = /^https:\/\/flow\.google\.com\/asb\//.test(thumbnailUrl);
        if (!assetId && !redirectedThumbnail) return;
        const title = el?.getAttribute?.('data-title') || tile.getAttribute?.('data-title') || tile.querySelector?.('.footer-title')?.textContent?.trim() || (tile.textContent || '').trim().slice(0, 120);
        const kind = el?.getAttribute?.('data-kind') || tile.getAttribute?.('data-kind') || (tile.tagName === 'FLOW-IMAGE-TILE' ? 'image' : tile.tagName === 'FLOW-VIDEO-TILE' ? 'video' : null);
        const projectId = el?.getAttribute?.('data-project') || tile.getAttribute?.('data-project') || null;
        const account = el?.getAttribute?.('data-account') || tile.getAttribute?.('data-account') || null;
        const createdRaw = el?.getAttribute?.('data-created-at') || tile.getAttribute?.('data-created-at')
          || el?.getAttribute?.('data-timestamp') || tile.getAttribute?.('data-timestamp');
        const createdAtMs = createdRaw != null && createdRaw !== '' && Number.isFinite(Number(createdRaw))
          ? Number(createdRaw)
          : undefined;
        const rect = tile.getBoundingClientRect?.();
        const visible = rect ? rect.width > 0 && rect.height > 0 : true;
        out.push({ id: assetId, assetId, title, kind, projectId, account, createdAtMs, visible,
          ...(!assetId ? { thumbnailUrl } : {}) });
      };
      for (const el of document.querySelectorAll('[data-asset-id], flow-image-tile [data-media-id], flow-video-tile [data-media-id]')) {
        const tile = el.closest('flow-image-tile, flow-video-tile, .asset-tile, [data-asset-tile], li, [role="listitem"]') || el;
        pushTile(tile, el);
      }
      for (const tile of document.querySelectorAll('flow-video-tile, flow-image-tile')) {
        if (tile.querySelector('[data-media-id], [data-asset-id]')) continue;
        pushTile(tile, null);
      }
      // De-dupe by asset id, keep first.
      const seen = new Map();
      for (const t of out) {
        const key = t.assetId || t.thumbnailUrl;
        if (!seen.has(key)) seen.set(key, t);
      }
      return [...seen.values()].filter((t) => t.visible !== false);
    }).catch(() => []);
    if (!Array.isArray(tiles)) return [];
    for (const tile of tiles) {
      if (tile.assetId || !tile.thumbnailUrl) continue;
      tile.id = tile.assetId = `thumbnail:${createHash('sha256').update(tile.thumbnailUrl).digest('hex')}`;
      tile.identityKind = 'thumbnail-url';
    }
    return tiles.filter(tile => tile.assetId);
  } catch {
    return [];
  }
}

function tileLocator(page, assetId, thumbnailUrl = null) {
  const id = String(assetId).replace(/["\\]/g, '\\$&');
  const source = thumbnailUrl?.replace(/["\\]/g, '\\$&');
  const thumbnail = source ? `, flow-video-tile:has(img[src="${source}"]), flow-image-tile:has(img[src="${source}"]), flow-video-tile:has(video[src="${source}"]), flow-video-tile:has(video[poster="${source}"])` : '';
  return page.locator(`flow-image-tile:has([data-media-id="${id}"]), flow-video-tile:has([data-media-id="${id}"]), [data-asset-id="${id}"], flow-video-tile:has(img[src*="${id}"]), flow-image-tile:has(img[src*="${id}"])${thumbnail}`).first();
}

// Target the verified tile: hover/select → More options → Download, with the
// download event pre-registered BEFORE the Download click (same race as the
// filechooser: awaiting after the click loses the event).
async function exposeAndDownloadTile(page, asset, assertProject = () => {}) {
  const id = asset.assetId || asset.id;
  const tile = tileLocator(page, id, asset.thumbnailUrl);
  assertProject();
  try {
    await tile.hover({ timeout: 3000 }).catch(() => {});
  } catch { /* hover best-effort */ }
  const more = tile.locator('button:has-text("More options"), [aria-label*="More" i], .more').first();
  if (await more.isVisible().catch(() => false)) {
    assertProject();
    await more.click({ timeout: 3000 });
    await page.waitForTimeout(400);
  }
  assertProject();
  // Scope the Download click to the tile/menu — never a page-wide first
  // download control belonging to another asset.
  let dlBtn = tile.locator('button:has-text("Download"), [aria-label*="download" i], .dl').first();
  if (!(await dlBtn.isVisible().catch(() => false))) {
    const menuDl = page.locator('.menu:visible button:has-text("Download"), [role="menu"]:visible button:has-text("Download"), [role="menuitem"]:visible:has-text("Download")').first();
    if (await menuDl.isVisible().catch(() => false)) dlBtn = menuDl;
  }
  if (await dlBtn.getAttribute('aria-haspopup').catch(() => null) === 'menu') {
    assertProject();
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
  assertProject();
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
  let transfer = null;
  // A download may open an explicitly requested existing project, never
  // guess one from the homepage or create a project as a side effect.
  const projectUrl = args.project_url;
  if (projectUrl !== undefined && (typeof projectUrl !== 'string'
    || !/^https:\/\/flow\.google\.com\/project\/[A-Za-z0-9_-]+\/?$/.test(projectUrl))) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'project_url must be an exact https://flow.google.com/project/<id> URL.');
  }
  const target = projectUrl?.replace(/\/$/, '');
  const assertProject = () => {
    if (!target) return;
    const current = new URL(page.url());
    if (current.origin + current.pathname.replace(/\/$/, '') !== target) {
      throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, 'The requested project is no longer open.', { reason: 'project_unavailable' });
    }
  };

  try {
    if (projectUrl) {
      const current = new URL(page.url());
      if (current.origin + current.pathname.replace(/\/$/, '') !== target) {
        await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      assertProject();
    }
    // 1. Enumerate live DOM identities FIRST — mapping before any click.
    let tiles = await enumerateAssetTiles(page);
    // Flow hydrates its library after navigation. Retry discovery briefly
    // without reloading the current project or touching its composer.
    const discoveryDeadline = Date.now() + 3000;
    while (tiles.length === 0 && /^https:\/\/flow\.google\.com\/project\/[A-Za-z0-9_-]+\/?(?:[?#]|$)/.test(page.url())) {
      assertProject();
      const openDl = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
      if (await openDl.isVisible().catch(() => false) || Date.now() >= discoveryDeadline) break;
      await page.waitForTimeout(Math.min(200, Math.max(1, discoveryDeadline - Date.now())));
      tiles = await enumerateAssetTiles(page);
    }
    assertProject();
    const explicitId = args.assetId ?? args.asset_id ?? null;

    if (tiles.length === 0) {
      // An explicit selection must never fall back to another open menu.
      if (explicitId) {
        return { status: 'not_found', reason: 'explicit_asset_not_found', choices: [],
          message: `Explicit asset "${explicitId}" is not present in the visible library. No file downloaded.`,
          next_action: 'Open the correct project and make the requested completed asset visible, then retry with its current asset_id.' };
      }
      // Honest conditional path: the already-open-menu working state (QA
      // single-client retest) with no enumerable tiles. Download the visible
      // context WITHOUT claiming latest identity.
      const openDl = page.locator('button:has-text("Download"), [aria-label*="download" i]').first();
      if (!(await openDl.isVisible().catch(() => false))) {
        await shotFn(page, 'download-btn-not-found').catch(() => null);
        let currentUrl = null;
        let homePage = false;
        try {
          const url = new URL(page.url());
          currentUrl = url.origin + url.pathname;
          homePage = url.origin === 'https://flow.google.com' && ['/', '/about', '/about/'].includes(url.pathname);
        } catch { /* URL unavailable; do not infer a project from missing evidence. */ }
        return { status: 'not_found', reason: homePage ? 'project_required' : 'no_visible_assets', currentUrl,
          message: homePage
            ? 'Open an existing Google Flow project containing a completed image or video before downloading. The current page is not a project.'
            : 'No completed image or video could be identified and no Download control is visible on this page.',
          next_action: homePage
            ? 'Retry flow_download_latest with project_url set to the existing project URL (https://flow.google.com/project/<id>), or open it with flow_open first. No new generation is needed.'
            : 'Make an existing completed asset visible in its project library, wait for the library to load, then retry. If the asset remains unrecognized, share the package version and a screenshot with private details hidden.' };
      }
      assertProject();
      transfer = await captureMediaDownload(page, outDirFn);
      assertProject();
      const dp = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      await openDl.click().catch(() => {});
      const download = await dp;
      if (!download) {
        await shotFn(page, 'download-no-event').catch(() => null);
        return { status: 'not_downloaded', reason: 'download_event_missing', retryable: true, message: 'No file was downloaded. The render may still be running or the download control may open a menu. Verify the asset before retrying.' };
      }
      assertProject();
      const saved = await saveMediaDownload(transfer ? transfer.wrap(download) : download, outDirFn, { page });
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
          assets: tiles.map(({ assetId, title, kind, identityKind }) => ({ assetId, title, kind, identityKind: identityKind || 'media-id' })),
          message: 'Download blocked: no unambiguous latest asset identity.',
          next_action: 'Choose the intended asset from assets/choices and retry flow_download_latest with its exact asset_id. DOM order is not proof of newest; no new generation is needed.',
        };
      }
      chosen = mapped.asset;
    }

    // 3. Mapping validated BEFORE the click — now target its real menu.
    assertProject();
    transfer = await captureMediaDownload(page, outDirFn);
    const { download, error } = await exposeAndDownloadTile(page, chosen, assertProject);
    if (!download) {
      await shotFn(page, 'download-no-event').catch(() => null);
      return { status: 'not_downloaded', reason: 'download_event_missing', retryable: true, message: error || 'Download menu did not produce a download event. No file saved.', asset: { assetId: chosen.assetId || chosen.id, title: chosen.title } };
    }
    assertProject();
    const saved = await saveMediaDownload(transfer ? transfer.wrap(download) : download, outDirFn, { page });
    return { status: 'downloaded', message: 'Verified media saved with format extensions.', ...saved, asset_verified: true, latest_verified: !explicitId, asset: { assetId: chosen.assetId || chosen.id, identityKind: chosen.identityKind || 'media-id', title: chosen.title, projectId: chosen.projectId, account: chosen.account } };
  } catch (err) {
    if (err.details?.reason === 'project_unavailable') {
      return { status: 'not_found', reason: 'project_unavailable',
        message: 'The requested project did not stay open. No file saved.',
        next_action: 'Check access to the existing project and complete any required sign-in in Chrome, then retry with the same project_url.' };
    }
    // Signed-URL expiry / incomplete / failure — no fabricated identity.
    const classified = classifyDownloadError(err);
    throw new FlowError(ErrorCodes.DOWNLOAD_FAILED, `Download failed (${classified.code}): ${classified.message}`, { code: classified.code, retryable: classified.retryable });
  } finally {
    await transfer?.close();
  }
}

export async function handleDownloadLatest(args = {}) {
  const page = getPage();
  return handleDownloadWithPage(page, args);
}
