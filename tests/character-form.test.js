import {it,expect} from 'vitest';
import {chromium} from 'playwright';
import {fillCharacterDescription, waitForCharacterPortrait} from '../src/browser/character-form.js';
import {normalizePromptText, readEditorText} from '../src/utils/prompt.js';

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

it('verifies multi-paragraph Slate-like contenteditable blocks without concatenation false mismatch',async()=>{
  const b=await chromium.launch({headless:true});
  try{
    const p=await b.newPage();
    await p.setContent(`<div id="ed" contenteditable="true" aria-label="Describe your character…"></div>
      <script>
        const ed = document.getElementById('ed');
        let lastInputData = '';
        ed.addEventListener('beforeinput', (e) => {
          if (typeof e.data === 'string' && e.data.includes('\\n')) lastInputData = e.data;
        });
        let formatting = false;
        ed.addEventListener('input', () => {
          if (formatting) return;
          formatting = true;
          const raw = lastInputData || ed.innerText || ed.textContent || '';
          lastInputData = '';
          const lines = raw.split(/\\r?\\n/);
          if (lines.length > 1) {
            // Simulate Slate rendering each paragraph as an adjacent <p> element + zero-width BOM on blank lines.
            ed.innerHTML = lines.map(line => line.trim()
              ? '<p>' + line.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</p>'
              : '<p><span data-slate-zero-width="n">\\uFEFF</span><br></p>').join('');
          }
          formatting = false;
        });
      </script>`);
    const desc = [
      'Vesper — original female action character (painterly 3D design).',
      ' ',
      'She is a young adult woman, agile and athletic.',
      ' ',
      'Full body character reference sheet: no text, no logos.',
    ].join('\n');
    const editor = p.getByLabel('Describe your character…');
    await fillCharacterDescription(p, editor, desc);
    // Confirm readEditorText + normalizePromptText preserve paragraph boundaries across <p>/contenteditable:
    expect(normalizePromptText(await readEditorText(editor))).toBe(normalizePromptText(desc));
    // Also verify raw <p> concatenation without spaces (\uFEFF between blocks) reads back cleanly via readEditorText:
    await editor.evaluate((el) => {
      el.innerHTML = '<p>Alpha block.</p><p><span data-slate-zero-width="n">\uFEFF</span><br></p><p>Beta block.</p>';
    });
    expect(await editor.textContent()).toBe('Alpha block.\uFEFFBeta block.');
    expect(normalizePromptText(await readEditorText(editor))).toBe('Alpha block. Beta block.');
  }finally{await b.close();}
});

it('fails closed with diagnostic details when character description actually mismatches',async()=>{
  const b=await chromium.launch({headless:true});
  try{
    const p=await b.newPage();
    await p.setContent(`<div id="ed" contenteditable="true" aria-label="Describe your character…"></div>
      <script>
        const ed = document.getElementById('ed');
        ed.addEventListener('input', () => { ed.textContent = 'Truncated'; });
      </script>`);
    const editor = p.getByLabel('Describe your character…');
    await expect(fillCharacterDescription(p, editor, 'Vesper full description')).rejects.toMatchObject({
      code: 'UNKNOWN_UI_CHANGE',
      details: expect.objectContaining({
        expectedLength: 23,
        actualLength: 9,
      }),
    });
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
