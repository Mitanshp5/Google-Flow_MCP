import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { FlowError, ErrorCodes } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

// Normalized evaluation weights — exact sum = 1.00 (100%)
export const VIDEO_REVIEW_WEIGHTS = Object.freeze({
  character_consistency: 0.25,
  prompt_adherence: 0.20,
  motion_quality: 0.20,
  temporal_coherence: 0.15,
  visual_fidelity: 0.10,
  composition: 0.10,
});

export const REVIEW_DIMENSIONS = Object.freeze(Object.keys(VIDEO_REVIEW_WEIGHTS));

export function computeOverallVideoScore(dimensions = {}) {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'dimensions object is required for video review scoring');
  }
  let weightedSum = 0;
  for (const dim of REVIEW_DIMENSIONS) {
    const raw = dimensions[dim];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 10) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS, `Dimension '${dim}' must be a finite number in [0, 10], got ${raw}`, { dimension: dim, value: raw });
    }
    weightedSum += raw * VIDEO_REVIEW_WEIGHTS[dim];
  }
  return Math.round(weightedSum * 100) / 100;
}

export function classifyVideoVerdict(overallScore) {
  if (typeof overallScore !== 'number' || !Number.isFinite(overallScore)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'overallScore must be a finite number');
  }
  if (overallScore >= 9.0) return 'excellent';
  if (overallScore >= 7.5) return 'good';
  if (overallScore >= 6.0) return 'acceptable';
  if (overallScore >= 4.0) return 'poor';
  return 'unusable';
}

export function generateAdvisoryFixGuide(dimensions = {}, findings = []) {
  const detectedIssues = new Set();
  const safeFindings = Array.isArray(findings) ? findings : [];

  for (const item of safeFindings) {
    const severity = String(item?.severity || '').toUpperCase();
    const desc = String(item?.description || '').toLowerCase();
    if (severity === 'CRITICAL' || severity === 'HIGH') {
      if (/(drift|morph|limb|distort|warp)/.test(desc)) detectedIssues.add('drift');
      if (/(swap|wrong character|identity|outfit mismatch)/.test(desc)) detectedIssues.add('identity_swap');
      if (/(count|number of character|extra character)/.test(desc)) detectedIssues.add('count');
      if (/(logo|brand|watermark|subtitle|caption|text on screen)/.test(desc)) detectedIssues.add('text_logo');
      if (/(role|wrong action)/.test(desc)) detectedIssues.add('role');
      if (/(reverse|backward)/.test(desc)) detectedIssues.add('reverse');
      if (/(continuity|seam|jump cut)/.test(desc)) detectedIssues.add('continuity');
    }
  }

  const recommendations = [];
  if (detectedIssues.has('drift')) {
    recommendations.push("Simplify motion prompt and add 'steady camera, consistent silhouette'.");
  }
  if (detectedIssues.has('identity_swap')) {
    recommendations.push('Use stronger visual contrast between actors and bind distinct clothing/prop anchors.');
  }
  if (detectedIssues.has('count')) {
    recommendations.push('Make one character dominant in foreground; relegate extras to deep background.');
  }
  if (detectedIssues.has('text_logo')) {
    recommendations.push("Append explicit negative filter: 'Negative: subtitles, captions, watermark, brand logos, text on screen'.");
  }
  if (detectedIssues.has('role')) {
    recommendations.push('Rewrite action clauses to explicitly bind each character name to their specific action.');
  }
  if (detectedIssues.has('reverse')) {
    recommendations.push('Reverse motion artifact detected; regenerate video take (requires explicit authorization).');
  }
  if (detectedIssues.has('continuity')) {
    recommendations.push('Re-verify parent shot last-frame extraction and transition prompt continuity.');
  }

  if (recommendations.length > 0) {
    return {
      advisoryOnly: true,
      requiresAuthorizationForRegen: true,
      detectedIssues: [...detectedIssues],
      suggestedAction: recommendations.join(' '),
      lowestDimension: findLowestDimension(dimensions),
    };
  }

  const lowest = findLowestDimension(dimensions);
  const defaultGuides = {
    character_consistency: 'Inspect character identity references and tighten character descriptors.',
    prompt_adherence: 'Clarify camera angle and concrete action verbs in prompt.',
    motion_quality: 'Consider a fresh video take with simplified movement (requires authorization).',
    temporal_coherence: 'Check lighting continuity across start/end frames and avoid conflicting optics.',
    visual_fidelity: 'Verify resolution setting or consider a higher-quality model tier (requires authorization).',
    composition: 'Refine camera framing/angle sentence cleanly separated from action prose.',
  };

  return {
    advisoryOnly: true,
    requiresAuthorizationForRegen: true,
    detectedIssues: [],
    lowestDimension: lowest,
    suggestedAction: defaultGuides[lowest] || 'No critical defects flagged.',
  };
}

function findLowestDimension(dimensions = {}) {
  let lowestKey = REVIEW_DIMENSIONS[0];
  let lowestVal = Infinity;
  for (const dim of REVIEW_DIMENSIONS) {
    const val = dimensions[dim];
    if (typeof val === 'number' && val < lowestVal) {
      lowestVal = val;
      lowestKey = dim;
    }
  }
  return lowestKey;
}

export function evaluateVideoReview({
  dimensions,
  findings = [],
  shotId = null,
  notes = null,
} = {}) {
  const overallScore = computeOverallVideoScore(dimensions);
  const verdict = classifyVideoVerdict(overallScore);
  const fixGuide = generateAdvisoryFixGuide(dimensions, findings);

  return {
    advisoryOnly: true,
    requiresAuthorizationForRegen: true,
    shotId,
    overallScore,
    verdict,
    weights: { ...VIDEO_REVIEW_WEIGHTS },
    dimensions: { ...dimensions },
    findings: Array.isArray(findings) ? findings : [],
    fixGuide,
    notes,
  };
}

async function probeVideoBasic(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Video file not found for review: ${filePath}`, { filePath });
  }
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    abs,
  ], { shell: false, timeout: 30000 });
  const data = JSON.parse(stdout);
  const vStream = (data.streams || []).find((s) => s.codec_type === 'video');
  if (!vStream) {
    throw new FlowError(ErrorCodes.VALIDATION_ERROR, `No video stream found in file: ${filePath}`, { filePath });
  }
  const durationSec = Number(vStream.duration || data.format?.duration || 0);
  return {
    path: abs,
    width: vStream.width,
    height: vStream.height,
    durationSec,
    codec: vStream.codec_name,
  };
}

/**
 * Extracts an advisory contact sheet image grid from a video clip using local FFmpeg.
 * Optionally extracts first, midpoint, and last frames alongside the grid.
 */
export async function extractVideoContactSheet(videoPath, outputPath, {
  cols = 4,
  rows = 2,
  thumbWidth = 320,
  extractKeyFrames = false,
} = {}) {
  const probe = await probeVideoBasic(videoPath);
  const absOut = path.resolve(outputPath);
  const outDir = path.dirname(absOut);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const safeCols = Math.max(1, Math.min(8, Math.floor(Number(cols) || 4)));
  const safeRows = Math.max(1, Math.min(8, Math.floor(Number(rows) || 2)));
  const totalSlots = safeCols * safeRows;
  const duration = Math.max(0.2, probe.durationSec || 1);
  const targetFps = Math.max(0.2, totalSlots / duration);
  const safeWidth = Math.max(120, Math.min(640, Math.floor(Number(thumbWidth) || 320)));

  const vf = `fps=${targetFps.toFixed(4)},scale=${safeWidth}:-2:flags=lanczos,tile=${safeCols}x${safeRows}`;

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', probe.path,
    '-vf', vf,
    '-frames:v', '1',
    absOut,
  ], { shell: false, timeout: 60000 });

  if (!fs.existsSync(absOut) || fs.statSync(absOut).size === 0) {
    throw new FlowError(ErrorCodes.STORAGE_IO_ERROR, `Contact sheet generation produced empty or missing output: ${outputPath}`);
  }

  const keyFrames = {};
  if (extractKeyFrames) {
    const baseName = path.basename(absOut, path.extname(absOut));
    const points = [
      { key: 'first', ss: 0 },
      { key: 'mid', ss: Math.max(0, duration / 2) },
    ];
    for (const pt of points) {
      const kfPath = path.join(outDir, `${baseName}_${pt.key}.png`);
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', pt.ss.toFixed(3),
        '-i', probe.path,
        '-frames:v', '1',
        kfPath,
      ], { shell: false, timeout: 30000 });
      keyFrames[pt.key] = kfPath;
    }
    const lastKfPath = path.join(outDir, `${baseName}_last.png`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-sseof', '-0.05',
      '-i', probe.path,
      '-update', '1',
      '-frames:v', '1',
      lastKfPath,
    ], { shell: false, timeout: 30000 });
    keyFrames.last = lastKfPath;
  }

  return {
    advisoryOnly: true,
    contactSheetPath: absOut,
    sizeBytes: fs.statSync(absOut).size,
    grid: `${safeCols}x${safeRows}`,
    targetFrames: totalSlots,
    videoProbe: probe,
    keyFrames,
  };
}
