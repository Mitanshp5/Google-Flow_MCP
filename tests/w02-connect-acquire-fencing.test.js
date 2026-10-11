import { it, expect, vi } from 'vitest';
import { chromium } from 'playwright';
import { launchKiaraProfile } from '../src/browser/launch-profile.js';
import { getBrowser, launchChromeDirect } from '../src/browser/connect.js';
import { withUiTransaction } from '../src/browser/ui-transaction.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';

for (const [name, acquire] of [
  ['profile attach', () => launchKiaraProfile()],
  ['direct-launch attach', () => launchChromeDirect({ chromePath: process.execPath })],
]) it(`late ${name} after reset does not publish the stale connection`, async () => {
  const browser = await w00LaunchBrowser();
  let release; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const spy = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const outcome = withUiTransaction(acquire).catch(e => e);
  await ready; jobQueue.reset(); release(browser);
  const error = await outcome;
  try {
    expect(getBrowser()).toBe(null);
    expect(error.code).toBe('STALE_EPOCH');
  } finally { spy.mockRestore(); await w00CloseBrowser(); }
}, 30000);
