import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
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

function loadMap() {
  try {
    const f = mapPath();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) {
    logger.debug('Selector map unreadable', { error: e.message });
  }
  return {};
}

/**
 * Get candidate selector list for a key.
 * Supports {PLACEHOLDER} templating via vars (e.g. {MODE}).
 */
export function getSelectors(key, vars = {}) {
  const map = loadMap();
  const fromMap = Array.isArray(map[key]) ? map[key] : null;
  const fromConfig = get(`selectors.${key}`, null);
  const list = fromMap || (Array.isArray(fromConfig) ? fromConfig : null) || BUILTIN_SELECTORS[key] || [];
  if (!BUILTIN_SELECTORS[key]) logger.debug('Unknown selector key', { key });
  return list.map(s => {
    let out = s;
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, v);
    return out;
  });
}

/**
 * Persist newly observed working selectors so the next run prefers them.
 * Live self-healing: discovery results feed back into the map.
 */
export function noteSelectors(key, selectors) {
  try {
    const f = mapPath();
    const map = loadMap();
    const fresh = (Array.isArray(selectors) ? selectors : [selectors]).filter(Boolean);
    if (!fresh.length) return;
    const merged = [...fresh, ...((Array.isArray(map[key]) ? map[key] : []))].filter(
      (s, i, a) => a.indexOf(s) === i
    ).slice(0, 12);
    map[key] = merged;
    map._lastUpdated = new Date().toISOString();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) {
    logger.debug('Could not persist selectors', { key, error: e.message });
  }
}

export function selectorKeys() {
  return Object.keys(BUILTIN_SELECTORS);
}
