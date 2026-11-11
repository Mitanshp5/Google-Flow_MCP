import { FlowError, ErrorCodes } from '../utils/errors.js';

export const DEFAULT_STORY_BUDGET_CREDITS = 50;

export const MODEL_CREDIT_RATES = Object.freeze({
  veo_quality: 50,
  veo_fast: 20,
  veo_lite: 20,
  omni_flash: 10,
  omni_1_2_flash: 24,
});

/**
 * Determine estimated credit rate per video take based on model name.
 * Non-video preparation (images, characters, locations, props) is free (0 credits).
 */
export function resolveVideoModelCreditRate(modelName) {
  const m = String(modelName || '').trim().toLowerCase();
  if (/omni/.test(m) && /1\.2/.test(m)) {
    return MODEL_CREDIT_RATES.omni_1_2_flash;
  }
  if (!m || m === 'auto' || /omni/.test(m)) {
    return MODEL_CREDIT_RATES.omni_flash;
  }
  if (/veo/.test(m) && /quality/.test(m)) {
    return MODEL_CREDIT_RATES.veo_quality;
  }
  if (/veo/.test(m) && /fast/.test(m)) {
    return MODEL_CREDIT_RATES.veo_fast;
  }
  if (/veo/.test(m) && /lite/.test(m)) {
    return MODEL_CREDIT_RATES.veo_lite;
  }
  if (/veo/.test(m)) {
    return MODEL_CREDIT_RATES.veo_fast;
  }
  return MODEL_CREDIT_RATES.omni_flash;
}

/**
 * Estimate required video credits for a single shot card.
 */
export function estimateShotCredits(shot = {}, brief = {}) {
  const rawQty = shot.quantity ?? shot.takes ?? 1;
  const parsedQty = Number(rawQty);
  const quantity = Number.isInteger(parsedQty) && parsedQty >= 1 ? parsedQty : 1;
  const model = String(
    shot.model || shot.videoModel || shot.generation?.model || brief?.videoModel || brief?.model || 'Omni 1.1 Flash'
  ).trim();

  const explicitCost = shot.estimatedCredits ?? shot.credits;
  let creditsPerTake;
  let rateSource;
  if (explicitCost !== undefined && explicitCost !== null) {
    const n = Number(explicitCost);
    if (!Number.isFinite(n) || n < 0) {
      throw new FlowError(
        'INVALID_STORY_SCHEMA',
        `[INVALID_STORY_SCHEMA] Shot ${shot.id || '(unknown)'} estimatedCredits must be a non-negative finite number`,
        { shotId: shot.id, estimatedCredits: explicitCost }
      );
    }
    creditsPerTake = n;
    rateSource = 'explicit_shot_estimate';
  } else {
    creditsPerTake = resolveVideoModelCreditRate(model);
    rateSource = 'model_rate_table';
  }

  return {
    shotId: shot.id || null,
    model,
    quantity,
    creditsPerTake,
    estimatedCredits: creditsPerTake * quantity,
    rateSource,
  };
}

/**
 * Resolve story credit allocation configuration from input or prior revision config.
 * Defaults to 50 credits when no explicit allocated budget is set.
 */
export function resolveAllocatedBudgetConfig(input = {}, fallbackConfig = null) {
  const rawTop = input.allocatedBudget ?? input.allocated_budget;
  const rawBudgetObj = input.budget && typeof input.budget === 'object'
    ? (input.budget.allocatedCredits ?? input.budget.allocatedBudget ?? input.budget.allocated_budget)
    : undefined;
  const rawPolicyAlloc = input.policy?.allocatedBudget;
  const rawPolicyCap = (typeof input.policy?.creditCap === 'number' && input.policy.creditCap > 0)
    ? input.policy.creditCap
    : undefined;

  let rawExplicit;
  let source;
  if (rawTop !== undefined && rawTop !== null) {
    rawExplicit = rawTop;
    source = 'explicit_allocated_budget';
  } else if (rawBudgetObj !== undefined && rawBudgetObj !== null) {
    rawExplicit = rawBudgetObj;
    source = 'explicit_budget_object';
  } else if (rawPolicyAlloc !== undefined && rawPolicyAlloc !== null) {
    rawExplicit = rawPolicyAlloc;
    source = 'explicit_policy_budget';
  } else if (rawPolicyCap !== undefined) {
    rawExplicit = rawPolicyCap;
    source = 'explicit_policy_creditCap';
  }

  if (rawExplicit !== undefined) {
    const n = Number(rawExplicit);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new FlowError(
        'INVALID_POLICY',
        `[INVALID_POLICY] Story allocatedBudget must be a non-negative integer, got: ${rawExplicit}`,
        { allocatedBudget: rawExplicit }
      );
    }
    return {
      allocatedCredits: n,
      allocationSource: source,
    };
  }

  if (fallbackConfig && Number.isInteger(fallbackConfig.allocatedCredits) && fallbackConfig.allocationSource && fallbackConfig.allocationSource !== 'default_50') {
    return {
      allocatedCredits: fallbackConfig.allocatedCredits,
      allocationSource: fallbackConfig.allocationSource,
    };
  }

  return {
    allocatedCredits: DEFAULT_STORY_BUDGET_CREDITS,
    allocationSource: 'default_50',
  };
}

/**
 * Evaluate full story budget status, credit calculation, and user prompt guidance.
 */
export function evaluateStoryBudget(story = {}, { spentCredits = 0, plannedSpendCredits = 0 } = {}) {
  const shots = Array.isArray(story.shots) ? story.shots : [];
  const perShotEstimate = shots.map((s) => estimateShotCredits(s, story.brief));
  const estimatedRequiredCredits = perShotEstimate.reduce((sum, item) => sum + item.estimatedCredits, 0);

  const config = story.budgetConfig || resolveAllocatedBudgetConfig(story);
  const allocatedCredits = Number.isInteger(config.allocatedCredits)
    ? config.allocatedCredits
    : DEFAULT_STORY_BUDGET_CREDITS;
  const allocationSource = config.allocationSource || 'default_50';

  const safeSpent = Number.isFinite(Number(spentCredits)) && Number(spentCredits) >= 0 ? Number(spentCredits) : 0;
  const safePlanned = Number.isFinite(Number(plannedSpendCredits)) && Number(plannedSpendCredits) >= 0 ? Number(plannedSpendCredits) : 0;

  const shortfallCredits = Math.max(0, estimatedRequiredCredits - allocatedCredits);
  const exceedsAllocatedBudget = estimatedRequiredCredits > allocatedCredits;
  const exceedsDefault50 = estimatedRequiredCredits > DEFAULT_STORY_BUDGET_CREDITS;
  const remainingAllocatedCredits = Math.max(0, allocatedCredits - safeSpent);
  const wouldExceedRemainingOnSpend = (safeSpent + safePlanned) > allocatedCredits;
  const canSpendVideoCredits = !exceedsAllocatedBudget && !wouldExceedRemainingOnSpend;
  const requiresBudgetApproval = exceedsAllocatedBudget;

  let question;
  if (exceedsAllocatedBudget) {
    question = `Estimated video generation cost for this story is ${estimatedRequiredCredits} credits across ${shots.length} shot(s), which exceeds the ${allocationSource === 'default_50' ? 'default ' : ''}allocated budget of ${allocatedCredits} credits by ${shortfallCredits} credits. Please ask the user for the total allocated budget for this story before spending a single video credit, and set allocatedBudget (e.g. ${estimatedRequiredCredits}) via flow_script_update.`;
  } else if (allocationSource === 'default_50') {
    question = `Default story budget allocated: ${DEFAULT_STORY_BUDGET_CREDITS} credits (calculated video requirement: ${estimatedRequiredCredits} credits across ${shots.length} shot(s); image & character generation are free at 0 credits). Confirm or update the total allocated budget with allocatedBudget if you want a custom cap.`;
  } else {
    question = `Story budget allocated: ${allocatedCredits} credits (calculated video requirement: ${estimatedRequiredCredits} credits across ${shots.length} shot(s); image & character generation are free at 0 credits).`;
  }

  return {
    allocatedCredits,
    defaultAllocatedCredits: DEFAULT_STORY_BUDGET_CREDITS,
    allocationSource,
    estimatedRequiredCredits,
    shortfallCredits,
    exceedsAllocatedBudget,
    exceedsDefault50,
    requiresBudgetApproval,
    spentCredits: safeSpent,
    remainingAllocatedCredits,
    plannedSpendCredits: safePlanned,
    wouldExceedRemainingOnSpend,
    canSpendVideoCredits,
    imageAndCharacterCredits: 0,
    freeToolsNote: 'Image generation and character creation are free (0 credits) and are never blocked for credit reasons.',
    question,
    perShotEstimate,
  };
}

/**
 * Enforce story budget BEFORE spending a single video credit.
 * Refuses if estimated story requirements exceed allocatedBudget or if
 * cumulative spent + planned spend exceeds allocatedBudget.
 */
export function assertStoryVideoSpendAllowed(story, { spentCredits = 0, plannedSpendCredits = 0 } = {}) {
  const budget = evaluateStoryBudget(story, { spentCredits, plannedSpendCredits });
  const title = story?.brief?.title || story?.storyId || story?.scriptId || 'story';
  const id = story?.storyId || story?.scriptId || 'unknown';

  if (budget.exceedsAllocatedBudget) {
    throw new FlowError(
      ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
      `Story '${title}' (${id}) requires an estimated ${budget.estimatedRequiredCredits} video credits, which exceeds the ${budget.allocationSource === 'default_50' ? 'default ' : ''}allocated budget of ${budget.allocatedCredits} credits (shortfall: ${budget.shortfallCredits} credits). No Generate click made and 0 credits spent. Ask the user for their total allocated budget and pass allocatedBudget via flow_script_update (patch: { allocatedBudget: ${budget.estimatedRequiredCredits} }) before spending a single credit.`,
      { needsBudgetApproval: true, storyId: id, ...budget }
    );
  }

  if (budget.wouldExceedRemainingOnSpend) {
    throw new FlowError(
      ErrorCodes.MANUAL_VERIFICATION_REQUIRED,
      `Story '${title}' (${id}) allocated budget of ${budget.allocatedCredits} credits exceeded: ${budget.spentCredits} reserved + ${budget.plannedSpendCredits} quoted. No Generate click made. Increase allocatedBudget via flow_script_update to continue.`,
      { needsBudgetApproval: true, storyId: id, ...budget }
    );
  }

  return budget;
}
