import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { detectPageElements } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
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

  if (!args.file_path) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, 'file_path is required to import a character.');
  }
  if (!fs.existsSync(args.file_path)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Character file not found: ${args.file_path}`);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.file_path, 'utf-8'));
  } catch (err) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, `Could not parse character JSON: ${err.message}`);
  }

  const jsonDir = path.dirname(path.resolve(args.file_path));
  const resolveImagePath = (p) => (path.isAbsolute(p) ? p : path.join(jsonDir, p));

  const characterName = data.name;
  const description = data.description;
  const referenceImages = Array.isArray(data.reference_images) && data.reference_images.length > 0
    ? data.reference_images.map(resolveImagePath)
    : (data.image_path ? [resolveImagePath(data.image_path)] : []);

  logger.info('Importing character from file', { name: characterName, file: args.file_path });

  // The Characters page only exists scoped to a project
  // (https://labs.google/fx/tools/flow/project/{id}/characters) — there is
  // no standalone "/characters" page.
  const project = await ensureProjectInContext(page, {
    name: args.project_name,
    campaign: args.campaign,
  });
  const projectId = extractProjectId(project.url);
  const charsUrl = projectId
    ? `${buildProjectUrl('https://labs.google/fx/tools/flow', projectId)}/characters`
    : `${project.url.replace(/\/$/, '')}/characters`;

  await page.goto(charsUrl, { waitUntil: 'networkidle', timeout: 30000 });
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
    await fileInput.setInputFiles(referenceImages);
    await page.waitForTimeout(2000);
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
