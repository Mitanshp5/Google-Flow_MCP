import { describe, it, expect } from 'vitest';
import { classifyAppState, shellReadyFromHtml, isGuessedRoute } from '../src/browser/app-state.js';

describe('W02 app readiness', () => {
  it('classifies Flow 404 as allowed URL but app error_404, not logged-in ready', () => {
    const html = '<html><head><title>Error: 404</title></head><body>Error: 404 page not found</body></html>';
    const s = classifyAppState({ url: 'https://flow.google.com/404', title: 'Error: 404', bodyText: 'Error: 404' });
    expect(s.allowedUrl).toBe(true);
    expect(s.app).toBe('error_404');
    expect(shellReadyFromHtml(html)).toBe(false);
  });

  it('classifies loading shell as loading, not ready', () => {
    const html = '<html><body><div class="skeleton">Loading…</div></body></html>';
    const s = classifyAppState({ url: 'https://flow.google.com/project/abc', title: 'Flow', bodyText: 'Loading…' });
    expect(s.app).toBe('loading');
    expect(shellReadyFromHtml(html)).toBe(false);
  });

  it('classifies auth interstitial as auth_needed independently of 404', () => {
    const s = classifyAppState({ url: 'https://accounts.google.com/signin', title: 'Sign in', bodyText: 'Sign in to continue' });
    expect(s.app).toBe('auth_needed');
  });

  it('recognizes semantic shell markers in real HTML', () => {
    const html = '<body><textarea placeholder="Describe"></textarea><nav><mat-list-item>Characters</mat-list-item></nav></body>';
    expect(shellReadyFromHtml(html)).toBe(true);
  });

  it('never reports guessed tool/character routes as valid', () => {
    expect(isGuessedRoute('https://flow.google.com/project/abc/characters').guessed).toBe(true);
    expect(isGuessedRoute('https://flow.google.com/tools/grid-architect').guessed).toBe(true);
    expect(isGuessedRoute('https://flow.google.com/project/abc/tool/6b649a77-e480-45e0-9d45-664e2b2e72ed?fromViewSource=tools').guessed).toBe(false);
  });
});
