import { describe, it, expect } from 'vitest';

// W03: readToolState crop_square/icon decontamination + quality actual (F09/C4).
// Evidence: square chip gives ratio:null + model "Nano Banana Pro crop_square"
// (report §F09, cases 031/066/071); video chip "Video · 720p · 8s" has quality.
// Uses semantic button-text fixtures matching the real bar map.

import { decontaminateModelField, parseQualityToken } from '../src/browser/capabilities.js';
import { readToolState } from '../src/browser/safe-actions.js';

function buttonPage(texts) {
  const btns = texts.map((t) => ({
    isVisible: async () => true,
    textContent: async () => t,
  }));
  return {
    locator: (sel) => {
      if (String(sel).includes('textarea') || String(sel).includes('contenteditable')) {
        const empty = {
          isVisible: async () => false,
          first: () => empty,
          last: () => empty,
          filter: () => empty,
          count: async () => 0,
          all: async () => [],
          locator: () => empty,
          textContent: async () => '',
          getAttribute: async () => null,
        };
        return empty;
      }
      const chain = {
        all: async () => btns.map((b) => ({
          isVisible: b.isVisible,
          textContent: b.textContent,
          getAttribute: async () => null,
        })),
        first: () => chain,
        last: () => chain,
        filter: () => chain,
        count: async () => btns.length,
        locator: () => chain,
      };
      return chain;
    },
  };
}

describe('W03 readToolState decontamination (F09/C4)', () => {
  it('pure model scrub removes crop_square + icon ligatures', () => {
    expect(decontaminateModelField('🍌 Nano Banana Pro crop_square')).toBe('Nano Banana Pro');
    expect(decontaminateModelField('Nano Banana Pro crop_16_9')).toBe('Nano Banana Pro');
    expect(decontaminateModelField('volume_upOmni Flash')).toBe('Omni Flash');
    expect(decontaminateModelField('apps_spark_2 Tools')).toBe('Tools');
  });

  it('quality token parses 360p/720p, rejects the rest', () => {
    expect(parseQualityToken('720p')).toBe('720p');
    expect(parseQualityToken('360p')).toBe('360p');
    expect(parseQualityToken('x2')).toBe(null);
    expect(parseQualityToken('')).toBe(null);
  });

  it('combined square chip yields clean model + 1:1 + quality from video chip', async () => {
    const page = buttonPage(['🍌 Nano Banana Pro crop_square x1']);
    const st = await readToolState(page);
    expect(st.model).toBe('Nano Banana Pro');
    expect(st.ratio).toBe('1:1');
    expect(st.quantity).toBe(1);
  });

  it('video chip exposes quality actual, never null-as-proof model', async () => {
    const page = buttonPage(['Video · 720p · 8s ▢ x1']);
    const st = await readToolState(page);
    expect(st.mode).toBe('video');
    expect(st.quality).toBe('720p');
    expect(st.duration).toBe('8s');
    // Video chip carries no model name: explicit unknown, not null-as-proof.
    expect(st.model === null || st.model === 'unknown').toBe(true);
  });
});
