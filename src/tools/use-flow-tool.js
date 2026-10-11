import { getPage } from '../browser/connect.js';
import { takeScreenshot, sanitizeFileName } from '../utils/screenshots.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { escapeRegExp } from '../utils/sanitize.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { isErrorHtml } from '../browser/app-state.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';

export async function exactToolRoot(page, name) {
  for (const root of await page.locator('[data-tool], form[aria-label], section[aria-label], [role="dialog"][aria-label]').all()) {
    const identity = await root.getAttribute('data-tool') || await root.getAttribute('aria-label');
    if (identity?.toLowerCase() === name.toLowerCase() && await root.isVisible()) return root;
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
  if (matches.length !== 1) return false;
  assertUiCurrent(epoch);
  await matches[0].fill(value);
  assertUiCurrent(epoch);
  const actual = await matches[0].inputValue();
  assertUiCurrent(epoch);
  return actual === value;
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
      await navigateToSidebar(page,'Tools');
      assertUiCurrent(epoch);
      const link = page.locator('a, button').filter({hasText:new RegExp('^'+escapeRegExp(name)+'$','i')});
      if (await link.count() === 1 && await link.isVisible()) { assertUiCurrent(epoch); await link.click(); }
    }
    assertUiCurrent(epoch);
    const title = await page.title();
    const bodyText = await page.locator('body').innerText();
    assertUiCurrent(epoch);
    const base = {tool:name,url:page.url()};
    if (isErrorHtml({title,bodyText,url:page.url()})) return {...base,status:'blocked',reason:'tool_not_found'};
    if (/Upgrade to create|Upgrade to remix|Upgrade required|Upgrade plan/i.test(bodyText)) return {...base,status:'blocked',reason:'entitlement_required'};
    root = await exactToolRoot(page,name);
    if (!root) return {...base,status:'blocked',reason:'tool_not_found',message:'Requested tool form could not be positively identified.'};
    const unapplied_fields = [];
    for (const [key,value] of Object.entries(args.params || {})) {
      if (!await fillExactField(root,key,value,epoch)) unapplied_fields.push(key);
    }
    const screenshot = await takeScreenshot(page,sanitizeFileName('tool-'+name));
    assertUiCurrent(epoch);
    return {...base,status:unapplied_fields.length ? 'prepared_unverified' : 'tool_opened',unapplied_fields,screenshot};
  });
}
