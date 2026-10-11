import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('W01 logger root + selector formats + error codes', () => {
  it('logger root follows FLOW_HOME (QA isolation limitation fix)', async () => {
    const originalHome = process.env.FLOW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-loghome-'));
    process.env.FLOW_HOME = home;
    const { getLogDir } = await import('../src/utils/logger.js?loghome=1');
    expect(getLogDir()).toBe(path.join(home, 'logs'));
    if (originalHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = originalHome;
  }, 30000);

  it('selectors ignore nested observations and keep executable lists authoritative', async () => {
    const originalHome = process.env.FLOW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-selhome-'));
    process.env.FLOW_HOME = home;
    const cfgDir = path.join(home, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    // Legacy observation-shaped file: nested objects, no executable arrays.
    fs.writeFileSync(
      path.join(cfgDir, 'selectors.map.json'),
      JSON.stringify({ main: { selectors: { buttons: [{ text: 'x' }] } } }),
    );
    const { getSelectors, noteSelectors } = await import('../src/utils/selectors.js?selobs=1');
    const list = getSelectors('submitButton');
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => typeof s === 'string')).toBe(true);
    // Persisting an executable list must preserve observation keys verbatim
    // at top level (discover-ui reads them there) while versioning the
    // executable envelope.
    noteSelectors('submitButton', ['button[data-test="w01"]']);
    const raw = JSON.parse(fs.readFileSync(path.join(cfgDir, 'selectors.map.json'), 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.main.selectors.buttons[0].text).toBe('x');
    expect(raw.selectors.submitButton[0]).toBe('button[data-test="w01"]');
    const after = getSelectors('submitButton');
    expect(after[0]).toBe('button[data-test="w01"]');
    if (originalHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = originalHome;
  }, 30000);

  it('corrupt selector map is backed up, never silently overwritten with defaults', async () => {
    const originalHome = process.env.FLOW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'w01-selcorrupt-'));
    process.env.FLOW_HOME = home;
    const cfgDir = path.join(home, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'selectors.map.json'), '{broken');
    const { getSelectors } = await import('../src/utils/selectors.js?selcorrupt=1');
    const list = getSelectors('submitButton');
    expect(Array.isArray(list)).toBe(true);
    const backups = fs.readdirSync(cfgDir).filter((n) => n.includes('.corrupt.'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(cfgDir, 'selectors.map.json'), 'utf-8')).toBe('{broken');
    if (originalHome === undefined) delete process.env.FLOW_HOME;
    else process.env.FLOW_HOME = originalHome;
  }, 30000);

  it('explicit storage/policy/contract error codes exist', async () => {
    const { ErrorCodes } = await import('../src/utils/errors.js');
    for (const code of [
      'CONTRACT_INVALID',
      'POLICY_DENIED',
      'STORAGE_CORRUPT',
      'STORAGE_VERSION_UNSUPPORTED',
      'STORAGE_CONFLICT',
      'LOCK_HELD',
      'JOURNAL_INVALID',
    ]) {
      expect(ErrorCodes[code]).toBe(code);
    }
  });
});
