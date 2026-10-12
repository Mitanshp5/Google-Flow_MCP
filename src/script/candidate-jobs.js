import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { getRuntimeRoot, atomicWriteJson, readVersionedJson, acquireLock } from '../storage/runtime-store.js';
import {
  getStory,
  getScriptDir,
  getScriptLockFile,
  computeCanonicalDigest,
  assertDirContained,
  assertFileContained,
  SAFE_SCRIPT_ID_RE,
} from './store.js';
import { buildStoryDag } from './dag.js';
import { VALID_ASPECT_RATIOS, VALID_REFERENCE_RIGHTS } from './schema.js';

export const CANDIDATE_JOB_VERSION = 1;
export const VALID_JOB_STAGES = Object.freeze(['references', 'image-candidates']);
// Truthful bounded stages: planned (intent only, local or remote), paused_*
// (quota/time exhaustion with immutable deadline), media-verified (all
// variants published locally), needs_review (partial/unlinked, operator acts).
// Remote approval/invocation never changes these locally (not-invoked).
export const KNOWN_JOB_STATUSES = Object.freeze(['planned', 'paused_time_budget', 'collecting-media', 'media-verified', 'needs_review', 'paused_quota', 'paused_media']);
export const JOB_ID_RE = Object.freeze(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const JOB_FILENAME_RE = Object.freeze(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i);
export const NODE_ID_RE = Object.freeze(/^(char|loc|prop|shot):[A-Za-z0-9_-]{1,64}$/);
export const NODE_DIGEST_RE = Object.freeze(/^[0-9a-f]{64}$/i);
// Consecutive no-op resume checkpoints collapse into one entry (with a count)
// so repeated resumes cannot grow history without bound; meaningful events are
// preserved and the created-first entry is never dropped by the cap.
export const MAX_JOB_HISTORY = 200;
// NOTE (correction item 3): the v1 jobs/index.json pointer was eliminated. Job
// records are independently committed checksum records listed by directory
// scan; a second pointer file only added an orphan-reconciliation burden with
// no benefit for this slice. A stale literal index.json is ignored by listing.

const ALLOWED_RUN_KEYS = Object.freeze([
  'scriptId', 'storyId', 'expectedRevision', 'stage', 'nodeId', 'nodeDigest',
  'model', 'ratio', 'quantity', 'candidateLimit', 'timeBudgetSec',
  'source', 'files', 'minWidth', 'minHeight', 'jobId',
]);

export function assertAllowedRunKeys(input, tool = 'flow_script_run') {
  rejectUnknownKeys(input, ALLOWED_RUN_KEYS, tool);
}
const ALLOWED_RESUME_KEYS = Object.freeze(['scriptId', 'storyId', 'jobId', 'expectedRevision']);

function rejectUnknownKeys(input, allowed, tool) {
  for (const k of Object.keys(input ?? {})) {
    if (!allowed.includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown field for ${tool}: ${k}`, { field: k });
    }
  }
}

// Conflicting scriptId/storyId aliases are rejected, never normalized into a
// lookup: silently preferring one binding could address the wrong script.
function resolveScriptId(input) {
  const s = input?.scriptId;
  const t = input?.storyId;
  if (s !== undefined && t !== undefined && s !== t) {
    throw new FlowError(
      'INVALID_PARAMS',
      '[INVALID_PARAMS] Conflicting scriptId and storyId; refusing to normalize into a lookup',
      { scriptId: s, storyId: t }
    );
  }
  return s ?? t;
}

function assertPositiveInt(name, v, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(v) || v <= 0 || v > max) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] ${name} must be a positive integer${max !== Number.MAX_SAFE_INTEGER ? ` <= ${max}` : ''}: ${v}`, { [name]: v });
  }
}

function assertPositiveFinite(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] ${name} must be a positive finite number: ${v}`, { [name]: v });
  }
}

// Exact identifiers: no trimming or case normalization. A padded value is a
// different identifier and must be rejected, not silently repaired.
function assertExactString(name, v, max) {
  if (typeof v !== 'string' || !v || v.length > max || v !== v.trim() || !v.trim()) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] ${name} must be an exact non-empty string (no leading/trailing whitespace)`, { [name]: typeof v === 'string' ? v.slice(0, 64) : v });
  }
}

function checkedDeadlineMs(timeBudgetSec, nowMs) {
  const delta = timeBudgetSec * 1000;
  const at = nowMs + delta;
  if (!Number.isFinite(delta) || !Number.isFinite(at)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] timeBudgetSec yields a non-finite deadline; refusing', { timeBudgetSec });
  }
  // Huge finite inputs (e.g. 1e308, or beyond the Date range) must fail clean
  // here instead of throwing RangeError out of `new Date().toISOString()`.
  if (Number.isNaN(new Date(at).getTime())) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] timeBudgetSec yields an unrepresentable deadline; refusing', { timeBudgetSec });
  }
  return at;
}

export function getJobsDir(scriptId, root = getRuntimeRoot(), { ensure = true } = {}) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] Invalid script ID: ${scriptId}`, { scriptId });
  }
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'jobs');
  assertDirContained(dir, root, scriptId);
  if (ensure) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    assertDirContained(dir, root, scriptId);
  }
  return dir;
}

function jobFileFor(jobsDir, jobId, root, scriptId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] jobId must be a full UUID: ${jobId}`, { jobId });
  }
  const file = path.join(jobsDir, `${jobId}.json`);
  assertFileContained(file, root, scriptId);
  return file;
}

// Contained durable path of a job record (read-only helper for lock-holding
// callers that perform their own read-modify-write inside one critical
// section; locks are not reentrant so helpers must not nest).
export function getJobRecordPath(scriptId, jobId, { root = getRuntimeRoot() } = {}) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] scriptId must be a valid identifier: ${scriptId}`, { scriptId });
  }
  const jobsDir = getJobsDir(scriptId, root, { ensure: false });
  return jobFileFor(jobsDir, jobId, root, scriptId);
}

export function verifyJobChecksum(data, file) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job record invalid: ${file}`, { file });
  }
  const { digest, ...rest } = data;
  if (typeof digest !== 'string' || !digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job digest missing: ${file}`, { file });
  }
  let computed;
  try {
    computed = computeCanonicalDigest(rest);
  } catch {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job payload undigestible: ${file}`, { file });
  }
  if (computed !== digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job digest mismatch: ${file}`, { file });
  }
  return data;
}

// Structured record validation beyond the checksum: every numeric, status and
// request field is range/type-checked and the record is bound to the filename
// and script it was read for. Anything invalid fails closed.
export function assertJobShape(job, file) {
  const bad = (field, detail) => {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job field invalid (${field}): ${file}`, { file, field, detail });
  };
  if (typeof job.id !== 'string' || !JOB_ID_RE.test(job.id)) bad('id', job.id);
  if (typeof job.jobId !== 'string' || !JOB_ID_RE.test(job.jobId)) bad('jobId', job.jobId);
  if (job.id !== job.jobId) bad('id/jobId', 'mismatch');
  if (typeof job.scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(job.scriptId)) bad('scriptId', job.scriptId);
  if (!Number.isInteger(job.scriptRevision) || job.scriptRevision < 1) bad('scriptRevision', job.scriptRevision);
  if (typeof job.scriptRevisionId !== 'string' || !job.scriptRevisionId) bad('scriptRevisionId', job.scriptRevisionId);
  if (typeof job.scriptDigest !== 'string' || !NODE_DIGEST_RE.test(job.scriptDigest)) bad('scriptDigest', job.scriptDigest);
  if (!VALID_JOB_STAGES.includes(job.stage)) bad('stage', job.stage);
  if (typeof job.nodeId !== 'string' || !NODE_ID_RE.test(job.nodeId)) bad('nodeId', job.nodeId);
  if (typeof job.nodeDigest !== 'string' || !NODE_DIGEST_RE.test(job.nodeDigest)) bad('nodeDigest', job.nodeDigest);
  if (typeof job.prompt !== 'string' || !job.prompt.trim()) bad('prompt', 'missing');
  if (!job.binding || typeof job.binding !== 'object' || Array.isArray(job.binding)) bad('binding', typeof job.binding);
  if (!Number.isInteger(job.policyRevision) || job.policyRevision < 1) bad('policyRevision', job.policyRevision);
  if (typeof job.policyDigest !== 'string' || !NODE_DIGEST_RE.test(job.policyDigest)) bad('policyDigest', job.policyDigest);
  if (typeof job.promptDigest !== 'string' || !NODE_DIGEST_RE.test(job.promptDigest)) bad('promptDigest', job.promptDigest);
  if (typeof job.decisionScope !== 'string' || !NODE_DIGEST_RE.test(job.decisionScope)) bad('decisionScope', job.decisionScope);
  assertModelRatioShape(job, bad);
  if (!Number.isInteger(job.quantity) || job.quantity < 1 || job.quantity > 4) bad('quantity', job.quantity);
  if (!Number.isInteger(job.candidateLimit) || job.candidateLimit < 1) bad('candidateLimit', job.candidateLimit);
  if (job.quantity > job.candidateLimit) bad('quantity/candidateLimit', 'quantity exceeds candidateLimit');
  if (!Number.isInteger(job.reserved) || job.reserved < 1) bad('reserved', job.reserved);
  if (typeof job.timeBudgetSec !== 'number' || !Number.isFinite(job.timeBudgetSec) || job.timeBudgetSec <= 0) bad('timeBudgetSec', job.timeBudgetSec);
  if (typeof job.createdAt !== 'string' || !job.createdAt) bad('createdAt', job.createdAt);
  if (typeof job.createdAtMs !== 'number' || !Number.isFinite(job.createdAtMs) || job.createdAtMs < 0) bad('createdAtMs', job.createdAtMs);
  if (typeof job.deadlineAt !== 'string' || !job.deadlineAt) bad('deadlineAt', job.deadlineAt);
  if (typeof job.deadlineAtMs !== 'number' || !Number.isFinite(job.deadlineAtMs) || !(job.deadlineAtMs > job.createdAtMs)) bad('deadlineAtMs', job.deadlineAtMs);
  if (!KNOWN_JOB_STATUSES.includes(job.status)) bad('status', job.status);
  if (!['not-invoked', 'fixture-invoked', 'fixture-unknown'].includes(job.invocation)) bad('invocation', job.invocation);
  if (job.canSpend !== false) bad('canSpend', job.canSpend);
  if (job.liveVerified !== false) bad('liveVerified', job.liveVerified);
  if (typeof job.nextAction !== 'string' || !job.nextAction) bad('nextAction', job.nextAction);
  if (job.mediaCounts !== undefined) {
    const m = job.mediaCounts;
    if (!m || typeof m !== 'object' || Array.isArray(m)) bad('mediaCounts', typeof m);
    else for (const k of ['candidates', 'duplicates', 'bytes']) {
      if (!Number.isInteger(m[k]) || m[k] < 0) bad(`mediaCounts.${k}`, m[k]);
    }
  }
  if (job.lastError !== undefined && job.lastError !== null) {
    const e = job.lastError;
    if (!e || typeof e !== 'object' || Array.isArray(e)) bad('lastError', typeof e);
    else {
      if (typeof e.code !== 'string' || !e.code) bad('lastError.code', e.code);
      if (typeof e.message !== 'string' || !e.message) bad('lastError.message', e.message);
    }
  }
  if (job.elapsedMs !== undefined && (typeof job.elapsedMs !== 'number' || !Number.isFinite(job.elapsedMs) || job.elapsedMs < 0)) bad('elapsedMs', job.elapsedMs);
  if (job.elapsedSec !== undefined && (typeof job.elapsedSec !== 'number' || !Number.isFinite(job.elapsedSec) || job.elapsedSec < 0)) bad('elapsedSec', job.elapsedSec);
  if (!Array.isArray(job.history) || job.history.length < 1 || job.history.length > MAX_JOB_HISTORY) bad('history', Array.isArray(job.history) ? job.history.length : typeof job.history);
  if (job.history[0]?.event !== 'created') bad('history[0]', job.history[0]?.event);
  for (const h of job.history) {
    if (!h || typeof h.event !== 'string' || !h.event || typeof h.at !== 'string' || !h.at) bad('history-entry', h);
  }
  return job;
}

function assertModelRatioShape(job, bad) {
  if (typeof job.model !== 'string' || !job.model || job.model.length > 100 || job.model !== job.model.trim() || !job.model.trim()) bad('model', job.model);
  if (typeof job.ratio !== 'string' || !job.ratio || job.ratio.length > 16 || job.ratio !== job.ratio.trim() || !job.ratio.trim()) bad('ratio', job.ratio);
  if (!VALID_ASPECT_RATIOS.includes(job.ratio)) bad('ratio', job.ratio);
}

function readJobFile(file, { expectedJobId = null, scriptId = null } = {}) {
  const data = readVersionedJson(file, { supported: [CANDIDATE_JOB_VERSION] });
  verifyJobChecksum(data, file);
  assertJobShape(data, file);
  if (expectedJobId !== null && (data.id !== expectedJobId || data.jobId !== expectedJobId)) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job id does not bind requested filename: ${file}`, { file, expectedJobId });
  }
  if (scriptId !== null && data.scriptId !== scriptId) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Candidate job script mismatch: ${file}`, { file, scriptId });
  }
  return data;
}

function listJobFiles(jobsDir, root, scriptId) {
  if (!fs.existsSync(jobsDir)) return [];
  return fs.readdirSync(jobsDir)
    .filter((n) => {
      if (n === 'index.json') return false; // eliminated legacy pointer: ignored, never read
      if (!JOB_FILENAME_RE.test(n)) {
        throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Unexpected file in candidate jobs directory: ${n}`, { file: n });
      }
      return true;
    })
    .map((n) => {
      const file = path.join(jobsDir, n);
      // Pre-read containment on every child: a planted file junction/symlink
      // escaping FLOW_HOME fails here before any byte is trusted.
      assertFileContained(file, root, scriptId);
      return { file, jobId: n.slice(0, -'.json'.length) };
    });
}

// Authored prompt only: display names/titles/descriptions are review metadata,
// never a generation prompt. A DAG member without an authored prompt cannot
// bind an intent.
function findAuthoredPrompt(snapshot, nodeId) {
  const sep = nodeId.indexOf(':');
  const prefix = nodeId.slice(0, sep);
  const id = nodeId.slice(sep + 1);
  if (prefix === 'char') {
    const n = (snapshot.bible?.characters || []).find((c) => c.id === id);
    if (n && typeof n.prompt === 'string' && n.prompt.trim()) return n.prompt;
    return null;
  }
  if (prefix === 'loc') {
    const n = (snapshot.bible?.locations || []).find((l) => l.id === id);
    if (n && typeof n.prompt === 'string' && n.prompt.trim()) return n.prompt;
    return null;
  }
  if (prefix === 'prop') {
    const n = (snapshot.bible?.props || []).find((p) => p.id === id);
    if (n && typeof n.prompt === 'string' && n.prompt.trim()) return n.prompt;
    return null;
  }
  if (prefix === 'shot') {
    const n = (snapshot.shots || []).find((s) => s.id === id);
    if (n && typeof n.prompt === 'string' && n.prompt.trim()) return n.prompt;
    return null;
  }
  return null;
}

function policyDigestOf(snapshot) {
  return computeCanonicalDigest({ binding: snapshot.binding, policy: snapshot.policy, governance: snapshot.governance });
}

// Authoritative intent binding against a freshly read snapshot: active-DAG
// membership (orphan nodeStates from accepted W08 retention never qualify),
// exact node digest, policy budget bounds, authored prompt, and the derived
// policy/decision digests that scope idempotence and the aggregate cap.
function bindRunIntent(snapshot, { scriptId, stage, nodeId, nodeDigest, model, ratio, candidateLimit, timeBudgetSec }) {
  let dag;
  try {
    dag = buildStoryDag(snapshot);
  } catch (e) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Script DAG unreadable for ${scriptId}: ${e.message}`, { scriptId });
  }
  if (!dag.nodes.has(nodeId)) {
    throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Node '${nodeId}' is not part of the active script DAG in script ${scriptId}`, { scriptId, nodeId });
  }
  const state = snapshot.nodeStates?.[nodeId];
  if (!state || state.nodeDigest !== nodeDigest) {
    throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Stale nodeDigest for ${nodeId}: content digest has changed`, { nodeId, expectedDigest: nodeDigest, currentDigest: state?.nodeDigest ?? null });
  }
  if (candidateLimit > snapshot.policy.candidateLimit) {
    throw new FlowError('RESERVATION_EXCEEDED', `[RESERVATION_EXCEEDED] candidateLimit ${candidateLimit} exceeds script policy candidateLimit ${snapshot.policy.candidateLimit}`, { candidateLimit, policyLimit: snapshot.policy.candidateLimit });
  }
  if (timeBudgetSec > snapshot.policy.timeBudgetSec) {
    throw new FlowError('RESERVATION_EXCEEDED', `[RESERVATION_EXCEEDED] timeBudgetSec ${timeBudgetSec} exceeds script policy timeBudgetSec ${snapshot.policy.timeBudgetSec}`, { timeBudgetSec, policyBudget: snapshot.policy.timeBudgetSec });
  }
  const prompt = findAuthoredPrompt(snapshot, nodeId);
  if (prompt === null) {
    throw new FlowError('INVALID_STORY_SCHEMA', `[INVALID_STORY_SCHEMA] Node '${nodeId}' has no authored prompt; refusing to bind generation intent. Add bible prompt via flow_script_update (e.g. patch bible.characters[] entry with {"prompt": "..."}) or run a prompt-authored node instead`, { scriptId, nodeId });
  }
  const policyDigest = policyDigestOf(snapshot);
  const promptDigest = computeCanonicalDigest(prompt);
  const decisionScope = computeCanonicalDigest({ stage, nodeId, nodeDigest, model, ratio, promptDigest });
  return { prompt, policyDigest, promptDigest, decisionScope };
}

function validateRunFields(input) {
  const scriptId = resolveScriptId(input);
  const { expectedRevision, stage, nodeId, nodeDigest, model, ratio, quantity, candidateLimit, timeBudgetSec } = input;
  const { source, files, minWidth, minHeight, jobId } = input;
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] scriptId must be a valid identifier: ${scriptId}`, { scriptId });
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] expectedRevision must be a positive integer: ${expectedRevision}`, { expectedRevision });
  }
  if (!VALID_JOB_STAGES.includes(stage)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] stage must be one of: ${VALID_JOB_STAGES.join(', ')}`, { stage });
  }
  if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] nodeId must match char:|loc:|prop:|shot: prefix with a valid entity id: ${nodeId}`, { nodeId });
  }
  if (typeof nodeDigest !== 'string' || !NODE_DIGEST_RE.test(nodeDigest)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] nodeDigest must be a full hex digest`, { nodeId });
  }
  assertExactString('model', model, 100);
  assertExactString('ratio', ratio, 16);
  if (!VALID_ASPECT_RATIOS.includes(ratio)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] Unsupported image aspect ratio', { ratio });
  }
  assertPositiveInt('quantity', quantity, 4);
  assertPositiveInt('candidateLimit', candidateLimit, Number.MAX_SAFE_INTEGER);
  assertPositiveFinite('timeBudgetSec', timeBudgetSec);
  if (quantity > candidateLimit) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] quantity (${quantity}) exceeds candidateLimit (${candidateLimit}); refusing before any intent write`, { quantity, candidateLimit });
  }
  // W09 local-import extension: explicit rights-declared files, quantity must
  // match files count (<=4) and persisted budget. Default (no source) stays
  // prepare-only planned intent with no browser acquisition.
  if (source !== undefined) {
    if (source !== 'local_import') {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] source must be 'local_import' when provided: ${source}`, { source });
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] local_import requires files[] with at least one entry', { files });
    }
    if (files.length > 4) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] local_import files count ${files.length} exceeds cap 4`, { count: files.length });
    }
    if (quantity !== files.length) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] quantity (${quantity}) must match local_import files count (${files.length})`, { quantity, filesCount: files.length });
    }
    for (const [i, f] of files.entries()) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] files[${i}] must be an object with path/rights`, { index: i });
      }
      if (typeof f.path !== 'string' || !f.path) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] files[${i}].path must be a non-empty local path`, { index: i });
      }
      if (f.path.length > 2048) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] files[${i}].path exceeds 2048 chars`, { index: i });
      }
      // No caller may label local import as Flow-generated: provenance is
      // always local_import; reject explicit Flow claims.
      if (typeof f.provenance === 'string' && /flow-?generated/i.test(f.provenance)) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] files[${i}] must never claim Flow-generated provenance for a local import`, { index: i });
      }
      if (!VALID_REFERENCE_RIGHTS.includes(f.rights)) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] files[${i}].rights must be one of: ${VALID_REFERENCE_RIGHTS.join(', ')}`, { index: i, rights: f.rights });
      }
      if (f.rightsNote !== undefined && (typeof f.rightsNote !== 'string' || f.rightsNote.length > 500)) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] files[${i}].rightsNote must be a string <= 500 chars`, { index: i });
      }
      // Reject execution-shaped or provenance-spoofing keys inside files[].
      for (const k of Object.keys(f)) {
        if (!['path', 'rights', 'rightsNote'].includes(k)) {
          throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown field in files[${i}]: ${k}`, { field: k, index: i });
        }
      }
    }
  } else if (files !== undefined || minWidth !== undefined || minHeight !== undefined) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] files/minWidth/minHeight require source local_import', { source });
  }
  if (minWidth !== undefined && (!Number.isInteger(minWidth) || minWidth < 1)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] minWidth must be a positive integer: ${minWidth}`, { minWidth });
  }
  if (minHeight !== undefined && (!Number.isInteger(minHeight) || minHeight < 1)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] minHeight must be a positive integer: ${minHeight}`, { minHeight });
  }
  if (jobId !== undefined) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] jobId is only supported for stage review-artifacts via flow_script_run (not a job intent field)', { jobId });
  }
  return { scriptId, expectedRevision, stage, nodeId, nodeDigest, model, ratio, quantity, candidateLimit, timeBudgetSec, source, files, minWidth, minHeight };
}

function sameBoundIntent(job, fields, bound) {
  return (
    job.policyDigest === bound.policyDigest &&
    job.stage === fields.stage &&
    job.nodeId === fields.nodeId &&
    job.nodeDigest === fields.nodeDigest &&
    job.model === fields.model &&
    job.ratio === fields.ratio &&
    job.quantity === fields.quantity &&
    job.candidateLimit === fields.candidateLimit &&
    job.timeBudgetSec === fields.timeBudgetSec
  );
}

export async function createCandidateJob(input = {}, { root = getRuntimeRoot(), hooks = {} } = {}) {
  rejectUnknownKeys(input, ALLOWED_RUN_KEYS, 'flow_script_run');
  const fields = validateRunFields(input);
  const { scriptId, expectedRevision } = fields;
  // Fail-clean deadline math before any side effect (huge finite inputs).
  checkedDeadlineMs(fields.timeBudgetSec, Date.now());

  // Pre-lock read is advisory only. The authoritative snapshot is re-read
  // under the shared script lock below, so a concurrent update landing
  // between this read and lock acquisition cannot publish a stale intent.
  const pre = getStory(scriptId, { root });
  if (pre.revision !== expectedRevision) {
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${pre.revision}`, { scriptId, expectedRevision, actualRevision: pre.revision });
  }
  bindRunIntent(pre, fields);
  // Internal race-test seam: a controlled concurrent writer runs here, after
  // the advisory read and before lock acquisition. Production passes no hooks.
  await hooks?.beforeLock?.(pre);

  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const snapshot = getStory(scriptId, { root });
    if (snapshot.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId, expectedRevision, actualRevision: snapshot.revision });
    }
    const bound = bindRunIntent(snapshot, fields);
    const jobsDir = getJobsDir(scriptId, root);
    const existing = listJobFiles(jobsDir, root, scriptId)
      .map(({ file, jobId }) => readJobFile(file, { expectedJobId: jobId, scriptId }));

    // Idempotence keeps the exact same handle: the key is the bound policy
    // scope plus the full intent, so an unrelated review revision neither
    // mints a duplicate nor resets the deadline.
    for (const j of existing) {
      if (sameBoundIntent(j, fields, bound)) return { ...j };
    }

    // First finite aggregate cap, scoped to the bound policy
    // (policyRevision is inside policyDigest): every persisted physical
    // variant counts via its stored reservation, including content
    // duplicates — only the identical intent above dedupes. Later extension
    // must support per-entity budgets under the same script budget.
    const reserved = existing
      .filter((j) => j.policyDigest === bound.policyDigest)
      .reduce((s, j) => s + j.reserved, 0);
    if (reserved + fields.quantity > snapshot.policy.candidateLimit) {
      throw new FlowError('RESERVATION_EXCEEDED', `[RESERVATION_EXCEEDED] Reserved candidates ${reserved} + ${fields.quantity} exceeds policy candidateLimit ${snapshot.policy.candidateLimit} for this policy scope`, { reserved, quantity: fields.quantity, policyLimit: snapshot.policy.candidateLimit });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const deadlineAtMs = checkedDeadlineMs(fields.timeBudgetSec, nowMs);
    const jobId = crypto.randomUUID();
    const record = {
      v: CANDIDATE_JOB_VERSION,
      id: jobId,
      jobId,
      scriptId,
      scriptRevision: snapshot.revision,
      scriptRevisionId: snapshot.revisionId,
      scriptDigest: snapshot.digest,
      stage: fields.stage,
      nodeId: fields.nodeId,
      nodeDigest: fields.nodeDigest,
      prompt: bound.prompt,
      promptDigest: bound.promptDigest,
      binding: snapshot.binding,
      policyRevision: snapshot.policy.policyRevision,
      policyDigest: bound.policyDigest,
      decisionScope: bound.decisionScope,
      model: fields.model,
      ratio: fields.ratio,
      quantity: fields.quantity,
      reserved: fields.quantity,
      candidateLimit: fields.candidateLimit,
      timeBudgetSec: fields.timeBudgetSec,
      createdAt: nowIso,
      createdAtMs: nowMs,
      deadlineAt: new Date(deadlineAtMs).toISOString(),
      deadlineAtMs,
      status: 'planned',
      invocation: 'not-invoked',
      canSpend: false,
      liveVerified: false,
      nextAction: 'awaiting_authorization: separate explicit zero-cost authorization and verified quote are required before any remote invocation.',
      history: [{ event: 'created', at: nowIso, revision: snapshot.revision }],
    };
    const persisted = { ...record, digest: computeCanonicalDigest({ ...record }) };

    const file = jobFileFor(jobsDir, jobId, root, scriptId);
    if (fs.existsSync(file)) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Candidate job already exists: ${jobId}`, { jobId });
    }
    atomicWriteJson(file, persisted);
    return { ...persisted };
  } finally {
    lock.release();
  }
}

export function listCandidateJobs(scriptId, { root = getRuntimeRoot() } = {}) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] scriptId must be a valid identifier: ${scriptId}`, { scriptId });
  }
  const jobsDir = getJobsDir(scriptId, root, { ensure: false });
  if (!fs.existsSync(jobsDir)) return [];
  const jobs = listJobFiles(jobsDir, root, scriptId)
    .map(({ file, jobId }) => readJobFile(file, { expectedJobId: jobId, scriptId }));
  jobs.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  return jobs;
}

export function getCandidateJob(scriptId, jobId, { root = getRuntimeRoot() } = {}) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] scriptId must be a valid identifier: ${scriptId}`, { scriptId });
  }
  const jobsDir = getJobsDir(scriptId, root, { ensure: false });
  if (!fs.existsSync(jobsDir)) {
    throw new FlowError('OPERATION_NOT_FOUND', `[OPERATION_NOT_FOUND] Candidate job not found: ${jobId}`, { scriptId, jobId });
  }
  const file = jobFileFor(jobsDir, jobId, root, scriptId);
  if (!fs.existsSync(file)) {
    throw new FlowError('OPERATION_NOT_FOUND', `[OPERATION_NOT_FOUND] Candidate job not found: ${jobId}`, { scriptId, jobId });
  }
  return readJobFile(file, { expectedJobId: jobId, scriptId });
}

function appendResumeHistory(history, entry) {
  const hist = Array.isArray(history) ? [...history] : [];
  const last = hist[hist.length - 1];
  if (last && last.event === 'resumed' && last.revision === entry.revision && last.pause === entry.pause) {
    hist[hist.length - 1] = {
      ...last,
      at: entry.at,
      elapsedMs: entry.elapsedMs,
      count: (Number.isInteger(last.count) ? last.count : 1) + 1,
    };
  } else {
    hist.push({ event: 'resumed', at: entry.at, revision: entry.revision, pause: entry.pause, elapsedMs: entry.elapsedMs, count: 1 });
  }
  while (hist.length > MAX_JOB_HISTORY) hist.splice(1, hist.length - MAX_JOB_HISTORY);
  return hist;
}

export async function resumeCandidateJob(input = {}, { root = getRuntimeRoot(), hooks = {} } = {}) {
  rejectUnknownKeys(input, ALLOWED_RESUME_KEYS, 'flow_script_resume');
  const scriptId = resolveScriptId(input);
  const { jobId, expectedRevision } = input;
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] scriptId must be a valid identifier: ${scriptId}`, { scriptId });
  }
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] jobId must be a full UUID', { jobId: typeof jobId === 'string' ? jobId.slice(0, 64) : jobId });
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] expectedRevision must be a positive integer: ${expectedRevision}`, { expectedRevision });
  }

  const pre = getStory(scriptId, { root });
  if (pre.revision !== expectedRevision) {
    throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${pre.revision}`, { scriptId, expectedRevision, actualRevision: pre.revision });
  }
  await hooks?.beforeLock?.(pre);

  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const snapshot = getStory(scriptId, { root });
    if (snapshot.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId, expectedRevision, actualRevision: snapshot.revision });
    }
    const jobsDir = getJobsDir(scriptId, root);
    const file = jobFileFor(jobsDir, jobId, root, scriptId);
    if (!fs.existsSync(file)) {
      throw new FlowError('OPERATION_NOT_FOUND', `[OPERATION_NOT_FOUND] Candidate job not found: ${jobId}`, { scriptId, jobId });
    }
    const job = readJobFile(file, { expectedJobId: jobId, scriptId });

    // Reconcile the exact bound dependencies under lock. A node that left the
    // active DAG, a stale node digest, or a changed policy/binding refuses
    // reuse; an unrelated revision that preserves them stays resumable.
    // No blind orphan adoption into current intent.
    let dag;
    try {
      dag = buildStoryDag(snapshot);
    } catch (e) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Script DAG unreadable for ${scriptId}: ${e.message}`, { scriptId });
    }
    if (!dag.nodes.has(job.nodeId)) {
      throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Job node '${job.nodeId}' is not part of the active script DAG; reuse refused`, { scriptId, jobId, nodeId: job.nodeId });
    }
    const currentDigest = snapshot.nodeStates?.[job.nodeId]?.nodeDigest;
    if (!currentDigest || currentDigest !== job.nodeDigest) {
      throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Job node digest stale for ${job.nodeId}; reuse refused`, { nodeId: job.nodeId, jobId });
    }
    if (policyDigestOf(snapshot) !== job.policyDigest) {
      throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Job policy/binding changed; reuse refused', { jobId });
    }

    // Measured elapsed from the actual clock; the durable deadline is
    // preserved verbatim — resume never resets or decreases it. A backwards
    // clock clamps at zero instead of underflowing.
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const elapsedMs = Math.max(0, nowMs - job.createdAtMs);
    const elapsedSec = Math.max(0, Math.round((elapsedMs / 1000) * 1000) / 1000);
    const exhausted = nowMs > job.deadlineAtMs;
    const pause = exhausted ? 'paused_time_budget' : 'paused_awaiting_authorization';
    const status = exhausted ? 'paused_time_budget' : job.status;
    const history = appendResumeHistory(job.history, { at: nowIso, revision: snapshot.revision, pause, elapsedMs });

    const { digest: _old, ...rest } = job;
    const updated = { ...rest, status, elapsedMs, elapsedSec, history };
    const next = { ...updated, digest: computeCanonicalDigest(updated) };
    atomicWriteJson(file, next);
    return {
      ...next,
      elapsedMs,
      elapsedSec,
      exhausted,
      resumable: true,
      pause,
      authorization: 'authorization_required',
      nextAction: next.nextAction,
    };
  } finally {
    lock.release();
  }
}

// Bounded truthful stage transition for local candidate jobs (execution and
// local-import publish paths). Revision CAS + id binding under the shared
// script lock; digest recomputed; immutable deadline never refreshed here.
// Only status/nextAction/mediaCounts/lastError may change; intent/budget
// bindings are never rewritten by a stage transition.
export async function writeJobUpdate(
  { scriptId, jobId, expectedRevision, status, invocation, nextAction, mediaCounts, lastError } = {},
  { root = getRuntimeRoot() } = {},
) {
  const sid = resolveScriptId({ scriptId });
  if (typeof sid !== 'string' || !SAFE_SCRIPT_ID_RE.test(sid)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] scriptId must be a valid identifier: ${sid}`, { scriptId: sid });
  }
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] jobId must be a full UUID', { jobId: typeof jobId === 'string' ? jobId.slice(0, 64) : jobId });
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] expectedRevision must be a positive integer: ${expectedRevision}`, { expectedRevision });
  }
  if (status !== undefined && !KNOWN_JOB_STATUSES.includes(status)) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown job status: ${status}`, { status });
  }
  if (nextAction !== undefined && (typeof nextAction !== 'string' || !nextAction)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] nextAction must be a non-empty string', {});
  }
  const lockFile = getScriptLockFile(sid, root);
  assertFileContained(lockFile, root, sid);
  const lock = acquireLock(lockFile);
  try {
    const snapshot = getStory(sid, { root });
    if (snapshot.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId: sid, expectedRevision, actualRevision: snapshot.revision });
    }
    const jobsDir = getJobsDir(sid, root);
    const file = jobFileFor(jobsDir, jobId, root, sid);
    if (!fs.existsSync(file)) {
      throw new FlowError('OPERATION_NOT_FOUND', `[OPERATION_NOT_FOUND] Candidate job not found: ${jobId}`, { scriptId: sid, jobId });
    }
    const job = readJobFile(file, { expectedJobId: jobId, scriptId: sid });
    const patch = {};
    if (status !== undefined) patch.status = status;
    if (invocation !== undefined) patch.invocation = invocation;
    if (nextAction !== undefined) patch.nextAction = nextAction;
    if (mediaCounts !== undefined) patch.mediaCounts = mediaCounts;
    if (lastError !== undefined) patch.lastError = lastError;
    const { digest: _old, ...rest } = job;
    void _old;
    const updated = { ...rest, ...patch };
    const next = { ...updated, digest: computeCanonicalDigest(updated) };
    // Full shape revalidation (status enum + optional counts/error) before write.
    assertJobShape(next, file);
    verifyJobChecksum(next, file);
    atomicWriteJson(file, next);
    return { ...next };
  } finally {
    lock.release();
  }
}
