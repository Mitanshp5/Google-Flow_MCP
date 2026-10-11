import { describe, it, expect, afterEach } from 'vitest';
import { withPage } from '../src/browser/session-scope.js';
import { getPage, setPage, setConnected } from '../src/browser/connect.js';

afterEach(() => { setPage(null); setConnected(false); });

describe('scoped page fail-closed boundary', () => {
  it('rejects a closed scoped page rather than handing a dead page to handlers', () => {
    withPage({ isClosed: () => true }, () => {
      expect(() => getPage()).toThrow(/not connected|closed/i);
    });
  });

  it('explicit null page scope cannot fall through to a live-global page', () => {
    const globalPage = { isClosed: () => false };
    setPage(globalPage);
    setConnected(true);
    withPage(null, () => {
      expect(() => getPage()).toThrow(/not connected|closed/i);
    });
    expect(getPage()).toBe(globalPage);
  });
});
