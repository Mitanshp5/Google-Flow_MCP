// W09 candidate execution — trusted loopback fixture orchestration through the
// ACTUAL common image handler. Local fixture execution only: 127.0.0.1 HTTP
// transport + headless fixture page. No live submission, no spend, no network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { withSession } from '../src/browser/session-scope.js';
import { w00ResolveChrome } from './helpers/w00-dom.js';
import { handleToolCall } from '../src/index.js';
import { mintChildApproval, createOperationStore } from '../src/domain/operations.js';
import { digestRequest } from '../src/domain/contracts.js';
import { sha256Hex } from '../src/assets/catalog.js';
import { generateFixtureImage } from './helpers/w09-image-fixtures.js';
import { basePlan, runArgs, w09MkTemp, callTool } from './helpers/w09-candidate-fixture.js';
import { initRuntimeDirs, atomicWriteJson } from '../src/storage/runtime-store.js';
import { getScriptDir, computeCanonicalDigest } from '../src/script/store.js';
import { getJobRecordPath } from '../src/script/candidate-jobs.js';
import { closeLogger } from '../src/utils/logger.js';
import { jobQueue } from '../src/queue/job-queue.js';

const ACCOUNT = 'filmmaker@example.com';
const PROJECT = 'w09_slice_proj';
const MODEL = 'Nano Banana Pro';

function isolateEnv() {
  const saved = {
    FLOW_HOME: process.env.FLOW_HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  const tmpDir = w09MkTemp('w09-exec-');
  process.env.FLOW_HOME = tmpDir;
  process.env.TMPDIR = tmpDir;
  process.env.TEMP = tmpDir;
  process.env.TMP = tmpDir;
  initRuntimeDirs(tmpDir);
  return { saved, tmpDir };
}

async function restoreEnv(saved, tmpDir) {
  await closeLogger();
  for (const k of ['FLOW_HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  // Windows file-locking timing (Playwright/ffmpeg/server handles release
  // asynchronously); retry briefly rather than flaking the suite.
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function composerHtml({ account, project, model, ratio, qty, quoteLabel }) {
  return `<!doctype html><body><span data-account-email="${account}">${account}</span>
<div id="composer" data-account="${account}" data-project="${project}">
<div contenteditable="true" aria-label="Image prompt"></div><div id="chips"></div><div id="slots"></div><div id="uploads"></div>
<button aria-label="Settings trigger" onclick="openPanel()">${model} ${ratio} x${qty}</button>
<button aria-pressed="false">Agent</button><button aria-label="Generate">Generate</button></div>
<div id="gallery"></div>
<div role="dialog" id="panel"><button class="mat-mdc-menu-trigger">${model} arrow_drop_down</button>
<button aria-pressed="true">Image</button><button>Video</button><button aria-pressed="true">${ratio}</button><button aria-pressed="true">x${qty}</button>
<p>${quoteLabel}</p></div>
<script>const panel=document.getElementById('panel');const markup=panel.innerHTML;function openPanel(){panel.innerHTML=markup;panel.style.display='block'}document.addEventListener('keydown',e=>{if(e.key==='Escape'){panel.innerHTML='';panel.style.display='none'}})</script></body>`;
}

// Real loopback HTTP transport: serves the composer page and fixture PNG bytes
// over 127.0.0.1 only. Downloaded bytes travel actual HTTP, never scope JSON.
async function startFixtureServer({ project, composerBody, assets }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === `/project/${project}`) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(composerBody);
      return;
    }
    const m = u.pathname.match(/^\/asset\/([A-Za-z0-9_-]+)$/);
    if (m && assets.has(m[1])) {
      const a = assets.get(m[1]);
      if (a.missing) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      if (a.status) {
        res.writeHead(a.status, { 'content-type': 'text/plain' });
        res.end(a.body ?? 'gone');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(a.bytes);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function handlerPayloadFor(job) {
  return { prompt: job.prompt, model: job.model, ratio: job.ratio, quantity: job.quantity, type: 'image' };
}

describe('W09 execution: dispatcher fixture path publishes operation-correlated candidates', () => {
  let tmpDir;
  let saved;
  let servers;
  let pages;
  let browsers;

  // Playwright roots its dev profile under $TMPDIR, which here is the lane
  // tmp dir itself. Each test therefore launches a dedicated browser AFTER
  // isolation and closes it BEFORE directory removal; otherwise the live
  // browser holds profile locks and cleanup fails with EPERM.
  async function launchFixtureBrowser() {
    const { executablePath } = w00ResolveChrome();
    const browser = await chromium.launch(executablePath
      ? { headless: true, executablePath, args: ['--no-sandbox'] }
      : { headless: true, args: ['--no-sandbox'] });
    browsers.push(browser);
    return browser;
  }

  beforeEach(() => {
    jobQueue.reset();
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
    servers = [];
    pages = [];
    browsers = [];
  });

  afterEach(async () => {
    for (const p of pages) await p.close().catch(() => {});
    for (const b of browsers) await b.close().catch(() => {});
    for (const s of servers) await new Promise((r) => s.close(r)).catch(() => {});
    await restoreEnv(saved, tmpDir);
  });

  it('default run with session candidateTransport executes the real handler and publishes one fixture_transport candidate', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const args = runArgs(scriptId, 1, 'char:elena', nodeDigest, {
      model: MODEL, ratio: '1:1', quantity: 1, candidateLimit: 1,
    });

    // Planned baseline without any transport: no candidates, no invocation.
    const planned = await callTool(handleToolCall, 'flow_script_run', args);
    expect(planned.invocation).toBe('not-invoked');
    expect(planned.candidates).toBe(undefined);

    // Real fixture PNG bytes (square for the 1:1 job ratio).
    const pngPath = path.join(tmpDir, 'v0.png');
    await generateFixtureImage(pngPath, { width: 64, height: 64, format: 'png', color: 'red' });
    const pngBytes = fs.readFileSync(pngPath);
    const assetId = 'w09-asset-v0';
    const assets = new Map([[assetId, { bytes: pngBytes }]]);
    const server = await startFixtureServer({
      project: PROJECT,
      composerBody: composerHtml({ account: ACCOUNT, project: PROJECT, model: MODEL, ratio: '1:1', qty: 1, quoteLabel: 'Generating will use 0 credits total' }),
      assets,
    });
    servers.push(server);
    const port = server.address().port;
    const browser = await launchFixtureBrowser();
    const page = await browser.newPage();
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}/project/${PROJECT}`);
    page.waitForTimeout = async () => {};

    // Single-use child minted explicitly by the local fixture tester for the
    // exact handler request (never by the orchestrator).
    const approvalChild = mintChildApproval({ policyId: 'local-image', maxCredits: 0 }, {
      requestDigest: digestRequest(handlerPayloadFor(planned)),
      accountKey: ACCOUNT, projectId: PROJECT, model: MODEL, quoteTotal: 0,
    });
    const approvals = new Map([[approvalChild.id, approvalChild]]);
    const ledger = { reserved: 0, maxAuthorized: 0 };
    const transport = {
      page,
      origin: 'local-fixture:w09-execution',
      expectedAccount: ACCOUNT,
      intendedProjectId: PROJECT,
      approvals,
      ledger,
      assets: [{ assetId, variantIndex: 0, url: `http://127.0.0.1:${port}/asset/${assetId}` }],
      quota: { remaining: 4 },
    };

    const result = await withSession({ page, candidateTransport: transport }, () =>
      handleToolCall('flow_script_run', args).then((r) => JSON.parse(r.content[0].text)));

    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.candidates).toHaveLength(1);
    const [c] = result.candidates;
    expect(c.candidateId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(c.sourceKind).toBe('fixture_transport');
    expect(c.provenance).toMatch(/synthetic-local-fixture/);
    expect(c.provenance).not.toMatch(/flow-?generated/i);
    expect(c.hash).toBe(sha256Hex(pngBytes));
    expect(c.variantIndex).toBe(0);
    expect(typeof result.operationId).toBe('string');
    expect(c.operationId).toBe(result.operationId);
    expect(result.invocation).toBe('fixture-invoked');
    expect(result.canSpend).toBe(false);
    expect(result.liveVerified).toBe(false);
    expect(fs.existsSync(c.path)).toBe(true);
    expect(path.resolve(c.path).startsWith(path.resolve(tmpDir))).toBe(true);

    // Approvals/ledger flowed through the real common commit path.
    expect(approvalChild.consumed).toBe(true);
    const opStore = createOperationStore(process.env.FLOW_HOME);
    expect(opStore.isChildConsumed(approvalChild.id)).toBe(true);
    expect(opStore.listOperations()).toHaveLength(1);

    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId });
    expect((status.candidates ?? []).map((x) => x.candidateId)).toContain(c.candidateId);
    expect(status.candidateJobs.find(j => j.jobId === result.jobId).invocation).toBe('fixture-invoked');
  }, 90000);
});

// Shared loopback fixture builder for the negative families. Every case runs
// the ACTUAL dispatcher + handler + adapter; only the observed evidence or
// the tester-minted approval differs per case.
const EXEC_COLORS = ['red', 'blue', 'green', 'yellow'];

async function buildExecutionFixture(ctx, opts = {}) {
  const {
    qty = 1,
    ratio = '1:1',
    quoteLabel = 'Generating will use 0 credits total',
    omitQuotePara = false,
    account = ACCOUNT,
    project = PROJECT,
    expectedAccount = account,
    intendedProjectId = project,
    approvalPatch = {},
    approvalCount = 1,
    quota = { remaining: 4 },
    assetModes = null,
    preSeedGallery = '',
    jobOverrides = {},
    transportExtra = undefined,
  } = opts;
  const { tmpDir, servers, pages, launchFixtureBrowser } = ctx;
  const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
  const scriptId = created.scriptId;
  const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
  const args = runArgs(scriptId, 1, 'char:elena', nodeDigest, {
    model: MODEL, ratio, quantity: qty, candidateLimit: qty, ...jobOverrides,
  });
  const planned = await callTool(handleToolCall, 'flow_script_run', args);

  const assetBytes = new Map();
  const served = new Map();
  for (let i = 0; i < qty; i += 1) {
    const mode = assetModes?.[i] ?? 'ok';
    const assetId = `w09-asset-v${i}`;
    if (mode === 'missing') {
      served.set(assetId, { missing: true });
      continue;
    }
    const p = path.join(tmpDir, `v${i}-${mode}.png`);
    if (mode === 'truncated') {
      const full = path.join(tmpDir, `v${i}-full.png`);
      await generateFixtureImage(full, { width: 64, height: 64, format: 'png', color: EXEC_COLORS[i % 4] });
      const bytes = fs.readFileSync(full);
      fs.writeFileSync(p, bytes.slice(0, Math.floor(bytes.length / 2)));
    } else if (mode === 'html') {
      fs.writeFileSync(p, '<html><body>expired session</body></html>');
    } else if (mode === 'dup0') {
      const src = assetBytes.get('w09-asset-v0');
      if (!src) throw new Error('dup0 requires variant 0 bytes first');
      fs.writeFileSync(p, src);
    } else {
      await generateFixtureImage(p, { width: 64, height: 64, format: 'png', color: EXEC_COLORS[i % 4] });
    }
    const bytes = fs.readFileSync(p);
    assetBytes.set(assetId, bytes);
    served.set(assetId, mode === 'expired' ? { status: 410, body: 'expired' } : { bytes });
  }
  const body = composerHtml({ account, project, model: MODEL, ratio, qty, quoteLabel })
    .replace('<div id="gallery"></div>', `<div id="gallery">${preSeedGallery}</div>`)
    .replace(omitQuotePara ? /<p>.*?<\/p>/ : '<!--keep-->', omitQuotePara ? '' : '$&');
  const server = await startFixtureServer({ project, composerBody: body, assets: served });
  servers.push(server);
  const port = server.address().port;
  const browser = await launchFixtureBrowser();
  const page = await browser.newPage();
  pages.push(page);
  await page.goto(`http://127.0.0.1:${port}/project/${project}`);
  page.waitForTimeout = async () => {};

  const approvals = new Map();
  let approvalChild = null;
  for (let k = 0; k < approvalCount; k += 1) {
    const child = mintChildApproval({ policyId: 'local-image', maxCredits: 0 }, {
      requestDigest: digestRequest(handlerPayloadFor(planned)),
      accountKey: ACCOUNT, projectId: PROJECT, model: MODEL, quoteTotal: 0,
      ...approvalPatch,
    });
    approvals.set(child.id, child);
    if (k === 0) approvalChild = child;
  }
  const ledger = { reserved: 0, maxAuthorized: 0, ...(opts.ledgerPatch ?? {}) };
  const transport = {
    page,
    origin: 'local-fixture:w09-execution',
    expectedAccount,
    intendedProjectId,
    approvals,
    ledger,
    assets: Array.from({ length: qty }, (_, i) => ({
      assetId: `w09-asset-v${i}`, variantIndex: i, url: `http://127.0.0.1:${port}/asset/w09-asset-v${i}`,
    })),
    quota,
    ...(transportExtra !== undefined ? transportExtra : {}),
  };
  const runWithTransport = () => withSession({ page, candidateTransport: transport }, () =>
    handleToolCall('flow_script_run', args).then((r) => JSON.parse(r.content[0].text)));
  const opStore = () => createOperationStore(process.env.FLOW_HOME);
  return { scriptId, nodeDigest, args, planned, page, server, port, transport, approvalChild, approvals, ledger, assetBytes, served, runWithTransport, opStore };
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (e) {
    expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected rejection with code ${code} but the call resolved`);
}

describe('W09 execution negatives: quotes and bindings never invoke without zero-only proof', () => {
  let tmpDir;
  let saved;
  let servers;
  let pages;
  let browsers;

  async function launchFixtureBrowser() {
    const { executablePath } = w00ResolveChrome();
    const browser = await chromium.launch(executablePath
      ? { headless: true, executablePath, args: ['--no-sandbox'] }
      : { headless: true, args: ['--no-sandbox'] });
    browsers.push(browser);
    return browser;
  }

  beforeEach(() => {
    jobQueue.reset();
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
    servers = [];
    pages = [];
    browsers = [];
  });

  afterEach(async () => {
    for (const p of pages) await p.close().catch(() => {});
    for (const b of browsers) await b.close().catch(() => {});
    for (const s of servers) await new Promise((r) => s.close(r)).catch(() => {});
    await restoreEnv(saved, tmpDir);
  });

  it('nonzero observed quote with matching nonzero approval is denied before any invocation', async () => {
    const f = await buildExecutionFixture({ tmpDir, servers, pages, browsers, launchFixtureBrowser }, {
      quoteLabel: 'Generating will use 5 credits total',
      approvalPatch: { quoteTotal: 5, maxCredits: 5 },
      ledgerPatch: { maxAuthorized: 5 },
    });
    await expectCode(f.runWithTransport(), 'POLICY_DENIED');
    expect(f.approvalChild.consumed).toBe(false);
    expect(f.ledger.reserved).toBe(0);
    expect(f.opStore().isChildConsumed(f.approvalChild.id)).toBe(false);
    expect(f.opStore().listOperations()).toEqual([]);
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId: f.scriptId });
    expect(status.candidates ?? []).toEqual([]);
  }, 90000);

  it('nonzero approval caps with a zero quote are denied before any invocation', async () => {
    const f = await buildExecutionFixture({ tmpDir, servers, pages, browsers, launchFixtureBrowser }, {
      approvalPatch: { maxCredits: 5 },
      ledgerPatch: { maxAuthorized: 5 },
    });
    await expectCode(f.runWithTransport(), 'POLICY_DENIED');
    expect(f.approvalChild.consumed).toBe(false);
    expect(f.opStore().listOperations()).toEqual([]);
  }, 90000);

  it.each([
    ['wrong expected account', { expectedAccount: 'other@example.com' }],
    ['wrong intended project', { intendedProjectId: 'other-project' }],
    ['wrong approved model', { approvalPatch: { model: 'Other Model' } }],
    ['wrong approved prompt digest', { approvalPatch: { requestDigest: digestRequest({ prompt: 'other', model: MODEL, ratio: '1:1', quantity: 1, type: 'image' }) } }],
    ['nonzero observed quote under zero-only approval', { quoteLabel: 'Generating will use 5 credits total' }],
    ['unreadable quote', { quoteLabel: 'Credits: lots!' }],
    ['missing quote', { omitQuotePara: true }],
    ['expired approval', { approvalPatch: { ttlMs: -1000 } }],
  ])('denies %s before invocation and consumption', async (_name, patch) => {
    const f = await buildExecutionFixture({ tmpDir, servers, pages, browsers, launchFixtureBrowser }, patch);
    await expect(f.runWithTransport()).rejects.toBeTruthy();
    expect(f.approvalChild.consumed).toBe(false);
    expect(f.ledger.reserved).toBe(0);
    expect(f.opStore().listOperations()).toEqual([]);
  }, 90000);
});

describe('W09 execution pauses: observed quota/deadline exhaustion pauses the same intent', () => {
  let tmpDir;
  let saved;
  let servers;
  let pages;
  let browsers;

  async function launchFixtureBrowser() {
    const { executablePath } = w00ResolveChrome();
    const browser = await chromium.launch(executablePath
      ? { headless: true, executablePath, args: ['--no-sandbox'] }
      : { headless: true, args: ['--no-sandbox'] });
    browsers.push(browser);
    return browser;
  }

  beforeEach(() => {
    jobQueue.reset();
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
    servers = [];
    pages = [];
    browsers = [];
  });

  afterEach(async () => {
    for (const p of pages) await p.close().catch(() => {});
    for (const b of browsers) await b.close().catch(() => {});
    for (const s of servers) await new Promise((r) => s.close(r)).catch(() => {});
    await restoreEnv(saved, tmpDir);
  });

  it('expired time budget pauses with the immutable deadline and never invokes', async () => {
    const f = await buildExecutionFixture({ tmpDir, servers, pages, browsers, launchFixtureBrowser }, {
      jobOverrides: { timeBudgetSec: 0.05 },
    });
    await new Promise((r) => setTimeout(r, 150));
    const paused = await f.runWithTransport();
    expect(paused.pause).toBe('paused_time_budget');
    expect(paused.status).toBe('paused_time_budget');
    expect(paused.resumable).toBe(true);
    expect(paused.deadlineAt).toBe(f.planned.deadlineAt);
    expect(paused.deadlineAtMs).toBe(f.planned.deadlineAtMs);
    expect(paused.candidates ?? []).toEqual([]);
    expect(f.approvalChild.consumed).toBe(false);
    expect(f.opStore().listOperations()).toEqual([]);
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId: f.scriptId });
    const jobView = (status.candidateJobs ?? []).find((j) => j.jobId === f.planned.jobId);
    expect(jobView?.status).toBe('paused_time_budget');
    expect(jobView?.deadlineAt).toBe(f.planned.deadlineAt);
  }, 90000);

  it('exhausted observed quota pauses without invoking and without touching approvals', async () => {
    const f = await buildExecutionFixture({ tmpDir, servers, pages, browsers, launchFixtureBrowser }, {
      quota: { remaining: 0 },
    });
    const paused = await f.runWithTransport();
    expect(paused.pause).toBe('paused_quota');
    expect(paused.status).toBe('paused_quota');
    expect(paused.resumable).toBe(true);
    expect(paused.candidates ?? []).toEqual([]);
    expect(f.approvalChild.consumed).toBe(false);
    expect(f.ledger.reserved).toBe(0);
    expect(f.opStore().listOperations()).toEqual([]);
  }, 90000);

  it('MCP caller claims cannot fake quota: run args reject quota-shaped keys', async () => {
    const created = await callTool(handleToolCall, 'flow_script_create', basePlan());
    const scriptId = created.scriptId;
    const nodeDigest = created.nodeStates['char:elena'].nodeDigest;
    const base = runArgs(scriptId, 1, 'char:elena', nodeDigest, { model: MODEL, ratio: '1:1', quantity: 1, candidateLimit: 1 });
    await expectCode(handleToolCall('flow_script_run', { ...base, quota: { remaining: 99 } }), 'INVALID_PARAMS');
    await expectCode(handleToolCall('flow_script_run', { ...base, deadline: Date.now() + 99999 }), 'INVALID_PARAMS');
  }, 60000);
});

describe('W09 execution correlation: exact per-variant linkage, transport honesty, duplicates', () => {
  let tmpDir;
  let saved;
  let servers;
  let pages;
  let browsers;

  async function launchFixtureBrowser() {
    const { executablePath } = w00ResolveChrome();
    const browser = await chromium.launch(executablePath
      ? { headless: true, executablePath, args: ['--no-sandbox'] }
      : { headless: true, args: ['--no-sandbox'] });
    browsers.push(browser);
    return browser;
  }

  function ctx() {
    return { tmpDir, servers, pages, browsers, launchFixtureBrowser };
  }

  beforeEach(() => {
    jobQueue.reset();
    const iso = isolateEnv();
    saved = iso.saved;
    tmpDir = iso.tmpDir;
    servers = [];
    pages = [];
    browsers = [];
  });

  afterEach(async () => {
    for (const p of pages) await p.close().catch(() => {});
    for (const b of browsers) await b.close().catch(() => {});
    for (const s of servers) await new Promise((r) => s.close(r)).catch(() => {});
    await restoreEnv(saved, tmpDir);
  });

  it('missing remote bytes publish only linked variants and mark the job needs_review', async () => {
    const f = await buildExecutionFixture(ctx(), { qty: 2, assetModes: ['ok', 'missing'] });
    const result = await f.runWithTransport();
    expect(result.status).toBe('needs_review');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].variantIndex).toBe(0);
    expect(result.canSpend).toBe(false);
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId: f.scriptId });
    expect(status.candidates ?? []).toHaveLength(1);
  }, 120000);

  it('repeating the same dispatched run returns retained candidates without another invocation', async () => {
    const f = await buildExecutionFixture(ctx());
    const first = await f.runWithTransport();
    const repeated = await f.runWithTransport();
    expect(repeated.candidates.map(c => c.candidateId)).toEqual(first.candidates.map(c => c.candidateId));
    expect(f.opStore().listOperations()).toHaveLength(1);
    expect(f.approvalChild.consumed).toBe(true);
    expect(repeated.canSpend).toBe(false);
  }, 90000);

  it('dispatcher resume recovers expired originals from the same operation without a fresh approval', async () => {
    const f = await buildExecutionFixture(ctx(), { assetModes: ['expired'] });
    const paused = await f.runWithTransport();
    expect(paused.pause).toBe('paused_media');
    const operation = f.opStore().listOperations()[0];
    f.served.set('w09-asset-v0', { bytes: f.assetBytes.get('w09-asset-v0') });
    f.transport.approvals = new Map();
    const resumed = await withSession({ page: f.page, candidateTransport: f.transport }, () =>
      callTool(handleToolCall, 'flow_script_resume', { scriptId: f.scriptId, jobId: f.planned.jobId, expectedRevision: 1 }));
    expect(resumed.status).toBe('media-verified');
    expect(resumed.candidates).toHaveLength(1);
    expect(resumed.candidates[0].operationId).toBe(operation.id);
    expect(resumed.candidates[0].hash).toBe(sha256Hex(f.assetBytes.get('w09-asset-v0')));
    expect(resumed.deadlineAtMs).toBe(f.planned.deadlineAtMs);
    expect(f.opStore().listOperations()).toHaveLength(1);
    expect(f.approvalChild.consumed).toBe(true);
    expect(resumed.canSpend).toBe(false);
  }, 90000);

  it('resume finishes interrupted execution publication without losing a persisted variant', async () => {
    const f = await buildExecutionFixture(ctx(), { qty: 2 });
    const first = await f.runWithTransport();
    const survivors = first.candidates.slice().sort((a, b) => a.variantIndex - b.variantIndex);
    const candidateDir = path.join(getScriptDir(f.scriptId), 'candidates');
    fs.unlinkSync(path.join(candidateDir, 'candidates', `${survivors[1].candidateId}.json`));
    const rewrite = (file, mutate) => {
      const { digest: ignored, ...data } = JSON.parse(fs.readFileSync(file, 'utf8'));
      void ignored; mutate(data);
      atomicWriteJson(file, { ...data, digest: computeCanonicalDigest(data) });
    };
    rewrite(path.join(candidateDir, 'executions', `${f.planned.jobId}.json`), data => { data.attempts[0].status = 'submitted'; });
    rewrite(getJobRecordPath(f.scriptId, f.planned.jobId), data => { data.status = 'collecting-media'; delete data.mediaCounts; });
    f.transport.approvals = new Map();
    const recovered = await withSession({ page: f.page, candidateTransport: f.transport }, () =>
      callTool(handleToolCall, 'flow_script_resume', { scriptId: f.scriptId, jobId: f.planned.jobId, expectedRevision: 1 }));
    expect(recovered.candidates).toHaveLength(2);
    expect(recovered.candidates.find(c => c.variantIndex === 0).candidateId).toBe(survivors[0].candidateId);
    expect(recovered.status).toBe('media-verified');
    expect(f.opStore().listOperations()).toHaveLength(1);
    expect(recovered.deadlineAtMs).toBe(first.deadlineAtMs);
  }, 120000);

  it('a deadline exhausted during download pauses before candidate publication', async () => {
    const f = await buildExecutionFixture(ctx());
    const get = f.page.request.get.bind(f.page.request);
    let clock;
    f.page.request.get = async (...args) => {
      const response = await get(...args);
      clock = vi.spyOn(Date, 'now').mockReturnValue(f.planned.deadlineAtMs + 1);
      return response;
    };
    try {
      const paused = await f.runWithTransport();
      expect(paused.status).toBe('paused_time_budget');
      expect(paused.candidates ?? []).toEqual([]);
      expect(paused.deadlineAtMs).toBe(f.planned.deadlineAtMs);
      expect(f.opStore().listOperations()).toHaveLength(1);
    } finally { clock?.mockRestore(); }
  }, 90000);

  it('stale foreign tiles never block linked variants and are never published', async () => {
    const staleTile = '<img src="http://127.0.0.1:9/stale.png" data-asset-id="stale-x" data-variant-index="0" data-attribution="foreign-op">';
    const f = await buildExecutionFixture(ctx(), { preSeedGallery: staleTile });
    const result = await f.runWithTransport();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].assetId).toBe('w09-asset-v0');
    expect(result.status).toBe('media-verified');
  }, 90000);

  it('non-loopback gallery content fails closed before any fetch', async () => {
    const hostile = '<img src="https://example.com/x.png" data-asset-id="hostile" data-variant-index="0" data-attribution="foreign-op">';
    const f = await buildExecutionFixture(ctx(), { preSeedGallery: hostile });
    // Hostile pre-existing content is refused at baseline time: no submit,
    // no consumption, no operation, no candidates, no outside fetch.
    await expectCode(f.runWithTransport(), 'INVALID_PARAMS');
    const status = await callTool(handleToolCall, 'flow_script_status', { scriptId: f.scriptId });
    expect(status.candidates ?? []).toEqual([]);
    expect(f.approvalChild.consumed).toBe(false);
    expect(f.opStore().listOperations()).toEqual([]);
  }, 90000);

  it('expired locator pauses with retained identity and recovers on resume', async () => {
    const f = await buildExecutionFixture(ctx(), { assetModes: ['expired'] });
    const paused = await f.runWithTransport();
    expect(paused.pause).toBe('paused_media');
    expect(paused.status).toBe('paused_media');
    expect(paused.resumable).toBe(true);
    expect(paused.candidates ?? []).toEqual([]);
    expect(f.approvalChild.consumed).toBe(true);
    expect(f.opStore().listOperations()).toHaveLength(1);
    expect(f.opStore().listOperations()[0].status).toBe('submission_unknown');
  }, 90000);

  it('truncated download pauses with retained identity instead of publishing', async () => {
    const f = await buildExecutionFixture(ctx(), { assetModes: ['truncated'] });
    const paused = await f.runWithTransport();
    expect(paused.pause).toBe('paused_media');
    expect(paused.candidates ?? []).toEqual([]);
    expect(f.opStore().listOperations()).toHaveLength(1);
  }, 90000);

  it('error-body bytes are never candidates; job needs review without spend', async () => {
    const f = await buildExecutionFixture(ctx(), { assetModes: ['html'] });
    const result = await f.runWithTransport();
    expect(result.status).toBe('needs_review');
    expect(result.candidates ?? []).toEqual([]);
    expect(result.canSpend).toBe(false);
  }, 90000);

  it('duplicate original bytes across variants publish distinct candidates with one blob', async () => {
    const f = await buildExecutionFixture(ctx(), { qty: 2, assetModes: ['ok', 'dup0'] });
    const bytes0 = f.assetBytes.get('w09-asset-v0');
    expect(f.assetBytes.get('w09-asset-v1').equals(bytes0)).toBe(true);
    const result = await f.runWithTransport();
    expect(result.candidates).toHaveLength(2);
    const [a, b] = result.candidates.slice().sort((x, y) => x.variantIndex - y.variantIndex);
    expect(a.hash).toBe(b.hash);
    expect(a.candidateId).not.toBe(b.candidateId);
    expect(b.duplicateOf).toBe(a.candidateId);
    expect(a.path).toBe(b.path);
  }, 120000);

  it('out-of-range variant indices in transport fail closed', async () => {
    const f = await buildExecutionFixture(ctx(), {});
    f.transport.assets = [{ assetId: 'w09-asset-v9', variantIndex: 9, url: f.transport.assets[0].url }];
    await expectCode(f.runWithTransport(), 'INVALID_PARAMS');
    expect(f.opStore().listOperations()).toEqual([]);
  }, 90000);

  it('resume args reject execution-shaped keys', async () => {
    const f = await buildExecutionFixture(ctx(), {});
    await expectCode(handleToolCall('flow_script_resume', { scriptId: f.scriptId, jobId: f.planned.jobId, expectedRevision: 1, candidateTransport: {} }), 'INVALID_PARAMS');
  }, 60000);
});
