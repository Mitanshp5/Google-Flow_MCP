import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getFlowHome, get } from '../utils/config.js';
import { resolveSafePath, assertInsideBase } from '../utils/sanitize.js';
import { ensureProjectInContext, extractProjectId, buildProjectUrl } from '../navigation/project-navigator.js';

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

  // The Characters page only exists scoped to a project
  // ({flowBase}/project/{id}/characters) — there is
  // no standalone "/characters" page.
  const project = await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });
  const projectId = extractProjectId(project.url);
  const charsUrl = projectId
    ? `${buildProjectUrl(get('flowUrl', 'https://flow.google.com/'), projectId)}/characters`
    : `${project.url.replace(/\/$/, '')}/characters`;

  await page.goto(charsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    const elements = await detectPageElements();
    return {
      status: 'discovery_needed',
      message: 'Characters page opened. File input for import not auto-detected.',
      elements,
      screenshot: await takeScreenshot(page, 'characters-import'),
    };
  }

  if (characterName) {
    const nameInput = await page.$('input[placeholder*="Name" i], input[aria-label*="Name" i]');
    if (nameInput) {
      await nameInput.click();
      await nameInput.fill('');
      await page.waitForTimeout(200);
      await nameInput.type(characterName, { delay: 20 });
    }
  }

  if (referenceImages.length > 0) {
    const existing = referenceImages.filter(p => {
      try {
        if (!fs.existsSync(p)) {
          logger.warn('Import reference image not found, skipping', { path: p.slice(0, 120) });
          return false;
        }
        return true;
      } catch { return false; }
    });
    if (existing.length > 0) {
      await fileInput.setInputFiles(existing);
      await page.waitForTimeout(2000);
    }
  }

  if (description) {
    const descInput = await page.$('textarea, [contenteditable="true"]');
    if (descInput) {
      await descInput.click();
      await descInput.fill('');
      await page.waitForTimeout(200);
      await descInput.type(description, { delay: 20 });
    }
  }

  await takeScreenshot(page, 'character-import-ready');

  return {
    status: 'ready_for_confirmation',
    message: 'Character import setup complete. Manual confirmation needed.',
    name: characterName,
    description,
    reference_images: referenceImages,
    screenshot: await takeScreenshot(page, 'character-import-ready'),
  };
}
