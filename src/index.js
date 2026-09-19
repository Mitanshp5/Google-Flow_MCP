#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { logger, closeLogger } from './utils/logger.js';
import { launchKiaraProfile, navigateToFlow } from './browser/launch-profile.js';
import { getPage, getBrowser, setBrowser, closeBrowser as closeBrowserConnection, isBrowserConnected } from './browser/connect.js';
import { verifyAccount as checkAccount } from './browser/account-check.js';
import { handleFlowOpen } from './tools/flow-open.js';
import { handleFlowStatus } from './tools/flow-status.js';
import { handleGenerateImage } from './tools/generate-image.js';
import { handleGenerateVideo } from './tools/generate-video.js';
import { handleDownloadLatest } from './tools/download-latest.js';
import { handleCreateCharacter } from './tools/create-character.js';
import { handleImportCharacter } from './tools/import-character.js';
import { handleOpenCharacters } from './tools/open-characters.js';
import { handleCreateScene } from './tools/create-scene.js';
import { handleOpenToolsGallery } from './tools/open-tools-gallery.js';
import { handleUseGridArchitect } from './tools/grid-architect.js';
import { handleDiscoverUi } from './tools/discover-ui.js';
import { handleListMentionOptions } from './tools/list-mentions.js';
import { handleUseFlowTool } from './tools/use-flow-tool.js';
import { jobQueue } from './queue/job-queue.js';
import { takeScreenshot } from './utils/screenshots.js';
import { FlowError } from './utils/errors.js';
import { schemas, parseOrThrow } from './utils/validate.js';
import { getUniverse, loadCatalog } from './utils/models.js';
import { discoverModels } from './navigation/model-discovery.js';
import fs from 'fs';
import path from 'path';

const TOOL_DEFINITIONS = [
  {
    name: 'flow_connect',
    description: 'Launch Chrome with the configured Google profile, connect CDP, navigate to Google Flow, and verify account.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Launch in headless mode (not recommended, Google Flow needs visible browser).', default: false },
        open_flow: { type: 'boolean', description: 'Auto-navigate to Google Flow after connection.', default: true },
      },
    },
  },
  {
    name: 'flow_disconnect',
    description: 'Close the browser and clean up the MCP connection to Google Flow.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_status',
    description: 'Check current connection status: browser connected, Flow page loaded, account verified, job queue state.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return full status with screenshot.', default: false },
      },
    },
  },
  {
    name: 'flow_account_check',
    description: 'Verify the logged-in Google account matches the configured expected email (Default).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_discover_ui',
    description: 'Navigate to a Google Flow page and discover all interactive elements (buttons, inputs, links, headings). Updates the internal selectors map for robust automation.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page to discover. Options: main, image-generation, video-generation, characters, scenes, images, all-media, tools-gallery, grid-architect. "characters" is project-scoped (/project/{id}/characters). "scenes"/"images"/"all-media" are sidebar tabs within the project (same URL). project_name/campaign target a specific project, or the current/active project is used.', default: 'main' },
        project_name: { type: 'string', description: 'Project name, used when page is "characters", "scenes", "images", or "all-media" (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching, used when page is "characters", "scenes", "images", or "all-media".' },
        url: { type: 'string', description: 'Exact https://flow.google.com/... URL to navigate to, overriding page-based resolution. Other hosts are rejected.' },
      },
    },
  },
  {
    name: 'flow_generate_image',
    description: '⚠️ THESE IMAGES CONSUME CREDITS. By default (auto_confirm=false): fills the prompt, selects model/ratio, takes a screenshot and returns "ready_for_confirmation". Does NOT click Generate. When auto_confirm=true: first verifies the UI is in IMAGE mode (not Video), that the model is an image model, takes a verification screenshot, THEN clicks Generate and waits for the images. NANO/BANANA image models only.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt for image generation.' },
        model: { type: 'string', description: 'Model to use: Nano Banana Pro, Nano Banana 2, or Imagen 4.', default: 'Nano Banana 2' },
        auto_confirm: { type: 'boolean', description: '⚠️ CREDITS. If false (default): only prepares, consumes nothing. If true: verifies that Image mode is active, THEN clicks Generate (consumes credits).', default: false },
        ratio: { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4.', default: '1:1' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to local reference images to upload (optional).' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'Names of existing project images/characters to reference via "@name" (e.g., ["Bob the Astronaut", "Image 3"]). Use flow_list_mention_options to discover available names.' },
        brand: { type: 'string', description: 'Brand context for automatic model selection: premium, standard.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_generate_video',
    description: 'Prepare a Veo video (prepare-only, no spend). Fast tests, Quality finals; ingredients need 8s.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene + action. Optics stay in UI selectors.' },
        model: { type: 'string', description: 'Video model name — call flow_list_models for the live list — or auto.', default: 'auto' },
        ratio: { type: 'string', description: '16:9 or 9:16.', default: '16:9', enum: ['16:9', '9:16'] },
        duration: { type: 'string', description: '4s, 6s, 8s, 10s. Ingredients force 8s.', default: '4s', enum: ['4s', '6s', '8s', '10s'] },
        quality: { type: 'string', description: 'Resolution 360p/720p.', enum: ['360p', '720p'] },
        camera: { type: 'string', description: 'Camera move: push-in, pull-back, pan, tilt, orbit, tracking shot.' },
        style: { type: 'string', description: 'Look/mood/lighting. No extra subjects in refs.' },
        start_frame: { type: 'string', description: 'First-frame image path (hero frame anchor).' },
        end_frame: { type: 'string', description: 'Last-frame image path. Shares light/framing with start.' },
        hero_frame: { type: 'string', description: 'Alias for start_frame.' },
        anchor_frame: { type: 'string', description: 'Prior strongest frame carried for continuity.' },
        shots: { type: 'array', items: { type: 'object' }, description: 'Multi-shot plan, max 6: [{prompt, duration}].' },
        quantity: { type: 'number', description: 'Variants 1-4 for compare-pick-refine.', default: 1 },
        auto_confirm: { type: 'boolean', description: 'Always prepare-only today. Reserved.', default: false },
        confirm_generate: { type: 'boolean', description: 'LIVE PAID CLICK: verify, click Generate (credits), poll video. Default false.', default: false },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to local reference images to upload (optional).' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'Project images/characters to reference via "@name" (e.g., ["Bob the Astronaut", "Image 3"]). Discover names via flow_list_mention_options.' },
        use_character: { type: 'string', description: 'Name of a single project character to reference via "@name" (added in addition to ingredients).' },
        use_scene: { type: 'string', description: 'Name of a single project scene to reference via "@name" (added in addition to ingredients).' },
        project_name: { type: 'string', description: 'Project name (remembered; reopens instead of duplicating).' },
        campaign: { type: 'string', description: 'Campaign id (doubles as project name when name absent).' },
        project_url: { type: 'string', description: 'Direct Flow /project/ URL — wins over name matching.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_list_models',
    description: 'List video/image models, ratios, durations from Flow UI (live) or cache. Call once per session before generating.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Force re-discovery from the open UI instead of cache.', default: false },
      },
    },
  },
  {
    name: 'flow_download_latest',
    description: 'Download the most recently generated file from Google Flow.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_create_character',
    description: 'Create a new character in Google Flow Characters with name and description. By default (auto_confirm=false): fills the description and returns "ready_for_confirmation" without submitting (no credits). When auto_confirm=true: fills and clicks submit, then renames "Untitled Character" to the given name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name.' },
        description: { type: 'string', description: 'Character description/prompt.' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images for character design.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
        auto_confirm: { type: 'boolean', description: 'If false (default): only fills the description and returns "ready_for_confirmation" without submitting. If true: submits (may use credits).', default: false },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'flow_import_character',
    description: 'Import a character from a saved JSON file into Google Flow.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to character JSON file.' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'flow_open_characters',
    description: 'Open the Characters page for the current/target project and list existing characters.',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
    },
  },
  {
    name: 'flow_list_mention_options',
    description: 'List the images and characters in the current project that can be referenced via "@name" in an image/video prompt (opens Flow\'s "@" reference popup and reads its options).',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
    },
  },
  {
    name: 'flow_create_scene',
    description: 'Create a new scene in Google Flow Scenes with characters and prompt. By default (auto_confirm=false) prepares only; set auto_confirm=true to actually create.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene description/prompt.' },
        characters: { type: 'array', items: { type: 'string' }, description: 'Character names to include in the scene.' },
        reference_image: { type: 'string', description: 'Path to a reference image (optional).' },
        auto_confirm: { type: 'boolean', description: 'If false (default): prepare only. If true: click New Scene and create.', default: false },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_open_tools_gallery',
    description: 'Open the Google Flow Tools Gallery and list available tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_use_grid_architect',
    description: 'Open Grid Architect in Google Flow, fill theme prompt, shot prompts, engine, ratio, and visual logic settings. Supports batch shot generation for brand campaigns. Prepare-only by default (auto_confirm=false).',
    inputSchema: {
      type: 'object',
      properties: {
        theme_prompt: { type: 'string', description: 'Overall theme prompt for the grid.' },
        shot_prompts: { type: 'array', items: { type: 'string' }, description: 'Array of individual shot prompts for the grid.' },
        engine: { type: 'string', description: 'Engine/model for the grid.', default: 'Nano Banana 2' },
        ratio: { type: 'string', description: 'Aspect ratio for all shots.', default: '16:9' },
        visual_logic: { type: 'string', description: 'Visual logic type: None, Colour Pop, Side by Side, etc.' },
        references: { type: 'array', items: { type: 'string' }, description: 'Paths to reference images.' },
        auto_confirm: { type: 'boolean', description: 'Reserved — currently prepare-only.', default: false },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['theme_prompt'],
    },
  },
  {
    name: 'flow_use_tool',
    description: 'Open any tool by name in Google Flow and optionally fill its configuration parameters. Prepare-only by default (auto_confirm=false).',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Name of the tool to open (e.g. Grid Architect, Image Generation).' },
        params: { type: 'object', description: 'Optional configuration parameters for the tool.' },
        auto_confirm: { type: 'boolean', description: 'Reserved — currently prepare-only.', default: false },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'flow_screenshot',
    description: 'Take a screenshot of the current Google Flow page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Custom name for the screenshot file.', default: 'manual' },
      },
    },
  },
  {
    name: 'flow_queue_status',
    description: 'Check the job queue: active job, pending queue, completed and failed job history.',
    inputSchema: {
      type: 'object',
      properties: {
        history_limit: { type: 'number', description: 'Number of recent history entries to return.', default: 5 },
      },
    },
  },
  {
    name: 'flow_queue_reset',
    description: 'Forcefully reset the job queue. Use this if a job is permanently stuck in "running" state and blocking other generations.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(name, args) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });

  switch (name) {
    case 'flow_connect': {
      const v = parseOrThrow(schemas.flow_connect, args, 'flow_connect');
      const result = await launchKiaraProfile(v.headless);
      if (result.browser) setBrowser(result.browser);
      let page;
      try {
        page = getPage();
      } catch {
        page = result.page;
        if (!page) throw new FlowError('BROWSER_NOT_CONNECTED', 'Browser launch returned no usable page');
      }
      let oauthRequired = false;
      if (v.open_flow !== false) {
        const navResult = await navigateToFlow(page);
        if (navResult && navResult.authenticated === false) {
          oauthRequired = true;
        }
      }
      let accountCheck = null;
      try {
        accountCheck = await checkAccount(page);
      } catch (e) {
        accountCheck = { verified: false, error: e.message, code: e.code };
      }
      // Best-effort model catalog refresh from the live UI (never blocks connect).
      let models = null;
      if (v.open_flow !== false) {
        try {
          models = await Promise.race([
            discoverModels(page),
            new Promise(res => setTimeout(() => res(null), 25000)),
          ]);
        } catch (e) {
          logger.debug('Connect-time model discovery skipped', { error: e.message });
        }
      }
      if (oauthRequired) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'oauth_required',
          message: 'Google Flow requires OAuth authentication. Open Chrome Default manually once:\n'
            + '  1. Launch: google-chrome --profile-directory="Default"\n'
            + '  2. Navigate to: https://flow.google.com/\n'
            + '  3. Complete the Google sign-in (one time)\n'
            + '  4. Retry this MCP tool in headless mode',
          browserType: 'Chrome Default',
          account: accountCheck?.account || 'verified-account',
          url: page.url().substring(0, 100),
          accountVerified: accountCheck,
        }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'connected',
        browserType: 'Chrome Default',
        account: accountCheck?.account || 'verified-account',
        url: page.url(),
        accountVerified: accountCheck,
        models: models || getUniverse(),
      }, null, 2) }] };
    }

    case 'flow_disconnect': {
      await closeBrowserConnection();
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'disconnected' }) }] };
    }

    case 'flow_status': {
      const status = await handleFlowStatus();
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    case 'flow_account_check': {
      const page = getPage();
      const result = await checkAccount(page);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_discover_ui': {
      const v = parseOrThrow(schemas.flow_discover_ui, args, 'flow_discover_ui');
      const result = await handleDiscoverUi(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_image': {
      const v = parseOrThrow(schemas.flow_generate_image, args, 'flow_generate_image');
      const result = await handleGenerateImage(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_video': {
      const v = parseOrThrow(schemas.flow_generate_video, args, 'flow_generate_video');
      const result = await handleGenerateVideo(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_models': {
      const refresh = args?.refresh === true;
      if (refresh) {
        try {
          const live = await discoverModels(getPage());
          if (live) {
            return { content: [{ type: 'text', text: JSON.stringify({ ...live, source: 'live' }, null, 2) }] };
          }
        } catch (e) {
          logger.warn('Manual model refresh failed, falling back to cache', { error: e.message });
        }
      }
      const cached = loadCatalog();
      return { content: [{ type: 'text', text: JSON.stringify(cached ? { ...cached, source: 'cache' } : { ...getUniverse(), source: 'fallback' }, null, 2) }] };
    }

    case 'flow_download_latest': {
      const result = await handleDownloadLatest(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_character': {
      const v = parseOrThrow(schemas.flow_create_character, args, 'flow_create_character');
      const result = await handleCreateCharacter(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_import_character': {
      const v = parseOrThrow(schemas.flow_import_character, args, 'flow_import_character');
      const result = await handleImportCharacter(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_characters': {
      const v = parseOrThrow(schemas.project_scoped, args, 'flow_open_characters');
      const result = await handleOpenCharacters(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_mention_options': {
      const v = parseOrThrow(schemas.project_scoped, args, 'flow_list_mention_options');
      const result = await handleListMentionOptions(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_scene': {
      const v = parseOrThrow(schemas.flow_create_scene, args, 'flow_create_scene');
      const result = await handleCreateScene(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open_tools_gallery': {
      const result = await handleOpenToolsGallery(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_grid_architect': {
      const v = parseOrThrow(schemas.flow_use_grid_architect, args, 'flow_use_grid_architect');
      const result = await handleUseGridArchitect(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_use_tool': {
      const v = parseOrThrow(schemas.flow_use_tool, args, 'flow_use_tool');
      const result = await handleUseFlowTool(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_screenshot': {
      const v = parseOrThrow(schemas.flow_screenshot, args, 'flow_screenshot');
      const page = getPage();
      const ss = await takeScreenshot(page, v.name);
      if (!ss) {
        return { content: [{ type: 'text', text: JSON.stringify({ screenshot: null, message: 'Screenshot failed — browser may be disconnected.' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ screenshot: ss, message: 'Screenshot saved.' }) }] };
    }

    case 'flow_queue_status': {
      const v = parseOrThrow(schemas.flow_queue_status, args, 'flow_queue_status');
      return { content: [{ type: 'text', text: JSON.stringify(jobQueue.getStatus(v.history_limit), null, 2) }] };
    }

    case 'flow_queue_reset': {
      jobQueue.reset();
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', message: 'Job queue forcefully reset.' }) }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'google-flow-browser-mcp', version: '1.0.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleToolCall(request.params.name, request.params.arguments);
  } catch (error) {
    logger.error('Tool execution error', {
      tool: request.params.name,
      error: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 3).join(' | '),
    });
    if (error instanceof McpError) throw error;
    if (error instanceof FlowError) {
      const blocking = [
        'WRONG_GOOGLE_ACCOUNT', 'NOT_LOGGED_IN', 'GENERATION_BUTTON_DISABLED',
        'MANUAL_VERIFICATION_REQUIRED', 'GOOGLE_LIMIT_REACHED', 'ACCOUNT_UNVERIFIED',
      ].includes(error.code);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: true,
          message: error.message,
          code: error.code || 'ERROR',
          details: error.details || {},
          needsManualIntervention: blocking,
        }, null, 2) }],
        isError: true,
      };
    }
    const message = error.message || 'Unknown error';
    const isBlocking = message.includes('MUST') || message.includes('cannot') || message.includes('blocked');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: true,
        message,
        code: isBlocking ? 'BLOCKING' : 'ERROR',
        needsManualIntervention: isBlocking,
      }, null, 2) }],
      isError: true,
    };
  }
});

async function shutdown(signal) {
  logger.info(`Shutting down on ${signal}`);
  try {
    await closeBrowserConnection();
  } catch (e) {
    logger.warn('Shutdown browser close failed', { error: e.message });
  }
  try {
    await closeLogger();
  } catch { /* ignore */ }
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('Google Flow Browser MCP server running on stdio');
