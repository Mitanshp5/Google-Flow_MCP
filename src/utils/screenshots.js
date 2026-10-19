import path from 'path';
import fs from 'fs';
import { getFlowHome, get } from './config.js';
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

export function getScreenshotDir() {
  return screenshotDir();
}

export async function takeScreenshot(page, name) {
  try {
    const dir = screenshotDir();
    ensureDir(dir);
    const safe = sanitizeFileName(name);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${safe}.png`;
    const filepath = path.join(dir, filename);
    // Capture the actual viewport through Chrome's native screenshot command.
    // Playwright's screenshot stability/font waits can stall indefinitely on
    // Flow's animated editor even after document.fonts reports ready.
    if (typeof page.context === 'function' && typeof page.context().newCDPSession === 'function') {
      const session = await page.context().newCDPSession(page);
      let timer;
      let animations;
      try {
        if (typeof page.evaluateHandle === 'function') {
          animations = await page.evaluateHandle(() => document.getAnimations().filter(animation => {
            if (animation.playState !== 'running') return false;
            animation.pause();
            return true;
          }));
        }
        // Headless fixture browsers have no native window/view. Production
        // Flow requires headed Chrome, whose visible view avoids waiting on
        // animated offscreen surfaces. This only reads UA, never changes it.
        const fromSurface = typeof page.evaluate === 'function'
          ? await page.evaluate(() => navigator.userAgent.includes('HeadlessChrome/')) : false;
        const {data} = await Promise.race([
          session.send('Page.captureScreenshot', {format:'png',fromSurface,captureBeyondViewport:false}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native viewport capture timed out; no screenshot verified')),get('screenshotTimeoutMs',10000));}),
        ]);
        fs.writeFileSync(filepath,Buffer.from(data,'base64'));
      } finally {
        clearTimeout(timer);
        if (animations) {
          await animations.evaluate(list=>list.forEach(animation=>animation.play())).catch(()=>{});
          await animations.dispose();
        }
        await session.detach();
      }
    } else {
      await page.screenshot({ path: filepath, fullPage: false, timeout:10000 });
    }
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
