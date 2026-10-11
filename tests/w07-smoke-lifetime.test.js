// W07-A3: runSmoke bounded entire lifetime (parent corrections).
// connect used to sit outside any deadline and the timer was never cleared.
// Every case below must settle within its budget with children reaped and
// no lingering timer: stalled initialize, stalled tools/call, malformed
// reply, spawn failure, invalid timeout, plus cwd + positive/negative
// fixture paths. No browser anywhere; fixture server only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { runSmoke } from '../scripts/smoke-client.mjs';
import { fixtureServerEntry } from '../scripts/smoke-fixture-server.mjs';

const fixtureSmokeEntry = () => path.resolve(fixtureServerEntry());

const LANE_SCRATCH = path.join('reliability-evidence', 'package', 'scratch');
let unrelatedCwd = '';

beforeAll(() => {
  fs.mkdirSync(LANE_SCRATCH, { recursive: true });
  unrelatedCwd = fs.mkdtempSync(path.join(LANE_SCRATCH, 'w07-cwd-'));
});

afterAll(() => {
  fs.rmSync(unrelatedCwd, { recursive: true, force: true });
});

describe('W07-A3 runSmoke lifetime and subprocess behavior', () => {
  it('rejects a non-positive timeout without spawning (SMOKE_USAGE_ERROR)', async () => {
    const started = Date.now();
    const verdict = await runSmoke({ serverEntry: fixtureSmokeEntry(), tool: 'smoke_ping', timeoutMs: 0 });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_USAGE_ERROR/);
  });

  it('rejects a non-finite timeout without spawning', async () => {
    const verdict = await runSmoke({ serverEntry: fixtureSmokeEntry(), tool: 'smoke_ping', timeoutMs: NaN });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_USAGE_ERROR/);
  });

  it('stalled initialize settles as SMOKE_TIMEOUT within budget (connect inside deadline)', async () => {
    const started = Date.now();
    const verdict = await runSmoke({
      serverEntry: fixtureSmokeEntry(),
      serverArgs: ['--mode', 'stall-init'],
      tool: 'smoke_ping',
      timeoutMs: 3000,
    });
    expect(Date.now() - started).toBeLessThan(25000);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TIMEOUT/);
  }, 30000);

  it('stalled tools/call settles as SMOKE_TIMEOUT within budget', async () => {
    const started = Date.now();
    const verdict = await runSmoke({
      serverEntry: fixtureSmokeEntry(),
      serverArgs: ['--mode', 'stall-call'],
      tool: 'smoke_ping',
      timeoutMs: 3000,
    });
    expect(Date.now() - started).toBeLessThan(25000);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TIMEOUT/);
  }, 30000);

  it('malformed reply fails closed quickly (never passes)', async () => {
    const started = Date.now();
    const verdict = await runSmoke({
      serverEntry: fixtureSmokeEntry(),
      serverArgs: ['--mode', 'malformed'],
      tool: 'smoke_ping',
      timeoutMs: 15000,
    });
    expect(Date.now() - started).toBeLessThan(30000);
    expect(verdict.pass).toBe(false);
  }, 40000);

  it('spawn failure (missing entry) fails closed as SMOKE_SPAWN_ERROR', async () => {
    const verdict = await runSmoke({
      serverEntry: path.join('reliability-evidence', 'package', 'qa-nonexistent-entry.js'),
      tool: 'smoke_ping',
      timeoutMs: 15000,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_(SPAWN_ERROR|NOT_INITIALIZED|MISSING_RESULT)/);
  }, 40000);

  it('fixture struct-error tool fails closed end to end', async () => {
    const verdict = await runSmoke({ serverEntry: fixtureSmokeEntry(), tool: 'smoke_struct_error', timeoutMs: 15000 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_TOOL_ERROR/);
  }, 30000);

  it('fixture empty-content tool fails closed end to end', async () => {
    const verdict = await runSmoke({ serverEntry: fixtureSmokeEntry(), tool: 'smoke_empty', timeoutMs: 15000 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/SMOKE_(TOOL_ERROR|EMPTY_RESULT|MISSING_RESULT)/);
  }, 30000);

  it('positive fixture ping passes from an unrelated cwd', async () => {
    const verdict = await runSmoke({
      serverEntry: fixtureSmokeEntry(),
      tool: 'smoke_ping',
      timeoutMs: 15000,
      cwd: unrelatedCwd,
    });
    expect(verdict.pass).toBe(true);
  }, 30000);

  it('imported runSmoke leaves no lingering timer: subprocess exits on its own', () => {
    const started = Date.now();
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(path.resolve('scripts/smoke-client.mjs')).href)}).then(async (m) => {` +
          ` const v = await m.runSmoke({ serverEntry: ${JSON.stringify(fixtureSmokeEntry())},` +
          ` serverArgs: ['--mode','stall-init'], tool: 'smoke_ping', timeoutMs: 1500 });` +
          ` console.log(v.reason); });`,
      ],
      { encoding: 'utf-8', timeout: 30000, cwd: unrelatedCwd },
    );
    expect(Date.now() - started).toBeLessThan(25000);
    expect(out).toMatch(/SMOKE_TIMEOUT/);
  }, 40000);

  it('lane scratch lives under the allowed lane, not system temp', () => {
    expect(path.resolve(LANE_SCRATCH).startsWith(path.resolve('reliability-evidence'))).toBe(true);
    expect(path.resolve(LANE_SCRATCH)).not.toMatch(/AppData.*Temp/i);
  });
});
