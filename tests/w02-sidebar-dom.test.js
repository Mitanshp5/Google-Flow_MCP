import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import {
  navigateSidebarDetailed,
  navigateToSidebar,
  getActiveSidebarSection,
} from '../src/navigation/project-navigator.js';

// Semantic DOM fixture mirroring QA evidence: mat-list-item sidebar entries,
// icon-bearing Tools anchor whose spans collapse to glued `apps_spark_2Tools`
// (actual isolated probe), a same-prefix generic tile outside the sidebar
// that must never be clicked, and an `inactive`-class decoy (contains the
// substring `active` but is NOT a selected item).
const FIXTURE = `<!doctype html><html><head><title>Flow project</title></head><body>
<div class="app">
<nav class="sidebar" aria-label="Project">
<mat-list-item data-route="#/all" aria-current="page"><span>All media</span></mat-list-item>
<mat-list-item data-route="#/characters"><span>Characters</span></mat-list-item>
<mat-list-item data-route="#/scenes"><span>Scenes</span></mat-list-item>
<a data-route="#/tools" href="#/tools"><span class="icon">apps_spark_2</span><span>Tools</span></a>
</nav>
<main><h1 id="heading">All media</h1><div class="composer"><textarea placeholder="Describe"></textarea></div></main>
<section class="gallery"><h2>Community tiles</h2><button data-tile>Tools</button></section>
<span class="inactive">Trash</span>
</div>
<script>
document.querySelectorAll('.sidebar mat-list-item, .sidebar a').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.sidebar [aria-current]').forEach((x) => x.removeAttribute('aria-current'));
    el.setAttribute('aria-current', 'page');
    window.location.hash = el.getAttribute('data-route');
    document.getElementById('heading').textContent = el.textContent;
  });
});
window.__galleryClicks = 0;
document.querySelector('[data-tile]').addEventListener('click', () => { window.__galleryClicks += 1; });
</script>
</body></html>`;

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
});

const FLOW_PROJECT_URL = 'https://flow.google.com/project/fixture-dom-probe';

// Serve the fixture from the Flow origin via local route fulfillment (no
// network, no CDP): the URL is a Flow project URL so origin checks are real.
async function newFixturePage() {
  const page = await browser.newPage();
  await page.route('https://flow.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
  );
  await page.goto(FLOW_PROJECT_URL, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('W02 sidebar semantic DOM (isolated headless fixture, no CDP)', () => {
  it('navigates icon-bearing Tools via exact dedicated label with route evidence', async () => {
    const page = await newFixturePage();
    try {
      const res = await navigateSidebarDetailed(page, 'Tools');
      const heading = await page.textContent('#heading');
      const hash = await page.evaluate(() => window.location.hash);
      const galleryClicks = await page.evaluate(() => window.__galleryClicks);
      expect(res.ok).toBe(true);
      expect(heading.replace(/\s+/g, '')).toBe('apps_spark_2Tools');
      expect(hash).toBe('#/tools');
      expect(galleryClicks).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('navigates mat-list-item Characters/Scenes with selected-item evidence', async () => {
    const page = await newFixturePage();
    try {
      const res = await navigateToSidebar(page, 'Characters');
      const selected = await getActiveSidebarSection(page);
      expect(res).toBe(true);
      expect(selected).toBe('Characters');
    } finally {
      await page.close();
    }
  }, 30000);

  it('never reports an inactive-class decoy as the selected section', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html><body><nav class="sidebar"><span class="inactive">Trash</span></nav></body></html>`,
        { waitUntil: 'domcontentloaded' },
      );
      await expect(getActiveSidebarSection(page)).resolves.toBe(null);
    } finally {
      await page.close();
    }
  }, 30000);
});
