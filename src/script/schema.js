import { FlowError } from '../utils/errors.js';
import { canonicalStringify } from '../domain/contracts.js';
import { buildStoryDag } from './dag.js';

export const SAFE_STORY_ID_RE = Object.freeze(/^[a-zA-Z0-9_-]{1,64}$/);
export const VALID_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4']);
export const VALID_PRIVACY_MODES = Object.freeze(['private', 'internal', 'public']);
export const VALID_REFERENCE_RIGHTS = Object.freeze(['owned', 'licensed', 'synthetic', 'fair_use']);
export const VALID_REVIEW_AUTHORITIES = Object.freeze(['client_human', 'director', 'automated_advisory']);
export const VALID_DEPENDENCY_TYPES = Object.freeze(['reference', 'continuity', 'panel', 'take', 'handoff']);

function gcdBigInt(a, b) {
  let x = typeof a === 'bigint' ? (a < 0n ? -a : a) : BigInt(Math.abs(Number(a)));
  let y = typeof b === 'bigint' ? (b < 0n ? -b : b) : BigInt(Math.abs(Number(b)));
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1n;
}

function reduceRationalBigInt(numBig, denBig) {
  if (typeof numBig !== 'bigint' || typeof denBig !== 'bigint' || denBig === 0n) {
    throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Invalid rational number: ${String(numBig)}/${String(denBig)}`, { num: String(numBig), den: String(denBig) });
  }
  const sign = (numBig < 0n) !== (denBig < 0n) ? -1 : 1;
  const absNum = numBig < 0n ? -numBig : numBig;
  const absDen = denBig < 0n ? -denBig : denBig;
  const g = gcdBigInt(absNum, absDen);
  const rNumBig = absNum / g;
  const rDenBig = absDen / g;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (rNumBig > maxSafe || rDenBig > maxSafe) {
    throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Reduced rational exceeds safe integer boundary: ${rNumBig.toString()}/${rDenBig.toString()}`, { num: rNumBig.toString(), den: rDenBig.toString() });
  }
  const rNum = Number(rNumBig) * sign;
  const rDen = Number(rDenBig);
  if (!Number.isSafeInteger(rNum) || !Number.isSafeInteger(rDen)) {
    throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Reduced rational is not a safe integer: ${rNum}/${rDen}`, { num: rNum, den: rDen });
  }
  return { num: rNum, den: rDen };
}

/**
 * Reduces a rational fraction using exact BigInt arithmetic, returning
 * plain Number properties { num, den } for safe canonical JSON serialization.
 */
export function reduceRational(num, den) {
  // Accept safe-integer Numbers (legacy) or BigInts (exact products).
  let numBig = null;
  let denBig = null;
  if (typeof num === 'bigint' && typeof den === 'bigint') {
    numBig = num;
    denBig = den;
  } else {
    if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
      throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Invalid rational number: ${num}/${den}`, { num, den });
    }
    numBig = BigInt(num);
    denBig = BigInt(den);
  }
  return reduceRationalBigInt(numBig, denBig);
}

/**
 * Parses and validates rational FPS:
 * - Integer 24 -> { num: 24, den: 1 }
 * - Float 23.976 -> { num: 24000, den: 1001 }
 * - Object { num: 24, den: 1 } -> validated & reduced
 */
export function parseRationalFps(input = 24) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] FPS must be positive: ${input}`, { fps: input });
    }
    if (Number.isInteger(input)) {
      return { num: input, den: 1 };
    }
    // Handle standard NTSC frame rates (23.976, 29.97, 59.94)
    if (Math.abs(input - 23.976) < 0.001) return { num: 24000, den: 1001 };
    if (Math.abs(input - 29.97) < 0.001) return { num: 30000, den: 1001 };
    if (Math.abs(input - 59.94) < 0.001) return { num: 60000, den: 1001 };
    // General float: clamp to reasonable denominator
    return reduceRational(Math.round(input * 1000), 1000);
  }

  if (input && typeof input === 'object') {
    const { num, den } = input;
    if (!Number.isSafeInteger(num) || num <= 0 || !Number.isSafeInteger(den) || den <= 0) {
      throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Rational FPS must have positive safe-integer num/den`, { input });
    }
    return reduceRational(num, den);
  }

  throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Invalid FPS specification: ${JSON.stringify(input)}`, { input });
}

/**
 * Calculates frames from seconds and rational FPS.
 */
export function framesForDuration(durationSec, fpsInput = 24) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0) {
    throw new FlowError('IMPOSSIBLE_TIMING', '[IMPOSSIBLE_TIMING] Duration must be a positive finite number', { durationSec });
  }
  const fps = parseRationalFps(fpsInput);
  return Math.round((durationSec * fps.num) / fps.den);
}

/**
 * Calculates timeline duration from standardized shots.
 */
export function calculateTimelineDuration(shots = [], fpsInput = 24) {
  if (!Array.isArray(shots)) {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Shots must be an array', { shots });
  }
  const fps = parseRationalFps(fpsInput);
  let totalUsableFramesBig = 0n;

  for (const shot of shots) {
    const usableFrames = shot.usableFrames;
    if (!Number.isSafeInteger(usableFrames) || usableFrames <= 0) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Invalid shot usable frames: ${usableFrames}`, {
        shotId: shot.id,
        usableFrames,
      });
    }
    totalUsableFramesBig += BigInt(usableFrames);
  }

  if (totalUsableFramesBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FlowError(
      'IMPOSSIBLE_TIMING',
      `[IMPOSSIBLE_TIMING] Aggregate total usable frames (${totalUsableFramesBig.toString()}) exceeds safe integer limit (${Number.MAX_SAFE_INTEGER})`,
      { totalUsableFrames: totalUsableFramesBig.toString() }
    );
  }

  const totalUsableFrames = Number(totalUsableFramesBig);
  // Exact rational product via BigInt: totalFrames * fps.den / fps.num.
  // Number multiplication would round for large safe-integer components
  // (e.g. 3 frames at 24/MAX_SAFE_INTEGER). Reduce in BigInt, then check the
  // JSON-safe boundary inside reduceRationalBigInt path.
  const durationRational = reduceRational(totalUsableFramesBig * BigInt(fps.den), BigInt(fps.num));
  const totalDurationSec = Math.round((totalUsableFrames * fps.den / fps.num) * 1000) / 1000;

  return {
    totalUsableFrames,
    durationRational,
    totalDurationSec,
    shotCount: shots.length,
    fps,
  };
}

/**
 * Validates a client-authored structured story specification:
 * - Brief parameters (aspect ratio, rational fps, target duration)
 * - Explicit bindings (accountKey, projectId) with rejection of conflicts
 * - Bounded generation policies (candidateLimit, timeBudgetSec, creditCap)
 * - Governance fields (privacyMode, referenceRights, reviewAuthority)
 * - Bible entities (characters, locations, props) with unique semantic IDs
 * - Shot cards with trim ranges, transition handles, and expected continuity states
 * - Feasibility math: usableFrames + handles <= plannedSourceFrames
 */
export function validateStoryInput({
  storyId = null,
  brief,
  binding = {},
  policy = {},
  governance = {},
  bible,
  scenes = [],
  shots = [],
  accountKey = null,
  projectId = null,
} = {}) {
  // Validate storyId if passed
  if (storyId !== null && storyId !== undefined) {
    if (typeof storyId !== 'string' || !storyId.trim() || !SAFE_STORY_ID_RE.test(storyId.trim())) {
      throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] Story ID must be an alphanumeric identifier: ${storyId}`, { storyId });
    }
  }

  // 1. Explicit Account & Project Bindings
  const resolvedAccountKey = binding.accountKey ?? accountKey;
  const resolvedProjectId = binding.projectId ?? projectId;

  if (typeof resolvedAccountKey !== 'string' || !resolvedAccountKey.trim()) {
    throw new FlowError('BINDING_REQUIRED', '[BINDING_REQUIRED] Story requires an explicit non-empty accountKey', { accountKey: resolvedAccountKey });
  }
  if (typeof resolvedProjectId !== 'string' || !resolvedProjectId.trim()) {
    throw new FlowError('BINDING_REQUIRED', '[BINDING_REQUIRED] Story requires an explicit non-empty projectId', { projectId: resolvedProjectId });
  }

  // Reject conflicting bindings if both binding object and top-level were provided
  if (binding.accountKey && accountKey && binding.accountKey !== accountKey) {
    throw new FlowError('BINDING_CONFLICT', `[BINDING_CONFLICT] Conflicting accountKey: binding=${binding.accountKey} vs top-level=${accountKey}`, { binding, accountKey });
  }
  if (binding.projectId && projectId && binding.projectId !== projectId) {
    throw new FlowError('BINDING_CONFLICT', `[BINDING_CONFLICT] Conflicting projectId: binding=${binding.projectId} vs top-level=${projectId}`, { binding, projectId });
  }

  // 2. Bounded Policy & Invariant Limits
  const resolvedPolicy = {
    candidateLimit: policy.candidateLimit ?? 4,
    timeBudgetSec: policy.timeBudgetSec ?? 3600,
    creditCap: policy.creditCap ?? 0,
    policyRevision: policy.policyRevision ?? 1,
  };

  if (!Number.isInteger(resolvedPolicy.candidateLimit) || resolvedPolicy.candidateLimit <= 0 || resolvedPolicy.candidateLimit > 20) {
    throw new FlowError('INVALID_POLICY', `[INVALID_POLICY] Candidate limit must be an integer between 1 and 20: ${resolvedPolicy.candidateLimit}`, { policy: resolvedPolicy });
  }
  if (typeof resolvedPolicy.timeBudgetSec !== 'number' || !Number.isFinite(resolvedPolicy.timeBudgetSec) || resolvedPolicy.timeBudgetSec <= 0) {
    throw new FlowError('INVALID_POLICY', `[INVALID_POLICY] Time budget must be a positive number: ${resolvedPolicy.timeBudgetSec}`, { policy: resolvedPolicy });
  }
  if (!Number.isInteger(resolvedPolicy.creditCap) || resolvedPolicy.creditCap < 0) {
    throw new FlowError('INVALID_POLICY', `[INVALID_POLICY] Credit cap must be a non-negative integer: ${resolvedPolicy.creditCap}`, { policy: resolvedPolicy });
  }
  if (!Number.isInteger(resolvedPolicy.policyRevision) || resolvedPolicy.policyRevision <= 0) {
    throw new FlowError('INVALID_POLICY', `[INVALID_POLICY] Policy revision must be a positive integer: ${resolvedPolicy.policyRevision}`, { policy: resolvedPolicy });
  }

  // 3. Governance
  const resolvedGovernance = {
    privacyMode: governance.privacyMode ?? 'private',
    referenceRights: governance.referenceRights ?? 'synthetic',
    reviewAuthority: governance.reviewAuthority ?? 'client_human',
  };

  if (!VALID_PRIVACY_MODES.includes(resolvedGovernance.privacyMode)) {
    throw new FlowError('INVALID_GOVERNANCE', `[INVALID_GOVERNANCE] Invalid privacyMode: ${resolvedGovernance.privacyMode}`, { governance: resolvedGovernance });
  }
  if (!VALID_REFERENCE_RIGHTS.includes(resolvedGovernance.referenceRights)) {
    throw new FlowError('INVALID_GOVERNANCE', `[INVALID_GOVERNANCE] Invalid referenceRights: ${resolvedGovernance.referenceRights}`, { governance: resolvedGovernance });
  }
  if (!VALID_REVIEW_AUTHORITIES.includes(resolvedGovernance.reviewAuthority)) {
    throw new FlowError('INVALID_GOVERNANCE', `[INVALID_GOVERNANCE] Invalid reviewAuthority: ${resolvedGovernance.reviewAuthority}`, { governance: resolvedGovernance });
  }

  // 4. Brief Validation
  if (!brief || typeof brief !== 'object') {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Story brief is required', { brief });
  }
  if (typeof brief.title !== 'string' || !brief.title.trim()) {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Story title must be a non-empty string', { title: brief.title });
  }
  if (!VALID_ASPECT_RATIOS.includes(brief.aspectRatio)) {
    throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Invalid aspect ratio: ${brief.aspectRatio}. Must be one of: ${VALID_ASPECT_RATIOS.join(', ')}`, { aspectRatio: brief.aspectRatio });
  }
  const fps = parseRationalFps(brief.fps ?? 24);
  if (typeof brief.targetDurationSec !== 'number' || !Number.isFinite(brief.targetDurationSec) || brief.targetDurationSec <= 0) {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Brief targetDurationSec must be a positive number', { targetDurationSec: brief.targetDurationSec });
  }

  // 5. Bible Validation
  if (!bible || typeof bible !== 'object') {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Story bible is required', { bible });
  }
  const characters = Array.isArray(bible.characters) ? bible.characters : [];
  const locations = Array.isArray(bible.locations) ? bible.locations : [];
  const props = Array.isArray(bible.props) ? bible.props : [];

  const characterIds = new Set();
  const locationIds = new Set();
  const propIds = new Set();
  const allEntityIds = new Set();

  const registerEntity = (id, type) => {
    if (typeof id !== 'string' || !id.trim()) {
      throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Entity in ${type} must have a non-empty string ID`, { id, type });
    }
    if (allEntityIds.has(id)) {
      throw new FlowError('DUPLICATE_ENTITY_ID', `[DUPLICATE_ENTITY_ID] Duplicate entity ID across bible: ${id}`, { id, type });
    }
    allEntityIds.add(id);
  };

  for (const c of characters) {
    registerEntity(c.id, 'characters');
    characterIds.add(c.id);
  }
  for (const l of locations) {
    registerEntity(l.id, 'locations');
    locationIds.add(l.id);
  }
  for (const p of props) {
    registerEntity(p.id, 'props');
    propIds.add(p.id);
  }

  // 6. Scenes Validation
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] At least one scene is required', { scenes });
  }
  const sceneIds = new Set();
  for (const scene of scenes) {
    if (typeof scene.id !== 'string' || !scene.id.trim()) {
      throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Scene must have a non-empty ID', { scene });
    }
    if (sceneIds.has(scene.id)) {
      throw new FlowError('DUPLICATE_ENTITY_ID', `[DUPLICATE_ENTITY_ID] Duplicate scene ID: ${scene.id}`, { sceneId: scene.id });
    }
    sceneIds.add(scene.id);
    if (!locationIds.has(scene.locationId)) {
      throw new FlowError('DANGLING_ENTITY_REFERENCE', `[DANGLING_ENTITY_REFERENCE] Scene ${scene.id} references non-existent location ID: ${scene.locationId}`, { sceneId: scene.id, locationId: scene.locationId });
    }
  }

  // 7. Shots Validation
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] At least one shot is required', { shots });
  }
  const shotIds = new Set();
  const standardizedShots = [];

  for (const shot of shots) {
    if (!shot || typeof shot !== 'object') {
      throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Shot card must be an object', { shot });
    }
    if (typeof shot.id !== 'string' || !shot.id.trim()) {
      throw new FlowError('INVALID_STORY_SCHEMA', '[INVALID_STORY_SCHEMA] Shot must have a non-empty ID', { shot });
    }
    if (shotIds.has(shot.id)) {
      throw new FlowError('DUPLICATE_ENTITY_ID', `[DUPLICATE_ENTITY_ID] Duplicate shot ID: ${shot.id}`, { shotId: shot.id });
    }
    shotIds.add(shot.id);

    if (!sceneIds.has(shot.sceneId)) {
      throw new FlowError('DANGLING_ENTITY_REFERENCE', `[DANGLING_ENTITY_REFERENCE] Shot ${shot.id} references non-existent scene ID: ${shot.sceneId}`, { shotId: shot.id, sceneId: shot.sceneId });
    }

    // Time & Trim calculations
    // Support either plannedSourceFrames or legacy sourceDurationSec
    let plannedSourceFrames = shot.plannedSourceFrames;
    if (plannedSourceFrames === undefined && typeof shot.sourceDurationSec === 'number') {
      plannedSourceFrames = framesForDuration(shot.sourceDurationSec, fps);
    }
    if (!Number.isSafeInteger(plannedSourceFrames) || plannedSourceFrames <= 0) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Shot ${shot.id} plannedSourceFrames must be a safe positive integer: ${plannedSourceFrames}`, { shotId: shot.id, plannedSourceFrames });
    }

    let trim = shot.trim;
    if (!trim) {
      // Build trim from usableDurationSec or default to full planned source
      const usableSec = shot.usableDurationSec ?? shot.durationSec;
      const usableFrames = typeof usableSec === 'number' ? framesForDuration(usableSec, fps) : plannedSourceFrames;
      trim = { inFrame: 0, outFrame: usableFrames };
    }

    if (!Number.isSafeInteger(trim.inFrame) || trim.inFrame < 0) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Shot ${shot.id} trim.inFrame must be a safe integer >= 0`, { shotId: shot.id, trim });
    }
    if (!Number.isSafeInteger(trim.outFrame) || trim.outFrame <= trim.inFrame) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Shot ${shot.id} trim.outFrame must be greater than inFrame`, { shotId: shot.id, trim });
    }
    if (trim.outFrame > plannedSourceFrames) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Shot ${shot.id} trim.outFrame (${trim.outFrame}) exceeds planned source frames (${plannedSourceFrames})`, {
        shotId: shot.id,
        trim,
        plannedSourceFrames,
      });
    }

    const usableFrames = trim.outFrame - trim.inFrame;

    const handles = {
      headFrames: shot.transitionHandles?.headFrames ?? 0,
      tailFrames: shot.transitionHandles?.tailFrames ?? 0,
    };
    if (!Number.isSafeInteger(handles.headFrames) || handles.headFrames < 0 || !Number.isSafeInteger(handles.tailFrames) || handles.tailFrames < 0) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Transition handles must be non-negative safe integers`, { shotId: shot.id, handles });
    }

    if (trim.inFrame - handles.headFrames < 0 || trim.outFrame + handles.tailFrames > plannedSourceFrames) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Shot ${shot.id} transition handles extend beyond source boundaries: head=${handles.headFrames} (in=${trim.inFrame}), tail=${handles.tailFrames} (out=${trim.outFrame}, source=${plannedSourceFrames})`, {
        shotId: shot.id,
        plannedSourceFrames,
        trim,
        handles,
      });
    }

    const totalRequiredFrames = usableFrames + handles.headFrames + handles.tailFrames;
    if (totalRequiredFrames > plannedSourceFrames) {
      throw new FlowError('IMPOSSIBLE_TIMING', `[IMPOSSIBLE_TIMING] Shot ${shot.id} usable frames (${usableFrames}) + handles (${handles.headFrames}+${handles.tailFrames}) exceeds planned source frames (${plannedSourceFrames})`, {
        shotId: shot.id,
        plannedSourceFrames,
        usableFrames,
        handles,
      });
    }

    // Entity reference checks
    const shotChars = shot.entities?.characters || [];
    for (const cid of shotChars) {
      if (!characterIds.has(cid)) {
        throw new FlowError('DANGLING_ENTITY_REFERENCE', `[DANGLING_ENTITY_REFERENCE] Shot ${shot.id} references unknown character: ${cid}`, { shotId: shot.id, characterId: cid });
      }
    }
    const shotProps = shot.entities?.props || [];
    for (const pid of shotProps) {
      if (!propIds.has(pid)) {
        throw new FlowError('DANGLING_ENTITY_REFERENCE', `[DANGLING_ENTITY_REFERENCE] Shot ${shot.id} references unknown prop: ${pid}`, { shotId: shot.id, propId: pid });
      }
    }

    // Continuity state validation: expected_state_before and expected_state_after
    const stateBefore = shot.expected_state_before ?? shot.expectedStateBefore ?? null;
    const stateAfter = shot.expected_state_after ?? shot.expectedStateAfter ?? null;

    for (const stateObj of [stateBefore, stateAfter]) {
      if (stateObj?.props) {
        for (const [pid, pstate] of Object.entries(stateObj.props)) {
          if (!propIds.has(pid)) {
            throw new FlowError('DANGLING_ENTITY_REFERENCE', `[DANGLING_ENTITY_REFERENCE] State references unknown prop: ${pid}`, { shotId: shot.id, propId: pid });
          }
          if (pstate) {
            const holderVal = pstate.holder;
            if (holderVal !== null && holderVal !== undefined) {
              if (Array.isArray(holderVal)) {
                if (holderVal.length > 1) {
                  throw new FlowError('STATE_CONFLICT', `[STATE_CONFLICT] Prop ${pid} has multiple conflicting simultaneous holders: ${holderVal.join(', ')}`, { shotId: shot.id, propId: pid, holders: holderVal });
                }
                for (const h of holderVal) {
                  if (typeof h !== 'string' || !h.trim()) {
                    throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Prop '${pid}' holder must be a string character ID, got ${typeof h}: ${h}`, { shotId: shot.id, propId: pid, holder: h });
                  }
                  if (!characterIds.has(h.trim())) {
                    throw new FlowError('UNDECLARED_HOLDER', `[UNDECLARED_HOLDER] Prop '${pid}' holder '${h}' is not declared in story characters bible`, { shotId: shot.id, propId: pid, holder: h });
                  }
                }
              } else if (typeof holderVal === 'string') {
                if (!holderVal.trim() || !characterIds.has(holderVal.trim())) {
                  throw new FlowError('UNDECLARED_HOLDER', `[UNDECLARED_HOLDER] Prop '${pid}' holder '${holderVal}' is not declared in story characters bible`, { shotId: shot.id, propId: pid, holder: holderVal });
                }
              } else {
                throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Prop '${pid}' holder must be a string character ID or null, got ${typeof holderVal}: ${holderVal}`, { shotId: shot.id, propId: pid, holder: holderVal });
              }
            }
          }
        }
      }
      if (stateObj?.characters) {
        for (const cid of Object.keys(stateObj.characters)) {
          if (!characterIds.has(cid)) {
            throw new FlowError('DANGLING_ENTITY_REFERENCE', `[DANGLING_ENTITY_REFERENCE] State references unknown character: ${cid}`, { shotId: shot.id, characterId: cid });
          }
        }
      }
    }

    // Explicit dependency parsing: reference, continuity, panel, take, handoff
    const rawDeps = shot.dependencies || [];
    if (!Array.isArray(rawDeps)) {
      throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Shot ${shot.id} dependencies must be an array`, { shotId: shot.id, dependencies: rawDeps });
    }
    const normalizedDeps = [];
    for (const dep of rawDeps) {
      if (typeof dep === 'string') {
        if (!dep.trim()) {
          throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Dependency target must be non-empty`, { shotId: shot.id, dep });
        }
        normalizedDeps.push({ type: 'continuity', target: dep.trim() });
      } else if (dep && typeof dep === 'object' && !Array.isArray(dep)) {
        if (!dep.type || !VALID_DEPENDENCY_TYPES.includes(dep.type)) {
          throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Invalid dependency type: ${dep?.type}`, { shotId: shot.id, dep });
        }
        if (typeof dep.target !== 'string' || !dep.target.trim()) {
          throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Dependency target must be non-empty string`, { shotId: shot.id, dep });
        }
        normalizedDeps.push({ type: dep.type, target: dep.target.trim() });
      } else {
        throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Invalid dependency in shot ${shot.id}: expected string or object, got ${dep === null ? 'null' : typeof dep}`, { shotId: shot.id, dep });
      }
    }

    standardizedShots.push({
      ...shot,
      plannedSourceFrames,
      trim,
      transitionHandles: handles,
      usableFrames,
      usableDurationSec: Math.round((usableFrames * fps.den / fps.num) * 1000) / 1000,
      sourceDurationSec: Math.round((plannedSourceFrames * fps.den / fps.num) * 1000) / 1000,
      expected_state_before: stateBefore,
      expected_state_after: stateAfter,
      dependencies: normalizedDeps,
    });
  }

  // Validate real graph structure first: build DAG and run topological sort cycle validation
  buildStoryDag({
    bible: {
      characters,
      locations,
      props,
    },
    scenes,
    shots: standardizedShots,
  });

  // Predecessor/successor continuity state validation across declared continuity dependencies
  const shotMap = new Map(standardizedShots.map((s) => [s.id, s]));
  for (const shot of standardizedShots) {
    for (const dep of shot.dependencies || []) {
      if (dep.type === 'continuity' || dep.type === 'handoff') {
        const predId = dep.target.replace(/^shot:/, '');
        const predShot = shotMap.get(predId);
        if (predShot) {
          // Verify prop states between predecessor's expected_state_after and successor's expected_state_before
          const predProps = predShot.expected_state_after?.props;
          const succProps = shot.expected_state_before?.props;
          if (predProps && succProps) {
            for (const [pid, bState] of Object.entries(succProps)) {
              const aState = predProps[pid];
              if (aState && bState) {
                if (aState.holder !== undefined && bState.holder !== undefined && aState.holder !== bState.holder) {
                  throw new FlowError(
                    'CONTINUITY_BREAK',
                    `[CONTINUITY_BREAK] Conflicting prop holder for '${pid}' between predecessor shot '${predShot.id}' (after: ${aState.holder}) and successor shot '${shot.id}' (before: ${bState.holder})`,
                    { predecessor: predShot.id, successor: shot.id, propId: pid, predecessorState: aState, successorState: bState }
                  );
                }
                if (aState.state !== undefined && bState.state !== undefined && aState.state !== bState.state) {
                  throw new FlowError(
                    'CONTINUITY_BREAK',
                    `[CONTINUITY_BREAK] Conflicting prop state for '${pid}' between predecessor shot '${predShot.id}' (after: ${aState.state}) and successor shot '${shot.id}' (before: ${bState.state})`,
                    { predecessor: predShot.id, successor: shot.id, propId: pid, predecessorState: aState, successorState: bState }
                  );
                }
              }
            }
          }

          // Verify character states
          const predChars = predShot.expected_state_after?.characters;
          const succChars = shot.expected_state_before?.characters;
          if (predChars && succChars) {
            for (const [cid, bChar] of Object.entries(succChars)) {
              const aChar = predChars[cid];
              if (aChar && bChar) {
                for (const [k, v] of Object.entries(bChar)) {
                  if (aChar[k] !== undefined && canonicalStringify(aChar[k]) !== canonicalStringify(v)) {
                    throw new FlowError(
                      'CONTINUITY_BREAK',
                      `[CONTINUITY_BREAK] Conflicting character state for '${cid}.${k}' between predecessor shot '${predShot.id}' and successor shot '${shot.id}'`,
                      { predecessor: predShot.id, successor: shot.id, characterId: cid, field: k }
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Calculate timeline
  const timeline = calculateTimelineDuration(standardizedShots, fps);

  return {
    binding: {
      accountKey: resolvedAccountKey,
      projectId: resolvedProjectId,
    },
    policy: resolvedPolicy,
    governance: resolvedGovernance,
    brief: {
      ...brief,
      fps,
    },
    bible: {
      characters,
      locations,
      props,
    },
    scenes,
    shots: standardizedShots,
    timeline,
    accountKey: resolvedAccountKey,
    projectId: resolvedProjectId,
  };
}
