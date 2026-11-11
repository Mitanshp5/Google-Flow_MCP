import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext, ensureProjectLibrary, navigateToSidebar } from '../navigation/project-navigator.js';
import { openGalleryToolByName } from './open-tools-gallery.js';
import { isErrorHtml } from '../browser/app-state.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';

export async function exactToolRoot(page, name) {
  for (const root of await page.locator('[data-tool], form[aria-label], section[aria-label], [role="dialog"][aria-label]').all()) {
    const identity = await root.getAttribute('data-tool') || await root.getAttribute('aria-label');
    if (identity?.toLowerCase() === name.toLowerCase() && await root.isVisible()) return root;
  }
  const appletPage = page.locator('flow-applet-view-page').first();
  if (await appletPage.isVisible().catch(() => false)) {
    const titleInput = appletPage.locator('flow-applet-view-header input.editable-text-input').first();
    const titleVal = (await titleInput.inputValue().catch(() => '')).trim();
    const isAppletRoute = /\/project\/[^/]+\/tool\/[^/]+/i.test(page.url());
    const hasPromptBox = await appletPage.locator('flow-applet-prompt-box, flow-base-prompt-box, [role="textbox"]').first().isVisible().catch(() => false);
    if ((titleVal && titleVal.toLowerCase() === name.toLowerCase()) || (isAppletRoute && hasPromptBox)) {
      return appletPage;
    }
  }
  return null;
}

// Caller strings are data, never selector fragments.
export async function fillExactField(root, name, value, epoch) {
  if (typeof value !== 'string') return false;
  const matches = [];
  for (const input of await root.locator('input:not([type="file"]):not([type="submit"]):not([type="button"]), textarea').all()) {
    const identities = await Promise.all(['name','placeholder','aria-label'].map(a => input.getAttribute(a)));
    if (identities.some(v => v?.toLowerCase() === name.toLowerCase()) && await input.isVisible()) matches.push(input);
  }
  if (matches.length === 1) {
    assertUiCurrent(epoch);
    await matches[0].fill(value);
    assertUiCurrent(epoch);
    const actual = await matches[0].inputValue();
    assertUiCurrent(epoch);
    return actual === value;
  }
  const textboxMatches = [];
  for (const tb of await root.locator('[role="textbox"], [contenteditable="true"]').all()) {
    const aria = await tb.getAttribute('aria-label');
    if ((aria?.toLowerCase() === name.toLowerCase() || (name.toLowerCase() === 'prompt' && await tb.locator('xpath=ancestor::flow-applet-prompt-box').count() > 0)) && await tb.isVisible()) {
      textboxMatches.push(tb);
    }
  }
  if (textboxMatches.length !== 1) return false;
  assertUiCurrent(epoch);
  await textboxMatches[0].locator('xpath=ancestor::flow-applet-view-page').locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await textboxMatches[0].scrollIntoViewIfNeeded().catch(() => {});
  await textboxMatches[0].click({ position: { x: 16, y: 10 }, timeout: 2500 }).catch(() => {});
  await textboxMatches[0].evaluate((el, val) => {
    el.focus();
    document.execCommand?.('selectAll', false, null);
    el.textContent = val;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
  }, value);
  assertUiCurrent(epoch);
  const actual = (await textboxMatches[0].innerText().catch(() => '')).trim();
  assertUiCurrent(epoch);
  return actual === value.trim();
}

export async function handleUseFlowTool(args) {
  const toolName = args.tool_name || args.name;
  if (typeof toolName !== 'string' || !toolName.trim()) throw new FlowError(ErrorCodes.INVALID_PARAMS,'Tool name is required');
  const name = toolName.trim().slice(0,100);
  return withUiTransaction(async ({epoch}) => {
    const page = getPage();
    assertUiCurrent(epoch);
    await ensureProjectInContext(page,{name:args.project_name,campaign:args.campaign,project_url:args.project_url});
    assertUiCurrent(epoch);
    let root = await exactToolRoot(page,name);
    if (!root) {
      await ensureProjectLibrary(page);
      assertUiCurrent(epoch);
      await navigateToSidebar(page,'Tools');
      await page.waitForTimeout(1500).catch(() => {});
      assertUiCurrent(epoch);
      await openGalleryToolByName(page, name);
    }
    assertUiCurrent(epoch);
    const title = await page.title();
    const bodyText = await page.locator('body').innerText();
    assertUiCurrent(epoch);
    const base = {tool:name,url:page.url()};
    if (isErrorHtml({title,bodyText,url:page.url()})) return {...base,status:'blocked',reason:'tool_not_found'};
    root = await exactToolRoot(page,name);
    if (!root) {
      if (/Upgrade to create|Upgrade to remix|Upgrade required|Upgrade plan/i.test(bodyText)) {
        return {...base,status:'blocked',reason:'entitlement_required'};
      }
      return {...base,status:'blocked',reason:'tool_not_found',message:'Requested tool form could not be positively identified.'};
    }
    if (await page.locator('.modal, [role="dialog"]').filter({hasText:/Upgrade to create|Upgrade to remix|Upgrade required|Upgrade plan/i}).first().isVisible().catch(() => false)) {
      return {...base,status:'blocked',reason:'entitlement_required'};
    }
    const unapplied_fields = [];
    for (const [key,value] of Object.entries(args.params || {})) {
      if (!await fillExactField(root,key,value,epoch)) unapplied_fields.push(key);
    }
    const screenshot = await takeScreenshot(page,sanitizeFileName('tool-'+name));
    assertUiCurrent(epoch);
    return {...base,status:unapplied_fields.length ? 'prepared_unverified' : 'tool_opened',unapplied_fields,screenshot};
  });
}
