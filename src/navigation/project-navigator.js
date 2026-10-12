import { logger } from '../utils/logger.js';
import { get, getFlowHome } from '../utils/config.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements, pressSelectAll } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { assertFlowUrl } from '../utils/sanitize.js';
import { normalizeSidebarLabel } from '../browser/page-adapter.js';
import { classifyAppState, isGuessedRoute } from '../browser/app-state.js';
import { getUiLease } from '../browser/ui-transaction.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function projectsFile() {
  return path.resolve(getFlowHome(), 'config', 'flow.projects.json');
}

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
  // baseUrl like https://flow.google.com/ (legacy https://labs.google/fx/tools/flow)
  // project URL like {base}/project/{id}
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/project/${projectId}`;
}

// W02 F08: in-place reuse helpers. Same project/campaign inspection must not
// reload the page (which wipes the prepared composer).
export function isSameProjectTarget(currentUrl, targetUrlOrId) {
  if (!currentUrl || !targetUrlOrId) return false;
  const currentId = extractProjectId(String(currentUrl));
  if (!currentId) return false;
  const target = String(targetUrlOrId);
  const targetId = target.includes('/project/') ? extractProjectId(target) : target;
  return !!targetId && currentId === targetId;
}

export function shouldReloadProject(currentUrl, requested = {}) {
  // Explicit project_url targeting the page we are already on -> no reload.
  if (requested.project_url && isSameProjectTarget(currentUrl, requested.project_url)) return false;
  // Session-resume id targeting the page we are already on -> no reload.
  if (requested.sessionProjectId && isSameProjectTarget(currentUrl, requested.sessionProjectId)) return false;
  // Campaign/name matches are resolved to URLs by the caller; default reload.
  return true;
}

export function loadProjects() {
  try {
    const f = projectsFile();
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf-8'));
    }
  } catch (e) {
    logger.warn('Could not load projects file', { error: e.message });
  }
  return { projects: [] };
}

export function saveProjects(data) {
  const file = projectsFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp + rename avoids corrupting registry on crash/concurrent write.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * List existing projects visible on the Flow homepage by scanning project cards.
 * Returns array of { name, url, fullText }.
 */
export async function listExistingProjects(page) {
  const flowUrl = get('flowUrl', 'https://flow.google.com/');

  // Navigate to the main Flow page if we're not there, or if we're INSIDE a project
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
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
export const RENAME_BUDGET_MS = 12000;

// W02 F14: bounded verified rename states. The actual project ID is always
// preserved; a failed/pending rename never creates a duplicate project.
export function classifyRenameResult({ attempted, verified, projectId, name, elapsedMs = 0 } = {}) {
  if (!name || attempted === false) {
    return { state: 'failed', projectId: projectId || null, name: name || null, verified: false, duplicateCreated: false, elapsedMs };
  }
  if (verified) {
    return { state: 'renamed', projectId: projectId || null, name, verified: true, duplicateCreated: false, elapsedMs };
  }
  // Attempted but unverified: pending when budget remains, else failed.
  const state = elapsedMs < RENAME_BUDGET_MS ? 'pending' : 'failed';
  return { state, projectId: projectId || null, name, verified: false, duplicateCreated: false, elapsedMs };
}

// W02 detailed rename for W06: bounded, hydration-aware, read-back verified.
export async function renameProjectVerified(page, newName, opts = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const budgetMs = opts.budgetMs ?? RENAME_BUDGET_MS;
  const projectId = (() => { try { return extractProjectId(page.url()); } catch { return null; } })();
  if (!newName) return classifyRenameResult({ attempted: false, verified: false, projectId, name: newName, elapsedMs: elapsed() });
  const attempted = await renameCurrentProjectInner(page, newName, budgetMs, started);
  let verified = false;
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
    verified = attempted && String(bodyText || '').includes(newName);
  } catch { verified = false; }
  return classifyRenameResult({ attempted, verified, projectId, name: newName, elapsedMs: elapsed() });
}

async function renameCurrentProjectInner(page, newName, budgetMs, started) {
  const remaining = () => budgetMs - (Date.now() - started);
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
      if (remaining() <= 0) break;
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
          await pressSelectAll(page);
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
  } catch (e) {
    logger.debug('Project ⋮-menu rename failed, trying title click', { error: e.message });
  }

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
    if (remaining() <= 0) break;
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;

      // Triple-click selects all existing text in the element
      await el.click({ clickCount: 3 });
      await page.waitForTimeout(500);

      // Some UIs swap the heading for a focused <input> after click
      const activeInput = page.locator('input:focus, [contenteditable]:focus').first();
      if (await activeInput.isVisible().catch(() => false)) {
        await pressSelectAll(page);
        await page.waitForTimeout(100);
        await page.keyboard.type(newName, { delay: 30 });
      } else {
        await pressSelectAll(page);
        await page.waitForTimeout(100);
        await page.keyboard.type(newName, { delay: 30 });
      }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);

      logger.info('Project renamed via title click', { newName, selector: sel });
      return true;
    } catch (e) { logger.debug('Title rename attempt failed', { selector: sel, error: e.message }); }
  }

  await takeScreenshot(page, 'rename-project-failed');
  logger.warn('Could not rename project — no matching ⋮ menu or title element found');
  return false;
}

export async function renameCurrentProject(page, newName) {
  if (!newName) return false;
  const deadline = Date.now() + RENAME_BUDGET_MS;
  const started = Date.now();
  const ok = await renameCurrentProjectInner(page, newName, RENAME_BUDGET_MS, started);
  if (Date.now() > deadline) logger.warn('Rename hit bounded budget', { budgetMs: RENAME_BUDGET_MS });
  void deadline;
  return ok;
}

/**
 * Create a new project: click "New project", optionally name it,
 * wait for the project page to load, store in local registry.
 * Returns { url, id, name }.
 */
export async function createNewProject(page, name, campaign) {
  const flowUrl = get('flowUrl', 'https://flow.google.com/');

  // Ensure we're on the main Flow page (not inside a project)
  const currentUrl = page.url();
  if (!currentUrl.includes(flowUrl) || currentUrl.includes('/project/')) {
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
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
          window.location.href = href.startsWith('http') ? href : 'https://flow.google.com' + href;
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

  // Store in local registry (include campaign so campaign-history lookup hits;
  // use crypto id to avoid Date.now() collisions)
  const store = loadProjects();
  const entry = {
    id: `proj_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    url: finalUrl,
    urlProjectId: extractProjectId(finalUrl),
    name: name || `Project ${new Date().toLocaleDateString('en-US')}`,
    campaign: campaign || null,
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
  const flowUrl = get('flowUrl', 'https://flow.google.com/');
  const currentUrl = page.url();
  // NAME MEMORY: a project is renamed as soon as work starts in it.
  // campaign doubles as the name when no explicit name is given, so every
  // run lands in (and remembers) a meaningfully named project.
  const effectiveName = context.name || context.campaign || null;

  // If a name was requested and differs from what we last set for this
  // session's project, (re)apply it via renameCurrentProject + READ BACK.
  const maybeApplyName = async (id) => {
    const want = effectiveName;
    if (want && want !== _sessionProjectName) {
      // Adopt without UI clicks when the page already shows the name.
      const already = await page.evaluate(
        (n) => (document.body?.innerText || '').includes(n), want
      ).catch(() => false);
      if (already) {
        _sessionProjectName = want;
        const store = loadProjects();
        const entry = store.projects.find(p => extractProjectId(p.url) === id);
        if (entry && entry.name !== want) {
          entry.name = want;
          saveProjects(store);
        }
        logger.info('Project name already showing — adopted into memory', { name: want });
        return;
      }
      const renamed = await renameCurrentProject(page, want);
      // Verify the new name actually appears in the UI.
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
      const verified = renamed && bodyText.includes(want);
      if (verified) {
        _sessionProjectName = want;
        const store = loadProjects();
        const entry = store.projects.find(p => extractProjectId(p.url) === id);
        if (entry) {
          entry.name = want;
          saveProjects(store);
        }
      } else {
        logger.warn('Project rename unverified by read-back', { name: want });
      }
    }
  };

  // Direct URL jump: project_url (must be a Flow /project/ URL) always wins.
  // Used to repair misnamed projects or target one registry duplicates confuse.
  // W02 F08: already on the requested project -> reuse in place, no reload.
  if (context.project_url && context.project_url.includes('/project/')) {
    const target = assertFlowUrl(context.project_url);
    if (!shouldReloadProject(currentUrl, { project_url: target })) {
      logger.info('Already on requested project — reusing in place (no reload)', { url: currentUrl });
      _sessionProjectId = extractProjectId(currentUrl);
      touchProject(_sessionProjectId);
      await maybeApplyName(_sessionProjectId);
      return { url: currentUrl, reused: true, projectId: _sessionProjectId };
    }
    logger.info('Navigating directly to project URL', { url: target });
    if (!(await gotoProject(page, target, 'direct-url'))) {
      throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND,
        `Could not open project page: ${target}. Check the URL and connection.`);
    }
    _sessionProjectId = extractProjectId(page.url());
    _sessionProjectName = null; // force maybeApplyName below to (re)name
    touchProject(_sessionProjectId);
    await maybeApplyName(_sessionProjectId);
    return { url: page.url(), reused: true, projectId: _sessionProjectId };
  }

  // Already inside a project? Reuse it — BUT if the caller named a specific
  // project and we are in a DIFFERENT one, navigate to the named project
  // instead of renaming the current one (renaming here caused duplicate names).
  if (currentUrl.includes('/project/') && !context.forceNew && !context.campaign) {
    const id = extractProjectId(currentUrl);
    if (effectiveName) {
      const store = loadProjects();
      const named = store.projects.find(p =>
        (p.name || '').toLowerCase() === effectiveName.toLowerCase()
      );
      const namedId = named ? (extractProjectId(named.url || '') || named.urlProjectId) : null;
      if (named && namedId && namedId !== id) {
        logger.info('In a different project than named — navigating to named project', {
          current: id, named: namedId, name: effectiveName,
        });
        if (!(await gotoProject(page, named.url, 'already-inside-redirect'))) {
          logger.warn('Named project unreachable; staying in current project', { name: effectiveName });
          if (id) _sessionProjectId = id;
          return { url: page.url(), reused: true, projectId: id };
        }
        _sessionProjectId = extractProjectId(page.url()) || namedId;
        _sessionProjectName = named.name;
        touchProject(_sessionProjectId);
        return { url: page.url(), reused: true, id: named.id, name: named.name };
      }
    }
    if (id) _sessionProjectId = id;
    logger.info('Already in a project — reusing', { url: currentUrl, projectId: id });
    await maybeApplyName(id);
    return { url: page.url(), reused: true, projectId: id };
  }

  if (!context.forceNew) {
    // Reuse the session project by navigating directly to its URL via ID
    // W02 F08: same-project session resume reuses in place without reload.
    if (_sessionProjectId) {
      if (isSameProjectTarget(currentUrl, _sessionProjectId)) {
        logger.info('Session project already targeted — reusing in place (no reload)', { projectId: _sessionProjectId });
        touchProject(_sessionProjectId);
        await maybeApplyName(_sessionProjectId);
        return { url: currentUrl, reused: true, projectId: _sessionProjectId };
      }
      const targetUrl = buildProjectUrl(flowUrl, _sessionProjectId);
      logger.info('Resuming session project by ID', { projectId: _sessionProjectId, url: targetUrl });
      if (await gotoProject(page, targetUrl, 'session-resume')) {
        if (extractProjectId(page.url()) === _sessionProjectId) {
          touchProject(_sessionProjectId);
          await maybeApplyName(_sessionProjectId);
          return { url: page.url(), reused: true, projectId: _sessionProjectId };
        }
      } else {
        logger.warn('Session project no longer reachable, will create new');
      }
      _sessionProjectId = null;
      _sessionProjectName = null;
    }

    const store = loadProjects();
    // Name match: a requested name that already exists reopens that project
    // instead of creating a duplicate (this is the project-name memory).
    if (effectiveName) {
      const named = store.projects.find(p =>
        (p.name || '').toLowerCase() === effectiveName.toLowerCase()
      );
      if (named) {
        logger.info('Reopening remembered project by name', { name: effectiveName, url: named.url });
        if (!(await gotoProject(page, named.url, 'name-match'))) {
          logger.warn('Named project unreachable, continuing to other options', { name: effectiveName });
        } else {
          _sessionProjectId = extractProjectId(page.url()) || extractProjectId(named.url);
          _sessionProjectName = named.name;
          touchProject(_sessionProjectId);
          return { url: page.url(), reused: true, id: named.id, name: named.name };
        }
      }
    }
    if (context.campaign) {
      const match = store.projects.find(p =>
        p.campaign && p.campaign.toLowerCase() === context.campaign.toLowerCase()
      );
      if (match) {
        logger.info('Found matching project from history', {
          campaign: context.campaign, name: match.name, url: match.url,
        });
        if (!(await gotoProject(page, match.url, 'campaign-match'))) {
          logger.warn('Campaign project unreachable, continuing', { campaign: context.campaign });
        } else {
          match.last_used = new Date().toISOString();
          saveProjects(store);
          _sessionProjectId = extractProjectId(match.url);
          _sessionProjectName = match.name;
          await maybeApplyName(_sessionProjectId);
          return { url: match.url, reused: true, id: match.id, name: match.name };
        }
      }
    }

    // MRU fallback: a fresh server process has no session memory, but the
    // registry does — reopen the most recently used project instead of
    // minting a duplicate "Project <date>" every session.
    const mru = [...store.projects].sort((a, b) =>
      new Date(b.last_used || b.created_at || 0) - new Date(a.last_used || a.created_at || 0)
    )[0];
    if (mru?.url) {
      logger.info('Reopening most-recently-used project (no session/campaign match)', {
        name: mru.name, url: mru.url,
      });
      if (await gotoProject(page, mru.url, 'mru-fallback')) {
        _sessionProjectId = extractProjectId(page.url());
        _sessionProjectName = mru.name;
        touchProject(_sessionProjectId);
        await maybeApplyName(_sessionProjectId);
        return { url: page.url(), reused: true, id: mru.id, name: mru.name };
      }
      logger.warn('MRU project unreachable or shell-less, will create new', { url: mru.url });
    }
  }

  // Create new project and record its ID + name (named from the start —
  // never "Untitled" when the caller gave us a name or campaign).
  const result = await createNewProject(page, effectiveName, context.campaign);
  _sessionProjectId = extractProjectId(result.url);
  _sessionProjectName = result.name;
  logger.info('New project created, session ID set', { projectId: _sessionProjectId });
  return result;
}

/**
 * Wait for the Flow project app shell to hydrate after navigation.
 * domcontentloaded + body is NOT enough: the editor (prompt box, sidebar,
 * toolbar) renders seconds later, especially in media-heavy projects.
 * Returns true when shell markers appear, false on timeout (caller fails fast
 * with a screenshot instead of cascading into selector misses).
 */
export async function waitForProjectShell(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const deadline = Date.now() + timeoutMs;
  const markers = [
    'textarea',
    '[contenteditable="true"]',
    'button:has-text("All media")',
    'a:has-text("Characters")',
    'button:has-text("Characters")',
    'mat-list-item',
  ];
  while (Date.now() < deadline) {
    // F10: fail fast on error/auth pages; loading is not ready.
    try {
      const title = await page.title().catch(() => '');
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
      const st = classifyAppState({ url: page.url(), title, bodyText });
      if (st.app === 'error_404' || st.app === 'auth_needed') {
        logger.warn('Project shell blocked by app state', { app: st.app });
        return false;
      }
    } catch { /* ignore probes */ }
    for (const sel of markers) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          logger.debug('Project shell ready', { marker: sel });
          await page.waitForTimeout(1000);
          return true;
        }
      } catch { /* next marker */ }
    }
    await page.waitForTimeout(1500);
  }
  logger.warn('Project shell did not hydrate in time', { timeoutMs });
  return false;
}

/**
 * Navigate to a project URL and wait for the app shell (prompt box, sidebar).
 * Returns true when the shell is usable, false otherwise (caller fails fast).
 */
async function gotoProject(page, url, label) {
  logger.info('Navigating to project', { label, url });
  try {
    const guess = isGuessedRoute(url);
    if (guess.guessed) {
      logger.warn('Refusing guessed project/tool route', { url, reason: guess.reason });
      return false;
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (!page.url().includes('/project/')) {
      logger.warn('Project navigation landed outside a project', { url: page.url(), label });
      return false;
    }
    // F10: 404/auth pages are not usable app state even under a Flow URL.
    try {
      const title = await page.title().catch(() => '');
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
      const st = classifyAppState({ url: page.url(), title, bodyText });
      if (st.app === 'error_404' || st.app === 'auth_needed') {
        logger.warn('Project navigation blocked by app state', { app: st.app, url: page.url() });
        return false;
      }
    } catch { /* fall through to shell wait */ }
    return await waitForProjectShell(page);
  } catch (e) {
    logger.warn('Project navigation failed', { label, error: e.message });
    return false;
  }
}
function touchProject(urlProjectId) {
  if (!urlProjectId) return;
  try {
    const store = loadProjects();
    const entry = store.projects.find(p =>
      extractProjectId(p.url || '') === urlProjectId || p.urlProjectId === urlProjectId
    );
    if (entry) {
      entry.last_used = new Date().toISOString();
      saveProjects(store);
    }
  } catch (e) {
    logger.debug('touchProject failed', { error: e.message });
  }
}

/**
 * Navigate to a section in the current project's sidebar.
 * sections: "Characters", "Scenes", "Tools", "Trash"
 * Returns true if navigation succeeded, false otherwise.
 */
export async function navigateToSidebar(page, section, opts = {}) {
  const detailed = await navigateSidebarDetailed(page, section, opts);
  return detailed.ok;
}

// Scoped sidebar roots only. There is deliberately NO document-wide generic
// fallback: a similarly named tile elsewhere in the page (gallery, dialogs)
// must never be clicked as if it were sidebar navigation.
// Live root is mat-nav-list[role=navigation] under mat-sidenav.project-sidenav;
// legacy HTML nav / *sidebar* scopes are preserved for old fixtures.
const SIDEBAR_SCOPES = [
  'mat-sidenav.project-sidenav mat-nav-list[role="navigation"] mat-list-item, mat-sidenav.project-sidenav mat-nav-list[role="navigation"] a',
  'mat-nav-list[role="navigation"] mat-list-item, mat-nav-list[role="navigation"] a',
  'mat-sidenav.project-sidenav mat-list-item, mat-sidenav.project-sidenav a',
  '[class*="sidebar"] button, [class*="sidebar"] a, [class*="sidebar"] mat-list-item, [class*="sidebar"] [role="listitem"]',
  'nav button, nav a, nav mat-list-item, nav [role="listitem"]',
];

// Click eligibility: positive enabled evidence only. Native disabled
// attribute/property counts alongside aria-disabled; unreadable eligibility
// fails closed (never clicked).
async function isClickEligible(handle) {
  try {
    let aria = null;
    let attr = null;
    let prop = null;
    let unreadable = false;
    try { aria = await handle.getAttribute('aria-disabled'); }
    catch { unreadable = true; }
    try { attr = await handle.getAttribute('disabled'); }
    catch { unreadable = true; }
    try {
      prop = await handle.evaluate((el) => {
        try { return el.disabled === true; }
        catch { return 'unknown'; }
      });
    } catch { unreadable = true; }
    if (prop === 'unknown') unreadable = true;
    if (unreadable) return false;
    if (aria === 'true') return false;
    if (attr !== null && attr !== undefined) return false;
    if (prop === true) return false;
    return true;
  } catch { return false; }
}

// Owning label for a sidebar item: the dedicated title span avoids icon
// ligature pollution (dashboard, accessibility_new, apps_spark_2).
async function readCandidateLabel(handle) {
  try {
    const owning = handle.locator('span[matlistitemtitle], .mdc-list-item__primary-text').first();
    const t = await owning.textContent({ timeout: 500 }).catch(() => null);
    if (t && String(t).trim()) return String(t);
  } catch { /* fall through to whole-item text */ }
  try {
    return (await handle.textContent()) || '';
  } catch { return ''; }
}

// One shared scoped DOM fact collector for sidebar selection. Serves
// readSidebarEvidence, getActiveSidebarSection and the navigate read-back:
// exactly one visible, enabled, owned item marked by exactly one selection
// channel (exact mdc-list-item--activated token, legacy aria, legacy exact
// active/selected/current tokens). Anything else — no owning scope, hidden,
// disabled, unlabelled, multiple or contradictory selections — is unknown
// (null), never fail-open. Owning label is span[matlistitemtitle] /
// .mdc-list-item__primary-text, avoiding icon ligature pollution.
async function collectSidebarFacts(page) {
  const res = await page.evaluate(() => {
    const labelOf = (el) => {
      try {
        const owning = el.querySelector('span[matlistitemtitle], .mdc-list-item__primary-text');
        const t = owning ? owning.textContent : el.textContent;
        const s = ((t || '').trim().slice(0, 120));
        return s || null;
      } catch { return null; }
    };
    const isVisible = (el) => {
      try {
        if (!el || el.nodeType !== 1) return false;
        if (el.hasAttribute('hidden')) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const cs = window.getComputedStyle(el);
        if (!cs) return false;
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        return true;
      } catch { return false; }
    };
    const isDisabled = (el) => {
      try {
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.hasAttribute('disabled')) return true;
        return false;
      } catch { return true; }
    };
    const inOwningScope = (el) => {
      try {
        if (!el || !el.closest) return false;
        return !!el.closest('mat-nav-list[role="navigation"], mat-sidenav.project-sidenav, [class*="sidebar"], nav');
      } catch { return false; }
    };
    const markedBy = (el) => {
      try {
        const cls = el.classList;
        if (cls && cls.contains('mdc-list-item--activated')) return 'activated';
      } catch { /* unmarked on unreadable classes */ }
      try {
        if (el.matches && (el.matches('[aria-current="page"]') || el.matches('[aria-selected="true"]'))) return 'aria';
      } catch { /* unmarked */ }
      try {
        const cls = el.classList;
        if (cls && (cls.contains('active') || cls.contains('selected') || cls.contains('current'))) return 'legacy';
      } catch { /* unmarked */ }
      return null;
    };
    const headingEl = document.querySelector('h1');
    const base = {
      heading: headingEl ? ((headingEl.textContent || '').trim().slice(0, 120)) : null,
      hash: window.location.hash || null,
      url: window.location.href,
      title: document.title || '',
    };
    let scopeRoots = [];
    try {
      scopeRoots = Array.from(document.querySelectorAll(
        'mat-sidenav.project-sidenav mat-nav-list[role="navigation"], mat-nav-list[role="navigation"], mat-sidenav.project-sidenav, [class*="sidebar"], nav'
      ));
    } catch { return { ...base, items: [], selected: null }; }
    if (scopeRoots.length === 0) return { ...base, items: [], selected: null };
    const seen = new Set();
    const items = [];
    for (const root of scopeRoots) {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll('mat-list-item, a, button, li, [role="listitem"]'));
      } catch { continue; }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!inOwningScope(el)) continue;
        if (!isVisible(el)) continue;
        const disabled = isDisabled(el);
        const channel = markedBy(el);
        items.push({ label: labelOf(el), marked: !!channel, disabled });
      }
    }
    // Count ALL enabled marked owning items before deriving any label, so
    // an unlabelled marked item keeps the whole selection unknown.
    const markedEnabled = items.filter((it) => it.marked && !it.disabled);
    const selected = markedEnabled.length === 1 ? (markedEnabled[0].label || null) : null;
    return { ...base, items, selected };
  });
  // Legacy mock-page shape (existing unit tests script evaluate to a plain
  // label string): treat it as the selected label, never as item facts.
  if (typeof res === 'string') {
    return { items: [], selected: res || null, heading: null, hash: null, url: null, title: '' };
  }
  return res;
}

// Raw selection facts from the live DOM. The evaluate callback returns facts
// only (no matching logic), so tests exercise the real DOM, not a mock.
export async function readSidebarEvidence(page) {
  try {
    const facts = await collectSidebarFacts(page);
    if (!facts || typeof facts !== 'object') return null;
    let pageUrl = null;
    try { pageUrl = page.url(); } catch { pageUrl = null; }
    return {
      selected: facts.selected ?? null,
      heading: facts.heading ?? null,
      hash: facts.hash ?? null,
      url: facts.url || pageUrl,
      title: facts.title || '',
    };
  } catch {
    return null;
  }
}

async function pollSidebarEvidence(page, want, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSidebarEvidence(page);
    if (last && last.selected && normalizeSidebarLabel(last.selected).toLowerCase() === want) return last;
    await page.waitForTimeout(250).catch(() => {});
  }
  return last;
}

async function readSidebarAppState(page) {
  try {
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    // Structure must come from visible markup (page.content), never from
    // tag-free bodyText alone.
    let html = '';
    try {
      if (typeof page.content === 'function') html = (await page.content().catch(() => '')) || '';
    } catch { html = ''; }
    return classifyAppState({ url: page.url(), title, bodyText, html });
  } catch {
    return { allowedUrl: false, app: 'unknown', reason: 'evidence-unreadable' };
  }
}

// W02 detailed sidebar navigation for W06 callers: verified section result.
// Failed nav yields { ok:false, blocker } — callers must block, never report valid.
//
// Matching enumerates scoped sidebar candidates and compares NORMALIZED
// owning labels exactly (span[matlistitemtitle] avoids icon ligatures;
// whole-item text is the legacy fallback). Glued `apps_spark_2Tools` still
// normalizes via the shared adapter.
// Verification requires the selected item (exact mdc-list-item--activated
// token, legacy aria fallback) to match plus usable app state — never a
// classname substring (`inactive` contains `active`) and never a
// document-generic tile click.
export async function navigateSidebarDetailed(page, section, opts = {}) {
  logger.info('Navigating to sidebar section', { section });
  const want = String(section || '').trim().toLowerCase();
  if (!want) return { ok: false, active: null, blocker: 'sidebar-nav-blocked: empty section' };
  const lease = getUiLease();
  const epoch = opts.epoch ?? lease.getEpoch();
  const norm = (s) => {
    try { return normalizeSidebarLabel(s).toLowerCase(); }
    catch { return String(s || '').trim().toLowerCase(); }
  };

  // Shared fact census first: deny ambiguity before any click. Multiple
  // distinct visible owning controls with the requested label must never
  // resolve to an arbitrary first click.
  let censusItems = null;
  let censusSelected = null;
  try {
    const facts = await collectSidebarFacts(page);
    censusItems = Array.isArray(facts?.items) ? facts.items : null;
    censusSelected = facts?.selected ?? null;
  } catch { censusItems = null; }
  if (!censusItems) {
    logger.warn('Sidebar evidence unreadable before click', { section });
    return { ok: false, active: null, blocker: `sidebar-nav-blocked: section "${section}" not found or not verified` };
  }
  const usableMatches = censusItems.filter((it) => it && !it.disabled && it.label && norm(it.label) === want);
  if (usableMatches.length > 1) {
    const current = censusSelected ? norm(censusSelected) : null;
    return { ok: false, active: current, blocker: `sidebar-nav-blocked: ambiguous sidebar selection for "${section}" (${usableMatches.length} visible owning controls)` };
  }

  for (const sel of SIDEBAR_SCOPES) {
    let handles = [];
    try {
      handles = await page.locator(sel).all();
    } catch (e) {
      logger.debug('Sidebar scope enumeration failed', { selector: sel, error: e.message });
      continue;
    }
    for (const handle of handles) {
      const raw = await readCandidateLabel(handle);
      if (!raw || normalizeSidebarLabel(raw).toLowerCase() !== want) continue;
      let visible = false;
      try {
        visible = await handle.isVisible().catch(() => false);
      } catch { continue; }
      if (!visible) continue;
      if (!(await isClickEligible(handle))) continue;
      // Lease checkpoint immediately before the consequential click.
      if (!lease.checkpoint(epoch)) {
        return { ok: false, active: null, blocker: 'sidebar-nav-blocked: ui lease stale before click' };
      }
      try {
        await handle.click();
      } catch (e) {
        logger.debug('Sidebar click failed', { section, error: e.message });
        continue;
      }
      // Bounded semantic wait for selection evidence (not a fixed sleep).
      const evidence = await pollSidebarEvidence(page, want, opts.pollMs ?? 5000);
      // Re-check the lease before trusting the read-back.
      if (!lease.checkpoint(epoch)) {
        return { ok: false, active: null, blocker: 'sidebar-nav-blocked: ui lease stale before read-back' };
      }
      const selected = evidence?.selected ? normalizeSidebarLabel(evidence.selected) : null;
      const selectedMatch = !!selected && selected.toLowerCase() === want;
      const app = await readSidebarAppState(page);
      if (selectedMatch && app.app === 'ready') {
        logger.info('Sidebar navigation verified', { section, active: selected, route: evidence?.hash || evidence?.url });
        return { ok: true, active: selected, route: evidence?.hash || evidence?.url, heading: evidence?.heading || null, blocker: null };
      }
      logger.debug('Sidebar click unverified', { section, selected, app: app.app });
      return {
        ok: false,
        active: selected,
        blocker: `sidebar-nav-blocked: section "${section}" click unverified (selected=${selected || 'none'}, app=${app.app})`,
      };
    }
  }

  // Scoped diagnostics only; they must never throw away the blocker.
  logger.warn('Sidebar section not found via selectors', { section });
  try {
    const elements = await detectPageElements();
    logger.info('Available buttons on page', {
      buttons: (elements?.buttons || []).map(b => b.text).filter(Boolean),
    });
  } catch (e) {
    logger.debug('Sidebar diagnostics unavailable', { error: e.message });
  }
  try {
    await takeScreenshot(page, `sidebar-${section}-not-found`);
  } catch (e) {
    logger.debug('Sidebar failure screenshot unavailable', { error: e.message });
  }

  return { ok: false, active: null, blocker: `sidebar-nav-blocked: section "${section}" not found or not verified` };
}

/**
 * Get the current page elements and detect the active sidebar section.
 * Returns the section that appears to be active, or null.
 */
export async function getActiveSidebarSection(page) {
  try {
    const evidence = await readSidebarEvidence(page);
    const section = evidence?.selected ?? null;
    if (!section) return null;
    try {
      return normalizeSidebarLabel(section);
    } catch { return String(section).trim(); }
  } catch {
    return null;
  }
}

/**
 * Store task metadata in the project registry after completing a task.
 * Matches by registry id OR by URL-extracted project id (dual ID systems).
 */
export function registerTaskInProject(projectId, taskInfo) {
  if (!projectId) return;
  const store = loadProjects();
  const proj = store.projects.find(p =>
    p.id === projectId || extractProjectId(p.url || '') === projectId || p.urlProjectId === projectId
  );
  if (proj) {
    proj.tasks.push({
      ...taskInfo,
      timestamp: new Date().toISOString(),
    });
    proj.last_used = new Date().toISOString();
    try {
      saveProjects(store);
    } catch (e) {
      logger.warn('Failed to save project registry', { error: e.message });
    }
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
