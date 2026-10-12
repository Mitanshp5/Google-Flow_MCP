// W09 reference review — manual client scoring + immutable canonical selection.
// Scorer-free: no hosted scorer/LLM/vision. Creative judgment is client-only.
// Technical gates (decoded hash/path, bound references) are independently
// rechecked, never overridden by caller booleans.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { getRuntimeRoot, atomicWriteJson, readVersionedJson, acquireLock } from '../storage/runtime-store.js';
import { getStory, getScriptDir, getScriptLockFile, computeCanonicalDigest, assertDirContained, assertFileContained, SAFE_SCRIPT_ID_RE } from './store.js';
import { buildStoryDag } from './dag.js';
import { getCandidate } from './candidate-store.js';
import { probeImage } from '../media/candidate-images.js';
import { sha256Hex } from '../assets/catalog.js';

export const SCORE_VERSION = 1;
export const REFERENCE_VERSION = 1;
export const SCORE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REFERENCE_ID_RE = SCORE_ID_RE;
export const HASH_RE = /^[0-9a-f]{64}$/i;
export const REQUIRED_GATES = Object.freeze(['subject_count', 'identity', 'state_continuity', 'artifacts', 'framing', 'dimensions', 'operation_refs']);
export const RATING_CRITERIA = Object.freeze(['identity', 'environment', 'action', 'composition', 'technical']);

function assertScriptId(scriptId) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] Invalid script ID: ${scriptId}`, { scriptId });
  }
}

function scoresDir(scriptId, root) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'scores');
  assertDirContained(dir, root, scriptId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  assertDirContained(dir, root, scriptId);
  return dir;
}

function referencesDir(scriptId, root) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'references');
  assertDirContained(dir, root, scriptId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  assertDirContained(dir, root, scriptId);
  return dir;
}

function verifyChecksum(data, file) {
  const { digest, ...rest } = data;
  if (typeof digest !== 'string' || !digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Review record digest missing: ${file}`, { file });
  }
  const computed = computeCanonicalDigest(rest);
  if (computed !== digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Review record digest mismatch: ${file}`, { file });
  }
  return data;
}

function listScoreFiles(dir, root, scriptId) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(n)) {
        throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Unexpected file in scores directory: ${n}`, { file: n });
      }
      return true;
    })
    .map((n) => {
      const file = path.join(dir, n);
      assertFileContained(file, root, scriptId);
      return { file, id: n.slice(0, -5) };
    });
}

function listReferenceFiles(dir, root, scriptId) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(n)) {
        throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Unexpected file in references directory: ${n}`, { file: n });
      }
      return true;
    })
    .map((n) => {
      const file = path.join(dir, n);
      assertFileContained(file, root, scriptId);
      return { file, id: n.slice(0, -5) };
    });
}

export function listScores(scriptId, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'scores');
  if (!fs.existsSync(dir)) return [];
  assertDirContained(dir, root, scriptId);
  const out = listScoreFiles(dir, root, scriptId).map(({ file, id }) => {
    const data = readVersionedJson(file, { supported: [SCORE_VERSION] });
    verifyChecksum(data, file);
    if (data.id !== id || data.scoreId !== id) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Score id binding mismatch: ${file}`, { file });
    }
    if (data.scriptId !== scriptId) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Score script mismatch: ${file}`, { file });
    }
    // Malformed/future-version/containment propagate; shapes validated here.
    assertScoreShape(data, file);
    return data;
  });
  out.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  return out;
}

export function listReferences(scriptId, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'references');
  if (!fs.existsSync(dir)) return [];
  assertDirContained(dir, root, scriptId);
  const out = listReferenceFiles(dir, root, scriptId).map(({ file, id }) => {
    const data = readVersionedJson(file, { supported: [REFERENCE_VERSION] });
    verifyChecksum(data, file);
    if (data.id !== id || data.referenceId !== id) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Reference id binding mismatch: ${file}`, { file });
    }
    if (data.scriptId !== scriptId) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Reference script mismatch: ${file}`, { file });
    }
    assertReferenceShape(data, file);
    return data;
  });
  out.sort((a, b) => (a.selectionRevision ?? 0) - (b.selectionRevision ?? 0) || ((a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)));
  return out;
}

export function getCurrentReferences(scriptId, { root = getRuntimeRoot() } = {}) {
  const all = listReferences(scriptId, { root });
  const byNode = new Map();
  for (const r of all) {
    const cur = byNode.get(r.nodeId);
    if (!cur || r.selectionRevision > cur.selectionRevision) byNode.set(r.nodeId, r);
  }
  return [...byNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

// Shared semantic freshness: complete authored node digest excluding ONLY
// root-level display metadata (name/title/notes). All other fields
// (prompt/appearance/costume/identity/state/location/scene/shot context) are
// semantic. Display-only or unrelated revisions preserve compatible media.
export function findAuthoredNode(snapshot, nodeId) {
  const sep = nodeId.indexOf(':');
  if (sep < 0) return null;
  const prefix = nodeId.slice(0, sep);
  const id = nodeId.slice(sep + 1);
  if (prefix === 'char') return (snapshot.bible?.characters || []).find((c) => c.id === id) ?? null;
  if (prefix === 'loc') return (snapshot.bible?.locations || []).find((l) => l.id === id) ?? null;
  if (prefix === 'prop') return (snapshot.bible?.props || []).find((p) => p.id === id) ?? null;
  if (prefix === 'scene') return (snapshot.scenes || []).find((s) => s.id === id) ?? null;
  if (prefix === 'shot') return (snapshot.shots || []).find((s) => s.id === id) ?? null;
  return null;
}

export function computeSemanticNodeDigest(snapshot, nodeId) {
  const node = findAuthoredNode(snapshot, nodeId);
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const { name: _n, title: _t, notes: _no, ...semantic } = node;
  void _n; void _t; void _no;
  try {
    return computeCanonicalDigest(semantic);
  } catch {
    return null;
  }
}

// Shared reference freshness used by status AND pack creation (never separate
// prompt-only logic). Returns { current: boolean, reason: string }.
// Current DAG membership and current account/project/policy/governance are
// mandatory. Missing/tampered files are stale here (status) and must block in
// pack creation without deleting originals (caller maps stale->PACK_BLOCKED).
export function checkReferenceFreshness(ref, snapshot, dag, { root = getRuntimeRoot() } = {}) {
  if (!dag || !dag.nodes.has(ref.nodeId)) {
    return { current: false, reason: 'not-in-current-dag' };
  }
  let cand = null;
  try {
    cand = getCandidate(ref.scriptId, ref.candidateId, { root });
  } catch {
    return { current: false, reason: 'candidate-unreadable' };
  }
  // Binding: account/project/policy/governance are mandatory and current.
  if (cand.accountKey !== snapshot.binding?.accountKey || cand.projectId !== snapshot.binding?.projectId) {
    return { current: false, reason: 'binding-changed' };
  }
  if (cand.policyDigest !== policyDigestOf(snapshot)) {
    return { current: false, reason: 'policy-changed' };
  }
  if (cand.hash.toLowerCase() !== String(ref.candidateHash).toLowerCase()) {
    return { current: false, reason: 'candidate-hash-mismatch' };
  }
  // Controlled originals binding: every stored path is containment-checked
  // before stat/read; missing/tampered bytes are stale, never auto-healed.
  try {
    assertFileContained(cand.path, root, ref.scriptId);
  } catch {
    return { current: false, reason: 'path-not-contained' };
  }
  try {
    if (!fs.existsSync(cand.path)) return { current: false, reason: 'file-missing' };
    assertFileContained(cand.path, root, ref.scriptId);
    const bytes = fs.readFileSync(cand.path);
    if (sha256Hex(bytes).toLowerCase() !== cand.hash.toLowerCase()) return { current: false, reason: 'bytes-changed' };
  } catch {
    return { current: false, reason: 'file-unreadable' };
  }
  // Semantic digest: compare current semantic against historical semantic at
  // selection time (history preserved). Display-only (name/title/notes) or
  // unrelated-node revisions keep equal semantics -> preserve.
  let historical = null;
  try {
    if (ref.scriptRevisionId) historical = getStory(ref.scriptId, { revisionId: ref.scriptRevisionId, root });
  } catch {
    historical = null;
  }
  const currentSemantic = computeSemanticNodeDigest(snapshot, ref.nodeId);
  if (!currentSemantic) return { current: false, reason: 'current-node-missing' };
  if (historical) {
    const historicalSemantic = computeSemanticNodeDigest(historical, ref.nodeId);
    if (!historicalSemantic) return { current: false, reason: 'historical-node-missing' };
    if (historicalSemantic !== currentSemantic) return { current: false, reason: 'semantic-changed' };
    return { current: true, reason: 'semantic-preserved' };
  }
  // No historical snapshot available: fall back to exact digest equality only.
  if (snapshot.nodeStates?.[ref.nodeId]?.nodeDigest !== ref.nodeDigest) {
    return { current: false, reason: 'digest-changed-no-history' };
  }
  return { current: true, reason: 'digest-equal' };
}

function assertScoreShape(s, file) {
  const bad = (field, detail) => {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Score field invalid (${field}): ${file}`, { file, field, detail });
  };
  if (typeof s.scoreId !== 'string' || !SCORE_ID_RE.test(s.scoreId)) bad('scoreId', s.scoreId);
  if (typeof s.candidateId !== 'string' || !SCORE_ID_RE.test(s.candidateId)) bad('candidateId', s.candidateId);
  if (typeof s.candidateHash !== 'string' || !HASH_RE.test(s.candidateHash)) bad('candidateHash', s.candidateHash);
  if (typeof s.candidateDigest !== 'string' || !HASH_RE.test(s.candidateDigest)) bad('candidateDigest', s.candidateDigest);
  if (typeof s.nodeId !== 'string' || !/^(char|loc|prop|shot):[A-Za-z0-9_-]{1,64}$/.test(s.nodeId)) bad('nodeId', s.nodeId);
  if (typeof s.nodeDigest !== 'string' || !HASH_RE.test(s.nodeDigest)) bad('nodeDigest', s.nodeDigest);
  if (!Number.isInteger(s.scriptRevision) || s.scriptRevision < 1) bad('scriptRevision', s.scriptRevision);
  if (typeof s.scriptRevisionId !== 'string' || !s.scriptRevisionId) bad('scriptRevisionId', s.scriptRevisionId);
  if (typeof s.scriptDigest !== 'string' || !HASH_RE.test(s.scriptDigest)) bad('scriptDigest', s.scriptDigest);
  if (typeof s.reviewer !== 'string' || !s.reviewer.trim()) bad('reviewer', s.reviewer);
  if (typeof s.reason !== 'string' || !s.reason.trim()) bad('reason', s.reason);
  if (typeof s.rubricVersion !== 'string' || !s.rubricVersion.trim()) bad('rubricVersion', s.rubricVersion);
  if (typeof s.score !== 'number' || !Number.isFinite(s.score)) bad('score', s.score);
  if (typeof s.eligible !== 'boolean') bad('eligible', s.eligible);
  if (!['scored_eligible', 'needs_review'].includes(s.status)) bad('status', s.status);
  if ((s.eligible && s.status !== 'scored_eligible') || (!s.eligible && s.status !== 'needs_review')) bad('eligible/status', `${s.eligible}/${s.status}`);
  if (typeof s.weights !== 'object' || s.weights === null || Array.isArray(s.weights)) bad('weights', typeof s.weights);
  if (typeof s.ratings !== 'object' || s.ratings === null || Array.isArray(s.ratings)) bad('ratings', typeof s.ratings);
  if (typeof s.confidences !== 'object' || s.confidences === null || Array.isArray(s.confidences)) bad('confidences', typeof s.confidences);
  if (typeof s.gates !== 'object' || s.gates === null || Array.isArray(s.gates)) bad('gates', typeof s.gates);
  if (typeof s.applicableWeights !== 'object' || s.applicableWeights === null || Array.isArray(s.applicableWeights)) bad('applicableWeights', typeof s.applicableWeights);
  if (typeof s.createdAtMs !== 'number' || !Number.isFinite(s.createdAtMs)) bad('createdAtMs', s.createdAtMs);
  // Deep validation of stored gates/ratings via the same production validators
  // used at score time; stored corruption must fail closed as STORAGE_CORRUPT.
  try {
    validateGates(s.gates);
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Score gates invalid: ${file}`, { file, field: 'gates', detail: e.message });
  }
  try {
    validateRatingsEtc(s.ratings, s.confidences, s.rubricVersion, s.weights, s.gates);
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Score ratings invalid: ${file}`, { file, field: 'ratings', detail: e.message });
  }
  // Recompute eligibility/score/applicable weights coherently; any drift fails closed.
  let expectedEligible = true;
  for (const g of REQUIRED_GATES) {
    const r = s.gates[g]?.result;
    if (r === 'fail' || r === 'unknown') {
      expectedEligible = false;
      break;
    }
  }
  let expectedScore;
  let expectedApplicable;
  try {
    ({ score: expectedScore, applicableWeights: expectedApplicable } = computeScore(s.ratings, s.weights, s.gates));
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Score recompute failed: ${file}`, { file, field: 'score', detail: e.message });
  }
  if (s.eligible !== expectedEligible) bad('eligible', `${s.eligible} !== recomputed ${expectedEligible}`);
  if (typeof s.score !== 'number' || !Number.isFinite(s.score) || Math.abs(s.score - expectedScore) > 1e-9) bad('score', `${s.score} !== recomputed ${expectedScore}`);
  {
    const expKeys = Object.keys(expectedApplicable).sort();
    const gotKeys = Object.keys(s.applicableWeights).sort();
    if (JSON.stringify(expKeys) !== JSON.stringify(gotKeys)) bad('applicableWeights', `keys ${JSON.stringify(gotKeys)} !== recomputed ${JSON.stringify(expKeys)}`);
    for (const k of expKeys) {
      const ev = expectedApplicable[k];
      const gv = s.applicableWeights[k];
      if (typeof gv !== 'number' || !Number.isFinite(gv) || Math.abs(gv - ev) > 1e-9) bad('applicableWeights', `${k}: ${gv} !== recomputed ${ev}`);
    }
  }
  return s;
}

function assertReferenceShape(r, file) {
  const bad = (field, detail) => {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Reference field invalid (${field}): ${file}`, { file, field, detail });
  };
  if (typeof r.referenceId !== 'string' || !REFERENCE_ID_RE.test(r.referenceId)) bad('referenceId', r.referenceId);
  if (typeof r.nodeId !== 'string' || !/^(char|loc|prop):[A-Za-z0-9_-]{1,64}$/.test(r.nodeId)) bad('nodeId', r.nodeId);
  if (typeof r.nodeDigest !== 'string' || !HASH_RE.test(r.nodeDigest)) bad('nodeDigest', r.nodeDigest);
  if (typeof r.candidateId !== 'string' || !SCORE_ID_RE.test(r.candidateId)) bad('candidateId', r.candidateId);
  if (typeof r.candidateHash !== 'string' || !HASH_RE.test(r.candidateHash)) bad('candidateHash', r.candidateHash);
  if (typeof r.candidateDigest !== 'string' || !HASH_RE.test(r.candidateDigest)) bad('candidateDigest', r.candidateDigest);
  if (!Number.isInteger(r.scriptRevision) || r.scriptRevision < 1) bad('scriptRevision', r.scriptRevision);
  if (typeof r.scriptRevisionId !== 'string' || !r.scriptRevisionId) bad('scriptRevisionId', r.scriptRevisionId);
  if (typeof r.scriptDigest !== 'string' || !HASH_RE.test(r.scriptDigest)) bad('scriptDigest', r.scriptDigest);
  if (!Number.isInteger(r.selectionRevision) || r.selectionRevision < 1) bad('selectionRevision', r.selectionRevision);
  if (!Array.isArray(r.supersedes)) bad('supersedes', typeof r.supersedes);
  if (!Array.isArray(r.consideredCandidateIds) || r.consideredCandidateIds.length < 1 || r.consideredCandidateIds.length > 20) bad('consideredCandidateIds', r.consideredCandidateIds?.length);
  if (!r.consideredCandidateIds.includes(r.candidateId)) bad('consideredCandidateIds', 'must include selected candidate');
  if (typeof r.scoreId !== 'string' || !SCORE_ID_RE.test(r.scoreId)) bad('scoreId', r.scoreId);
  if (typeof r.reviewer !== 'string' || !r.reviewer.trim()) bad('reviewer', r.reviewer);
  if (typeof r.reason !== 'string' || !r.reason.trim()) bad('reason', r.reason);
  if (r.status !== 'current') bad('status', r.status);
  if (typeof r.createdAtMs !== 'number' || !Number.isFinite(r.createdAtMs)) bad('createdAtMs', r.createdAtMs);
  return r;
}

function assertPackShape(p, file) {
  const bad = (field, detail) => {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Pack field invalid (${field}): ${file}`, { file, field, detail });
  };
  if (typeof p.packId !== 'string' || !PACK_ID_RE.test(p.packId)) bad('packId', p.packId);
  if (typeof p.shotId !== 'string' || !/^shot:[A-Za-z0-9_-]{1,64}$/.test(p.shotId)) bad('shotId', p.shotId);
  if (typeof p.shotDigest !== 'string' || !HASH_RE.test(p.shotDigest)) bad('shotDigest', p.shotDigest);
  if (!Number.isInteger(p.scriptRevision) || p.scriptRevision < 1) bad('scriptRevision', p.scriptRevision);
  if (typeof p.scriptRevisionId !== 'string' || !p.scriptRevisionId) bad('scriptRevisionId', p.scriptRevisionId);
  if (typeof p.scriptDigest !== 'string' || !HASH_RE.test(p.scriptDigest)) bad('scriptDigest', p.scriptDigest);
  if (!Number.isInteger(p.packRevision) || p.packRevision < 1) bad('packRevision', p.packRevision);
  if (!Array.isArray(p.supersedes)) bad('supersedes', typeof p.supersedes);
  if (!Array.isArray(p.selections) || p.selections.length < 1) bad('selections', p.selections?.length);
  for (const sel of p.selections) {
    if (typeof sel.nodeId !== 'string' || !/^(char|loc|prop):[A-Za-z0-9_-]{1,64}$/.test(sel.nodeId)) bad('selections.nodeId', sel?.nodeId);
    if (typeof sel.referenceId !== 'string' || !REFERENCE_ID_RE.test(sel.referenceId)) bad('selections.referenceId', sel?.referenceId);
    if (typeof sel.candidateId !== 'string' || !SCORE_ID_RE.test(sel.candidateId)) bad('selections.candidateId', sel?.candidateId);
    if (typeof sel.hash !== 'string' || !HASH_RE.test(sel.hash)) bad('selections.hash', sel?.hash);
    if (!Number.isInteger(sel.selectionRevision) || sel.selectionRevision < 1) bad('selections.selectionRevision', sel?.selectionRevision);
    if (!['anchor', 'ingredient'].includes(sel.role)) bad('selections.role', sel?.role);
  }
  if (typeof p.reviewer !== 'string' || !p.reviewer.trim()) bad('reviewer', p.reviewer);
  if (typeof p.reason !== 'string' || !p.reason.trim()) bad('reason', p.reason);
  if (p.status !== 'current') bad('status', p.status);
  if (typeof p.createdAtMs !== 'number' || !Number.isFinite(p.createdAtMs)) bad('createdAtMs', p.createdAtMs);
  return p;
}

function validateGates(gates) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] gates must be an object with seven hard gates', { gates });
  }
  for (const g of REQUIRED_GATES) {
    const v = gates[g];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] gate ${g} must be an object with result`, { gate: g });
    }
    if (!['pass', 'na', 'fail', 'unknown'].includes(v.result)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] gate ${g} result must be pass/na/fail/unknown`, { gate: g, result: v.result });
    }
    if (v.result === 'na') {
      // Only identity NA is currently justified (hands-only/cutaway with
      // face not visible). Other NA must be rejected as invented.
      if (g !== 'identity') {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] gate ${g} NA is not justified; only identity NA is allowed with reason`, { gate: g });
      }
      if (typeof v.naReason !== 'string' || !v.naReason.trim() || v.naReason.length > 500) {
        throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] identity NA requires a non-empty naReason <= 500 chars', { gate: g });
      }
    }
    if (v.result === 'fail' || v.result === 'unknown') {
      // Fail/unknown requires a nonempty note recording why.
      if (typeof v.note !== 'string' || !v.note.trim()) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] gate ${g} ${v.result} requires a nonempty note`, { gate: g });
      }
    }
  }
  // No extra gates.
  for (const k of Object.keys(gates)) {
    if (!REQUIRED_GATES.includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown gate: ${k}`, { gate: k });
    }
  }
}

function validateRatingsEtc(ratings, confidences, rubricVersion, weights, gates) {
  if (typeof rubricVersion !== 'string' || !rubricVersion.trim() || rubricVersion.length > 100) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] rubricVersion must be a non-empty string <= 100', { rubricVersion });
  }
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] weights must be an object', { weights });
  }
  for (const c of RATING_CRITERIA) {
    const w = weights[c];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] weights.${c} must be finite 0..1`, { criterion: c });
    }
  }
  for (const k of Object.keys(weights)) {
    if (!RATING_CRITERIA.includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown weight criterion: ${k}`, { criterion: k });
    }
  }
  const sum = RATING_CRITERIA.reduce((s, c) => s + weights[c], 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] weights must sum to 1 (got ${sum})`, { sum });
  }
  // Applicable NA weights cannot sum to zero: with identity NA, the remaining
  // criteria must still carry positive weight (no invented scores, no empty basis).
  {
    const identityNa = gates?.identity?.result === 'na';
    const applicable = RATING_CRITERIA.filter((c) => !(c === 'identity' && identityNa));
    const applicableSum = applicable.reduce((s, c) => s + weights[c], 0);
    if (!(applicableSum > 0)) {
      throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] applicable weights must sum to a positive value (NA criterion carries no score basis)', { applicableSum });
    }
  }
  if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] ratings must be an object', { ratings });
  }
  if (!confidences || typeof confidences !== 'object' || Array.isArray(confidences)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] confidences must be an object', { confidences });
  }
  const identityNa = gates?.identity?.result === 'na';
  for (const c of RATING_CRITERIA) {
    const isNaCriterion = c === 'identity' && identityNa;
    const rv = ratings[c];
    const cv = confidences[c];
    if (isNaCriterion) {
      // NA: no invented scores. Ratings/confidences must be absent for NA.
      if (rv !== undefined) {
        throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] identity rating must be absent when identity gate is NA (no invented scores)', { criterion: c });
      }
      if (cv !== undefined) {
        throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] identity confidence must be absent when identity gate is NA', { criterion: c });
      }
      continue;
    }
    if (typeof rv !== 'number' || !Number.isFinite(rv) || rv < 0 || rv > 5) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] ratings.${c} must be finite 0..5 (no NaN/defaults)`, { criterion: c });
    }
    if (typeof cv !== 'number' || !Number.isFinite(cv) || cv < 0 || cv > 1) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] confidences.${c} must be finite 0..1`, { criterion: c });
    }
  }
  for (const k of Object.keys(ratings)) {
    if (!RATING_CRITERIA.includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown rating criterion: ${k}`, { criterion: k });
    }
  }
  for (const k of Object.keys(confidences)) {
    if (!RATING_CRITERIA.includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown confidence criterion: ${k}`, { criterion: k });
    }
  }
}

function computeScore(ratings, weights, gates) {
  const identityNa = gates?.identity?.result === 'na';
  const applicable = RATING_CRITERIA.filter((c) => !(c === 'identity' && identityNa));
  const wSum = applicable.reduce((s, c) => s + weights[c], 0);
  if (!(wSum > 0)) return { score: 0, applicableWeights: {} };
  let acc = 0;
  const applicableWeights = {};
  for (const c of applicable) {
    const nw = weights[c] / wSum;
    applicableWeights[c] = nw;
    acc += ratings[c] * nw;
  }
  return { score: Math.round(acc * 1000) / 1000, applicableWeights };
}

function policyDigestOf(snapshot) {
  return computeCanonicalDigest({ binding: snapshot.binding, policy: snapshot.policy, governance: snapshot.governance });
}

export async function scoreCandidate(input = {}, { root = getRuntimeRoot() } = {}) {
  const { scriptId, expectedRevision, nodeId, nodeDigest, reviewer, candidateId, candidateHash, gates, ratings, confidences, rubricVersion, weights, reason } = input;
  assertScriptId(scriptId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] expectedRevision must be a positive integer: ${expectedRevision}`, { expectedRevision });
  }
  if (typeof nodeId !== 'string' || !/^(char|loc|prop|shot):[A-Za-z0-9_-]{1,64}$/.test(nodeId)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] nodeId must match char:|loc:|prop:|shot: prefix: ${nodeId}`, { nodeId });
  }
  if (typeof nodeDigest !== 'string' || !HASH_RE.test(nodeDigest)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] nodeDigest must be a full hex digest', { nodeId });
  }
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reviewer must be a non-empty client identity <= 200', { reviewer });
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reason must be a non-empty client reason <= 2000', { reason });
  }
  if (typeof candidateId !== 'string' || !SCORE_ID_RE.test(candidateId)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateId must be a full UUID', { candidateId });
  }
  if (typeof candidateHash !== 'string' || !HASH_RE.test(candidateHash)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateHash must be a full hex digest', { candidateHash });
  }
  validateGates(gates);
  validateRatingsEtc(ratings, confidences, rubricVersion, weights, gates);

  const snapshot = getStory(scriptId, { root });
  if (snapshot.revision !== expectedRevision) {
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId, expectedRevision, actualRevision: snapshot.revision });
  }
  let dag;
  try {
    dag = buildStoryDag(snapshot);
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Script DAG unreadable: ${e.message}`, { scriptId });
  }
  if (!dag.nodes.has(nodeId)) {
    throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Node '${nodeId}' is not part of the active DAG`, { nodeId });
  }
  const curDigest = snapshot.nodeStates?.[nodeId]?.nodeDigest;
  if (!curDigest || curDigest !== nodeDigest) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Stale nodeDigest for ${nodeId}`, { nodeId });
  }
  const cand = getCandidate(scriptId, candidateId, { root });
  if (cand.nodeId !== nodeId) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Candidate ${candidateId} belongs to ${cand.nodeId}, not ${nodeId}`, { candidateId, nodeId });
  }
  if (cand.hash.toLowerCase() !== candidateHash.toLowerCase()) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', '[REVIEW_DIGEST_MISMATCH] candidateHash does not match stored candidate', { candidateId });
  }
  if (cand.nodeDigest !== nodeDigest) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', '[REVIEW_DIGEST_MISMATCH] Candidate nodeDigest stale vs current node', { candidateId, nodeId });
  }
  // Independently recheck technical gates: decoded file + bound refs.
  // Every stored c.path access is containment-checked before stat/read/probe.
  assertFileContained(cand.path, root, scriptId);
  if (!fs.existsSync(cand.path)) {
    throw new FlowError('MEDIA_NOT_FOUND', `[MEDIA_NOT_FOUND] Candidate file missing: ${candidateId}`, { candidateId });
  }
  assertFileContained(cand.path, root, scriptId);
  const bytes = fs.readFileSync(cand.path);
  if (sha256Hex(bytes).toLowerCase() !== cand.hash.toLowerCase()) {
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed: ${candidateId}`, { candidateId });
  }
  assertFileContained(cand.path, root, scriptId);
  const probe = await probeImage(cand.path, { timeoutMs: 15000 });
  if (probe.hash.toLowerCase() !== cand.hash.toLowerCase()) {
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate decode hash mismatch: ${candidateId}`, { candidateId });
  }
  // Final physical hash recheck before publish (mutation between decode and use).
  assertFileContained(cand.path, root, scriptId);
  const finalBytes = fs.readFileSync(cand.path);
  if (sha256Hex(finalBytes).toLowerCase() !== cand.hash.toLowerCase()) {
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed before score publish: ${candidateId}`, { candidateId });
  }
  // operation_refs gate: candidate's policy/binding must still match current.
  if (policyDigestOf(snapshot) !== cand.policyDigest) {
    throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Candidate policy/binding stale; re-review refused', { candidateId });
  }

  // Eligibility: all gates pass or justified NA. Unknown/fail => needs-review.
  let eligible = true;
  for (const g of REQUIRED_GATES) {
    const r = gates[g].result;
    if (r === 'fail' || r === 'unknown') {
      eligible = false;
      break;
    }
  }
  const { score, applicableWeights } = computeScore(ratings, weights, gates);

  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const fresh = getStory(scriptId, { root });
    if (fresh.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch on score publish: expected ${expectedRevision}, current is ${fresh.revision}`, { scriptId });
    }
    const cur2 = fresh.nodeStates?.[nodeId]?.nodeDigest;
    if (!cur2 || cur2 !== nodeDigest) {
      throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Stale nodeDigest on publish for ${nodeId}`, { nodeId });
    }
    const scoreId = crypto.randomUUID();
    const nowMs = Date.now();
    const record = {
      v: SCORE_VERSION,
      id: scoreId,
      scoreId,
      scriptId,
      candidateId,
      candidateHash: cand.hash,
      candidateDigest: cand.digest,
      nodeId,
      nodeDigest,
      scriptRevision: fresh.revision,
      scriptRevisionId: fresh.revisionId,
      scriptDigest: fresh.digest,
      reviewer: reviewer.trim(),
      reason: reason.trim(),
      gates: JSON.parse(JSON.stringify(gates)),
      ratings: JSON.parse(JSON.stringify(ratings)),
      confidences: JSON.parse(JSON.stringify(confidences)),
      rubricVersion,
      weights: JSON.parse(JSON.stringify(weights)),
      applicableWeights,
      score,
      eligible,
      status: eligible ? 'scored_eligible' : 'needs_review',
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
      canSpend: false,
      liveVerified: false,
    };
    const { digest: _d, ...rest } = record;
    void _d;
    const withDigest = { ...rest, digest: computeCanonicalDigest(rest) };
    const dir = scoresDir(scriptId, root);
    const file = path.join(dir, `${scoreId}.json`);
    assertFileContained(file, root, scriptId);
    if (fs.existsSync(file)) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Score already exists: ${scoreId}`, { scoreId });
    }
    atomicWriteJson(file, withDigest);
    return { ...withDigest };
  } finally {
    lock.release();
  }
}

export async function selectReference(input = {}, { root = getRuntimeRoot() } = {}) {
  const { scriptId, expectedRevision, nodeId, nodeDigest, reviewer, candidateId, candidateHash, consideredCandidateIds, expectedReferenceRevision, reason } = input;
  assertScriptId(scriptId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] expectedRevision must be a positive integer`, { expectedRevision });
  }
  if (typeof nodeId !== 'string' || !/^(char|loc|prop):[A-Za-z0-9_-]{1,64}$/.test(nodeId)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] select_reference only for char:|loc:|prop: (use reference_pack for shots): ${nodeId}`, { nodeId });
  }
  if (typeof nodeDigest !== 'string' || !HASH_RE.test(nodeDigest)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] nodeDigest must be a full hex digest', { nodeId });
  }
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reviewer must be a non-empty client identity', { reviewer });
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reason must be a non-empty client reason', { reason });
  }
  if (typeof candidateId !== 'string' || !SCORE_ID_RE.test(candidateId)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateId must be a full UUID', { candidateId });
  }
  if (typeof candidateHash !== 'string' || !HASH_RE.test(candidateHash)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateHash must be a full hex digest', { candidateHash });
  }
  if (!Array.isArray(consideredCandidateIds) || consideredCandidateIds.length === 0 || consideredCandidateIds.length > 20) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] consideredCandidateIds must be 1..20 UUIDs including the selected candidate', { consideredCandidateIds });
  }
  for (const id of consideredCandidateIds) {
    if (typeof id !== 'string' || !SCORE_ID_RE.test(id)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] consideredCandidateIds entry must be a full UUID: ${id}`, { id });
    }
  }
  if (!consideredCandidateIds.includes(candidateId)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] consideredCandidateIds must include the selected candidateId', { candidateId });
  }
  if (!Number.isInteger(expectedReferenceRevision) || expectedReferenceRevision < 0) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] expectedReferenceRevision must be an integer >= 0', { expectedReferenceRevision });
  }

  const snapshot = getStory(scriptId, { root });
  if (snapshot.revision !== expectedRevision) {
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId });
  }
  let dag;
  try {
    dag = buildStoryDag(snapshot);
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] DAG unreadable: ${e.message}`, { scriptId });
  }
  if (!dag.nodes.has(nodeId)) {
    throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Node '${nodeId}' not in active DAG`, { nodeId });
  }
  const curDigest = snapshot.nodeStates?.[nodeId]?.nodeDigest;
  if (!curDigest || curDigest !== nodeDigest) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Stale nodeDigest for ${nodeId}`, { nodeId });
  }
  const cand = getCandidate(scriptId, candidateId, { root });
  if (cand.nodeId !== nodeId || cand.hash.toLowerCase() !== candidateHash.toLowerCase() || cand.nodeDigest !== nodeDigest) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', '[REVIEW_DIGEST_MISMATCH] Candidate binding mismatch for selection', { candidateId, nodeId });
  }
  // Considered set must all exist and belong to the same node.
  for (const id of consideredCandidateIds) {
    const c = getCandidate(scriptId, id, { root });
    if (c.nodeId !== nodeId) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Considered candidate ${id} belongs to ${c.nodeId}, not ${nodeId}`, { id, nodeId });
    }
  }
  // Physical file + decode recheck (caller bool cannot override).
  // Every stored c.path access is containment-checked before stat/read/probe.
  assertFileContained(cand.path, root, scriptId);
  if (!fs.existsSync(cand.path)) {
    throw new FlowError('MEDIA_NOT_FOUND', `[MEDIA_NOT_FOUND] Candidate file missing: ${candidateId}`, { candidateId });
  }
  assertFileContained(cand.path, root, scriptId);
  const bytes = fs.readFileSync(cand.path);
  if (sha256Hex(bytes).toLowerCase() !== cand.hash.toLowerCase()) {
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed: ${candidateId}`, { candidateId });
  }
  assertFileContained(cand.path, root, scriptId);
  const selectProbe = await probeImage(cand.path, { timeoutMs: 15000 });
  if (selectProbe.hash.toLowerCase() !== cand.hash.toLowerCase()) {
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate decode hash mismatch: ${candidateId}`, { candidateId });
  }
  // Final physical hash recheck before publish.
  assertFileContained(cand.path, root, scriptId);
  const selectFinal = fs.readFileSync(cand.path);
  if (sha256Hex(selectFinal).toLowerCase() !== cand.hash.toLowerCase()) {
    throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Candidate bytes changed before select publish: ${candidateId}`, { candidateId });
  }
  if (policyDigestOf(snapshot) !== cand.policyDigest) {
    throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Candidate policy stale; selection refused', { candidateId });
  }
  // Gate eligibility: the LATEST immutable score for this candidate under the
  // current digest-bound node must be eligible. Never find any prior eligible:
  // a later FAIL/UNKNOWN overrules an earlier PASS.
  const scores = listScores(scriptId, { root })
    .filter((s) => s.candidateId === candidateId && s.nodeDigest === nodeDigest)
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  const latestScore = scores.length > 0 ? scores[scores.length - 1] : null;
  if (!latestScore || latestScore.eligible !== true) {
    throw new FlowError('REVIEW_NEEDS_REVIEW', '[REVIEW_NEEDS_REVIEW] Latest score is not eligible (all hard gates pass/NA required); selection blocked', { candidateId });
  }
  const eligibleScore = latestScore;

  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const fresh = getStory(scriptId, { root });
    if (fresh.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch on select publish`, { scriptId });
    }
    const cur2 = fresh.nodeStates?.[nodeId]?.nodeDigest;
    if (!cur2 || cur2 !== nodeDigest) {
      throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Stale nodeDigest on select publish`, { nodeId });
    }
    const existingForNode = listReferences(scriptId, { root }).filter((r) => r.nodeId === nodeId);
    const maxRev = existingForNode.reduce((m, r) => Math.max(m, r.selectionRevision ?? 0), 0);
    if (maxRev !== expectedReferenceRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Reference revision mismatch for ${nodeId}: expected ${expectedReferenceRevision}, current is ${maxRev}`, { nodeId, expectedReferenceRevision, actualRevision: maxRev });
    }
    const referenceId = crypto.randomUUID();
    const nowMs = Date.now();
    const record = {
      v: REFERENCE_VERSION,
      id: referenceId,
      referenceId,
      scriptId,
      nodeId,
      nodeDigest,
      candidateId,
      candidateHash: cand.hash,
      candidateDigest: cand.digest,
      scriptRevision: fresh.revision,
      scriptRevisionId: fresh.revisionId,
      scriptDigest: fresh.digest,
      selectionRevision: maxRev + 1,
      supersedes: existingForNode.map((r) => r.referenceId),
      consideredCandidateIds: [...consideredCandidateIds],
      consideredHashes: consideredCandidateIds.map((id) => getCandidate(scriptId, id, { root }).hash),
      scoreId: eligibleScore.scoreId,
      reviewer: reviewer.trim(),
      reason: reason.trim(),
      status: 'current',
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
      canSpend: false,
      liveVerified: false,
    };
    const { digest: _d, ...rest } = record;
    void _d;
    const withDigest = { ...rest, digest: computeCanonicalDigest(rest) };
    const dir = referencesDir(scriptId, root);
    const file = path.join(dir, `${referenceId}.json`);
    assertFileContained(file, root, scriptId);
    if (fs.existsSync(file)) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Reference already exists: ${referenceId}`, { referenceId });
    }
    atomicWriteJson(file, withDigest);
    return { ...withDigest };
  } finally {
    lock.release();
  }
}

export const PACK_VERSION = 1;
export const PACK_ID_RE = SCORE_ID_RE;
export const PACK_SLOT_CAP = 3;

function packsDir(scriptId, root) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'packs');
  assertDirContained(dir, root, scriptId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  assertDirContained(dir, root, scriptId);
  return dir;
}

export function listPacks(scriptId, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'packs');
  if (!fs.existsSync(dir)) return [];
  assertDirContained(dir, root, scriptId);
  const files = fs.readdirSync(dir)
    .filter((n) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(n)) {
        throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Unexpected file in packs directory: ${n}`, { file: n });
      }
      return true;
    })
    .map((n) => {
      const file = path.join(dir, n);
      assertFileContained(file, root, scriptId);
      return { file, id: n.slice(0, -5) };
    });
  const out = files.map(({ file, id }) => {
    const data = readVersionedJson(file, { supported: [PACK_VERSION] });
    verifyChecksum(data, file);
    if (data.id !== id || data.packId !== id) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Pack id binding mismatch: ${file}`, { file });
    }
    if (data.scriptId !== scriptId) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Pack script mismatch: ${file}`, { file });
    }
    assertPackShape(data, file);
    return data;
  });
  out.sort((a, b) => (a.packRevision ?? 0) - (b.packRevision ?? 0) || ((a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)));
  return out;
}

export function getCurrentPacks(scriptId, { root = getRuntimeRoot() } = {}) {
  const all = listPacks(scriptId, { root });
  const byShot = new Map();
  for (const p of all) {
    const cur = byShot.get(p.shotId);
    if (!cur || p.packRevision > cur.packRevision) byShot.set(p.shotId, p);
  }
  return [...byShot.values()].sort((a, b) => a.shotId.localeCompare(b.shotId));
}

function requiredRefsForShot(snapshot, dag, shotNodeId) {
  const shotId = shotNodeId.startsWith('shot:') ? shotNodeId.slice(5) : shotNodeId;
  const shot = (snapshot.shots || []).find((s) => s.id === shotId);
  if (!shot) {
    throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Shot not found: ${shotNodeId}`, { shotId });
  }
  const scene = (snapshot.scenes || []).find((sc) => sc.id === shot.sceneId);
  if (!scene) {
    throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Owning scene not found for ${shotNodeId}: ${shot.sceneId}`, { shotId });
  }
  const required = new Set();
  for (const cid of shot.entities?.characters || []) required.add(`char:${cid}`);
  for (const pid of shot.entities?.props || []) required.add(`prop:${pid}`);
  if (scene.locationId) required.add(`loc:${scene.locationId}`);
  try {
    for (const dep of dag.getDependencies(shotNodeId)) {
      const src = dep.prerequisite ?? dep.source;
      if (typeof src === 'string' && /^(char|loc|prop):/.test(src) && dep.type === 'reference') {
        required.add(src);
      }
    }
  } catch {
    // DAG already validated; ignore here.
  }
  return { shot, scene, required: [...required].sort() };
}

export async function createReferencePack(input = {}, { root = getRuntimeRoot() } = {}) {
  const { scriptId, expectedRevision, nodeId, nodeDigest, reviewer, reason, expectedPackRevision } = input;
  assertScriptId(scriptId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] expectedRevision must be a positive integer', { expectedRevision });
  }
  if (typeof nodeId !== 'string' || !/^shot:[A-Za-z0-9_-]{1,64}$/.test(nodeId)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] reference_pack only for shot: nodes: ${nodeId}`, { nodeId });
  }
  if (typeof nodeDigest !== 'string' || !HASH_RE.test(nodeDigest)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] nodeDigest must be a full hex digest', { nodeId });
  }
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reviewer must be a non-empty client identity', { reviewer });
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] reason must be a non-empty client reason', { reason });
  }
  if (!Number.isInteger(expectedPackRevision) || expectedPackRevision < 0) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] expectedPackRevision must be an integer >= 0', { expectedPackRevision });
  }

  const snapshot = getStory(scriptId, { root });
  if (snapshot.revision !== expectedRevision) {
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId });
  }
  let dag;
  try {
    dag = buildStoryDag(snapshot);
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] DAG unreadable: ${e.message}`, { scriptId });
  }
  if (!dag.nodes.has(nodeId)) {
    throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Shot '${nodeId}' not in active DAG`, { nodeId });
  }
  const curShotDigest = snapshot.nodeStates?.[nodeId]?.nodeDigest;
  if (!curShotDigest || curShotDigest !== nodeDigest) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Stale nodeDigest for ${nodeId}`, { nodeId });
  }
  const { required } = requiredRefsForShot(snapshot, dag, nodeId);
  const currentByNode = new Map(getCurrentReferences(scriptId, { root }).map((r) => [r.nodeId, r]));
  const missing = required.filter((n) => !currentByNode.has(n));
  if (missing.length > 0) {
    throw new FlowError('PACK_BLOCKED', `[PACK_BLOCKED] Missing canonical references for ${nodeId}: ${missing.join(', ')}`, {
      shotId: nodeId,
      missing,
      nextAction: 'select_reference for each missing char/loc/prop before packing',
    });
  }
  if (required.length > PACK_SLOT_CAP) {
    throw new FlowError('PACK_BLOCKED', `[PACK_BLOCKED] Required refs ${required.length} exceed slot cap ${PACK_SLOT_CAP} for ${nodeId}; refusing to drop`, {
      shotId: nodeId,
      required,
      cap: PACK_SLOT_CAP,
      options: ['reviewed_composite', 'different_verified_model', 'split_shot'],
    });
  }
  // Shared freshness (never separate prompt-only logic): recompute exact required
  // entity set already done above from owning scene + actual shot/DAG. Over-cap
  // blocks with no omission (checked above). Missing/tampered references block
  // without deleting originals.
  const selections = [];
  for (const reqNode of required) {
    const ref = currentByNode.get(reqNode);
    const fresh = checkReferenceFreshness(ref, snapshot, dag, { root });
    if (!fresh.current) {
      throw new FlowError('PACK_BLOCKED', `[PACK_BLOCKED] Reference for ${reqNode} is stale (${fresh.reason}); reselect required`, {
        shotId: nodeId,
        nodeId: reqNode,
        reason: fresh.reason,
      });
    }
    const cand = getCandidate(scriptId, ref.candidateId, { root });
    if (cand.hash.toLowerCase() !== ref.candidateHash.toLowerCase()) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Reference candidate hash mismatch for ${reqNode}`, { nodeId: reqNode });
    }
    assertFileContained(cand.path, root, scriptId);
    if (!fs.existsSync(cand.path)) {
      throw new FlowError('MEDIA_NOT_FOUND', `[MEDIA_NOT_FOUND] Reference file missing for ${reqNode}: ${ref.candidateId}`, { nodeId: reqNode });
    }
    assertFileContained(cand.path, root, scriptId);
    const bytes = fs.readFileSync(cand.path);
    if (sha256Hex(bytes).toLowerCase() !== cand.hash.toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Reference bytes changed for ${reqNode}`, { nodeId: reqNode });
    }
    // Technical probe hash must be checked after asynchronous decode.
    assertFileContained(cand.path, root, scriptId);
    const packProbe = await probeImage(cand.path, { timeoutMs: 15000 });
    if (packProbe.hash.toLowerCase() !== cand.hash.toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Reference decode hash mismatch for ${reqNode}`, { nodeId: reqNode });
    }
    // Final physical hash recheck before publish.
    assertFileContained(cand.path, root, scriptId);
    const packFinal = fs.readFileSync(cand.path);
    if (sha256Hex(packFinal).toLowerCase() !== cand.hash.toLowerCase()) {
      throw new FlowError('MEDIA_HASH_MISMATCH', `[MEDIA_HASH_MISMATCH] Reference bytes changed before pack publish for ${reqNode}`, { nodeId: reqNode });
    }
    const role = reqNode.startsWith('loc:') ? 'anchor' : 'ingredient';
    selections.push({
      nodeId: reqNode,
      referenceId: ref.referenceId,
      candidateId: ref.candidateId,
      hash: ref.candidateHash,
      selectionRevision: ref.selectionRevision,
      role,
    });
  }
  selections.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const fresh = getStory(scriptId, { root });
    if (fresh.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Revision mismatch on pack publish', { scriptId });
    }
    const cur2 = fresh.nodeStates?.[nodeId]?.nodeDigest;
    if (!cur2 || cur2 !== nodeDigest) {
      throw new FlowError('REVIEW_DIGEST_MISMATCH', '[REVIEW_DIGEST_MISMATCH] Stale shot digest on pack publish', { nodeId });
    }
    // Re-read current canonical selections under script lock after slow probes
    // to prevent publishing a superseded pack. Recompute the exact required
    // entity set from the fresh snapshot (owning scene + actual shot/DAG) and
    // refuse if it no longer matches the probed selections.
    let freshDag;
    try {
      freshDag = buildStoryDag(fresh);
    } catch (e) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] DAG unreadable on pack publish: ${e.message}`, { scriptId });
    }
    const freshRequired = requiredRefsForShot(fresh, freshDag, nodeId).required;
    const freshByNode = new Map(getCurrentReferences(scriptId, { root }).map((r) => [r.nodeId, r]));
    const probedIds = selections.map((s) => s.nodeId).sort();
    if (JSON.stringify([...freshRequired].sort()) !== JSON.stringify(probedIds)) {
      throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Required reference set changed before pack publish; refusing superseded pack', { shotId: nodeId, required: freshRequired, probed: probedIds });
    }
    for (const sel of selections) {
      const curRef = freshByNode.get(sel.nodeId);
      if (!curRef || curRef.referenceId !== sel.referenceId || curRef.selectionRevision !== sel.selectionRevision || curRef.candidateHash.toLowerCase() !== sel.hash.toLowerCase()) {
        throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Canonical selection for ${sel.nodeId} changed before pack publish; refusing superseded pack`, { shotId: nodeId, nodeId: sel.nodeId });
      }
      const freshness = checkReferenceFreshness(curRef, fresh, freshDag, { root });
      if (!freshness.current) {
        throw new FlowError('PACK_BLOCKED', `[PACK_BLOCKED] Reference for ${sel.nodeId} became ${freshness.reason} before pack publish; reselect required`, { shotId: nodeId, nodeId: sel.nodeId });
      }
    }
    const existingForShot = listPacks(scriptId, { root }).filter((p) => p.shotId === nodeId);
    const maxRev = existingForShot.reduce((m, p) => Math.max(m, p.packRevision ?? 0), 0);
    if (maxRev !== expectedPackRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Pack revision mismatch for ${nodeId}: expected ${expectedPackRevision}, current is ${maxRev}`, { shotId: nodeId });
    }
    const packId = crypto.randomUUID();
    const nowMs = Date.now();
    const record = {
      v: PACK_VERSION,
      id: packId,
      packId,
      scriptId,
      shotId: nodeId,
      shotDigest: nodeDigest,
      scriptRevision: fresh.revision,
      scriptRevisionId: fresh.revisionId,
      scriptDigest: fresh.digest,
      worldStateDigest: fresh.digest,
      packRevision: maxRev + 1,
      supersedes: existingForShot.map((p) => p.packId),
      selections,
      reviewer: reviewer.trim(),
      reason: reason.trim(),
      status: 'current',
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
      canSpend: false,
      liveVerified: false,
    };
    const { digest: _d, ...rest } = record;
    void _d;
    const withDigest = { ...rest, digest: computeCanonicalDigest(rest) };
    const dir = packsDir(scriptId, root);
    const file = path.join(dir, `${packId}.json`);
    assertFileContained(file, root, scriptId);
    if (fs.existsSync(file)) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Pack already exists: ${packId}`, { packId });
    }
    atomicWriteJson(file, withDigest);
    return { ...withDigest };
  } finally {
    lock.release();
  }
}
