// W09 candidate workflow fixtures — LOCAL ONLY, lane-local temp.
// Helper for dispatcher vertical slices: script plans, run args, synthetic
// image generation. All provenance is synthetic-local-fixture or local_import,
// never Flow-generated.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateFixtureImage } from './w09-image-fixtures.js';

export function w09LaneBaseDir() {
  const lane = path.join(process.cwd(), 'evidence', 'runtime-fixtures');
  try {
    fs.mkdirSync(lane, { recursive: true });
    return lane;
  } catch {
    const fallback = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function w09MkTemp(prefix) {
  const base = w09LaneBaseDir();
  return fs.mkdtempSync(path.join(base, prefix));
}

export function basePlan() {
  return {
    binding: { accountKey: 'filmmaker@example.com', projectId: 'w09_slice_proj' },
    policy: { candidateLimit: 4, timeBudgetSec: 3600, creditCap: 0, policyRevision: 1 },
    governance: { privacyMode: 'private', referenceRights: 'synthetic', reviewAuthority: 'client_human' },
    brief: { title: 'W09 Slice', aspectRatio: '16:9', fps: 24, targetDurationSec: 8 },
    bible: {
      characters: [
        { id: 'elena', name: 'Dr. Elena Vance', prompt: 'Cinematic portrait of Dr. Elena Vance' },
        { id: 'bob', name: 'Bob', prompt: 'Portrait of Bob the assistant' },
      ],
      locations: [{ id: 'lab', name: 'Subterranean Lab', prompt: 'Dark underground laboratory' }],
      props: [{ id: 'vial', name: 'Vial', prompt: 'Glass vial' }],
    },
    scenes: [{ id: 'sc1', title: 'Lab', locationId: 'lab' }],
    shots: [
      {
        id: 'sh1',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['bob'], props: ['vial'] },
        prompt: 'Bob inspecting the vial',
      },
      {
        id: 'sh2',
        sceneId: 'sc1',
        plannedSourceFrames: 192,
        trim: { inFrame: 0, outFrame: 192 },
        entities: { characters: ['elena'], props: [] },
        prompt: 'Elena observing the lab',
      },
    ],
  };
}

export function runArgs(scriptId, rev, nodeId, nodeDigest, overrides = {}) {
  return {
    scriptId,
    expectedRevision: rev,
    stage: 'image-candidates',
    nodeId,
    nodeDigest,
    model: 'Nano Banana 2',
    ratio: '1:1',
    quantity: 2,
    candidateLimit: 2,
    timeBudgetSec: 600,
    ...overrides,
  };
}

export async function ensureLocalImage(dir, name, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  await generateFixtureImage(full, { width: 64, height: 48, format: 'png', color: 'red', ...opts });
  return full;
}

export async function callTool(handleToolCall, name, args) {
  const raw = await handleToolCall(name, args);
  return JSON.parse(raw.content[0].text);
}
