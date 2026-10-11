/**
 * W00 Slice B: getPage()/isBrowserConnected() consult the ambient session
 * scope first, then the live global. Real dispatch (which calls getPage()
 * internally) can therefore run against fixture pages with live globals
 * untouched. No live CDP.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { getPage, isBrowserConnected, getBrowser } from '../src/browser/connect.js';
import { withPage } from '../src/browser/session-scope.js';
import { w00LoadFixture, w00CloseBrowser } from './helpers/w00-dom.js';
import { FlowError } from '../src/utils/errors.js';

describe('W00 scoped getPage boundary', () => {
  afterAll(async () => {
    await w00CloseBrowser();
  }, 30000);

  it('outside a scope, disconnected getPage still throws (live fallback preserved)', () => {
    if (isBrowserConnected()) return; // a live session owns this machine; skip
    expect(() => getPage()).toThrow(FlowError);
    expect(getBrowser()).toBe(null);
  });

  it('inside withPage, getPage returns the scoped fixture page', async () => {
    const page = await w00LoadFixture('w00-sidebar.html');
    try {
      await withPage(page, async () => {
        expect(getPage()).toBe(page);
        expect(isBrowserConnected()).toBe(true);
      });
    } finally {
      await page.close();
    }
  });

  it('leaving the scope restores the live fallback (no leak)', async () => {
    const page = await w00LoadFixture('w00-sidebar.html');
    try {
      await withPage(page, async () => {
        expect(getPage()).toBe(page);
      });
    } finally {
      await page.close();
    }
    if (!isBrowserConnected()) {
      expect(() => getPage()).toThrow(FlowError);
    }
    expect(getBrowser()).toBe(null);
  });
});
