import { describe, it, expect } from 'vitest';
import { stripTypeLabelSuffix } from '../src/navigation/mentions.js';
import { modelTokens } from '../src/utils/models.js';
import { extractProjectId, buildProjectUrl } from '../src/navigation/project-navigator.js';
import { cameraMoves } from '../src/utils/prompt.js';

// P2-1: pure browser-adjacent logic that previously had zero direct tests.
describe('stripTypeLabelSuffix', () => {
  it('strips concatenated type labels from asset rows', () => {
    expect(stripTypeLabelSuffix('Cow in spaceImage')).toBe('Cow in space');
    expect(stripTypeLabelSuffix('BobCharacter')).toBe('Bob');
    expect(stripTypeLabelSuffix('Scene 1Scene')).toBe('Scene 1');
  });

  it('leaves clean titles and short strings alone', () => {
    expect(stripTypeLabelSuffix('Cat flies rocket to Mars')).toBe('Cat flies rocket to Mars');
    expect(stripTypeLabelSuffix('Image')).toBe('Image');
    expect(stripTypeLabelSuffix('')).toBe('');
  });
});

describe('modelTokens', () => {
  it('tokenizes names ignoring case and punctuation', () => {
    expect(modelTokens('Omni Flash 1.1')).toEqual(['omni', 'flash', '1', '1']);
    expect(modelTokens('Veo-3.1-Fast')).toEqual(['veo', '3', '1', 'fast']);
    expect(modelTokens('')).toEqual([]);
  });
});

describe('extractProjectId / buildProjectUrl', () => {
  it('round-trips project ids through urls', () => {
    const url = buildProjectUrl('https://flow.google.com/', 'abc-123');
    expect(url).toBe('https://flow.google.com/project/abc-123');
    expect(extractProjectId(url)).toBe('abc-123');
    expect(extractProjectId('https://flow.google.com/')).toBe(null);
  });

  it('buildProjectUrl tolerates trailing slashes and legacy base', () => {
    expect(buildProjectUrl('https://flow.google.com///', 'x')).toBe('https://flow.google.com/project/x');
    expect(buildProjectUrl('https://labs.google/fx/tools/flow', 'x')).toBe(
      'https://labs.google/fx/tools/flow/project/x'
    );
  });
});

describe('cameraMoves', () => {
  it('exposes the documented move vocabulary', () => {
    const moves = cameraMoves();
    expect(moves).toContain('push-in');
    expect(moves).toContain('tracking shot');
    expect(moves.length).toBeGreaterThan(5);
  });
});
