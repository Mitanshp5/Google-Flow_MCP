import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkFFmpegTools,
  probeVideo,
  extractLastFrame,
  concatVideos,
  assembleProduction,
} from '../scripts/assemble-video.mjs';

describe('Media Assembly and Frame Extraction (Milestone 6)', () => {
  const clip1 = path.resolve('outputs/browser-mcp-ad/clip1.mp4');
  const clip2 = path.resolve('outputs/browser-mcp-ad/clip2.mp4');
  const testOutputDir = path.resolve('temp-test-assembly');

  afterAll(() => {
    try {
      if (fs.existsSync(testOutputDir)) {
        fs.rmSync(testOutputDir, { recursive: true, force: true });
      }
    } catch { /* ok */ }
  });

  it('verifies that ffmpeg and ffprobe are available and operational', async () => {
    const tools = await checkFFmpegTools();
    expect(tools.ffmpeg).toBe(true);
    expect(tools.ffprobe).toBe(true);
    expect(tools.versions.ffmpeg).toBeTruthy();
    expect(tools.versions.ffprobe).toBeTruthy();
  });

  it('probes a video file and returns duration, resolution, and streams', async () => {
    const probe = await probeVideo(clip1);
    expect(probe.width).toBeGreaterThan(0);
    expect(probe.height).toBeGreaterThan(0);
    expect(probe.durationSec).toBeGreaterThan(0);
    expect(probe.codec).toBeTruthy();
    expect(probe.sizeBytes).toBeGreaterThan(0);
  });

  it('extracts the last frame robustly to a valid image file', async () => {
    const outFrame = path.join(testOutputDir, 'clip1_last_frame.png');
    const result = await extractLastFrame(clip1, outFrame);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
    expect(['frame_index', 'sseof', 'timestamp']).toContain(result.strategy);
  });

  it('concatenates two video clips into a single verified output file', async () => {
    const outVideo = path.join(testOutputDir, 'assembled.mp4');
    const result = await concatVideos([clip1, clip2], outVideo);

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.outputProbe.durationSec).toBeGreaterThan(0);
    expect(result.durationDelta).toBeLessThan(1.0);
    expect(result.clips.length).toBe(2);
  });

  it('runs assembleProduction and generates a structured manifest report', async () => {
    const outVideo = path.join(testOutputDir, 'production_reel.mp4');
    const reportPath = path.join(testOutputDir, 'assembly_report.json');

    const report = await assembleProduction({
      inputs: [clip1, clip2],
      output: outVideo,
      report: reportPath,
      extractFrames: true,
      framesDir: path.join(testOutputDir, 'frames'),
    });

    expect(report.output.path).toBe(outVideo);
    expect(report.verification.durationMatch).toBe(true);
    expect(report.extractedContinuationFrames.length).toBe(2);
    expect(fs.existsSync(reportPath)).toBe(true);

    const savedJson = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(savedJson.output.durationSec).toBe(report.output.durationSec);
  });
});

