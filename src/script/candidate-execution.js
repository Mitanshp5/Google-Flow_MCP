// W09 candidate execution — trusted loopback fixture orchestration through the
// ACTUAL common image handler.
//
// Default flow_script_run (no source) with a session-scoped candidateTransport
// runs: bounded durable job -> real handleGenerateImage -> existing withSession
// handlerSubmission observers -> UNMODIFIED executeDurableSubmission / common
// policy / operation store / commit / journal / UI lease -> observed
// operation-correlated ORIGINAL variants -> real loopback download transport ->
// retainImage -> immutable candidate publication -> status/restart/review.
//
// The transport is selected ONLY by AsyncLocalStorage session scope
// (getSessionScope()?.candidateTransport). MCP args/config/env can never
// select it: run/resume schemas reject execution-shaped keys before dispatch.
// The fixture page and every transport URL must be loopback
// (127.0.0.1 / ::1 / localhost); anything else fails closed with no fetch.
// Single-use approval children are minted explicitly by the local fixture
// tester and passed through untouched; this orchestrator never mints,
// consumes (outside the common commit), or refreshes approvals.
// Live/remote invocation stays disabled: production (no scope) remains
// planned/authorization_required with no browser acquisition.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FlowError } from '../utils/errors.js';
import { getRuntimeRoot, atomicWriteJson, readVersionedJson, acquireLock } from '../storage/runtime-store.js';
import { getSessionScope, withSession } from '../browser/session-scope.js';
import { assertUiCurrent, withUiTransaction } from '../browser/ui-transaction.js';
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
import { createCandidateJob, getCandidateJob, resumeCandidateJob, assertAllowedRunKeys, assertJobShape, verifyJobChecksum, getJobRecordPath, writeJobUpdate } from './candidate-jobs.js';
import { getCandidateAssetsDir, listCandidates, writeCandidateRecord } from './candidate-store.js';
import { retainImage } from '../media/candidate-images.js';
import { sha256Hex } from '../assets/catalog.js';
import { handleGenerateImage } from '../tools/generate-image.js';
import { createOperationStore, correlatePollResult } from '../domain/operations.js';
import { digestRequest } from '../domain/contracts.js';
import { extractObservedAccount } from '../browser/app-state.js';
import { extractProjectId } from '../navigation/project-navigator.js';

export const EXECUTION_VERSION = 1;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const TRANSPORT_KEYS = Object.freeze([
  'page', 'origin', 'expectedAccount', 'intendedProjectId',
  'approvals', 'ledger', 'assets', 'quota',
]);

function assertScriptId(scriptId) {
  if (typeof scriptId !== 'string' || !SAFE_SCRIPT_ID_RE.test(scriptId)) {
    throw new FlowError('INVALID_STORY_ID', `[INVALID_STORY_ID] Invalid script ID: ${scriptId}`, { scriptId });
  }
}

export function getCandidateTransport() {
  return getSessionScope()?.candidateTransport ?? null;
}

export function hasCandidateTransport() {
  return !!getCandidateTransport();
}

function assertLoopbackHttp(urlString, what) {
  let u = null;
  try {
    u = new URL(urlString);
  } catch {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] ${what} is not a parseable URL: ${String(urlString).slice(0, 120)}`, { what });
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] ${what} must be loopback http(s) (127.0.0.1/::1/localhost); refusing non-loopback transport`, { what });
  }
  return u;
}

function assertLoopbackPage(page) {
  if (!page || typeof page.url !== 'function' || typeof page.evaluate !== 'function') {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.page must be a live fixture page', {});
  }
  let url = '';
  try {
    url = page.url();
  } catch {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.page URL unreadable; refusing', {});
  }
  assertLoopbackHttp(url, 'candidateTransport.page URL');
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.page is closed; refusing', {});
    }
  } catch (e) {
    if (e instanceof FlowError) throw e;
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.page liveness unreadable; refusing', {});
  }
  return url;
}

// Shape + loopback validation only. No side effects, no consumption, no minting.
function validateTransport(transport) {
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport must be an object', {});
  }
  for (const k of Object.keys(transport)) {
    if (!TRANSPORT_KEYS.includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown candidateTransport field: ${k}`, { field: k });
    }
  }
  if (typeof transport.origin !== 'string' || !transport.origin.startsWith('local-fixture:')) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.origin must start with local-fixture:', { origin: typeof transport.origin === 'string' ? transport.origin.slice(0, 80) : transport.origin });
  }
  assertLoopbackPage(transport.page);
  if (typeof transport.expectedAccount !== 'string' || !transport.expectedAccount.includes('@')) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.expectedAccount must be an explicit account identity', {});
  }
  if (typeof transport.intendedProjectId !== 'string' || !transport.intendedProjectId.trim()) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.intendedProjectId must be explicit', {});
  }
  if (!transport.approvals || typeof transport.approvals !== 'object') {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.approvals registry is required', {});
  }
  if (!transport.ledger || typeof transport.ledger !== 'object') {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.ledger is required', {});
  }
  // Observed quota signal (fixture-observed, never an MCP caller claim):
  // either an explicit exhaustion flag or a finite remaining count.
  if (!transport.quota || typeof transport.quota !== 'object' || Array.isArray(transport.quota)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.quota observed signal is required (remaining count or exhausted flag)', {});
  }
  for (const k of Object.keys(transport.quota)) {
    if (!['remaining', 'exhausted', 'reason'].includes(k)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Unknown candidateTransport.quota field: ${k}`, { field: k });
    }
  }
  if (transport.quota.exhausted !== true && (!Number.isInteger(transport.quota.remaining) || transport.quota.remaining < 0)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.quota.remaining must be an integer >= 0', {});
  }
  if (transport.quota.reason !== undefined && (typeof transport.quota.reason !== 'string' || transport.quota.reason.length > 500)) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.quota.reason must be a string <= 500 chars', {});
  }
  if (!Array.isArray(transport.assets) || transport.assets.length === 0) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.assets must be a non-empty array', {});
  }
  for (const [i, a] of transport.assets.entries()) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateTransport.assets[${i}] must be an object`, { index: i });
    }
    if (typeof a.assetId !== 'string' || !a.assetId.trim()) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateTransport.assets[${i}].assetId must be explicit`, { index: i });
    }
    if (!Number.isInteger(a.variantIndex) || a.variantIndex < 0) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateTransport.assets[${i}].variantIndex must be an integer >= 0`, { index: i });
    }
    if (typeof a.url !== 'string' || !a.url) {
      throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateTransport.assets[${i}].url must be explicit`, { index: i });
    }
    assertLoopbackHttp(a.url, `candidateTransport.assets[${i}].url`);
  }
  return transport;
}

function executionsDir(scriptId, root) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'executions');
  assertDirContained(dir, root, scriptId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  assertDirContained(dir, root, scriptId);
  return dir;
}

function checkpointFileFor(dir, jobId, root, scriptId) {
  const file = path.join(dir, `${jobId}.json`);
  assertFileContained(file, root, scriptId);
  return file;
}

function verifyCheckpointChecksum(data, file) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Execution checkpoint invalid: ${file}`, { file });
  }
  const { digest, ...rest } = data;
  if (typeof digest !== 'string' || !digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Execution checkpoint digest missing: ${file}`, { file });
  }
  if (computeCanonicalDigest(rest) !== digest) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Execution checkpoint digest mismatch: ${file}`, { file });
  }
  return data;
}

export function readExecutionCheckpoint(scriptId, jobId, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const dir = path.join(getScriptDir(scriptId, root), 'candidates', 'executions');
  if (!fs.existsSync(dir)) return null;
  assertDirContained(dir, root, scriptId);
  const file = checkpointFileFor(dir, jobId, root, scriptId);
  if (!fs.existsSync(file)) return null;
  const data = readVersionedJson(file, { supported: [EXECUTION_VERSION] });
  verifyCheckpointChecksum(data, file);
  if (data.jobId !== jobId || data.scriptId !== scriptId) {
    throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Execution checkpoint binding mismatch: ${file}`, { file });
  }
  return data;
}

export function writeCheckpointAtomic(scriptId, checkpoint, { root = getRuntimeRoot() } = {}) {
  const dir = executionsDir(scriptId, root);
  const file = checkpointFileFor(dir, checkpoint.jobId, root, scriptId);
  const { digest: _drop, ...rest } = checkpoint;
  void _drop;
  const withDigest = { ...rest, digest: computeCanonicalDigest(rest) };
  verifyCheckpointChecksum(withDigest, file);
  atomicWriteJson(file, withDigest);
  return { ...withDigest };
}

// Durable attempt-start checkpoint BEFORE any handler invocation (never after
// markInvocationBoundary guessing): survives restart at every later phase.
export function appendExecutionAttempt(scriptId, jobId, attempt, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const existing = readExecutionCheckpoint(scriptId, jobId, { root });
    const attempts = existing ? [...(existing.attempts ?? [])] : [];
    if (attempts.length) {
      throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] This intent already has an execution checkpoint; resume it without another invocation', { jobId });
    }
    attempts.push({ ...attempt });
    const checkpoint = existing ?? { v: EXECUTION_VERSION, id: jobId, jobId, scriptId, attempts: [] };
    checkpoint.attempts = attempts;
    return writeCheckpointAtomic(scriptId, checkpoint, { root });
  } finally {
    lock.release();
  }
}

export function updateExecutionAttempt(scriptId, jobId, attemptNo, patch, { root = getRuntimeRoot() } = {}) {
  assertScriptId(scriptId);
  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    const existing = readExecutionCheckpoint(scriptId, jobId, { root });
    if (!existing) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Missing execution checkpoint for update: ${jobId}`, { jobId });
    }
    const attempts = existing.attempts.map((a) => (a.attempt === attemptNo ? { ...a, ...patch } : a));
    return writeCheckpointAtomic(scriptId, { ...existing, attempts }, { root });
  } finally {
    lock.release();
  }
}

function downloadDirFor(root) {
  const dir = path.join(path.resolve(root), 'tmp-downloads');
  return dir;
}

// Main entry: default run (no source) with session candidateTransport.
// Production without scope never reaches here (planned intent preserved).
export async function runExecution(input = {}, { root = getRuntimeRoot() } = {}) {
  // Execution-shaped MCP keys can never select or steer the fixture path:
  // only session scope selects it, and unknown keys fail here first.
  assertAllowedRunKeys(input, 'flow_script_run');
  const transport = validateTransport(getCandidateTransport());
  const { scriptId, expectedRevision } = input;
  assertScriptId(scriptId);

  // Bounded durable job first (idempotent handle, finite budget, revision CAS).
  const job = await createCandidateJob(input, { root });
  if (readExecutionCheckpoint(scriptId, job.jobId, { root })) {
    return resumeExecution({ scriptId, jobId: job.jobId, expectedRevision }, { root });
  }

  // The whole fixture interaction runs inside one top-level UI transaction:
  // a fresh epoch starts clean even after a prior reset/abort, the nested
  // image handler joins it, and any later reset/abort fences every subsequent
  // consequential step (observe/download/publish) via assertUiCurrent.
  return withUiTransaction(async ({ epoch }) => {
    return runExecutionInTransaction({ transport, job, input, root, epoch });
  });
}

async function runExecutionInTransaction({ transport, job, input, root, epoch }) {
  const { scriptId, expectedRevision } = input;

  // Single registered child, passed through untouched (never minted here).
  const entries = typeof transport.approvals?.entries === 'function'
    ? [...transport.approvals.entries()]
    : Object.entries(transport.approvals ?? {});
  if (entries.length !== 1) {
    throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.approvals must register exactly one single-use child for this attempt', { count: entries.length });
  }
  const approvalChild = entries[0][1];

  // W09 zero-only bound policy, merged at this trusted layer (the common
  // policy itself has no zero-only rule: it only caps paid quotes). Local
  // execution submits solely on an explicit zero quote with a zero-capped
  // registered child; nonzero caps never invoke and never consume.
  if (approvalChild?.maxCredits !== 0 || approvalChild?.quoteTotal !== 0) {
    throw new FlowError('POLICY_DENIED', '[POLICY_DENIED] W09 local execution requires a zero-only approval (maxCredits 0 and quoteTotal 0); nonzero caps never invoke', {
      maxCredits: approvalChild?.maxCredits ?? null,
      quoteTotal: approvalChild?.quoteTotal ?? null,
    });
  }

  // Persistent quota/time exhaustion pauses the SAME intent and deadline:
  // no invocation, no consumption, resumable. The quota signal is the
  // fixture-observed transport signal, never an MCP caller claim.
  const preMs = Date.now();
  if (preMs > job.deadlineAtMs) {
    const paused = await writeJobUpdate({
      scriptId, jobId: job.jobId, expectedRevision,
      status: 'paused_time_budget',
      nextAction: 'paused_time_budget: observed deadline exhausted before invocation; same intent and immutable deadline retained, no invocation occurred.',
    }, { root });
    const elapsedMs = Math.max(0, preMs - job.createdAtMs);
    return {
      ...paused, exhausted: true, resumable: true, pause: 'paused_time_budget',
      elapsedMs, elapsedSec: Math.max(0, Math.round((elapsedMs / 1000) * 1000) / 1000),
      candidates: [], canSpend: false, liveVerified: false,
    };
  }
  if (transport.quota.exhausted === true || transport.quota.remaining < job.quantity) {
    const paused = await writeJobUpdate({
      scriptId, jobId: job.jobId, expectedRevision,
      status: 'paused_quota',
      nextAction: 'paused_quota: observed local quota exhausted before invocation; same intent and deadline retained, no invocation occurred.',
    }, { root });
    const elapsedMs = Math.max(0, preMs - job.createdAtMs);
    return {
      ...paused, exhausted: transport.quota.exhausted === true, resumable: true, pause: 'paused_quota',
      elapsedMs, elapsedSec: Math.max(0, Math.round((elapsedMs / 1000) * 1000) / 1000),
      candidates: [], canSpend: false, liveVerified: false,
    };
  }

  const handlerPayload = { prompt: job.prompt, model: job.model, ratio: job.ratio, quantity: job.quantity, type: 'image' };
  const handlerRequestDigest = digestRequest(handlerPayload);

  // Transport asset coherence (before any invocation): variant indices must
  // be unique and addressable by this job (partial batches explicitly
  // allowed: fewer assets than quantity publish only linked variants).
  {
    const seen = new Set();
    for (const a of transport.assets) {
      if (seen.has(a.variantIndex)) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateTransport.assets has a duplicate variantIndex ${a.variantIndex}; refusing ambiguous batch`, { variantIndex: a.variantIndex });
      }
      seen.add(a.variantIndex);
      if (a.variantIndex >= job.quantity) {
        throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] candidateTransport.assets variantIndex ${a.variantIndex} is outside job quantity ${job.quantity}; refusing`, { variantIndex: a.variantIndex, quantity: job.quantity });
      }
    }
  }
  // Pre-existing non-loopback content fails here (before any submit,
  // consumption, or fetch) — never fetched, never published.
  assertUiCurrent(epoch);
  const baselineTiles = await transport.page.evaluate(() => [...document.querySelectorAll('#gallery img[data-asset-id]')].map((el) => ({
    assetId: el.getAttribute('data-asset-id'),
    url: el.currentSrc || el.src || '',
  })));
  for (const t of baselineTiles) {
    if (t.url) assertLoopbackHttp(t.url, `pre-existing gallery tile ${t.assetId}`);
  }
  const baselineIds = [...new Set(baselineTiles.map((t) => t.assetId).filter(Boolean))];
  const baseline = { ids: baselineIds, observedAt: Date.now(), origin: `${transport.origin}:gallery-baseline` };

  // Attempt-start checkpoint BEFORE handler invocation.
  const prior = readExecutionCheckpoint(scriptId, job.jobId, { root });
  const attemptNo = (prior?.attempts?.length ?? 0) + 1;
  appendExecutionAttempt(scriptId, job.jobId, {
    attempt: attemptNo,
    handlerRequestDigest,
    baseline,
    operationId: null,
    operationNonce: null,
    status: 'invoked',
    assetMap: [],
    submitCount: 0,
    error: null,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  }, { root });

  // Compose the handlerSubmission the real image handler expects. The trusted
  // tester registry/ledger/identities flow through untouched; submit observes
  // operation-correlated originals and returns labelled observations.
  const opStore = createOperationStore(path.resolve(root));
  const composedSubmit = async ({ operationId, epoch: handlerEpoch }) => {
    assertUiCurrent(handlerEpoch);
    const op = opStore.getOperation(operationId);
    updateExecutionAttempt(scriptId, job.jobId, attemptNo, {
      operationId: op.id, operationNonce: op.nonce ?? null,
    }, { root });
    await writeJobUpdate({
      scriptId, jobId: job.jobId, expectedRevision,
      status: 'collecting-media', invocation: 'fixture-invoked',
      nextAction: 'collecting-media: local fixture invocation crossed the common boundary; reconcile this operation, never resubmit automatically.',
    }, { root });
    const tiles = transport.assets.map((a) => ({ assetId: a.assetId, variantIndex: a.variantIndex, url: a.url }));
    await transport.page.evaluate(({ tiles: t, attribution }) => {
      const g = document.getElementById('gallery');
      if (!g) throw new Error('fixture gallery missing');
      for (const tile of t) {
        const img = document.createElement('img');
        img.src = tile.url;
        img.setAttribute('data-asset-id', tile.assetId);
        img.setAttribute('data-variant-index', String(tile.variantIndex));
        img.setAttribute('data-attribution', attribution);
        g.appendChild(img);
      }
    }, { tiles, attribution: op.id });
    const observedAt = Date.now();
    const observations = tiles.map((t) => ({ ...t, observedAt, type: 'image', attribution: op.id }));
    updateExecutionAttempt(scriptId, job.jobId, attemptNo, {
      operationId: op.id,
      operationNonce: op.nonce ?? null,
      status: 'submitted',
      submitCount: 1,
      assetMap: observations.map((o) => ({ variantIndex: o.variantIndex, assetId: o.assetId, locator: o.url, downloadStatus: 'pending' })),
    }, { root });
    assertUiCurrent(handlerEpoch);
    return { observations };
  };

  const handlerSubmission = {
    page: transport.page,
    expectedAccount: transport.expectedAccount,
    intendedProjectId: transport.intendedProjectId,
    approvalChild,
    approvals: transport.approvals,
    ledger: transport.ledger,
    opStore,
    origin: transport.origin,
    submit: composedSubmit,
  };

  let handlerResult;
  try {
    assertUiCurrent(epoch);
    const outer = getSessionScope() ?? {};
    if (outer.page && outer.page !== transport.page) {
      throw new FlowError('INVALID_PARAMS', '[INVALID_PARAMS] candidateTransport.page differs from scoped page; refusing ambiguous actor', {});
    }
    handlerResult = await withSession(
      { ...outer, page: transport.page, handlerSubmission },
      () => handleGenerateImage({
        prompt: job.prompt,
        model: job.model,
        ratio: job.ratio,
        quantity: job.quantity,
        auto_confirm: true,
      }),
    );
  } catch (e) {
    // Unknown invocation: retain uncertainty, never resubmit here. Adopt the
    // operation when the durable store proves one was created for our digest.
    const ops = opStore.listOperations().filter((o) => o.requestDigest === handlerRequestDigest && o.approvalChildId === approvalChild.id);
    const adopted = ops.length > 0 ? ops[ops.length - 1] : null;
    updateExecutionAttempt(scriptId, job.jobId, attemptNo, {
      operationId: adopted ? adopted.id : null,
      operationNonce: adopted ? (adopted.nonce ?? null) : null,
      status: 'unknown',
      error: { code: e?.code ?? 'ERROR', message: String(e?.message ?? e).slice(0, 500) },
    }, { root });
    throw e;
  }

  const { operationId } = handlerResult;
  return collectExecutionCandidates({ transport, job, input, root, epoch, operationId, baseline, attemptNo, handlerRequestDigest });
}

async function collectExecutionCandidates({ transport, job, input, root, epoch, operationId, baseline, attemptNo, handlerRequestDigest }) {
  const { scriptId, expectedRevision } = input;
  const opStore = createOperationStore(path.resolve(root));
  const op = opStore.getOperation(operationId);

  // Per-variant correlation + loopback download + retention (slow collection;
  // fence the actor before every consequential step, publish under lock later).
  // Failure classes are disjoint and truthful:
  // - content skip (unlinked/error-body/kind/multi-frame/dimensions): the
  //   variant yields no candidate; linked siblings still publish (needs_review).
  // - transport pause (expired/incomplete/probe-decode/timeout/mutated):
  //   batch aborts with progress checkpointed; job paused_media for resume.
  // - store conflict / fence / system errors: thrown (fail closed, no publish).
  const CONTENT_SKIP_CODES = new Set([
    'MEDIA_HTML_REJECTED', 'MEDIA_UNRECOGNIZED', 'MEDIA_KIND_MISMATCH',
    'MEDIA_MULTI_FRAME', 'MEDIA_DIMENSIONS_TOO_SMALL', 'MEDIA_ASPECT_MISMATCH',
    'MEDIA_TOO_LARGE', 'MEDIA_EMPTY',
  ]);
  const PAUSE_TRANSPORT_CODES = new Set([
    'DOWNLOAD_NOT_OK', 'DOWNLOAD_FAILED', 'DOWNLOAD_EXPIRED',
    'MEDIA_PROBE_FAILED', 'MEDIA_DECODE_FAILED', 'MEDIA_TIMEOUT', 'MEDIA_SOURCE_MUTATED',
  ]);
  const observed = (await transport.page.evaluate(() => [...document.querySelectorAll('#gallery img[data-asset-id]')].map((el) => ({
    assetId: el.getAttribute('data-asset-id'),
    variantIndex: Number(el.getAttribute('data-variant-index')),
    url: el.currentSrc || el.src || '',
    attribution: el.getAttribute('data-attribution'),
    observedAt: Date.now(),
    type: 'image',
  })))).map((o) => ({ ...o, id: o.assetId }));
  for (const o of observed) assertLoopbackHttp(o.url || 'http://127.0.0.1/', `observed tile ${o.assetId}`);

  const recordProgress = (assetMap) => {
    const byVariant = new Map();
    for (const entry of assetMap) byVariant.set(entry.variantIndex, { ...byVariant.get(entry.variantIndex), ...entry });
    return updateExecutionAttempt(scriptId, job.jobId, attemptNo, { assetMap: [...byVariant.values()] }, { root });
  };
  const currentMap = () => (readExecutionCheckpoint(scriptId, job.jobId, { root })?.attempts ?? []).find((a) => a.attempt === attemptNo)?.assetMap ?? [];
  const pauseTime = async () => {
    const paused = await writeJobUpdate({
      scriptId, jobId: job.jobId, expectedRevision, status: 'paused_time_budget',
      nextAction: 'paused_time_budget: immutable deadline exhausted during collection; preserve this operation and never resubmit automatically.',
    }, { root });
    return { ...paused, pause: 'paused_time_budget', exhausted: true, resumable: true,
      candidates: listCandidates(scriptId, { root, jobId: job.jobId }), operationId, canSpend: false, liveVerified: false };
  };
  const published = [];
  const failures = [];
  let pausedFailure = null;
  for (let variantIndex = 0; variantIndex < job.quantity && !pausedFailure; variantIndex += 1) {
    assertUiCurrent(epoch);
    if (Date.now() > job.deadlineAtMs) return pauseTime();
    const obs = observed.filter((o) => o.variantIndex === variantIndex);
    const correlation = correlatePollResult({ operation: op, baseline, expectedType: 'image', candidates: obs });
    if (correlation.verdict !== 'linked') {
      failures.push({ variantIndex, reason: 'correlation-unlinked', details: correlation.reasons ?? [] });
      recordProgress([...currentMap(), { variantIndex, assetId: obs[0]?.assetId ?? null, locator: null, downloadStatus: 'skipped', reason: 'correlation-unlinked' }]);
      continue;
    }
    const asset = correlation.asset;
    const locator = transport.assets.find((a) => a.assetId === asset.id)?.url ?? asset.url;
    assertLoopbackHttp(locator, `variant ${variantIndex} locator`);
    const markFailed = (code, message, downloadStatus) => {
      failures.push({ variantIndex, reason: code.toLowerCase().replace(/_/g, '-'), details: [message] });
      recordProgress([...currentMap(), { variantIndex, assetId: asset.id, locator, downloadStatus, reason: message }]);
    };
    let bytes;
    try {
      const res = await transport.page.request.get(locator, { timeout: 30000 });
      if (!res.ok()) {
        if (res.status() === 404) {
          markFailed('DOWNLOAD_MISSING', 'locator returned 404; no original bytes observed', 'skipped');
          continue;
        }
        const code = res.status() === 410 ? 'DOWNLOAD_EXPIRED' : 'DOWNLOAD_NOT_OK';
        markFailed(code, `locator returned ${res.status()}`, 'expired');
        pausedFailure = { code, message: `variant ${variantIndex} locator returned ${res.status()}; pausing with identity retained for safe recovery` };
        break;
      }
      bytes = await res.body();
    } catch (e) {
      markFailed('DOWNLOAD_FAILED', String(e?.message ?? e).slice(0, 200), 'failed');
      pausedFailure = { code: 'DOWNLOAD_FAILED', message: `variant ${variantIndex} download failed; pausing with identity retained for safe recovery` };
      break;
    }
    if (Date.now() > job.deadlineAtMs) return pauseTime();
    const tmpDir = downloadDirFor(root);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${job.jobId}-v${variantIndex}.bin`);
    fs.writeFileSync(tmpFile, bytes);
    const assetsDir = getCandidateAssetsDir(scriptId, root);
    let ret;
    try {
      ret = await retainImage(tmpFile, { assetsDir, root, expectedRatio: job.ratio });
    } catch (e) {
      if (e?.code && CONTENT_SKIP_CODES.has(e.code)) {
        markFailed(e.code, String(e?.message ?? e).slice(0, 200), 'skipped');
        continue;
      }
      if (e?.code && PAUSE_TRANSPORT_CODES.has(e.code)) {
        markFailed(e.code, String(e?.message ?? e).slice(0, 200), 'incomplete');
        pausedFailure = { code: e.code, message: `variant ${variantIndex} retained bytes failed verification (${e.code}); pausing with identity retained for safe recovery` };
        break;
      }
      recordProgress([...currentMap(), { variantIndex, assetId: asset.id, locator, downloadStatus: 'failed', reason: String(e?.message ?? e).slice(0, 200) }]);
      throw e;
    } finally {
      try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    }
    published.push({ variantIndex, asset, ret, sourceBytes: bytes });
    recordProgress([...currentMap(), {
      variantIndex, assetId: asset.assetId, locator,
      downloadStatus: 'downloaded', retainedPath: ret.path, retainedHash: ret.hash,
    }]);
  }

  if (pausedFailure) {
    const paused = await writeJobUpdate({
      scriptId, jobId: job.jobId, expectedRevision,
      status: 'paused_media',
      nextAction: 'paused_media: local transport interrupted; locator identities retained, resume restores pending downloads of the same operation without resubmitting.',
      lastError: { code: pausedFailure.code, message: pausedFailure.message.slice(0, 500), at: new Date().toISOString() },
    }, { root });
    return { ...paused, pause: 'paused_media', resumable: true, exhausted: false, candidates: [], canSpend: false, liveVerified: false, failures };
  }

  if (published.length === 0) {
    const updated = await writeJobUpdate({
      scriptId, jobId: job.jobId, expectedRevision,
      status: 'needs_review',
      nextAction: 'needs_review: no operation-correlated original observed; inspect reasons without resubmitting.',
      mediaCounts: { candidates: 0, duplicates: 0, bytes: 0 },
      lastError: failures[0] ? { code: 'CORRELATION_UNLINKED', message: JSON.stringify(failures[0]).slice(0, 500), at: new Date().toISOString() } : null,
    }, { root });
    return { ...updated, candidates: [], operationId, canSpend: false, liveVerified: false, failures };
  }

  // Publish under the shared script lock with full revalidation.
  if (Date.now() > job.deadlineAtMs) return pauseTime();
  const lockFile = getScriptLockFile(scriptId, root);
  assertFileContained(lockFile, root, scriptId);
  const lock = acquireLock(lockFile);
  try {
    assertUiCurrent(epoch);
    const snapshot = getStory(scriptId, { root });
    if (snapshot.revision !== expectedRevision) {
      throw new FlowError('STORAGE_CONFLICT', `[STORAGE_CONFLICT] Revision mismatch on execution publish: expected ${expectedRevision}, current is ${snapshot.revision}`, { scriptId });
    }
    let dag;
    try {
      dag = buildStoryDag(snapshot);
    } catch (e) {
      throw new FlowError('STORAGE_CORRUPT', `[STORAGE_CORRUPT] Script DAG unreadable for ${scriptId}: ${e.message}`, { scriptId });
    }
    if (!dag.nodes.has(job.nodeId)) {
      throw new FlowError('NODE_NOT_FOUND', `[NODE_NOT_FOUND] Job node '${job.nodeId}' left the active DAG; publish refused`, { nodeId: job.nodeId });
    }
    const curDigest = snapshot.nodeStates?.[job.nodeId]?.nodeDigest;
    if (!curDigest || curDigest !== job.nodeDigest) {
      throw new FlowError('REVIEW_DIGEST_MISMATCH', `[REVIEW_DIGEST_MISMATCH] Job node digest stale; publish refused`, { nodeId: job.nodeId });
    }
    const freshOp = opStore.getOperation(operationId);
    if (freshOp.status !== 'submission_unknown' && freshOp.status !== 'submitted') {
      throw new FlowError('OPERATION_DENIED', `[OPERATION_DENIED] Operation no longer pending publication: ${freshOp.status}`, { operationId });
    }
    const existing = listCandidates(scriptId, { root, jobId: job.jobId });
    const existingByVariant = new Map();
    for (const candidate of existing) {
      if (existingByVariant.has(candidate.variantIndex)) {
        throw new FlowError('STORAGE_CORRUPT', '[STORAGE_CORRUPT] Duplicate persisted execution variant', { jobId: job.jobId });
      }
      existingByVariant.set(candidate.variantIndex, candidate);
    }
    const allForScript = listCandidates(scriptId, { root });
    const hashToFirst = new Map();
    for (const c of allForScript) {
      const h = c.hash.toLowerCase();
      if (!hashToFirst.has(h)) hashToFirst.set(h, c.candidateId);
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const created = [];
    for (const p of published) {
      const retained = existingByVariant.get(p.variantIndex);
      if (retained) {
        if (retained.hash !== p.ret.hash || retained.operationId !== operationId || retained.assetId !== p.asset.assetId) {
          throw new FlowError('STORAGE_CONFLICT', '[STORAGE_CONFLICT] Persisted variant does not bind this original and operation', { candidateId: retained.candidateId });
        }
        created.push(retained);
        continue;
      }
      const hLower = p.ret.hash.toLowerCase();
      const duplicateOf = hashToFirst.get(hLower) ?? null;
      const candidateId = crypto.randomUUID();
      const importHash = sha256Hex(fs.readFileSync(p.ret.path));
      const record = {
        v: 1,
        id: candidateId,
        candidateId,
        scriptId,
        jobId: job.jobId,
        scriptRevision: snapshot.revision,
        scriptRevisionId: snapshot.revisionId,
        scriptDigest: snapshot.digest,
        nodeId: job.nodeId,
        nodeDigest: job.nodeDigest,
        prompt: job.prompt,
        promptDigest: job.promptDigest,
        binding: job.binding,
        policyDigest: job.policyDigest,
        decisionScope: job.decisionScope,
        model: job.model,
        ratio: job.ratio,
        variantIndex: p.variantIndex,
        sourceKind: 'fixture_transport',
        provenance: 'synthetic-local-fixture',
        rights: 'synthetic',
        path: p.ret.path,
        hash: p.ret.hash,
        sourceHash: sha256Hex(p.sourceBytes),
        exportHash: null,
        importHash,
        observedRatio: p.ret.probe?.ratio ?? p.ret.probe?.width / p.ret.probe?.height ?? null,
        size: p.ret.size,
        mime: p.ret.mime,
        ext: p.ret.ext,
        width: p.ret.probe.width,
        height: p.ret.probe.height,
        duplicateOf,
        operationId,
        operationNonce: op.nonce ?? null,
        requestDigest: op.requestDigest ?? handlerRequestDigest,
        assetId: p.asset.assetId,
        attribution: p.asset.attribution ?? null,
        accountKey: snapshot.binding.accountKey,
        projectId: snapshot.binding.projectId,
        createdAt: nowIso,
        createdAtMs: nowMs,
      };
      const persisted = writeCandidateRecord(scriptId, record, { root });
      created.push(persisted);
      if (!hashToFirst.has(hLower)) hashToFirst.set(hLower, persisted.candidateId);
    }
    // Lock-free inner writes: this block already holds the script lock (locks
    // are not reentrant), so the lock-taking checkpoint/job helpers must not
    // be called here. Same read-modify-write, same digest, same atomic write.
    const cpNow = readExecutionCheckpoint(scriptId, job.jobId, { root });
    const cpAttempts = (cpNow?.attempts ?? []).map((a) => (a.attempt === attemptNo ? { ...a, status: 'published' } : a));
    writeCheckpointAtomic(scriptId, { ...(cpNow ?? { v: EXECUTION_VERSION, id: job.jobId, jobId: job.jobId, scriptId }), attempts: cpAttempts }, { root });
    const jobFile = getJobRecordPath(scriptId, job.jobId, { root });
    const currentJob = getCandidateJob(scriptId, job.jobId, { root });
    const { digest: _jd, ...jobRest } = currentJob;
    void _jd;
    const transitionPatch = failures.length > 0
      ? {
          status: 'needs_review',
          nextAction: 'needs_review: partial operation-correlated originals published; inspect variant reasons without resubmitting.',
          mediaCounts: { candidates: created.length, duplicates: created.filter((c) => c.duplicateOf).length, bytes: created.reduce((s, c) => s + c.size, 0) },
          lastError: { code: 'VARIANT_PARTIAL', message: JSON.stringify(failures).slice(0, 500), at: nowIso },
        }
      : {
          status: 'media-verified',
          nextAction: 'awaiting_client_review: score candidates via flow_script_review action score_candidate, then select_reference.',
          mediaCounts: { candidates: created.length, duplicates: created.filter((c) => c.duplicateOf).length, bytes: created.reduce((s, c) => s + c.size, 0) },
        };
    const transitioned = { ...jobRest, ...transitionPatch, digest: computeCanonicalDigest({ ...jobRest, ...transitionPatch }) };
    assertJobShape(transitioned, jobFile);
    verifyJobChecksum(transitioned, jobFile);
    atomicWriteJson(jobFile, transitioned);
    return { ...transitioned, candidates: created, operationId, canSpend: false, liveVerified: false, failures };
  } finally {
    lock.release();
  }
}

// Resume reuses the durable operation, never the submit handler or approval.
// Only an intent with no execution checkpoint may make its first invocation.
export async function resumeExecution(input = {}, { root = getRuntimeRoot() } = {}) {
  const job = await resumeCandidateJob(input, { root });
  const { scriptId, jobId } = job;
  const checkpoint = readExecutionCheckpoint(scriptId, jobId, { root });
  const candidates = listCandidates(scriptId, { root, jobId });
  for (const candidate of candidates) {
    assertFileContained(candidate.path, root, scriptId);
    if (!fs.existsSync(candidate.path) || sha256Hex(fs.readFileSync(candidate.path)) !== candidate.hash) {
      throw new FlowError('MEDIA_HASH_MISMATCH', '[MEDIA_HASH_MISMATCH] Retained candidate changed; recovery cannot reuse it', { candidateId: candidate.candidateId });
    }
  }
  const result = { ...job, candidates, canSpend: false, liveVerified: false };
  const attempt = checkpoint?.attempts?.at(-1);
  if (attempt?.status === 'published') return result;
  if (job.pause === 'paused_time_budget') return result;
  const transport = validateTransport(getCandidateTransport());
  return withUiTransaction(async ({ epoch }) => {
    assertUiCurrent(epoch);
    if (!attempt) return runExecutionInTransaction({ transport, job, input, root, epoch });
    if (!attempt.operationId) {
      const updated = await writeJobUpdate({
        scriptId, jobId, expectedRevision: input.expectedRevision,
        status: 'needs_review', nextAction: 'needs_review: unresolved execution checkpoint; inspect durable evidence, never resubmit automatically.',
      }, { root });
      return { ...updated, candidates, unknownOutcome: true, canSpend: false, liveVerified: false };
    }
    const op = createOperationStore(path.resolve(root)).getOperation(attempt.operationId);
    const requestDigest = digestRequest({ prompt: job.prompt, model: job.model, ratio: job.ratio, quantity: job.quantity, type: 'image' });
    const observedAccount = extractObservedAccount(await transport.page.content());
    const observedProject = extractProjectId(transport.page.url());
    assertUiCurrent(epoch);
    if (op.nonce !== attempt.operationNonce || op.requestDigest !== requestDigest ||
        attempt.handlerRequestDigest !== requestDigest || !attempt.baseline ||
        observedAccount !== job.binding.accountKey || observedProject !== job.binding.projectId ||
        transport.expectedAccount !== job.binding.accountKey || transport.intendedProjectId !== job.binding.projectId ||
        op.accountRef !== job.binding.accountKey || op.projectRef !== job.binding.projectId) {
      throw new FlowError('POLICY_DENIED', '[POLICY_DENIED] Recovery identity does not bind the existing job and operation', { jobId });
    }
    return collectExecutionCandidates({
      transport, job, input, root, epoch, operationId: op.id,
      baseline: attempt.baseline, attemptNo: attempt.attempt, handlerRequestDigest: requestDigest,
    });
  });
}
