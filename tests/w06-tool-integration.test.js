import { beforeAll, afterAll, it, expect } from 'vitest';
import { w00LaunchBrowser } from './helpers/w00-dom.js';
import { withPage } from '../src/browser/session-scope.js';
import { handleToolCall } from '../src/index.js';
import { getUiLease } from '../src/browser/ui-transaction.js';
import { jobQueue } from '../src/queue/job-queue.js';
let browser;
const url = 'https://flow.google.com/project/tool-integration';
beforeAll(async () => { browser = await w00LaunchBrowser(); });
afterAll(async () => { jobQueue.reset(); await browser.close(); }, 30000);
async function fixture(html, fn) {
 getUiLease().reset(); jobQueue.reset();
 const page = await browser.newPage();
 await page.route('**/*', r => r.fulfill({contentType:'text/html',body:html}));
 await page.goto(url);
 try { await fn(page); } finally { await page.close(); }
}
async function call(page,name,args) {
 return JSON.parse((await withPage(page,() => handleToolCall(name,{project_url:url,...args}))).content[0].text);
}
const shell = '<nav class="sidebar"><a href="#tools">Tools</a></nav><button aria-label="Agent mode" aria-pressed="false">Agent</button>';
it('arbitrary tool never guesses a route or writes unrelated composer',async () => {
 await fixture(shell + '<textarea aria-label="Prompt"></textarea>',async page => {
  const res = await call(page,'flow_use_tool',{tool_name:'Imaginary',params:{Prompt:'Unsafe'}});
  expect(res.status).toBe('blocked');
  expect(page.url()).not.toContain('/tools/imaginary');
  expect(await page.locator('textarea').inputValue()).toBe('');
 });
},30000);
it('verified feature reports unsupported parameters without CSS interpolation',async () => {
 await fixture(shell + '<section data-tool="Palette"><textarea name="Prompt"></textarea></section>',async page => {
  const key = 'x"] , textarea';
  const res = await call(page,'flow_use_tool',{tool_name:'Palette',params:{Prompt:'Colors',count:2,[key]:'injection'}});
  expect(res.status).toBe('prepared_unverified');
  expect(res.unapplied_fields).toEqual(expect.arrayContaining(['count',key]));
  expect(await page.locator('textarea').inputValue()).toBe('Colors');
 });
},30000);
it('exact arbitrary feature and field can report tool opened without submitting',async () => {
 await fixture(shell + '<form aria-label="Palette"><textarea name="Prompt"></textarea><button onclick="window.spent=true">Generate</button></form>',async page => {
  const res = await call(page,'flow_use_tool',{tool_name:'Palette',params:{Prompt:'Colors'}});
  expect(res.status).toBe('tool_opened');
  expect(res.unapplied_fields).toEqual([]);
  expect(await page.locator('textarea').inputValue()).toBe('Colors');
  expect(await page.evaluate(() => window.spent)).toBeUndefined();
 });
},30000);
it('wrong named tool form stays untouched',async () => {
 await fixture(shell + '<form aria-label="Other"><textarea name="Prompt">Original</textarea></form>',async page => {
  const res = await call(page,'flow_use_tool',{tool_name:'Palette',params:{Prompt:'Colors'}});
  expect(res.status).toBe('blocked');
  expect(await page.locator('textarea').inputValue()).toBe('Original');
 });
},30000);
