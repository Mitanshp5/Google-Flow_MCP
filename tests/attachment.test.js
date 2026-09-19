import { describe, it, expect } from 'vitest';
import { summarizeAttachment } from '../src/browser/safe-actions.js';

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
