import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPage } from '../browser/connect.js';
import { getOutputDir } from '../utils/file-manager.js';
import { saveMediaDownload } from '../utils/media-download.js';

const run = promisify(execFile);

export async function handleExportReel(args = {}) {
  if (!Array.isArray(args.prompts) || args.prompts.length !== 3 || args.prompts.some(p => typeof p !== 'string' || p.length < 10)) {
    throw new Error('Exactly three distinct prompt prefixes are required in story order');
  }
  if (new Set(args.prompts).size !== 3) throw new Error('Prompt prefixes must be distinct');
  const page = getPage();
  if (!page.url().startsWith(args.project_url) || !/^https:\/\/flow\.google\.com\/project\/[\w-]+$/.test(args.project_url)) {
    throw new Error('Open the exact project root before exporting');
  }
  const targets = [];
  for (let i = 0; i < 3; i++) {
    const text = page.getByText(args.prompts[i], { exact: false });
    if (await text.count() !== 1) throw new Error(`Prompt ${i + 1} does not identify exactly one clip`);
    const target = await text.evaluate((el, index) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const buttons = [...node.querySelectorAll('button')];
        const download = buttons.find(b => /download/i.test(b.getAttribute('aria-label') || b.textContent || ''));
        if (download && node.querySelector('video, img')) {
          download.setAttribute('data-flow-export', String(index));
          return { text: node.innerText.slice(0, 1200), index };
        }
      }
      return null;
    }, i);
    if (!target || !/360p/.test(target.text) || !/Omni 1\.1 Flash/.test(target.text)) {
      throw new Error(`Clip ${i + 1} missing or settings not observable`);
    }
    targets.push(target);
  }
  if (args.prepare_only !== false) return { status: 'ready', targets, message: 'No downloads or generation performed' };
  if (!args.ffmpeg_path || !fs.existsSync(args.ffmpeg_path)) throw new Error('Existing ffmpeg_path required');
  const ffprobe = path.join(path.dirname(args.ffmpeg_path), 'ffprobe.exe');
  if (!fs.existsSync(ffprobe)) throw new Error('ffprobe.exe required beside ffmpeg');
  const dir = path.join(getOutputDir('video'), `reel-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const metadata = [];
  for (let i = 0; i < 3; i++) {
    const event = page.waitForEvent('download', { timeout: 20000 });
    await page.locator(`button[data-flow-export="${i}"]`).click({ timeout: 5000 });
    const download = await event;
    const saved = await saveMediaDownload(download, getOutputDir);
    if (saved.files.length !== 1 || saved.kind !== 'video') throw new Error('Expected exactly one video per selected clip');
    const file = saved.path;
    const probe = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
    const info = JSON.parse(probe.stdout);
    const video = info.streams.find(s => s.codec_type === 'video');
    if (!video || Math.abs(video.width / video.height - 9 / 16) > 0.02 || Number(info.format.duration) < 7) throw new Error('Clip duration/aspect verification failed');
    files.push(file);
    metadata.push({ file, duration: Number(info.format.duration), width: video.width, height: video.height, audio: info.streams.some(s => s.codec_type === 'audio') });
  }
  if (metadata.some(m => !m.audio)) return { status: 'blocked', reason: 'At least one generated clip has no audio track; voiceover cannot be claimed', clips: metadata, directory: dir };
  const output = path.join(dir, 'The-Last-Light-21s.mp4');
  const filters = files.flatMap((_, i) => [
    `[${i}:v]trim=duration=7,setpts=PTS-STARTPTS,fps=24,scale=360:640,setsar=1[v${i}]`,
    `[${i}:a]atrim=duration=7,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
  ]).concat('[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]').join(';');
  await run(args.ffmpeg_path, ['-n', ...files.flatMap(f => ['-i', f]), '-filter_complex', filters, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', output], { maxBuffer: 4 * 1024 * 1024 });
  const final = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output])).stdout);
  if (Math.abs(Number(final.format.duration) - 21) > 0.1) throw new Error('Final duration verification failed');
  return { status: 'exported', path: output, duration: Number(final.format.duration), width: 360, height: 640, clips: metadata, voiceover_review: 'Audio tracks retained; spoken content requires listening review', credits_spent: 0 };
}
