import { describe, it, expect } from 'vitest';
import { resolveDownloadKind } from '../src/tools/download-latest.js';
import { getOutputDir } from '../src/utils/file-manager.js';

// P0-3: downloads must not all land in outputs/images/.
describe('P0-3 download routing', () => {
  it('routes by filename extension first (case-insensitive)', () => {
    expect(resolveDownloadKind({ suggestedFilename: 'clip.mp4' }))
      .toMatchObject({ kind: 'video', detectedFrom: 'filename' });
    expect(resolveDownloadKind({ suggestedFilename: 'CLIP.WEBM' }))
      .toMatchObject({ kind: 'video', detectedFrom: 'filename' });
    expect(resolveDownloadKind({ suggestedFilename: 'img.png' }).kind).toBe('image');
    expect(resolveDownloadKind({ suggestedFilename: 'photo.JPG' }).kind).toBe('image');
    expect(resolveDownloadKind({ suggestedFilename: 'a.webp' }).kind).toBe('image');
    expect(resolveDownloadKind({ suggestedFilename: 'shot.jpeg' }).kind).toBe('image');
  });

  it('falls back to job type when the extension is unknown', () => {
    expect(resolveDownloadKind({ suggestedFilename: 'blob', jobType: 'video_generation' }))
      .toMatchObject({ kind: 'video', detectedFrom: 'job' });
    expect(resolveDownloadKind({ suggestedFilename: 'blob', jobType: 'image_generation' }))
      .toMatchObject({ kind: 'image', detectedFrom: 'job' });
  });

  it('filename wins over a conflicting job type', () => {
    expect(resolveDownloadKind({ suggestedFilename: 'x.mp4', jobType: 'image_generation' }).kind)
      .toBe('video');
  });

  it('lands in other/ (never images/) when nothing determines the kind', () => {
    expect(resolveDownloadKind({})).toMatchObject({ kind: 'other', detectedFrom: 'fallback' });
    expect(resolveDownloadKind({ suggestedFilename: 'blob', jobType: 'create_character' }).kind)
      .toBe('other');
  });

  it("getOutputDir('other') resolves under outputs/other/", () => {
    expect(getOutputDir('other')).toMatch(/outputs[\\/]other$/);
  });
});
