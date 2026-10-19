import { FlowError, ErrorCodes } from '../utils/errors.js';

export async function fillCharacterDescription(page, editor, description, archetype) {
  if (archetype) {
    const card = page.getByRole('button').filter({ hasText: archetype }).first();
    if (!(await card.isVisible())) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Requested character archetype is not visible');
    const before = await editor.textContent();
    await card.click();
    // The preset writes asynchronously. A fixed sleep followed by fill races
    // its late response and lets it replace the authored description.
    await page.waitForFunction(({label, before, archetype}) => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')]
        .find(e => e.getAttribute('aria-label') === label);
      const preset = [...document.querySelectorAll('button')].find(e => e.textContent.includes(archetype));
      const generating = preset && /Generating(?:…|\.{3})/i.test(preset.textContent);
      const submit = document.querySelector('button[aria-label="Start generation"]');
      return el && el.textContent !== before && el.textContent.trim().length > 0
        && !generating && (!submit || !submit.disabled);
    }, {label:await editor.getAttribute('aria-label'),before,archetype}, {timeout:120000});
  }
  await editor.fill(description);
  const actual = await editor.inputValue().catch(() => null) ?? await editor.textContent();
  if (actual.replace(/\s+/g,' ').trim() !== description.replace(/\s+/g,' ').trim()) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Character description read-back mismatch. No generation submitted.');
  }
}

export async function waitForCharacterPortrait(page, timeoutMs = 120000) {
  await page.waitForURL(/\/character\/[^/?#]+$/, {timeout:timeoutMs});
  await page.waitForFunction(() => [...document.querySelectorAll('img[data-media-id], img[src*="flow-content.google/image/"], img[src*="media.getMediaUrlRedirect"]')]
    .some(img => img.getBoundingClientRect().width > 0 && img.complete && img.naturalWidth > 0), null, {timeout:timeoutMs});
  return page.evaluate(() => {
    const image = [...document.querySelectorAll('img[data-media-id], img[src*="flow-content.google/image/"], img[src*="media.getMediaUrlRedirect"]')]
      .find(img => img.getBoundingClientRect().width > 0 && img.complete && img.naturalWidth > 0);
    return { assetId:image.getAttribute('data-media-id'), width:image.naturalWidth, height:image.naturalHeight, verified:true };
  });
}
