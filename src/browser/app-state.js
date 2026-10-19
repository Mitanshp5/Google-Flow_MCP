import { isFlowUrl } from '../utils/sanitize.js';

// W02 app-readiness: allowed origin, account verification and app usability
// are INDEPENDENT dimensions. Pure string classifiers so fixtures run
// without CDP or a live browser.
//
// Strictness rules (parent correction):
// - A hydrated Flow shell requires the Flow origin PLUS owning app
//   structure (sidebar scope AND composer control). A lone generic
//   textarea/contenteditable, or matching body text, is never proof.
// - Text inside script/style/template/noscript blocks or hidden subtrees is
//   never shell or account evidence.

export const SHELL_MARKERS = [
  /<nav\b[^>]*>|<mat-list-item\b|<mat-nav-list\b[^>]*\brole\s*=\s*["']navigation["']/i,
  /<textarea\b[^>]*>|contenteditable\s*=\s*["']true["']/i,
];

// Remove non-visible source blocks before matching: script/style/template/
// noscript contents and hidden-attribute / display:none / visibility:hidden
// elements. Approximation over raw HTML; live callers additionally pass
// innerText (already visible-only) as bodyText.
export function stripNonVisible(html) {
  let s = String(html || '');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  s = s.replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ');
  s = s.replace(/<[^>]*\bhidden\b[^>]*>[\s\S]*?<\/[a-z][^>]*>/gi, ' ');
  s = s.replace(/<[^>]*\bstyle\s*=\s*"[^"]*(display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"[^>]*>[\s\S]*?<\/[a-z][^>]*>/gi, ' ');
  s = s.replace(/<[^>]*\bstyle\s*=\s*'[^']*(display\s*:\s*none|visibility\s*:\s*hidden)[^']*'[^>]*>[\s\S]*?<\/[a-z][^>]*>/gi, ' ');
  return s;
}

function hasSidebarScope(visibleHtml) {
  return SHELL_MARKERS[0].test(visibleHtml);
}

function hasComposerControl(visibleHtml) {
  return /<textarea\b[^>]*>|contenteditable\s*=\s*["']true["']/i.test(visibleHtml);
}

// True only for owning Flow app structure on visible markup: BOTH a sidebar
// scope and a composer control. A skeleton/loading page without controls,
// a wrong-app generic textarea, or script/hidden text is never ready.
export function shellReadyFromHtml(html) {
  const vis = stripNonVisible(html);
  if (!hasComposerControl(vis)) return false;
  if (!hasSidebarScope(vis)) return false;
  return true;
}

export function isErrorHtml({ title = '', bodyText = '', url = '' } = {}) {
  const t = `${title} ${bodyText}`;
  if (/Error:\s*404|\b404\b.*not found|page not found/i.test(t)) return true;
  if (/\/404(?:[/?#]|$)/.test(String(url))) return true;
  return false;
}

export function isAuthHtml({ title = '', bodyText = '', url = '' } = {}) {
  const u = String(url);
  if (u.includes('accounts.google.com')) return true;
  const t = `${title} ${bodyText}`;
  if (/sign in|mfa|consent|captcha|verify.*human|region.*not supported/i.test(t) && !/<textarea[\s>]/i.test(stripNonVisible(t))) return true;
  return false;
}

export function isLoadingHtml({ bodyText = '', html = '' } = {}) {
  const t = `${bodyText} ${stripNonVisible(html)}`;
  if (shellReadyFromHtml(html)) return false;
  return /loading|hydrat|skeleton|please wait/i.test(t);
}

// F10: allowed origin / account / app usability are independent.
// - Flow 404 stays allowedUrl=true with app=error_404; that says nothing
//   about the account either way (callers report unverified, never false).
// - `ready` requires the Flow origin AND visible owning structure from the
//   html source. bodyText alone (tag-free) can never prove structure.
// - Non-Flow origins are `unknown` (non-flow-origin), never `ready`,
//   even with a generic textarea on screen.
export function classifyAppState({ url = '', title = '', bodyText = '', html = '' } = {}) {
  const allowedUrl = isFlowUrl(url);
  if (isErrorHtml({ title, bodyText, url })) {
    return { allowedUrl, app: 'error_404', reason: 'error-page' };
  }
  if (isAuthHtml({ title, bodyText, url })) {
    return { allowedUrl, app: 'auth_needed', reason: 'auth-interstitial' };
  }
  const visible = stripNonVisible(html);
  // The native character detail surface is usable before its below-fold
  // generation composer is mounted. Its owning form/preview/name controls
  // identify this view; a missing library sidebar is intentional.
  if (allowedUrl && /\/project\/[^/?#]+\/character\/[^/?#]+\/?$/.test(url)
    && /<flow-character-edit-page\b/i.test(visible) && /<flow-character-form\b/i.test(visible)
    && /<flow-character-preview-panel\b/i.test(visible) && /aria-label=["']Character name["']/i.test(visible)) {
    return {allowedUrl,app:'ready',reason:'flow-character-editor'};
  }
  if (allowedUrl && /\/project\/[^/?#]+\/character(?:\/[^/?#]+)?\/?$/.test(url)
    && /aria-label=["']Describe your character(?:…|\.{3})?["']/i.test(visible)
    && (/aria-label=["']Select model family["']/i.test(visible)
      || (/<flow-character-edit-page\b/i.test(visible) && /<flow-character-form\b/i.test(visible)
        && /<flow-character-prompt-box\b/i.test(visible) && /aria-label=["']Character name["']/i.test(visible)))
    && /aria-label=["']Start generation["']/i.test(visible)) {
    return {allowedUrl,app:'ready',reason:'flow-character-editor'};
  }
  if (allowedUrl && /\/project\/[^/?#]+\/tools\/?$/.test(url)
    && hasSidebarScope(visible) && /<flow-applet-hero-banner\b/i.test(visible)
    && /class=["'][^"']*\bapplet-manager-content\b/i.test(visible)) {
    return { allowedUrl, app: 'ready', reason: 'flow-tools-gallery' };
  }
  if (shellReadyFromHtml(html)) {
    if (!allowedUrl) return { allowedUrl, app: 'unknown', reason: 'non-flow-origin' };
    return { allowedUrl, app: 'ready', reason: 'flow-shell' };
  }
  if (isLoadingHtml({ bodyText, html })) {
    return { allowedUrl, app: 'loading', reason: 'shell-not-hydrated' };
  }
  if (!allowedUrl && (html || bodyText)) {
    return { allowedUrl, app: 'unknown', reason: 'non-flow-origin' };
  }
  return { allowedUrl, app: html || bodyText ? 'loading' : 'unknown', reason: 'insufficient-evidence' };
}

const ATOMIC_EMAIL_EXACT_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const GLOBAL_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ACCOUNT_CONTROL_LABEL_RE = /^\s*(?:(?:open|view|manage|switch)\s+)?(?:google\s*account|account\s*switcher|signed\s*in\s*as|active\s*account|user\s*account|switch\s*account|google\s*profile)\b/i;
const UNRELATED_CONTENT_LABEL_RE = /^\s*(?:asset|media|tile|thumbnail|card|file|project|prompt|image|video)\b/i;

// Positive account observation from visible markup only: an explicit
// data-account-email token or an owning Google account/profile control aria-label.
// Returns the exact token or null — never an unrelated asset label, never a substring
// guess, validates atomic attributes in full, and denies ambiguous or contradictory
// candidate accounts.
export function extractObservedAccount(html) {
  const vis = stripNonVisible(html);
  const candidates = [];

  const dataAttrRe = /data-account-email\s*=\s*["']([^"']*)["']/gi;
  let dm;
  while ((dm = dataAttrRe.exec(vis)) !== null) {
    const rawVal = dm[1].trim();
    if (rawVal.length === 0) continue;
    if (!ATOMIC_EMAIL_EXACT_RE.test(rawVal)) {
      // Malformed atomic email attribute: non-empty attribute value is NOT an exact email.
      // Deny silently shortening into a valid approved identity.
      candidates.push(null);
      continue;
    }
    candidates.push(rawVal);
  }

  const ariaRe = /aria-label\s*=\s*["']([^"']*)["']/gi;
  let am;
  while ((am = ariaRe.exec(vis)) !== null) {
    const label = am[1];
    if (UNRELATED_CONTENT_LABEL_RE.test(label)) continue;
    if (!ACCOUNT_CONTROL_LABEL_RE.test(label)) continue;
    const matches = label.match(GLOBAL_EMAIL_RE);
    if (matches && matches.length > 0) {
      for (const email of matches) {
        candidates.push(email.trim());
      }
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.some((c) => !c)) return null;

  const normalized = new Set(candidates.map((e) => e.toLowerCase()));
  if (normalized.size !== 1) {
    return null;
  }

  const exactMatches = new Set(candidates);
  if (exactMatches.size !== 1) {
    return null;
  }

  return candidates[0];
}

// Optional expected-vs-observed token comparison (full equality, not substring
// inclusion, not absence-of-sign-in). No observed token => unverified.
// A mismatch is a distinct terminal state, never inferred from 404/loading.
export function verifyAccountState({ expected = null, observed = null } = {}) {
  if (!observed || !ATOMIC_EMAIL_EXACT_RE.test(String(observed))) return { state: 'unverified', expected: expected || null, observed: null };
  if (expected && String(observed).toLowerCase() === String(expected).toLowerCase()) {
    return { state: 'verified', expected, observed };
  }
  if (!expected) return { state: 'verified', expected: null, observed };
  return { state: 'mismatch', expected, observed };
}

// F02: URL shape is NOT evidence. Every /tool/ style route is unverified
// until matched against an actually observed UI link (see
// resolveToolRouteFromLinks). Legacy always-guessed patterns stay guessed;
// shaped-but-unobserved tool URLs are unverified, never valid.
export function isGuessedRoute(url) {
  let u;
  try { u = new URL(url); } catch { return { guessed: true, reason: 'invalid-url' }; }
  const p = u.pathname;
  if (/\/project\/[^/]+\/characters\/?$/.test(p)) return { guessed: true, reason: 'obsolete-plural-characters' };
  if (/\/tools\//.test(p)) return { guessed: true, reason: 'global-slug-guess' };
  if (/\/project\/[^/]+\/tool\/[0-9a-f-]{8,}/i.test(p) && u.searchParams.get('fromViewSource') === 'tools') {
    return { guessed: false, reason: 'observed-tool-shape' };
  }
  if (/\/tool\/[^/]+/.test(p)) return { guessed: true, reason: 'unobserved-tool-route' };
  return { guessed: false, reason: 'non-tool-route' };
}

// Strict F02 resolver for W06: a tool route is verified ONLY when it matches
// an actually observed UI link (exact href, same project id) with matching
// feature identity. Pattern-shaped URLs with no observed link are blocked.
export function resolveToolRouteFromLinks(observedLinks, { projectId = null, url = null, toolName = null } = {}) {
  const links = Array.isArray(observedLinks) ? observedLinks : [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  for (const link of links) {
    const href = link?.href;
    if (!href) continue;
    let u;
    try { u = new URL(href, 'https://flow.google.com'); } catch { continue; }
    if (!isFlowUrl(u.toString())) continue;
    const pathMatch = u.pathname.match(/^\/project\/([^/]+)\/tool\/([^/]+)\/?$/);
    if (!pathMatch) continue;
    if (projectId && pathMatch[1] !== projectId) continue;
    if (url && u.toString() !== String(url)) continue;
    if (toolName && norm(link.text).includes(norm(toolName)) === false) continue;
    return { verified: true, href: u.toString(), projectId: pathMatch[1], toolId: pathMatch[2], reason: 'observed-ui-link' };
  }
  return { verified: false, href: null, reason: 'no-observed-link' };
}
