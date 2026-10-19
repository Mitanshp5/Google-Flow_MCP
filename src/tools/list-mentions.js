import { logger } from '../utils/logger.js';
import { getPage } from '../browser/connect.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext } from '../navigation/project-navigator.js';
import { listMentionOptionsDetailed } from '../navigation/mentions.js';
import {
  readComposerSnapshot,
  compareComposerSnapshots,
  isValidRestoreClaim,
} from '../browser/composer-state.js';

// W04: truthful empty-vs-failed classification. Empty (picker opened, zero
// rows) is success-empty; failed (picker never opened) is blocked.
export function classifyMentionListing({ pickerStatus = 'failed', names = [] } = {}) {
  if (pickerStatus === 'ok' && names.length > 0) {
    return { toolStatus: 'success', picker: 'ok', message: `Found ${names.length} reference(s) available via @name.` };
  }
  if (pickerStatus === 'empty' || (pickerStatus === 'ok' && names.length === 0)) {
    return { toolStatus: 'success', picker: 'empty', message: 'Picker opened; project has no @ references yet.' };
  }
  return { toolStatus: 'blocked', picker: 'failed', message: 'Could not open the @ picker; references unknown (not proven empty).' };
}

export function hasPreparedState(snap) {
  if (!snap) return false;
  if (typeof snap.text === 'string' && snap.text.trim().length > 0) return true;
  if (Array.isArray(snap.chips) && snap.chips.length > 0) return true;
  if (snap.slots && Object.keys(snap.slots).length > 0) return true;
  if (Array.isArray(snap.pendingUploads) && snap.pendingUploads.length > 0) return true;
  return false;
}

async function findPromptInput(page) {
  const cands = [
    page.locator('[contenteditable="true"]:visible').first(),
    page.locator('textarea:visible').first(),
    page.locator('[contenteditable="true"]').first(),
    page.locator('#prompt').first(),
  ];
  for (const c of cands) {
    try {
      if (await c.isVisible().catch(() => false)) return c;
    } catch { /* next */ }
  }
  // Fallback for fixture pages where visibility is not computed.
  for (const c of cands) {
    try {
      if ((await c.count().catch(() => 0)) > 0) return c;
    } catch { /* next */ }
  }
  return null;
}

/**
 * List the names available in Google Flow's "@" reference popup —
 * i.e. the images and characters in the current project that can be
 * used as ingredients via @name in an image/video prompt.
 * deps injection is test-only; production callers pass args alone.
 */
export async function handleListMentionOptions(args = {}, deps = {}) {
  const page = deps.page || getPage();
  const ensureFn = deps.ensureProjectFn || ensureProjectInContext;
  const shotFn = deps.takeScreenshotFn || takeScreenshot;

  // 1. Capture the FULL rich snapshot BEFORE any navigation/listing.
  let preInput = await findPromptInput(page);
  let before = null;
  try {
    if (preInput) before = await readComposerSnapshot(page, preInput);
  } catch {
    before = null;
  }
  const hadPrepared = hasPreparedState(before);

  // 2. Targeted navigation (may reload and wipe the composer).
  await ensureFn(page, {
    name: args.project_name,
    campaign: args.campaign,
  });

  // 3. Re-resolve the prompt input after navigation.
  const promptInput = (await findPromptInput(page)) || preInput;
  if (!promptInput) {
    await shotFn(page, 'no-prompt-input-for-mentions').catch(() => null);
    throw new FlowError(
      ErrorCodes.UNKNOWN_UI_CHANGE,
      'Could not find a prompt input to open the @ reference popup from.'
    );
  }

  const detailed = await listMentionOptionsDetailed(page, promptInput);
  const names = detailed.names;
  const classified = classifyMentionListing({ pickerStatus: detailed.status, names });
  logger.info('Listed @ mention options', { count: names.length, picker: detailed.status });

  // 4. Re-read FULL rich state and strictly compare (binding included).
  // Text-only equality never counts as preserved.
  let after = null;
  try {
    after = await readComposerSnapshot(page, promptInput);
  } catch {
    after = null;
  }
  let composer = { state: 'unknown' };
  let richChanged = false;
  if (before && after) {
    const cmp = compareComposerSnapshots(before, after);
    const preserved = isValidRestoreClaim({ before, after, claimedBy: 'restore-verified' });
    if (preserved) {
      composer = { state: 'preserved', comparison: cmp };
    } else {
      richChanged = true;
      composer = {
        state: cmp.equal ? 'unverified' : 'invalidated',
        reason: cmp.equal ? 'composer preservation could not be verified from the available UI evidence' : 'composer rich state changed during listing',
        comparison: cmp,
      };
    }
  }
  // Focus returns to the composer; stray @ residue is already removed by the
  // picker close path using the exact trigger delta.
  try {
    await promptInput.click().catch(() => {});
  } catch { /* ignore */ }

  if (classified.toolStatus === 'blocked') {
    return {
      status: 'blocked',
      references: [],
      picker: detailed.status,
      reason: detailed.reason,
      message: classified.message,
      composer,
      screenshot: await shotFn(page, 'mention-options-failed').catch(() => null),
    };
  }
  // Changed prepared state invalidates even a successful read: no success
  // with text-only preservation — unless only plain text was prepared (no
  // chips/slots/uploads) and it can be restored verbatim, re-verified below.
  if (hadPrepared && richChanged && before && after) {
    const noRefs = (s) => (!s || ((s.chips || []).length === 0 && Object.keys(s.slots || {}).length === 0 && (s.pendingUploads || []).length === 0));
    // Unknown chip/slot observation is NOT proof of a text-only composer.
    // Never clear/retype a rich prompt merely because our selectors missed it.
    if (before.chipsObservable && after.chipsObservable && before.slotsObservable && after.slotsObservable
      && noRefs(before) && noRefs(after) && typeof before.text === 'string' && before.text.trim()) {
      try {
        await promptInput.click().catch(() => {});
        await promptInput.fill(before.text).catch(() => {});
        await page.waitForTimeout(400);
        const reread = await readComposerSnapshot(page, promptInput).catch(() => null);
        if (reread && isValidRestoreClaim({before, after: reread, claimedBy: 'restore-verified'})) {
          composer = { state: 'restored', comparison: compareComposerSnapshots(before, reread) };
          richChanged = false;
        }
      } catch { /* fall through to blocked */ }
    }
  }
  if (hadPrepared && richChanged) {
    return {
      status: 'blocked',
      references: [],
      picker: detailed.status,
      reason: composer.state === 'unverified' ? 'composer-preservation-unverified' : 'composer-prepared-state-lost',
      message: composer.state === 'unverified'
        ? 'References were read, but prepared composer preservation could not be verified. No text-only rewrite was attempted.'
        : 'Listing changed prepared composer state; preparation invalidated rather than silently reloaded.',
      composer,
      screenshot: await shotFn(page, 'mention-options-invalidated').catch(() => null),
    };
  }

  return {
    status: 'success',
    references: names,
    picker: detailed.status,
    message: classified.message,
    composer,
    screenshot: await shotFn(page, 'mention-options').catch(() => null),
  };
}
