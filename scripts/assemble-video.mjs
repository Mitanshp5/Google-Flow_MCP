#!/usr/bin/env node
/**
 * Cross-platform media assembly and frame extraction script for Google Flow MCP.
 *
 * Capabilities:
 * 1. Probes source video clips using ffprobe (resolution, duration, fps, streams).
 * 2. Robustly extracts the true last frame of clips (for chain continuity) with fallback strategies.
 * 3. Normalizes and concatenates source clips into a delivery MP4 (H.264 / AAC).
 * 4. Verifies the concatenated output with ffprobe.
 * 5. Generates a structured JSON assembly manifest / report.
 *
 * Usage:
 *   node scripts/assemble-video.mjs --inputs clip1.mp4 clip2.mp4 clip3.mp4 --output final.mp4 --extract-frames
 *   node scripts/assemble-video.mjs --manifest shot-plan.json --output final.mp4
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export async function checkFFmpegTools() {
  const tools = { ffmpeg: false, ffprobe: false, versions: {} };
  try {
    const { stdout: ffprobeOut } = await execFileAsync('ffprobe', ['-version']);
    tools.ffprobe = true;
    tools.versions.ffprobe = ffprobeOut.split('\n')[0].trim();
  } catch (err) {
    tools.ffprobe = false;
    tools.error = `ffprobe is not available: ${err.message}`;
  }

  try {
    const { stdout: ffmpegOut } = await execFileAsync('ffmpeg', ['-version']);
    tools.ffmpeg = true;
    tools.versions.ffmpeg = ffmpegOut.split('\n')[0].trim();
  } catch (err) {
    tools.ffmpeg = false;
    tools.error = (tools.error ? `${tools.error} | ` : '') + `ffmpeg is not available: ${err.message}`;
  }

  return tools;
}

export async function probeVideo(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const args = [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    abs,
  ];

  const { stdout } = await execFileAsync('ffprobe', args);
  const data = JSON.parse(stdout);

  const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error(`No video stream found in file: ${filePath}`);
  }

  let fps = null;
  if (videoStream.r_frame_rate) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0) fps = Math.round((num / den) * 100) / 100;
  }

  const durationSec = Number(videoStream.duration || data.format?.duration || 0);
  const nbFrames = Number(videoStream.nb_frames || 0) || (fps && durationSec ? Math.round(fps * durationSec) : null);

  return {
    path: abs,
    filename: path.basename(abs),
    width: videoStream.width,
    height: videoStream.height,
    aspectRatio: `${videoStream.width}:${videoStream.height}`,
    codec: videoStream.codec_name,
    pixFmt: videoStream.pix_fmt,
    fps,
    durationSec,
    nbFrames,
    hasAudio: Boolean(audioStream),
    audioCodec: audioStream?.codec_name || null,
    audioSampleRate: audioStream?.sample_rate || null,
    formatName: data.format?.format_name || null,
    sizeBytes: fs.statSync(abs).size,
  };
}

export async function extractLastFrame(videoPath, outputPath, probeInfo = null) {
  const info = probeInfo || await probeVideo(videoPath);
  const outAbs = path.resolve(outputPath);
  const outDir = path.dirname(outAbs);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const attempts = [];

  // Strategy 1: Exact frame index if nbFrames is known
  if (info.nbFrames && info.nbFrames > 1) {
    const targetIdx = info.nbFrames - 1;
    try {
      if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', info.path,
        '-vf', `select=eq(n\\,${targetIdx})`,
        '-vframes', '1',
        outAbs,
      ]);
      if (fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0) {
        attempts.push({ strategy: 'frame_index', targetIdx, success: true });
        return { path: outAbs, strategy: 'frame_index', size: fs.statSync(outAbs).size };
      }
    } catch (e) {
      attempts.push({ strategy: 'frame_index', error: e.message });
    }
  }

  // Strategy 2: End-relative seek (-sseof -0.1)
  try {
    if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
    await execFileAsync('ffmpeg', [
      '-y',
      '-sseof', '-0.1',
      '-i', info.path,
      '-update', '1',
      '-frames:v', '1',
      outAbs,
    ]);
    if (fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0) {
      attempts.push({ strategy: 'sseof', success: true });
      return { path: outAbs, strategy: 'sseof', size: fs.statSync(outAbs).size };
    }
  } catch (e) {
    attempts.push({ strategy: 'sseof', error: e.message });
  }

  // Strategy 3: Timestamp-based seek (duration - 0.05s)
  const seekTime = Math.max(0, info.durationSec - 0.05);
  try {
    if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(seekTime),
      '-i', info.path,
      '-frames:v', '1',
      outAbs,
    ]);
    if (fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0) {
      attempts.push({ strategy: 'timestamp', seekTime, success: true });
      return { path: outAbs, strategy: 'timestamp', size: fs.statSync(outAbs).size };
    }
  } catch (e) {
    attempts.push({ strategy: 'timestamp', error: e.message });
  }

  throw new Error(`Failed to extract last frame from ${videoPath}. Attempts: ${JSON.stringify(attempts)}`);
}

export async function concatVideos(inputPaths, outputPath, options = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('concatVideos requires at least one input path');
  }

  const outAbs = path.resolve(outputPath);
  const outDir = path.dirname(outAbs);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const clipInfos = [];
  for (const p of inputPaths) {
    clipInfos.push(await probeVideo(p));
  }

  // Normalize target dimensions to first clip (or options)
  const targetWidth = options.width || clipInfos[0].width;
  const targetHeight = options.height || clipInfos[0].height;
  const targetFps = options.fps || clipInfos[0].fps || 24;

  // Build filter_complex string
  // For each input i:
  // scale and set sar, format=yuv420p
  // if no audio, synthesize silent audio
  const filterParts = [];
  const concatInputs = [];

  for (let i = 0; i < clipInfos.length; i++) {
    const info = clipInfos[i];
    filterParts.push(
      `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,` +
      `fps=${targetFps},format=yuv420p[v${i}]`
    );

    if (info.hasAudio) {
      filterParts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
    } else {
      filterParts.push(`aevalsrc=0:d=${info.durationSec}:s=48000:c=stereo[a${i}]`);
    }

    concatInputs.push(`[v${i}][a${i}]`);
  }

  const concatFilter = `${concatInputs.join('')}concat=n=${clipInfos.length}:v=1:a=1[outv][outa]`;
  filterParts.push(concatFilter);

  const ffmpegArgs = ['-y'];
  for (const info of clipInfos) {
    ffmpegArgs.push('-i', info.path);
  }

  ffmpegArgs.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    outAbs
  );

  await execFileAsync('ffmpeg', ffmpegArgs);

  if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size === 0) {
    throw new Error(`Concat completed but output file is empty or missing: ${outputPath}`);
  }

  const outputProbe = await probeVideo(outAbs);
  const expectedTotalDuration = clipInfos.reduce((acc, c) => acc + c.durationSec, 0);

  return {
    outputPath: outAbs,
    outputProbe,
    clips: clipInfos,
    expectedDuration: expectedTotalDuration,
    actualDuration: outputProbe.durationSec,
    durationDelta: Math.abs(outputProbe.durationSec - expectedTotalDuration),
  };
}

export async function assembleProduction(options = {}) {
  const tools = await checkFFmpegTools();
  if (!tools.ffmpeg || !tools.ffprobe) {
    throw new Error(`FFmpeg prerequisite missing: ${tools.error}`);
  }

  const inputs = options.inputs || [];
  if (inputs.length === 0) {
    throw new Error('No input clips provided for assembly');
  }

  const outputPath = options.output || 'assembly_output.mp4';
  const framesDir = options.framesDir || path.join(path.dirname(outputPath), 'continuation_frames');

  const clipProbes = [];
  const extractedFrames = [];

  for (let i = 0; i < inputs.length; i++) {
    const clipPath = inputs[i];
    const probe = await probeVideo(clipPath);
    clipProbes.push(probe);

    if (options.extractFrames) {
      const frameName = `shot_${String(i + 1).padStart(2, '0')}_last_frame.png`;
      const frameOut = path.join(framesDir, frameName);
      const frameResult = await extractLastFrame(clipPath, frameOut, probe);
      extractedFrames.push({
        clipIndex: i + 1,
        clipPath,
        framePath: frameResult.path,
        strategy: frameResult.strategy,
        sizeBytes: frameResult.size,
      });
    }
  }

  const concatResult = await concatVideos(inputs, outputPath, {
    width: options.width,
    height: options.height,
    fps: options.fps,
  });

  const report = {
    assembledAt: new Date().toISOString(),
    ffmpeg: tools.versions,
    output: {
      path: concatResult.outputPath,
      width: concatResult.outputProbe.width,
      height: concatResult.outputProbe.height,
      fps: concatResult.outputProbe.fps,
      durationSec: concatResult.outputProbe.durationSec,
      sizeBytes: concatResult.outputProbe.sizeBytes,
      hasAudio: concatResult.outputProbe.hasAudio,
      codec: concatResult.outputProbe.codec,
      audioCodec: concatResult.outputProbe.audioCodec,
    },
    audioStrategy: {
      sourceAudioPreserved: true,
      customScoreMixed: false,
      note: 'Source clip audio normalized and retained; custom score/SFX requires separate mixing pass.',
    },
    clips: clipProbes.map((c, idx) => ({
      index: idx + 1,
      filename: c.filename,
      path: c.path,
      durationSec: c.durationSec,
      resolution: `${c.width}x${c.height}`,
      hasAudio: c.hasAudio,
    })),
    extractedContinuationFrames: extractedFrames,
    verification: {
      expectedDurationSec: concatResult.expectedDuration,
      actualDurationSec: concatResult.actualDuration,
      durationMatch: concatResult.durationDelta < 1.0,
      allClipsDecodable: true,
    },
  };

  if (options.report) {
    const reportPath = path.resolve(options.report);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    report.reportSavedPath = reportPath;
  }

  return report;
}

// CLI driver
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  const inputs = [];
  let output = 'final_assembled.mp4';
  let report = null;
  let extractFrames = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inputs' || args[i] === '-i') {
      while (args[i + 1] && !args[i + 1].startsWith('-')) {
        inputs.push(args[++i]);
      }
    } else if (args[i] === '--output' || args[i] === '-o') {
      output = args[++i];
    } else if (args[i] === '--report' || args[i] === '-r') {
      report = args[++i];
    } else if (args[i] === '--extract-frames' || args[i] === '-f') {
      extractFrames = true;
    } else if (args[i] === '--manifest' || args[i] === '-m') {
      const manifestPath = args[++i];
      const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(manifestData.clips)) {
        inputs.push(...manifestData.clips.map((c) => c.path || c));
      }
    }
  }

  if (inputs.length === 0) {
    console.error('Usage: node scripts/assemble-video.mjs --inputs <clip1> <clip2> ... --output <output.mp4> [--extract-frames] [--report report.json]');
    process.exit(1);
  }

  assembleProduction({ inputs, output, report, extractFrames })
    .then((rep) => {
      console.log('✅ Assembly complete:', rep.output.path);
      console.log(`   Duration: ${rep.output.durationSec}s, Dimensions: ${rep.output.width}x${rep.output.height}`);
      if (rep.extractedContinuationFrames.length > 0) {
        console.log(`   Continuation frames extracted: ${rep.extractedContinuationFrames.length}`);
      }
    })
    .catch((err) => {
      console.error('❌ Assembly failed:', err.message);
      process.exit(1);
    });
}

