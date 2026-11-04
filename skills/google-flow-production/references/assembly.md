# Assembly and Delivery

## Assembly is local-only

There is no MCP editor or exporter tool. Assembly of reviewed clips is a local, separately authorized operation. Use a local edit only when it is explicitly approved; otherwise return the verified source clips with an honest assembly limitation. This skill does not add an arbitrary-length exporter or automatically run FFmpeg.

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
