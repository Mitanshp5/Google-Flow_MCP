import { describe, it, expect } from 'vitest';
import { parseBarQuantity, parseBarRatio } from '../src/browser/safe-actions.js';

// Bottom-bar map verified against live Flow UI:
// modes Image/Video; ratios 16:9 4:3 1:1 3:4 9:16; quantities x1..x4 (×4 uses U+00D7).
describe('prompt-bar label parsers', () => {
  it('parses quantities incl. × spelling', () => {
    expect(parseBarQuantity('x1')).toBe(1);
    expect(parseBarQuantity('x2')).toBe(2);
    expect(parseBarQuantity('×4')).toBe(4);
    expect(parseBarQuantity('X3')).toBe(3);
    expect(parseBarQuantity('x5')).toBe(null);
    expect(parseBarQuantity('Video')).toBe(null);
    expect(parseBarQuantity('16:9')).toBe(null);
  });
  it('parses the five bar ratios, rejects the rest', () => {
    for (const r of ['16:9', '4:3', '1:1', '3:4', '9:16']) {
      expect(parseBarRatio(r)).toBe(r);
    }
    expect(parseBarRatio(' 9:16 ')).toBe('9:16');
    expect(parseBarRatio('21:9')).toBe(null);
    expect(parseBarRatio('x2')).toBe(null);
    expect(parseBarRatio('0')).toBe(null);
  });
});
