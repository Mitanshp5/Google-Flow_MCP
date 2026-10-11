// W07 installed launcher entry slice (lane-task.md, ONE boundary).
// Every advertised start-mcp script must exec the shipped dist/index.js in
// an installed-style layout (dist/ + scripts/, NO src/ — matching
// package.json `files`), invoked from an unrelated CWD; --dry-run must name
// that same existing target. Real execution is exercised for real: the
// script execs node on inherited stdio and the test speaks initialized MCP
// (initialize + tools/call smoke_ping) through the real SDK Client with a
// whole-run deadline. No browser launch, no registration, no src edits.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runSmoke } from '../scripts/smoke-client.mjs';

const SLICE = path.join('evidence-v2', 'w07-installed-launcher-entry');
const SCRATCH = path.join(SLICE, 'scratch');
// Spaces are intentional: native paths / quoted spaces must be honored.
const PKG = path.join(SCRATCH, 'pkg with spaces');
const SRC_ONLY_PKG = path.join(SCRATCH, 'src only pkg');
const UNRELATED = path.join(SCRATCH, 'unrelated cwd');

function copyLaunchers(destScripts) {
  for (const f of ['start-mcp.sh', 'start-mcp.ps1', 'start-mcp.bat']) {
    fs.copyFileSync(path.join('scripts', f), path.join(destScripts, f));
  }
}

beforeAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  // Installed-style layout: shipped entry + launchers, NO src/.
  fs.mkdirSync(path.join(PKG, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(PKG, 'scripts'), { recursive: true });
  fs.copyFileSync('scripts/smoke-fixture-server.mjs', path.join(PKG, 'dist', 'index.js'));
  fs.writeFileSync(
    path.join(PKG, 'package.json'),
    JSON.stringify({ name: 'w07-fixture-pkg', type: 'module' }),
  );
  copyLaunchers(path.join(PKG, 'scripts'));
  // Dev-remnant layout: src only, no dist (fallback characterization).
  fs.mkdirSync(path.join(SRC_ONLY_PKG, 'src'), { recursive: true });
  fs.mkdirSync(path.join(SRC_ONLY_PKG, 'scripts'), { recursive: true });
  fs.copyFileSync('scripts/smoke-fixture-server.mjs', path.join(SRC_ONLY_PKG, 'src', 'index.js'));
  fs.writeFileSync(
    path.join(SRC_ONLY_PKG, 'package.json'),
    JSON.stringify({ name: 'w07-fixture-pkg', type: 'module' }),
  );
  copyLaunchers(path.join(SRC_ONLY_PKG, 'scripts'));
  fs.mkdirSync(UNRELATED, { recursive: true });
});

afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function have(command, args) {
  try {
    const r = spawnSync(command, args, { stdio: 'ignore', timeout: 20000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

const HAVE_BASH = process.platform !== 'win32' && have('bash', ['--version']);
const HAVE_POWERSHELL =
  process.platform === 'win32' &&
  (have('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion']) ||
    have('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion']));
const HAVE_CMD = process.platform === 'win32' && have('cmd', ['/c', 'exit 0']);

const SH = { dryRun: ['bash', ['--dry-run']], launch: ['bash', []] };
const PS1 = {
  dryRun: ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '', '-DryRun']],
  launch: ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '']],
};
const BAT = { dryRun: ['cmd', ['/c', '', '--dry-run']], launch: ['cmd', ['/c', '']] };

function scriptPath(pkg, file) {
  return path.resolve(path.join(pkg, 'scripts', file));
}

// Dry-run plans are logged on stderr by convention; assert on combined output.
function dryRunOutput(command, args) {
  const r = spawnSync(command, args, {
    encoding: 'utf-8',
    cwd: path.resolve(UNRELATED),
    timeout: 30000,
  });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}


function launchOf(kind, pkg) {
  if (kind === 'sh') return { command: 'bash', args: [scriptPath(pkg, 'start-mcp.sh')] };
  if (kind === 'ps1') {
    const powershell = have('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'])
      ? 'powershell'
      : 'pwsh';
    return {
      command: powershell,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(pkg, 'start-mcp.ps1')],
    };
  }
  // The SDK transport has no shell option and cmd.exe argv arrays cannot
  // express a quoted spaced .bat path (verified by probe). Invoke the REAL
  // .bat through PowerShell's call operator, which quotes correctly; stdio
  // pipes are inherited, so the initialized handshake is genuine.
  const powershellBat = have('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'])
    ? 'powershell'
    : 'pwsh';
  return {
    command: powershellBat,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${scriptPath(pkg, 'start-mcp.bat')}'`],
  };
}

async function handshakeViaLauncher(kind, pkg) {
  const launch = launchOf(kind, pkg);
  return runSmoke({
    serverEntry: path.resolve(path.join(pkg, 'dist', 'index.js')),
    launch,
    tool: 'smoke_ping',
    toolArgs: {},
    timeoutMs: 25000,
    cwd: path.resolve(UNRELATED),
    // Realistic console env: the SDK default safe-env on win32 omits
    // PATHEXT, under which Windows `node` lookup (ps1 Get-Command, bat
    // where) fails. Real launcher invocations inherit a full console env.
    env: { ...process.env },
  });
}

describe('W07 start-mcp --dry-run names the shipped entry (control)', () => {
  it('sh dry-run names dist/index.js', () => {
    if (!HAVE_BASH) return;
    expect(dryRunOutput('bash', [scriptPath(PKG, 'start-mcp.sh'), '--dry-run'])).toMatch(/dist[/\\]index\.js/);
  });

  it('ps1 dry-run names dist/index.js', () => {
    if (!HAVE_POWERSHELL) return;
    const powershell = have('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'])
      ? 'powershell'
      : 'pwsh';
    expect(
      dryRunOutput(powershell, [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath(PKG, 'start-mcp.ps1'),
        '-DryRun',
      ]),
    ).toMatch(/dist[/\\]index\.js/);
  }, 30000);

  it('bat dry-run names dist/index.js', () => {
    if (!HAVE_CMD) return;
    // cmd.exe argv quoting cannot express a spaced .bat path via spawn
    // arrays (verified by probe: `'"spaced"' is not recognized`). With
    // shell:true, cmd.exe applies its documented quote handling to the
    // command string. Still executes the REAL .bat file. Combined output:
    // the bat logs plans on stderr by convention.
    const script = scriptPath(PKG, 'start-mcp.bat');
    const r = spawnSync(`"${script}" --dry-run`, {
      encoding: 'utf-8',
      cwd: path.resolve(UNRELATED),
      timeout: 30000,
      shell: 'cmd.exe',
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).toMatch(/dist[/\\]index\.js/);
  });
});

describe('W07 start-mcp real execution serves the shipped entry (regression)', () => {
  it('sh launcher passes initialized smoke_ping with no src/ present', async () => {
    if (!HAVE_BASH) return;
    const verdict = await handshakeViaLauncher('sh', PKG);
    expect(verdict.reason).not.toMatch(/Connection closed|MODULE_NOT_FOUND|ENOENT/);
    expect(verdict.pass).toBe(true);
  }, 60000);

  it('ps1 launcher passes initialized smoke_ping with no src/ present', async () => {
    if (!HAVE_POWERSHELL) return;
    const verdict = await handshakeViaLauncher('ps1', PKG);
    expect(verdict.reason).not.toMatch(/Connection closed|MODULE_NOT_FOUND|ENOENT/);
    expect(verdict.pass).toBe(true);
  }, 60000);

  it('bat launcher passes initialized smoke_ping with no src/ present', async () => {
    if (!HAVE_CMD) return;
    const verdict = await handshakeViaLauncher('bat', PKG);
    expect(verdict.reason).not.toMatch(/Connection closed|MODULE_NOT_FOUND|ENOENT/);
    expect(verdict.pass).toBe(true);
  }, 60000);

  it('sh launcher keeps src fallback when dist is absent (dev layout)', async () => {
    if (!HAVE_BASH) return;
    const launch = launchOf('sh', SRC_ONLY_PKG);
    const verdict = await runSmoke({
      serverEntry: path.resolve(path.join(SRC_ONLY_PKG, 'src', 'index.js')),
      launch,
      tool: 'smoke_ping',
      toolArgs: {},
      timeoutMs: 25000,
      cwd: path.resolve(UNRELATED),
    });
    expect(verdict.pass).toBe(true);
  }, 60000);
});

// Silence unused-const lint for the declarative launcher table.
void SH;
void PS1;
void BAT;
