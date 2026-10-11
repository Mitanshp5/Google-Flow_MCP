// W07 Unix occupied-port slice: start-browser.sh must NEVER kill an
// unrelated PID when the CDP port is occupied by a non-CDP process.
// Fixture shell binaries (fake lsof/curl/kill/chrome) make the occupied,
// reuse, and free branches hermetic: no real port is touched, nothing is
// killed, no Chrome launches. Only safe modes + fixture processes run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SLICE = path.join('evidence-v2', 'w07-browser-port');
const SCRATCH = path.join(SLICE, 'scratch');
const PKG = path.join(SCRATCH, 'pkg with spaces');
const UNRELATED = path.join(SCRATCH, 'unrelated cwd');
const FAKEBIN = path.join(SCRATCH, 'fakebin');
const KILL_LOG = path.join(SCRATCH, 'kill.log');
const CHROME_MARKER = path.join(SCRATCH, 'chrome-launched.marker');

function writeExec(rel, content) {
  const p = path.join(SCRATCH, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode: 0o755 });
  return p;
}

beforeAll(() => {
  if (process.platform === 'win32') return;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(path.join(PKG, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(PKG, 'config'), { recursive: true });
  fs.mkdirSync(UNRELATED, { recursive: true });
  fs.mkdirSync(FAKEBIN, { recursive: true });
  // Fresh copy of the REAL launcher under test.
  fs.copyFileSync('scripts/start-browser.sh', path.join(PKG, 'scripts', 'start-browser.sh'));
  // Fake chrome: only leaves a marker if ever launched (must not happen
  // in the blocked test; must happen in the free-port control). Absolute
  // path: the script documents chromeExecutable as a full path.
  const fakeChrome = writeExec(
    path.join('faketools', 'fake-chrome.sh'),
    '#!/usr/bin/env bash\n' +
      `echo "launched $@" >> "${path.resolve(CHROME_MARKER)}"\n` +
      'exit 0\n',
  );
  fs.writeFileSync(
    path.join(PKG, 'config', 'flow.config.json'),
    JSON.stringify({ chromeExecutable: path.resolve(fakeChrome), cdpPort: 19223 }),
  );
  // Fake lsof: LSOF_MODE=inuse -> port busy + fake PID 424242; free -> exit 1.
  writeExec(
    path.join('fakebin', 'lsof'),
    '#!/usr/bin/env bash\n' +
      'if [[ "${LSOF_MODE:-free}" == "inuse" ]]; then\n' +
      '  for a in "$@"; do [[ "$a" == "-ti" ]] && echo "424242" && exit 0; done\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 1\n',
  );
  // Fake curl: CURL_MODE=cdp -> version JSON exit 0; else exit 1 (not CDP).
  writeExec(
    path.join('fakebin', 'curl'),
    '#!/usr/bin/env bash\n' +
      'if [[ "${CURL_MODE:-down}" == "cdp" ]]; then echo "{\\"Browser\\":\\"Fake\\"}"; exit 0; fi\n' +
      'exit 1\n',
  );
  // Fake kill: records argv, never signals anything.
  writeExec(
    path.join('fakebin', 'kill'),
    '#!/usr/bin/env bash\n' +
      `echo "kill $@" >> "${path.resolve(KILL_LOG)}"\n` +
      'exit 0\n',
  );
  if (fs.existsSync(KILL_LOG)) fs.unlinkSync(KILL_LOG);
  if (fs.existsSync(CHROME_MARKER)) fs.unlinkSync(CHROME_MARKER);
});

afterAll(() => {
  if (process.platform === 'win32') return;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function runBrowser(extraEnv = {}) {
  const r = spawnSync('bash', [path.resolve(path.join(PKG, 'scripts', 'start-browser.sh'))], {
    encoding: 'utf-8',
    cwd: path.resolve(UNRELATED),
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${path.resolve(FAKEBIN)}${path.delimiter}${process.env.PATH}`,
      ...extraEnv,
    },
  });
  expect(r.error).toBeUndefined();
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function killLog() {
  return fs.existsSync(KILL_LOG) ? fs.readFileSync(KILL_LOG, 'utf-8') : '';
}

describe.skipIf(process.platform === 'win32')('W07 start-browser.sh occupied-port behavior (regression)', () => {
  it('occupied non-CDP port: never kills, explicit blocker, no launch', () => {
    const { status, output } = runBrowser({ LSOF_MODE: 'inuse', CURL_MODE: 'down' });
    // No kill of any PID (fake or otherwise) may be attempted.
    expect(killLog()).toBe('');
    // No launch may follow a blocked port.
    expect(fs.existsSync(CHROME_MARKER)).toBe(false);
    // Explicit blocker, fail-closed.
    expect(output).toMatch(/PORT_BLOCKED|occupied|not launch/i);
    expect(status).not.toBe(0);
  });

  it('CDP-responding port reuses without kill or launch (control)', () => {
    if (fs.existsSync(KILL_LOG)) fs.unlinkSync(KILL_LOG);
    const { status, output } = runBrowser({ LSOF_MODE: 'inuse', CURL_MODE: 'cdp' });
    expect(killLog()).toBe('');
    expect(fs.existsSync(CHROME_MARKER)).toBe(false);
    expect(output).toMatch(/already running/i);
    expect(status).toBe(0);
  });

  it('free port launches fake chrome without kill (control)', () => {
    if (fs.existsSync(KILL_LOG)) fs.unlinkSync(KILL_LOG);
    if (fs.existsSync(CHROME_MARKER)) fs.unlinkSync(CHROME_MARKER);
    // CURL_MODE=cdp so the post-launch readiness probe succeeds at once
    // (keeps the control fast); the launch itself is what is asserted.
    const { status } = runBrowser({ LSOF_MODE: 'free', CURL_MODE: 'cdp' });
    expect(killLog()).toBe('');
    // Free port still launches (fake chrome marker proves the path intact).
    expect(fs.existsSync(CHROME_MARKER)).toBe(true);
    expect(status).toBe(0);
  });
});
