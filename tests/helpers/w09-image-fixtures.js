// W09 local-media fixtures — SYNTHETIC/LOCAL provenance only.
// Generates tiny real PNG/JPEG/WebP bytes via local ffmpeg lavfi
// (testsrc/color). Never Flow-generated evidence. Never remote URLs.
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

function run(cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export const FIXTURE_PROVENANCE = 'synthetic-local-fixture';

// Generate a synthetic still image with real encoded bytes.
// format: 'png' | 'mjpeg' (for .jpg) | 'webp'. size WxH.
export async function generateFixtureImage(outFile, { width = 64, height = 48, format = 'png', color = 'red' } = {}) {
  const vcodec = format === 'mjpeg' ? 'mjpeg' : format === 'webp' ? 'libwebp' : 'png';
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=${width}x${height}:d=0.2:r=5`,
    '-frames:v', '1',
    '-vcodec', vcodec,
    outFile,
  ];
  await run('ffmpeg', args);
  return outFile;
}

export async function ensureFixture(dir, name, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) {
    await generateFixtureImage(full, opts);
  }
  return full;
}

// Synthetic ANIMATED WebP (multi-frame) — must be rejected as non-still.
// Verified: ffprobe reports codec webp_anim with nb_read_frames = frame count.
export async function generateAnimatedWebp(outFile, { width = 64, height = 48, frames = 6 } = {}) {
  const fps = 10;
  const duration = (frames / fps).toFixed(2);
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi',
    '-i', `testsrc=d=${duration}:r=${fps}:s=${width}x${height}`,
    '-frames:v', String(frames),
    '-vcodec', 'libwebp',
    outFile,
  ]);
  return outFile;
}

// Synthetic high-entropy PNG (multi-MiB) for absolute total-bytes cap tests.
export async function generateNoisePng(outFile, { size = 2048 } = {}) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi',
    '-i', `nullsrc=s=${size}x${size}:d=0.5:r=5,noise=alls=90:allf=t`,
    '-frames:v', '1',
    '-vcodec', 'png',
    outFile,
  ], { timeoutMs: 120000 });
  return outFile;
}
// Synthetic APNG (multi-frame PNG) — must be rejected as non-still.
// Verified: ffprobe reports codec apng with nb_read_frames = frame count.
export async function generateApng(outFile, { width = 64, height = 48, frames = 3 } = {}) {
  const fps = 10;
  const duration = (frames / fps).toFixed(2);
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi',
    '-i', `testsrc=d=${duration}:r=${fps}:s=${width}x${height}`,
    '-frames:v', String(frames),
    '-vcodec', 'apng',
    '-f', 'apng',
    outFile,
  ]);
  return outFile;
}
