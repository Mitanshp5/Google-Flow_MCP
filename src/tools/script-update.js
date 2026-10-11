import { updateScript } from '../script/planner.js';

export async function handleScriptUpdate(args) {
  return updateScript(args);
}

export const handleStoryUpdate = handleScriptUpdate;
