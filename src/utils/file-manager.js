import path from 'path';
import fs from 'fs';
import { getFlowHome } from './config.js';
import { logger } from './logger.js';

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
