import { getPage } from '../browser/connect.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { ensureManualMode } from '../browser/safe-actions.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { ensureProjectInContext, navigateToSidebar } from '../navigation/project-navigator.js';
import { isErrorHtml } from '../browser/app-state.js';
import { withUiTransaction, assertUiCurrent } from '../browser/ui-transaction.js';
import { exactToolRoot, fillExactField } from './use-flow-tool.js';

export async function handleUseGridArchitect(args) {
  if (typeof args.theme_prompt !== 'string' || !args.theme_prompt.trim()) throw new FlowError(ErrorCodes.INVALID_PARAMS,'theme_prompt is required and must be a non-empty string');
  const job = jobQueue.createJob('grid_architect',args);
  try {
    jobQueue.startJob(job.id);
    return await withUiTransaction(async ({epoch}) => {
      const page = getPage();
      assertUiCurrent(epoch);
      await ensureProjectInContext(page,{name:args.project_name,campaign:args.campaign,project_url:args.project_url});
      assertUiCurrent(epoch);
      let root = await exactToolRoot(page,'grid-architect') || await exactToolRoot(page,'Grid Architect');
      if (!root) {
        await navigateToSidebar(page,'Tools');
        assertUiCurrent(epoch);
        const link = page.getByRole('link',{name:'Grid Architect',exact:true}).or(page.getByRole('button',{name:'Grid Architect',exact:true}));
        if (await link.count() === 1 && await link.isVisible()) { assertUiCurrent(epoch); await link.click(); }
      }
      assertUiCurrent(epoch);
      const bodyText = await page.locator('body').innerText();
      const title = await page.title();
      assertUiCurrent(epoch);
      const base = {url:page.url(),jobId:job.id};
      const blocked = (reason,message) => {
        assertUiCurrent(epoch);
        jobQueue.failJob(job.id,new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE,message));
        return {...base,status:'blocked',reason,message};
      };
      if (isErrorHtml({title,bodyText,url:page.url()})) return blocked('page_not_found','Grid Architect page not found.');
      if (/Upgrade to create|Upgrade to remix|Upgrade required|Upgrade plan/i.test(bodyText)) return blocked('entitlement_required','Grid Architect requires an upgraded entitlement.');
      root = await exactToolRoot(page,'grid-architect') || await exactToolRoot(page,'Grid Architect');
      if (!root) return blocked('grid_architect_form_not_found','Grid Architect tool form could not be positively identified.');
      assertUiCurrent(epoch);
      await ensureManualMode(page);
      assertUiCurrent(epoch);
      const unapplied_fields = [];
      if (!await fillExactField(root,'theme',args.theme_prompt,epoch)) unapplied_fields.push('theme_prompt');
      for (const key of ['engine','ratio','visual_logic']) {
        if (args[key] !== undefined && !await fillExactField(root,key,args[key],epoch)) unapplied_fields.push(key);
      }
      for (const [i,value] of (args.shot_prompts || []).entries()) {
        if (!await fillExactField(root,'Shot '+(i+1),value,epoch)) unapplied_fields.push('shot_prompts['+i+']');
      }
      // Picker state alone cannot prove reference ingestion.
      if (args.references?.length) unapplied_fields.push('references');
      const screenshot = await takeScreenshot(page,'grid-architect-prepared');
      assertUiCurrent(epoch);
      const result = {...base,status:unapplied_fields.length ? 'prepared_unverified' : 'ready_for_confirmation',unapplied_fields,screenshot,message:'Preparation only; generation requires manual confirmation.'};
      jobQueue.completeJob(job.id,result);
      return result;
    });
  } catch (error) { jobQueue.failJob(job.id,error); throw error; }
}
