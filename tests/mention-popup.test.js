import { describe, it, expect } from 'vitest';
import {
  openMentionPopup,
  closeMentionPopup,
  listMentionOptions,
} from '../src/navigation/mentions.js';
import { mockPageRoutes } from './helpers/mock-page.js';

// P2-1 (full): the non-destructive @ cleanup contract — panel failure must
// remove only the "@" we typed, never user text. insertMentionReference's
// multi-step panel dance stays live-only.
function textInput(initial) {
  let text = initial;
  return {
    get text() { return text; },
    set text(v) { text = v; },
    textContent: async () => text,
    inputValue: async () => text,
    click: async () => {},
  };
}

describe('openMentionPopup', () => {
  it('returns the panel handles when it opens', async () => {
    const page = mockPageRoutes([{ match: 'Search', visible: true }]);
    const out = await openMentionPopup(page, textInput('hello'));
    expect(out).not.toBe(null);
    expect(page.presses).toContain('End');
    expect(page.presses).toContain('type:@');
  });

  it('removes only the trailing @ when the panel never opens', async () => {
    const page = mockPageRoutes([]);
    let calls = 0;
    const input = {
      textContent: async () => (++calls === 1 ? 'hello' : 'hello@'),
      inputValue: async () => 'hello',
      click: async () => {},
    };
    await expect(openMentionPopup(page, input)).resolves.toBe(null);
    expect(page.presses).toContain('Backspace');
    expect(page.presses.filter((p) => p === 'Backspace')).toHaveLength(1);
  });
});

describe('closeMentionPopup', () => {
  it('leaves input without trailing @ untouched (no Backspace)', async () => {
    const page = mockPageRoutes([]);
    await closeMentionPopup(page, textInput('keep my prompt'));
    expect(page.presses).toEqual(['Escape']);
  });

  it('deletes exactly the trailing @ otherwise', async () => {
    const page = mockPageRoutes([]);
    await closeMentionPopup(page, textInput('prompt@'));
    expect(page.presses).toEqual(['Escape', 'End', 'Backspace']);
  });
});

describe('listMentionOptions', () => {
  it('strips type labels and cleans up the @ afterwards', async () => {
    const page = mockPageRoutes(
      [{ match: 'Search', visible: true }],
      { evaluateResult: ['Cow in spaceImage', 'BobCharacter'] }
    );
    const input = textInput('draft');
    const names = await listMentionOptions(page, input);
    expect(names).toEqual(['Cow in space', 'Bob']);
    // Popup closed afterwards (Escape); in the mock the typed @ never lands
    // in input text, so there is nothing trailing to delete.
    expect(page.presses).toContain('Escape');
    expect(page.presses).not.toContain('Backspace');
  });
});
