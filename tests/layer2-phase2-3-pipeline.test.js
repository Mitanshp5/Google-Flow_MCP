import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateStoryInput } from '../src/script/schema.js';
import { buildStoryDag, extractSceneChains } from '../src/script/dag.js';
import {
  assembleProduction,
  probeVideo,
} from '../scripts/assemble-video.mjs';
import {
  VIDEO_REVIEW_WEIGHTS,
  evaluateVideoReview,
  extractVideoContactSheet,
} from '../src/media/video-reviewer.js';
import {
  buildVideoPrompt,
  formatTimestampBeats,
  isVeoModel,
} from '../src/utils/prompt.js';

const execFileAsync = promisify(execFile);

describe('Layer 2 Phase 2A: DAG-Integrated Scene Chaining & Entity Extensions', () => {
  const baseStory = () => ({
    binding: { accountKey: 'filmmaker@example.com', projectId: 'proj-chain' },
    brief: { title: 'Chained Story', aspectRatio: '16:9', fps: 24, targetDurationSec: 12 },
    bible: {
      characters: [
        {
          id: 'detective',
          name: 'Detective Vance',
          entityType: 'character',
          voiceDescription: 'gravelly exhausted baritone',
        },
      ],
      locations: [
        { id: 'alley', name: 'Rainy Alley', entityType: 'location' },
      ],
      props: [
        { id: 'sedan', name: 'Black 1970s Sedan', entityType: 'visual_asset' },
      ],
    },
    scenes: [
      { id: 'sc1', title: 'Arrival', locationId: 'alley' },
      { id: 'sc2', title: 'Discovery', locationId: 'alley' },
    ],
  });

  it('auto-wires parentShotId continuity dependency and detects scene chains accurately', () => {
    const story = {
      ...baseStory(),
      shots: [
        {
          id: 'sh1',
          sceneId: 'sc1',
          chainType: 'ROOT',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
          entities: { characters: ['detective'], props: ['sedan'] },
          expected_state_after: { props: { sedan: { holder: null, state: 'door_open' } } },
        },
        {
          id: 'sh2',
          sceneId: 'sc1',
          chainType: 'CONTINUATION',
          parentShotId: 'sh1',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
          continuity: {
            startFrameSource: 'sh1.lastFrame',
            transitionPrompt: 'Detective steps out of the sedan and shuts the door',
            verifiedContinuity: true,
          },
          expected_state_before: { props: { sedan: { holder: null, state: 'door_open' } } },
        },
        {
          id: 'sh3',
          sceneId: 'sc2',
          chainType: 'ROOT',
          plannedSourceFrames: 96,
          usableDurationSec: 4,
        },
      ],
    };

    const validated = validateStoryInput(story);
    const sh2 = validated.shots.find((s) => s.id === 'sh2');
    expect(sh2.dependencies).toContainEqual({ type: 'continuity', target: 'shot:sh1' });

    const dag = buildStoryDag(validated);
    expect(dag.getDependencies('shot:sh2').some((e) => e.source === 'shot:sh1' && e.type === 'continuity')).toBe(true);

    const chains = extractSceneChains(validated);
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({ segmentIndex: 0, isChain: true, verifiedChain: true, shotIds: ['sh1', 'sh2'] });
    expect(chains[1]).toMatchObject({ segmentIndex: 1, isChain: false, verifiedChain: false, shotIds: ['sh3'] });
  });

  it('rejects CONTINUATION without parentShotId, self-chaining, and state breaks across chains', () => {
    expect(() => validateStoryInput({
      ...baseStory(),
      shots: [{ id: 'sh1', sceneId: 'sc1', chainType: 'CONTINUATION', plannedSourceFrames: 96 }],
    })).toThrowError(/CONTINUATION shot sh1 requires parentShotId/);

    expect(() => validateStoryInput({
      ...baseStory(),
      shots: [{ id: 'sh1', sceneId: 'sc1', chainType: 'CONTINUATION', parentShotId: 'sh1', plannedSourceFrames: 96 }],
    })).toThrowError(/cannot chain to itself/);

    expect(() => validateStoryInput({
      ...baseStory(),
      shots: [
        {
          id: 'sh1',
          sceneId: 'sc1',
          chainType: 'ROOT',
          plannedSourceFrames: 96,
          expected_state_after: { props: { sedan: { state: 'locked' } } },
        },
        {
          id: 'sh2',
          sceneId: 'sc1',
          chainType: 'CONTINUATION',
          parentShotId: 'sh1',
          plannedSourceFrames: 96,
          expected_state_before: { props: { sedan: { state: 'door_open' } } },
        },
      ],
    })).toThrowError(/CONTINUITY_BREAK/);
  });
});

describe('Layer 2 Phase 2B & 2C: Continuity-Safe FFmpeg Assembly & Advisory Reviewer', () => {
  const clip1 = path.resolve('outputs/browser-mcp-ad/clip1.mp4');
  const clip2 = path.resolve('outputs/browser-mcp-ad/clip2.mp4');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-l2-media-'));

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('enforces continuity safeguard: suppresses skipLead on CONTINUATION shots while honoring it on ROOT shots', async () => {
    const outPath = path.join(tmpDir, 'continuity_safe.mp4');
    const report = await assembleProduction({
      inputs: [
        { path: clip1, chainType: 'ROOT' },
        { path: clip2, chainType: 'CONTINUATION', verifiedContinuity: true },
      ],
      output: outPath,
      skipLeadSec: 1.0,
      transition: 'auto',
    });

    expect(report.clips[0].effectiveSkipLeadSec).toBe(1.0);
    expect(report.clips[0].leadTrimSuppressedForContinuity).toBe(false);
    expect(report.clips[1].effectiveSkipLeadSec).toBe(0);
    expect(report.clips[1].leadTrimSuppressedForContinuity).toBe(true);
    expect(report.continuityReport.suppressedLeadTrims).toHaveLength(1);
    expect(report.continuityReport.segmentCount).toBe(1); // Hard cut within chain segment
    expect(report.audioStrategy.audioFormat).toBe('48kHz stereo AAC');
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('applies xfade across independent ROOT shots and supports narration audio ducking', async () => {
    // Synthesize a short 4s mono 24kHz WAV narration tone via ffmpeg to test resampling & ducking
    const narrWav = path.join(tmpDir, 'narr_24k.wav');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-ar', '24000', '-ac', '1', narrWav,
    ]);

    const xfadeOut = path.join(tmpDir, 'xfade_ducked.mp4');
    const report = await assembleProduction({
      inputs: [
        { path: clip1, chainType: 'ROOT' },
        { path: clip2, chainType: 'ROOT' },
      ],
      output: xfadeOut,
      transition: 'auto',
      xfadeDuration: 0.4,
      narration: narrWav,
      sfxVolume: 0.3,
      narrationVolume: 1.2,
    });

    expect(report.continuityReport.segmentCount).toBe(2); // Independent segments joined with xfade
    expect(report.audioStrategy.narrationMixed).toBe(true);
    expect(report.audioStrategy.sfxVolumeDuck).toBe(0.3);
    expect(report.output.hasAudio).toBe(true);

    const probed = await probeVideo(xfadeOut);
    expect(probed.audioSampleRate).toBe('48000');
  });

  it('normalizes reviewer weights strictly to 1.00 (100%) and enforces advisory governance', async () => {
    const sum = Object.values(VIDEO_REVIEW_WEIGHTS).reduce((acc, w) => acc + w, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1.0);

    const evalGood = evaluateVideoReview({
      shotId: 'sh1',
      dimensions: {
        character_consistency: 9.0,
        prompt_adherence: 8.0,
        motion_quality: 8.5,
        temporal_coherence: 8.0,
        visual_fidelity: 9.0,
        composition: 8.0,
      },
    });
    expect(evalGood.overallScore).toBe(8.45);
    expect(evalGood.verdict).toBe('good');
    expect(evalGood.advisoryOnly).toBe(true);
    expect(evalGood.requiresAuthorizationForRegen).toBe(true);

    const evalDrift = evaluateVideoReview({
      shotId: 'sh2',
      dimensions: {
        character_consistency: 4.0,
        prompt_adherence: 5.0,
        motion_quality: 3.5,
        temporal_coherence: 4.0,
        visual_fidelity: 6.0,
        composition: 6.0,
      },
      findings: [
        { severity: 'CRITICAL', description: 'Severe face morph and limb drift mid-clip' },
        { severity: 'HIGH', description: 'Watermark text on screen in corner' },
      ],
    });
    expect(evalDrift.verdict).toBe('poor');
    expect(evalDrift.fixGuide.advisoryOnly).toBe(true);
    expect(evalDrift.fixGuide.detectedIssues).toContain('drift');
    expect(evalDrift.fixGuide.detectedIssues).toContain('text_logo');
    expect(evalDrift.fixGuide.suggestedAction).toMatch(/steady camera/i);
  });

  it('generates an FFmpeg contact sheet and key frames for advisory video review', async () => {
    const sheetPath = path.join(tmpDir, 'review_sheet.png');
    const res = await extractVideoContactSheet(clip1, sheetPath, {
      cols: 3,
      rows: 2,
      thumbWidth: 240,
      extractKeyFrames: true,
    });

    expect(res.advisoryOnly).toBe(true);
    expect(fs.existsSync(res.contactSheetPath)).toBe(true);
    expect(res.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(res.keyFrames.first)).toBe(true);
    expect(fs.existsSync(res.keyFrames.mid)).toBe(true);
    expect(fs.existsSync(res.keyFrames.last)).toBe(true);
  });
});

describe('Layer 2 Phase 3: Model-Aware Prompt Scaffolding', () => {
  it('detects Veo models vs non-Veo models and selectively injects audio tags only when supported', () => {
    expect(isVeoModel('Veo 3.1 - Fast')).toBe(true);
    expect(isVeoModel('Omni Flash')).toBe(false);

    const audioOpts = {
      sfx: 'heavy rain on glass',
      ambient: 'distant traffic hum',
      voiceProfiles: [{ name: 'Vance', voiceDescription: 'low gravelly baritone' }],
    };

    const veoPrompt = buildVideoPrompt({
      subject: 'Detective Vance',
      prompt: 'Vance whispers into his radio',
      setting: 'Dark rainy alleyway at night',
      camera: 'slow push-in',
      style: 'neo-noir',
      model: 'Veo 3.1 - Fast',
      audio: audioOpts,
      includeStandardNegative: true,
    });
    expect(veoPrompt).toContain('Character voices: Vance: low gravelly baritone.');
    expect(veoPrompt).toContain('SFX: heavy rain on glass.');
    expect(veoPrompt).toContain('Audio: distant traffic hum.');
    expect(veoPrompt).toContain('Negative: subtitles, captions');

    const nonVeoPrompt = buildVideoPrompt({
      subject: 'Detective Vance',
      prompt: 'Vance whispers into his radio',
      camera: 'slow push-in',
      model: 'Omni Flash',
      audio: audioOpts,
    });
    expect(nonVeoPrompt).not.toContain('Character voices:');
    expect(nonVeoPrompt).not.toContain('SFX:');
    expect(nonVeoPrompt).not.toContain('Audio:');
    expect(nonVeoPrompt).not.toContain('Negative:');
  });

  it('formats multi-shot timestamp beats onto a clean single line', () => {
    const formatted = formatTimestampBeats([
      { start: '00:00', end: '00:02', description: 'Wide establishing shot\nin rain' },
      { start: '00:02', end: '00:05', description: 'Close-up on detective eyes' },
    ]);
    expect(formatted).toBe('[00:00-00:02] Wide establishing shot in rain [00:02-00:05] Close-up on detective eyes');
    expect(formatted).not.toContain('\n');
  });
});
