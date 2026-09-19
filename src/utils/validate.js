import { z } from 'zod';
import { FlowError, ErrorCodes } from './errors.js';

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

export const schemas = {
  flow_connect: z.object({
    headless: z.boolean().optional().default(false),
    open_flow: z.boolean().optional().default(true),
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
};
