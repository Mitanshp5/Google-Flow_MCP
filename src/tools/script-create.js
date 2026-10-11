import { createScript } from '../script/planner.js';

export async function handleScriptCreate(args) {
  return createScript(args);
}

export const handleStoryCreate = handleScriptCreate;
