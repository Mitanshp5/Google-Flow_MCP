import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { classifyAppState, shellReadyFromHtml, extractObservedAccount } from '../src/browser/app-state.js';
import { handleFlowOpen } from '../src/tools/flow-open.js';
import { setPage, setConnected } from '../src/browser/connect.js';

process.env.FLOW_EXPECTED_ACCOUNT = 'probe.account@example.com';

const READY_NO_CHIP = `<!doctype html><html><head><title>Flow project</title></head><body>
<nav class="sidebar" aria-label="Project"><mat-list-item aria-current="page">All media</mat-list-item></nav>
<main><h1>All media</h1><div class="composer"><textarea placeholder="Describe"></textarea></div></main>
</body></html>`;

const READY_WITH_CHIP = `<!doctype html><html><head><title>Flow project</title></head><body>
<div data-account-email="probe.account@example.com" aria-label="Google Account: probe.account@example.com"></div>
<nav class="sidebar" aria-label="Project"><mat-list-item aria-current="page">All media</mat-list-item></nav>
<main><h1>All media</h1><div class="composer"><textarea placeholder="Describe"></textarea></div></main>
</body></html>`;

const LOADING_APP = `<!doctype html><html><head><title>Flow</title></head><body>
<div class="skeleton"><div class="spinner"></div><p>Loading your project…</p></div>
</body></html>`;

let browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
});

async function flowPage(html, projectId = 'probe-acct') {
  const page = await browser.newPage();
  await page.route('https://flow.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(`https://flow.google.com/project/${projectId}`, { waitUntil: 'domcontentloaded' });
  return page;
}

describe('W02 app/account independence (isolated headless fixture, no CDP)', () => {
  it('wrong-app generic textarea is never a hydrated Flow shell', () => {
    const html = '<html><body><textarea></textarea><p>Describe your idea</p></body></html>';
    expect(shellReadyFromHtml(html)).toBe(false);
    const s = classifyAppState({ url: 'https://example.com/app', title: 'Notes', bodyText: 'Describe your idea', html });
    expect(s.app).not.toBe('ready');
  });

  it('hidden script/style text is never shell proof on a Flow URL', () => {
    const html = `<html><body><script>const t="<textarea></textarea>";</script>` +
      `<div style="display:none">Characters</div><p>Loading…</p></body></html>`;
    expect(shellReadyFromHtml(html)).toBe(false);
    expect(extractObservedAccount(html)).toBe(null);
  });

  it('scopes account extraction to owning Google account controls and denies contradictory/ambiguous evidence', () => {
    // Owning Google account control
    expect(extractObservedAccount('<button aria-label="Google Account: probe.account@example.com">Avatar</button>'))
      .toBe('probe.account@example.com');
    expect(extractObservedAccount('<button aria-label="Account switcher: probe.account@example.com">Avatar</button>'))
      .toBe('probe.account@example.com');
    expect(extractObservedAccount('<button aria-label="Signed in as probe.account@example.com">Avatar</button>'))
      .toBe('probe.account@example.com');

    // Unrelated asset / media / card labels are ignored
    expect(extractObservedAccount('<div aria-label="Asset title: probe.account@example.com">Asset</div>'))
      .toBe(null);
    expect(extractObservedAccount('<div aria-label="Media: probe.account@example.com">Asset</div>'))
      .toBe(null);
    expect(extractObservedAccount('<div aria-label="File: probe.account@example.com">Asset</div>'))
      .toBe(null);

    // Prioritizes owning account control over unrelated asset label
    const fixtureWithAsset = '<div><div aria-label="Asset title: other@example.com">Asset</div><button aria-label="Google Account: probe.account@example.com">Avatar</button></div>';
    expect(extractObservedAccount(fixtureWithAsset)).toBe('probe.account@example.com');

    // Contradictory evidence across account controls returns null
    const contradictoryControls = '<div><button aria-label="Google Account: user1@example.com">Avatar</button><button aria-label="Google Account: user2@example.com">Avatar</button></div>';
    expect(extractObservedAccount(contradictoryControls)).toBe(null);

    const contradictoryDataAttr = '<div><div data-account-email="user1@example.com"></div><button aria-label="Google Account: user2@example.com">Avatar</button></div>';
    expect(extractObservedAccount(contradictoryDataAttr)).toBe(null);

    // Matching evidence agrees and returns observed account
    const agreeingEvidence = '<div><div data-account-email="probe.account@example.com"></div><button aria-label="Google Account: probe.account@example.com">Avatar</button></div>';
    expect(extractObservedAccount(agreeingEvidence)).toBe('probe.account@example.com');

    // Conflicting emails inside one account label return null
    expect(extractObservedAccount('<button aria-label="Google Account: creator@example.com (other@example.com)">Avatar</button>'))
      .toBe(null);

    // Repeated identical email inside one account label is valid
    expect(extractObservedAccount('<button aria-label="Google Account: creator@example.com (creator@example.com)">Avatar</button>'))
      .toBe('creator@example.com');

    // Malformed atomic email attribute is not silently shortened
    expect(extractObservedAccount('<span data-account-email="creator@example.com malformed"></span>'))
      .toBe(null);
    expect(extractObservedAccount('<span data-account-email="invalid-not-email"></span>'))
      .toBe(null);
  });

  it('ready shell with unknown account is NOT logged in', async () => {
    const page = await flowPage(READY_NO_CHIP, 'probe-unknown');
    setPage(page);
    setConnected(true);
    try {
      const res = await handleFlowOpen({ url: 'https://flow.google.com/project/probe-unknown', waitFor: 0 });
      expect(res.app).toBe('ready');
      expect(res.isLoggedIn).toBe(false);
      expect(res.account == null || res.account.state === 'unverified').toBe(true);
    } finally {
      await page.close();
      setPage(null);
      setConnected(false);
    }
  }, 30000);

  it('ready shell with positive exact account chip IS logged in', async () => {
    const page = await flowPage(READY_WITH_CHIP, 'probe-verified');
    setPage(page);
    setConnected(true);
    try {
      const res = await handleFlowOpen({ url: 'https://flow.google.com/project/probe-verified', waitFor: 0 });
      expect(res.app).toBe('ready');
      expect(res.isLoggedIn).toBe(true);
      expect(res.account?.state).toBe('verified');
    } finally {
      await page.close();
      setPage(null);
      setConnected(false);
    }
  }, 30000);

  it('real loading app fixture is loading, not ready or logged in', async () => {
    const page = await flowPage(LOADING_APP, 'probe-loading');
    setPage(page);
    setConnected(true);
    try {
      const res = await handleFlowOpen({ url: 'https://flow.google.com/project/probe-loading', waitFor: 0 });
      expect(res.app).toBe('loading');
      expect(res.isLoggedIn).toBe(false);
      expect(res.status).toBe('loading');
    } finally {
      await page.close();
      setPage(null);
      setConnected(false);
    }
  }, 30000);
});
