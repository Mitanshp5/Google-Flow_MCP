import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openUploadPicker, uploadReferences, dropFilesIntoComposer } from '../src/browser/upload.js';

// Portable fixtures: the implementation stat()s and reads the files, so tests
// must own real bytes in a temp dir instead of a developer's local paths.
let dir;
let A;
let B;
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEB'
  + 'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEG'
  + 'E1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW'
  + 'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLD'
  + 'xMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z',
  'base64',
);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flowfix-'));
  A = path.join(dir, 'photo-a.jpg');
  B = path.join(dir, 'photo-b.jpg');
  writeFileSync(A, JPEG);
  writeFileSync(B, JPEG);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Page stub: no usable picker, a composer that gains chips on drop. */
function makePage({ chips = 0, chipName = 'chip' } = {}) {
  const state = { chips, drags: 0 };
  const page = {
    url: () => 'https://flow.google.com/project/aaaaaaaa-1111-2222-3333-444444444444',
    locator: () => ({
      first: () => ({ isVisible: async () => false, count: async () => 0, click: async () => {}, waitFor: async () => {} }),
    }),
    waitForTimeout: async () => {},
    waitForEvent: async () => null,
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('flow-ingredient-chip') && src.includes('map')) {
        return state.chips > 0
          ? [{ name: chipName, assetId: null, src: 'https://flow.google.com/asb/x' }]
          : [];
      }
      if (src.includes('querySelectorAll')) return state.chips;
      if (src.includes('getBoundingClientRect')) return { x: 10, y: 10 };
      return null;
    },
    context: () => ({
      newCDPSession: async () => ({
        send: async (method, params) => {
          if (method === 'Input.dispatchDragEvent' && params?.type === 'drop') {
            state.chips += (params?.data?.files || []).length;
          }
          return {};
        },
        detach: async () => {},
      }),
    }),
  };
  return { page, state };
}

describe('attaching references when the picker cannot deliver', () => {
  it('drops first and reports a new chip as attachment, identity unavailable', async () => {
    const { page, state } = makePage();
    const res = await uploadReferences(page, null, [A], {});
    expect(['cdp-drop', 'picker-then-cdp-drop']).toContain(res.uploadMode);
    expect(res.attachmentVerified).toBe(true);
    expect(res.identityVerified).toBe(false);
    expect(res.identityCheck).toBe('unavailable-in-this-ui');
    expect(res.newChips).toBe(1);
    expect(state.chips).toBe(1);
  });

  it('one chip for two requested files is progress, not success', async () => {
    const { page } = makePage();
    // Emulate a half-accepted batch: only ONE of the two files lands.
    page.context = () => ({
      newCDPSession: async () => ({
        send: async (method, params) => {
          if (method === 'Input.dispatchDragEvent' && params?.type === 'drop') {
            page.__state.chips = 1;
          }
          return {};
        },
        detach: async () => {},
      }),
    });
    page.__state = { chips: 0 };
    const evalOrig = page.evaluate;
    page.evaluate = async (fn) => {
      const src = String(fn);
      if (src.includes('flow-ingredient-chip') && src.includes('map')) {
        return page.__state.chips > 0
          ? [{ name: 'chip', assetId: null, src: 'https://flow.google.com/asb/x' }]
          : [];
      }
      if (src.includes('querySelectorAll')) return page.__state.chips;
      if (src.includes('getBoundingClientRect')) return { x: 10, y: 10 };
      return evalOrig(fn);
    };
    const res = await uploadReferences(page, null, [A, B], {});
    expect(res.attachmentVerified).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.needsConfirmation).toBe(true);
    expect(res.reason).toMatch(/partial attachment/);
  });

  it('a same-name chip that already existed neither re-uploads nor verifies', async () => {
    const { page, state } = makePage({ chips: 1, chipName: path.basename(A) });
    const res = await uploadReferences(page, null, [A], {});
    expect(state.drags).toBe(0);
    expect(res.attachmentVerified).toBe(false);
    expect(res.needsConfirmation).toBe(true);
    expect(res.reason).toMatch(/preexisting chip/);
  });

  it('refuses the drop topology that cannot pass host paths', async () => {
    process.env.FLOW_BROWSER_REMOTE = 'true';
    const { page, state } = makePage();
    const res = await dropFilesIntoComposer(page, [A]);
    delete process.env.FLOW_BROWSER_REMOTE;
    expect(res.dropped).toBe(false);
    expect(res.reason).toMatch(/unsupported_topology/);
    expect(state.drags).toBe(0);
  });

  it('never claims success without a composer', async () => {
    const page = {
      evaluate: async (fn) => (String(fn).includes('getBoundingClientRect') ? null : 0),
      waitForTimeout: async () => {},
      context: () => ({ newCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }),
    };
    const res = await dropFilesIntoComposer(page, [A]);
    expect(res.dropped).toBe(false);
    expect(res.reason).toMatch(/composer not found/);
  });

  it('reports an explicit error when neither menu nor drop works', async () => {
    const page = {
      url: () => 'https://flow.google.com/',
      locator: () => ({ first: () => ({ isVisible: async () => false, count: async () => 0, click: async () => {} }) }),
      waitForTimeout: async () => {},
      evaluate: async () => 0,
      context: () => ({ newCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }) }),
    };
    const res = await openUploadPicker(page, { files: [A] });
    expect(res.fileChooser).toBeNull();
    expect(res.dropped).toBe(false);
    expect(res.error).toBe('Add ingredients entry not found');
  });
});
