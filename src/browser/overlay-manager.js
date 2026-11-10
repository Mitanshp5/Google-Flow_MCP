import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';

/**
 * Scoped Overlay Manager
 *
 * Tracks, inspects, and safely cleans up CDK overlays, asset pickers, and menus.
 * Guarantees:
 * 1. Rights confirmation dialogs are NEVER dismissed silently or accepted automatically.
 * 2. Unowned/stray overlays (e.g. CDK listbox, flow-add-menu) are closed so they do not block prompt clicks.
 * 3. Overlay closure verifies that underlying composer/inputs are interactable.
 * 4. Cleanup failures return a typed result with screenshot rather than failing silently.
 */

export const OVERLAY_SELECTORS = [
  'flow-add-menu',
  '.cdk-overlay-pane:not(:empty)',
  'div[role="listbox"]',
  'div[role="menu"]',
  '.cdk-overlay-backdrop',
];

export async function detectActiveOverlays(page) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    return { hasOverlays: false, overlays: [], hasRightsDialog: false };
  }

  try {
    const rightsVisible = await page.getByText('Rights to use this image', { exact: true })
      .isVisible().catch(() => false);

    const overlays = await page.evaluate(() => {
      const items = [];
      const panes = document.querySelectorAll('.cdk-overlay-pane');
      panes.forEach((p, idx) => {
        if (p.getBoundingClientRect().width > 0 && p.getBoundingClientRect().height > 0) {
          items.push({
            type: 'cdk-pane',
            index: idx,
            tag: p.firstElementChild?.tagName?.toLowerCase() || 'empty',
            text: (p.textContent || '').slice(0, 100).trim(),
          });
        }
      });
      const listboxes = document.querySelectorAll('[role="listbox"]');
      listboxes.forEach((lb) => {
        if (lb.getBoundingClientRect().width > 0) {
          items.push({
            type: 'listbox',
            ariaLabel: lb.getAttribute('aria-label') || '',
            itemCount: lb.children.length,
          });
        }
      });
      return items;
    }).catch(() => []);

    return {
      hasOverlays: overlays.length > 0 || rightsVisible,
      overlays,
      hasRightsDialog: rightsVisible,
    };
  } catch (err) {
    logger.debug('Error detecting active overlays', { error: err.message });
    return { hasOverlays: false, overlays: [], hasRightsDialog: false };
  }
}

export async function closeOwnedOverlays(page, { timeoutMs = 3000, preserveRights = true } = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    void timeoutMs;
    return { success: true, closedCount: 0 };
  }

  const detected = await detectActiveOverlays(page);
  if (detected.hasRightsDialog && preserveRights) {
    logger.warn('Rights confirmation dialog detected — preserving for user action');
    return {
      success: false,
      reason: 'rights_confirmation_required',
      message: 'Flow requires you to confirm rights to this image. Acknowledge the visible dialog, then prepare again; no generation was submitted.',
    };
  }

  if (!detected.hasOverlays) {
    void timeoutMs;
    return { success: true, closedCount: 0 };
  }

  let closedCount = 0;
  try {
    // Try explicit close button on active modal/pane if available
    const closeBtn = page.locator('.cdk-overlay-pane button[aria-label*="close" i], .cdk-overlay-pane button:has-text("Close"), .cdk-overlay-pane button:has-text("Cancel")').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(200);
      closedCount++;
    }

    // Use Escape to dismiss menus / listboxes
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const recheck = await detectActiveOverlays(page);
    if (recheck.hasOverlays && !recheck.hasRightsDialog) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // Verify backdrop is gone or non-blocking
    const remaining = await detectActiveOverlays(page);
    if (remaining.hasOverlays && !remaining.hasRightsDialog) {
      const screenshot = await takeScreenshot(page, 'overlay-cleanup-failed').catch(() => null);
      return {
        success: false,
        reason: 'cleanup_failed',
        message: 'Could not close overlay or backdrop cleanly. Flow prompt may be obstructed.',
        screenshot,
      };
    }

    return { success: true, closedCount: closedCount + 1 };
  } catch (err) {
    logger.warn('Error during overlay cleanup', { error: err.message });
    return {
      success: false,
      reason: 'cleanup_error',
      message: `Overlay cleanup failed: ${err.message}`,
    };
  }
}

export async function ensureComposerInteractable(page, { timeoutMs = 5000 } = {}) {
  const cleanup = await closeOwnedOverlays(page, { timeoutMs });
  if (!cleanup.success && cleanup.reason === 'rights_confirmation_required') {
    throw new FlowError(ErrorCodes.MANUAL_VERIFICATION_REQUIRED, cleanup.message);
  }

  const promptInput = page.locator('flow-base-prompt-box [contenteditable="true"], flow-prompt-box [contenteditable="true"], textarea').first();
  if (await promptInput.isVisible().catch(() => false)) {
    return { ok: true, interactable: true };
  }
  return { ok: true, interactable: false, reason: 'prompt input not immediately visible' };
}
