import { it, expect, vi } from 'vitest';
import { chromium } from 'playwright';
vi.mock('../src/browser/connect.js', () => ({getPage:()=>globalThis.__characterLibraryPage}));
vi.mock('../src/utils/screenshots.js', () => ({takeScreenshot:async()=>null}));
vi.mock('../src/navigation/project-navigator.js', async original => ({
  ...await original(), ensureProjectInContext:async()=>({}), navigateToSidebar:async()=>true,
}));
import {handleCreateCharacter} from '../src/tools/create-character.js';
import {jobQueue} from '../src/queue/job-queue.js';

it('opens the exact New character action instead of matching the sidebar icon or hidden form', async () => {
  const browser = await chromium.launch({headless:true});
  jobQueue.reset();
  try {
    const page = await browser.newPage();
    globalThis.__characterLibraryPage = page;
    page.waitForTimeout = async()=>{};
    await page.setContent(`<nav><button>accessibility_newCharacters</button></nav>
      <div id="ordinary" contenteditable="true" aria-label="What do you want to create?">Existing draft</div>
      <button id="create">New character</button>
      <div id="native" hidden><div id="description" contenteditable="true" aria-label="Describe your character…"></div>
      <button aria-label="Select model family">🍌 Nano Banana 2.1</button></div>
      <script>document.getElementById('create').onclick=()=>{document.getElementById('native').hidden=false;};</script>`);
    const out = await handleCreateCharacter({name:'QA Courier',description:'A blue-jacketed courier.',auto_confirm:false});
    expect(out.status).toBe('ready_for_confirmation');
    expect(await page.locator('#description').textContent()).toBe('A blue-jacketed courier.');
    expect(await page.locator('#ordinary').textContent()).toBe('Existing draft');
  } finally {
    delete globalThis.__characterLibraryPage;
    jobQueue.reset();
    await browser.close();
  }
});
