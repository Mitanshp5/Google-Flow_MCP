import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { get } from '../utils/config.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import fs from 'fs';
import path from 'path';

const PROJECTS_FILE = path.resolve(get('flowHome', '.'), 'config', 'flow.projects.json');

// Session-level project ID extracted from the URL (/project/{id}).
// Persists across all tool calls in this MCP session so every generation
// goes into the same project without creating a new one each time.
let _sessionProjectId = null;
let _sessionProjectName = null;

export function extractProjectId(url) {
  const m = url.match(/\/project\/([^/?#]+)/);
  return m ? m[1] : null;
}

export function buildProjectUrl(baseUrl, projectId) {
  // baseUrl like https://labs.google/fx/tools/flow
  // project URL like https://labs.google/fx/tools/flow/project/{id}
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/project/${projectId}`;
}

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
    }
  } catch (e) {
    logger.warn('Could not load projects file', { error: e.message });
  }
  return { projects: [] };
}

function saveProjects(data) {
  const dir = path.dirname(PROJECTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

/**
 * List existing projects visible on the Flow homepage by scanning project cards.
 * Returns array of { name, url, fullText }.
 */
export async function listExistingProjects(page) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/tools/flow');

  // Navigate to the main Flow page if we're not there, or if we're INSIDE a project
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  logger.info('Scanning for existing projects...');

  // Try to find project cards — they have edit/delete action buttons
  const projects = await page.evaluate(() => {
    const result = [];
    // Look for elements that contain Edit/Delete buttons (project cards)
    const allCards = document.querySelectorAll(
      '[class*="card"], [class*="project"], li, article, [class*="grid"] > div'
    );
    allCards.forEach(card => {
      const text = (card.textContent || '').trim();
      const hasEditDelete = text.includes('Edit') || text.includes('Delete');
      if (hasEditDelete && text.length > 5 && text.length < 500) {
        // Extract project name (anything that's not edit/delete button text)
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
        const nameLines = lines.filter(l =>
          !l.includes('Edit') && !l.includes('Delete') &&
          !l.includes('edit') && !l.includes('delete') &&
          l.length > 1
        );
        result.push({
          name: nameLines.join(' | ') || 'Untitled project',
          fullText: text.substring(0, 300),
        });
      }
    });
    return result;
  });

  logger.info('Existing projects found', { count: projects.length });
  return projects;
}

/**
 * Rename the current project by clicking its title on the top-left of the page.
 * Google Flow shows the project name as a clickable heading — clicking it makes
 * it editable in-place (or opens a small rename input).
 *
 * Strategy A: click the title element directly → select-all → type new name → Enter
 * Strategy B: click the ⋮ more-options menu → click Rename → fill input → Enter
 */
export async function renameCurrentProject(page, newName) {
  if (!newName) return false;
  logger.info('Renaming project...', { newName });

  // --- Strategy A: ⋮ more-options menu (top-left header) → Rename ---
  // The project header looks like: "← <project name>          ⋮  ... PRO avatar"
  // The "⋮" (more_vert) button opens a menu with a "Rename" option.
  try {
    const moreMenuSelectors = [
      'button:has-text("more_vert")',
      'button[aria-label*="more" i]',
      'button[aria-label*="options" i]',
      '[class*="more-options"] button',
      'button:has([data-icon="more_vert"])',
    ];

    let menuOpened = false;
    for (const sel of moreMenuSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
        menuOpened = true;
        logger.info('Opened project ⋮ menu', { selector: sel });
        break;
      }
    }

    if (menuOpened) {
      const renameOption = page.locator(
        '[role="menuitem"]:has-text("Rename"), ' +
        'button:has-text("Rename"), ' +
        'li:has-text("Rename")'
      ).first();

      if (await renameOption.isVisible().catch(() => false)) {
        await renameOption.click();
        await page.waitForTimeout(500);

        // After clicking Rename, either a dialog input appears, or the
        // header title itself becomes an editable/focused field.
        const input = page.locator(
          'input:focus, [contenteditable]:focus, dialog input, input[type="text"]:visible'
        ).first();

        if (await input.isVisible().catch(() => false)) {
          await page.keyboard.press('Control+a');
          await page.keyboard.type(newName, { delay: 30 });
          await page.keyboard.press('Enter');
          await page.waitForTimeout(800);
          logger.info('Project renamed via ⋮ menu', { newName });
          return true;
        }

        await takeScreenshot(page, 'rename-no-input-after-menu');
      } else {
        // Close the menu if "Rename" wasn't found in it
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }
  } catch { /* fall through to Strategy B */ }

  // --- Strategy B: click the top-left project title directly (in-place edit) ---
  const titleSelectors = [
    'h1[contenteditable]',
    'h2[contenteditable]',
    '[data-testid*="project-title"]',
    '[data-testid*="projectTitle"]',
    '[aria-label*="project name"]',
    '[class*="project-name"]',
    '[class*="projectName"]',
    '[class*="project_name"]',
  ];

  for (const sel of titleSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      // Triple-click selects all existing text in the element
      await el.click({ clickCount: 3 });
      await page.waitForTimeout(500);

      // Some UIs swap the heading for a focused <input> after click
      const activeInput = page.locator('input:focus, [contenteditable]:focus').first();
      const target = (await activeInput.isVisible().catch(() => false)) ? activeInput : el;
      void target;

      await page.keyboard.press('Control+a');
      await page.waitForTimeout(100);
      await page.keyboard.type(newName, { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      logger.info('Project renamed via title click', { newName, selector: sel });
      return true;
    } catch { /* try next */ }
  }

  await takeScreenshot(page, 'rename-project-failed');
  logger.warn('Could not rename project — no matching ⋮ menu or title element found');
  return false;
}

/**
 * Create a new project: click "New project", optionally name it,
 * wait for the project page to load, store in local registry.
 * Returns { url, id, name }.
 */
export async function createNewProject(page, name) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/tools/flow');

  // Ensure we're on the main Flow page (not inside a project)
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  logger.info('Creating new project...');

  // Click "New project"
  const newBtnSelectors = [
    'button:has-text("New project")',
    'a:has-text("New project")',
    '[aria-label*="New project"]',
  ];

  let clicked = false;
  for (const sel of newBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    } catch { /* continue */ }
  }

  if (!clicked) {
    // Fallback: try to find any "add" or "new" button
    const fallback = page.locator('[aria-label*="add"], button:has-text("add"), [class*="fab"]').first();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click();
    } else {
      await takeScreenshot(page, 'no-new-project-btn');
      throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
        'Could not find "New project" button on the Flow page');
    }
  }

  await page.waitForTimeout(4000);

  const projectUrl = page.url();
  logger.info('New project created', { url: projectUrl });

  let finalUrl = page.url();

  // If we're not inside a project (no /project/ in URL), click the project card
  if (!finalUrl.includes('/project/')) {
    logger.info('Not inside project page, clicking project card to enter...');
    await page.waitForTimeout(2000);

    // Find all project links, click the newest (first in DOM order)
    const cardClicked = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/project/"]');
      if (links.length > 0) {
        const link = links[0]; // newest project = first in order
        const href = link.getAttribute('href');
        if (href) {
          window.location.href = href.startsWith('http') ? href : 'https://labs.google' + href;
          return true;
        }
      }
      return false;
    });

    if (cardClicked) {
      await page.waitForTimeout(3000);
      finalUrl = page.url();
      logger.info('Navigated into project', { url: finalUrl });
    } else {
      // Fallback: try clicking via Playwright
      const projectLink = page.locator('a[href*="/project/"]').first();
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click();
        await page.waitForTimeout(3000);
        finalUrl = page.url();
        logger.info('Navigated into project via click', { url: finalUrl });
      } else {
        await takeScreenshot(page, 'no-project-links');
        throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
          'Could not find project card to navigate into. ' +
          'The project was created but no card link was found.');
      }
    }
  }

  // Rename the project via the top-left title element (if a name was requested)
  if (name) {
    await renameCurrentProject(page, name);
  }

  // Store in local registry
  const store = loadProjects();
  const entry = {
    id: `proj_${Date.now()}`,
    url: finalUrl,
    name: name || `Project ${new Date().toLocaleDateString('en-US')}`,
    created_at: new Date().toISOString(),
    last_used: new Date().toISOString(),
    tasks: [],
  };
  store.projects.push(entry);
  saveProjects(store);

  await takeScreenshot(page, 'new-project');

  return { url: finalUrl, id: entry.id, name: entry.name };
}

/**
 * Ensure we are inside a project context.
 * Rules:
 * 1. If already in a project → reuse it
 * 2. If context.campaign matches a stored project → reopen that project
 * 3. If context.forceNew → always create new
 * 4. Otherwise → create new project
 *
 * context = { campaign, name, forceNew }
 * Returns { url, reused, id, name }
 */
export async function ensureProjectInContext(page, context = {}) {
  const flowUrl = get('flowUrl', 'https://labs.google/fx/tools/flow');
  const currentUrl = page.url();

  // If a name was requested and differs from what we last set for this
  // session's project, (re)apply it via renameCurrentProject.
  const maybeApplyName = async (id) => {
    if (context.name && context.name !== _sessionProjectName) {
      const renamed = await renameCurrentProject(page, context.name);
      if (renamed) {
        _sessionProjectName = context.name;
        const store = loadProjects();
        const entry = store.projects.find(p => extractProjectId(p.url) === id);
        if (entry) {
          entry.name = context.name;
          saveProjects(store);
        }
      }
    }
  };

  // Already inside a project? Record its ID and reuse.
  if (currentUrl.includes('/project/')) {
    const id = extractProjectId(currentUrl);
    if (id) _sessionProjectId = id;
    logger.info('Already in a project — reusing', { url: currentUrl, projectId: id });
    await maybeApplyName(id);
    return { url: page.url(), reused: true, projectId: id };
  }

  if (!context.forceNew) {
    // Reuse the session project by navigating directly to its URL via ID
    if (_sessionProjectId) {
      const targetUrl = buildProjectUrl(flowUrl, _sessionProjectId);
      logger.info('Resuming session project by ID', { projectId: _sessionProjectId, url: targetUrl });
      try {
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        if (extractProjectId(page.url()) === _sessionProjectId) {
          await maybeApplyName(_sessionProjectId);
          return { url: page.url(), reused: true, projectId: _sessionProjectId };
        }
      } catch (e) {
        logger.warn('Session project no longer reachable, will create new', { error: e.message });
      }
      _sessionProjectId = null;
      _sessionProjectName = null;
    }

    // Try campaign history
    const store = loadProjects();
    if (context.campaign) {
      const match = store.projects.find(p =>
        p.campaign && p.campaign.toLowerCase() === context.campaign.toLowerCase()
      );
      if (match) {
        logger.info('Found matching project from history', {
          campaign: context.campaign, name: match.name, url: match.url,
        });
        await page.goto(match.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
        match.last_used = new Date().toISOString();
        saveProjects(store);
        _sessionProjectId = extractProjectId(match.url);
        _sessionProjectName = match.name;
        await maybeApplyName(_sessionProjectId);
        return { url: match.url, reused: true, id: match.id, name: match.name };
      }
    }
  }

  // Create new project and record its ID + name
  const result = await createNewProject(page, context.name);
  _sessionProjectId = extractProjectId(result.url);
  _sessionProjectName = result.name;
  logger.info('New project created, session ID set', { projectId: _sessionProjectId });
  return result;
}

/**
 * Navigate to a section in the current project's sidebar.
 * sections: "Characters", "Scenes", "Tools", "Trash"
 * Returns true if navigation succeeded, false otherwise.
 */
export async function navigateToSidebar(page, section) {
  logger.info('Navigating to sidebar section', { section });

  const selectors = [
    `[class*="sidebar"] button:has-text("${section}")`,
    `[class*="sidebar"] a:has-text("${section}")`,
    `nav button:has-text("${section}")`,
    `nav a:has-text("${section}")`,
    `[class*="nav"] button:has-text("${section}")`,
    `[class*="nav"] a:has-text("${section}")`,
    `button:has-text("${section}")`,
    `a:has-text("${section}")`,
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(1500);
        logger.info('Sidebar navigation done', { section, selector });
        return true;
      }
    } catch { /* try next */ }
  }

  // Fallback: detect all buttons and log them
  logger.warn('Sidebar section not found via selectors', { section });
  const elements = await detectPageElements(page);
  await takeScreenshot(page, `sidebar-${section}-not-found`);
  logger.info('Available buttons on page', {
    buttons: elements.buttons.map(b => b.text).filter(Boolean),
  });

  return false;
}

/**
 * Get the current page elements and detect the active sidebar section.
 * Returns the section that appears to be active, or null.
 */
export async function getActiveSidebarSection(page) {
  try {
    const section = await page.evaluate(() => {
      const active = document.querySelector(
        '[class*="sidebar"] [class*="active"], [class*="sidebar"] [aria-current="page"], nav [class*="active"]'
      );
      if (active) {
        return (active.textContent || '').trim();
      }
      return null;
    });
    return section;
  } catch {
    return null;
  }
}

/**
 * Store task metadata in the project registry after completing a task.
 */
export function registerTaskInProject(projectId, taskInfo) {
  if (!projectId) return;
  const store = loadProjects();
  const proj = store.projects.find(p => p.id === projectId);
  if (proj) {
    proj.tasks.push({
      ...taskInfo,
      timestamp: new Date().toISOString(),
    });
    proj.last_used = new Date().toISOString();
    saveProjects(store);
  }
}

/**
 * Get a human-readable description of the current project context
 * for use in tool responses.
 */
export async function getProjectContextInfo(page) {
  const url = page.url();
  const inProject = url.includes('/project/');
  let section = null;
  if (inProject) {
    section = await getActiveSidebarSection(page);
  }
  return {
    inProject,
    url,
    activeSection: section,
    projectId: inProject ? url.split('/project/')[1]?.split('/')[0] || url.split('/project/')[1] : null,
  };
}

/**
 * Switch the project's bottom toolbar from Video mode to Image mode.
 * 
 * The Flow UI has TWO levels:
 *   1. Content-type tabs: "Image" | "Video" | "Ingredients" (role="tab")
 *   2. Within Video tab: a dropdown for duration (6s) and ratio (x2)
 * 
 * We click the Image tab directly to switch to Image mode.
 * The Image tab has role="tab" and id ending in "-trigger-IMAGE".
 */
export async function switchToImageMode(page) {
  logger.info('Checking current generation mode...');

  const currentImageTab = await page.evaluate(() => {
    const imageTab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
    if (imageTab) return imageTab.getAttribute('aria-selected');
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.includes('Image') && b.offsetParent !== null);
    return btn ? btn.textContent.trim().substring(0, 20) : null;
  }).catch(() => null);

  if (currentImageTab === 'true') {
    logger.info('Already in Image mode');
    return true;
  }

  const imageTab = page.locator('button[role="tab"][id*="trigger-IMAGE"]').first();
  if (await imageTab.isVisible().catch(() => false)) {
    logger.info('Clicking Image tab to switch to Image mode');

    const isDisabled = await imageTab.getAttribute('aria-disabled').catch(() => null);
    if (isDisabled === 'true') {
      logger.warn('Image tab is disabled');
    } else {
      await imageTab.click();
      await page.waitForTimeout(2000);

      const verifyImage = await page.evaluate(() => {
        const tab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
        return tab ? tab.getAttribute('aria-selected') : 'not-found';
      }).catch(() => 'error');

      if (verifyImage === 'true') {
        logger.info('Successfully switched to Image mode');
        return true;
      }

      logger.warn('First click did not switch, retrying...');
      await imageTab.click();
      await page.waitForTimeout(2000);

      const verifyAgain = await page.evaluate(() => {
        const tab = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
        return tab ? tab.getAttribute('aria-selected') : 'not-found';
      }).catch(() => 'error');

      if (verifyAgain === 'true') {
        logger.info('Switched to Image mode on retry');
        return true;
      }
    }
  }

  logger.info('Trying Video dropdown fallback...');
  const videoButton = page.locator('button:has-text("Video")').first();
  if (await videoButton.isVisible().catch(() => false)) {
    await videoButton.click();
    await page.waitForTimeout(1500);

    const imgOption = page.locator('[role="menuitem"]:has-text("Image"), [id*="trigger-IMAGE"]').first();
    if (await imgOption.isVisible().catch(() => false)) {
      await imgOption.click();
      await page.waitForTimeout(1500);
      logger.info('Switched to Image mode via dropdown');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const vf = await page.evaluate(() => {
        const t = document.querySelector('button[role="tab"][id*="trigger-IMAGE"]');
        return t ? t.getAttribute('aria-selected') : null;
      }).catch(() => null);

      if (vf === 'true') {
        return true;
      }
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await takeScreenshot(page, 'switch-to-image-mode-failed');
  throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,
    'Could not switch to Image mode. The Video mode button was not found or ' +
    'the Image option is missing. Generation cancelled to avoid an accidental ' +
    'paid video generation. Please check the Google Flow UI manually.');

}
