import { describe, it, expect } from 'vitest';
import {
  buildPickerQuery,
  isExactRowMatch,
  verifyMentionInsert,
  PICKER_ROOT_SELECTORS,
} from '../src/navigation/mentions.js';

// W04 slice 4 — mention punctuation trigger, scoped real picker, exact
// title/asset identity, never first-word fallback. Headless, no CDP.
describe('W04 mentions picker query uses full title', () => {
  it('builds full-title query, never first word', () => {
    expect(buildPickerQuery('Cow in space')).toBe('Cow in space');
    expect(buildPickerQuery('  qa-reference.png  ')).toBe('qa-reference.png');
  });
  it('exposes scoped picker root selectors', () => {
    expect(Array.isArray(PICKER_ROOT_SELECTORS)).toBe(true);
    expect(PICKER_ROOT_SELECTORS.length).toBeGreaterThan(0);
  });
});

describe('W04 mentions exact row match', () => {
  it('exact full title matches', () => {
    expect(isExactRowMatch('Cow in space', 'Cow in space')).toBe(true);
    expect(isExactRowMatch('Cow in spaceImage', 'Cow in space')).toBe(true);
  });
  it('first-word/substring never matches', () => {
    expect(isExactRowMatch('Cow', 'Cow in space')).toBe(false);
    expect(isExactRowMatch('Cow in', 'Cow in space')).toBe(false);
    expect(isExactRowMatch('Cow in space suit', 'Cow in space')).toBe(false);
  });
  it('line-wrapped titles match (block breaks and suffix wraps)', () => {
    expect(isExactRowMatch('Bob the\nastronautCharacter', 'Bob the Astronaut')).toBe(true);
    expect(isExactRowMatch('Bob the astronaut\nCharacter', 'Bob the Astronaut')).toBe(true);
    expect(isExactRowMatch('Bob the astronaut', 'Bob the Astronaut')).toBe(true);
    expect(isExactRowMatch('Bob the cosmonaut', 'Bob the Astronaut')).toBe(false);
  });
});

describe('W04 mentions insert verification has no first-word fallback', () => {
  it('full title in composer verifies', () => {
    expect(verifyMentionInsert({ requested: 'Cow in space', composerText: 'hi Cow in space', chips: [] }).verified).toBe(true);
  });
  it('chip with exact title/assetId verifies', () => {
    const r = verifyMentionInsert({
      requested: 'qa-reference.png',
      composerText: '...',
      chips: [{ title: 'qa-reference.png', assetId: 'a1' }],
    });
    expect(r.verified).toBe(true);
  });
  it('first-word-only text does NOT verify', () => {
    const r = verifyMentionInsert({ requested: 'Cow in space', composerText: 'hi Cow', chips: [] });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/first-word|exact/i);
  });
  it('truncated chip without asset identity does NOT verify', () => {
    const r = verifyMentionInsert({ requested: 'Cow in space suit', composerText: 'Cow', chips: [{ title: 'Cow', assetId: null }] });
    expect(r.verified).toBe(false);
  });
});
