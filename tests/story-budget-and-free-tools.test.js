import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/browser/connect.js', () => ({
  getPage: () => globalThis.__budgetFakePage,
}));

vi.mock('../src/browser/safe-actions.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    openBarSettings: async () => ({
      panel: {
        evaluate: async () => (globalThis.__budgetCostText ? [globalThis.__budgetCostText] : []),
      },
    }),
    isVerifiedSettingsPanel: async () => ({ isSettings: true }),
    closeSettingsPanel: async () => true,
    findActionButton: async () => ({
      locator: {
        isDisabled: async () => false,
        click: async () => { globalThis.__budgetConfirmClicks += 1; },
      },
    }),
  };
});

vi.mock('../src/utils/screenshots.js', () => ({
  takeScreenshot: async () => null,
}));

vi.mock('../src/browser/character-form.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    waitForCharacterPortrait: async () => ({ assetId: 'char-portrait-001', width: 1024, height: 1024, verified: true }),
  };
});

vi.mock('../src/navigation/character-rename.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    renameCharacterTitle: async () => true,
  };
});

import { handleToolCall } from '../src/index.js';
import { initRuntimeDirs } from '../src/storage/runtime-store.js';
import { jobQueue } from '../src/queue/job-queue.js';
import { handleGenerateConfirm } from '../src/tools/generate-confirm.js';
import {
  DEFAULT_STORY_BUDGET_CREDITS,
  estimateShotCredits,
  evaluateStoryBudget,
} from '../src/script/budget.js';
import { getReservedProjectCredits, reserveProjectCredits } from '../src/utils/project-credit-budget.js';

function makeConfirmFakePage({
  url = 'https://flow.google.com/project/proj_story_budget',
  account = 'creator@example.com',
  costText = '20 credits total',
  insufficientCreditsVisible = false,
  characterDescription = '',
  characterModel = 'Nano Banana 2',
  baseline = { count: 1, ids: ['old-1'], tiles: ['t1'] },
  after = { count: 2, ids: ['old-1', 'new-2'], tiles: ['t1', 't2'] },
} = {}) {
  globalThis.__budgetCostText = costText;
  let snapCount = 0;
  return {
    url: () => url,
    content: async () => `<span data-account-email="${account}">${account}</span>`,
    getByText: (re) => ({
      first: () => ({
        isVisible: async () => insufficientCreditsVisible && re instanceof RegExp && re.test('Not enough credits'),
      }),
    }),
    locator: (sel) => {
      if (String(sel).includes('Describe your character')) {
        return {
          first: () => ({
            isVisible: async () => true,
            evaluate: async () => characterDescription,
            innerText: async () => characterDescription,
            textContent: async () => characterDescription,
            inputValue: async () => characterDescription,
          }),
        };
      }
      if (String(sel).includes('Select model family')) {
        return {
          innerText: async () => characterModel,
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
      };
    },
    evaluate: async (fn) => {
      const src = String(typeof fn === 'function' ? fn.toString() : fn);
      if (src.includes('credits')) return costText;
      snapCount += 1;
      return snapCount === 1 ? { ...baseline } : { ...after };
    },
    waitForTimeout: async () => {},
  };
}

describe('Story Credit Budget Allocation & Free Non-Video Tools', () => {
  let tmpDir;
  let origHome;

  beforeEach(() => {
    origHome = process.env.FLOW_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-story-budget-'));
    process.env.FLOW_HOME = tmpDir;
    initRuntimeDirs(tmpDir);
    jobQueue.reset();
    globalThis.__budgetConfirmClicks = 0;
    delete globalThis.__budgetFakePage;
    delete globalThis.__budgetCostText;
  });

  afterEach(() => {
    jobQueue.reset();
    delete globalThis.__budgetFakePage;
    delete globalThis.__budgetCostText;
    if (origHome !== undefined) process.env.FLOW_HOME = origHome;
    else delete process.env.FLOW_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function callTool(name, args) {
    const res = await handleToolCall(name, args);
    return JSON.parse(res.content[0].text);
  }

  function buildStoryInput(shots, extra = {}) {
    return {
      binding: { accountKey: 'creator@example.com', projectId: 'proj_story_budget' },
      brief: { title: 'Skyline Chase', aspectRatio: '16:9', fps: 24, targetDurationSec: 16 },
      bible: {
        characters: [{ id: 'hero', name: 'Hero', prompt: 'Hero portrait' }],
        locations: [{ id: 'roof', name: 'Rooftop', prompt: 'Night rooftop' }],
        props: [],
      },
      scenes: [{ id: 'sc1', title: 'Rooftop Run', locationId: 'roof' }],
      shots,
      ...extra,
    };
  }

  it('defaults story allocatedBudget to 50 credits, calculates video requirements, and asks user before spending when over 50', async () => {
    expect(DEFAULT_STORY_BUDGET_CREDITS).toBe(50);

    // 4 shots on Veo 3.1 - Fast -> 4 * 20 = 80 credits > 50 default
    const fourVeoShots = [1, 2, 3, 4].map((n) => ({
      id: `sh${n}`,
      sceneId: 'sc1',
      model: 'Veo 3.1 - Fast',
      plannedSourceFrames: 96,
      trim: { inFrame: 0, outFrame: 96 },
      prompt: `Action beat ${n}`,
    }));

    const created = await callTool('flow_script_create', buildStoryInput(fourVeoShots));
    expect(created.budget.defaultAllocatedCredits).toBe(50);
    expect(created.budget.allocatedCredits).toBe(50);
    expect(created.budget.allocationSource).toBe('default_50');
    expect(created.budget.estimatedRequiredCredits).toBe(80);
    expect(created.budget.shortfallCredits).toBe(30);
    expect(created.budget.exceedsAllocatedBudget).toBe(true);
    expect(created.budget.exceedsDefault50).toBe(true);
    expect(created.budget.canSpendVideoCredits).toBe(false);
    expect(created.budget.imageAndCharacterCredits).toBe(0);
    expect(created.budget.question).toMatch(/80 credits/i);
    expect(created.budget.question).toMatch(/50 credits/i);
    expect(created.nextActions[0]).toMatchObject({
      action: 'confirm_story_budget',
      priority: 'critical',
      requiredCredits: 80,
      allocatedCredits: 50,
    });

    // Updating allocatedBudget increases the cap without invalidating nodes
    const updated = await callTool('flow_script_update', {
      scriptId: created.scriptId,
      expectedRevision: created.revision,
      allocatedBudget: 100,
    });
    expect(updated.budget.allocatedCredits).toBe(100);
    expect(updated.budget.allocationSource).toBe('explicit_allocated_budget');
    expect(updated.budget.exceedsAllocatedBudget).toBe(false);
    expect(updated.budget.canSpendVideoCredits).toBe(true);
    expect(updated.invalidations.invalidatedNodeIds).toEqual([]);

    const status = await callTool('flow_script_status', { scriptId: created.scriptId });
    expect(status.allocatedBudget).toBe(100);
    expect(status.estimatedRequiredCredits).toBe(80);
    expect(status.budget.canSpendVideoCredits).toBe(true);
  });

  it('refuses even the very first video spend BEFORE spending a single credit when story calculation exceeds default 50 budget', async () => {
    const heavyShots = [1, 2, 3].map((n) => ({
      id: `sh${n}`,
      sceneId: 'sc1',
      model: 'Veo 3.1 - Fast',
      plannedSourceFrames: 96,
      trim: { inFrame: 0, outFrame: 96 },
      prompt: `Heavy shot ${n}`,
    })); // 3 * 20 = 60 credits > 50

    const created = await callTool('flow_script_create', buildStoryInput(heavyShots));
    expect(created.estimatedRequiredCredits).toBe(60);

    // Prepare first shot (quoted 20 credits <= 50, yet story total is 60 > 50!)
    const videoPrep = jobQueue.createJob('video_generation', { prompt: 'Shot 1' });
    jobQueue.startJob(videoPrep.id);
    jobQueue.completeJob(videoPrep.id, {
      status: 'ready_for_confirmation',
      type: 'video',
      model_used: 'Veo 3.1 - Fast',
      quantity: 1,
      settings_verification: { verified: true },
    });

    globalThis.__budgetFakePage = makeConfirmFakePage({ costText: '20 credits total' });

    // Even WITHOUT passing scriptId manually, projectId auto-binds to proj_story_budget
    // and blocks BEFORE clicking Generate or reserving a single credit!
    await expect(
      handleGenerateConfirm({ job_id: videoPrep.id, wait_ms: 1000 })
    ).rejects.toThrow(/requires an estimated 60 video credits.*allocated budget of 50 credits/i);

    expect(globalThis.__budgetConfirmClicks).toBe(0);
    expect(getReservedProjectCredits({ account: 'creator@example.com', projectId: 'proj_story_budget' })).toBe(0);

    // Approve allocatedBudget=75 -> now first video confirm succeeds AND spends past 50 when approved!
    await callTool('flow_script_update', {
      scriptId: created.scriptId,
      expectedRevision: 1,
      patch: { allocatedBudget: 75 },
    });

    const okFirst = await handleGenerateConfirm({ job_id: videoPrep.id, wait_ms: 1000 });
    expect(globalThis.__budgetConfirmClicks).toBe(1);
    expect(okFirst.quote.total).toBe(20);
    expect(getReservedProjectCredits({ account: 'creator@example.com', projectId: 'proj_story_budget' })).toBe(20);

    // Reserve two more shots (20 + 20 = 60 total > 50 default, allowed under 75 allocated budget!)
    for (const label of ['shot2', 'shot3']) {
      const p = jobQueue.createJob('video_generation', { prompt: label });
      jobQueue.startJob(p.id);
      jobQueue.completeJob(p.id, {
        status: 'ready_for_confirmation',
        type: 'video',
        model_used: 'Veo 3.1 - Fast',
        quantity: 1,
      });
      await handleGenerateConfirm({ job_id: p.id, wait_ms: 1000, scriptId: created.scriptId });
    }
    expect(getReservedProjectCredits({ account: 'creator@example.com', projectId: 'proj_story_budget' })).toBe(60);

    // 4th shot (20 more -> 80 > 75) must refuse BEFORE clicking
    const p4 = jobQueue.createJob('video_generation', { prompt: 'shot4' });
    jobQueue.startJob(p4.id);
    jobQueue.completeJob(p4.id, {
      status: 'ready_for_confirmation',
      type: 'video',
      model_used: 'Veo 3.1 - Fast',
      quantity: 1,
    });
    const clicksBeforeBlocked = globalThis.__budgetConfirmClicks;
    await expect(
      handleGenerateConfirm({ job_id: p4.id, wait_ms: 1000, scriptId: created.scriptId })
    ).rejects.toThrow(/allocated budget of 75 credits exceeded: 60 reserved \+ 20 quoted/i);
    expect(globalThis.__budgetConfirmClicks).toBe(clicksBeforeBlocked);
  });

  it('never blocks free image or character generation due to credit limits, exhausted budgets, missing quotes, or insufficient-credit warnings', async () => {
    // Exhaust project video credit cap completely (50/50 reserved) AND show insufficient credits banner
    reserveProjectCredits({
      account: 'creator@example.com',
      projectId: 'proj_exhausted',
      operationId: 'video:past',
      credits: 50,
    });

    // 1) Image generation confirms freely even with insufficient_credits banner, no quote, max_credits: 0, 50/50 spent
    const imgPrep = jobQueue.createJob('image_generation', { prompt: 'Free portrait' });
    jobQueue.startJob(imgPrep.id);
    jobQueue.completeJob(imgPrep.id, {
      status: 'ready_for_confirmation',
      type: 'image',
      model_used: 'Nano Banana 2',
      quantity: 1,
      settings_verification: { verified: true },
    });

    globalThis.__budgetFakePage = makeConfirmFakePage({
      url: 'https://flow.google.com/project/proj_exhausted',
      costText: null,
      insufficientCreditsVisible: true,
    });

    const imgRes = await handleGenerateConfirm({ job_id: imgPrep.id, max_credits: 0, wait_ms: 1000 });
    expect(globalThis.__budgetConfirmClicks).toBe(1);
    expect(imgRes.status).toBe('output_detected');
    expect(imgRes.quote).toMatchObject({ total: 0, state: 'free' });
    expect(getReservedProjectCredits({ account: 'creator@example.com', projectId: 'proj_exhausted' })).toBe(50);

    // 2) Character creation confirms freely WITHOUT freeCharacterImages config even when video cap exhausted
    const charDesc = 'Vesper — original female action character.';
    const charPrep = jobQueue.createJob('create_character', { prompt: charDesc });
    jobQueue.startJob(charPrep.id);
    jobQueue.completeJob(charPrep.id, {
      status: 'ready_for_confirmation',
      type: 'character',
      name: 'Vesper',
      description: charDesc,
      prompt: charDesc,
      model_used: 'Nano Banana 2',
      project_url: 'https://flow.google.com/project/proj_exhausted/character',
    });

    globalThis.__budgetFakePage = makeConfirmFakePage({
      url: 'https://flow.google.com/project/proj_exhausted/character',
      costText: null,
      insufficientCreditsVisible: true,
      characterDescription: charDesc,
      characterModel: 'Nano Banana 2',
    });

    const charRes = await handleGenerateConfirm({ job_id: charPrep.id, max_credits: 0, wait_ms: 1000 });
    expect(globalThis.__budgetConfirmClicks).toBe(2);
    expect(charRes.status).toBe('completed');
    expect(charRes.quote).toMatchObject({ total: 0, state: 'free' });
    expect(charRes.naming).toMatchObject({ requested: 'Vesper', verified: true });
    expect(getReservedProjectCredits({ account: 'creator@example.com', projectId: 'proj_exhausted' })).toBe(50);
  });

  it('estimates per-shot credits across models, quantities, and explicit shot overrides', () => {
    expect(estimateShotCredits({ id: 'a', model: 'Veo 3.1 - Quality', quantity: 2 }).estimatedCredits).toBe(100);
    expect(estimateShotCredits({ id: 'b', model: 'Veo 3.1 - Lite', quantity: 1 }).estimatedCredits).toBe(20);
    expect(estimateShotCredits({ id: 'c', model: 'Omni 1.1 Flash', quantity: 3 }).estimatedCredits).toBe(30);
    expect(estimateShotCredits({ id: 'd', estimatedCredits: 15, quantity: 2 }).estimatedCredits).toBe(30);

    const report = evaluateStoryBudget({
      brief: { title: 'Test' },
      shots: [{ id: 'a', model: 'Omni 1.1 Flash', quantity: 2 }],
    });
    expect(report.estimatedRequiredCredits).toBe(20);
    expect(report.allocatedCredits).toBe(50);
    expect(report.canSpendVideoCredits).toBe(true);
  });
});
