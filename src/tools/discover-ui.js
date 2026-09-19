import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import fs from 'fs';
import path from 'path';
import { getFlowHome, get } from '../utils/config.js';
import { assertFlowUrl } from '../utils/sanitize.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl, navigateToSidebar } from '../navigation/project-navigator.js';

function selectorsPath() {
  return path.join(getFlowHome(), 'config', 'selectors.map.json');
}

function loadSelectors() {
  try {
    return JSON.parse(fs.readFileSync(selectorsPath(), 'utf-8'));
  } catch {
    return {
      _description: 'UI selectors map for Google Flow',
      _lastUpdated: null,
      main: { url: null, selectors: {} },
      imageGeneration: { selectors: {} },
      videoGeneration: { selectors: {} },
      characters: { url: null, selectors: {} },
      scenes: { url: null, selectors: {} },
      toolsGallery: { url: null, selectors: {} },
      gridArchitect: { url: null, selectors: {} },
    };
  }
}

function saveSelectors(map) {
  map._lastUpdated = new Date().toISOString();
  fs.writeFileSync(selectorsPath(), JSON.stringify(map, null, 2));
  logger.info('Selectors map saved');
}

// "characters" is NOT a standalone page — it only exists scoped to a project:
// {flowBase}/project/{projectId}/characters
// Resolved at runtime in handleDiscoverUi via ensureProjectInContext.
const PROJECT_SUBROUTE_PAGES = ['characters'];

// "scenes" (and "images"/"all-media") are NOT separate routes — they are
// sidebar tabs within the project's main page (same URL, no suffix).
// Resolved by navigating to the project then clicking the matching tab.
const PROJECT_TAB_PAGES = {
  scenes: 'Scenes',
  images: 'Images',
  'all-media': 'All Media',
};

function flowBase() {
  return get('flowUrl', 'https://flow.google.com/').replace(/\/+$/, '');
}

const PAGES = {
  get main() { return flowBase() + '/'; },
  get toolsGallery() { return flowBase() + '/tools?tab=GALLERY'; },
  get gridArchitect() { return flowBase() + '/tools/grid-architect'; },
  get imageGeneration() { return flowBase() + '/'; },
  get videoGeneration() { return flowBase() + '/'; },
};

const PAGE_SELECTOR_KEYS = {
  main: 'main',
  characters: 'characters',
  scenes: 'scenes',
  'tools-gallery': 'toolsGallery',
  'tools gallery': 'toolsGallery',
  grid: 'gridArchitect',
  'grid-architect': 'gridArchitect',
  image: 'imageGeneration',
  video: 'videoGeneration',
};

function getPageKey(pageName) {
  const lower = (pageName || '').toLowerCase().trim();
  return PAGE_SELECTOR_KEYS[lower] || lower;
}

export async function handleDiscoverUi(args) {
  // Validate user-supplied URL BEFORE touching the browser so SSRF is rejected
  // with UNSUPPORTED_URL even when disconnected (fail fast, correct code).
  let url = args.url ? assertFlowUrl(args.url) : null;
  let page = getPage();
  const pageName = args.page || 'main';
  const pageKey = getPageKey(pageName);

  let tabToClick = null;

  if (!url) {
    if (PROJECT_SUBROUTE_PAGES.includes(pageKey)) {
      const project = await ensureProjectInContext(page, {
        name: args.project_name,
        campaign: args.campaign,
      });
      const projectId = extractProjectId(project.url);
      url = projectId
        ? `${buildProjectUrl(get('flowUrl', 'https://flow.google.com/'), projectId)}/${pageKey}`
        : project.url;
    } else if (PROJECT_TAB_PAGES[pageKey]) {
      const project = await ensureProjectInContext(page, {
        name: args.project_name,
        campaign: args.campaign,
      });
      url = project.url;
      tabToClick = PROJECT_TAB_PAGES[pageKey];
    } else {
      url = PAGES[pageKey] || PAGES.main;
    }
  }

  logger.info('Discovering UI', { page: pageName, pageKey, url: url?.substring(0, 80), tabToClick });

  try {
    // Navigate to the page
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // For sidebar-tab pages (Scenes/Images/All Media), click the tab —
    // these don't have their own URL, just a client-side state change.
    if (tabToClick) {
      await navigateToSidebar(page, tabToClick);
      await page.waitForTimeout(1500);
    }

    const currentUrl = page.url();
    const title = await page.title();

    // Take full page screenshot
    const screenshotPath = await takeScreenshot(page, `discover-${sanitizeFileName(pageName)}`);

    // Extract visible text content
    const visibleText = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      const texts = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) {
          texts.push(text);
        }
      }
      return [...new Set(texts)].slice(0, 200);
    });

    // Detect all interactive elements
    const elements = await detectPageElements();

    // Extract specifically model-related text
    const modelNames = visibleText.filter(t =>
      t.includes('Nano') || t.includes('Imagen') || t.includes('Veo') || t.includes('Omni') ||
      t.includes('Model')
    );

    // Extract ratio-related text
    const ratioTexts = visibleText.filter(t =>
      t.includes(':') && (t.includes('9') || t.includes('4') || t.includes('3') || t.includes('1'))
    );

    // Update selectors map
    const selectorsMap = loadSelectors();
    selectorsMap[pageKey] = {
      url: currentUrl,
      title,
      discoveredAt: new Date().toISOString(),
      selectors: {
        buttons: elements.buttons,
        inputs: elements.inputs,
        links: elements.links,
        headings: elements.headings,
        modelTexts: modelNames,
        ratioTexts: ratioTexts,
      },
    };
    saveSelectors(selectorsMap);

    return {
      status: 'discovered',
      page: pageName,
      pageKey,
      url: currentUrl,
      title,
      screenshot: screenshotPath,
      elements: {
        buttons: elements.buttons.map(b => b.text).filter(Boolean),
        inputs: elements.inputs.map(i => i.placeholder || i.ariaLabel || i.name).filter(Boolean),
        headings: elements.headings.map(h => `${h.level}: ${h.text}`),
        visible_models: modelNames,
        visible_ratios: ratioTexts,
      },
      totalButtonsFound: elements.buttons.length,
      totalInputsFound: elements.inputs.length,
    };
  } catch (err) {
    await takeScreenshot(page, `discover-error-${sanitizeFileName(pageName)}`);
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      `UI discovery failed for ${pageName}: ${err.message}`
    );
  }
}
