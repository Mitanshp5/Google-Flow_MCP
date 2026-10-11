import { describe, it, expect } from 'vitest';
import {
  buildUploadPlan,
  summarizeUploadAck,
  verifySlotAssignment,
  verifyFullReferenceSet,
  openUploadPicker,
} from '../src/browser/upload.js';

// W04 slice 3 — real Add-ingredients → Upload-media → filechooser acknowledgement
// with identity; slot verification separate from input.files proof. Headless
// fixture/mocked-page tests, no live CDP, no real uploads.
describe('W04 upload plan', () => {
  it('rejects empty plan and unsupported extensions', () => {
    expect(buildUploadPlan([]).ok).toBe(false);
    expect(buildUploadPlan(['/t/a.exe']).ok).toBe(false);
    expect(buildUploadPlan(['/t/a.png', '/t/b.jpg']).ok).toBe(true);
  });
});

describe('W04 upload acknowledgement needs identity, not input.files alone', () => {
  it('input accepted without acknowledged identity is NOT verified', () => {
    const out = summarizeUploadAck({
      requested: ['hero.png'],
      fileChooserSeen: true,
      inputAccepted: 1,
      acknowledged: [],
    });
    expect(out.verified).toBe(false);
  });
  it('acknowledged identity per file verifies', () => {
    const out = summarizeUploadAck({
      requested: ['hero.png'],
      fileChooserSeen: true,
      inputAccepted: 1,
      acknowledged: [{ name: 'hero.png', assetId: 'u1', title: 'hero.png' }],
    });
    expect(out.verified).toBe(true);
  });
  it('missing filechooser is reported, never silent success', () => {
    const out = summarizeUploadAck({
      requested: ['hero.png'],
      fileChooserSeen: false,
      inputAccepted: 0,
      acknowledged: [],
    });
    expect(out.verified).toBe(false);
    expect(out.notes.join(' ')).toMatch(/filechooser/i);
  });
});

describe('W04 slot verification separate from upload acceptance', () => {
  it('correct start/end/ingredient slots verify', () => {
    const r = verifySlotAssignment(
      { start: { title: 'hero.png' }, end: { title: 'end.png' }, ingredients: [{ title: 'qa-reference.png' }] },
      { start: { title: 'hero.png', assetId: 's1' }, end: { title: 'end.png', assetId: 's2' }, ingredients: [{ title: 'qa-reference.png', assetId: 'a1' }] }
    );
    expect(r.verified).toBe(true);
  });
  it('start/end swap never passes', () => {
    const r = verifySlotAssignment(
      { start: { title: 'hero.png' }, end: { title: 'end.png' } },
      { start: { title: 'end.png', assetId: 's2' }, end: { title: 'hero.png', assetId: 's1' } }
    );
    expect(r.verified).toBe(false);
    expect(r.swapped).toBe(true);
  });
  it('unknown slot without identity is unverified', () => {
    const r = verifySlotAssignment({ start: { title: 'hero.png' } }, { start: { title: null, assetId: null } });
    expect(r.verified).toBe(false);
    expect(r.roles.start.verified).toBe(false);
  });
});

describe('W04 full required reference set', () => {
  it('partial required pack is incomplete', () => {
    expect(verifyFullReferenceSet({ required: ['a', 'b'], actual: ['a'] }).complete).toBe(false);
    expect(verifyFullReferenceSet({ required: ['a', 'b'], actual: ['a', 'b'] }).complete).toBe(true);
  });
});

describe('W04 openUploadPicker uses real filechooser flow', () => {
  function fakePage({ addVisible = true, uploadVisible = true, chooser = { setFiles: async () => {} } } = {}) {
    const clicks = [];
    return {
      clicks,
      locator: (sel) => {
        const s = String(sel);
        const visible = /Add ingredients/i.test(s) ? addVisible : /Upload media/i.test(s) ? uploadVisible : false;
        const chain = {
          first: () => chain,
          click: async () => { clicks.push(s); },
          isVisible: async () => visible,
        };
        return chain;
      },
      waitForEvent: async (ev) => (ev === 'filechooser' && chooser ? chooser : null),
      waitForTimeout: async () => {},
    };
  }
  it('clicks Add ingredients then Upload media and awaits filechooser', async () => {
    const page = fakePage({});
    const out = await openUploadPicker(page);
    expect(out.fileChooser).toBeTruthy();
    expect(page.clicks.join(' ')).toMatch(/Add ingredients/);
    expect(page.clicks.join(' ')).toMatch(/Upload media/);
  });
  it('missing Upload media entry is an explicit error, not blind input fallback', async () => {
    const page = fakePage({ uploadVisible: false });
    const out = await openUploadPicker(page);
    expect(out.fileChooser).toBe(null);
    expect(out.error).toMatch(/Upload media/i);
  });
});
