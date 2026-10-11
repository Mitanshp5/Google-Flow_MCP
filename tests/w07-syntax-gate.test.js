// W07 syntax-gate slice: all-source syntax coverage, honestly labeled.
// (a) typecheck wiring: npm script must cover all sources, not the entry.
// (b) eslint wiring: config must cover shipped .mjs helpers.
// (c/d) runner behavior: injected nested syntax error fails with the file
// named; clean staging passes. Staging lives under evidence-v2 (lane
// scratch), never src/. `node --check` is syntax-only; no typing is claimed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SLICE = path.join('evidence-v2', 'w07-syntax-gate');
const STAGE = path.join(SLICE, 'scratch', 'staging');
const RUNNER = path.join('scripts', 'check-syntax.mjs');

function readPkg() {
  return JSON.parse(fs.readFileSync('package.json', 'utf-8'));
}

function runRunner(args, cwd) {
  return spawnSync(process.execPath, [path.resolve(RUNNER), ...args], {
    encoding: 'utf-8',
    cwd: cwd ?? process.cwd(),
    timeout: 120000,
  });
}

beforeAll(() => {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'ok.js'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(STAGE, 'a', 'b', 'broken.js'), 'export const broken = {\n');
});

afterAll(() => {
  fs.rmSync(STAGE, { recursive: true, force: true });
});

describe('W07 syntax-gate wiring (regression)', () => {
  it('npm run typecheck covers all sources, not just the entry file', () => {
    const cmd = String(readPkg().scripts.typecheck ?? '');
    expect(cmd).not.toMatch(/node --check src\/index\.js\s*$/);
    expect(cmd).toMatch(/check-syntax/);
  });

  it('eslint config covers shipped .mjs helpers', () => {
    const cfg = fs.readFileSync('eslint.config.js', 'utf-8');
    expect(cfg).toMatch(/\*\*\/\*\.mjs/);
  });

  it('stdlib mechanism sanity: node --check rejects a nested broken file', () => {
    const r = spawnSync(process.execPath, ['--check', path.resolve(STAGE, 'a', 'b', 'broken.js')], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(r.status).not.toBe(0);
  });
});

describe('W07 syntax runner behavior', () => {
  it('fails on staging with an injected nested syntax error, naming the file', async () => {
    const { checkSyntax } = await import('../scripts/check-syntax.mjs');
    const res = await checkSyntax([path.resolve(STAGE)]);
    expect(res.ok).toBe(false);
    expect(res.failures.join('\n')).toMatch(/broken\.js/);
  });

  it('passes on clean staging (injected error removed)', async () => {
    fs.unlinkSync(path.join(STAGE, 'a', 'b', 'broken.js'));
    try {
      const { checkSyntax } = await import('../scripts/check-syntax.mjs');
      const res = await checkSyntax([path.resolve(STAGE)]);
      expect(res.failures).toEqual([]);
      expect(res.ok).toBe(true);
    } finally {
      fs.writeFileSync(path.join(STAGE, 'a', 'b', 'broken.js'), 'export const broken = {\n');
    }
  });

  it('repo-wide run exits 0 via CLI (true exit code)', () => {
    const r = runRunner([]);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  }, 60000);

  it('staging run exits non-zero via CLI (true exit code)', () => {
    const r = runRunner([path.resolve(STAGE)]);
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
    expect(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).toMatch(/broken\.js/);
  }, 60000);
});
