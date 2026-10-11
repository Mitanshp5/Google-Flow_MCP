// W02 scoped page adapter: pure real-HTML parsing for sidebar navigation.
// No mocked DOM callbacks: tests feed actual HTML strings (mat-list-item,
// icon-bearing Tools anchor) captured from QA evidence.

const KNOWN_ICON_LIGATURES = new Set([
  'apps_spark_2', 'apps_spark', 'tune', 'movie', 'image', 'brush',
  'grid_view', 'more_vert', 'home', 'folder', 'delete', 'settings',
]);

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ');
}

// Longest known ligature glued to the front of a token (e.g. the isolated
// probe's `apps_spark_2Tools`). The remainder must start uppercase so legit
// labels that merely begin like a ligature (`homely`) are never stripped.
function gluedLigaturePrefix(token) {
  let best = '';
  for (const lig of KNOWN_ICON_LIGATURES) {
    if (token.length > lig.length && token.startsWith(lig)) {
      const rest = token.slice(lig.length);
      if (/^[A-Z]/.test(rest) && lig.length > best.length) best = lig;
    }
  }
  return best;
}

export function normalizeSidebarLabel(raw) {
  const text = stripTags(raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const parts = text.split(' ').filter(Boolean);
  // Strip only known icon ligatures from the front, not broad substrings.
  while (parts.length > 1 && KNOWN_ICON_LIGATURES.has(parts[0])) parts.shift();
  if (parts.length > 0) {
    const glued = gluedLigaturePrefix(parts[0]);
    if (glued) parts[0] = parts[0].slice(glued.length);
  }
  return parts.join(' ').trim();
}

// Extract scoped sidebar candidates from real HTML: button, a,
// mat-list-item, [role=listitem]. Returns [{tag, label, normalized}].
export function extractSidebarCandidates(html) {
  const s = String(html || '');
  const out = [];
  const re = /<(button|a|mat-list-item|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2] || '';
    const normalized = normalizeSidebarLabel(inner);
    if (!normalized) continue;
    out.push({ tag, label: stripTags(inner).replace(/\s+/g, ' ').trim(), normalized });
  }
  return out;
}

// Exact dedicated-label match (case-insensitive). No substring guessing:
// 'Tool' must not match 'Tools', 'Char' must not match 'Characters'.
export function matchSidebarSection(html, section) {
  const want = String(section || '').trim().toLowerCase();
  if (!want) return null;
  const cands = extractSidebarCandidates(html);
  for (const c of cands) {
    if (c.normalized.toLowerCase() === want) return c;
  }
  return null;
}

export function getActiveSidebarFromHtml(html) {
  const s = String(html || '');
  const re = /<(button|a|mat-list-item|li)\b[^>]*?(aria-current\s*=\s*["']page["']|class\s*=\s*["'][^"']*active[^"']*["'])[^>]*>([\s\S]*?)<\/\1\s*>/i;
  const m = re.exec(s);
  if (!m) return null;
  return normalizeSidebarLabel(m[3]) || null;
}
