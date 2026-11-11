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

function normalizeClipDescriptors(inputs = [], options = {}) {
  const globalSkipLead = Number(options.skipLeadSec || 0);
  return inputs.map((item, idx) => {
    const desc = typeof item === 'string' ? { path: item } : { ...item };
    const isContinuation = desc.chainType === 'CONTINUATION' || desc.chained === true;
    const requestedSkip = Number(desc.skipLeadSec ?? globalSkipLead ?? 0);

    // Continuity Safeguard: NEVER trim lead-in frames from frame-chained continuation clips.
    const leadTrimSuppressed = isContinuation && requestedSkip > 0;
    const effectiveSkipLeadSec = isContinuation ? 0 : Math.max(0, requestedSkip);

    return {
      index: idx,
      path: desc.path,
      chainType: desc.chainType || (desc.chained ? 'CONTINUATION' : 'ROOT'),
      verifiedContinuity: Boolean(desc.verifiedContinuity),
      requestedSkipLeadSec: requestedSkip,
      effectiveSkipLeadSec,
      leadTrimSuppressedForContinuity: leadTrimSuppressed,
      targetDurationSec: desc.durationSec != null ? Number(desc.durationSec) : null,
    };
  });
}

function clampFloat(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

export async function mixAudioTrack(videoPath, audioPath, outputPath, {
  audioVolume = 1.2,
  backgroundVolume = 0.3,
  fadeInSec = 0.3,
  fadeOutSec = 0.5,
} = {}) {
  const vProbe = await probeVideo(videoPath);
  const absAudio = path.resolve(audioPath);
  if (!fs.existsSync(absAudio)) {
    throw new Error(`Audio track not found: ${audioPath}`);
  }
  const absOut = path.resolve(outputPath);
  const outDir = path.dirname(absOut);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const bgVol = clampFloat(backgroundVolume, 0, 2, 0.3);
  const fgVol = clampFloat(audioVolume, 0, 2, 1.2);
  const fIn = clampFloat(fadeInSec, 0, 10, 0.3);
  const fOut = clampFloat(fadeOutSec, 0, 10, 0.5);
  const fadeOutStart = Math.max(0, vProbe.durationSec - fOut);

  const bgChain = vProbe.hasAudio
    ? `[0:a]volume=${bgVol},aformat=sample_rates=48000:channel_layouts=stereo[bg]`
    : `aevalsrc=0:d=${vProbe.durationSec}:s=48000:c=stereo[bg]`;
  const fgChain = `[1:a]volume=${fgVol},aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=${fIn},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fOut}[fg]`;
  const filterComplex = `${bgChain};${fgChain};[bg][fg]amix=inputs=2:duration=first:normalize=0[aout]`;

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', vProbe.path,
    '-i', absAudio,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    absOut,
  ]);

  return probeVideo(absOut);
}

export async function concatVideos(inputPaths, outputPath, options = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('concatVideos requires at least one input path');
  }

  const outAbs = path.resolve(outputPath);
  const outDir = path.dirname(outAbs);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const descriptors = normalizeClipDescriptors(inputPaths, options);
  const clipInfos = [];
  for (const desc of descriptors) {
    const info = await probeVideo(desc.path);
    const maxUsable = Math.max(0.1, info.durationSec - desc.effectiveSkipLeadSec);
    const effectiveDurationSec = desc.targetDurationSec && desc.targetDurationSec > 0
      ? Math.min(maxUsable, desc.targetDurationSec)
      : maxUsable;
    clipInfos.push({
      ...info,
      ...desc,
      effectiveDurationSec,
    });
  }

  // Normalize target dimensions to first clip (or options)
  const targetWidth = options.width || clipInfos[0].width;
  const targetHeight = options.height || clipInfos[0].height;
  const targetFps = options.fps || clipInfos[0].fps || 24;
  const transitionMode = options.transition || 'auto'; // 'cut' | 'xfade' | 'auto'
  const xfadeType = /^[a-z0-9_]+$/i.test(String(options.xfadeTransition || ''))
    ? options.xfadeTransition
    : 'fade';
  const requestedXfadeDur = Number(options.xfadeDuration ?? (transitionMode === 'xfade' ? 0.5 : 0));

  const filterParts = [];
  const ffmpegArgs = ['-y'];

  for (let i = 0; i < clipInfos.length; i++) {
    const info = clipInfos[i];
    if (info.effectiveSkipLeadSec > 0) {
      ffmpegArgs.push('-ss', String(info.effectiveSkipLeadSec));
    }
    if (info.targetDurationSec && info.targetDurationSec > 0) {
      ffmpegArgs.push('-t', String(info.effectiveDurationSec));
    }
    ffmpegArgs.push('-i', info.path);

    filterParts.push(
      `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,` +
      `fps=${targetFps},settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
    );

    if (info.hasAudio) {
      filterParts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      filterParts.push(`aevalsrc=0:d=${info.effectiveDurationSec}:s=48000:c=stereo[a${i}]`);
    }
  }

  // Group into continuous segments when transitionMode === 'auto' or 'cut'
  const segments = [];
  if (transitionMode === 'xfade' && requestedXfadeDur > 0) {
    for (let i = 0; i < clipInfos.length; i++) {
      segments.push([i]);
    }
  } else if (transitionMode === 'cut' || requestedXfadeDur <= 0) {
    segments.push(clipInfos.map((_, idx) => idx));
  } else {
    // 'auto': keep consecutive CONTINUATION clips joined via hard cut in same segment
    let seg = [];
    for (let i = 0; i < clipInfos.length; i++) {
      const c = clipInfos[i];
      if (seg.length === 0 || c.chainType === 'CONTINUATION') {
        seg.push(i);
      } else {
        segments.push(seg);
        seg = [i];
      }
    }
    if (seg.length > 0) segments.push(seg);
  }

  const segNodes = [];
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const idxs = segments[sIdx];
    const segDur = idxs.reduce((acc, idx) => acc + clipInfos[idx].effectiveDurationSec, 0);
    if (idxs.length === 1) {
      const idx = idxs[0];
      segNodes.push({ v: `v${idx}`, a: `a${idx}`, durationSec: segDur });
    } else {
      const concatIn = idxs.map((idx) => `[v${idx}][a${idx}]`).join('');
      const vOut = segments.length === 1 ? 'outv' : `sv${sIdx}`;
      const aOut = segments.length === 1 ? 'outa' : `sa${sIdx}`;
      filterParts.push(`${concatIn}concat=n=${idxs.length}:v=1:a=1[${vOut}][${aOut}]`);
      segNodes.push({ v: vOut, a: aOut, durationSec: segDur });
    }
  }

  let expectedTotalDuration = 0;
  let finalV = segNodes[0].v;
  let finalA = segNodes[0].a;

  if (segNodes.length === 1) {
    expectedTotalDuration = segNodes[0].durationSec;
    if (finalV !== 'outv') {
      filterParts.push(`[${finalV}]null[outv]`);
      finalV = 'outv';
    }
    if (finalA !== 'outa') {
      filterParts.push(`[${finalA}]anull[outa]`);
      finalA = 'outa';
    }
  } else {
    const minSegDur = Math.min(...segNodes.map((s) => s.durationSec));
    const xfadeDur = Math.max(0.05, Math.min(requestedXfadeDur, minSegDur * 0.45));
    let cumDur = segNodes[0].durationSec;
    for (let k = 0; k < segNodes.length - 1; k++) {
      const offset = Math.max(0.01, cumDur - xfadeDur);
      const vIn = k === 0 ? `[${segNodes[0].v}][${segNodes[1].v}]` : `[xv${k}][${segNodes[k + 1].v}]`;
      const vOut = k === segNodes.length - 2 ? '[outv]' : `[xv${k + 1}]`;
      const aIn = k === 0 ? `[${segNodes[0].a}][${segNodes[1].a}]` : `[xa${k}][${segNodes[k + 1].a}]`;
      const aOut = k === segNodes.length - 2 ? '[outa]' : `[xa${k + 1}]`;
      filterParts.push(`${vIn}xfade=transition=${xfadeType}:duration=${xfadeDur.toFixed(3)}:offset=${offset.toFixed(3)}${vOut}`);
      filterParts.push(`${aIn}acrossfade=d=${xfadeDur.toFixed(3)}${aOut}`);
      cumDur = offset + segNodes[k + 1].durationSec;
    }
    expectedTotalDuration = cumDur;
  }

  ffmpegArgs.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    outAbs
  );

  await execFileAsync('ffmpeg', ffmpegArgs);

  if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size === 0) {
    throw new Error(`Concat completed but output file is empty or missing: ${outputPath}`);
  }

  const outputProbe = await probeVideo(outAbs);

  return {
    outputPath: outAbs,
    outputProbe,
    clips: clipInfos,
    transitionMode,
    segmentCount: segNodes.length,
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
    const clipPath = typeof inputs[i] === 'string' ? inputs[i] : inputs[i].path;
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

  const hasNarration = Boolean(options.narration);
  const hasMusic = Boolean(options.music);
  const baseTarget = (hasNarration || hasMusic)
    ? path.join(path.dirname(path.resolve(outputPath)), `.base_${path.basename(outputPath)}`)
    : outputPath;

  let concatResult = await concatVideos(inputs, baseTarget, {
    width: options.width,
    height: options.height,
    fps: options.fps,
    transition: options.transition,
    xfadeTransition: options.xfadeTransition,
    xfadeDuration: options.xfadeDuration,
    skipLeadSec: options.skipLeadSec,
  });

  let currentVideo = concatResult.outputPath;
  try {
    if (hasNarration) {
      const narrTarget = hasMusic
        ? path.join(path.dirname(path.resolve(outputPath)), `.narr_${path.basename(outputPath)}`)
        : path.resolve(outputPath);
      const mixedProbe = await mixAudioTrack(currentVideo, options.narration, narrTarget, {
        audioVolume: options.narrationVolume ?? 1.2,
        backgroundVolume: options.sfxVolume ?? 0.3,
        fadeInSec: options.fadeInSec ?? 0.3,
        fadeOutSec: options.fadeOutSec ?? 0.5,
      });
      concatResult = { ...concatResult, outputProbe: mixedProbe, outputPath: mixedProbe.path };
      currentVideo = mixedProbe.path;
    }

    if (hasMusic) {
      const finalProbe = await mixAudioTrack(currentVideo, options.music, path.resolve(outputPath), {
        audioVolume: options.musicVolume ?? 0.25,
        backgroundVolume: 1.0,
        fadeInSec: options.musicFadeInSec ?? 1.0,
        fadeOutSec: options.musicFadeOutSec ?? 1.5,
      });
      concatResult = { ...concatResult, outputProbe: finalProbe, outputPath: finalProbe.path };
    }
  } finally {
    // Cleanup temporary base/intermediary tracks
    const dir = path.dirname(path.resolve(outputPath));
    for (const tmpName of [`.base_${path.basename(outputPath)}`, `.narr_${path.basename(outputPath)}`]) {
      const tmpPath = path.join(dir, tmpName);
      if (tmpPath !== path.resolve(outputPath) && fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

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
      audioFormat: '48kHz stereo AAC',
      narrationMixed: hasNarration,
      musicMixed: hasMusic,
      sfxVolumeDuck: hasNarration ? (options.sfxVolume ?? 0.3) : 1.0,
    },
    continuityReport: {
      transitionMode: concatResult.transitionMode,
      segmentCount: concatResult.segmentCount,
      suppressedLeadTrims: concatResult.clips
        .filter((c) => c.leadTrimSuppressedForContinuity)
        .map((c) => ({ index: c.index + 1, path: c.path, reason: 'CONTINUATION_FRAME_PROTECTION' })),
    },
    clips: concatResult.clips.map((c, idx) => ({
      index: idx + 1,
      filename: c.filename,
      path: c.path,
      chainType: c.chainType,
      effectiveSkipLeadSec: c.effectiveSkipLeadSec,
      leadTrimSuppressedForContinuity: c.leadTrimSuppressedForContinuity,
      durationSec: c.durationSec,
      effectiveDurationSec: c.effectiveDurationSec,
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
  let transition = 'auto';
  let xfadeDuration = 0.5;
  let skipLeadSec = 0;
  let narration = null;
  let music = null;

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
    } else if (args[i] === '--transition') {
      transition = args[++i];
    } else if (args[i] === '--xfade-duration') {
      xfadeDuration = Number(args[++i]);
    } else if (args[i] === '--skip-lead') {
      skipLeadSec = Number(args[++i]);
    } else if (args[i] === '--narration') {
      narration = args[++i];
    } else if (args[i] === '--music') {
      music = args[++i];
    } else if (args[i] === '--manifest' || args[i] === '-m') {
      const manifestPath = args[++i];
      const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(manifestData.clips)) {
        inputs.push(...manifestData.clips);
      }
    }
  }

  if (inputs.length === 0) {
    console.error('Usage: node scripts/assemble-video.mjs --inputs <clip1> <clip2> ... --output <output.mp4> [--transition auto|cut|xfade] [--xfade-duration 0.5] [--skip-lead 1.0] [--narration <audio>] [--music <audio>] [--extract-frames] [--report report.json]');
    process.exit(1);
  }

  assembleProduction({ inputs, output, report, extractFrames, transition, xfadeDuration, skipLeadSec, narration, music })
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

