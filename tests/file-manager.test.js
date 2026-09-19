import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findNewFiles } from '../src/utils/file-manager.js';
import { sanitizeFileName } from '../src/utils/screenshots.js';

describe('file-manager', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('findNewFiles filters dotfiles and survives ENOENT races', () => {
    const before = Date.now() - 1000;
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    fs.writeFileSync(path.join(dir, 'a.png'), 'x');
    const found = findNewFiles(dir, before);
    expect(found.some(f => f.endsWith('a.png'))).toBe(true);
    expect(found.some(f => f.endsWith('.hidden'))).toBe(false);
    expect(findNewFiles(path.join(dir, 'nope'), before)).toEqual([]);
  });

  it('sanitizeFileName is safe for screenshots', () => {
    expect(sanitizeFileName('../../x')).not.toContain('/');
    expect(sanitizeFileName('tool-Grid Architect')).toBe('tool-Grid-Architect');
  });
});
