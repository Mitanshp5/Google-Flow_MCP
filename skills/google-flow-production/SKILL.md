---
name: google-flow-production
description: "Use when producing videos with Google Flow MCP."
version: 0.1.0
author: Mitansh Prajapati, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Google-Flow, Video, Creative-Direction, Production]
---

# Google Flow Production

Turn an approved brief into a shot plan, consistent reference assets, verified clips, and a reviewed edit using the Google Flow MCP. This is an agent workflow, not a new MCP tool or an unattended renderer. Existing browser verification and credit controls remain authoritative.

## When to Use

- Produce a product video, creator-led ad, brand story, cinematic sequence, or social clip.
- Improve shot prompts, continuity, reference selection, or the final edit.
- Do not use for publishing ads, buying media, bypassing account restrictions, or promising rendering features that Flow has not verified.

## Prerequisites

- This project's MCP is registered in the agent client; Chrome is signed in to the intended account.
- The agent can read this file and its relative references. Read it explicitly in clients that do not discover repository skills automatically.
- Reference assets are owned, licensed, or otherwise authorized for this use; real-person likenesses require appropriate consent.
- FFmpeg and FFprobe are optional local dependencies for assembly. They are not included, installed, or invoked automatically by this skill.

## Procedure

1. Capture the brief using [the brief template](templates/brief.md). Reuse facts already supplied; ask only for missing decisions that change the result. Confirm objective, audience, product/subject, truthful claims, offer, tone, persona, setting, target length, platform, framing, delivery requirements, and a total credit ceiling. Do not invent testimonials, metrics, scarcity, or product properties. Completion: the user approves the brief; production approval alone is not spending authorization.
2. Establish the browser and project using [the tool contract](references/flow-tools.md). Confirm the account with positive evidence, choose a new or existing project explicitly, and record its URL. Refresh the live model catalog; distinguish observed options from cache, configuration, and fallback entries. Intersect the requested settings with the tool schema and the selected model's verified UI capabilities. Completion: account/project are known and the proposed settings have a supported path; unknown capabilities remain blockers.
3. Pick one primary style from [style selection](references/style-selection.md); optionally use one additional style for a specific beat. Load only those cards. They supply creative vocabulary, never model capabilities. Completion: each chosen style has an explicit role in the plan.
4. Create a beat sheet using [the shot template](templates/shot-plan.md). Separate narrative beats from generated clips. Plan each clip around one clear action; fit spoken lines to the available time. Derive clip count and trim ranges from verified supported durations, not a fixed provider limit. Include transition handles in the source duration. Use a calculation tool for timing totals. Completion: the approved shot plan specifies references, camera, look, dialogue, source duration, edit range, and expected continuity for every shot.
5. Prepare and review the subject, product, and location references using [continuity guidance](references/continuity.md). Prefer real product photos where accuracy matters. Generate additional views only when needed and authorized. Flow characters, project ingredients, and frame conditioning are different mechanisms, not interchangeable identity guarantees. Completion: every shot's reference set is selected, rights are recorded, and required attachments or frame roles can be positively verified.
6. Write individual shot prompts using [prompt craft](references/prompt-craft.md), then prepare one shot at a time. The [tool-call examples](templates/tool-calls.json) are schema examples, not executable promises: replace sample model names, paths, IDs, and URLs with observed values. Keep `auto_confirm:false` and `confirm_generate:false` during preparation. Completion: the returned settings and full reference set match the approved shot; `prepared_unverified`, missing evidence, or failed references are not ready.
7. Obtain explicit authorization for spending within the agreed budget. Prefer `flow_generate_confirm` for the exact immediately prepared `ready_for_confirmation` job, with an explicit `max_credits` ceiling. Confirm it before preparing a different shot or changing the page/composer. The MCP must reverify its preparation and quote. A known quote and sufficient remaining project budget are still required, even with user approval. Completion: one authorized submission is recorded; ambiguous outcomes retain their exposure and are inspected, never blindly retried.
8. Inspect remote completion before downloading. Queue completion or a submitted job is not proof a render exists. Use exact returned asset choices when ordering is ambiguous; never equate the first tile with the newest render. Download using `flow_download_latest`, retain its verified original, and record its identity and local path in [the asset manifest](templates/asset-manifest.json). Completion: each selected clip is a real verified local file, inspected for identity, product accuracy, motion, framing, and audio.
9. Assemble only reviewed clips following [assembly and delivery](references/assembly.md). The existing `flow_export_reel` has a restricted contract; do not present it as an arbitrary timeline editor. General local editing requires a separately specified, authorized FFmpeg invocation and input validation. Completion: FFprobe confirms actual output properties, playback confirms visual/audio continuity, and the user receives the actual final path plus any remaining limitations.

## Pitfalls

- Never send provider placeholder syntax, fictional element IDs, or invented tool names to Flow.
- Video currently advertises `16:9` and `9:16`, durations `4s`, `6s`, `8s`, `10s`, and quality `360p`/`720p`. These are schema bounds, not proof every model supports every combination. Unsupported delivery ratios require an approved edit or a different plan, not silent cropping.
- Frames and Ingredients are separate video modes. Do not combine `start_frame`/`end_frame`/`hero_frame`/`anchor_frame` with `ingredients`, `use_character`, `use_scene`, or uploaded `reference_images` in one call. At most three collected project mention names are accepted for video. Do not silently replace a requested duration or reference mode.
- `flow_list_mention_options` can affect the composer. Discover names before preparing a shot; if discovery invalidates a prepared state, prepare it again.
- `flow_script_*` provides local planning and candidate import/review. `flow_script_run` is not an autonomous paid video pipeline.
- Local approval, a prepared prompt, a credit reservation, a remote submission, and a completed render are different states. Report them separately.
- Generated dialogue, readable logos, exact typography, and beat synchronization are requests to review, not guarantees. Use authorized post-production for precise requirements.

## Verification

- Every approved shot has settings/reference read-back or is explicitly blocked; no unknown state is labeled ready.
- Each submission has authorization, a known bounded quote, and accounted-for budget exposure; no safeguard is weakened or reset to fit a plan.
- Each downloaded file is tied to the intended project and selected asset, not inferred from grid position.
- The final artifact has measured duration, dimensions, codecs, and audio status; playback review is separate from metadata inspection.
- Report only what actually exists: prepared plan, verified source clips, or finished edit. Name unfinished stages plainly.
- Developer checks: `terminal(command="npm run test -- tests/production-skill.test.js")` checks documentation links, bundled style cards, safe example/schema compatibility, packaging declaration, and notices. It does not certify live generation or visual quality.
