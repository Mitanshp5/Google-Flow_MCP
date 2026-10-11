// W07-C: published command dependencies ship in the tarball (F13).
// Every npm script that runs from the INSTALLED layout must resolve its
// files from the packed `files` manifest. scripts/run.js dispatches to
// sibling helper files, so those siblings must be published too.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const files = pkg.files ?? [];

function published(rel) {
  // True if npm `files` allowlist covers rel (exact or parent dir).
  return files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, '') + '/'));
}

describe('W07-C packed files cover published commands (F13)', () => {
  it('ships scripts/run.js (used by start-browser/start-mcp/register/test:smoke)', () => {
    expect(published('scripts/run.js')).toBe(true);
  });

  it('ships the portable smoke client used by test:smoke', () => {
    expect(published('scripts/smoke-client.mjs')).toBe(true);
  });

  it('ships start-browser/start-mcp/register helpers for both platforms', () => {
    for (const f of [
      'scripts/start-browser.ps1',
      'scripts/start-browser.sh',
      'scripts/start-mcp.ps1',
      'scripts/start-mcp.sh',
      'scripts/start-mcp.bat',
      'scripts/register.ps1',
      'scripts/register.sh',
      'scripts/test-flow-image.ps1',
      'scripts/test-flow-image.sh',
    ]) {
      expect({ file: f, published: published(f) }).toEqual({ file: f, published: true });
    }
  });

  it('every package.json script target resolves to a published file or an explicit repo-only note', () => {
    const repoOnly = new Set(pkg.w07RepoOnlyScripts ?? []);
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      const m = String(cmd).match(/scripts\/([A-Za-z0-9_.-]+)/g) ?? [];
      for (const ref of m) {
        const rel = ref.replace(/\\/g, '/');
        expect(
          published(rel) || [...repoOnly].some((s) => name === s),
          `script ${name} references unpublished ${rel}`,
        ).toBe(true);
      }
    }
  });

  it('dist bundle entry exists after build (the shipped server)', () => {
    expect(fs.existsSync('dist/index.js')).toBe(true);
  });

  it('run.js dispatcher file exists in the repo', () => {
    expect(fs.existsSync(path.join('scripts', 'run.js'))).toBe(true);
  });
});
