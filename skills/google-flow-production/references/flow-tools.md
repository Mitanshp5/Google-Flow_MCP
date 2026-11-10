# Google Flow Tool Contract

Use the tool definitions exposed by the connected server, not names copied from a prompt guide. This reference describes the repository's current contract; if the installed server differs, inspect its advertised schema and stop on incompatible requirements.

## Session and project

1. `flow_list_browser_targets` discovers existing CDP endpoints without launching a browser.
2. `flow_connect` accepts `cdpPort` for reuse; do not launch another profile unnecessarily.
3. `flow_account_check` must positively identify the intended account. Missing evidence is not approval.
4. For a new campaign, `flow_create_project` returns a new project. For an existing one, use its exact URL with `flow_open` and verify `flow_status`. Never create or rename a project merely to download an existing asset.
5. `flow_list_models` with `refresh:true` refreshes discovery. A merged list can also contain configured or fallback names; inspect provenance and exact selected UI settings. `probe_capabilities:true` is optional and requires refresh; it changes settings temporarily. Run discovery before shot preparation.

## Preparation

### Tool Selection Matrix

| User intent | Correct operation |
|---|---|
| Create a visual reference sheet of a character | `flow_generate_image` |
| Create a reusable native Google Flow Character | `flow_create_character` |
| Inspect registered project characters | `flow_open_characters` |
| Rename a generated Flow Character | `flow_rename_character` |
| List exact `@` references available in the project | `flow_list_mention_options` |
| Generate a video shot | `flow_generate_video` |
| Submit a prepared paid generation | `flow_generate_confirm` |
| Download a completed exact asset | `flow_download_latest` with `asset_id` where needed |

- `flow_generate_image`: `prompt`, `model`, `ratio`, `reference_images`, `ingredients`, `use_character`, `use_scene`, `project_name`, `campaign`, `auto_confirm:false`, and optionally `max_credits`. Open the intended project first; the image tool does not advertise `project_url`.
- `flow_create_character`: `name`, `description`, optional `archetype`/`reference_images`, `project_name`, `campaign`, and `auto_confirm:false`. Use its advertised fields only. Open and verify the project first; do not assume image-model or project-URL fields are advertised for this tool.
- `flow_list_mention_options`: discover actual project reference names before preparing generation. Use names exactly as returned, not fabricated IDs. Its advertised scope fields are `project_name` and `campaign`; verify the active project rather than relying on an unadvertised URL argument.
- `flow_generate_video`: `prompt`, `model`, `ratio`, `duration`, `quality`, `camera`, `style`, `quantity`, `project_url`, `auto_confirm:false`, and `confirm_generate:false`. Choose either Frames or Ingredients per shot.
- Frames: use local `start_frame` and optionally `end_frame`. `hero_frame` aliases the start; `anchor_frame` is a fallback start, not a second independent anchor. Required slots must be verified.
- Ingredients: use existing exact names in `ingredients`, `use_character`, or `use_scene`, or upload `reference_images`. At most three collected mention names are accepted for video. Do not equate an uploaded file with a project mention or assume an attachment landed in the intended role.

The video schema currently advertises ratios `16:9`/`9:16`, durations `4s`/`6s`/`8s`/`10s`, and qualities `360p`/`720p`. Image ratios also include `1:1`, `4:3`, and `3:4`. Schema membership alone does not establish selected-model support. Do not assume a universal ingredient duration: verify the exact model/mode/duration combination and preserve blockers instead of coercing the request.

## Approval and spending

All paid generations (image, video, character) converge on one guarded server-side commit boundary (`commitPreparedGeneration`). Out-of-band DOM clicks, standalone Playwright click scripts, or coordinate-based clicks are strictly banned as they bypass credit quotes, budget reservations, and idempotent transaction tracking.

The preferred path is prepare, inspect, authorize, then `flow_generate_confirm` with the exact returned `job_id` and explicit `max_credits`. Only `ready_for_confirmation` is eligible; `prepared_unverified` is not. Confirm the immediately prepared shot before modifying the composer or preparing another shot. Do not batch preparations and assume old jobs remain safely confirmable.

Image/character `auto_confirm:true` and video `confirm_generate:true` authorize live submissions. They are not planning flags and must not appear in preparation examples. Video `auto_confirm` is not the live authorization flag.

A brief or beat-sheet approval does not authorize spending. Conversely, explicit approval to execute a bounded plan within a budget need not be requested again for each in-budget shot, provided the user has not reserved per-shot approval. Recheck observed quotes and remaining exposure before every submission. `max_credits` is a per-submission ceiling; the configured persistent project budget is a separate total limit (50 by default). Never edit either limit without authorization. Unknown outcomes remain reserved and require inspection, not automatic retries.

## Results and downloads

`flow_queue_status` describes the local queue, not authoritative remote render completion. Use remote observations and `flow_status`/`flow_screenshot` to establish completion. A screenshot or audio stream does not establish correct spoken words.

`flow_download_latest` accepts `project_url` for an existing project and optional exact `asset_id` from returned choices. When the result is ambiguous, select the intended asset explicitly. A thumbnail identity token may be tied to the current visible library; refresh choices after reloading. Preserve the verified original and record all derived copies.

## Local planning and editing

`flow_script_create`, `flow_script_update`, `flow_script_status`, and `flow_script_review` support revisioned local planning. `flow_script_run` supports bounded local candidate intent, explicit local import, and review artifacts; it does not drive an autonomous remote video pipeline. Do not imply a generic brief or shot template is already a valid script-schema payload.
