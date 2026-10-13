import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getFlowHome, get } from '../utils/config.js';

// Fallback catalog used only when neither user config nor live discovery
// has produced a list (first run, offline). Live discovery overwrites this.
// W03: exact live image identities preserved verbatim (Pro / 2 Lite / 2.1 per
// manual-live-image-models.json). Stale "Nano Banana 2" is NOT a live model —
// it is kept out of the fallback so callers cannot mistake it for availability.
// Fallback entries carry source:fallback provenance (see getModelProvenance),
// never source:live.
export const FALLBACK_CATALOG = {
  imageModels: ['Nano Banana Pro', 'Nano Banana 2 Lite', 'Nano Banana 2.1', 'Imagen 4'],
  videoModels: ['Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Veo 3.1 - Lite', 'Omni Flash', 'Omni 1.1 Flash'],
  ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
  videoRatios: ['16:9', '9:16'],
  durations: ['4s', '6s', '8s', '10s'],
  qualities: ['360p', '720p'],
};

// Conservative capability defaults for models we have never seen:
// assume NO ingredients/extend (Quality-like restrictions) — fail closed.
// ingredientsRequireDuration preserves the shipped force-8s-with-ingredients
// behavior for every model until P1-3 live discovery authoritatively relaxes
// a per-model value. No per-model duration claim is asserted anywhere here.
export const DEFAULT_CAPS = { ingredients: false, extend: false, frames: true, ingredientsRequireDuration: '8s' };

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

// Max age for live-discovered capabilities before they stop overriding the
// static table (judgment value: Flow ships UI changes on week-ish cadences;
// an explicit refresh rewrites the timestamp). Stale entries fall back to
// KNOWN_CAPS → DEFAULT_CAPS rather than asserting possibly-rotted values.
export const LIVE_CAPS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Keys discoverCapabilities() is allowed to write. Deliberately excludes
// ingredientsRequireDuration: duration requirements are not observable from
// option-row presence, so discovery must never assert them (rule: the
// conservative P1-2 default keeps forcing until verified otherwise).
const LIVE_CAPS_KEYS = ['ingredients', 'frames', 'extend'];

export function capsFor(modelName) {
  const key = String(modelName || '').toLowerCase();
  const live = liveCapsFor(key);
  // Defaults merge under known entries so new conservative keys (e.g.
  // ingredientsRequireDuration) apply to known models too until P1-3
  // discovery overrides them per-model from the live UI.
  if (live) return { ...DEFAULT_CAPS, ...KNOWN_CAPS[key], ...live, known: true, source: 'live-cache' };
  const known = KNOWN_CAPS[key];
  if (known) return { ...DEFAULT_CAPS, ...known, known: true, source: 'static' };
  return { ...DEFAULT_CAPS, known: false, source: 'default' };
}

/**
 * Pure scrubber (unit-tested): keep only explicitly-observed booleans for
 * known keys. Anything malformed → null (fall back to static), never guess.
 */
export function scrubLiveCaps(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {};
  for (const k of LIVE_CAPS_KEYS) {
    if (typeof entry[k] === 'boolean') out[k] = entry[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function liveCapsFor(lowerName) {
  try {
    const cache = loadCatalog();
    const age = Date.now() - new Date(cache?.capabilitiesObservedAt).getTime();
    if (!Number.isFinite(age) || age > LIVE_CAPS_MAX_AGE_MS) return null;
    const entry = cache?.capabilities?.[lowerName];
    return scrubLiveCaps(entry);
  } catch {
    return null;
  }
}

/**
 * Ingredients duration gate (parent #2 correction): model-blind 8s force
 * REMOVED. Previously every model with ingredients coerced to 8s, which hid
 * unknown/unsupported combinations as false-ready. Now always passes through
 * the requested duration (forced:false); callers must use
 * getDurationVerdict() with the exact bound capability record and BLOCK on
 * unknown/unsupported instead of coercing. Preserves syntax vs semantics
 * (parse via capabilities.parseDurationSyntax upstream).
 * Returns { duration, forced:false }.
 */
export function resolveIngredientsDuration(caps, requestedDuration, hasIngredients) {
  void caps;
  if (!hasIngredients) return { duration: requestedDuration, forced: false };
  return { duration: requestedDuration, forced: false };
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
    // literals below are last-resort fallbacks only. W03: image default is the
    // observed live Pro variant, never the stale "Nano Banana 2".
    const def = kind === 'video'
      ? get('defaultVideoModel', 'Omni 1.1 Flash')
      : get('defaultImageModel', 'Nano Banana Pro');
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

/**
 * W03 provenance (parent #4 correction): config is a planning candidate,
 * NOT observed availability. Cached live observations require freshness and
 * account/project binding; stale or unbound cache is not currently available.
 * UI selection readback (isModelLiveVerified) may verify an exact model live
 * regardless of fallback/config provenance.
 * getModelProvenance(name, opts) where opts = { nowMs, accountKey, projectId,
 * maxAgeMs }. Returns { name, source, available }.
 * source: live|live-cache|config|fallback|unknown. available:true only for
 * fresh, binding-matched live cache.
 */
export function getModelProvenance(name, opts = {}) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return { name: String(name || ''), source: 'unknown', available: false };
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? LIVE_CAPS_MAX_AGE_MS;
  try {
    const cache = loadCatalog();
    if (cache) {
      const cached = [...(cache?.imageModels || []), ...(cache?.videoModels || [])].map((s) => String(s).toLowerCase());
      if (cached.includes(norm)) {
        const observedAt = cache.observedAt || cache.discoveredAt || cache.capabilitiesObservedAt || cache.savedAt;
        const age = nowMs - new Date(observedAt).getTime();
        const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
        if (!fresh) {
          // Stale cache is not currently available (parent #4).
        } else if (cache.accountKey || cache.projectId) {
          // Bound cache requires matching binding.
          const accountOk = !cache.accountKey || !opts.accountKey || cache.accountKey === opts.accountKey;
          const projectOk = !cache.projectId || !opts.projectId || cache.projectId === opts.projectId;
          if (accountOk && projectOk) {
            return { name: String(name), source: cache?.source === 'live' ? 'live' : 'live-cache', available: true };
          }
        } else if (!opts.accountKey && !opts.projectId) {
          // Unbound cache with no binding requested: accept as live-cache
          // (legacy caches predate binding), but flag needsBinding.
          return { name: String(name), source: cache?.source === 'live' ? 'live' : 'live-cache', available: true, needsBinding: true };
        } else {
          // Caller requires binding but cache has none → not available.
        }
      }
    }
  } catch { /* fall through */ }
  const cfgImages = Object.keys(get('imageModels', {})).map((s) => s.toLowerCase());
  const cfgVideos = Object.keys(get('videoModels', {})).map((s) => s.toLowerCase());
  if (cfgImages.includes(norm) || cfgVideos.includes(norm)) {
    return { name: String(name), source: 'config', available: false, reason: 'config is planning candidate, not observed availability' };
  }
  const fb = [...FALLBACK_CATALOG.imageModels, ...FALLBACK_CATALOG.videoModels].map((s) => s.toLowerCase());
  if (fb.includes(norm)) {
    return { name: String(name), source: 'fallback', available: false };
  }
  return { name: String(name), source: 'unknown', available: false };
}

export function listModelsWithProvenance(kind = 'video', opts = {}) {
  const universe = kind === 'image' ? getUniverse().imageModels : getUniverse().videoModels;
  return universe.map((name) => ({ name, ...getModelProvenance(name, opts) }));
}

/**
 * UI selection readback may verify an exact model live regardless of
 * fallback/config provenance (parent #4). Exact (case-insensitive,
 * punctuation-insensitive) match between requested and observed chip/row.
 */
export function isModelLiveVerified(requested, observed) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const a = norm(requested);
  const b = norm(observed);
  return Boolean(a && b && a === b);
}

/**
 * W03 semantic durations: the live verified set for this session.
 * Returns { durations, source } where source is live-cache|config|fallback|unknown.
 * Empty durations means unknown (blocks per §9.1) — never synthesize 1-30.
 */
export function getLiveDurations() {
  try {
    const cache = loadCatalog();
    if (Array.isArray(cache?.durations) && cache.durations.length > 0) {
      return { durations: [...cache.durations], source: cache.source || 'live-cache' };
    }
  } catch { /* ignore */ }
  const cfg = get('durations', null);
  if (Array.isArray(cfg) && cfg.length > 0) return { durations: [...cfg], source: 'config' };
  return { durations: [...FALLBACK_CATALOG.durations], source: 'fallback' };
}
