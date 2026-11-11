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

const DIALOGUE_VERBS = Object.freeze([
  'says', 'whispers', 'shouts', 'asks', 'replies', 'murmurs', 'exclaims', 'gasps', 'laughs', 'mutters',
]);

export const STANDARD_VIDEO_NEGATIVE = 'subtitles, captions, watermark, text on screen, logo, blurry faces, distorted hands';

export function isVeoModel(model) {
  return Boolean(model && /\bveo\b/i.test(String(model)));
}

export function formatTimestampBeats(beats = []) {
  if (!Array.isArray(beats) || beats.length === 0) return '';
  return beats
    .filter((b) => b && b.description && String(b.description).trim())
    .map((b) => {
      const start = String(b.start || '00:00').trim();
      const end = String(b.end || '00:02').trim();
      const desc = String(b.description).trim().replace(/\s+/g, ' ');
      return `[${start}-${end}] ${desc}`;
    })
    .join(' ');
}

export function buildVideoPrompt({
  prompt,
  subject = null,
  setting = null,
  camera = null,
  style = null,
  model = null,
  audio = null,
  negative = null,
  includeStandardNegative = false,
} = {}) {
  const base = String(prompt || '').trim();
  if (!base) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt is required and must be a non-empty string');
  }
  if (base.length > 8000) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'prompt must be ≤ 8000 characters');
  }
  // Single-line: Flow's chat box splits typed newlines into separate message
  // bubbles (only the last stays as the draft), so join with sentence breaks.
  const parts = [];
  if (subject && String(subject).trim()) {
    parts.push(`${String(subject).trim().replace(/\s+/g, ' ')}.`);
  }
  parts.push(base.replace(/\s+/g, ' '));
  if (setting && String(setting).trim()) {
    parts.push(`Setting: ${String(setting).trim().replace(/\s+/g, ' ').slice(0, 400)}.`);
  }
  if (camera && String(camera).trim()) {
    parts.push(`Camera move: ${String(camera).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
  }
  if (style && String(style).trim()) {
    parts.push(`Style: ${String(style).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
  }

  // Selective, model-aware audio scaffolding: never inject experimental Veo audio tags unconditionally.
  const allowAudio = audio && typeof audio === 'object' && (isVeoModel(model) || audio.force === true);
  if (allowAudio) {
    const lowerBase = base.toLowerCase();
    const hasDialogue = DIALOGUE_VERBS.some((verb) => lowerBase.includes(verb));
    if (hasDialogue && Array.isArray(audio.voiceProfiles) && audio.voiceProfiles.length > 0 && !lowerBase.includes('character voices:')) {
      const voices = audio.voiceProfiles
        .filter((v) => v && v.name && v.voiceDescription)
        .map((v) => `${String(v.name).trim()}: ${String(v.voiceDescription).trim().replace(/\s+/g, ' ')}`);
      if (voices.length > 0) {
        parts.push(`Character voices: ${voices.join('. ')}.`);
      }
    }
    if (audio.sfx && String(audio.sfx).trim()) {
      parts.push(`SFX: ${String(audio.sfx).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
    }
    if (audio.ambient && String(audio.ambient).trim()) {
      parts.push(`Audio: ${String(audio.ambient).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
    } else if (audio.allowMusic === false && !lowerBase.includes('audio:') && !lowerBase.includes('music:')) {
      parts.push(audio.allowVoice
        ? 'Audio: no background music. Keep character dialogue and natural ambient sounds.'
        : 'Audio: natural ambient sounds only, no background music, no narration.');
    }
  }

  if (negative && String(negative).trim()) {
    parts.push(`Negative: ${String(negative).trim().replace(/\s+/g, ' ').slice(0, 300)}.`);
  } else if (includeStandardNegative === true && !base.toLowerCase().includes('negative:')) {
    parts.push(`Negative: ${STANDARD_VIDEO_NEGATIVE}.`);
  }

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

export function normalizePromptText(text) {
  return String(text || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\r\n\t\u00a0\u2000-\u200a\s]+/g, ' ')
    .trim();
}

export async function readEditorText(locator) {
  if (!locator) return '';
  if (typeof locator.inputValue === 'function') {
    const inputVal = await locator.inputValue().catch(() => null);
    if (typeof inputVal === 'string') return inputVal;
  }
  if (typeof locator.evaluate === 'function') {
    // Rich editors (Slate/ProseMirror contenteditable) render paragraphs as block
    // nodes without inter-node spaces; innerText preserves line breaks while
    // textContent concatenates adjacent blocks directly together.
    const evaluated = await locator.evaluate((el) => {
      if (!el) return '';
      if (typeof el.value === 'string') return el.value;
      const inner = typeof el.innerText === 'string' ? el.innerText : '';
      return inner !== '' ? inner : (el.textContent || '');
    }).catch(() => null);
    if (typeof evaluated === 'string') return evaluated;
  }
  if (typeof locator.textContent === 'function') {
    return (await locator.textContent().catch(() => '')) || '';
  }
  return '';
}

export function cameraMoves() {
  return [...CAMERA_MOVES];
}
