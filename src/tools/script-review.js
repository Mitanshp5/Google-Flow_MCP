import { reviewScriptNode } from '../script/planner.js';

export async function handleScriptReview(args) {
  return reviewScriptNode(args);
}

export const handleStoryReview = handleScriptReview;
