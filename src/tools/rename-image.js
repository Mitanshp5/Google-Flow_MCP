import { getPage } from '../browser/connect.js';
import { ensureProjectInContext, ensureProjectLibrary, navigateToSidebar } from '../navigation/project-navigator.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { withUiTransaction } from '../browser/ui-transaction.js';

// Exact tile identity only: never use the project's similarly named header.
export async function handleRenameImage(args, deps = {}) {
  return withUiTransaction(async () => {
  const page = deps.page || getPage();
  await (deps.ensureProject || ensureProjectInContext)(page, {
    name: args.project_name, campaign: args.campaign, project_url: args.project_url,
  });
  // Same-project context may still be a standalone character/tool editor,
  // which has no library sidebar. Return to that verified project's root.
  await ensureProjectLibrary(page);
  if (!(await (deps.navigate || navigateToSidebar)(page, 'Images'))) {
    throw new FlowError(ErrorCodes.FLOW_PAGE_NOT_FOUND, 'Images section did not open');
  }
  const matches = [];
  for (const tile of await page.locator('flow-image-tile').all()) {
    if (!(await tile.isVisible())) continue;
    const { id, title } = await tile.evaluate(el => ({
      id: el.querySelector('img[data-media-id]')?.getAttribute('data-media-id') || null,
      title: el.querySelector('.footer-title')?.textContent?.trim() || '',
    }));
    if (args.asset_id ? id === args.asset_id : title === args.name) matches.push({ tile, id, title });
  }
  if (matches.length !== 1) {
    throw new FlowError(ErrorCodes.INVALID_PARAMS, `Expected one exact image, found ${matches.length}. Use a unique asset_id or exact name.`);
  }
  const { tile, id, title } = matches[0];
  await tile.hover();
  await tile.getByRole('button', { name: 'More options', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: /^(?:edit\s*)?Rename$/ }).click();
  const editor = page.locator('input.editing[aria-label="Editable text"]:visible');
  await editor.waitFor({ state: 'visible', timeout: 5000 });
  if (await editor.count() !== 1) throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Image rename editor is ambiguous');
  await editor.fill(args.new_name);
  await editor.locator('..').getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(600);
  if ((await tile.locator('.footer-title').textContent()).trim() !== args.new_name) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, 'Image rename did not pass read-back');
  }
  return { status: 'renamed', asset_id: id, from: title, to: args.new_name,
    screenshot: await (deps.screenshot || takeScreenshot)(page, 'image-renamed') };
  });
}
