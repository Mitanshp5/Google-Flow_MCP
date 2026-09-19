import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { summarizeAttachment } from '../src/browser/safe-actions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P0-1/P0-2: pure attachment-accounting logic. The DOM half
// (attachReferenceFiles: setInputFiles + input.files read-back + preview
// counting) needs a live page — verify manually via the prepare-only
// protocol step noted in the P0-1/P0-2 commit messages.
describe('summarizeAttachment', () => {
  it('no files requested is vacuously verified', () => {
    expect(summarizeAttachment({ requested: [] })).toMatchObject({
      requested: [],
      attached: 0,
      verified: true,
    });
  });

  it('full input acceptance verifies even with zero preview delta', () => {
    // Preview selectors are advisory only and must never gate: UI versions
    // render thumbnails in different containers.
    const out = summarizeAttachment({
      requested: ['a.png', 'b.png'],
      inputAccepted: 2,
      previewsBefore: 5,
      previewsAfter: 5,
    });
    expect(out.verified).toBe(true);
    expect(out.attached).toBe(0);
  });

  it('shortfall fails with counts in the notes', () => {
    const out = summarizeAttachment({
      requested: ['a.png', 'b.png'],
      inputAccepted: 1,
      previewsBefore: 5,
      previewsAfter: 6,
    });
    expect(out.verified).toBe(false);
    expect(out.attached).toBe(1);
    expect(out.notes.join(' ')).toMatch(/1\/2/);
  });

  it('negative preview delta clamps to zero attached', () => {
    const out = summarizeAttachment({
      requested: ['a.png'],
      inputAccepted: 1,
      previewsBefore: 5,
      previewsAfter: 3,
    });
    expect(out.attached).toBe(0);
    expect(out.verified).toBe(true);
  });

  it('zero acceptance with files requested fails', () => {
    expect(
      summarizeAttachment({ requested: ['a.png'], inputAccepted: 0 }).verified
    ).toBe(false);
  });
});

// P0-1 follow-up: the ref-upload block needs resolveSafePath + fs at call
// time (a missing import only explodes on the live path, which unit tests
// never execute — this guards the wiring statically).
describe('P0-1 image handler imports', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/tools/generate-image.js'), 'utf-8');

  it('imports resolveSafePath and fs for reference validation', () => {
    expect(src).toMatch(/resolveSafePath.*from '\.\.\/utils\/sanitize\.js'/);
    expect(src).toMatch(/import fs from 'fs'/);
  });
});
