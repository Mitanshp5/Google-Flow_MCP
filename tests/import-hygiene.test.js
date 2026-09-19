import { describe, it, expect } from 'vitest';
import fs from 'fs';

// P1-5: generate-video.js must not re-import at call time what it already
// holds at top level (Node module caching makes it a no-op functionally,
// but the debris hides the real dependency surface during review).
describe('P1-5 no redundant dynamic imports in generate-video', () => {
  const src = fs.readFileSync('src/tools/generate-video.js', 'utf-8');

  it('has zero await import() statements', () => {
    expect(src).not.toMatch(/await import\(/);
  });
});
