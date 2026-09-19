import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getFlowHome, get } from '../utils/config.js';

// Fallback catalog used only when neither user config nor live discovery
// has produced a list (first run, offline). Live discovery overwrites this.
export const FALLBACK_CATALOG = {
  imageModels: ['Nano Banana Pro', 'Nano Banana 2', 'Imagen 4'],
  videoModels: ['Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Veo 3.1 - Lite', 'Omni Flash', 'Omni 1.1 Flash'],
  ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
  videoRatios: ['16:9', '9:16'],
  durations: ['4s', '6s', '8s', '10s'],
  qualities: ['360p', '720p'],
};

// Conservative capability defaults for models we have never seen:
// assume NO ingredients/extend (Quality-like restrictions) — fail closed.
export const DEFAULT_CAPS = { ingredients: false, extend: false, frames: true };

// Known capability overrides (verified against Flow support docs).
export const KNOWN_CAPS = {
  'veo 3.1 - fast': { ingredients: true, extend: true, frames: true },
  'veo 3.1 - lite': { ingredients: true, extend: true, frames: true },
  'veo 3.1 - quality': { ingredients: false, extend: false, frames: true },
  'omni flash': { ingredients: false, extend: false, frames: false },
  'omni 1.1 flash': { ingredients: false, extend: false, frames: false },
};

function catalogPath() {
  return path.join(getFlowHome(), 'config', 'flow.models.json');
}

export function loadCatalog() {
  try {
    const f = catalogPath();
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (data && Array.isArray(data.videoModels)) return data;
    }
  } catch (e) {
    logger.debug('Model catalog cache unreadable', { error: e.message });
  }
  return null;
}

export function saveCatalog(catalog) {
  const f = catalogPath();
  try {
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...catalog, savedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, f);
    logger.info('Model catalog saved', {
      video: catalog.videoModels?.length, image: catalog.imageModels?.length, source: catalog.source,
    });
  } catch (e) {
    logger.warn('Could not save model catalog', { error: e.message });
  }
}

function uniq(list) {
  const seen = new Set();
  return (list || []).filter(x => {
    const k = String(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Merged model universe: user config ∪ live-discovered cache ∪ fallback.
 * Nothing here is hardcoded as source of truth — config and discovery win.
 */
export function getUniverse() {
  const cfgImages = Object.keys(get('imageModels', {}));
  const cfgVideos = Object.keys(get('videoModels', {}));
  const cache = loadCatalog();
  return {
    imageModels: uniq([...cfgImages, ...(cache?.imageModels || []), ...FALLBACK_CATALOG.imageModels]),
    videoModels: uniq([...cfgVideos, ...(cache?.videoModels || []), ...FALLBACK_CATALOG.videoModels]),
    ratios: uniq([...get('ratios', []), ...(cache?.ratios || []), ...FALLBACK_CATALOG.ratios]),
    videoRatios: uniq([...get('videoRatios', []), ...(cache?.videoRatios || []), ...FALLBACK_CATALOG.videoRatios]),
    durations: uniq([...get('durations', []), ...(cache?.durations || []), ...FALLBACK_CATALOG.durations]),
    qualities: uniq([...get('qualities', []), ...(cache?.qualities || []), ...FALLBACK_CATALOG.qualities]),
    source: cache ? `config+cache(${cache.source || 'live'})` : 'config+fallback',
  };
}

export function capsFor(modelName) {
  const known = KNOWN_CAPS[String(modelName || '').toLowerCase()];
  if (known) return { ...known, known: true };
  return { ...DEFAULT_CAPS, known: false };
}

/**
 * Tokenize a model name for fuzzy matching: lowercase alphanumeric tokens.
 * "Omni Flash 1.1" → ["omni","flash","1","1"]; punctuation is ignored so
 * user spellings ("omni flash 1.1", "Veo-3.1-Fast") match live names.
 */
export function modelTokens(name) {
  return String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Resolve a requested model against the live universe — no frozen alias
 * table. Order: exact (case-insensitive) → normalized equality →
 * token-subset (requested tokens ⊆ candidate tokens, fewest extra tokens
 * wins; ties are ambiguous → null with candidates so the caller asks).
 * Returns { name, caps, from } or null when unknown/ambiguous.
 */
export function resolveModel(requested, kind = 'video') {
  if (!requested || String(requested).toLowerCase() === 'auto') {
    // Defaults are config-overridable (defaultVideoModel/defaultImageModel);
    // literals below are last-resort fallbacks only.
    const def = kind === 'video'
      ? get('defaultVideoModel', 'Veo 3.1 - Fast')
      : get('defaultImageModel', 'Nano Banana 2');
    return { name: def, caps: capsFor(def), from: 'default' };
  }
  const norm = String(requested).trim().toLowerCase();
  const pool = kind === 'video' ? getUniverse().videoModels : getUniverse().imageModels;
  const exact = pool.find(m => String(m).toLowerCase() === norm);
  if (exact) return { name: exact, caps: capsFor(exact), from: 'exact' };
  const squashed = norm.replace(/[^a-z0-9]+/g, '');
  const squashedHit = pool.find(m => String(m).toLowerCase().replace(/[^a-z0-9]+/g, '') === squashed);
  if (squashedHit) return { name: squashedHit, caps: capsFor(squashedHit), from: 'normalized' };
  const want = modelTokens(norm);
  if (want.length === 0) return null;
  const scored = [];
  for (const candidate of pool) {
    const have = modelTokens(candidate);
    if (want.every(t => have.includes(t))) {
      scored.push({ candidate, extra: have.length - want.length });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.extra - b.extra);
  const best = scored.filter(s => s.extra === scored[0].extra);
  if (best.length > 1) {
    logger.debug('Ambiguous model request', { requested, candidates: best.map(s => s.candidate) });
    return null;
  }
  return { name: best[0].candidate, caps: capsFor(best[0].candidate), from: 'tokens' };
}
