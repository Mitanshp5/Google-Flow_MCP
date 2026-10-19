/**
 * W00 slice w00-import-dispatch: safe import lifecycle + real handleToolCall
 * scoped-fixture dispatch + registry/schema parity over ACTUAL objects.
 *
 * No source-text regex as acceptance. No live CDP, no navigation to Flow,
 * no Generate/Accept/spend. Fixture pages use local setContent only.
 * Browser tests carry explicit 30s timeouts (headless Chrome launch +
 * screenshot are genuine timing requirements).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  TOOL_DEFINITIONS, handleToolCall, startServer,
} from '../src/index.js';
import { schemas } from '../src/utils/validate.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { isBrowserConnected, getPage } from '../src/browser/connect.js';
import { withPage } from '../src/browser/session-scope.js';
import { FlowError } from '../src/utils/errors.js';
import {
  w00LoadFixture, w00CloseBrowser, w00ResolveChrome,
} from './helpers/w00-dom.js';

// ---- test-only FLOW_HOME isolation (screenshots/metadata stay in temp) ----
const W00_FLOW_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w00-flow-')), 'home');
const SAVED_FLOW_HOME = process.env.FLOW_HOME;
process.env.FLOW_HOME = W00_FLOW_HOME;

afterAll(async () => {
  await w00CloseBrowser().catch(() => {});
  if (SAVED_FLOW_HOME === undefined) delete process.env.FLOW_HOME;
  else process.env.FLOW_HOME = SAVED_FLOW_HOME;
  fs.rmSync(W00_FLOW_HOME, { recursive: true, force: true });
}, 30000);

function parsed(result) {
  return JSON.parse(result.content[0].text);
}

async function expectFlowError(promise, code) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(FlowError);
    expect(e.code).toBe(code);
    return;
  }
  throw new Error(`expected FlowError ${code}, dispatch succeeded`);
}

describe('w00 import lifecycle uses actual exports', () => {
  it('exposes registry + dispatch + explicit startServer', () => {
    expect(typeof startServer).toBe('function');
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      'flow_account_check', 'flow_connect', 'flow_create_character',
      'flow_create_project', 'flow_create_scene', 'flow_discover_ui', 'flow_disconnect',
      'flow_download_latest', 'flow_generate_confirm', 'flow_generate_image', 'flow_generate_video',
      'flow_import_character', 'flow_list_browser_targets', 'flow_list_mention_options', 'flow_list_models',
      'flow_export_reel',
      'flow_list_projects', 'flow_open', 'flow_open_characters', 'flow_open_tools_gallery',
      'flow_queue_reset', 'flow_queue_status', 'flow_rename_character', 'flow_rename_image', 'flow_screenshot',
      'flow_script_create', 'flow_script_review', 'flow_script_status',
      'flow_script_run', 'flow_script_resume',
      'flow_script_update', 'flow_status', 'flow_use_grid_architect',
      'flow_use_tool',
    ].sort());
    expect(typeof handleToolCall).toBe('function');
  });

  it('import registered no process shutdown handlers', () => {
    expect(process.listenerCount('SIGINT')).toBe(0);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('w00 real dispatch while disconnected (no live browser)', () => {
  beforeEach(() => {
    expect(isBrowserConnected()).toBe(false);
    jobQueue.reset();
  });

  it.each([
    ['flow_connect', { headless: 'yes' }],
    ['flow_open', { waitFor: 'x' }],
    ['flow_discover_ui', { page: '' }],
    ['flow_generate_image', {}],
    ['flow_generate_video', {}],
    ['flow_create_character', {}],
    ['flow_import_character', {}],
    ['flow_open_characters', { project_name: 123 }],
    ['flow_list_mention_options', { campaign: {} }],
    ['flow_create_scene', {}],
    ['flow_use_grid_architect', {}],
    ['flow_use_tool', {}],
    ['flow_screenshot', { name: '' }],
    ['flow_queue_status', { history_limit: 0 }],
    ['flow_generate_confirm', {}],
    ['flow_rename_character', {}],
  ])('%s rejects invalid args with INVALID_PARAMS (never launches/touches browser)', async (name, args) => {
    await expectFlowError(handleToolCall(name, args), 'INVALID_PARAMS');
  });

  it.each([
    ['flow_open', { url: 'https://flow.google.com/' }],
    ['flow_account_check', {}],
    ['flow_discover_ui', {}],
    ['flow_generate_image', { prompt: 'w00 probe' }],
    ['flow_generate_video', { prompt: 'w00 probe' }],
    ['flow_download_latest', {}],
    ['flow_create_character', { name: 'n', description: 'd' }],
    ['flow_import_character', { file_path: 'x.json' }],
    ['flow_open_characters', {}],
    ['flow_list_mention_options', {}],
    ['flow_create_scene', { prompt: 'x' }],
    ['flow_open_tools_gallery', {}],
    ['flow_use_grid_architect', { theme_prompt: 'x' }],
    ['flow_use_tool', { tool_name: 'Grid Architect' }],
    ['flow_screenshot', { name: 'w00' }],
    ['flow_create_project', { name: 'w00 probe' }],
  ])('%s with valid args fails closed BROWSER_NOT_CONNECTED (no navigation)', async (name, args) => {
    await expectFlowError(handleToolCall(name, args), 'BROWSER_NOT_CONNECTED');
  });

  it('flow_status reports browser:false object', async () => {
    const status = await handleFlowStatusDirect();
    expect(status.browser).toBe(false);
  });

  async function handleFlowStatusDirect() {
    return parsed(await handleToolCall('flow_status', {}));
  }

  it('flow_list_models({}) returns a real catalog object without a browser', async () => {
    const body = parsed(await handleToolCall('flow_list_models', {}));
    expect(['cache', 'fallback']).toContain(body.source);
    expect(Array.isArray(body.videoModels)).toBe(true);
  });

  it('flow_list_browser_targets/flow_list_projects succeed with no browser', async () => {
    const targets = parsed(await handleToolCall('flow_list_browser_targets', {}));
    expect(targets.status).toBe('success');
    expect(Array.isArray(targets.targets)).toBe(true);
    const projects = parsed(await handleToolCall('flow_list_projects', {}));
    expect(projects.status).toBe('success');
    expect(Array.isArray(projects.projects)).toBe(true);
  });

  it('flow_queue_status/reset + flow_disconnect succeed with no browser', async () => {
    expect(parsed(await handleToolCall('flow_queue_status', { history_limit: 2 })).history).toBeDefined();
    expect(parsed(await handleToolCall('flow_queue_reset', {})).status).toBe('success');
    expect(parsed(await handleToolCall('flow_disconnect', {})).status).toBe('disconnected');
  });

  it('unknown tool throws real McpError MethodNotFound', async () => {
    try {
      await handleToolCall('flow_nope', {});
    } catch (e) {
      expect(e.code).toBe(ErrorCode.MethodNotFound);
      return;
    }
    throw new Error('expected MethodNotFound');
  });
});

describe('w00 scoped fixture dispatch on real headless Chrome', () => {
  it('resolves a fixture browser (blocker if none)', async () => {
    const r = await w00ResolveChrome();
    expect(r && typeof r.via).toBe('string');
  }, 30000);

  it('flow_status on a scoped fixture reports browser:true with fixture URL', async () => {
    const page = await w00LoadFixture('w00-sidebar.html');
    try {
      const body = await withPage(page, async () => parsed(await handleToolCall('flow_status', {})));
      expect(body.browser).toBe(true);
      expect(body.currentUrl).toBe(page.url());
    } finally {
      await page.close();
    }
  }, 30000);

  it('flow_screenshot on a scoped fixture writes a real PNG', async () => {
    const page = await w00LoadFixture('w00-composer-video.html');
    try {
      const body = await withPage(page, async () => parsed(await handleToolCall('flow_screenshot', { name: 'w00-dispatch' })));
      expect(typeof body.screenshot).toBe('string');
      expect(fs.existsSync(body.screenshot)).toBe(true);
      expect(fs.statSync(body.screenshot).size).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30000);

  it('nested scopes restore; concurrent scopes stay distinct', async () => {
    const p1 = await w00LoadFixture('w00-sidebar.html');
    const p2 = await w00LoadFixture('w00-composer-video.html');
    try {
      const seen = {};
      await withPage(p1, async () => {
        seen.outerBefore = getPage();
        await withPage(p2, async () => {
          seen.inner = getPage();
          seen.innerStatus = parsed(await handleToolCall('flow_status', {})).currentUrl;
        });
        seen.outerAfter = getPage();
      });
      expect(seen.outerBefore).toBe(p1);
      expect(seen.inner).toBe(p2);
      expect(seen.outerAfter).toBe(p1);
      expect(seen.innerStatus).toBe(p2.url());
      const conc = {};
      await Promise.all([
        withPage(p1, async () => {
          await new Promise((r) => setTimeout(r, 25));
          conc.a = getPage();
        }),
        withPage(p2, async () => {
          await new Promise((r) => setTimeout(r, 5));
          conc.b = getPage();
        }),
      ]);
      expect(conc.a).toBe(p1);
      expect(conc.b).toBe(p2);
    } finally {
      await p1.close();
      await p2.close();
    }
  }, 30000);

  it('outside the scope the page is gone: flow_screenshot rejects disconnected', async () => {
    const page = await w00LoadFixture('w00-sidebar.html');
    await page.close();
    expect(isBrowserConnected()).toBe(false);
    await expectFlowError(handleToolCall('flow_screenshot', { name: 'w00' }), 'BROWSER_NOT_CONNECTED');
  }, 30000);
});

// ---- registry/schema parity over ACTUAL objects ----
// Zod v4 public-API introspection (no private _def access).
function zodFieldInfo(field) {
  let t = field;
  let optional = false;
  let hasDefault = false;
  let defVal;
  for (;;) {
    if (t instanceof z.ZodOptional) { optional = true; t = t.def.innerType; continue; }
    if (t instanceof z.ZodDefault) {
      optional = true; hasDefault = true;
      const dv = t.def.defaultValue;
      try { defVal = typeof dv === 'function' ? dv() : dv; } catch { defVal = undefined; }
      t = t.def.innerType; continue;
    }
    break;
  }
  return { optional, hasDefault, defVal };
}

function zodShape(schema) {
  if (schema instanceof z.ZodObject) return schema.shape;
  return null;
}

const SCHEMA_FOR_TOOL = {
  flow_connect: 'flow_connect',
  flow_open: 'flow_open',
  flow_discover_ui: 'flow_discover_ui',
  flow_generate_image: 'flow_generate_image',
  flow_generate_video: 'flow_generate_video',
  flow_create_character: 'flow_create_character',
  flow_create_project: 'flow_create_project',
  flow_generate_confirm: 'flow_generate_confirm',
  flow_rename_character: 'flow_rename_character',
  flow_rename_image: 'flow_rename_image',
  flow_import_character: 'flow_import_character',
  flow_list_browser_targets: 'flow_list_browser_targets',
  flow_list_projects: 'flow_list_projects',
  flow_open_characters: 'project_scoped',
  flow_list_mention_options: 'project_scoped',
  flow_create_scene: 'flow_create_scene',
  flow_use_grid_architect: 'flow_use_grid_architect',
  flow_use_tool: 'flow_use_tool',
  flow_screenshot: 'flow_screenshot',
  flow_queue_status: 'flow_queue_status',
  flow_script_create: 'flow_script_create',
  flow_script_update: 'flow_script_update',
  flow_script_status: 'flow_script_status',
  flow_script_review: 'flow_script_review',
  flow_script_run: 'flow_script_run',
  flow_script_resume: 'flow_script_resume',
};
const NO_SCHEMA_TOOLS = [
  'flow_disconnect', 'flow_status', 'flow_account_check', 'flow_list_models',
  'flow_download_latest', 'flow_open_tools_gallery', 'flow_queue_reset', 'flow_export_reel',
];

// Outstanding advertised-vs-validated gaps, owned by W06. Both directions
// asserted: every observed gap must be listed, every listing observed.
// Each entry below was verified against TOOL_DEFINITIONS in src/index.js
// and the zod schemas in src/utils/validate.js on this snapshot.
// W09 conditional review contract: flow_script_review decision is
// advertised-optional and zod-optional; runtime/zod superRefine requires it
// only for legacy no-action review, while typed W09 actions
// (score_candidate/select_reference/reference_pack) use reviewer/reason.
// No parity exception is registered for this intentional conditional.
const W06_MISMATCHES = [
  'flow_create_character: zod field \'model\' not advertised',
  'flow_create_character: zod field \'reference_image\' not advertised',
  'flow_generate_confirm: advertised-required \'job_id\' is zod-optional',
  'flow_generate_confirm: zod field \'jobId\' not advertised',
  'flow_rename_character: zod field \'character_id\' not advertised',
  'flow_create_scene: advertised-required \'prompt\' is zod-optional',
  'flow_create_scene: zod field \'description\' not advertised',
  'flow_discover_ui: zod field \'waitFor\' not advertised',
  'flow_generate_image: zod field \'quantity\' not advertised',
  'flow_list_mention_options: zod field \'project_url\' not advertised',
  'flow_open_characters: zod field \'project_url\' not advertised',
  'flow_use_tool: advertised-required \'tool_name\' is zod-optional',
  'flow_use_tool: zod field \'name\' not advertised',
];

describe('w00 registry/schema parity consumes actual exported objects', () => {
  it('every definition maps to a real dispatch case + explicit schema decision', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [tool, key] of Object.entries(SCHEMA_FOR_TOOL)) {
      expect(names, tool).toContain(tool);
      expect(schemas[key], `${tool} zod`).toBeDefined();
    }
    for (const tool of NO_SCHEMA_TOOLS) expect(names, tool).toContain(tool);
    expect(names.sort()).toEqual(
      [...Object.keys(SCHEMA_FOR_TOOL), ...NO_SCHEMA_TOOLS].sort(),
    );
  });

  it('advertised properties/required/defaults match zod or are W06-registered', () => {
    const observed = [];
    for (const def of TOOL_DEFINITIONS) {
      const key = SCHEMA_FOR_TOOL[def.name];
      if (!key) continue;
      const shape = zodShape(schemas[key]);
      expect(shape, `${def.name} zod object`).not.toBe(null);
      const props = def.inputSchema.properties || {};
      const required = new Set(def.inputSchema.required || []);
      for (const [pname, pspec] of Object.entries(props)) {
        if (!(pname in shape)) {
          observed.push(`${def.name}: advertised '${pname}' has no zod field`);
          continue;
        }
        const info = zodFieldInfo(shape[pname]);
        if (required.has(pname) && info.optional) {
          observed.push(`${def.name}: advertised-required '${pname}' is zod-optional`);
        }
        if (!required.has(pname) && !info.optional) {
          observed.push(`${def.name}: advertised-optional '${pname}' is zod-required`);
        }
        if (pspec.default !== undefined && info.hasDefault
          && JSON.stringify(pspec.default) !== JSON.stringify(info.defVal)) {
          observed.push(`${def.name}: default mismatch on '${pname}'`);
        }
      }
      for (const zname of Object.keys(shape)) {
        if (!(zname in props)) observed.push(`${def.name}: zod field '${zname}' not advertised`);
      }
    }
    expect({ observed: observed.sort(), registered: [...W06_MISMATCHES].sort() }).toEqual({
      observed: [...W06_MISMATCHES].sort(),
      registered: [...W06_MISMATCHES].sort(),
    });
  });
});
