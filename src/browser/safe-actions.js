import path from 'path';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';
import { getSelectors } from '../utils/selectors.js';

function actionDelay() {
  return get('actionDelayMs', 800);
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMac() {
  return process.platform === 'darwin';
}

export async function pressSelectAll(page) {
  const mod = isMac() ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+a`);
}

const IMAGE_FAMILIES = ['nano', 'banana', 'imagen'];
const VIDEO_FAMILIES = ['veo', 'omni', 'kling', 'sora', 'seedance'];

/**
 * Scope locator: the bottom prompt bar that owns the given input.
 * Agent toggle, model chip, ratio, video/image switch all live BELOW in this
 * bar — page-wide button scans hit nav chrome instead. Falls back to the
 * whole page when no bar container is found.
 */
export async function promptBarScope(page, inputLocator) {
  try {
    // Nearest ancestor div that owns ≥3 buttons: the bar row holding the
    // input PLUS the Agent/model/ratio/quantity/send buttons below it.
    const bar = inputLocator.locator('xpath=ancestor::div[count(.//button) >= 3][1]');
    if (await bar.count().catch(() => 0) > 0) return bar.first();
  } catch { /* fall through */ }
  return page.locator('body');
}

/**
 * Find the Agent-mode toggle button ("Agent" + aria-pressed) inside the bottom
 * prompt bar. Page-wide scans hit unrelated buttons — restrict to containers
 * that also own a prompt input.
 * Returns the locator or null.
 */
export async function findAgentToggle(page) {
  const candidates = await page.locator('button').filter({ hasText: /^Agent$/ }).all().catch(() => []);
  for (const btn of candidates) {
    if (!(await btn.isVisible().catch(() => false))) continue;
    // Accept only buttons sharing a container with a prompt input (the bar).
    const inBar = await btn.evaluate((b) => {
      let el = b;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        el = el.parentElement;
        if (!el) break;
        if (el.querySelector && el.querySelector('textarea, [contenteditable="true"]')) return true;
      }
      return false;
    }).catch(() => false);
    if (inBar) return btn;
  }
  return null;
}

/**
 * Ensure Agent mode is OFF. Flow's Agent chat hijacks the prompt box and
 * model UI — every MCP run turns it off first, then verifies.
 * Returns 'off'. Throws MANUAL_VERIFICATION_REQUIRED (as plain Error with
 * code) when it cannot be turned off — caller converts to FlowError.
 */
export async function ensureManualMode(page, opts = {}) {
  const tries = opts.tries ?? 2;
  for (let i = 0; i <= tries; i++) {
    const toggle = await findAgentToggle(page);
    if (!toggle) {
      logger.debug('Agent toggle not found — assuming manual UI');
      return 'unknown-no-toggle';
    }
    const pressed = await toggle.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'false') {
      if (i > 0) logger.info('Agent mode is now OFF (verified)');
      return 'off';
    }
    logger.info('Agent mode is ON — turning it off', { attempt: i + 1 });
    await toggle.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await takeScreenshot(page, 'agent-mode-stuck-on');
  const err = new Error(
    'Agent mode is ON and could not be turned off via the Agent toggle. ' +
    'Turn it off manually in Flow (Agent button by the prompt box), then retry. No credits spent.'
  );
  err.code = 'MANUAL_VERIFICATION_REQUIRED';
  throw err;
}

/**
 * Pure parsers for bottom-bar labels (user-verified bar map):
 * modes "Image"/"Video"; ratios "16:9","4:3","1:1","3:4","9:16";
 * quantities "x1".."x4" where x4 may use U+00D7 (×4).
 */
export function parseBarQuantity(text) {
  const m = String(text || '').trim().match(/^[x×]\s*([1-4])$/iu);
  return m ? Number(m[1]) : null;
}

export function parseBarRatio(text) {
  const norm = String(text || '').trim().replace(/\s+/g, '');
  return /^(16:9|4:3|1:1|3:4|9:16)$/.test(norm) ? norm : null;
}

/**
 * Locate the visible prompt input (owner of the bottom bar).
 */
async function barInput(page) {
  const cands = [
    page.locator('textarea[placeholder*="create" i]').first(),
    page.locator('textarea:visible').last(),
    page.locator('[contenteditable="true"]:visible').last(),
  ];
  for (const c of cands) {
    if (await c.isVisible().catch(() => false)) return c;
  }
  return null;
}

/**
 * Shared settings-panel primitives. The chip TOGGLES the panel, so every
 * open first checks for an already-open panel and every close confirms it
 * actually closed (Escape can be swallowed mid-animation).
 */
async function findSettingsPanel(page) {
  let panel = page.locator('[role="dialog"]:visible, [role="menu"]:visible, [role="listbox"]:visible').last();
  if ((await panel.count().catch(() => 0)) === 0) {
    const overlay = page.locator('.cdk-overlay-pane:visible').last();
    panel = (await overlay.count().catch(() => 0)) > 0 ? overlay
      : page.locator('div').filter({ hasText: /Generating will use/ }).first();
  }
  return (await panel.count().catch(() => 0)) > 0 ? panel : null;
}

async function closeSettingsPanel(page) {
  for (let i = 0; i < 4; i++) {
    if (!(await findSettingsPanel(page))) return true;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
  return !(await findSettingsPanel(page));
}

async function openBarSettings(page) {
  // Reuse an already-open panel (chip toggles — never blind-click).
  let panel = await findSettingsPanel(page);
  if (panel) return { panel };
  const input = await barInput(page);
  const scope = input ? await promptBarScope(page, input) : page.locator('body');
  let chip = scope.locator('button[aria-label*="Settings trigger" i]').first();
  if (!(await chip.isVisible({ timeout: 4000 }).catch(() => false))) {
    chip = scope.locator('button').filter({ hasText: /nano|banana|imagen|veo|omni|video|720p|360p/i }).first();
  }
  if (!(await chip.isVisible({ timeout: 4000 }).catch(() => false))) {
    return { error: 'settings chip not visible in prompt bar' };
  }
  for (let attempt = 0; attempt < 3 && !panel; attempt++) {
    if (attempt > 0) await page.waitForTimeout(800);
    await chip.click({ timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 10 && !panel; i++) {
      await page.waitForTimeout(500);
      panel = await findSettingsPanel(page);
    }
  }
  if (!panel) return { error: 'settings panel did not open from chip' };
  return { panel };
}

function selectedStateOf(el) {
  if (!el) return false;
  if (el.getAttribute('aria-pressed') === 'true') return true;
  if (el.getAttribute('aria-checked') === 'true') return true;
  if (el.getAttribute('data-state') === 'on') return true;
  if (el.getAttribute('data-selected') === 'true') return true;
  if (el.classList && /selected|active/i.test(String(el.className))) return true;
  return false;
}

/**
 * Pick one toggle option inside an OPEN settings panel. Skips the click when
 * the option already reads selected (aria-checked — mat-button-toggle).
 * Never opens/closes the panel. Returns { ok, verified, detail }.
 */
async function pickPanelToggle(page, panel, kind, wantText, matchRe) {
  const fail = (detail) => ({ ok: false, verified: false, kind, detail });
  let opt = panel.locator('button, [role="option"], [role="menuitem"], li').filter({ hasText: matchRe }).first();
  if (!(await opt.isVisible({ timeout: 3000 }).catch(() => false))) {
    const containsRe = kind === 'ratio'
      ? new RegExp(wantText.replace(':', '\\s*:\\s*'), 'i')
      : new RegExp(wantText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    opt = panel.locator('button, [role="option"], [role="menuitem"], li').filter({ hasText: containsRe }).first();
  }
  if (!(await opt.isVisible({ timeout: 4000 }).catch(() => false))) {
    const names = await panel.evaluate((p) =>
      [...new Set(Array.from(p.querySelectorAll('button, [role="option"], [role="menuitem"], li'))
        .map(e => (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' '))
        .filter(x => x.length > 0 && x.length < 60))].slice(0, 40)).catch(() => []);
    logger.warn(`Bar ${kind} option not in settings panel`, { want: wantText, panelOptions: names });
    await takeScreenshot(page, `bar-${kind}-no-option`);
    return fail(`option "${wantText}" not in settings panel`);
  }
  const already = await opt.evaluate(selectedStateOf).catch(() => false);
  if (already) {
    logger.info(`Prompt-bar ${kind} already set — no click`, { want: wantText });
    return { ok: true, verified: true, kind, detail: `${wantText} (already set)` };
  }
  await opt.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // The panel re-renders on mode switches — the clicked handle may be
  // detached, so re-query before reading selected state.
  const fresh = panel.locator('button, [role="option"], [role="menuitem"], li').filter({ hasText: matchRe }).first();
  const probe = (await fresh.isVisible({ timeout: 3000 }).catch(() => false)) ? fresh : opt;
  const selected = await probe.evaluate((b) => {
    if (selectedStateOf(b)) return true;
    // A parent row/group may carry the selected state instead.
    let el = b;
    for (let i = 0; i < 3 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.getAttribute && selectedStateOf(el)) return true;
    }
    return false;
  }).catch(() => null);
  await takeScreenshot(page, `bar-${kind}-set`);
  if (selected === true) {
    logger.info(`Prompt-bar ${kind} set + verified`, { want: wantText });
    return { ok: true, verified: true, kind, detail: wantText };
  }
  logger.warn(`Prompt-bar ${kind} clicked, selection state not exposed`, { want: wantText });
  return { ok: true, verified: false, kind, detail: `${wantText} (clicked, unverified)` };
}

/**
 * Batch-configure mode/ratio/quantity/quality/duration in ONE panel open.
 * One open → set each (skipping correct ones) → one confirmed close.
 * This avoids chip-toggle churn between separate setter calls.
 */
export async function configurePromptBar(page, { mode, ratio, quantity, quality, duration }) {
  const fail = (detail) => ({ ok: false, verified: false, kind: 'panel', detail });
  const opened = await openBarSettings(page);
  if (opened.error || !opened.panel) {
    await takeScreenshot(page, 'bar-batch-no-panel');
    return [fail(opened.error || 'settings panel did not open')];
  }
  const panel = opened.panel;
  const specs = [];
  if (mode) {
    const want = mode === 'Video' ? 'Video' : 'Image';
    specs.push(['mode', want, new RegExp(`^${want}$`, 'i')]);
  }
  if (ratio) {
    const want = parseBarRatio(ratio) || String(ratio).trim();
    specs.push(['ratio', want, new RegExp(`^${want.replace(':', '\\s*:\\s*')}$`)]);
  }
  if (quantity != null) {
    const n = Math.min(Math.max(Number(quantity) || 1, 1), 4);
    specs.push(['quantity', `x${n}`, new RegExp(`^[x×]\\s*${n}$`, 'iu')]);
  }
  if (quality) specs.push(['quality', String(quality), new RegExp(`^${String(quality).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')]);
  if (duration) specs.push(['duration', String(duration), new RegExp(`^${String(duration).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')]);
  const results = [];
  for (const [kind, want, re] of specs) {
    // Relocate the panel before EVERY pick: mode switches re-render it, so
    // a handle captured before the previous pick is stale afterwards.
    let live = await findSettingsPanel(page);
    if (!live) {
      const reopened = await openBarSettings(page);
      live = reopened.panel || null;
    }
    if (!live) {
      results.push({ ok: false, verified: false, kind, detail: 'settings panel vanished mid-batch' });
      continue;
    }
    results.push(await pickPanelToggle(page, live, kind, want, re));
    await page.waitForTimeout(800);
  }
  const closed = await closeSettingsPanel(page);
  if (!closed) {
    await takeScreenshot(page, 'bar-batch-stuck-open');
    logger.warn('Settings panel would not close after batch — continuing, next step reuses it');
  }
  await page.waitForTimeout(600);
  return results;
}

/**
 * Click an option inside the bottom-bar SETTINGS panel and read back.
 * The bar itself holds only [close][add][Agent][chip][send] — Image/Video,
 * ratios, quantities and models all live behind the chip ("Settings trigger").
 * Opens the panel, clicks the exact-text option, verifies selected state
 * in-panel, closes with Escape, screenshots.
 * Returns { ok, verified, detail } — never throws.
 */
async function clickBarOption(page, kind, wantText, matchRe) {
  const fail = (detail) => ({ ok: false, verified: false, kind, detail });
  try {
    const opened = await openBarSettings(page);
    if (opened.error || !opened.panel) {
      await takeScreenshot(page, `bar-${kind}-no-panel`);
      await closeSettingsPanel(page);
      return fail(opened.error || 'settings panel did not open from chip');
    }
    // Exact text first (icon ligatures can pollute labels) — then contains.
    const res = await pickPanelToggle(page, opened.panel, kind, wantText, matchRe);
    await closeSettingsPanel(page);
    await page.waitForTimeout(600);
    return res;
  } catch (e) {
    return fail(e.message);
  }
}

/** Set Image/Video mode via the bottom bar. */
export async function setPromptBarMode(page, mode) {
  const want = mode === 'Video' ? 'Video' : 'Image';
  return clickBarOption(page, 'mode', want, new RegExp(`^${want}$`, 'i'));
}

/** Set aspect ratio via the bottom bar (16:9, 4:3, 1:1, 3:4, 9:16). */
export async function setPromptBarRatio(page, ratio) {
  const want = parseBarRatio(ratio);
  if (!want) return { ok: false, verified: false, kind: 'ratio', detail: `unsupported ratio "${ratio}"` };
  return clickBarOption(page, 'ratio', want, new RegExp(`^${want.replace(':', '\\s*:\\s*')}$`));
}

/** Set output count via the bottom bar (x1..x4, accepts ×N spelling). */
export async function setPromptBarQuantity(page, qty) {
  const n = Math.min(Math.max(Number(qty) || 1, 1), 4);
  return clickBarOption(page, 'quantity', `x${n}`, new RegExp(`^[x×]\\s*${n}$`, 'iu'));
}

/** Set quality toggle via settings — validated against the live universe,
 * never silently coerced (unknown quality fails so the caller can ask). */
export async function setPromptBarQuality(page, quality) {
  const { getUniverse } = await import('../utils/models.js');
  const available = getUniverse().qualities || [];
  const want = String(quality || '').trim().toLowerCase();
  const hit = available.find(q => String(q).toLowerCase() === want);
  if (!hit) {
    return { ok: false, verified: false, kind: 'quality', detail: `quality "${quality}" not in live list (${available.join('/')})` };
  }
  return clickBarOption(page, 'quality', hit, new RegExp(`^${hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
}

/** Set duration toggle via settings (4s/6s/8s/10s — mat-button-toggle). */
export async function setPromptBarDuration(page, duration) {
  const m = String(duration || '').match(/(\d+)\s*s?/i);
  const want = m && ['4', '6', '8', '10'].includes(m[1]) ? `${m[1]}s` : '8s';
  return clickBarOption(page, 'duration', want, new RegExp(`^${want}$`, 'i'));
}

/** Set model via the bottom-bar settings panel. Exact name first, family fallback.
 * The model row is a nested DROPDOWN: click row → click model in expanded
 * list → close → verify via chip read-back. */
export async function setPromptBarModel(page, model) {
  const want = String(model || '').trim();
  if (!want) return { ok: false, verified: false, kind: 'model', detail: 'empty model name' };
  const fail = (detail) => ({ ok: false, verified: false, kind: 'model', detail });
  try {
    const opened = await openBarSettings(page);
    if (opened.error || !opened.panel) return fail(opened.error || 'settings panel did not open');
    const panel = opened.panel;
    // Read-before-write: the model row (mat-mdc-menu-trigger) shows the
    // current model — skip the dropdown entirely when it already matches.
    const readRow = async (root) => {
      try {
        let r = root.locator('button.mat-mdc-menu-trigger').first();
        if (!(await r.isVisible({ timeout: 2500 }).catch(() => false))) {
          r = root.locator('button').filter({ hasText: /nano|banana|imagen|veo|omni/i }).first();
        }
        if (await r.isVisible({ timeout: 2500 }).catch(() => false)) {
          return ((await r.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
        }
      } catch { /* ignore */ }
      return '';
    };
    const rowNow = await readRow(panel);
    // Full-name match only (normalized): a family-only match is NOT enough —
    // "Nano Banana 2" must not satisfy "Nano Banana Pro".
    const normRow = rowNow.toLowerCase()
      .replace(/arrow_drop_down|arrow_drop_up/g, '')
      .replace(/^[^a-z0-9]+/u, '').replace(/\s+/g, ' ').trim();
    if (normRow && normRow.includes(want.toLowerCase())) {
      logger.info('Model already selected in settings row — no change', { want, row: rowNow });
      await closeSettingsPanel(page);
      return { ok: true, verified: true, kind: 'model', detail: want };
    }
    const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Expand the model dropdown row (shows current model + chevron).
    const row = panel.locator('button').filter({ hasText: /nano|banana|imagen|veo|omni/i }).first();
    if (await row.isVisible().catch(() => false)) {
      await row.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    const names = await panel.evaluate((p) =>
      [...new Set(Array.from(p.querySelectorAll('button, flow-menu-item, [role="option"], [role="menuitem"], li'))
        .map(e => (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' '))
        .filter(x => x.length > 0 && x.length < 80))].slice(0, 40)).catch(() => []);
    logger.info('Settings-panel model options', { sample: names.slice(0, 20) });
    const family = want.split(' ')[0];
    const hit = names.find(n => n.toLowerCase() === want.toLowerCase())
      || names.find(n => n.toLowerCase().includes(want.toLowerCase()))
      || names.find(n => n.toLowerCase().includes(family.toLowerCase()));
    if (hit) {
      // The model dropdown (mat-menu) renders its options in a separate
      // overlay and icon ligatures glue to labels without spaces in
      // textContent ("volume_upOmni…") — both defeat locator hasText.
      // POLL for the option (menu animation is slow over CDP), then
      // activate the first non-row match in the DOM.
      let clicked = null;
      for (let i = 0; i < 16 && !clicked; i++) {
        if (i > 0) await page.waitForTimeout(500);
        clicked = await page.evaluate((wantLower) => {
          const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
          for (const pane of document.querySelectorAll('.cdk-overlay-pane')) {
            const r = pane.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            // Model options are FLOW-MENU-ITEM custom elements (mat-menu).
            for (const b of pane.querySelectorAll('flow-menu-item, button, a, [role="option"], [role="menuitem"], li, [mat-menu-item]')) {
              const t = norm(b.innerText || b.textContent);
              if (!t.includes(wantLower)) continue;
              const cls = (b.className?.baseVal ?? b.className ?? '').toString();
              if (/menu-trigger/.test(cls)) continue; // collapsed row, not an option
              const br = b.getBoundingClientRect();
              if (br.width === 0 && br.height === 0) continue;
              b.click();
              return { clicked: t };
            }
          }
          return null;
        }, want.toLowerCase()).catch(() => null);
      }
      logger.info('Model option DOM click', { want, clicked });
      await page.waitForTimeout(1500);
      if (!clicked?.clicked) {
        logger.warn('Model option matched in text scan but not clickable', { hit });
      }
    } else {
      logger.warn('Model not listed in settings panel', { want, names });
    }
    await takeScreenshot(page, 'bar-model-set');
    // Close the dropdown FIRST, then confirm the option list is really gone:
    // otherwise the "row" read below can match the still-open list (bogus).
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      const listOpen = await page.locator('.cdk-overlay-pane:visible, [role="listbox"]:visible')
        .filter({ hasText: /veo 3\.1|omni/i }).first().isVisible().catch(() => false);
      if (!listOpen) break;
    }
    await page.waitForTimeout(800);
    // Verify via the model ROW (shows the current model after the dropdown
    // closes) — the bar chip carries no model name in video mode.
    let rowText = '';
    try {
      const row = panel.locator('button').filter({ hasText: /nano|banana|imagen|veo|omni/i }).first();
      if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
        rowText = ((await row.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
      }
    } catch { /* ignore */ }
    if (!rowText) {
      // Escape closed the whole settings panel — reopen and read the row.
      try {
        const reopened = await openBarSettings(page);
        if (reopened.panel) {
          rowText = await readRow(reopened.panel);
        }
        await closeSettingsPanel(page);
      } catch { /* ignore */ }
    }
    const after = await readToolState(page).catch(() => null);
    const normHit = String(rowText || '').toLowerCase()
      .replace(/arrow_drop_down|arrow_drop_up/g, '')
      .replace(/^[^a-z0-9]+/u, '').replace(/\s+/g, ' ').trim();
    const rowHit = normHit && normHit.includes(want.toLowerCase());
    const ok = !!rowHit;
    if (ok) {
      logger.info('Model set + row verified', { want, row: rowText, chip: after?.modelChip });
      return { ok: true, verified: true, kind: 'model', detail: want };
    }
    void esc;
    return fail(`model "${want}" not confirmed (hit=${hit || 'none'}, row=${rowText || 'none'}, chip=${after?.modelChip || 'none'})`);
  } catch (e) {
    return fail(e.message);
  }
}

/**
 * Read the current tool state from the bottom prompt bar:
 * agent mode, generation mode (image|video|unknown from chip family),
 * model chip text + parsed model, ratio hint, quantity.
 * Pure read — never clicks.
 */
export async function readToolState(page) {
  const state = {
    agentMode: 'unknown',
    mode: 'unknown',
    model: null,
    modelChip: null,
    ratio: null,
    quantity: null,
    duration: null,
  };
  try {
    const toggle = await findAgentToggle(page);
    if (toggle) {
      const pressed = await toggle.getAttribute('aria-pressed').catch(() => null);
      state.agentMode = pressed === 'true' ? 'on' : pressed === 'false' ? 'off' : 'unknown';
    }
  } catch { /* ignore */ }
  try {
    // Model chip: button in the prompt bar carrying a model + ratio + quantity,
    // e.g. "🍌 Nano Banana 2 ▢ x2". Scan INSIDE the prompt bar only —
    // page-wide scans hit nav chrome. Also read the bar's explicit
    // Image/Video, ratio and xN buttons (user-verified bar map).
    const input = await barInput(page);
    const scope = input ? await promptBarScope(page, input) : page.locator('body');
    const btns = await scope.locator('button').all().catch(() => []);
    const texts = [];
    for (const b of btns) {
      if (!(await b.isVisible().catch(() => false))) continue;
      const txt = ((await b.textContent().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
      if (txt) texts.push(txt);
    }
    let best = null;
    let bestHasModel = false;
    for (const txt of texts) {
      if (txt.length > 60) continue;
      const lower = txt.toLowerCase();
      const fam = [...IMAGE_FAMILIES, ...VIDEO_FAMILIES, 'omni', 'kling', 'sora', 'seedance', 'hailuo', 'wan', 'flux', 'soul', 'reve', 'gpt'];
      if (fam.some(f => lower.includes(f))) {
        best = txt;
        bestHasModel = true;
        break;
      }
    }
    // Fallback: video/image mode chip without a model token
    // ("Video · 720p · 8s ▢ x1" / "Nano…" always has one, video may not).
    if (!best) {
      best = texts.find(t => /^(video|image)\b/i.test(t) && t.length <= 60) || null;
    }
    if (best) {
      state.modelChip = best;
      const lower = best.toLowerCase();
      // Video-mode chip carries no model name ("Video · 720p · 8s ▢ x1") —
      // still extract mode/duration/quantity from it.
      if (/^video\b/.test(lower)) state.mode = 'video';
      else if (/^image\b/.test(lower)) state.mode = 'image';
      const dm = best.match(/(\d+)\s*s\b/i);
      if (dm) state.duration = `${dm[1]}s`;
      // Quantity: trailing xN / ×N (U+00D7).
      const qm = lower.match(/[x×]\s*([1-4])\s*$/u);
      if (qm) state.quantity = Number(qm[1]);
      // Explicit ratio text wins; then crop glyph (crop_16_9); else null.
      const rm = best.match(/(\d+\s*:\s*\d+)/);
      if (rm) state.ratio = rm[1].replace(/\s+/g, '');
      else {
        const cm = best.match(/crop_(\d+)_(\d+)/i);
        if (cm) state.ratio = `${cm[1]}:${cm[2]}`;
      }
      // Model = chip minus quantity/ratio/crop tails and emoji — but ONLY
      // when the chip actually names a model (video chips often don't).
      let model = bestHasModel
        ? best.replace(/[x×]\s*[1-4]\s*$/iu, '').replace(/(\d+\s*:\s*\d+)\s*$/i, '').trim()
        : '';
      if (bestHasModel) {
        model = model.replace(/^[\p{Emoji}\p{So}\u2000-\u2BFF]+\s*/u, '').trim();
        // Drop lone ratio glyph tails (▢ ▯ □ etc.) and crop params (crop_16_9).
        model = model.replace(/[\u25A0-\u25FF\u2300-\u23FF]\s*$/u, '').trim();
        model = model.replace(/\bcrop_\d+_\d+\b/gi, '').replace(/\s+/g, ' ').trim();
      }
      state.model = model || null;
      if (IMAGE_FAMILIES.some(f => lower.includes(f))) state.mode = 'image';
      else if (VIDEO_FAMILIES.some(f => lower.includes(f))) state.mode = 'video';
    }
    // Explicit bar buttons override chip-family guessing.
    for (const t of texts) {
      const r = parseBarRatio(t);
      if (r && !state.ratio) state.ratio = r;
      const q = parseBarQuantity(t);
      if (q && !state.quantity) state.quantity = q;
    }
  } catch (e) {
    logger.debug('readToolState model scan failed', { error: e.message });
  }
  return state;
}

/**
 * Pure decision step for attachment verification (P0-1/P0-2), unit-tested.
 * verified means the file input demonstrably accepted every requested file
 * (input.files.length read-back). Rendered-preview counts are reported for
 * transparency but never gate anything: preview DOM varies by Flow UI
 * version and must not brick a working run on a guessed selector.
 */
export function summarizeAttachment({ requested = [], inputAccepted = 0, previewsBefore = 0, previewsAfter = 0 } = {}) {
  const names = [...requested];
  if (names.length === 0) {
    return { requested: [], inputAccepted: 0, attached: 0, verified: true, notes: ['no files requested'] };
  }
  const attached = Math.max(0, previewsAfter - previewsBefore);
  const notes = [
    `file input accepted ${inputAccepted}/${names.length}`,
    `rendered previews: ${previewsBefore} → ${previewsAfter}`,
  ];
  return { requested: names, inputAccepted, attached, verified: inputAccepted === names.length, notes };
}

/**
 * Upload local reference/frame files through Flow's file input, then read
 * back that they actually landed (P0-1/P0-2). Returns summarizeAttachment()
 * output. Never throws for UI absence — verified:false lets the caller
 * warn (prepare-only) or refuse the paid click (live).
 */
export async function attachReferenceFiles(page, inputLocator, files, opts = {}) {
  const names = (files || []).map((f) => path.basename(String(f)));
  const label = opts.label || 'references';
  if (!files || files.length === 0) return summarizeAttachment({ requested: [] });
  let scope = null;
  try {
    scope = inputLocator ? await promptBarScope(page, inputLocator) : page.locator('body');
  } catch {
    scope = page.locator('body');
  }
  const countPreviews = async () => {
    try {
      return await scope.locator('img, [role="img"]').count();
    } catch {
      return 0;
    }
  };
  const previewsBefore = await countPreviews();
  try {
    await page.locator('input[type="file"]').first().setInputFiles(files);
    await page.waitForTimeout(1500);
  } catch (e) {
    logger.warn('Reference attach failed (no file input)', { label, error: e.message });
    const base = summarizeAttachment({ requested: names, inputAccepted: 0, previewsBefore, previewsAfter: previewsBefore });
    return { ...base, notes: [...base.notes, `${label}: no file input available (${e.message}); attach manually`] };
  }
  // Re-query before read-back: the framework may re-render the input.
  let inputAccepted = 0;
  try {
    inputAccepted = await page.locator('input[type="file"]').first()
      .evaluate((el) => (el && el.files ? el.files.length : 0));
  } catch (e) {
    logger.warn('Reference attach read-back failed', { label, error: e.message });
  }
  const previewsAfter = await countPreviews();
  const out = summarizeAttachment({ requested: names, inputAccepted, previewsBefore, previewsAfter });
  logger.info('Reference attach result', {
    label,
    requested: out.requested,
    inputAccepted: out.inputAccepted,
    attached: out.attached,
    verified: out.verified,
  });
  return out;
}

/**
 * Safe click with pre- and post-delay
 */
export async function safeClick(selector, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay ?? actionDelay();
  const postDelay = options.postDelay ?? actionDelay();

  await delay(preDelay);
  let element = null;
  try {
    element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  } catch {
    throw new Error(`Element not found: ${selector}`);
  }
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  try {
    await element.click({ timeout: 5000 });
  } catch (e) {
    // Stale handle between wait and click — retry once via locator.
    logger.warn('safeClick stale handle, retrying via locator', { selector, error: e.message });
    await page.locator(selector).first().click({ timeout: 5000 });
  }
  await delay(postDelay);
  logger.debug('Clicked element', { selector });
}

/**
 * Safe fill input
 */
export async function safeFill(selector, text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay ?? actionDelay();
  const postDelay = options.postDelay ?? actionDelay();

  await delay(preDelay);
  let element = null;
  try {
    element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  } catch {
    throw new Error(`Input not found: ${selector}`);
  }
  if (!element) {
    throw new Error(`Input not found: ${selector}`);
  }
  await element.click();
  await element.fill('');
  await delay(200);
  await element.type(text, { delay: 30 });
  await delay(postDelay);
  logger.debug('Filled input', { selector, textLength: text.length });
}

/**
 * Safe press keyboard key
 */
export async function safePress(key, options = {}) {
  const page = getPage();
  const preDelay = options.preDelay ?? actionDelay();
  await delay(preDelay);
  await page.keyboard.press(key);
  await delay(actionDelay());
}

/**
 * Wait for text to appear on page
 */
export async function waitForText(text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 15000;
  try {
    await page.waitForSelector(`text=${text}`, { timeout });
    logger.debug('Text found on page', { text });
    return true;
  } catch {
    logger.warn('Text not found on page', { text });
    return false;
  }
}

/**
 * Navigate and wait for load
 */
export async function safeGoto(url, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 30000;
  const preDelay = options.preDelay || 500;

  await delay(preDelay);
  logger.info('Navigating', { url: url.substring(0, 80) });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await delay(actionDelay());
}

/**
 * Get visible text of all elements matching selector
 */
export async function getVisibleTexts(selector) {
  const page = getPage();
  const elements = await page.$$(selector);
  const texts = [];
  for (const el of elements) {
    if (await el.isVisible()) {
      const text = await el.textContent();
      if (text && text.trim()) texts.push(text.trim());
    }
  }
  return texts;
}

/**
 * Detect all buttons, inputs, and interactive elements on the page
 */
export async function detectPageElements() {
  const page = getPage();
  const elements = await page.evaluate(() => {
    const isShown = (el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const result = {
      buttons: [],
      inputs: [],
      links: [],
      dropdowns: [],
      headings: [],
      labels: [],
    };

    document.querySelectorAll('button, [role="button"], [type="button"]').forEach(el => {
      const text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
      if (text && text.length < 100) {
        result.buttons.push({
          text: text.substring(0, 80),
          visible: isShown(el),
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label') || null,
          dataTestId: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || null,
        });
      }
    });

    document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]').forEach(el => {
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const name = el.getAttribute('name') || '';
      result.inputs.push({
        placeholder: placeholder.substring(0, 60),
        ariaLabel: ariaLabel.substring(0, 60),
        name: name.substring(0, 60),
        type: el.getAttribute('type') || el.tagName,
        visible: isShown(el),
      });
    });

    document.querySelectorAll('a[href]').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (text && text.length < 80) {
        result.links.push({
          text: text.substring(0, 60),
          href: (el.getAttribute('href') || '').substring(0, 100),
          visible: isShown(el),
        });
      }
    });

    document.querySelectorAll('select, [role="listbox"]').forEach(el => {
      const label = el.getAttribute('aria-label') || el.textContent?.trim() || '';
      result.dropdowns.push({
        label: label.substring(0, 60),
        visible: isShown(el),
      });
    });

    document.querySelectorAll('h1, h2, h3, h4').forEach(el => {
      result.headings.push({
        level: el.tagName,
        text: (el.textContent?.trim() || '').substring(0, 80),
      });
    });

    return result;
  });

  return elements;
}

/**
 * Read the current generation mode from the toolbar tabs.
 * Returns 'image', 'video', or null if not determinable.
 */
export async function readCurrentGenerationMode() {
  const page = getPage();
  const { getSelectors } = await import('../utils/selectors.js');
  const imgSels = getSelectors('modeTab', { MODE: 'IMAGE' });
  const vidSels = getSelectors('modeTab', { MODE: 'VIDEO' });
  try {
    const result = await page.evaluate(({ imgSels, vidSels }) => {
      // Strategy 1: mode tabs by registry IDs
      const imageTab = document.querySelector(imgSels.join(', '));
      const videoTab = document.querySelector(vidSels.join(', '));

      if (imageTab && videoTab) {
        const imageSelected = imageTab.getAttribute('aria-selected') === 'true';
        const videoSelected = videoTab.getAttribute('aria-selected') === 'true';
        if (imageSelected) return { mode: 'image', method: 'tab-id' };
        if (videoSelected) return { mode: 'video', method: 'tab-id' };
      }

      // Strategy 2: Look for tab buttons where the text is exactly "Image" or "Video"
      const allTabs = Array.from(document.querySelectorAll('[role="tab"], button[aria-selected]'));
      for (const tab of allTabs) {
        const text = (tab.textContent || '').trim();
        const selected = tab.getAttribute('aria-selected') === 'true';
        if (selected && (text === 'Image' || text === 'Images')) return { mode: 'image', method: 'tab-text' };
        if (selected && (text === 'Video' || text === 'Videos')) return { mode: 'video', method: 'tab-text' };
      }

      // Strategy 3: Look for duration selector (only present in video mode)
      const hasDuration = !!document.querySelector('[aria-label*="duration" i], [class*="duration"]');
      if (hasDuration) return { mode: 'video', method: 'duration-check' };

      return { mode: null, method: 'unknown' };
    }, { imgSels, vidSels });
    logger.info('Current generation mode detected', result);
    return result.mode;
  } catch (e) {
    logger.warn('Could not detect generation mode', { error: e.message });
    return null;
  }
}

/**
 * Safely configures the generation settings (mode, ratio, model, quantity, duration)
 * by clicking the correct tabs in the Flow bottom toolbar.
 *
 * The Flow toolbar has these layers:
 *   • Top-level mode tabs: Image | Video  (role=tab, id=*trigger-IMAGE / *trigger-VIDEO)
 *   • Settings panel (opened by clicking a settings/gear button or the model name chip)
 *     - Ratio tabs: 1:1 | 16:9 | 9:16 | 4:3 | 3:4
 *     - Quantity tabs: 1x | x2 | x3 | x4
 *     - Duration tabs (video only): 4s | 6s | 8s
 *     - Model dropdown (arrow_drop_down button)
 */
export async function configureGenerationUI(options = {}) {
  const { mode, ratio, model, quantity, duration, strict = false } = options;
  const page = getPage();
  const failures = [];
  const verified = [];

  logger.info('Configuring generation UI (Fast-then-Quality, fail-closed on miss when strict)', { mode, ratio, model, quantity, duration, strict });

  // ─── STEP 1: Switch mode (Image vs Video) via registry tab IDs ───────────
  if (mode) {
    const isImage = mode === 'Image';
    const triggerSuffix = isImage ? 'IMAGE' : 'VIDEO';

    // Primary: registry tab IDs
    let modeTabVisible = false;
    let modeTab = null;
    for (const sel of getSelectors('modeTab', { MODE: triggerSuffix })) {
      const cand = page.locator(sel).first();
      if (await cand.isVisible().catch(() => false)) {
        modeTab = cand;
        modeTabVisible = true;
        break;
      }
    }

    if (modeTabVisible) {
      const alreadySelected = await modeTab.getAttribute('aria-selected').catch(() => 'false');
      if (alreadySelected !== 'true') {
        logger.info(`Switching to ${mode} mode via tab ID trigger-${triggerSuffix}`);
        await modeTab.click();
        await page.waitForTimeout(1200);

        // Verify the switch happened
        const nowSelected = await modeTab.getAttribute('aria-selected').catch(() => 'false');
        if (nowSelected !== 'true') {
          logger.warn(`Mode switch to ${mode} may not have worked, retrying`);
          await modeTab.click();
          await page.waitForTimeout(1200);
        }
      } else {
        logger.info(`Already in ${mode} mode`);
      }
    } else {
      // Fallback: text-based tab search
      const modeTabByText = page.locator('[role="tab"]')
        .filter({ hasText: new RegExp(`^${escapeRegExp(mode)}$`, 'i') }).first();
      if (await modeTabByText.isVisible().catch(() => false)) {
        logger.info(`Switching to ${mode} mode via text tab fallback`);
        await modeTabByText.click();
        await page.waitForTimeout(1200);
      } else {
        logger.warn(`Could not find ${mode} mode tab — UI may have changed`);
        await takeScreenshot(page, `configure-ui-no-${mode.toLowerCase()}-tab`);
      }
    }
  }

  // ─── STEP 2: Open the settings/options panel to access ratio, quantity, model ─
  // Candidates come from the selector registry (self-healing via discover-ui).
  let panelOpened = false;

  // Try a dedicated settings button first (gear icon, settings, options)
  const settingsBtnSelectors = getSelectors('settingsTrigger');

  for (const sel of settingsBtnSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(800);
      panelOpened = true;
      logger.info('Opened settings panel via settings button', { sel });
      break;
    }
  }

  if (!panelOpened) {
    // Fallback: click the model-name chip/button (shows model name + ratio).
    // Registry entries are refreshed by live model discovery, so new model
    // names appear here automatically.
    const modelChipSelectors = getSelectors('modelChip');

    for (const sel of modelChipSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(800);
        panelOpened = true;
        logger.info('Opened settings panel via model chip', { sel });
        break;
      }
    }
  }

  if (!panelOpened) {
    logger.warn('Could not open settings panel — ratio/quantity/model will not be configured');
    await takeScreenshot(page, 'configure-ui-panel-not-opened');
  }

  if (panelOpened) {
    // ─── STEP 3: Select Ratio ───────────────────────────────────────────────
    if (ratio) {
      // Ratio tabs are role=tab buttons with text like "1:1", "16:9", etc.
      const ratioTab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${escapeRegExp(ratio)}$`) }).first();
      if (await ratioTab.isVisible().catch(() => false)) {
        const ratioSelected = await ratioTab.getAttribute('aria-selected').catch(() => 'false');
        if (ratioSelected !== 'true') {
          logger.info(`Setting ratio to ${ratio}`);
          await ratioTab.click();
          await page.waitForTimeout(500);
        } else {
          logger.info(`Ratio ${ratio} already selected`);
        }
        verified.push('ratio');
      } else {
        failures.push(`ratio tab ${ratio} not found`);
        logger.warn(`Could not find ratio tab for ${ratio}`);
      }
    }

    // ─── STEP 4: Select Duration (video only) ──────────────────────────────
    if (duration && mode === 'Video') {
      // Duration tabs look like "4s", "6s", "8s". Accept number (5) or string ("5s").
      const durStr = typeof duration === 'number' ? `${duration}s`
        : String(duration).endsWith('s') ? String(duration) : `${duration}s`;
      const durTab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${escapeRegExp(durStr)}$`) }).first();
      if (await durTab.isVisible().catch(() => false)) {
        logger.info(`Setting duration to ${durStr}`);
        await durTab.click();
        await page.waitForTimeout(500);
        verified.push('duration');
      } else {
        failures.push(`duration tab ${durStr} not found`);
        logger.warn(`Could not find duration tab for ${durStr}`);
      }
    }

    // ─── STEP 5: Select Quantity ────────────────────────────────────────────
    if (quantity) {
      // Quantity tabs: "1x", "x2", "x3", "x4" (varies by mode/UI version)
      const qtyVariants = [
        `${quantity}x`,   // "1x", "2x"
        `x${quantity}`,   // "x2", "x3"
        String(quantity), // plain "1", "2"
      ];
      let qtySet = false;
      for (const qtyStr of qtyVariants) {
        const qtyTab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${escapeRegExp(qtyStr)}$`) }).first();
        if (await qtyTab.isVisible().catch(() => false)) {
          const qtySelected = await qtyTab.getAttribute('aria-selected').catch(() => 'false');
          if (qtySelected !== 'true') {
            logger.info(`Setting quantity to ${qtyStr}`);
            await qtyTab.click();
            await page.waitForTimeout(500);
          } else {
            logger.info(`Quantity ${qtyStr} already selected`);
          }
          qtySet = true;
          verified.push('quantity');
          break;
        }
      }
      if (!qtySet) {
        failures.push(`quantity tab ${quantity} not found`);
        logger.warn(`Could not find quantity tab for quantity ${quantity}`);
      }
    }

    // ─── STEP 6: Select Model via dropdown ─────────────────────────────────
    // Guard: only click a button that actually looks like a model chip
    // (contains a known model/ratio token). A bare aria-haspopup matches EVERY
    // menu trigger (project ⋮, settings, account) — clicking those opens random
    // menus whose overlay backdrop then blocks all later clicks.
    if (model) {
      const MODEL_TOKENS = ['nano', 'banana', 'imagen', 'veo', 'omni', 'flash', '16:9', '9:16', '1:1', '4:3', '3:4'];
      const dropdownBtns = await page.locator('button').all();
      let dropdownBtn = null;
      for (const btn of dropdownBtns) {
        if (!(await btn.isVisible().catch(() => false))) continue;
        const txt = ((await btn.textContent().catch(() => '')) || '').trim().toLowerCase();
        const hasPopup = await btn.getAttribute('aria-haspopup').catch(() => null);
        const looksLikeModel = MODEL_TOKENS.some(t => txt.includes(t)) || txt.includes('arrow_drop_down');
        if (looksLikeModel && (txt.includes('arrow_drop_down') || hasPopup)) {
          dropdownBtn = btn;
          break;
        }
      }

      if (dropdownBtn) {
        const currentModelName = (await dropdownBtn.textContent().catch(() => ''))
          .replace('arrow_drop_down', '').trim().toLowerCase();
        const targetModel = model.toLowerCase().trim();
        // Exact (normalized) match — no substring false-positives ("Veo" matching any Veo).
        const same = currentModelName.replace(/\s+/g, ' ') === targetModel.replace(/\s+/g, ' ');

        if (!same) {
          logger.info(`Changing model from "${currentModelName}" to "${model}"`);
          await dropdownBtn.click();
          await page.waitForTimeout(1000);

          const modelOption = page.locator('[role="option"], [role="menuitem"], li, button')
            .filter({ hasText: new RegExp(`^${escapeRegExp(model)}$`, 'i') }).first();
          if (await modelOption.isVisible().catch(() => false)) {
            await modelOption.click();
            await page.waitForTimeout(1000);
            logger.info(`Model changed to ${model}`);
            verified.push('model');
          } else {
            failures.push(`model option "${model}" not found`);
            logger.warn(`Model option "${model}" not found in dropdown`);
            // Close the dropdown robustly: Escape until no overlay backdrop blocks.
            for (let i = 0; i < 3; i++) {
              await page.keyboard.press('Escape');
              await page.waitForTimeout(400);
              const blocked = await page.locator('.cdk-overlay-backdrop-showing').first().isVisible().catch(() => false);
              if (!blocked) break;
            }
          }
        } else {
          logger.info(`Model "${model}" already selected (current: "${currentModelName}")`);
          verified.push('model');
        }
      } else {
        failures.push('model dropdown button not found');
        logger.warn('Model dropdown button not found in settings panel');
      }
    }

    // ─── STEP 7: Close settings panel ──────────────────────────────────────
    logger.info('Closing generation settings panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  } else {
    failures.push('settings panel could not be opened');
  }

  if (mode) verified.push('mode');
  const ok = failures.length === 0;
  if (!ok) {
    logger.warn('Generation UI verification failures', { failures, verified });
    if (strict) {
      await takeScreenshot(page, 'configure-ui-mismatch');
      throw new Error(`UI verification failed: ${failures.join('; ')}`);
    }
  }
  return { ok, failures, verified };
}
