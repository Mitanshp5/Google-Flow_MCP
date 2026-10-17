import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {chromium} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readComposerReferences} from '../src/browser/composer-references.js';
import {readComposerSnapshot,isValidRestoreClaim,compareComposerSnapshots,restoreComposerAfterPicker} from '../src/browser/composer-state.js';
import {attachVideoFrame} from '../src/browser/video-frames.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
let browser,dir;
beforeAll(async()=>{browser=await chromium.launch({headless:true});dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-current-composer-'));});
afterAll(async()=>{await browser?.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});

const chip=(id)=>`<flow-image-ingredient-chip><button aria-busy="false"><img src="https://flow-content.google/image/${id}?signed=1"></button></flow-image-ingredient-chip>`;
const frameBar=()=>`<flow-ingredient-bar><div class="ingredient-bar-container"><div class="frame-trigger"><button onclick="window.slot='start';document.querySelector('#picker').hidden=false">Start</button></div><button aria-label="Swap first and last frames">Swap</button><div class="frame-trigger"><button onclick="window.slot='end';document.querySelector('#picker').hidden=false">End</button></div></div></flow-ingredient-bar>`;
function fixture({frames=false}={}){
  return `<style>flow-base-prompt-box,flow-add-menu-asset-item{display:block;padding:10px}</style>
    <button aria-label="Google Account: Tester (qa@example.com)">Account</button>
    <flow-base-prompt-box>${frames?frameBar():`<flow-ingredient-bar><div class="ingredient-bar-container"><flow-ingredient-chip>${chip('aa-1')}</flow-ingredient-chip></div></flow-ingredient-bar>`}
      <div contenteditable="true">Keep this prompt.</div><flow-add-menu>${frames?'':'<button aria-label="Add ingredients to the prompt box">Add</button>'}</flow-add-menu>
      <button aria-label="Settings trigger">Video · 720p · 4s crop_9_16 x1</button><button class="agent-mode-chip" aria-pressed="false">Agent</button>
    </flow-base-prompt-box>`;
}
async function newPage(html){
  const p=await browser.newPage();
  await p.route('https://flow-content.google/**',r=>r.fulfill({contentType:'image/png',body:png}));
  await p.route('https://flow.google.com/**',r=>r.fulfill({contentType:'text/html',body:html}));
  await p.goto('https://flow.google.com/project/current-fixture');return p;
}
describe('current Flow composer (local live-derived fixtures)',()=>{
  it('cleans only our separating space when Flow already consumed the @ trigger',async()=>{
    const p=await newPage(fixture());try{
      const input=p.locator('[contenteditable]');
      const before=await readComposerSnapshot(p,input);
      await input.fill(before.text+' ');
      const result=await restoreComposerAfterPicker(p,input,before,{triggerDelta:' @'});
      expect(result.restored,JSON.stringify({before,result})).toBe(true);
      expect(await input.textContent()).toBe(before.text);
      expect((await readComposerSnapshot(p,input)).chips).toEqual(before.chips);
    }finally{await p.close();}
  });
  it('observes real ingredient IDs, settings and account/project binding',async()=>{
    const p=await newPage(fixture());try{
      const input=p.locator('[contenteditable]');
      const before=await readComposerSnapshot(p,input),after=await readComposerSnapshot(p,input);
      expect(before.chips[0].assetId).toBe('aa-1');
      expect(before.account).toBe('qa@example.com');expect(before.projectId).toBe('current-fixture');
      expect(isValidRestoreClaim({before,after,claimedBy:'restore-verified'})).toBe(true);
      await p.locator('flow-ingredient-chip img').evaluate(e=>e.src='https://flow-content.google/image/bb-2?renewed=1');
      expect(isValidRestoreClaim({before,after:await readComposerSnapshot(p,input),claimedBy:'restore-verified'})).toBe(false);
    }finally{await p.close();}
  });
  it('recognizes start/end slots anchored around the swap control and rejects changed roles',async()=>{
    const p=await newPage(fixture({frames:true}));try{
      await p.locator('.frame-trigger').first().evaluate((el,html)=>el.innerHTML=html,chip('aa-1'));
      const before=await readComposerSnapshot(p,p.locator('[contenteditable]'));
      expect(before.slots.start.assetId).toBe('aa-1');expect(before.slotsObservable).toBe(true);
      await p.evaluate(()=>{const slots=document.querySelectorAll('.frame-trigger');slots[1].innerHTML=slots[0].innerHTML;slots[0].innerHTML='<button>Start</button>';});
      const after=await readComposerSnapshot(p,p.locator('[contenteditable]'));
      expect(compareComposerSnapshots(before,after).slotsEqual).toBe(false);
      expect(isValidRestoreClaim({before,after,claimedBy:'restore-verified'})).toBe(false);
      await p.getByLabel('Swap first and last frames').evaluate(el=>el.remove());
      expect(await readComposerReferences(p)).toBeNull();
    }finally{await p.close();}
  });
  it('does not certify a placeholder chip or missing account identity',async()=>{
    const p=await newPage(fixture());try{
      await p.locator('flow-ingredient-chip img').evaluate(el=>el.remove());
      const snap=await readComposerSnapshot(p,p.locator('[contenteditable]'));
      expect(snap.chipsObservable).toBe(false);
      expect(isValidRestoreClaim({before:snap,after:snap,claimedBy:'restore-verified'})).toBe(false);
      await p.getByLabel('Google Account: Tester (qa@example.com)').evaluate(el=>el.remove());
      expect((await readComposerSnapshot(p,p.locator('[contenteditable]'))).bindingObservable).toBe(false);
    }finally{await p.close();}
  });
  it('detects lost paragraph boundaries even when textContent is unchanged',async()=>{
    const p=await newPage(fixture());try{
      const input=p.locator('[contenteditable]');
      await input.evaluate(el=>el.innerHTML='<p>First.</p><p>Second.</p>');
      const before=await readComposerSnapshot(p,input);
      await input.evaluate(el=>el.innerHTML='<p>First.Second.</p>');
      const after=await readComposerSnapshot(p,input);
      expect(before.text).toBe(after.text);
      expect(compareComposerSnapshots(before,after).structureEqual).toBe(false);
      expect(isValidRestoreClaim({before,after,claimedBy:'restore-verified'})).toBe(false);
    }finally{await p.close();}
  });
  it('uploads into a real start slot and proves its stable identity without overwriting it',async()=>{
    const p=await newPage(fixture({frames:true})+`<div id="picker" hidden><button onclick="document.querySelector('input').click()">Upload media</button><input type="file" hidden><div id="rows"></div><button id="add">Add to prompt</button></div><script>
      document.querySelector('input').onchange=()=>{const name=document.querySelector('input').files[0].name;window.uploadId=window.slot==='start'?'cc-3':'dd-4';document.querySelector('#rows').innerHTML='<flow-add-menu-asset-item><span class="asset-title">'+name+'</span><img src="https://flow-content.google/image/'+window.uploadId+'?x=1"></flow-add-menu-asset-item>';};
      document.querySelector('#add').onclick=()=>{document.querySelectorAll('.frame-trigger')[window.slot==='start'?0:1].innerHTML='<flow-image-ingredient-chip><button aria-busy="false"><img src="https://flow-content.google/image/'+window.uploadId+'?x=1"></button></flow-image-ingredient-chip>';document.querySelector('#picker').hidden=true;};
      </script>`);
    try{
      const file=path.join(dir,'start.png');fs.writeFileSync(file,png);
      const result=await attachVideoFrame(p,file,'start');
      expect(result.verified,JSON.stringify(result)).toBe(true);
      expect(result.acknowledged[0]).toMatchObject({assetId:'cc-3',slot:'start'});
      const endFile=path.join(dir,'end.png');fs.writeFileSync(endFile,png);
      const endResult=await attachVideoFrame(p,endFile,'end');
      expect(endResult.verified,JSON.stringify(endResult)).toBe(true);
      expect(endResult.acknowledged[0]).toMatchObject({assetId:'dd-4',slot:'end'});
      expect((await attachVideoFrame(p,file,'start')).verified).toBe(false);
    }finally{await p.close();}
  },15000);
  it('accepts direct frame insertion when the picker has no Add-to-prompt confirmation',async()=>{
    const p=await newPage(fixture({frames:true})+`<div id="picker" hidden><button onclick="document.querySelector('input').click()">Upload media</button><input type="file" hidden><div id="rows"></div></div><script>
      document.querySelector('input').onchange=()=>{
        const row=document.createElement('flow-add-menu-asset-item');
        row.innerHTML='<span class="asset-title">direct.png</span><img src="https://flow-content.google/image/ee-5?x=1">';
        row.onclick=()=>{document.querySelector('.frame-trigger').innerHTML=${JSON.stringify(chip('ee-5'))};document.querySelector('#picker').hidden=true;};
        document.querySelector('#rows').append(row);
      };
    </script>`);
    try{
      const file=path.join(dir,'direct.png');fs.writeFileSync(file,png);
      const result=await attachVideoFrame(p,file,'start');
      expect(result.verified,JSON.stringify(result)).toBe(true);
      expect(result.acknowledged[0]).toMatchObject({assetId:'ee-5',slot:'start'});
    }finally{await p.close();}
  },15000);
});
