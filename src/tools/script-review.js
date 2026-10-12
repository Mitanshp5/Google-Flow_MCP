import { reviewScriptNode } from '../script/planner.js';
import { scoreCandidate, selectReference } from '../script/reference-review.js';
import { FlowError } from '../utils/errors.js';

export async function handleScriptReview(args) {
  const normalized = { ...args, scriptId: args?.scriptId ?? args?.storyId };
  // No action means exact existing W08 node review (unchanged).
  if (!normalized?.action) {
    return reviewScriptNode(normalized);
  }
  if (normalized.action === 'score_candidate') {
    return scoreCandidate(normalized);
  }
  if (normalized.action === 'select_reference') {
    return selectReference(normalized);
  }
  if (normalized.action === 'reference_pack') {
    const mod = await import('../script/reference-review.js');
    if (typeof mod.createReferencePack !== 'function') {
      throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reference_pack not yet available in this slice', { action: normalized.action });
    }
    return mod.createReferencePack(normalized);
  }
  throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown review action: ${normalized.action}`, { action: normalized.action });
}

export const handleStoryReview = handleScriptReview;
