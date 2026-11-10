# Assembly and Delivery

## Assembly is local-only

There is no MCP editor or exporter tool. Assembly of reviewed clips is a local, separately authorized operation. Use a local edit only when it is explicitly approved; otherwise return the verified source clips with an honest assembly limitation. This skill does not add an arbitrary-length exporter or automatically run FFmpeg.

## Scripted Media Assembly Helper

A cross-platform helper is provided at `scripts/assemble-video.mjs` to automate FFprobe clip probing, robust last-frame extraction with frame-index fallback, and concat verification:

```bash
# Example invocation
node scripts/assemble-video.mjs --inputs clip1.mp4 clip2.mp4 clip3.mp4 --output final_cut.mp4 --extract-frames --report assembly_report.json
```

The script verifies:
1. Every input has a valid decodable video stream via FFprobe.
2. Extracts continuation frames into a named directory with size and format verification.
3. Normalizes and concatenates into H.264 / AAC MP4.
4. Confirms final duration matches expected clip sum within ±1.0s.
5. Emits a structured JSON report documenting clip inputs, output dimensions, audio layout, and frame continuity paths.

## Plan a local edit

1. Preserve each original verified download. Work on separate named copies in an approved output directory.
2. Confirm `ffmpeg` and `ffprobe` are available using the terminal tool. Do not install dependencies without authorization. Invoke executable argument arrays, not user-interpolated shell strings.
3. Probe every real input with FFprobe JSON output. Check that it is the intended video and record width, height, duration, codecs, frame rate, audio presence, and audio format. Reject missing/corrupt inputs. Validate requested trim ranges against actual duration.
4. Write an ordered edit plan that names each clip, trim range, intended output framing, and optional B-roll position. B-roll should replace a planned interval when the final duration must stay fixed; simply inserting it lengthens the edit. Obtain approval for crop/pad choices, silent gaps, extra generation, music, captions, or voiceover if not already in scope.
5. Stream-copy concatenation is appropriate only for matching stream layouts, codecs/parameters, resolution, time base, and audio configuration. Otherwise explicitly normalize scale/padding, sample aspect ratio, frame rate/time base, pixel format, and audio rate/channels into intermediate clips before concatenation. Selecting a different output codec alone does not normalize arbitrary inputs. Use controlled staging filenames and validate/escape any concat list; do not paste untrusted paths into shell commands.
6. For silent inputs, retain silence deliberately or add an approved audio source; do not claim a voiceover exists. Check rights for music and other supplied media. Save to a new output path and do not overwrite originals.

## Verify the final artifact

Probe the actual output and compare measured duration, dimensions, codecs, frame rate, and audio status with the approved delivery specification. A successful FFmpeg exit is not sufficient. Play it back to inspect every cut, face/product continuity, framing, readable text, pacing, dialogue, audible joins, and any music or captions. If playback review cannot be performed, say it remains unverified.

Deliver the actual final file path, actual measured duration and dimensions, and a short statement of remaining limitations. Do not call the result finished when only a plan, local queue completion, unreviewed source files, or a command template exists. Record source-to-output mapping and review results in the asset manifest.
