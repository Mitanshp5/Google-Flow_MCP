import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getFlowHome } from '../utils/config.js';
import { resolveSafePath, assertInsideBase } from '../utils/sanitize.js';
import { handleCreateCharacter } from './create-character.js';
import { schemas, parseOrThrow } from '../utils/validate.js';

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
  getPage(); // Preserve the browser-required tool contract before file I/O.
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

  // Import is a shared, verified preparation. A file input exists only after
  // opening Flow's upload picker, and the name is applied after creation.
  const preparation = parseOrThrow(schemas.flow_create_character, {
    ...args, name: characterName, description, reference_images: referenceImages, auto_confirm: false,
  }, 'flow_import_character');
  return { ...await handleCreateCharacter(preparation), imported_from: absFile };
}
