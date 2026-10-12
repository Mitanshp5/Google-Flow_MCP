import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import {
  navigateSidebarDetailed,
  navigateToSidebar,
  getActiveSidebarSection,
  readSidebarEvidence,
} from '../src/navigation/project-navigator.js';
import { withPage } from '../src/browser/session-scope.js';
import { handleOpenToolsGallery } from '../src/tools/open-tools-gallery.js';
import { getUiLease } from '../src/browser/ui-transaction.js';

// Local-only material sidebar fixture mirroring sanitized live evidence
// (mat-nav-list[role=navigation] under mat-sidenav.project-sidenav,
// mdc-list-item--activated selection, span[matlistitemtitle] owning labels).
// Served from a Flow project URL via local route fulfillment (no network,
// no live browser, no QA project IDs). Fixture labelled local throughout.
const LOCAL_PROJECT_URL = 'https://flow.google.com/project/fixture-local-sidebar';

function localItem(label, icon, opts = {}) {
  const activated = opts.activated
    ? ' mdc-list-item--activated'
    : '';
  const extra = opts.cls ? ` ${opts.cls}` : '';
  const disabled = opts.disabled ? ' aria-disabled="true"' : ' aria-disabled="false"';
  const style = opts.hidden ? ' style="display:none"' : '';
  return `<mat-list-item data-route="${opts.route || '#/x'}" class="mat-mdc-list-item mdc-list-item mat-mdc-list-item-interactive mdc-list-item--with-leading-icon${activated}${extra}"${disabled}${style}>`
    + `<mat-icon role="img" class="mat-icon notranslate google-symbols" aria-hidden="true"> ${icon} </mat-icon>`
    + `<span class="mdc-list-item__content"><span matlistitemtitle="" class="mat-mdc-list-item-title mdc-list-item__primary-text">${label}</span></span></mat-list-item>`;
}

function localToolsAnchor(opts = {}) {
  const activated = opts.activated
    ? ' mdc-list-item--activated'
    : '';
  const style = opts.hidden ? ' style="display:none"' : '';
  return `<a mat-list-item="" data-route="#/tools" href="#/tools" class="mat-mdc-list-item mdc-list-item mat-mdc-list-item-interactive mdc-list-item--with-leading-icon${activated}" aria-disabled="false"${style}>`
    + `<mat-icon role="img" class="mat-icon notranslate google-symbols" aria-hidden="true">apps_spark_2</mat-icon>`
    + `<span class="mdc-list-item__content"><span matlistitemtitle="" class="mat-mdc-list-item-title mdc-list-item__primary-text">Tools</span></span></a>`;
}

// Base local fixture: real nav root only (no HTML nav, no *sidebar* class),
// class-only selection, icon+owning-label items, out-of-nav Tools decoy,
// inactive + lookalike decoys outside the nav, composer for app readiness.
function localMaterialFixture({ selected = 'All media', toolsHidden = false } = {}) {
  const is = (label) => (selected === label ? { activated: true } : {});
  return `<!doctype html><html><head><title>Google Flow local</title></head><body>
<div class="page-layout"><flow-project-page><flow-project-sidenav-container class="has-header-offset">
<mat-sidenav-container class="mat-drawer-container mat-sidenav-container sidenav">
<mat-sidenav class="mat-drawer mat-sidenav project-sidenav mat-drawer-opened mat-drawer-side">
<div class="mat-drawer-inner-container"><flow-project-nav-list>
<mat-nav-list role="navigation" class="mat-mdc-nav-list mat-mdc-list-base mdc-list"><div>
${localItem('All media', 'dashboard', { ...is('All media'), route: '#/all' })}
${localItem('Images', 'image', { ...is('Images'), route: '#/images' })}
${localItem('Characters', 'accessibility_new', { ...is('Characters'), route: '#/characters' })}
${localItem('Scenes', 'movie', { ...is('Scenes'), route: '#/scenes' })}
${localItem('Uploads', 'drive_folder_upload', { ...is('Uploads'), route: '#/uploads' })}
${localToolsAnchor({ activated: selected === 'Tools', hidden: toolsHidden })}
</div></mat-nav-list></flow-project-nav-list></div></mat-sidenav>
</mat-sidenav-container></flow-project-sidenav-container></flow-project-page></div>
<main><h1 id="local-heading">${selected}</h1>
<div class="composer"><textarea placeholder="Describe"></textarea></div>
<section id="local-tools-gallery" style="display:${selected === 'Tools' ? 'block' : 'none'}"><h2>Explore tools</h2><button>My Tools</button><button>Community</button><button>Templates</button></section>
</main>
<section class="gallery"><button data-local-tile>Tools</button></section>
<span class="inactive">Trash</span>
<mat-list-item class="mat-mdc-list-item mdc-list-item mdc-list-item--activated-lookalike"><span>Fake</span></mat-list-item>
<script>
document.querySelectorAll('mat-nav-list[role="navigation"] mat-list-item, mat-nav-list[role="navigation"] a').forEach((el) => {
  el.addEventListener('click', () => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    document.querySelectorAll('mat-nav-list[role="navigation"] .mdc-list-item--activated').forEach((x) => x.classList.remove('mdc-list-item--activated'));
    el.classList.add('mdc-list-item--activated');
    const owning = el.querySelector('span[matlistitemtitle], .mdc-list-item__primary-text');
    const label = owning ? owning.textContent.trim() : el.textContent.trim();
    document.getElementById('local-heading').textContent = label;
    const route = el.getAttribute('data-route');
    if (route) window.location.hash = route;
    const g = document.getElementById('local-tools-gallery');
    if (g) g.style.display = (label === 'Tools') ? 'block' : 'none';
  });
});
window.__localGalleryClicks = 0;
document.querySelector('[data-local-tile]').addEventListener('click', () => { window.__localGalleryClicks += 1; });
</script>
</body></html>`;
}

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
});

async function newLocalPage(html, url = LOCAL_PROJECT_URL) {
  const page = await browser.newPage();
  await page.route('https://flow.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('real sidebar live-derived repair (local fixtures only)', () => {
  it('reads Images selection via exact activated class + owning label', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'Images' }));
    try {
      const evidence = await readSidebarEvidence(page);
      const active = await getActiveSidebarSection(page);
      const heading = await page.textContent('#local-heading');
      expect(evidence?.selected).toBe('Images');
      expect(active).toBe('Images');
      expect(heading.trim()).toBe('Images');
    } finally {
      await page.close();
    }
  }, 30000);

  it('reads All media owning label without dashboard ligature pollution', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media' }));
    try {
      const evidence = await readSidebarEvidence(page);
      const active = await getActiveSidebarSection(page);
      expect(evidence?.selected).toBe('All media');
      expect(active).toBe('All media');
    } finally {
      await page.close();
    }
  }, 30000);

  it('navigates Images from All media with selected-item evidence (boolean true)', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media' }));
    try {
      const res = await navigateSidebarDetailed(page, 'Images', { pollMs: 1500 });
      const nav = await navigateToSidebar(page, 'Images', { pollMs: 1500 }).catch(() => null);
      void nav;
      const heading = await page.textContent('#local-heading');
      const hash = await page.evaluate(() => window.location.hash);
      const active = await getActiveSidebarSection(page);
      const galleryClicks = await page.evaluate(() => window.__localGalleryClicks);
      expect(res.ok).toBe(true);
      expect(res.active).toBe('Images');
      expect(active).toBe('Images');
      expect(heading.trim()).toBe('Images');
      expect(hash).toBe('#/images');
      expect(galleryClicks).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('navigateToSidebar preserves public boolean return (true/false, no .ok shape)', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media' }));
    try {
      const ok = await navigateToSidebar(page, 'Images', { pollMs: 1500 });
      expect(ok).toBe(true);
      expect(typeof ok).toBe('boolean');
      const miss = await navigateToSidebar(page, 'NoSuchSection', { pollMs: 500 });
      expect(miss).toBe(false);
      expect(typeof miss).toBe('boolean');
    } finally {
      await page.close();
    }
  }, 30000);

  it('navigates Tools route with gallery readiness via boolean caller (not nav.ok)', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media' }));
    try {
      const nav = await navigateToSidebar(page, 'Tools', { pollMs: 1500 });
      const active = await getActiveSidebarSection(page);
      const galleryClicks = await page.evaluate(() => window.__localGalleryClicks);
      const galleryText = await page.textContent('#local-tools-gallery');
      // Boolean caller: true is truthy; old nav.ok check would read undefined.
      expect(nav).toBe(true);
      expect(nav.ok).toBe(undefined);
      expect(!!nav).toBe(true);
      expect(active).toBe('Tools');
      expect(galleryText).toContain('Explore tools');
      expect(galleryText).toContain('My Tools');
      expect(galleryClicks).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('opens Tools gallery through actual gallery handler (local, no remote)', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media' }));
    try {
      const res = await withPage(page, async () => handleOpenToolsGallery());
      const bodyText = await page.textContent('body');
      expect(res.status).toBe('opened');
      expect(String(res.url)).toContain('flow.google.com/project/fixture-local-sidebar');
      expect(bodyText).toContain('Explore tools');
    } finally {
      await page.close();
    }
  }, 30000);

  it('never reports inactive-class or lookalike-class decoys as selected', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html><body><mat-sidenav class="mat-drawer mat-sidenav project-sidenav">`
        + `<mat-nav-list role="navigation"><div>`
        + `<span class="inactive">Trash</span>`
        + `<mat-list-item class="mat-mdc-list-item mdc-list-item mdc-list-item--activated-lookalike"><span matlistitemtitle="">Fake</span></mat-list-item>`
        + `</div></mat-nav-list></mat-sidenav></body></html>`,
        { waitUntil: 'domcontentloaded' },
      );
      await expect(getActiveSidebarSection(page)).resolves.toBe(null);
      const evidence = await readSidebarEvidence(page);
      expect(evidence?.selected ?? null).toBe(null);
    } finally {
      await page.close();
    }
  }, 30000);

  it('never clicks generic out-of-nav Tools decoy or hidden real Tools', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media', toolsHidden: true }));
    try {
      const res = await navigateSidebarDetailed(page, 'Tools', { pollMs: 800 });
      const active = await getActiveSidebarSection(page);
      const galleryClicks = await page.evaluate(() => window.__localGalleryClicks);
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/sidebar-nav-blocked/);
      expect(active).toBe('All media');
      expect(galleryClicks).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('preserves false for missing scope and wrong selected item', async () => {
    const noScope = await newLocalPage(
      `<!doctype html><html><head><title>Flow local</title></head><body>`
      + `<main><h1 id="local-heading">All media</h1><div class="composer"><textarea></textarea></div></main>`
      + `<section class="gallery"><button data-local-tile>Tools</button></section></body></html>`,
    );
    try {
      const res = await navigateSidebarDetailed(noScope, 'Tools', { pollMs: 500 });
      expect(res.ok).toBe(false);
      expect(res.active).toBe(null);
      await expect(getActiveSidebarSection(noScope)).resolves.toBe(null);
    } finally {
      await noScope.close();
    }
    const wrong = await newLocalPage(localMaterialFixture({ selected: 'Images' }));
    try {
      const res = await navigateSidebarDetailed(wrong, 'NoSuchSection', { pollMs: 500 });
      expect(res.ok).toBe(false);
      expect(await getActiveSidebarSection(wrong)).toBe('Images');
    } finally {
      await wrong.close();
    }
  }, 30000);

  it('blocks 404 and auth pages even with selected material item (local)', async () => {
    const notFound = await newLocalPage(
      `<!doctype html><html><head><title>Error: 404</title></head><body>`
      + `<mat-sidenav class="mat-drawer mat-sidenav project-sidenav"><div class="mat-drawer-inner-container">`
      + `<mat-nav-list role="navigation"><div>`
      + `${localItem('Images', 'image', { activated: true, route: '#/images' })}`
      + `</div></mat-nav-list></div></mat-sidenav>`
      + `<main><h1>Error: 404</h1><p>Error: 404 page not found</p><textarea></textarea></main></body></html>`,
    );
    try {
      const res = await navigateSidebarDetailed(notFound, 'Images', { pollMs: 500 });
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/sidebar-nav-blocked/);
    } finally {
      await notFound.close();
    }
    const auth = await newLocalPage(
      `<!doctype html><html><head><title>Sign in</title></head><body>`
      + `<mat-sidenav class="mat-drawer mat-sidenav project-sidenav"><div class="mat-drawer-inner-container">`
      + `<mat-nav-list role="navigation"><div>`
      + `${localItem('Images', 'image', { activated: true, route: '#/images' })}`
      + `</div></mat-nav-list></div></mat-sidenav>`
      + `<main><h1>Sign in</h1><p>Sign in to continue</p><textarea></textarea></main></body></html>`,
    );
    try {
      const res = await navigateSidebarDetailed(auth, 'Images', { pollMs: 500 });
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/sidebar-nav-blocked/);
    } finally {
      await auth.close();
    }
  }, 30000);

  it('blocks mismatched non-Flow application URL (local unknown app)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(localMaterialFixture({ selected: 'Images' }), { waitUntil: 'domcontentloaded' });
      const res = await navigateSidebarDetailed(page, 'Images', { pollMs: 500 });
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/sidebar-nav-blocked/);
    } finally {
      await page.close();
    }
  }, 30000);

  it('keeps legacy nav (HTML nav + aria-current) working (local legacy control)', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://flow.google.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Flow local legacy</title></head><body>
<div class="app"><nav class="sidebar" aria-label="Project">
<mat-list-item data-route="#/all" aria-current="page"><span>All media</span></mat-list-item>
<mat-list-item data-route="#/characters"><span>Characters</span></mat-list-item>
<mat-list-item data-route="#/scenes"><span>Scenes</span></mat-list-item>
<a data-route="#/tools" href="#/tools"><span class="icon">apps_spark_2</span><span>Tools</span></a>
</nav>
<main><h1 id="local-heading">All media</h1><div class="composer"><textarea></textarea></div></main>
<section class="gallery"><button data-local-tile>Tools</button></section></div>
<script>
document.querySelectorAll('.sidebar mat-list-item, .sidebar a').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.sidebar [aria-current]').forEach((x) => x.removeAttribute('aria-current'));
    el.setAttribute('aria-current', 'page');
    window.location.hash = el.getAttribute('data-route');
    document.getElementById('local-heading').textContent = el.textContent;
  });
});
window.__localGalleryClicks = 0;
document.querySelector('[data-local-tile]').addEventListener('click', () => { window.__localGalleryClicks += 1; });
</script></body></html>`,
        }),
      );
      await page.goto(LOCAL_PROJECT_URL, { waitUntil: 'domcontentloaded' });
      const res = await navigateSidebarDetailed(page, 'Characters', { pollMs: 1500 });
      const active = await getActiveSidebarSection(page);
      const galleryClicks = await page.evaluate(() => window.__localGalleryClicks);
      expect(res.ok).toBe(true);
      expect(active).toBe('Characters');
      expect(galleryClicks).toBe(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('refuses stale UI lease before click/read-back (local)', async () => {
    const page = await newLocalPage(localMaterialFixture({ selected: 'All media' }));
    try {
      const lease = getUiLease();
      const captured = lease.getEpoch();
      lease.fence();
      const res = await navigateSidebarDetailed(page, 'Images', { pollMs: 500, epoch: captured });
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/ui lease stale/);
    } finally {
      await page.close();
    }
  }, 30000);
});

// Parent boundary probes: owning/selection negatives reproduced through the
// actual exports on local semantic HTML (no live browser, no QA IDs).
const LOCAL_PARENT_URL = 'https://flow.google.com/project/local-parent-boundary';

const parentItem = (name, cls = '', hidden = false, disabled = false) =>
  `<mat-list-item class="${cls}"${hidden ? ' style="display:none"' : ''}${disabled ? ' aria-disabled="true"' : ''}><span matlistitemtitle>${name}</span></mat-list-item>`;

async function parentBoundaryPage(items, scoped = true) {
  const page = await browser.newPage();
  const html = `<!doctype html><html><head><title>Flow local</title></head><body>`
    + `<style>mat-list-item{display:block;padding:10px}textarea{display:block}</style>`
    + `${scoped ? '<mat-sidenav class="project-sidenav"><mat-nav-list role="navigation">' : ''}`
    + `${items}`
    + `${scoped ? '</mat-nav-list></mat-sidenav>' : ''}`
    + `<textarea></textarea></body></html>`;
  await page.route('https://flow.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(LOCAL_PARENT_URL, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('parent owning/selection boundaries (local fixtures only)', () => {
  it('unscoped material-looking tile is not sidebar selection', async () => {
    const page = await parentBoundaryPage(parentItem('Images', 'mdc-list-item--activated'), false);
    try {
      expect((await readSidebarEvidence(page))?.selected ?? null).toBe(null);
      expect(await getActiveSidebarSection(page)).toBe(null);
    } finally {
      await page.close();
    }
  }, 30000);

  it('hidden activated decoy cannot override visible selected All media', async () => {
    const page = await parentBoundaryPage(
      parentItem('Images', 'mdc-list-item--activated', true) + parentItem('All media', 'mdc-list-item--activated'),
    );
    try {
      expect((await readSidebarEvidence(page))?.selected).toBe('All media');
      expect(await getActiveSidebarSection(page)).toBe('All media');
    } finally {
      await page.close();
    }
  }, 30000);

  it('click without selected UI change cannot become ready from hidden Images selection', async () => {
    const page = await parentBoundaryPage(
      parentItem('Images', 'mdc-list-item--activated', true)
      + parentItem('All media', 'mdc-list-item--activated')
      + parentItem('Images'),
    );
    try {
      const res = await navigateSidebarDetailed(page, 'Images', { pollMs: 250 });
      expect(res.ok).toBe(false);
      expect(await page.locator('mat-list-item.mdc-list-item--activated:visible').innerText()).toBe('All media');
    } finally {
      await page.close();
    }
  }, 30000);

  it('conflicting visible activated selections remain unknown', async () => {
    const page = await parentBoundaryPage(
      parentItem('Images', 'mdc-list-item--activated') + parentItem('All media', 'mdc-list-item--activated'),
    );
    try {
      expect((await readSidebarEvidence(page))?.selected ?? null).toBe(null);
      expect(await getActiveSidebarSection(page)).toBe(null);
    } finally {
      await page.close();
    }
  }, 30000);

  it('same-label multiple visible owning controls deny ambiguity before click', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://flow.google.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Flow local</title></head><body>`
            + `<style>mat-list-item{display:block;padding:10px}textarea{display:block}</style>`
            + `<mat-sidenav class="project-sidenav"><mat-nav-list role="navigation">`
            + parentItem('All media', 'mdc-list-item--activated')
            + `<mat-list-item data-local-dup><span matlistitemtitle>Images</span></mat-list-item>`
            + `<mat-list-item data-local-dup><span matlistitemtitle>Images</span></mat-list-item>`
            + `</mat-nav-list></mat-sidenav><textarea></textarea>`
            + `<script>window.__localDupClicks = 0;`
            + `document.querySelectorAll('[data-local-dup]').forEach((el) => el.addEventListener('click', () => {`
            + ` window.__localDupClicks += 1;`
            + ` document.querySelectorAll('mat-nav-list .mdc-list-item--activated').forEach((x) => x.classList.remove('mdc-list-item--activated'));`
            + ` el.classList.add('mdc-list-item--activated'); }));</script>`
            + `</body></html>`,
        }),
      );
      await page.goto(LOCAL_PARENT_URL, { waitUntil: 'domcontentloaded' });
      const res = await navigateSidebarDetailed(page, 'Images', { pollMs: 250 });
      const dupClicks = await page.evaluate(() => window.__localDupClicks);
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/sidebar-nav-blocked/);
      expect(dupClicks).toBe(0);
      expect(await getActiveSidebarSection(page)).toBe('All media');
    } finally {
      await page.close();
    }
  }, 30000);

  it('disabled owning items are never trusted for match or selection', async () => {
    const nav = await parentBoundaryPage(
      parentItem('All media', 'mdc-list-item--activated')
      + parentItem('Images', '', false, true),
    );
    try {
      const res = await navigateSidebarDetailed(nav, 'Images', { pollMs: 250 });
      expect(res.ok).toBe(false);
      expect(res.blocker).toMatch(/sidebar-nav-blocked/);
      expect(await getActiveSidebarSection(nav)).toBe('All media');
    } finally {
      await nav.close();
    }
    const read = await parentBoundaryPage(parentItem('Images', 'mdc-list-item--activated', false, true));
    try {
      expect((await readSidebarEvidence(read))?.selected ?? null).toBe(null);
      expect(await getActiveSidebarSection(read)).toBe(null);
    } finally {
      await read.close();
    }
  }, 30000);
});

// Parent core-review leads: executed counterexamples to the frozen candidate,
// reproduced here through the actual exports on local semantic HTML.
const LOCAL_REVIEW_URL = 'https://flow.google.com/project/local-parent-review';

async function reviewPage(body) {
  const page = await browser.newPage();
  const html = `<style>mat-list-item,flow-image-tile{display:block;min-width:100px;min-height:35px}button{min-width:80px;min-height:30px}</style>`
    + `${body}<textarea></textarea>`;
  await page.route('https://flow.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(LOCAL_REVIEW_URL, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('parent core review leads (local fixtures only)', () => {
  it('unlabelled selected owning item prevents named singleton certification', async () => {
    const page = await reviewPage(
      '<nav><mat-list-item class="mdc-list-item--activated"><span matlistitemtitle>Images</span></mat-list-item>'
      + '<mat-list-item class="mdc-list-item--activated"><span matlistitemtitle></span></mat-list-item></nav>',
    );
    try {
      expect((await readSidebarEvidence(page))?.selected ?? null).toBe(null);
    } finally {
      await page.close();
    }
  }, 30000);

  it('broad nav substring outside trusted census cannot receive a click', async () => {
    const page = await reviewPage(
      '<nav><button class="active">All media</button></nav>'
      + '<div class="navbar-decoy"><button onclick="window.clicked=true">Images</button></div>'
      + '<script>window.clicked=false</script>',
    );
    try {
      await navigateSidebarDetailed(page, 'Images', { pollMs: 100 });
      expect(await page.evaluate(() => window.clicked)).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it('disabled owning custom item cannot receive a click', async () => {
    const page = await reviewPage(
      '<nav><mat-list-item disabled onclick="window.clicked=true"><span matlistitemtitle>Images</span></mat-list-item></nav>'
      + '<script>window.clicked=false</script>',
    );
    try {
      await navigateSidebarDetailed(page, 'Images', { pollMs: 100 });
      expect(await page.evaluate(() => window.clicked)).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);
});
