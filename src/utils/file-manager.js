import path from 'path';
import fs from 'fs';
import { getFlowHome } from './config.js';
import { logger, getLogDir } from './logger.js';
import { getScreenshotDir } from './screenshots.js';

function outputBase() {
  return path.join(getFlowHome(), 'outputs');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateFilename(type, model, jobId, index) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const modelSlug = (model || 'unknown').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const ext = type === 'image' ? 'png' : 'mp4';
  const idx = String(index || 1).padStart(3, '0');
  const safeJob = String(jobId || 'nojobs').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  return `flow_${dateStr}_${timeStr}_${modelSlug}_${type}_${safeJob}_${idx}.${ext}`;
}

export function getOutputDir(type) {
  // P0-3: neutral 'other' bucket for downloads whose kind genuinely can't
  // be determined (previously everything non-'image' landed in videos/).
  const sub = type === 'image' ? 'images' : type === 'video' ? 'videos' : 'other';
  const dir = path.join(outputBase(), sub);
  ensureDir(dir);
  return dir;
}

export function saveMetadata(jobId, data) {
  const metaDir = path.join(outputBase(), 'metadata');
  ensureDir(metaDir);
  const safeJob = String(jobId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  const filePath = path.join(metaDir, `${safeJob}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  logger.info('Metadata saved', { jobId, path: filePath });
  return filePath;
}

export function prepareDownload(type, model, jobId, index = 1) {
  const dir = getOutputDir(type);
  const filename = generateFilename(type, model, jobId, index);
  const fullPath = path.join(dir, filename);
  return { dir, filename, fullPath };
}

// P2-4 retention policy (judgment values, documented): debug trails decay
// fast (screenshots are MBs each), metadata slower. outputs/images|videos
// (user assets, including downloads) are deliberately NEVER swept.
export const RETENTION_DEFAULTS = {
  logs: { maxAgeMs: 30 * 24 * 3600 * 1000, maxCount: 100 },
  screenshots: { maxAgeMs: 7 * 24 * 3600 * 1000, maxCount: 200 },
  metadata: { maxAgeMs: 30 * 24 * 3600 * 1000, maxCount: 500 },
};

export function pruneDir(dir, { maxAgeMs = Infinity, maxCount = Infinity } = {}) {
  const out = { dir, deleted: 0, kept: 0, errors: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  const now = Date.now();
  const fresh = [];
  for (const f of entries) {
    const full = path.join(dir, f);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > maxAgeMs) {
      try {
        fs.rmSync(full, { force: true });
        out.deleted += 1;
      } catch (e) {
        out.errors.push(`${f}: ${e.message}`);
        fresh.push({ full, mtime: stat.mtimeMs });
      }
    } else {
      fresh.push({ full, mtime: stat.mtimeMs });
    }
  }
  fresh.sort((a, b) => b.mtime - a.mtime);
  let extraDeleted = 0;
  for (const f of fresh.slice(maxCount)) {
    try {
      fs.rmSync(f.full, { force: true });
      out.deleted += 1;
      extraDeleted += 1;
    } catch (e) {
      out.errors.push(`${path.basename(f.full)}: ${e.message}`);
    }
  }
  out.kept = fresh.length - extraDeleted;
  return out;
}

export function defaultRetentionDirs() {
  return [
    { dir: getLogDir(), policy: RETENTION_DEFAULTS.logs, label: 'logs' },
    { dir: getScreenshotDir(), policy: RETENTION_DEFAULTS.screenshots, label: 'screenshots' },
    { dir: path.join(outputBase(), 'metadata'), policy: RETENTION_DEFAULTS.metadata, label: 'metadata' },
  ];
}

/**
 * Best-effort retention sweep (P2-4), run on flow_connect. Never throws;
 * per-file errors are collected, never fatal. Returns a summary.
 */
export function runRetentionSweep(dirs = defaultRetentionDirs()) {
  const summary = { deleted: 0, kept: 0, errors: [], dirs: {} };
  try {
    for (const { dir, policy, label } of dirs) {
      try {
        const r = pruneDir(dir, policy);
        summary.deleted += r.deleted;
        summary.kept += r.kept;
        summary.errors.push(...r.errors.map((e) => `${label}: ${e}`));
        summary.dirs[label || dir] = { deleted: r.deleted, kept: r.kept };
      } catch (e) {
        summary.errors.push(`${label || dir}: ${e.message}`);
      }
    }
  } catch (e) {
    summary.errors.push(`sweep: ${e.message}`);
  }
  if (summary.deleted > 0 || summary.errors.length > 0) {
    logger.info('Retention sweep', summary);
  } else {
    logger.debug('Retention sweep (nothing to prune)', { kept: summary.kept });
  }
  return summary;
}

export function findNewFiles(dir, beforeMs) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of entries) {
    // Filter dotfiles by basename (not full path).
    if (path.basename(f).startsWith('.')) continue;
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs > beforeMs) out.push({ full, mtime: stat.mtimeMs });
    } catch { /* ENOENT race — file deleted mid-scan */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.map(o => o.full);
}
