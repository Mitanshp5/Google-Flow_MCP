import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleToolCall } from '../src/index.js';
import { withPage } from '../src/browser/session-scope.js';
import { createUiLease } from '../src/browser/session.js';
import { withUiTransaction } from '../src/browser/ui-transaction.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { w00LaunchBrowser, w00CloseBrowser } from './helpers/w00-dom.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-parent-boundaries-'));
const previousHome = process.env.FLOW_HOME;
process.env.FLOW_HOME = root;
const url = 'https://flow.google.com/project/parent-boundary';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function pageFor(body) {
  const page = await (await w00LaunchBrowser()).newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto(url);
  return page;
}
const result = response => JSON.parse(response.content[0].text);
beforeEach(() => jobQueue.reset());
afterAll(async () => {
  await w00CloseBrowser();
  if (previousHome === undefined) delete process.env.FLOW_HOME; else process.env.FLOW_HOME = previousHome;
});

describe('Gate A real dispatcher and UI ownership', () => {
  it('queues unrelated callers while permitting nesting in the owning async transaction', async () => {
    const lease = createUiLease(); const entered = deferred(); const release = deferred(); const order = [];
    const first = lease.run(async () => { order.push('first'); entered.resolve(); await release.promise;
      await lease.run(async () => { order.push('nested'); });
    });
    await entered.promise;
    const second = lease.run(async () => { order.push('second'); });
    await new Promise(r => setTimeout(r, 25));
    const beforeRelease = [...order]; release.resolve(); await Promise.all([first, second]);
    expect(beforeRelease).toEqual(['first']);
    expect(order).toEqual(['first', 'nested', 'second']);
  });
  it('rejects an old transaction nested call after reset rather than adopting the new epoch', async () => {
    const lease = createUiLease();
    await expect(lease.run(async () => { lease.reset(); await lease.run(async () => 'stale action'); }))
      .rejects.toMatchObject({ code: 'STALE_EPOCH' });
  });
  it('serializes dispatcher discovery navigation behind another UI owner', async () => {
    const page = await pageFor('<html><body><button>Test</button></body></html>');
    const entered = deferred(); const release = deferred();
    const owner = withUiTransaction(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const call = withPage(page, () => handleToolCall('flow_discover_ui', { page: 'main', url: 'https://flow.google.com/fixture-discovery' }));
    await new Promise(r => setTimeout(r, 50));
    const beforeRelease = page.url(); release.resolve(); await owner; await call;
    expect(beforeRelease).toBe(url);
    await page.close();
  }, 30000);
  it('blocks character opening on a non-error ordinary composer', async () => {
    const page = await pageFor('<html><body><textarea>Existing prompt</textarea></body></html>');
    try {
      const out = result(await withPage(page, () => handleToolCall('flow_open_characters', { project_url: url })));
      expect(out.status).toBe('blocked');
      expect(out.reason).toBe('character_feature_unverified');
    } finally { await page.close(); }
  }, 30000);
  it('blocks import into an unrelated file input and leaves its fields untouched', async () => {
    const file = path.join(root, 'character.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Hero', description: 'Required character description', reference_images: ['missing.png'] }));
    const page = await pageFor('<html><body><input type="file"><input aria-label="Name" value="Existing"><textarea>Existing prompt</textarea></body></html>');
    try {
      const out = result(await withPage(page, () => handleToolCall('flow_import_character', { file_path: file, project_url: url })));
      expect(out.status).toBe('blocked');
      expect(out.reason).toBe('character_form_not_found');
      expect(await page.inputValue('textarea')).toBe('Existing prompt');
      expect(await page.inputValue('input[aria-label="Name"]')).toBe('Existing');
    } finally { await page.close(); }
  }, 30000);
  it('does not ready a character import with a missing required reference on its native form', async () => {
    const file = path.join(root, 'missing-reference.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Hero', description: 'Character', reference_images: ['missing.png'] }));
    const page = await pageFor('<html><body><h1>Characters</h1><input type="file"><input aria-label="Name"><textarea placeholder="Describe your character"></textarea></body></html>');
    try {
      const out = result(await withPage(page, () => handleToolCall('flow_import_character', { file_path: file, project_url: url })));
      expect(out.status).toBe('prepared_unverified');
      expect(out.unapplied).toContain('reference_images');
    } finally { await page.close(); }
  }, 30000);
  it('requires character name read-back rather than echoing a missing input', async () => {
    const file = path.join(root, 'missing-name.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Hero', description: 'Character' }));
    const page = await pageFor('<html><body><h1>Characters</h1><input type="file"><textarea placeholder="Describe your character"></textarea></body></html>');
    try {
      const out = result(await withPage(page, () => handleToolCall('flow_import_character', { file_path: file, project_url: url })));
      expect(out.status).toBe('prepared_unverified');
      expect(out.unapplied).toContain('name');
    } finally { await page.close(); }
  }, 30000);
  it('reset during import prevents later field mutation by the stale dispatcher actor', async () => {
    const file = path.join(root, 'reset-import.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Hero', description: 'Character' }));
    const page = await pageFor('<html><body><input type="file"><input aria-label="Name" value="Original"><textarea placeholder="Describe your character">Original</textarea></body></html>');
    const entered = deferred(); const release = deferred();
    page.waitForTimeout = async () => { entered.resolve(); await release.promise; };
    const call = withPage(page, () => handleToolCall('flow_import_character', { file_path: file, project_url: url }));
    const outcome = call.catch(e => e);
    await entered.promise;
    await handleToolCall('flow_queue_reset', {});
    release.resolve();
    expect((await outcome).code).toBe('STALE_EPOCH');
    expect(await page.inputValue('input[aria-label="Name"]')).toBe('Original');
    await page.close();
  }, 30000);
  it('blocks discovery when the requested Images tab cannot be verified', async () => {
    const page = await pageFor('<html><body><nav class="sidebar"><mat-list-item aria-current="page">All media</mat-list-item></nav><textarea>Original</textarea></body></html>');
    page.waitForTimeout = async () => {};
    try {
      const out = result(await withPage(page, () => handleToolCall('flow_discover_ui', { page: 'images' })));
      expect(out.status).toBe('blocked');
      expect(out.reason).toBe('requested_view_unverified');
    } finally { await page.close(); }
  }, 30000);
  it('image-generation discovery alias cannot silently discover the homepage', async () => {
    const page = await pageFor('<html><body><nav class="sidebar"><mat-list-item aria-current="page">All media</mat-list-item></nav></body></html>');
    page.waitForTimeout = async () => {};
    try {
      const out = result(await withPage(page, () => handleToolCall('flow_discover_ui', { page: 'image-generation' })));
      expect(out.status).toBe('blocked');
      expect(page.url()).toBe(url);
    } finally { await page.close(); }
  }, 30000);
});
