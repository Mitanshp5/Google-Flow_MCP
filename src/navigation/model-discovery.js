import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveCatalog, loadCatalog, getUniverse } from '../utils/models.js';
import { setPromptBarModel } from '../browser/safe-actions.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';

const IMAGE_HINTS = ['nano', 'banana', 'imagen'];
const VIDEO_HINTS = ['veo', 'omni', 'kling', 'sora', 'seedance', 'hailuo', 'wan'];

/**
 * Discover available models/ratios/durations from Flow's own UI at launch.
 * Opens the tune/settings panel in a project, enumerates option-like controls,
 * classifies them, saves to config/flow.models.json. Best-effort: never throws
 * (caller decides fallback). Returns { imageModels, videoModels, ratios,
 * durations, source: 'live' } or null when the UI yields nothing usable.
 */
export async function discoverModels(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 25000;
  const deadline = Date.now() + timeoutMs;
  try {
    await ensureProjectInContext(page, {
      name: opts.project_name,
      campaign: opts.campaign,
    });

    // Open the tune/settings panel (chat UI) — try known triggers.
    // New Flow UI renders Material icon ligatures ("tune", "settings_2") as
    // button text, so match those as well as aria-labels.
    const { getSelectors } = await import('../utils/selectors.js');
    const triggers = getSelectors('settingsTrigger').map(sel =>
      page.locator(sel).first()
    );
    let opened = false;
    for (const t of triggers) {
      if (Date.now() > deadline) break;
      try {
        if (await t.isVisible({ timeout: 3000 }).catch(() => false)) {
          await t.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1000);
          opened = true;
          break;
        }
      } catch { /* next trigger */ }
    }
    if (!opened) {
      logger.warn('Model discovery: settings panel did not open');
      return null;
    }

    // Enumerate candidate option texts — ONLY inside the open tune panel
    // (dialog/menu/listbox). Never fall back to document scope: the Agent
    // chat panel contains suggestion cards ("Nano Banana 2 ...") that would
    // contaminate the catalog with non-model text.
    const panelHandle = await page.locator('[role="dialog"], [role="menu"], [role="listbox"]').first()
      .elementHandle().catch(() => null);
    if (!panelHandle) {
      logger.warn('Model discovery: no tune panel container found');
      await takeScreenshot(page, 'models-no-panel');
      return null;
    }
    const texts = await page.evaluate((root) => {
      const els = Array.from(root.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="tab"], li, button'
      ));
      return els
        .map(e => (e.textContent || '').trim().replace(/\s+/g, ' '))
        .filter(t => t.length > 0 && t.length < 60);
    }, panelHandle).catch(() => []);
    const uniqTexts = [...new Set(texts)];

    const imageModels = [];
    const videoModels = [];
    const ratios = [];
    const durations = [];
    for (const t of uniqTexts) {
      const lower = t.toLowerCase();
      if (/^\d+\s*:\s*\d+$/.test(t)) {
        const r = t.replace(/\s+/g, '');
        if (!ratios.includes(r)) ratios.push(r);
        continue;
      }
      if (/^\d+\s*s$/i.test(t)) {
        const d = t.replace(/\s+/g, '').toLowerCase();
        if (!durations.includes(d)) durations.push(d);
        continue;
      }
      if (IMAGE_HINTS.some(h => lower.includes(h))) {
        if (!imageModels.some(m => m.toLowerCase() === lower)) imageModels.push(t);
        continue;
      }
      if (VIDEO_HINTS.some(h => lower.includes(h))) {
        if (!videoModels.some(m => m.toLowerCase() === lower)) videoModels.push(t);
      }
    }

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    // Second Escape clears any overlay backdrop the panel left behind.
    const blocked = await page.locator('.cdk-overlay-backdrop-showing').first().isVisible().catch(() => false);
    if (blocked) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
    }

    if (videoModels.length === 0 && imageModels.length === 0) {
      logger.warn('Model discovery: no model options recognized', { scanned: uniqTexts.length });
      await takeScreenshot(page, 'models-not-found');
      return null;
    }
    const catalog = {
      imageModels, videoModels, ratios, durations,
      discoveredAt: new Date().toISOString(),
      source: 'live',
    };
    saveCatalog(catalog);
    logger.info('Models discovered live from Flow UI', {
      video: videoModels, image: imageModels, ratios, durations,
    });
    return catalog;
  } catch (e) {
    logger.warn('Model discovery failed (using cache/fallback)', { error: e.message });
    return null;
  }
}

// Capability markers: option-row text patterns that indicate a model
// supports a capability when present AND enabled in the settings panel with
// that model selected. Vocabulary comes from this repo's own UI strings
// ("Ingredients to Video" warnings, "Video Frames/Ingredients" slot notes);
// whether these markers truly discriminate per-model support is calibrated
// live (see P1-3 calibration run) — never asserted from outside sources.
// Deliberately no duration markers: duration requirements are not observable
// from row presence, so discovery never writes ingredientsRequireDuration.
const CAPABILITY_MARKERS = [
  { key: 'ingredients', patterns: [/ingredient/i] },
  { key: 'frames', patterns: [/video frame/i, /start frame/i, /end frame/i, /first frame/i, /last frame/i] },
  { key: 'extend', patterns: [/\bextend\b/i] },
];

async function openSettingsPanel(page, deadline) {
  // Reuse the battle-tested opener (bar-scoped exact chip first, 5s poll,
  // confirmed panel state) instead of a weaker duplicate: naive trigger
  // clicks hit the top-right "Tile grid settings" button and silently open
  // the wrong menu (verified live). The container validator on top stays as
  // backstop against cache poisoning.
  const { openBarSettings } = await import('../browser/safe-actions.js');
  if (Date.now() > deadline) return false;
  try {
    const { panel, error } = await openBarSettings(page);
    if (error || !panel) return false;
    return true;
  } catch {
    return false;
  }
}

async function closeSettingsPanel(page) {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    const blocked = await page.locator('.cdk-overlay-backdrop-showing').first().isVisible().catch(() => false);
    if (!blocked) break;
  }
}

async function panelHandle(page) {
  return page.locator('[role="dialog"], [role="menu"], [role="listbox"]').first()
    .elementHandle().catch(() => null);
}

/**
 * Poll for the open SETTINGS panel and validate it really is one (P1-3
 * calibration finding: the model-name fallback trigger opens the nested
 * model *dropdown* — also a [role="menu"] — whose scan would record all-
 * false capabilities and poison the cache. The settings panel always
 * carries the model row (menu-trigger); the dropdown never does. Returns
 * null unless a validated panel appears in time.
 */
async function awaitSettingsPanel(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await panelHandle(page);
      if (handle) {
        // Container AND content: the shell renders before its rows over CDP,
        // and an empty shell scans as all-false (calibrated live).
        const ready = await page.evaluate((root) => {
          try {
            if (!root.querySelector('button.mat-mdc-menu-trigger, [class*="menu-trigger"]')) return false;
            return Array.from(root.querySelectorAll('button')).some((b) =>
              /nano|banana|imagen|veo|omni/i.test(b.textContent || ''));
          } catch {
            return false;
          }
        }, handle).catch(() => false);
        if (ready) return handle;
      }
    } catch { /* retry */ }
    await page.waitForTimeout(500).catch(() => {});
  }
  return null;
}

// Read-only snapshot of the currently selected model row (for restore).
async function readSelectedModelRow(page, deadline) {
  if (!(await openSettingsPanel(page, deadline))) return '';
  try {
    const handle = await awaitSettingsPanel(page, 4000);
    if (!handle) return '';
    const text = await page.evaluate((root) => {
      const row = root.querySelector('button.mat-mdc-menu-trigger')
        || Array.from(root.querySelectorAll('button')).find((b) =>
          /nano|banana|imagen|veo|omni/i.test(b.textContent || ''));
      return ((row?.textContent || '').replace(/arrow_drop_down|arrow_drop_up/g, '').trim().replace(/\s+/g, ' '));
    }, handle).catch(() => '');
    return text;
  } finally {
    await closeSettingsPanel(page);
  }
}

async function scanPanelCapabilities(page) {
  const handle = await awaitSettingsPanel(page, 4000);
  if (!handle) return null;
  return page.evaluate((root, markers) => {
    const els = Array.from(root.querySelectorAll('[role="option"], [role="menuitem"], [role="tab"], li, button'));
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const out = {};
    for (const m of markers) {
      const res = m.patterns.map((p) => new RegExp(p.src, p.flags));
      const hits = [];
      for (const el of els) {
        if (!shown(el)) continue;
        const t = ((el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ');
        if (!t || !res.some((re) => re.test(t))) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (hits.length < 5) hits.push(t.slice(0, 60));
      }
      out[m.key] = { supported: hits.length > 0, samples: hits };
    }
    return out;
  }, handle, CAPABILITY_MARKERS.map((m) => ({
    key: m.key,
    patterns: m.patterns.map((r) => ({ src: r.source, flags: r.flags })),
  }))).catch(() => null);
}

/**
 * Discover per-model capabilities from the live settings panel (P1-3).
 * For each model: select it, reopen the panel, record which capability rows
 * are present+enabled, then move on. Merges {ingredients,frames,extend}
 * per model into flow.models.json with capabilitiesObservedAt; capsFor()
 * prefers fresh entries over the static table. Never writes duration
 * requirements. Best-effort: never throws (returns null when the panel
 * never opens), restores the entry selection when it could be read.
 * No credits involved (selection clicks only, never Generate).
 */
export async function discoverCapabilities(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const deadline = Date.now() + timeoutMs;
  try {
    await ensureProjectInContext(page, {
      name: opts.project_name,
      campaign: opts.campaign,
    });
    const models = Array.isArray(opts.models) && opts.models.length > 0
      ? opts.models
      : getUniverse().videoModels;

    const entryModel = await readSelectedModelRow(page, deadline);
    const probed = [];
    const skipped = [];
    for (const model of models) {
      if (Date.now() > deadline) {
        skipped.push({ model, reason: 'timeout-budget' });
        continue;
      }
      let sel = null;
      try {
        sel = await setPromptBarModel(page, model);
      } catch (e) {
        skipped.push({ model, reason: `select-threw: ${e.message}` });
        continue;
      }
      if (!sel?.ok) {
        skipped.push({ model, reason: sel?.detail || 'select-unverified' });
        continue;
      }
      if (!(await openSettingsPanel(page, deadline))) {
        skipped.push({ model, reason: 'panel-did-not-open' });
        continue;
      }
      try {
        const scan = await scanPanelCapabilities(page);
        if (!scan) {
          skipped.push({ model, reason: 'panel-scan-failed' });
          continue;
        }
        const caps = {};
        for (const m of CAPABILITY_MARKERS) caps[m.key] = !!scan[m.key]?.supported;
        probed.push({
          model,
          caps,
          samples: Object.fromEntries(CAPABILITY_MARKERS.map((m) => [m.key, scan[m.key]?.samples || []])),
        });
        logger.info('Capabilities observed live', { model, caps });
      } finally {
        await closeSettingsPanel(page);
      }
    }

    let restored = false;
    if (entryModel) {
      try {
        const back = await setPromptBarModel(page, entryModel);
        restored = !!back?.ok;
      } catch (e) {
        logger.warn('Capability probe: restore-select failed', { entryModel, error: e.message });
      }
    }

    if (probed.length > 0) {
      const prev = loadCatalog() || {};
      const capabilities = { ...(prev.capabilities || {}) };
      for (const p of probed) capabilities[String(p.model).toLowerCase()] = p.caps;
      saveCatalog({
        ...prev,
        videoModels: Array.isArray(prev.videoModels) && prev.videoModels.length > 0
          ? prev.videoModels
          : models,
        capabilities,
        capabilitiesObservedAt: new Date().toISOString(),
      });
    }
    return { probed, skipped, restored, observedAt: new Date().toISOString() };
  } catch (e) {
    logger.warn('Capability discovery failed (keeping static caps)', { error: e.message });
    return null;
  }
}
