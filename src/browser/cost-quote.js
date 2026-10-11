/**
 * W03 — Cost-quote parsing (pure, no browser).
 * Evidence: "Generating will use 0 credits" / "0 credits" live labels.
 * Rule (official-source-1): costs are per generation, not per request —
 * never multiply a displayed batch total twice.
 */

export const QUOTE_MAX_AGE_MS = 30 * 1000;
export const MAX_QUANTITY = 4;

function clampQuantity(q) {
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY) {
    throw new Error(`quantity out of bound 1-${MAX_QUANTITY}: ${q}`);
  }
  return n;
}

/**
 * Parse a Flow credit label.
 * Parent #3 (strict): unit must be explicit in the observed bound label.
 * - Ambiguous nonzero ('10 credits' with no per-generation/total marker)
 *   → state:unknown (blocks, no spend). Conservative totalUpperBound is still
 *   reported as amount*quantity (worst-case per-generation) but state stays
 *   unknown so callers cannot assert known spend.
 * - Ambiguous zero ('0 credits') → known zero (0*qty=0 either way), but
 *   integration must still bind real quote evidence + freshness (30s).
 * - Rejects: negatives, commas (1,000), multiple/conflicting amounts,
 *   unrelated labels, non-credit units → unknown.
 * Returns { raw, amount, unit, quantity, totalUpperBound, state, isZero }.
 * state: known|unknown. unknown blocks (caller must not spend).
 */
export function parseCostLabel(raw, { quantity = 1 } = {}) {
  const qty = clampQuantity(quantity);
  const text = String(raw ?? '').trim();
  const unknown = (reason) => ({ raw: text, amount: null, unit: 'unknown', quantity: qty, totalUpperBound: null, state: 'unknown', isZero: false, reason });
  if (!text) return unknown('empty label');
  const lower = text.toLowerCase();
  // Must be a credit label at all.
  if (!/credits?/i.test(text)) return unknown('non-credit unit');
  // Reject negatives explicitly (e.g. "-5 credits").
  if (/-\s*\d/.test(text)) return unknown('negative amount');
  // Reject commas in numbers (1,000) — ambiguous locale grouping, do not guess.
  if (/\d,\d/.test(text)) return unknown('comma-grouped amount');
  // Collect all credit-amount candidates; multiple distinct amounts conflict.
  const amounts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*credits?/gi)].map((m) => Number(m[1]));
  if (amounts.length === 0) return unknown('no parseable amount');
  if (amounts.length > 1) {
    const distinct = [...new Set(amounts)];
    if (distinct.length > 1) return { ...unknown('conflicting multiple amounts'), amounts: distinct };
    // Same amount repeated (e.g. label + aria duplicate) — treat as single.
  }
  const amount = amounts[0];
  if (!Number.isFinite(amount)) return unknown('non-finite amount');
  let unit = null;
  if (/per generation|per image|per video|\beach\b|each generation/i.test(lower)) unit = 'per-generation';
  else if (/\btotal\b|for all|for \d+|batch total/i.test(lower)) unit = 'total';
  else if (/generating will use/i.test(lower) && !/per generation|total/i.test(lower)) {
    // Observed live phrasing "Generating will use 0 credits" carries no unit.
    unit = null; // ambiguous
  }
  if (!unit) {
    // Ambiguous unit: nonzero blocks; zero is safe either way but still needs
    // integration binding/freshness (caller enforces via isQuoteFresh + evidence).
    if (amount === 0) {
      return { raw: text, amount: 0, unit: 'unknown-ambiguous-zero', quantity: qty, totalUpperBound: 0, state: 'known', isZero: true, reason: 'ambiguous unit but zero amount (binding+freshness still required)' };
    }
    return { raw: text, amount, unit: 'unknown-ambiguous', quantity: qty, totalUpperBound: amount * qty, state: 'unknown', isZero: false, reason: 'ambiguous unit (neither per-generation nor total explicit): blocks' };
  }
  const totalUpperBound = unit === 'per-generation' ? amount * qty : amount;
  return { raw: text, amount, unit, quantity: qty, totalUpperBound, state: 'known', isZero: amount === 0 };
}

export function isQuoteFresh(observedAt, nowMs = Date.now(), maxAgeMs = QUOTE_MAX_AGE_MS) {
  const age = nowMs - new Date(observedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

export function detectEntitlement(text) {
  const t = String(text || '').toLowerCase();
  if (/upgrade|insufficient credits|remix|entitlement|payment required/.test(t)) {
    return { entitlement: 'upgrade_required', raw: String(text || '') };
  }
  return { entitlement: 'none', raw: String(text || '') };
}

export function detectRateSignal(text) {
  const t = String(text || '').toLowerCase();
  if (/google_limit_reached|rate.?limit|quota|try again later|too many requests/.test(t)) {
    return { rateLimited: true, raw: String(text || '') };
  }
  return { rateLimited: false, raw: String(text || '') };
}
