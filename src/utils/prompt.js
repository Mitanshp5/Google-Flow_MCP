import { FlowError, ErrorCodes } from './errors.js';

// Technical optics vocabulary (lens specs, aperture, focal length).
// Scene direction / camera movement (dolly, orbit, crane, tracking shot) is valid
// cinematic staging and is separated from technical optics.
export const TECHNICAL_OPTICS_HINTS = [
  'f/1.4', 'f/1.8', 'f/2', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11', 'f/16',
  'anamorphic', '35mm', '16mm', '8mm', '50mm', '85mm',
  'aperture', 'focal length', 'focal', 'lens',
];

export const CAMERA_MOVEMENT_HINTS = [
  'dolly', 'crane', 'orbit', 'jib', 'drone',
  'tracking shot', 'push-in', 'pull-back', 'pan', 'tilt',
  'aerial view', 'slow pan', 'camera tracks', 'camera track',
];

const CAMERA_MOVES = [
  'static', 'handheld', 'push-in', 'pull-back', 'pan', 'tilt',
  'orbit', 'dolly', 'tracking shot', 'crane shot', 'aerial view', 'slow pan',
];

export function buildVideoPrompt({ prompt, camera, style }) {
  const base = String(prompt || '').trim();
  if (!base) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt is required and must be a non-empty string');
  }
  if (base.length > 8000) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt must be ≤ 8000 characters');
  }
  // Single-line: Flow's chat box splits typed newlines into separate message
  // bubbles (only the last stays as the draft), so join with sentence breaks.
  const parts = [base.replace(/\s+/g, ' ')];
  if (camera && String(camera).trim()) parts.push(`Camera move: ${String(camera).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
  if (style && String(style).trim()) parts.push(`Style: ${String(style).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
  return parts.join(' ').slice(0, 8600);
}

export function checkPromptContradictions({ prompt, ingredients = [], startFrame, endFrame }) {
  const warnings = [];
  const lower = String(prompt || '').toLowerCase();
  const hasOptics = TECHNICAL_OPTICS_HINTS.some(h => lower.includes(h));
  if (hasOptics) {
    warnings.push('Prompt contains technical optics parameters (lens/aperture/camera body) — prefer UI selectors; keep prompt to scene+action.');
  }
  if ((startFrame || endFrame) && !/transition|start|end|frame|arc|morph|continu/i.test(String(prompt))) {
    warnings.push('Frames supplied but prompt does not describe the transition/action between them — add it for best interpolation.');
  }
  if (ingredients.length > 0 && !ingredients.some(n => lower.includes(String(n).toLowerCase().split(' ')[0]))) {
    warnings.push('Ingredients supplied but prompt does not name them — reference each ingredient by name for best blending.');
  }
  return warnings;
}

export function normalizeDuration(raw, allowed = ['4s', '6s', '8s', '10s']) {
  const dur = typeof raw === 'number' ? `${raw}s` : String(raw ?? '4s');
  return allowed.includes(dur) ? dur : null;
}

export function cameraMoves() {
  return [...CAMERA_MOVES];
}
