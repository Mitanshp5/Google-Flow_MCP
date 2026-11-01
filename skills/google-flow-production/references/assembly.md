# Assembly and Delivery

## Existing MCP exporter boundary

`flow_export_reel` is a specialized exporter, not a general editor. Use it only when all of its current constraints are met: exactly three uniquely identified existing clips, observed Omni 1.1 Flash/360p settings, vertical framing, at least seven seconds per clip, and an audio track in each. It trims each clip to seven seconds and concatenates a 21-second 360-by-640 reel. It expects a supplied local FFmpeg executable with `ffprobe.exe` beside it, so this implementation is Windows-specific. Keep `prepare_only:true` until local export is requested. Its fixed output naming is not a generic campaign naming contract.

For any other timeline, use an explicitly planned local edit or return the reviewed source clips with an honest assembly limitation. This skill does not add an arbitrary-length exporter or automatically run FFmpeg.

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
