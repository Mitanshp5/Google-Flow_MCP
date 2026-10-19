import {it,expect,vi} from 'vitest';
import {chromium} from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {takeScreenshot} from '../src/utils/screenshots.js';
it('captures actual Chromium viewport without waiting for an unresolved font-ready promise',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'flow-shot-test-'));
  const b=await chromium.launch({headless:true});
  vi.stubEnv('FLOW_HOME',home);
  try{
    const p=await b.newPage();
    await p.setContent('<style>@keyframes pulse{from{opacity:0.7}to{opacity:1}}h1{animation:pulse 1s infinite alternate}</style><h1>Real screenshot test</h1>');
    await p.evaluate(()=>Object.defineProperty(document,'fonts',{value:{ready:new Promise(()=>{})}}));
    const start=Date.now();
    const file=await takeScreenshot(p,'native-font-wait-regression');
    expect(file).toBeTruthy();
    expect(fs.readFileSync(file).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(Date.now()-start).toBeLessThan(5000);
    expect(await p.evaluate(()=>document.getAnimations().every(a=>a.playState==='running'))).toBe(true);
  }finally{vi.unstubAllEnvs();await b.close();fs.rmSync(home,{recursive:true,force:true});}
});

it('bounds a stalled compositor capture and reports no screenshot instead of hanging the workflow',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'flow-stalled-shot-test-'));
  vi.stubEnv('FLOW_HOME',home);
  vi.useFakeTimers();
  const detach=vi.fn(async()=>{});
  try{
    const pending=takeScreenshot({context:()=>({newCDPSession:async()=>({send:()=>new Promise(()=>{}),detach})})},'stalled');
    await vi.advanceTimersByTimeAsync(10001);
    expect(await pending).toBeNull();
    expect(detach).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(home,'screenshots-debug'))).toEqual([]);
  }finally{vi.useRealTimers();vi.unstubAllEnvs();fs.rmSync(home,{recursive:true,force:true});}
});
