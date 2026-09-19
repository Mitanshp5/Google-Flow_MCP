import { describe, it, expect } from 'vitest';
import { findActionButton, GENERATE_BUTTON_SELECTORS } from '../src/browser/safe-actions.js';

// P1-4: aria-first ordered lookup. Fake page implements exactly the call
// shape the helper uses: page.locator(sel).first().isVisible().
function fakePage(visibleSels, throwingSels = []) {
  return {
    locator: (sel) => ({
      first: () => {
        if (throwingSels.includes(sel)) throw new Error('detached');
        return { isVisible: async () => visibleSels.includes(sel) };
      },
    }),
  };
}

describe('findActionButton', () => {
  it('aria matches win over text matches regardless of visibility overlap', () => {
    const page = fakePage([
      'button:has-text("Generate")',
      'button[aria-label*="Generate" i]',
    ]);
    return expect(findActionButton(page, GENERATE_BUTTON_SELECTORS)).resolves.toMatchObject({
      matched: 'button[aria-label*="Generate" i]',
    });
  });

  it('falls through invisible candidates in order', () => {
    const page = fakePage(['button[type="submit"]']);
    return expect(findActionButton(page, GENERATE_BUTTON_SELECTORS)).resolves.toMatchObject({
      matched: 'button[type="submit"]',
    });
  });

  it('returns null when nothing is visible (caller fails closed)', async () => {
    await expect(findActionButton(fakePage([]), GENERATE_BUTTON_SELECTORS)).resolves.toBe(null);
    await expect(findActionButton(fakePage([]), [])).resolves.toBe(null);
  });

  it('skips throwing locators instead of crashing', () => {
    const page = fakePage(
      ['button:has-text("Generate")'],
      ['button[aria-label*="Start generation" i]']
    );
    return expect(findActionButton(page, GENERATE_BUTTON_SELECTORS)).resolves.toMatchObject({
      matched: 'button:has-text("Generate")',
    });
  });

  it('shared list keeps aria first, text last', () => {
    const textIdx = GENERATE_BUTTON_SELECTORS.findIndex((s) => s.includes('has-text'));
    const ariaIdx = GENERATE_BUTTON_SELECTORS.findIndex((s) => s.includes('aria-label'));
    expect(ariaIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBe(GENERATE_BUTTON_SELECTORS.length - 1);
  });
});
