import { it, expect, vi } from 'vitest';
const launch = vi.hoisted(() => ({ started: null, release: null }));
const discovery = vi.hoisted(() => ({ run: null }));
vi.mock('../src/browser/launch-profile.js', async original => ({
  ...await original(),
  launchKiaraProfile: async () => { launch.started(); return new Promise(resolve => { launch.release = resolve; }); },
}));
vi.mock('../src/navigation/model-discovery.js', async original => ({
  ...await original(),
  discoverModels: (...args) => discovery.run ? discovery.run(...args) : Promise.resolve(null),
}));
import { handleToolCall } from '../src/index.js';
import { getBrowser } from '../src/browser/connect.js';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';
import { withUiTransaction } from '../src/browser/ui-transaction.js';
import { guardUiPage } from '../src/browser/guarded-page.js';
import { withPage } from '../src/browser/session-scope.js';

it('reset during first launch prevents browser publication and subsequent navigation', async () => {
  const browser = await w00LaunchBrowser(); const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Local fixture</body></html>' }));
  await page.setContent('<html><body>Local fixture</body></html>');
  let started; const entered = new Promise(resolve => { started = resolve; }); launch.started = started;
  const outcome = handleToolCall('flow_connect', { open_flow: true }).catch(e => e);
  await entered; await handleToolCall('flow_queue_reset', {});
  launch.release({ browser, page });
  const error = await outcome;
  try {
    expect(getBrowser()).toBe(null);
    expect(page.url()).toBe('about:blank');
    expect(error.code).toBe('STALE_EPOCH');
  } finally { await w00CloseBrowser(); }
}, 30000);

it('guarded locator options preserve real Playwright nested has-filter behavior', async () => {
  const browser = await w00LaunchBrowser(); const page = await browser.newPage();
  await page.setContent('<div><span>Target</span></div><div>Other</div>');
  await withUiTransaction(async ({ epoch }) => {
    const guarded = guardUiPage(page, epoch);
    expect(await guarded.locator('div').filter({ has: guarded.locator('span') }).count()).toBe(1);
  });
  await w00CloseBrowser();
}, 30000);

it('connect keeps UI ownership until delayed discovery has stopped', async () => {
  const browser = await w00LaunchBrowser(); const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body><textarea></textarea></body></html>' }));
  await page.setContent('<html><body>Local</body></html>');
  page.waitForTimeout = async () => {};
  let entered; const ready = new Promise(resolve => { entered = resolve; }); let releaseDiscovery;
  discovery.run = () => { entered(); return new Promise(resolve => { releaseDiscovery = resolve; }); };
  launch.started = () => { queueMicrotask(() => launch.release({ page })); };
  const nativeTimeout = global.setTimeout;
  const timeout = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...args) => nativeTimeout(fn, ms === 25000 ? 0 : ms, ...args));
  let finished = false;
  const call = withPage(page, () => handleToolCall('flow_connect', { open_flow: true })).then(value => { finished = true; return value; });
  await ready; await new Promise(resolve => nativeTimeout(resolve, 30));
  const prematurelyReleased = finished;
  releaseDiscovery(null);
  await call;
  discovery.run = null; timeout.mockRestore(); await w00CloseBrowser();
  expect(prematurelyReleased).toBe(false);
}, 30000);
