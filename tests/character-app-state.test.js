import {it,expect} from 'vitest';
import {classifyAppState} from '../src/browser/app-state.js';
const html='<div contenteditable="true" aria-label="Describe your character…"></div><button aria-label="Select model family">Nano Banana 2.1</button><button aria-label="Start generation">Go</button>';
it('recognizes hydrated native character editors without requiring a library sidebar',()=>{
  expect(classifyAppState({url:'https://flow.google.com/project/p/character/c',html})).toMatchObject({app:'ready',reason:'flow-character-editor'});
  const edit='<flow-character-edit-page><flow-character-form><input aria-label="Character name"><flow-character-prompt-box><div contenteditable="true" aria-label="Describe your character…"></div><button aria-label="Start generation">Go</button></flow-character-prompt-box></flow-character-form></flow-character-edit-page>';
  expect(classifyAppState({url:'https://flow.google.com/project/p/character/c',html:edit})).toMatchObject({app:'ready',reason:'flow-character-editor'});
  const beforeComposer='<flow-character-edit-page><flow-character-form><input aria-label="Character name"><flow-character-preview-panel><button>Create body</button></flow-character-preview-panel></flow-character-form></flow-character-edit-page>';
  expect(classifyAppState({url:'https://flow.google.com/project/p/character/c',html:beforeComposer})).toMatchObject({app:'ready',reason:'flow-character-editor'});
});
it('does not recognize an ordinary composer, hidden controls or a different origin as a character editor',()=>{
  expect(classifyAppState({url:'https://other.example/project/p/character/c',html}).app).not.toBe('ready');
  expect(classifyAppState({url:'https://flow.google.com/project/p/character/c',html:'<textarea>Draft</textarea>'}).app).not.toBe('ready');
  expect(classifyAppState({url:'https://flow.google.com/project/p/character/c',html:`<div hidden>${html}</div>`}).app).not.toBe('ready');
});
