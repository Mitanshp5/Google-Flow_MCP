import { describe, it, expect } from 'vitest';
import {
  escapeRegExp,
  promptBarScope,
  barInput,
  findSettingsPanel,
  closeSettingsPanel,
} from '../src/browser/safe-actions.js';
import { mockButton, mockPageRoutes } from './helpers/mock-page.js';

// P2-1 (full): shallow UI primitives. Deep panel flows (configurePromptBar,
// setPromptBarModel, openBarSettings) and all getPage()-bound helpers stay
// live-only — they need real DOM, not wider mocks.
describe('escapeRegExp', () => {
  it('escapes selector-significant characters', () => {
    expect(escapeRegExp('a.b(c)')).toBe('a\\.b\\(c\\)');
    expect(escapeRegExp('16:9')).toBe('16:9');
  });
});

describe('promptBarScope', () => {
  const barEl = Object.assign(mockButton({ visible: true }), { tag: 'bar' });

  it('returns the owning bar when one exists', async () => {
    const input = { locator: () => ({ count: async () => 1, first: () => barEl }) };
    await expect(promptBarScope(mockPageRoutes([]), input)).resolves.toBe(barEl);
  });

  it('falls back to body when no bar container', async () => {
    const input = { locator: () => ({ count: async () => 0, first: () => barEl }) };
    const scope = await promptBarScope(mockPageRoutes([]), input);
    expect(scope).toBeDefined();
    expect(scope).not.toBe(barEl);
  });
});

describe('barInput', () => {
  it('returns the first visible candidate in preference order', async () => {
    const second = Object.assign(mockButton({ visible: true }), { tag: 'second' });
    const page = mockPageRoutes([
      { match: 'placeholder', element: Object.assign(mockButton({ visible: false }), { tag: 'first' }) },
      { match: 'textarea', element: second },
    ]);
    // first()/last() yield locator-likes carrying the element's props.
    const found = await barInput(page);
    expect(found?.tag).toBe('second');
  });

  it('returns null when no input is visible', async () => {
    await expect(barInput(mockPageRoutes([]))).resolves.toBe(null);
  });
});

describe('findSettingsPanel', () => {
  it('finds an open dialog panel', async () => {
    const page = mockPageRoutes([{ match: '[role="dialog"]', visible: true }]);
    await expect(findSettingsPanel(page)).not.toBe(null);
  });

  it('falls back to a visible overlay pane', async () => {
    const page = mockPageRoutes([{ match: '.cdk-overlay-pane', visible: true }]);
    await expect(findSettingsPanel(page)).not.toBe(null);
  });

  it('returns null when nothing is open', async () => {
    await expect(findSettingsPanel(mockPageRoutes([]))).resolves.toBe(null);
  });
});

describe('closeSettingsPanel', () => {
  it('already-closed returns true without pressing Escape', async () => {
    const page = mockPageRoutes([]);
    await expect(closeSettingsPanel(page)).resolves.toBe(true);
    expect(page.presses).toEqual([]);
  });

  it('stuck-open returns false after four Escapes', async () => {
    const page = mockPageRoutes([{ match: '[role="dialog"]', visible: true }]);
    await expect(closeSettingsPanel(page)).resolves.toBe(false);
    expect(page.presses).toEqual(['Escape', 'Escape', 'Escape', 'Escape']);
  });
});
