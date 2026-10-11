import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { FlowError } from './errors.js';
import { getFlowHome, get } from './config.js';

// Every CSS/role/text selector the automation depends on lives HERE as an
// ordered candidate list — never inline in tool logic. Lists merge as:
// built-in fallback < config file (selectors.*) < live selectors.map.json.
// discover-ui appends newly observed selectors via noteSelectors().
const BUILTIN_SELECTORS = {
  // Generation mode tabs (classic toolbar UI).
  modeTab: [
    '[role="tab"][id*="trigger-{MODE}"]',
  ],
  // Buttons that open the generation settings panel.
  settingsTrigger: [
    'button[aria-label*="settings" i]',
    'button[aria-label*="options" i]',
    'button[aria-label*="generation settings" i]',
    'button[aria-label*="image settings" i]',
    'button[aria-label*="video settings" i]',
    'button[aria-label*="tune" i]',
    // New Flow chat UI renders Material icon ligatures as button text.
    'button:has-text("tune")',
    'button:has-text("settings_2")',
  ],
  // Model chip fallback (toolbar showing current model + ratio).
  modelChip: [
    'button:has-text("Nano Banana")',
    'button:has-text("Imagen")',
    'button:has-text("Veo")',
    'button:has-text("Omni Flash")',
    'button:has-text("Omni")',
  ],
  // Generic option rows inside dropdowns/panels.
  optionRow: [
    '[role="option"]',
    '[role="menuitem"]',
    'li',
    'button',
  ],
  // Prompt inputs, in preference order.
  promptInput: [
    'textarea:visible',
    '[contenteditable="true"]:visible',
    'textarea',
    '[contenteditable="true"]',
  ],
  // "@" asset-picker panel.
  mentionSearchInput: [
    'input[placeholder*="Search assets" i]',
    'input[placeholder*="Search" i]:visible',
  ],
  mentionAddButton: [
    'button:has-text("Add to Prompt")',
    'button:has-text("Add to prompt")',
  ],
  mentionResultRow: [
    '[role="listitem"]',
    '[role="option"]',
    '[role="button"]',
    '[class*="asset-item"]',
    '[class*="media-item"]',
    '[class*="grid"] > div',
    'li',
  ],
  // Account chip candidates.
  accountChip: [
    '[data-account-email]',
    '[aria-label*="gmail" i]',
    '[data-test-id*="account"]',
    '[aria-label*="Google Account" i]',
  ],
  // Sidebar sections are matched by exact accessible name (see navigateToSidebar).
  sidebarScope: [
    '[class*="sidebar"] button, [class*="sidebar"] a',
    'nav button, nav a',
    '[class*="nav"] button, [class*="nav"] a',
  ],
  // Project creation / discovery.
  newProjectButton: [
    'button:has-text("New project")',
    'a:has-text("New project")',
    '[aria-label*="New project"]',
  ],
  projectCardLink: ['a[href*="/project/"]'],
  // Character creation form.
  characterDescInput: [
    '[placeholder*="Describe your character" i]',
    '[data-placeholder*="Describe your character" i]',
    '[aria-label*="Describe" i]',
    '[contenteditable="true"]:visible',
    'textarea:visible',
  ],
  submitButton: [
    'button[aria-label*="Create character" i]',
    'button[aria-label*="create" i]',
    'button:has-text("Create")',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Generate" i]',
    'button[type="submit"]',
  ],
};

function mapPath() {
  return path.join(getFlowHome(), 'config', 'selectors.map.json');
}

export const SELECTOR_MAP_VERSION = 1;

export function isExecutableSelectorList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string');
}

function loadRawMap() {
  const f = mapPath();
  if (!fs.existsSync(f)) return { file: f, parsed: {}, corrupt: false, backup: null };
  const raw = fs.readFileSync(f, 'utf-8');
  try {
    return { file: f, parsed: JSON.parse(raw), corrupt: false, backup: null };
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${f}.corrupt.${stamp}.bak`;
    fs.writeFileSync(backup, raw);
    return { file: f, parsed: {}, corrupt: true, backup };
  }
}

function splitStore(parsed) {
  const executable = {};
  if (parsed && typeof parsed === 'object') {
    const envelope = parsed.selectors;
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      for (const [k, v] of Object.entries(envelope)) {
        if (isExecutableSelectorList(v)) executable[k] = v;
      }
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (['selectors', 'observations', 'version', '_lastUpdated', '_description'].includes(k)) continue;
      if (isExecutableSelectorList(v) && !executable[k]) executable[k] = v;
    }
  }
  return executable;
}

function loadMap() {
  return loadRawMap().parsed;
}

/**
 * Get candidate selector list for a key.
 * Supports {PLACEHOLDER} templating via vars (e.g. {MODE}).
 */
export function getSelectors(key, vars = {}) {
  const executable = splitStore(loadMap());
  const fromMap = isExecutableSelectorList(executable[key]) ? executable[key] : null;
  const configured = get(`selectors.${key}`, null);
  const fromConfig = isExecutableSelectorList(configured) ? configured : null;
  const list = fromMap || fromConfig || BUILTIN_SELECTORS[key] || [];
  if (!BUILTIN_SELECTORS[key]) logger.debug('Unknown selector key', { key });
  return list.map(s => {
    let out = s;
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
    return out;
  });
}

/**
 * Persist newly observed working selectors so the next run prefers them.
 * Live self-healing: discovery results feed back into the map.
 */
export function noteSelectors(key, selectors) {
  const { file: f, parsed, corrupt, backup } = loadRawMap();
  if (corrupt) {
    throw new FlowError('STORAGE_CORRUPT', 'selector map corrupt; refusing to overwrite', { file: f, backup });
  }
  try {
    const executable = splitStore(parsed);
    const fresh = (Array.isArray(selectors) ? selectors : [selectors]).filter((s) => typeof s === 'string' && s);
    if (!fresh.length) return;
    const merged = [...fresh, ...((Array.isArray(executable[key]) ? executable[key] : []))].filter(
      (s, i, a) => a.indexOf(s) === i
    ).slice(0, 12);
    executable[key] = merged;
    const out = { ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    out.version = SELECTOR_MAP_VERSION;
    out._lastUpdated = new Date().toISOString();
    out.selectors = { ...(out.selectors && typeof out.selectors === 'object' ? out.selectors : {}), ...executable };
    for (const [k, v] of Object.entries(executable)) out[k] = v;
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) {
    if (e instanceof FlowError) throw e;
    logger.debug('Could not persist selectors', { key, error: e.message });
  }
}

export function selectorKeys() {
  return Object.keys(BUILTIN_SELECTORS);
}
