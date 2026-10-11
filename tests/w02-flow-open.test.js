import { describe, it, expect } from 'vitest';
import { handleFlowOpen } from '../src/tools/flow-open.js';
import { setPage, setConnected } from '../src/browser/connect.js';

describe('W02 flow-open truthfulness', () => {
  it('reports 404 as blocked, not connected/logged-in', async () => {
    // Fake page: 404 HTML, no shell (real-HTML fixture, no CDP).
    const page = {
      goto: async () => {},
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      isClosed: () => false,
      url: () => 'https://flow.google.com/404',
      title: async () => 'Error: 404',
      textContent: async () => 'Error: 404 page not found',
      content: async () => '<html><body>Error: 404</body></html>',
    };
    setPage(page);
    setConnected(true);
    try {
      const res = await handleFlowOpen({ url: 'https://flow.google.com/404', waitFor: 0 });
      expect(res.allowedUrl).toBe(true);
      expect(res.app).toBe('error_404');
      expect(res.isLoggedIn).toBe(false);
      expect(res.isFlowPage).toBe(false);
      expect(String(res.status)).not.toBe('connected');
      expect(String(res.blocker || res.app)).toMatch(/404|blocked/i);
    } finally {
      setPage(null);
      setConnected(false);
    }
  }, 15000);
});
