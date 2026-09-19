import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { saveCatalog } from '../utils/models.js';
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
