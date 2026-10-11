/**
 * W03 — Models, settings, capability combinations (pure helpers).
 *
 * Owns NO browser connection. All functions here are pure/string-based so
 * they are unit-testable with semantic HTML fixtures and need no live CDP.
 *
 * Provenance: story-production plan §9.1 + W03, QA F04/F05/R02/F09, worker
 * remediation P2 (F04/F05), independent-review G4 (duration allowlist).
 */

export const QUOTE_MAX_AGE_MS = 30 * 1000;
export const CAPABILITY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const CHANGELOG_MARKERS = [/view all changelogs/i, /get started/i, /changelog/i];
const MODEL_ROW_MARKERS = [/nano/i, /banana/i, /imagen/i, /veo/i, /omni/i];
const SETTINGS_SUPPORT_MARKERS = [
  /generating will use/i,
  /x1/i,
  /16:9|4:3|1:1|3:4|9:16/i,
  /arrow_drop_down|menu-trigger/i,
  /image\b/i,
  /video\b/i,
];

/**
 * Decide whether a panel's visible text is the verified generation-settings
 * (composer) panel — not a changelog dialog, grid surface, or empty shell.
 * NOTE: text-only is a weak signal (parent #5). It is kept as a fast
 * pre-filter only; the authoritative gate is assessSettingsPanelStructure()
 * via DOM control ownership (see safe-actions isVerifiedSettingsPanel).
 * Returns { isSettings, reason }.
 */
export function isGenerationSettingsPanelText(text) {
  const t = String(text || '');
  if (CHANGELOG_MARKERS.some((re) => re.test(t))) {
    // Changelog dialogs can contain model-like suggestion cards; they are
    // never generation settings (F04).
    return { isSettings: false, reason: 'changelog-dialog' };
  }
  const hasModelRow = MODEL_ROW_MARKERS.some((re) => re.test(t));
  if (!hasModelRow) {
    return { isSettings: false, reason: 'no-model-row (empty shell or foreign panel)' };
  }
  const supportHits = SETTINGS_SUPPORT_MARKERS.filter((re) => re.test(t)).length;
  if (supportHits === 0) {
    return { isSettings: false, reason: 'model token without settings context' };
  }
  return { isSettings: true, reason: 'composer settings identity (text pre-filter only)' };
}

/**
 * Authoritative panel-identity gate via DOM control ownership/structure
 * (parent #5). Text substring alone admits suggestion dropdowns
 * ("Nano ... Image"); structure does not.
 * Input is observed booleans from the panel's owned DOM (see
 * safe-actions isVerifiedSettingsPanel for extraction):
 * - hasModelRow: owned model row (button.mat-mdc-menu-trigger with model text)
 * - hasQuantityOrRatio: owned quantity (x1..x4) and/or ratio control
 * - hasCreditNote: owned "Generating will use" credit note
 * - hasModeTabs: owned Image/Video mode control
 * - hasChangelogMarker: owned changelog marker (View all changelogs/Get started)
 * - controlCount: number of owned interactive controls (buttons/tabs/options)
 */
export function assessSettingsPanelStructure({
  hasModelRow = false,
  hasQuantityOrRatio = false,
  hasCreditNote = false,
  hasModeTabs = false,
  hasChangelogMarker = false,
  controlCount = 0,
} = {}) {
  if (hasChangelogMarker) {
    return { isSettings: false, reason: 'changelog-marker owned by panel' };
  }
  if (!hasModelRow) {
    return { isSettings: false, reason: 'no owned model row' };
  }
  // Suggestion/model dropdowns carry model names but no settings controls.
  if (!hasQuantityOrRatio && !hasCreditNote && !hasModeTabs) {
    return { isSettings: false, reason: 'model names without owned settings controls (dropdown/suggestion)' };
  }
  if (controlCount < 3) {
    return { isSettings: false, reason: 'insufficient owned settings controls' };
  }
  return { isSettings: true, reason: 'owned composer settings controls verified' };
}

/**
 * Readiness gate: never ready from ok:true verified:false (F04/R02).
 * Parent #5: empty verification cannot prove requested settings.
 * Caller must pass an explicit nonempty required set, e.g.
 * isSettingsReady(results, ['mode','model','ratio','quantity']).
 * Returns true only when every required kind has an {ok:true,verified:true}
 * entry AND every entry in results is ok+verified.
 */
export function isSettingsReady(results, requiredKinds) {
  if (!Array.isArray(results) || results.length === 0) return false;
  if (!Array.isArray(requiredKinds) || requiredKinds.length === 0) return false;
  for (const kind of requiredKinds) {
    const hit = results.find((r) => r && r.kind === kind && r.ok === true && r.verified === true);
    if (!hit) return false;
  }
  return results.every((r) => r && r.ok === true && r.verified === true);
}

// --- Model-field decontamination (F09/C4) ---------------------------------

const ICON_LIGATURES = [
  'arrow_drop_down',
  'arrow_drop_up',
  'apps_spark_2',
  'volume_up',
  'tune',
  'settings_2',
  'crop_landscape',
  'crop_portrait',
];

export function decontaminateModelField(raw) {
  let s = String(raw || '');
  for (const icon of ICON_LIGATURES) {
    s = s.replace(new RegExp(icon, 'gi'), ' ');
  }
  // Crop tokens: crop_16_9 / crop_square / bare square glyph tails.
  s = s.replace(/\bcrop_\d+_\d+\b/gi, ' ');
  s = s.replace(/\bcrop_square\b/gi, ' ');
  s = s.replace(/\bcrop\b/gi, ' ');
  // Lone ratio glyph tails (▢ ▯ □ etc.) and emoji leaders.
  s = s.replace(/[▢▯□◻◼]/g, ' ');
  s = s.replace(/^[\p{Emoji}\p{So}\u2000-\u2BFF]+\s*/u, '').trim();
  s = s.replace(/\s+/g, ' ').trim();
  // Quantity/ratio tails that leak into a combined chip.
  let prev;
  do {
    prev = s;
    s = s.replace(/[\u00c2\u00a0·•|–—\s-]+$/u, '').trim();
    s = s.replace(/[x×]\s*[1-4]\s*$/iu, '').trim();
    s = s.replace(/[\u00c2\u00a0·•|–—\s-]+$/u, '').trim();
    s = s.replace(/(\d+\s*:\s*\d+)\s*$/i, '').trim();
    s = s.replace(/[\u00c2\u00a0·•|–—\s-]+$/u, '').trim();
  } while (s !== prev);
  return s;
}

export function parseQualityToken(text) {
  const m = String(text || '').trim().match(/^(360p|720p|1080p)$/i);
  return m ? m[1].toLowerCase().replace('p', 'p') : null;
}

// --- Duration syntax vs semantics (G4) -------------------------------------

/** Syntactic parse only: canonical Flow duration labels. Never invents 1-30. */
export function parseDurationSyntax(text) {
  const m = String(text || '').trim().match(/^(\d+)\s*s?$/i);
  if (!m) return null;
  const canon = `${m[1]}s`;
  return ['4s', '6s', '8s', '10s'].includes(canon) ? canon : null;
}

/** Tri-state capability: missing row is unknown, never proof unsupported. */
export function toTriState({ present, enabled = true, restriction = '' } = {}) {
  if (!present) return { state: 'unknown', reason: 'row absent: unknown, not unsupported' };
  if (enabled) return { state: 'supported', reason: 'row present and enabled' };
  return { state: 'unsupported', reason: `disabled: ${restriction || 'explicit restriction'}` };
}

function normDuration(d) {
  const p = parseDurationSyntax(d);
  return p;
}

/**
 * Semantic duration verdict via exact bound capability record (parent #2).
 * Global catalog arrays/config/doc sets cannot prove semantic support.
 * Caller must supply the positively observed exact record for
 * model+feature+ratio+quality+refs:
 *   exactRecord = { supportedDurations:[...], disabledDurations?:[...],
 *                   observedAt, evidence }
 * - syntax invalid → unsupported (never invent 1-30).
 * - missing model/feature/record → unknown (blocks).
 * - stale record → unknown (blocks; re-observe).
 * - duration in supportedDurations → supported (even unknown model names, if
 *   positively observed; no hardcoded whitelist).
 * - duration in disabledDurations → unsupported (explicit disabled evidence).
 * - membership absence alone → unknown (blocks), unless explicit disabled.
 */
export function getDurationVerdict({ model, feature, ratio = '', quality = '', refs = '', duration, exactRecord = null } = {}) {
  const syn = normDuration(duration);
  if (!syn) {
    return { state: 'unsupported', reason: `syntactically invalid duration "${duration}"`, duration: null };
  }
  if (!model || !feature) {
    return { state: 'unknown', reason: 'missing model/feature binding', duration: syn };
  }
  if (!exactRecord || !Array.isArray(exactRecord.supportedDurations)) {
    return { state: 'unknown', reason: 'no exact bound capability record: blocks (global set cannot prove support)', duration: syn };
  }
  // Binding check: exact record must belong to the requested combination.
  // Mismatched model/feature/ratio/quality/refs cannot prove support.
  const norm = (s) => String(s || '').toLowerCase().trim();
  if (exactRecord.model && norm(exactRecord.model) !== norm(model)) {
    return { state: 'unknown', reason: 'exact record model mismatch: blocks', duration: syn };
  }
  if (exactRecord.feature && norm(exactRecord.feature) !== norm(feature)) {
    return { state: 'unknown', reason: 'exact record feature mismatch: blocks', duration: syn };
  }
  if (exactRecord.ratio && norm(exactRecord.ratio) !== norm(ratio)) {
    return { state: 'unknown', reason: 'exact record ratio mismatch: blocks', duration: syn };
  }
  if (exactRecord.quality && norm(exactRecord.quality) !== norm(quality)) {
    return { state: 'unknown', reason: 'exact record quality mismatch: blocks', duration: syn };
  }
  if (exactRecord.refs && norm(exactRecord.refs) !== norm(refs)) {
    return { state: 'unknown', reason: 'exact record refs mismatch: blocks', duration: syn };
  }
  if (exactRecord.observedAt && !isCapabilityFresh(exactRecord.observedAt, Date.now(), CAPABILITY_MAX_AGE_MS)) {
    return { state: 'unknown', reason: 'exact record stale: blocks', duration: syn };
  }
  const supported = exactRecord.supportedDurations.map(normDuration).filter(Boolean);
  const disabled = Array.isArray(exactRecord.disabledDurations)
    ? exactRecord.disabledDurations.map(normDuration).filter(Boolean)
    : [];
  if (supported.includes(syn)) {
    return { state: 'supported', reason: `duration ${syn} positively observed for exact record`, duration: syn };
  }
  if (disabled.includes(syn)) {
    return { state: 'unsupported', reason: `duration ${syn} explicitly disabled for exact record`, duration: syn };
  }
  return { state: 'unknown', reason: `duration ${syn} absence alone is unknown (no explicit disabled evidence): blocks`, duration: syn };
}

export function makeCapabilityRecord({ model, feature, ratio = '', duration = '', quality = '', quantity = '', state = 'unknown', evidence = '' } = {}) {
  const key = [model, feature, ratio, duration, quality, quantity].map((s) => String(s || '').toLowerCase().trim()).filter(Boolean).join('|');
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CAPABILITY_MAX_AGE_MS).toISOString();
  return { key, model, feature, ratio, duration, quality, quantity, state, evidence, observedAt, expiresAt };
}

export function isCapabilityFresh(observedAt, nowMs = Date.now(), maxAgeMs = CAPABILITY_MAX_AGE_MS) {
  const age = nowMs - new Date(observedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
