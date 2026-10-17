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
import { getPage, setBrowser, closeBrowser as closeBrowserConnection } from './browser/connect.js';
import { verifyAccount as checkAccount } from './browser/account-check.js';
import { handleFlowOpen } from './tools/flow-open.js';
import { handleFlowStatus } from './tools/flow-status.js';
import { handleCreateProject } from './tools/create-project.js';
import { handleListBrowserTargets } from './tools/list-browser-targets.js';
import { handleListProjects } from './tools/list-projects.js';
import { handleGenerateConfirm } from './tools/generate-confirm.js';
import { handleRenameCharacter } from './tools/rename-character.js';
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
import { handleScriptCreate } from './tools/script-create.js';
import { handleScriptUpdate } from './tools/script-update.js';
import { handleScriptStatus } from './tools/script-status.js';
import { handleScriptReview } from './tools/script-review.js';
import { handleScriptRun } from './tools/script-run.js';
import { handleScriptResume } from './tools/script-resume.js';
import { jobQueue } from './queue/job-queue.js';
import { takeScreenshot } from './utils/screenshots.js';
import { FlowError } from './utils/errors.js';
import { schemas, parseOrThrow } from './utils/validate.js';
import { getUniverse, loadCatalog } from './utils/models.js';
import { runRetentionSweep } from './utils/file-manager.js';
import { discoverModels, discoverCapabilities } from './navigation/model-discovery.js';
import { handleExportReel } from './tools/export-reel.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { withUiTransaction, assertUiCurrent } from './browser/ui-transaction.js';
import { guardUiPage } from './browser/guarded-page.js';
import { withPage } from './browser/session-scope.js';

const TOOL_DEFINITIONS = [
  {
    name: 'flow_connect',
    description: 'Launch Chrome with the configured Google profile, connect CDP, navigate to Google Flow, and verify account.',
    inputSchema: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: 'Launch in headless mode (not recommended, Google Flow needs visible browser).', default: false },
          open_flow: { type: 'boolean', description: 'Auto-navigate to Google Flow after connection.', default: true },
          cdpPort: { type: 'number', description: 'CDP port of an already-open Chrome (see flow_list_browser_targets). Defaults to config cdpPort.' },
        },
      },
    },
    {
      name: 'flow_list_browser_targets',
      description: 'Probe local Chrome CDP ports (config port plus common ones) and report which have a listening browser. No browser connection needed.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'flow_create_project',
      description: 'Create a brand-new Flow project via the "New project" button (never reuses or renames an existing project). Pass its url as project_url afterwards to pin it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the new project.' },
          campaign: { type: 'string', description: 'Campaign identifier stored in the local registry.' },
        },
      },
    },
    {
      name: 'flow_list_projects',
      description: 'List known Flow projects from the local registry (name, url, campaign, last_used). No browser needed.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'flow_generate_confirm',
      description: 'LIVE PAID CLICK for a verified preparation. Requires a known quote within max_credits. Watches briefly after submission; local queue completion does NOT prove remote render completion. Inspect the new remote asset before downloading. No auto-download.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Prepared ready_for_confirmation job id.' },
          max_credits: { type: 'number', description: 'Spend ceiling (images ~0, Omni 1.1 Flash cheap default, Veo ~20). Refuses above this.', default: 2 },
          wait_ms: { type: 'number', description: 'Post-click watch, default 2s, ceiling 30s. Characters return immediately for renaming. Verify remote output before downloading.', default: 2000 },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'flow_rename_character',
      description: 'Rename a character inside its detail page (pencil the title, Done). Never touches the project title.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Current character name as shown on its card.' },
          new_name: { type: 'string', description: 'New character name.' },
          project_name: { type: 'string', description: 'Project scope.' },
          campaign: { type: 'string', description: 'Campaign scope.' },
          project_url: { type: 'string', description: 'Direct Flow /project/ URL (recommended pin).' },
        },
        required: ['new_name'],
      },
    },
  {
    name: 'flow_disconnect',
    description: 'Close the browser and clean up the MCP connection to Google Flow.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_open',
    description: 'Navigate the already-connected browser to a Google Flow URL without reconnecting. Only https://flow.google.com/... URLs are allowed (other hosts rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Exact Flow URL to navigate to. Defaults to the configured flowUrl when omitted.' },
        waitFor: { type: 'number', description: 'Extra ms to wait after load (clamped 0-15000).', default: 3000 },
      },
    },
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
        max_credits: { type: 'number', description: 'Maximum credits authorized for this submission. Unknown or higher quotes are refused.', default: 2 },
        ratio: { type: 'string', description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4.', default: '1:1' },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to local reference images to upload (optional).' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'Names of existing project images/characters to reference via "@name" (e.g., ["Bob the Astronaut", "Image 3"]). Use flow_list_mention_options to discover available names.' },
        use_character: { type: 'string', description: 'Name of a single project character to reference via "@name" (added in addition to ingredients).' },
        use_scene: { type: 'string', description: 'Name of a single project scene to reference via "@name" (added in addition to ingredients).' },
        project_name: { type: 'string', description: 'Name for the project (will reuse existing project with same campaign, or create new).' },
        campaign: { type: 'string', description: 'Campaign identifier for project matching (e.g., "summer-2026", "new-collection").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'flow_generate_video',
    description: 'Prepare video (default Omni 1.1 Flash cheap; prepare-only, no spend). Quality finals; ingredients need 8s.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene + action. Optics stay in UI selectors.' },
        model: { type: 'string', description: 'Live model from flow_list_models, or auto.', default: 'auto' },
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
        confirm_generate: { type: 'boolean', description: 'Authorize one verified paid submission. Rendering remains pending.', default: false },
        max_credits: { type: 'number', description: 'Credit ceiling. Unknown/higher quotes refuse.', default: 2 },
        reference_images: { type: 'array', items: { type: 'string' }, description: 'Paths to local reference images to upload (optional).' },
        ingredients: { type: 'array', items: { type: 'string' }, description: 'Project @names from flow_list_mention_options.' },
        use_character: { type: 'string', description: 'Additional character @name.' },
        use_scene: { type: 'string', description: 'Additional scene @name.' },
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
        probe_capabilities: { type: 'boolean', description: 'Also probe per-model settings (slow, changes model selection temporarily). Requires refresh:true.', default: false },
      },
    },
  },
  {
    name: 'flow_download_latest',
    description: 'Download a verified latest asset, or an explicit asset_id. Ambiguous ordering returns choices instead of guessing. Saves and verifies media bytes. No generation or upscaling.',
    inputSchema: { type: 'object', properties: {
      asset_id: { type: 'string', description: 'Optional exact asset ID from download choices; selects that asset without claiming it is newest.' },
    } },
  },
  {
    name: 'flow_export_reel',
    description: 'Export three existing project clips in prompt order, trim each to 7s, concatenate to 21s using local FFmpeg. No generation or credits. Prepare-only by default. Downloads and verifies MP4s from Flow ZIPs; requires audio tracks.',
    inputSchema: { type: 'object', properties: {
      project_url: { type: 'string', description: 'Exact current Flow project root URL.' },
      prompts: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'Unique video prompt prefixes in story order.' },
      ffmpeg_path: { type: 'string', description: 'Existing local ffmpeg executable with ffprobe alongside.' },
      prepare_only: { type: 'boolean', default: true },
    }, required: ['project_url', 'prompts'] },
  },
  {
    name: 'flow_create_character',
    description: 'Create a new character in Google Flow Characters with name and description. By default (auto_confirm=false): fills the description and returns "ready_for_confirmation" without submitting (no credits). When auto_confirm=true: fills and clicks submit, then renames "Untitled Character" to the given name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Character name.' },
        description: { type: 'string', description: 'Character description/prompt.' },
        archetype: { type: 'string', description: 'Starter card to pick first (The Eccentric, The Professional, The Wildcard, The Familiar, The Wicked, The Fantastical).' },
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

  {
    name: 'flow_script_create',
    description: 'Create a structured script, bible, continuity DAG, and bounded generation policy in immutable revision storage (local planning only, zero credit spend).',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'Optional explicit script UUID or identifier.' },
        brief: { type: 'object', description: 'Script brief: title, aspectRatio, fps, targetDurationSec.' },
        binding: { type: 'object', description: 'Account and project binding: accountKey, projectId.' },
        policy: { type: 'object', description: 'Bounded policy limits: candidateLimit, timeBudgetSec, creditCap.' },
        governance: { type: 'object', description: 'Governance: privacyMode, referenceRights, reviewAuthority.' },
        bible: { type: 'object', description: 'Continuity bible: characters, locations, props with semantic IDs.' },
        scenes: { type: 'array', description: 'Ordered scene list referencing bible locations.' },
        shots: { type: 'array', description: 'Ordered shot cards with trim ranges, transition handles, and expected continuity states.' },
        accountKey: { type: 'string', description: 'Optional top-level accountKey.' },
        projectId: { type: 'string', description: 'Optional top-level projectId.' },
      },
      required: ['brief', 'bible'],
    },
  },
  {
    name: 'flow_script_update',
    description: 'Update script brief, bible, or shots under CAS revision control, computing semantic invalidations across the continuity state DAG (local planning only, zero credit spend).',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'Target script UUID.' },
        expectedRevision: { type: 'number', description: 'Expected current revision number.' },
        patch: { type: 'object', description: 'Fields to update (brief, bible, scenes, shots, policy).' },
        accountKey: { type: 'string', description: 'Optional accountKey verification.' },
        projectId: { type: 'string', description: 'Optional projectId verification.' },
      },
      required: ['scriptId', 'expectedRevision'],
    },
  },
  {
    name: 'flow_script_status',
    description: 'Query script continuity status, shot readiness, blocking prerequisites, and actionable planning steps (local planning only, zero credit spend).',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'Target script UUID.' },
        accountKey: { type: 'string', description: 'Optional accountKey verification.' },
        projectId: { type: 'string', description: 'Optional projectId verification.' },
      },
      required: ['scriptId'],
    },
  },
  {
    name: 'flow_script_review',
    description: 'Submit human or director review decisions for script nodes bound to exact content digest and reviewer identity (local planning only, zero credit spend). Optional action score_candidate/select_reference/reference_pack for W09 manual client review with digest-bound IDs/hashes/reviewer/reason.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'Target script UUID.' },
        expectedRevision: { type: 'number', description: 'Expected current revision number.' },
        nodeId: { type: 'string', description: 'Target node ID (char:*, loc:*, prop:*, scene:*, shot:*).' },
        nodeDigest: { type: 'string', description: 'Digest of node content to verify against stale review.' },
        reviewer: { type: 'string', description: 'Reviewer identifier.' },
        decision: { type: 'string', enum: ['approve', 'reject', 'revise', 'reset'], description: 'Review decision (required when no W09 action).' },
        notes: { type: 'string', description: 'Optional review notes.' },
        action: { type: 'string', enum: ['score_candidate', 'select_reference', 'reference_pack'], description: 'Optional W09 typed review action; absent means legacy node review.' },
        candidateId: { type: 'string', description: 'Full candidate UUID for score/select.' },
        candidateHash: { type: 'string', description: 'Full candidate sha256 for digest binding.' },
        expectedReferenceRevision: { type: 'number', description: 'Expected current reference revision for node (0 for first).' },
        expectedPackRevision: { type: 'number', description: 'Expected current pack revision for shot (0 for first).' },
        reason: { type: 'string', description: 'Client creative reason for W09 action.' },
        gates: { type: 'object', description: 'Seven hard eligibility gates for score_candidate.' },
        ratings: { type: 'object', description: '0..5 ratings per criterion for score_candidate.' },
        confidences: { type: 'object', description: '0..1 confidence per criterion.' },
        rubricVersion: { type: 'string', description: 'Rubric version for scoring.' },
        weights: { type: 'object', description: 'Criterion weights summing to 1.' },
        consideredCandidateIds: { type: 'array', description: 'Considered candidate set for selection.', items: { type: 'string' } },
      },
      required: ['scriptId', 'expectedRevision', 'nodeId', 'nodeDigest', 'reviewer'],
    },
  },
  {
    name: 'flow_script_run',
    description: 'Create a bounded local image-candidate intent for a script node. No browser access, remote submission or spend. Optional source local_import with explicit rights-declared files retains real immutable candidates. Stage review-artifacts with jobId produces a labelled immutable contact sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'Target script identifier.' },
        expectedRevision: { type: 'number', description: 'Expected current script revision.' },
        stage: { type: 'string', enum: ['references', 'image-candidates', 'review-artifacts'] },
        nodeId: { type: 'string', description: 'Target char, loc, prop or shot node ID.' },
        nodeDigest: { type: 'string', description: 'Full current node content digest.' },
        model: { type: 'string', description: 'Exact explicit image model name; not evidence of live availability.' },
        ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], description: 'Explicit image aspect ratio.' },
        quantity: { type: 'number', description: 'Variants 1–4; must fit the candidate limit.' },
        candidateLimit: { type: 'number', description: 'Finite decision-unit cap within the script policy.' },
        timeBudgetSec: { type: 'number', description: 'Finite time budget within the script policy; resume cannot reset the deadline.' },
        source: { type: 'string', enum: ['local_import'], description: 'Optional local import source; default planned prepare-only intent.' },
        files: { type: 'array', description: 'Local import files with explicit rights; quantity must match files count <=4.', items: { type: 'object' } },
        minWidth: { type: 'number', description: 'Minimum retained width for local import.' },
        minHeight: { type: 'number', description: 'Minimum retained height for local import.' },
        jobId: { type: 'string', description: 'Reserved for review-artifacts stage with existing job.' },
      },
      required: ['scriptId', 'expectedRevision', 'stage', 'nodeId', 'nodeDigest', 'model', 'ratio', 'quantity', 'candidateLimit', 'timeBudgetSec'],
    },
  },
  {
    name: 'flow_script_resume',
    description: 'Reconcile a durable candidate intent after restart. Preserves deadlines and budget reservations; never submits remotely.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'Target script identifier.' },
        jobId: { type: 'string', description: 'Full candidate-job UUID.' },
        expectedRevision: { type: 'number', description: 'Expected current script revision.' },
      },
      required: ['scriptId', 'jobId', 'expectedRevision'],
    },
  },
];

const pendingGeneration = new Set();
async function handleToolCall(name, args) {
  // All mutating dispatches share one UI owner; nested handler transactions
  // join it. Reset stays outside so it can fence an active owner immediately.
  const ownTransaction = new Set([
    'flow_connect', 'flow_disconnect', 'flow_discover_ui', 'flow_account_check',
    'flow_list_models', 'flow_download_latest', 'flow_import_character',
    'flow_open_characters', 'flow_list_mention_options', 'flow_open_tools_gallery',
    'flow_use_grid_architect', 'flow_use_tool',
    'flow_open', 'flow_generate_image', 'flow_generate_video',
    'flow_create_character', 'flow_create_scene',
    'flow_create_project', 'flow_generate_confirm', 'flow_rename_character',
  ]);
  const generation = ['flow_generate_image', 'flow_generate_video', 'flow_create_character', 'flow_create_scene', 'flow_use_grid_architect'].includes(name);
  if (generation && pendingGeneration.size) {
    throw new FlowError('JOB_IN_PROGRESS', 'A generation preparation already owns or is waiting for UI access.');
  }
  if (ownTransaction.has(name)) {
    if (generation) pendingGeneration.add(name);
    try {
      return await withUiTransaction(async ({ epoch }) => {
        assertUiCurrent(epoch);
        const dispatch = () => dispatchToolCall(name, args, epoch);
        let page = null;
        try { page = getPage(); } catch { /* connect may create the first page */ }
        const result = await (page ? withPage(guardUiPage(page, epoch), dispatch) : dispatch());
        assertUiCurrent(epoch);
        return result;
      });
    } finally { if (generation) pendingGeneration.delete(name); }
  }
  return dispatchToolCall(name, args);
}

function rejectConflictingScriptIds(args, tool) {
  if (args?.scriptId !== undefined && args?.storyId !== undefined && args.scriptId !== args.storyId) {
    throw new FlowError('INVALID_PARAMS', `[INVALID_PARAMS] Conflicting scriptId and storyId for ${tool}`, {
      scriptId: args.scriptId, storyId: args.storyId,
    });
  }
}

async function dispatchToolCall(name, args, epoch) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });

  switch (name) {
    case 'flow_connect': {
      const v = parseOrThrow(schemas.flow_connect, args, 'flow_connect');
      const result = await launchKiaraProfile(v.headless, { cdpPort: v.cdpPort });
      assertUiCurrent(epoch);
      if (result.browser) setBrowser(result.browser);
      let page;
      try {
        page = getPage();
      } catch {
        page = result.page;
        if (!page) throw new FlowError('BROWSER_NOT_CONNECTED', 'Browser launch returned no usable page');
      }
      page = guardUiPage(page, epoch);
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
          // The observer owns a bounded deadline. Keep the lease until it
          // returns; racing it leaves uncancelled UI work behind.
          models = await discoverModels(page, { timeoutMs: 25000 });
        } catch (e) {
          logger.debug('Connect-time model discovery skipped', { error: e.message });
        }
      }
      // P2-4: prune disposable debug trails (logs/screenshots/metadata only —
      // never user assets). Best-effort inside, never throws, never blocks.
      runRetentionSweep();
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

    case 'flow_list_browser_targets': {
      const result = await handleListBrowserTargets();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_create_project': {
      const v = parseOrThrow(schemas.flow_create_project, args, 'flow_create_project');
      const result = await handleCreateProject(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_list_projects': {
      const result = await handleListProjects();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_generate_confirm': {
      const v = parseOrThrow(schemas.flow_generate_confirm, args, 'flow_generate_confirm');
      const result = await handleGenerateConfirm(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_rename_character': {
      const v = parseOrThrow(schemas.flow_rename_character, args, 'flow_rename_character');
      const result = await handleRenameCharacter(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_open': {
      const v = parseOrThrow(schemas.flow_open, args, 'flow_open');
      const result = await handleFlowOpen(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_status': {
      const v = parseOrThrow(schemas.flow_status, args, 'flow_status');
      const status = await handleFlowStatus(v);
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
            // Listing names must not implicitly run the slow per-model probe.
            // Keep capability calibration available as an explicit opt-in.
            let capabilities = null;
            if (args?.probe_capabilities === true) try {
              capabilities = await discoverCapabilities(getPage(), { models: live.videoModels });
            } catch (e) {
              logger.warn('Capability discovery failed, keeping name lists only', { error: e.message });
            }
            return { content: [{ type: 'text', text: JSON.stringify({ ...live, capabilities, source: 'live' }, null, 2) }] };
          }
        } catch (e) {
          logger.warn('Manual model refresh failed, falling back to cache', { error: e.message });
        }
      }
      const cached = loadCatalog();
      if (cached) {
        const at = Date.parse(cached.savedAt || cached.discoveredAt || '') || 0;
        const ageMs = at ? Date.now() - at : null;
        return { content: [{ type: 'text', text: JSON.stringify({ ...cached, source: 'cache',
          stale: ageMs === null || ageMs > 6 * 3600 * 1000, cacheAgeMs: ageMs,
          note: 'Cache may predate the live UI (models/ratios change). For a live refresh, navigate into a project first, then call with refresh:true.',
        }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...getUniverse(), source: 'fallback' }, null, 2) }] };
    }

    case 'flow_download_latest': {
      const result = await handleDownloadLatest(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_export_reel': {
      const result = await handleExportReel(args);
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

    case 'flow_story_create':
    case 'flow_script_create': {
      const normalizedArgs = {
        ...args,
        scriptId: args?.scriptId || args?.storyId,
        storyId: args?.storyId || args?.scriptId,
      };
      const v = parseOrThrow(schemas[name] || schemas.flow_story_create, normalizedArgs, name);
      const normalized = { ...v, storyId: v.scriptId || v.storyId, scriptId: v.scriptId || v.storyId };
      const result = await handleScriptCreate(normalized);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_story_update':
    case 'flow_script_update': {
      const normalizedArgs = {
        ...args,
        scriptId: args?.scriptId || args?.storyId,
        storyId: args?.storyId || args?.scriptId,
      };
      const v = parseOrThrow(schemas[name] || schemas.flow_story_update, normalizedArgs, name);
      const normalized = { ...v, storyId: v.scriptId || v.storyId, scriptId: v.scriptId || v.storyId };
      const result = await handleScriptUpdate(normalized);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_story_status':
    case 'flow_script_status': {
      const normalizedArgs = {
        ...args,
        scriptId: args?.scriptId || args?.storyId,
        storyId: args?.storyId || args?.scriptId,
      };
      const v = parseOrThrow(schemas[name] || schemas.flow_story_status, normalizedArgs, name);
      const normalized = { ...v, storyId: v.scriptId || v.storyId, scriptId: v.scriptId || v.storyId };
      const result = await handleScriptStatus(normalized);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_story_review':
    case 'flow_script_review': {
      const normalizedArgs = {
        ...args,
        scriptId: args?.scriptId || args?.storyId,
        storyId: args?.storyId || args?.scriptId,
      };
      const v = parseOrThrow(schemas[name] || schemas.flow_story_review, normalizedArgs, name);
      const normalized = { ...v, storyId: v.scriptId || v.storyId, scriptId: v.scriptId || v.storyId };
      const result = await handleScriptReview(normalized);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_story_run':
    case 'flow_script_run': {
      rejectConflictingScriptIds(args, name);
      const normalizedArgs = {
        ...args,
        scriptId: args?.scriptId ?? args?.storyId,
        storyId: args?.storyId ?? args?.scriptId,
      };
      const v = parseOrThrow(schemas[name], normalizedArgs, name);
      const result = await handleScriptRun(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    case 'flow_story_resume':
    case 'flow_script_resume': {
      rejectConflictingScriptIds(args, name);
      const normalizedArgs = {
        ...args,
        scriptId: args?.scriptId ?? args?.storyId,
        storyId: args?.storyId ?? args?.scriptId,
      };
      const v = parseOrThrow(schemas[name], normalizedArgs, name);
      const result = await handleScriptResume(v);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'google-flow-browser-mcp', version: '1.1.0' },
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

export { TOOL_DEFINITIONS, handleToolCall };

export async function startServer() {
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Google Flow Browser MCP server running on stdio');
}

function isDirectEntry() {
  try {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  await startServer();
}
