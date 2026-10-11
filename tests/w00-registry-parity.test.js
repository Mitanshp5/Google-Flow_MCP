/**
 * W00 finding-ownership registry + module inventory + fixture QA pin.
 * Behavioral registry/dispatch/parity lives in tests/w00-import-dispatch.test.js
 * (actual imported objects, real dispatch). This file keeps the static
 * planning artifacts: every finding owned, modules inventoried, QA pin in
 * fixture metadata (never exported from production).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { W00_FINDING_REGISTRY, W00_QA_REVISION } from './helpers/w00-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('W00 finding-ownership registry covers F01-F16/R01-R04', () => {
  it('declares an owner + repro for all 20 findings/risks', () => {
    const ids = W00_FINDING_REGISTRY.map((r) => r.id);
    const expected = [
      ...Array.from({ length: 16 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`),
      'R01', 'R02', 'R03', 'R04',
    ];
    expect(ids.sort()).toEqual(expected.sort());
    for (const row of W00_FINDING_REGISTRY) {
      expect(row.owner, `${row.id} owner`).toMatch(/^W\d/);
      expect(row.repro.length, `${row.id} repro`).toBeGreaterThan(0);
    }
  });

  it('W00 starters are exactly F01/F03/F04/F12/F13', () => {
    const starters = W00_FINDING_REGISTRY.filter((r) => r.owner === 'W00-starter').map((r) => r.id).sort();
    expect(starters).toEqual(['F01', 'F03', 'F04', 'F12', 'F13']);
  });
});

describe('W00 QA pin lives in fixture metadata, not production exports', () => {
  it('tests/fixtures/w00-qa.json pins the revision and fixture inventory', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'w00-qa.json'), 'utf-8'));
    expect(meta.qa_revision).toBe(W00_QA_REVISION);
    expect(meta.qa_revision).toMatch(/^[0-9a-f]{40}$/);
    for (const name of meta.fixtures) {
      expect(fs.existsSync(path.join(__dirname, 'fixtures', name)), name).toBe(true);
    }
  });
});

describe('W00 module inventory matches the production tree', () => {
  it('pins known src areas without claiming new modules', () => {
    const srcFiles = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) srcFiles.push(path.relative(path.join(__dirname, '..'), p));
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    // Baseline count at QA revision, plus the authorized session-scope.js.
    expect(srcFiles.length).toBeGreaterThanOrEqual(30);
    expect(srcFiles).toContain(path.join('src', 'index.js'));
    expect(srcFiles).toContain(path.join('src', 'browser', 'session-scope.js'));
    expect(srcFiles).toContain(path.join('src', 'navigation', 'project-navigator.js'));
    expect(srcFiles).toContain(path.join('src', 'browser', 'safe-actions.js'));
  });
});
