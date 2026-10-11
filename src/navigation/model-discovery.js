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
/**
 * Discover available models/ratios/durations from Flow's own UI.
 * Parent #1 correction: uses opened.panel (verified settings owner), never the
 * first generic dialog; expands the actual nested model dropdown to enumerate
 * enabled exact option rows (Pro/Lite/2.1); selects Image/Video deliberately
 * and restores full original settings/composer or returns restored:false;
 * never creates a project for read-only refresh (honest blocker when missing
 * project context and allowCreate !== true).
 * Best-effort: never throws (caller decides fallback). Returns catalog with
 * source live + binding, or null when blocked/unusable.
 */
export async function discoverModels(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 25000;
  const deadline = Date.now() + timeoutMs;
  const allowCreate = opts.allowCreate === true;
  try {
    // Read-only guard: no project creation for refresh on missing project.
    let inProject = false;
    try {
      inProject = String(page.url() || '').includes('/project/');
    } catch { inProject = false; }
    if (!inProject && !allowCreate) {
      logger.warn('Model discovery blocked: no project context (read-only, no creation)', { url: (() => { try { return page.url(); } catch { return ''; } })() });
      return null;
    }
    if (!inProject && allowCreate) {
      await ensureProjectInContext(page, {
        name: opts.project_name,
        campaign: opts.campaign,
      });
    } else if (inProject && (opts.project_name || opts.campaign)) {
      // Already in a project: reuse in place, never reload for read-only
      // discovery (F08 preservation). Only navigate when explicitly requested
      // via allowCreate + different target (handled by caller).
    }

    const safe = await import('../browser/safe-actions.js');
    const { openBarSettings, readToolState, setPromptBarMode, closeSettingsPanel } = safe;
    if (Date.now() > deadline) return null;

    // Snapshot entry settings/composer for restore (mode + model row).
    let entryState = null;
    try {
      entryState = await readToolState(page).catch(() => null);
    } catch { entryState = null; }
    const entryMode = entryState?.mode === 'video' ? 'Video' : entryState?.mode === 'image' ? 'Image' : null;
    const entryModel = entryState?.model && entryState.model !== 'unknown' ? entryState.model : null;

    // Open via verified single composer driver; use opened.panel owner directly.
    let opened = null;
    try {
      opened = await openBarSettings(page);
    } catch {
      opened = null;
    }
    if (!opened?.panel) {
      logger.warn('Model discovery: verified composer settings did not open', { detail: opened?.error });
      return null;
    }
    const panel = opened.panel;

    const imageModels = [];
    const videoModels = [];
    const ratios = [];
    const durations = [];
    const pushUnique = (arr, name) => {
      if (!name) return;
      if (!arr.some((m) => m.toLowerCase() === String(name).toLowerCase())) arr.push(name);
    };
    const cleanModelName = (t) => String(t)
      .replace(/^[\p{Emoji}\p{So}\u2000-\u2BFF]+\s*/u, '')
      .replace(/arrow_drop_down|arrow_drop_up|apps_spark_2|volume_up/gi, '')
      .trim().replace(/\s+/g, ' ');

    // Deliberately select Image then Video to enumerate both dropdowns.
    const modes = opts.modes && Array.isArray(opts.modes) && opts.modes.length > 0 ? opts.modes : ['Image', 'Video'];
    for (const mode of modes) {
      if (Date.now() > deadline) break;
      try {
        const setMode = await setPromptBarMode(page, mode).catch(() => null);
        if (!setMode?.ok) {
          // Mode switch unverified: still attempt enumeration of current panel,
          // but record that this mode was not deliberately selected.
          logger.warn('Model discovery: mode select unverified', { mode, detail: setMode?.detail });
        }
      } catch { /* continue with current panel */ }
      // Re-open (mode switches re-render the panel) and use the fresh owner.
      let cur = null;
      try {
        cur = await openBarSettings(page);
      } catch { cur = null; }
      const curPanel = cur?.panel || panel;
      // Enumerate static rows (ratios/durations) inside the owning panel.
      const rows = await enumeratePanelRows(page, curPanel).catch(() => ({ ratios: [], durations: [] }));
      for (const r of rows.ratios || []) {
        const v = String(r).replace(/\s+/g, '');
        if (v && !ratios.includes(v)) ratios.push(v);
      }
      for (const d of rows.durations || []) {
        const v = String(d).replace(/\s+/g, '').toLowerCase();
        if (v && !durations.includes(v)) durations.push(v);
      }
      // Expand the nested model dropdown and enumerate enabled exact rows.
      const models = await enumerateModelDropdown(page, curPanel).catch(() => []);
      for (const m of models) {
        if (!m || m.enabled === false) continue;
        const name = cleanModelName(m.name || '');
        if (!name) continue;
        const lower = name.toLowerCase();
        if (IMAGE_HINTS.some((h) => lower.includes(h))) pushUnique(imageModels, name);
        else if (VIDEO_HINTS.some((h) => lower.includes(h))) pushUnique(videoModels, name);
      }
    }

    // Restore full original settings/composer or invalidate.
    let restored = true;
    try {
      if (entryMode) {
        const backMode = await setPromptBarMode(page, entryMode).catch(() => null);
        if (!backMode?.ok) restored = false;
      }
      if (entryModel) {
        const { setPromptBarModel } = safe;
        const backModel = await setPromptBarModel(page, entryModel).catch(() => null);
        if (!backModel?.ok) restored = false;
      }
    } catch { restored = false; }
    try {
      await closeSettingsPanel(page).catch(() => {});
    } catch { /* ignore */ }
    // Verify restore by readback when we had an entry snapshot.
    if (entryModel || entryMode) {
      try {
        const after = await readToolState(page).catch(() => null);
        if (entryModel && after?.model && after.model !== 'unknown') {
          const { isModelLiveVerified } = await import('../utils/models.js');
          if (!isModelLiveVerified(entryModel, after.model)) restored = false;
        }
      } catch { /* keep restored flag */ }
    }

    if (videoModels.length === 0 && imageModels.length === 0) {
      logger.warn('Model discovery: no model options enumerated from nested dropdowns');
      await takeScreenshot(page, 'models-not-found');
      return null;
    }
    const now = new Date().toISOString();
    let projectId = null;
    try {
      const url = page.url();
      const m = String(url || '').match(/\/project\/([a-zA-Z0-9-]+)/);
      if (m) projectId = m[1];
    } catch { /* ignore */ }
    const catalog = {
      imageModels, videoModels, ratios, durations,
      discoveredAt: now,
      observedAt: now,
      source: 'live',
      provenance: 'live',
      accountKey: opts.accountKey || null,
      projectId: opts.projectId || projectId,
      restored,
    };
    if (!restored) {
      logger.warn('Model discovery: restore unverified — preparation/approval invalidated', { entryMode, entryModel });
    }
    saveCatalog(catalog);
    logger.info('Models discovered live from nested dropdowns', {
      video: videoModels, image: imageModels, ratios, durations, restored,
    });
    return catalog;
  } catch (e) {
    logger.warn('Model discovery failed (using cache/fallback)', { error: e.message });
    return null;
  }
}

/**
 * Enumerate ratio/duration rows owned by the settings panel (no dropdown).
 */
async function enumeratePanelRows(page, panel) {
  const handle = await panel.elementHandle().catch(() => null);
  if (!handle) return { ratios: [], durations: [] };
  const texts = await page.evaluate((root) => {
    const els = Array.from(root.querySelectorAll('[role="option"], [role="menuitem"], [role="tab"], li, button'));
    return els
      .map((e) => ((e.innerText || e.textContent) || '').trim().replace(/\s+/g, ' '))
      .filter((t) => t.length > 0 && t.length < 60);
  }, handle).catch(() => []);
  const ratios = [];
  const durations = [];
  for (const t of [...new Set(texts)]) {
    if (/^\d+\s*:\s*\d+$/.test(t)) ratios.push(t);
    else if (/^\d+\s*s$/i.test(t)) durations.push(t);
  }
  return { ratios, durations };
}

/**
 * Expand the nested model dropdown owned by the settings panel and enumerate
 * enabled exact option rows. Reads the owning expanded overlay (not the first
 * generic dialog), filters disabled/aria-disabled, closes the dropdown.
 * Returns [{ name, enabled }].
 */
async function enumerateModelDropdown(page, panel) {
  // Find the model row inside the owning panel.
  const row = panel.locator('button.mat-mdc-menu-trigger').first();
  let rowVisible = false;
  try {
    rowVisible = await row.isVisible({ timeout: 3000 }).catch(() => false);
  } catch { rowVisible = false; }
  let trigger = rowVisible ? row : panel.locator('button').filter({ hasText: /nano|banana|imagen|veo|omni/i }).first();
  try {
    if (!(await trigger.isVisible({ timeout: 3000 }).catch(() => false))) return [];
  } catch { return []; }
  await trigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // Owning expanded overlay: the visible pane that contains model options and
  // is NOT the settings panel itself. Poll for it (menu animation over CDP).
  let options = [];
  for (let i = 0; i < 10 && options.length === 0; i++) {
    if (i > 0) await page.waitForTimeout(500);
    options = await page.evaluate(() => {
      const out = [];
      for (const pane of document.querySelectorAll('.cdk-overlay-pane')) {
        const r = pane.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const items = pane.querySelectorAll('flow-menu-item, [role="option"], [role="menuitem"], li, button, [mat-menu-item]');
        for (const el of items) {
          const er = el.getBoundingClientRect();
          if (er.width === 0 && er.height === 0) continue;
          const cls = ((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '').toString();
          if (/menu-trigger/.test(cls)) continue;
          const t = ((el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ');
          if (!t || t.length >= 80) continue;
          if (!/nano|banana|imagen|veo|omni/i.test(t)) continue;
          const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
          out.push({ name: t.slice(0, 80), enabled: !disabled });
        }
        if (out.length > 0) break;
      }
      return out;
    }).catch(() => []);
  }
  // Close the dropdown (one Escape closes overlay; settings panel stays per Flow).
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  return options;
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
      const capabilitiesMeta = { ...(prev.capabilitiesMeta || {}) };
      const now = new Date().toISOString();
      // W03 timestamps binding: per-combination evidence + observed/expiry.
      const { CAPABILITY_MAX_AGE_MS } = await import('../browser/capabilities.js');
      for (const p of probed) {
        capabilities[String(p.model).toLowerCase()] = p.caps;
        capabilitiesMeta[String(p.model).toLowerCase()] = {
          observedAt: now,
          expiresAt: new Date(Date.now() + CAPABILITY_MAX_AGE_MS).toISOString(),
          evidence: 'settings-panel-row-scan',
          restored,
        };
      }
      saveCatalog({
        ...prev,
        videoModels: Array.isArray(prev.videoModels) && prev.videoModels.length > 0
          ? prev.videoModels
          : models,
        capabilities,
        capabilitiesMeta,
        capabilitiesObservedAt: now,
      });
    }
    // W03 restore UI binding: if entry selection could be read but restore
    // failed, preparation/approval is invalidated by the caller (restored:false).
    return { probed, skipped, restored, observedAt: new Date().toISOString() };
  } catch (e) {
    logger.warn('Capability discovery failed (keeping static caps)', { error: e.message });
    return null;
  }
}
