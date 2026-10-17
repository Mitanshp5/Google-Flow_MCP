import {openBarSettings, closeSettingsPanel} from './safe-actions.js';
import {uploadReferences} from './upload.js';
import {readComposerReferences} from './composer-references.js';

export async function setVideoReferenceMode(page, mode) {
  const {panel, error} = await openBarSettings(page);
  if (!panel) return {ok:false, verified:false, kind:'reference_mode', detail:error};
  try {
    const option = panel.getByRole('radio', {name: mode === 'frames' ? /Frames$/i : /Ingredients$/i});
    if (await option.count() !== 1) return {ok:false, verified:false, kind:'reference_mode', detail:`${mode} toggle missing or ambiguous`};
    if (await option.getAttribute('aria-checked') !== 'true') await option.click({timeout:3000});
    const verified = await option.getAttribute('aria-checked') === 'true';
    return {ok:verified, verified, kind:'reference_mode', detail:mode};
  } finally { await closeSettingsPanel(page); }
}

export async function attachVideoFrame(page, file, slot) {
  if (!['start', 'end'].includes(slot)) throw new Error('Unknown frame slot');
  const before = await readComposerReferences(page);
  if (before?.mode !== 'frames' || !before.slotsObservable) {
    return {verified:false, notes:['Frame controls could not be positively identified'], acknowledged:[]};
  }
  // Never silently replace a user's already populated frame (chip click removes it).
  if (before.slots[slot]) return {verified:false, notes:[`${slot} frame already populated; refusing to overwrite it`], acknowledged:[]};
  const trigger = page.locator('flow-base-prompt-box flow-ingredient-bar .frame-trigger').nth(slot === 'start' ? 0 : 1);
  return uploadReferences(page, null, [file], {entryLocator:trigger.getByRole('button', {name:slot === 'start' ? 'Start' : 'End', exact:true}), slot});
}
