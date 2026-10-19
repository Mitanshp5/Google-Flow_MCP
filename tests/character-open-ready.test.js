import {it,expect,vi} from 'vitest';
import {chromium} from 'playwright';
import {withPage} from '../src/browser/session-scope.js';
import {handleFlowOpen} from '../src/tools/flow-open.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
it('waits for native-editor hydration instead of returning a premature loading snapshot',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'flow-ready-test-'));
  vi.stubEnv('FLOW_HOME',home);vi.stubEnv('FLOW_EXPECTED_ACCOUNT','creator@example.com');
  const b=await chromium.launch({headless:true});
  try{
    const p=await b.newPage();
    await p.route('https://flow.google.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<span data-account-email="creator@example.com">creator@example.com</span><script>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<flow-character-edit-page><flow-character-form><input aria-label="Character name"><flow-character-prompt-box><div contenteditable="true" aria-label="Describe your character…"></div><button aria-label="Start generation">Go</button></flow-character-prompt-box></flow-character-form></flow-character-edit-page>'),150)</script>`}));
    const result=await withPage(p,()=>handleFlowOpen({url:'https://flow.google.com/project/p/character/c',waitFor:100}));
    expect(result).toMatchObject({status:'connected',app:'ready',isLoggedIn:true,isFlowPage:true});
  }finally{await b.close();vi.unstubAllEnvs();fs.rmSync(home,{recursive:true,force:true});}
});
