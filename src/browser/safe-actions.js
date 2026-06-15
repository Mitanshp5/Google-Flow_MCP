import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { getPage } from './connect.js';

const ACTION_DELAY = get('actionDelayMs', 800);

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe click with pre- and post-delay
 */
export async function safeClick(selector, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay || ACTION_DELAY;
  const postDelay = options.postDelay || ACTION_DELAY;

  await delay(preDelay);
  const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  await element.click();
  await delay(postDelay);
  logger.debug('Clicked element', { selector });
}

/**
 * Safe fill input
 */
export async function safeFill(selector, text, options = {}) {
  const page = getPage();
  const timeout = options.timeout || 10000;
  const preDelay = options.preDelay || ACTION_DELAY;
  const postDelay = options.postDelay || ACTION_DELAY;

  await delay(preDelay);
  const element = await page.waitForSelector(selector, { timeout, state: 'visible' });
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
  const preDelay = options.preDelay || ACTION_DELAY;
  await delay(preDelay);
  await page.keyboard.press(key);
  await delay(ACTION_DELAY);
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
  await page.goto(url, { waitUntil: 'networkidle', timeout });
  await delay(ACTION_DELAY);
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
          visible: !!el.offsetParent,
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
        visible: !!el.offsetParent,
      });
    });

    document.querySelectorAll('a[href]').forEach(el => {
      const text = el.textContent?.trim() || '';
      if (text && text.length < 80) {
        result.links.push({
          text: text.substring(0, 60),
          href: (el.getAttribute('href') || '').substring(0, 100),
          visible: !!el.offsetParent,
        });
      }
    });

    document.querySelectorAll('select, [role="listbox"]').forEach(el => {
      const label = el.getAttribute('aria-label') || el.textContent?.trim() || '';
      result.dropdowns.push({
        label: label.substring(0, 60),
        visible: !!el.offsetParent,
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
  try {
    const result = await page.evaluate(() => {
      // Strategy 1: Look for tab buttons with known IDs containing trigger-IMAGE / trigger-VIDEO
      const imageTab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"], [role="tab"][id*="trigger-IMAGE"]');
      const videoTab = document.querySelector('button[role="tab"][id*="trigger-VIDEO"], [role="tab"][id*="trigger-VIDEO"]');

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
    });
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
  const { mode, ratio, model, quantity, duration } = options;
  const page = getPage();

  logger.info('Configuring generation UI', { mode, ratio, model, quantity, duration });

  // ─── STEP 1: Switch mode (Image vs Video) using the KNOWN tab IDs ─────────
  if (mode) {
    const isImage = mode === 'Image';
    const triggerSuffix = isImage ? 'IMAGE' : 'VIDEO';

    // Primary: use the structured tab IDs
    const modeTab = page.locator(`[role="tab"][id*="trigger-${triggerSuffix}"]`).first();
    const modeTabVisible = await modeTab.isVisible().catch(() => false);

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
        .filter({ hasText: new RegExp(`^${mode}$`, 'i') }).first();
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
  // The panel is opened by clicking the small settings chip/button in the toolbar.
  // It contains ratio tabs, quantity tabs, and possibly a model dropdown.
  // We try multiple selectors since the button text varies by current model.
  let panelOpened = false;

  // Try a dedicated settings button first (gear icon, settings, options)
  const settingsBtnSelectors = [
    'button[aria-label*="settings" i]',
    'button[aria-label*="options" i]',
    'button[aria-label*="generation settings" i]',
    'button[aria-label*="image settings" i]',
    'button[aria-label*="video settings" i]',
  ];

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
    // Fallback: click the model-name chip/button (shows model name + ratio, e.g. "Nano Banana 2")
    // Only match buttons that are clearly part of the generation toolbar, not navigation
    const modelChipSelectors = [
      'button:has-text("Nano Banana")',
      'button:has-text("Imagen")',
      'button:has-text("Veo")',
      'button:has-text("Omni Flash")',
      // Generic: any button in the toolbar containing a known ratio string
      'button:has-text("16:9")',
      'button:has-text("9:16")',
      'button:has-text("1:1")',
      'button:has-text("4:3")',
      'button:has-text("3:4")',
    ];

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
      const ratioTab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${ratio.replace(':', ':')}$`) }).first();
      if (await ratioTab.isVisible().catch(() => false)) {
        const ratioSelected = await ratioTab.getAttribute('aria-selected').catch(() => 'false');
        if (ratioSelected !== 'true') {
          logger.info(`Setting ratio to ${ratio}`);
          await ratioTab.click();
          await page.waitForTimeout(500);
        } else {
          logger.info(`Ratio ${ratio} already selected`);
        }
      } else {
        logger.warn(`Could not find ratio tab for ${ratio}`);
      }
    }

    // ─── STEP 4: Select Duration (video only) ──────────────────────────────
    if (duration && mode === 'Video') {
      // Duration tabs look like "4s", "6s", "8s"
      const durStr = duration.endsWith('s') ? duration : `${duration}s`;
      const durTab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${durStr}$`) }).first();
      if (await durTab.isVisible().catch(() => false)) {
        logger.info(`Setting duration to ${durStr}`);
        await durTab.click();
        await page.waitForTimeout(500);
      } else {
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
        const qtyTab = page.locator('[role="tab"]').filter({ hasText: new RegExp(`^${qtyStr}$`) }).first();
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
          break;
        }
      }
      if (!qtySet) logger.warn(`Could not find quantity tab for quantity ${quantity}`);
    }

    // ─── STEP 6: Select Model via dropdown ─────────────────────────────────
    if (model) {
      // The model dropdown button contains the model name + "arrow_drop_down" icon text
      // We find buttons whose text CONTAINS the drop-down chevron, indicating a dropdown.
      const dropdownBtns = await page.locator('button').all();
      let dropdownBtn = null;
      for (const btn of dropdownBtns) {
        if (!(await btn.isVisible().catch(() => false))) continue;
        const txt = (await btn.textContent().catch(() => '')).trim();
        // A dropdown button contains an arrow glyph or aria hints
        if (txt.includes('arrow_drop_down') || (await btn.getAttribute('aria-haspopup').catch(() => null))) {
          dropdownBtn = btn;
          break;
        }
      }

      if (dropdownBtn) {
        const currentModelName = (await dropdownBtn.textContent().catch(() => ''))
          .replace('arrow_drop_down', '').trim().toLowerCase();
        const targetModel = model.toLowerCase();

        if (!currentModelName.includes(targetModel) && !targetModel.includes(currentModelName)) {
          logger.info(`Changing model from "${currentModelName}" to "${model}"`);
          await dropdownBtn.click();
          await page.waitForTimeout(1000);

          const modelOption = page.locator('[role="option"], [role="menuitem"], li, button')
            .filter({ hasText: new RegExp(model, 'i') }).first();
          if (await modelOption.isVisible().catch(() => false)) {
            await modelOption.click();
            await page.waitForTimeout(1000);
            logger.info(`Model changed to ${model}`);
          } else {
            logger.warn(`Model option "${model}" not found in dropdown`);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
          }
        } else {
          logger.info(`Model "${model}" already selected (current: "${currentModelName}")`);
        }
      } else {
        logger.warn('Model dropdown button not found in settings panel');
      }
    }

    // ─── STEP 7: Close settings panel ──────────────────────────────────────
    logger.info('Closing generation settings panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }
}
