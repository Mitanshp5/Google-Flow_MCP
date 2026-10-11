import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getFlowHome, get } from '../utils/config.js';
import { resolveSafePath, assertInsideBase } from '../utils/sanitize.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';
import { isErrorHtml } from '../browser/app-state.js';

/**
 * Import a character from a saved JSON file (args.file_path).
 * Expected JSON shape:
 * {
 *   "name": "Character Name",
 *   "description": "Character description/prompt",
 *   "image_path": "/path/to/reference.png"        // or "reference_images": ["..."]
 * }
 * Image paths in the JSON may be absolute, or relative to the JSON file's directory.
 */
export async function handleImportCharacter(args) {
  const page = getPage();

  if (!args.file_path || typeof args.file_path !== 'string') {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'file_path is required and must be a string.');
  }
  // Resolve relative to flowHome for determinism; absolute paths allowed.
  const absFile = resolveSafePath(args.file_path);
  if (!fs.existsSync(absFile)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Character file not found: ${args.file_path}`);
  }
  let stat;
  try {
    stat = fs.statSync(absFile);
  } catch {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Character file not readable: ${args.file_path}`);
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Character file must be a regular JSON file ≤ 5MB');
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(absFile, 'utf-8'));
  } catch (err) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Could not parse character JSON: ${err.message}`);
  }

  const jsonDir = path.dirname(absFile);
  const resolveImagePath = (p) => {
    if (typeof p !== 'string' || !p.trim()) {
      throw new FlowError(ErrorCodes.INVALID_PARAMS, 'Reference image path must be a non-empty string');
    }
    const t = p.trim();
    // Absolute stays absolute; relative resolves against the JSON dir (documented).
    const abs = path.isAbsolute(t) ? path.normalize(t) : path.resolve(jsonDir, t);
    // Traversal guard for relative entries: must stay inside JSON dir or flowHome.
    if (!path.isAbsolute(t)) {
      try {
        assertInsideBase(abs, jsonDir);
      } catch {
        assertInsideBase(abs, getFlowHome());
      }
    }
    return abs;
  };

  const characterName = data.name;
  const description = data.description;
  const referenceImages = Array.isArray(data.reference_images) && data.reference_images.length > 0
    ? data.reference_images.map(resolveImagePath)
    : (data.image_path ? [resolveImagePath(data.image_path)] : []);

  logger.info('Importing character from file', { name: characterName, file: absFile });

  // F02: The Character page exists scoped to a project
  // ({flowBase}/project/{id}/character) — singular route.
  const project = await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
    project_url: args.project_url,
  });
  const projectId = extractProjectId(project.url);
  const charUrl = projectId
    ? `${buildProjectUrl(get('flowUrl', 'https://flow.google.com/'), projectId)}/character`
    : `${project.url.replace(/\/$/, '')}/character`;

  await page.goto(charUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');

  // F02: Check if route redirected to 404 or error page
  if (isErrorHtml({ title, bodyText, url: currentUrl })) {
    return {
      status: 'blocked',
      reason: 'page_not_found',
      url: currentUrl,
      title,
      message: 'Character route returned 404 or page not found.',
      screenshot: await takeScreenshot(page, 'characters-import-404'),
    };
  }

  const fileInput = await page.$('input[type="file"]');
  const characterForm = await page.locator('[placeholder*="Describe your character" i], [aria-label*="Describe your character" i]').first().isVisible().catch(() => false);
  if (!characterForm) {
    return { status: 'blocked', reason: 'character_form_not_found',
      message: 'Character import form identity is unverified; no fields were changed.',
      screenshot: await takeScreenshot(page, 'character-import-unverified') };
  }
  if (!fileInput) {
    const elements = await detectPageElements();
    return {
      status: 'discovery_needed',
      message: 'Character page opened. File input for import not auto-detected.',
      elements,
      screenshot: await takeScreenshot(page, 'characters-import'),
    };
  }

  const unapplied = [];
  const actual = {};
  for (const [key, value, selector] of [
    ['name', characterName, 'input[placeholder*="Name" i], input[aria-label*="Name" i]'],
    ['description', description, '[placeholder*="Describe your character" i], [aria-label*="Describe your character" i]'],
  ]) {
    const input = page.locator(selector).first();
    if (typeof value !== 'string' || !value.trim() || !await input.isVisible().catch(() => false)) {
      unapplied.push(key);
      continue;
    }
    await input.fill(value);
    actual[key] = await input.inputValue().catch(() => null)
      ?? await input.textContent().catch(() => null);
    if (actual[key] !== value) unapplied.push(key);
  }
  // A generic file input proves neither native character ownership nor the
  // persisted reference identity. Until that native acknowledgement is observed,
  // required reference packs remain explicitly unverified rather than skipped.
  if (referenceImages.length > 0) unapplied.push('reference_images');
  return {
    status: unapplied.length ? 'prepared_unverified' : 'ready_for_confirmation',
    message: unapplied.length ? 'Character import has unverified required fields or references. No submission occurred.'
      : 'Character fields read back. Manual confirmation is required; no submission occurred.',
    name: characterName,
    description,
    reference_images: referenceImages,
    actual,
    unapplied,
    screenshot: await takeScreenshot(page, 'character-import-ready'),
  };
}
