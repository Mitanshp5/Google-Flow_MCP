import { z } from 'zod';
import { FlowError, ErrorCodes } from './errors.js';
import { VALID_ASPECT_RATIOS } from '../script/schema.js';

function fmtError(e) {
  try {
    return e.issues?.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') || e.message;
  } catch {
    return String(e?.message || e);
  }
}

export function parseOrThrow(schema, args, toolName) {
  const res = schema.safeParse(args ?? {});
  if (!res.success) {
    throw new FlowError(
      ErrorCodes.INVALID_PARAMS,
      `Invalid params for ${toolName}: ${fmtError(res.error)}`,
      { issues: res.error.issues }
    );
  }
  return res.data;
}

const nonEmpty = (label) => z.string().trim().min(1, `${label} must not be empty`).max(8000);

const exactId = (label, max) => z.string().min(1, `${label} is required`).max(max)
  .refine(v => v === v.trim() && v.trim().length > 0, { message: `${label} must be exact (no leading/trailing whitespace)` });

export const schemas = {
  flow_connect: z.object({
    headless: z.boolean().optional().default(false),
    open_flow: z.boolean().optional().default(true),
    cdpPort: z.number().int().min(1).max(65535).optional().describe('CDP port of an already-open Chrome (see flow_list_browser_targets). Defaults to config.'),
  }).passthrough(),

  flow_status: z.object({
    full: z.boolean().optional().default(false),
  }).passthrough(),

  flow_discover_ui: z.object({
    page: z.string().trim().min(1).max(64).optional().default('main'),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    url: z.string().trim().max(2000).optional(),
    waitFor: z.number().optional(),
  }).passthrough(),

  flow_generate_image: z.object({
    prompt: nonEmpty('prompt'),
    model: z.string().trim().max(100).optional(),
    auto_confirm: z.boolean().optional().default(false),
    ratio: z.string().trim().max(16).optional(),
    reference_images: z.array(z.string().max(1024)).max(8).optional(),
    ingredients: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    use_character: z.string().trim().max(200).optional(),
    use_scene: z.string().trim().max(200).optional(),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    quantity: z.number().int().min(1).max(4).optional(),
  }).passthrough(),

  flow_generate_video: z.object({
    prompt: nonEmpty('prompt').describe('Scene + action. Keep optics (lens/aperture/camera body) out — those are UI selectors.'),
    // Model names are dynamic (flow_list_models refreshes from Flow UI at launch).
    // Handler resolves against the live universe; unknown names fail with the live list.
    model: z.string().trim().min(1).max(100).optional().describe('Video model name (see flow_list_models) or auto. Fast-then-Quality: auto/Fast/Lite tests, Quality finals, Omni for fast vertical. Quality blocks ingredients/extend.'),
    ratio: z.enum(['16:9', '9:16']).optional().describe('Video aspect ratio.'),
    duration: z.union([z.enum(['4s', '6s', '8s', '10s']), z.number().int().min(1).max(30)]).optional().describe('Clip length. Ingredients require 8s.'),
    quality: z.enum(['360p', '720p']).optional().describe('Video resolution toggle in settings.'),
    camera: z.string().trim().max(300).optional().describe('Camera move in plain terms: push-in, pull-back, pan, tilt, orbit, tracking shot. Kept separate from subject motion.'),
    style: z.string().trim().max(300).optional().describe('Look/mood/lighting. Location/style refs should not contain extra subjects.'),
    start_frame: z.string().max(1024).optional().describe('Local image path for first-frame anchor (hero frame). Plain background preferred.'),
    end_frame: z.string().max(1024).optional().describe('Local image path for last-frame anchor. Shares lighting/framing with start frame.'),
    hero_frame: z.string().max(1024).optional().describe('Alias for start_frame: locked still (lighting/composition/face visible) before animate.'),
    shots: z.array(z.object({
      prompt: z.string().trim().min(1).max(2000),
      duration: z.union([z.enum(['4s', '6s', '8s', '10s']), z.number().int().min(1).max(30)]).optional(),
    }).passthrough()).max(6).optional().describe('Multi-shot plan (2-6). Each shot prepared in order; carry-forward anchor across shots.'),
    anchor_frame: z.string().max(1024).optional().describe('Strongest prior output frame carried as continuity anchor.'),
    reference_images: z.array(z.string().max(1024)).max(8).optional(),
    ingredients: z.array(z.string().trim().min(1).max(200)).max(3).optional().describe('Project @names (max 3, 8s only). Use flow_list_mention_options first.'),
    use_character: z.string().trim().max(200).optional(),
    use_scene: z.string().trim().max(200).optional(),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    quantity: z.number().int().min(1).max(4).optional().describe('Variants for compare-pick-refine; test at low res, re-render winner.'),
    auto_confirm: z.boolean().optional().default(false),
    confirm_generate: z.boolean().optional().default(false).describe('LIVE PAID CLICK. When true: verifies model chip, clicks Generate (spends credits), polls for the video. Default false = prepare-only.'),
    project_url: z.string().trim().max(2000).optional().describe('Direct Flow /project/ URL — wins over name/campaign matching.'),
  }).passthrough(),

  flow_create_character: z.object({
    name: nonEmpty('name'),
    description: nonEmpty('description'),
    archetype: z.string().trim().max(100).optional().describe('Starter card to pick first (The Eccentric, The Professional, The Wildcard, The Familiar, The Wicked, The Fantastical).'),
    reference_images: z.array(z.string().max(1024)).max(8).optional(),
    reference_image: z.string().max(1024).optional(),
    model: z.string().trim().max(100).optional(),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    auto_confirm: z.boolean().optional().default(false),
  }).passthrough(),

  flow_import_character: z.object({
    file_path: nonEmpty('file_path'),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
  }).passthrough(),

  flow_create_scene: z.object({
    prompt: nonEmpty('prompt').optional(),
    description: z.string().trim().min(1).max(8000).optional(),
    characters: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    reference_image: z.string().max(1024).optional(),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    auto_confirm: z.boolean().optional().default(false),
  }).passthrough().refine(
    (v) => (v.prompt && v.prompt.trim()) || (v.description && v.description.trim()),
    { message: 'prompt (or description) is required', path: ['prompt'] }
  ),

  flow_use_grid_architect: z.object({
    theme_prompt: nonEmpty('theme_prompt'),
    shot_prompts: z.array(z.string().trim().min(1).max(2000)).max(32).optional(),
    engine: z.string().trim().max(100).optional(),
    ratio: z.string().trim().max(16).optional(),
    visual_logic: z.string().trim().max(100).optional(),
    references: z.array(z.string().max(1024)).max(8).optional(),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    auto_confirm: z.boolean().optional().default(false),
  }).passthrough(),

  flow_use_tool: z.object({
    tool_name: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    params: z.record(z.string(), z.any()).optional(),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    auto_confirm: z.boolean().optional().default(false),
  }).passthrough().refine(
    (v) => (v.tool_name && v.tool_name.trim()) || (v.name && v.name.trim()),
    { message: 'tool_name is required', path: ['tool_name'] }
  ),

  flow_open: z.object({
    url: z.string().trim().max(2000).optional(),
    waitFor: z.number().optional(),
  }).passthrough(),

  flow_screenshot: z.object({
    name: z.string().trim().min(1).max(80).optional().default('manual'),
  }).passthrough(),

  flow_queue_status: z.object({
    history_limit: z.number().int().min(1).max(100).optional().default(5),
  }).passthrough(),

  project_scoped: z.object({
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    project_url: z.string().trim().max(2000).optional(),
  }).passthrough(),

  flow_create_project: z.object({
    name: z.string().trim().min(1).max(200).optional().describe('Name for the brand-new project (never reuses/renames an existing one).'),
    campaign: z.string().trim().max(200).optional(),
  }).passthrough(),

  flow_list_browser_targets: z.object({}).passthrough(),

  flow_list_projects: z.object({}).passthrough(),

  flow_generate_confirm: z.object({
    job_id: z.string().trim().min(1).max(64).optional().describe('Prepared ready_for_confirmation job to live-click Generate for.'),
    jobId: z.string().trim().min(1).max(64).optional(),
    max_credits: z.number().min(0).max(1000).optional().default(2).describe('Spend ceiling; quoted cost above this refuses (images ~0, Omni cheap, Veo ~20).'),
    wait_ms: z.number().int().min(15000).max(600000).optional().default(120000).describe('Post-click poll wait.'),
  }).passthrough().refine((v) => (v.job_id && v.job_id.trim()) || (v.jobId && v.jobId.trim()),
    { message: 'job_id is required', path: ['job_id'] }),

  flow_rename_character: z.object({
    name: z.string().trim().min(1).max(200).optional().describe('Current character name as shown on its card.'),
    character_id: z.string().trim().min(1).max(200).optional(),
    new_name: nonEmpty('new_name'),
    project_name: z.string().trim().max(200).optional(),
    campaign: z.string().trim().max(200).optional(),
    project_url: z.string().trim().max(2000).optional(),
  }).passthrough().refine((v) => (v.name && v.name.trim()) || (v.character_id && v.character_id.trim()),
    { message: 'name (or character_id) is required', path: ['name'] }),

  flow_story_create: z.object({
    storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'storyId must be a valid identifier').optional(),
    brief: z.record(z.string(), z.any()),
    binding: z.record(z.string(), z.any()).optional(),
    policy: z.record(z.string(), z.any()).optional(),
    governance: z.record(z.string(), z.any()).optional(),
    bible: z.record(z.string(), z.any()),
    scenes: z.array(z.record(z.string(), z.any())).optional(),
    shots: z.array(z.record(z.string(), z.any())).optional(),
    accountKey: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),

  flow_story_update: z.object({
    storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'storyId must be a valid identifier'),
    expectedRevision: z.number().int().min(1, 'expectedRevision must be a positive integer'),
    patch: z.record(z.string(), z.any()).optional(),
    accountKey: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),

  flow_story_status: z.object({
    storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'storyId must be a valid identifier'),
    accountKey: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),

  flow_story_review: z.object({
    storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'storyId must be a valid identifier'),
    expectedRevision: z.number().int().min(1, 'expectedRevision must be a positive integer'),
    nodeId: z.string().trim().min(1, 'nodeId is required'),
    nodeDigest: z.string().trim().min(1, 'nodeDigest is required'),
    reviewer: z.string().trim().min(1, 'reviewer is required'),
    decision: z.enum(['approve', 'reject', 'revise', 'reset']).optional(),
    notes: z.string().optional(),
    action: z.enum(['score_candidate', 'select_reference', 'reference_pack']).optional(),
    candidateId: exactId('candidateId', 64).optional(),
    candidateHash: exactId('candidateHash', 256).optional(),
    expectedReferenceRevision: z.number().int().min(0).optional(),
    expectedPackRevision: z.number().int().min(0).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    gates: z.record(z.string(), z.any()).optional(),
    ratings: z.record(z.string(), z.any()).optional(),
    confidences: z.record(z.string(), z.any()).optional(),
    rubricVersion: z.string().trim().min(1).max(100).optional(),
    weights: z.record(z.string(), z.any()).optional(),
    consideredCandidateIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  }).passthrough().superRefine((v, ctx) => {
    if (!v.action && v.decision === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'decision is required when no W09 action is given', path: ['decision'] });
    }
  }),

  flow_script_create: z.object({
    scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'scriptId must be a valid identifier').optional(),
    brief: z.record(z.string(), z.any()),
    binding: z.record(z.string(), z.any()).optional(),
    policy: z.record(z.string(), z.any()).optional(),
    governance: z.record(z.string(), z.any()).optional(),
    bible: z.record(z.string(), z.any()),
    scenes: z.array(z.record(z.string(), z.any())).optional(),
    shots: z.array(z.record(z.string(), z.any())).optional(),
    accountKey: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),

  flow_script_update: z.object({
    scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'scriptId must be a valid identifier'),
    expectedRevision: z.number().int().min(1, 'expectedRevision must be a positive integer'),
    patch: z.record(z.string(), z.any()).optional(),
    accountKey: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),

  flow_script_status: z.object({
    scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'scriptId must be a valid identifier'),
    accountKey: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),

  flow_script_review: z.object({
    scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'scriptId must be a valid identifier'),
    expectedRevision: z.number().int().min(1, 'expectedRevision must be a positive integer'),
    nodeId: z.string().trim().min(1, 'nodeId is required'),
    nodeDigest: z.string().trim().min(1, 'nodeDigest is required'),
    reviewer: z.string().trim().min(1, 'reviewer is required'),
    decision: z.enum(['approve', 'reject', 'revise', 'reset']).optional(),
    notes: z.string().optional(),
    action: z.enum(['score_candidate', 'select_reference', 'reference_pack']).optional(),
    candidateId: exactId('candidateId', 64).optional(),
    candidateHash: exactId('candidateHash', 256).optional(),
    expectedReferenceRevision: z.number().int().min(0).optional(),
    expectedPackRevision: z.number().int().min(0).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    gates: z.record(z.string(), z.any()).optional(),
    ratings: z.record(z.string(), z.any()).optional(),
    confidences: z.record(z.string(), z.any()).optional(),
    rubricVersion: z.string().trim().min(1).max(100).optional(),
    weights: z.record(z.string(), z.any()).optional(),
    consideredCandidateIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  }).passthrough().superRefine((v, ctx) => {
    // Conditional review contract (no parity exception): legacy no-action
    // review still requires a decision; typed W09 actions use reviewer/reason
    // instead of decision.
    if (!v.action && v.decision === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'decision is required when no W09 action is given', path: ['decision'] });
    }
  }),

  flow_script_run: z.object({
    scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    expectedRevision: z.number().int().min(1),
    stage: z.enum(['references', 'image-candidates', 'review-artifacts']),
    nodeId: exactId('nodeId', 128),
    nodeDigest: exactId('nodeDigest', 256),
    model: exactId('model', 100),
    ratio: z.enum(VALID_ASPECT_RATIOS),
    quantity: z.number().int().min(1).max(4),
    candidateLimit: z.number().int().min(1),
    timeBudgetSec: z.number().finite().positive(),
    source: z.enum(['local_import']).optional(),
    files: z.array(z.object({
      path: z.string().min(1).max(2048),
      rights: z.enum(['owned', 'licensed', 'synthetic', 'fair_use']),
      rightsNote: z.string().max(500).optional(),
    }).passthrough()).max(4).optional(),
    minWidth: z.number().int().min(1).optional(),
    minHeight: z.number().int().min(1).optional(),
    jobId: exactId('jobId', 64).optional(),
  }).passthrough(),
  flow_story_run: z.object({
    storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    expectedRevision: z.number().int().min(1),
    stage: z.enum(['references', 'image-candidates', 'review-artifacts']),
    nodeId: exactId('nodeId', 128),
    nodeDigest: exactId('nodeDigest', 256),
    model: exactId('model', 100),
    ratio: z.enum(VALID_ASPECT_RATIOS),
    quantity: z.number().int().min(1).max(4),
    candidateLimit: z.number().int().min(1),
    timeBudgetSec: z.number().finite().positive(),
    source: z.enum(['local_import']).optional(),
    files: z.array(z.object({
      path: z.string().min(1).max(2048),
      rights: z.enum(['owned', 'licensed', 'synthetic', 'fair_use']),
      rightsNote: z.string().max(500).optional(),
    }).passthrough()).max(4).optional(),
    minWidth: z.number().int().min(1).optional(),
    minHeight: z.number().int().min(1).optional(),
    jobId: exactId('jobId', 64).optional(),
  }).passthrough(),
  flow_script_resume: z.object({
    scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    jobId: exactId('jobId', 64),
    expectedRevision: z.number().int().min(1),
  }).passthrough(),
  flow_story_resume: z.object({
    storyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    jobId: exactId('jobId', 64),
    expectedRevision: z.number().int().min(1),
  }).passthrough(),
};

