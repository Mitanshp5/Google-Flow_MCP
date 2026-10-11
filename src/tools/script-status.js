import { getScriptStatus } from '../script/planner.js';

export async function handleScriptStatus(args) {
  return getScriptStatus(args);
}

export const handleStoryStatus = handleScriptStatus;
