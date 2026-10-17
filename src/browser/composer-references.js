// Current Flow composer: observe stable media IDs, never input.files or
// page-wide preview counts. Start/end identity is anchored to the swap control.
export async function readComposerReferences(page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('flow-base-prompt-box')].filter(el => el.getBoundingClientRect().width > 0);
    if (roots.length !== 1) return null;
    const root = roots[0];
    const identity = (el) => {
      const img = el.querySelector('img');
      const match = (img?.src || '').match(/^https:\/\/flow-content\.google\/(?:image|video)\/([a-f0-9-]+)(?:\?|$)/i);
      const assetId = match?.[1] || null;
      const library = [...document.querySelectorAll('flow-image-tile, flow-video-tile')].find(tile =>
        tile.querySelector('[data-media-id]')?.getAttribute('data-media-id') === assetId);
      return {assetId, title: library?.querySelector('.footer-title')?.textContent?.trim() || null,
        crop: img?.getAttribute('style') || null, busy: !!el.querySelector('[aria-busy="true"]')};
    };
    const bar = root.querySelector('flow-ingredient-bar .ingredient-bar-container');
    const triggers = bar ? [...bar.children].filter(el => el.classList.contains('frame-trigger')) : [];
    const swap = bar?.querySelector('[aria-label="Swap first and last frames"]');
    const frames = triggers.length === 2 && swap
      && !!(triggers[0].compareDocumentPosition(swap) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(swap.compareDocumentPosition(triggers[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
    const ingredients = triggers.length === 0 && !!root.querySelector('[aria-label="Add ingredients to the prompt box"]');
    if (!frames && !ingredients) return null;
    const slots = {};
    let slotsObservable = true;
    if (frames) {
      triggers.forEach((el, i) => {
        const slot = i === 0 ? 'start' : 'end';
        if (el.querySelector('flow-image-ingredient-chip')) {
          slots[slot] = {...identity(el), slot};
          if (!slots[slot].assetId || slots[slot].busy) slotsObservable = false;
        } else if (el.querySelector('button')?.textContent.trim() !== (i === 0 ? 'Start' : 'End')) {
          slotsObservable = false;
        }
      });
    }
    const chips = [...root.querySelectorAll('flow-ingredient-chip')].map(identity);
    return {mode: frames ? 'frames' : 'ingredients', chips, slots,
      chipsObservable: chips.every(c => c.assetId && !c.busy), slotsObservable,
      pendingUploads: [...root.querySelectorAll('[aria-busy="true"]')].map(el => ({status:'pending', label:el.getAttribute('aria-label')})),
      settings: {summary:root.querySelector('[aria-label="Settings trigger"]')?.textContent?.replace(/\s+/g,' ').trim() || null,
        agentMode:root.querySelector('.agent-mode-chip')?.getAttribute('aria-pressed') ?? null}};
  });
}
