/**
 * W00 Slice A: AsyncLocalStorage scoped page/session boundary.
 * No exported mutable global page provider: scopes are carried by
 * withSession/withPage callbacks. getPage (connect.js) consults the
 * scope first, then the live global — so real dispatch can run against
 * fixture pages without touching live browser state.
 */
import { describe, it, expect } from 'vitest';
import {
  getSessionScope,
  getScopedPage,
  withSession,
  withPage,
} from '../src/browser/session-scope.js';

describe('W00 session scope: empty outside, provided inside', () => {
  it('has no scope and no page outside a session', () => {
    expect(getSessionScope()).toBe(null);
    expect(getScopedPage()).toBe(null);
  });

  it('withPage provides the page and restores null afterwards', async () => {
    const page = { marker: 'fixture-page' };
    let seenInside = null;
    await withPage(page, async () => {
      seenInside = getScopedPage();
    });
    expect(seenInside).toBe(page);
    expect(getScopedPage()).toBe(null);
  });

  it('nested scopes restore correctly (inner does not leak to outer)', async () => {
    const outer = { marker: 'outer' };
    const inner = { marker: 'inner' };
    const seen = {};
    await withPage(outer, async () => {
      seen.before = getScopedPage();
      await withPage(inner, async () => {
        seen.during = getScopedPage();
      });
      seen.after = getScopedPage();
    });
    expect(seen.before).toBe(outer);
    expect(seen.during).toBe(inner);
    expect(seen.after).toBe(outer);
    expect(getScopedPage()).toBe(null);
  });

  it('concurrent scopes stay isolated', async () => {
    const a = { marker: 'a' };
    const b = { marker: 'b' };
    const seen = {};
    await Promise.all([
      withPage(a, async () => {
        await new Promise((r) => setTimeout(r, 25));
        seen.a = getScopedPage();
      }),
      withPage(b, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.b = getScopedPage();
      }),
    ]);
    expect(seen.a).toBe(a);
    expect(seen.b).toBe(b);
  });

  it('withSession carries extra session fields and withPage inherits them', async () => {
    const page2 = { marker: 'p2' };
    let seen = null;
    await withSession({ sessionId: 's1' }, async () => {
      await withPage(page2, async () => {
        seen = getSessionScope();
      });
    });
    expect(seen).toMatchObject({ sessionId: 's1', page: page2 });
    expect(getSessionScope()).toBe(null);
  });
});
