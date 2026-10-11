// W07-E: installed-tarball + outside-CWD isolation (F13/K61).
// Builds freshly, packs the ACTUAL npm tarball, installs it into an isolated
// lane-scratch consumer dir, then exercises the public surface from an
// unrelated CWD with an isolated FLOW_HOME/HOME: no repo files touched, no
// real user config touched, no browser launched (safe --help/--dry-run +
// browser-free initialized smoke). All scratch lives under
// reliability-evidence/package/scratch (NOT system temp).
// Live correlation of generated assets is integration-dependent (W05/W11)
// and explicitly not claimed here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runSmoke } from '../scripts/smoke-client.mjs';
import { fixtureServerEntry } from '../scripts/smoke-fixture-server.mjs';

const LANE_SCRATCH = path.join('reliability-evidence', 'package', 'scratch');
fs.mkdirSync(LANE_SCRATCH, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(LANE_SCRATCH, 'w07-tarball-'));
const UNRELATED_CWD = fs.mkdtempSync(path.join(LANE_SCRATCH, 'w07-unrelated-cwd-'));
const FAKE_HOME = path.join(SCRATCH, 'fake-home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
const FLOW_HOME = path.join(SCRATCH, 'flow-home');
fs.mkdirSync(FLOW_HOME, { recursive: true });

let tgzPath = '';
let installDir = '';

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

beforeAll(() => {
  const npmCache = path.join(SCRATCH, 'npm-cache');
  const baseEnv = { ...process.env, npm_config_cache: npmCache };

  // 0. Fresh build so the packed bundle matches current source.
  execSync(`${npmBin()} run build`, { encoding: 'utf-8', cwd: process.cwd(), timeout: 120000, env: baseEnv });

  // 1. Pack the actual tarball (offline-safe; no publish).
  const packOut = execSync(`${npmBin()} pack --json`, { encoding: 'utf-8', cwd: process.cwd(), env: baseEnv });
  const parsed = JSON.parse(packOut);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const packedName = entry.filename;
  const built = path.join(process.cwd(), packedName);
  const staged = path.join(SCRATCH, packedName);
  fs.copyFileSync(built, staged);
  fs.unlinkSync(built);
  tgzPath = staged;

  // 2. Install into an isolated consumer dir with its own package.json.
  // NOTE: `npm install --prefix <emptydir> <tgz>` fails on npm 11 with
  // EALLOWSCRIPTS (prefix-scoped install); a regular project install works.
  // String form (shell): execFileSync(npm.cmd) raises EINVAL on Windows.
  installDir = path.join(SCRATCH, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', type: 'module' }, null, 2),
  );
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.toLowerCase().includes('allow_scripts') || k.toLowerCase().includes('allowscripts')) {
      delete cleanEnv[k];
    }
  }
  execSync(`${npmBin()} install --no-audit --no-fund --ignore-scripts "${path.resolve(tgzPath)}"`, {
    encoding: 'utf-8',
    timeout: 180000,
    cwd: installDir,
    env: {
      ...cleanEnv,
      npm_config_cache: path.join(SCRATCH, 'npm-cache'),
    },
  });
}, 240000);

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(UNRELATED_CWD, { recursive: true, force: true });
});

describe('W07-E initialized fixture-server smoke (positive + negative)', () => {
  it('positive: initialized fixture ping passes with no browser', async () => {
    const verdict = await runSmoke({
      serverEntry: fixtureServerEntry(),
      tool: 'smoke_ping',
      toolArgs: {},
      timeoutMs: 30000,
    });
    expect(verdict.pass).toBe(true);
  }, 60000);

  it('negative: fixture isError tool fails closed (F12)', async () => {
    const verdict = await runSmoke({
      serverEntry: fixtureServerEntry(),
      tool: 'smoke_fail',
      toolArgs: {},
      timeoutMs: 30000,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TOOL_ERROR/);
  }, 60000);
});

describe('W07-E installed tarball isolation (F13/K61)', () => {
  it('packed the actual tarball file', () => {
    expect(fs.existsSync(tgzPath)).toBe(true);
  });

  it('installed package resolves the shipped server entry', () => {
    const entry = path.join(installDir, 'node_modules', 'google-flow_mcp', 'dist', 'index.js');
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('installed package resolves published command deps (scripts/run.js)', () => {
    const run = path.join(installDir, 'node_modules', 'google-flow_mcp', 'scripts', 'run.js');
    expect(fs.existsSync(run)).toBe(true);
  });

  it('installed package resolves all published helper scripts', () => {
    const base = path.join(installDir, 'node_modules', 'google-flow_mcp', 'scripts');
    for (const f of [
      'run.js',
      'smoke-client.mjs',
      'smoke-fixture-server.mjs',
      'start-browser.ps1',
      'start-browser.sh',
      'start-mcp.ps1',
      'start-mcp.sh',
      'start-mcp.bat',
      'register.ps1',
      'register.sh',
      'test-flow-image.ps1',
      'test-flow-image.sh',
    ]) {
      expect(fs.existsSync(path.join(base, f))).toBe(true);
    }
  });

  it('positive initialized smoke passes with child cwd outside the repo and isolated FLOW_HOME', async () => {
    const entry = path.resolve(path.join(installDir, 'node_modules', 'google-flow_mcp', 'dist', 'index.js'));
    const verdict = await runSmoke({
      serverEntry: entry,
      tool: 'flow_status',
      toolArgs: {},
      timeoutMs: 60000,
      cwd: path.resolve(installDir),
      env: { ...process.env, FLOW_HOME: path.resolve(FLOW_HOME) },
    });
    expect(verdict.pass).toBe(true);
  }, 90000);

  it('packaged register --dry-run passes with isolated HOME and writes nothing outside scratch', () => {
    const listEntries = (dir) => fs.readdirSync(dir).filter((e) => process.platform !== 'win32' || e !== 'AppData');
    const before = listEntries(FAKE_HOME);
    const script = path.resolve(path.join(installDir, 'node_modules', 'google-flow_mcp', 'scripts', 'register.sh'));
    const ps1Script = path.resolve(path.join(installDir, 'node_modules', 'google-flow_mcp', 'scripts', 'register.ps1'));
    const out =
      process.platform === 'win32'
        ? execFileSync(
            'powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Script, '-DryRun'],
            { encoding: 'utf-8', cwd: path.resolve(UNRELATED_CWD), env: { ...process.env, HOME: path.resolve(FAKE_HOME), USERPROFILE: path.resolve(FAKE_HOME) }, timeout: 60000 },
          )
        : execFileSync('bash', [script, '--dry-run'], {
            encoding: 'utf-8', cwd: path.resolve(UNRELATED_CWD), env: { ...process.env, HOME: path.resolve(FAKE_HOME) }, timeout: 60000,
          });
    expect(out).toMatch(/--dry-run/);
    expect(listEntries(FAKE_HOME)).toEqual(before);
  }, 90000);

  it('unrelated CWD contains no repo bleed-through after the run', () => {
    expect(fs.readdirSync(UNRELATED_CWD)).toEqual([]);
  });
});
