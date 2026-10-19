import {it,expect} from 'vitest';
import {chromium} from 'playwright';
import {fillCharacterDescription, waitForCharacterPortrait} from '../src/browser/character-form.js';

it('waits for a late archetype response before applying the authored description',async()=>{
  const b=await chromium.launch({headless:true});
  try{
    const p=await b.newPage();
    await p.setContent(`<div contenteditable="true" aria-label="Describe your character…">Old</div><button>The Professional</button>
      <script>document.querySelector('button').onclick=()=>{
        document.querySelector('button').textContent='The Professional Generating...';
        setTimeout(()=>document.querySelector('div').textContent='Preset partial',80);
        setTimeout(()=>{document.querySelector('div').textContent='Preset full response';document.querySelector('button').textContent='The Professional';},180);
      }</script>`);
    const editor=p.getByLabel('Describe your character…');
    await fillCharacterDescription(p,editor,'Arden, graphite jacket.','The Professional');
    await p.waitForTimeout(120);
    expect(await editor.textContent()).toBe('Arden, graphite jacket.');
  }finally{await b.close();}
});

it('does not mistake an empty named character entry for a rendered portrait',async()=>{
  const b=await chromium.launch({headless:true});
  try{
    const p=await b.newPage();
    await p.route('https://flow.google.com/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Arden Vale</h1><p>Generate or add an image of your character</p>'}));
    await p.goto('https://flow.google.com/project/test/character/arden');
    await expect(waitForCharacterPortrait(p,100)).rejects.toThrow();
    await p.setContent('<img data-media-id="portrait" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">');
    expect(await waitForCharacterPortrait(p,1000)).toMatchObject({assetId:'portrait',width:1,height:1,verified:true});
  }finally{await b.close();}
});
