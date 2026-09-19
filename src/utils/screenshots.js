import path from 'path';
import fs from 'fs';
import { getFlowHome } from './config.js';
import { logger } from './logger.js';

function screenshotDir() {
  return path.join(getFlowHome(), 'screenshots-debug');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function sanitizeFileName(name, fallback = 'shot') {
  const base = String(name ?? fallback).trim() || fallback;
  // Strip path separators, traversal, Windows-reserved chars; cap length.
  const cleaned = base
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export async function takeScreenshot(page, name) {
  try {
    const dir = screenshotDir();
    ensureDir(dir);
    const safe = sanitizeFileName(name);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${safe}.png`;
    const filepath = path.join(dir, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    logger.info('Screenshot saved', { name: safe, path: filepath });
    return filepath;
  } catch (err) {
    logger.warn('Failed to take screenshot', { name, error: err.message });
    return null;
  }
}

export function getLatestScreenshot(namePattern) {
  const dir = screenshotDir();
  if (!fs.existsSync(dir)) return null;
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.includes(namePattern));
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const f of files) {
    try {
      const full = path.join(dir, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = full;
      }
    } catch { /* file deleted mid-scan — ignore */ }
  }
  return best;
}
