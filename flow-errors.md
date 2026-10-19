# Google Flow MCP errors encountered

## Video prompt entry timed out

**Error:** `locator.type: Timeout 30000ms exceeded` while waiting for the visible `[contenteditable="true"]` prompt box. The locator resolved to Flow's “What do you want to create?” textbox, but text entry did not finish.

**Meaning:** The MCP tool could see the prompt editor but failed to enter the prompt before its 30-second timeout. No video was submitted by this failed attempt.

## Reference image ingredient could not be inserted

**Error:** `None of the 1 ingredient(s) could be inserted (Generating previewUntitled). Use flow_list_mention_options to discover exact @names; refusing mismatched paid generation.` (`UNKNOWN_UI_CHANGE`)

**Meaning:** Flow listed `Generating previewUntitled` as a reference option, but the MCP could not select it as an ingredient. It stopped rather than prepare a video without the requested reference. No video was submitted by this attempt.

**Next step:** Confirm the generated image is fully rendered and has a stable reference name in the new project, then retry prompt preparation using that exact name. Keep video generation unsubmitted.

## Fixes and verification (2026-10-17)

- Replaced delayed character-by-character prompt entry with Playwright `fill(prompt)` for image/video preparation. The original video prompt exceeded the 30-second typing budget at 20 ms per character. Existing prompt read-back checks remain in place.
- Scoped reference listing and selection to the asset picker, read `.asset-title` rather than preview/status text, and exclude pending previews. Pending-only pickers report unavailable references rather than a false empty project.
- Try exact visible reference titles before searching; displayed ellipses are not sent literally to search. Ambiguous matching rows are refused.
- Regression checks: 23 mention/reference tests and the video-handler test with a 2,099-character prompt pass. Build, lint, and syntax checks pass.
- Full suite: 944 passed, 6 skipped, 3 failed. Remaining failures are in unchanged model-catalog tests (`tests/dynamic-catalog.test.js` and `tests/w03-model-catalog.test.js`), outside these two reported errors.
- Initial post-restart verification was blocked by sign-in. This was subsequently resolved; see the live verification below. No video generation was submitted.

## Full catalog live verification (2026-10-18)

Test project: `https://flow.google.com/project/cf75fd16-ccd5-4a67-bced-518e1955b222` (`MCP Tool Verification 2026-10-17`). Browser is independently launched and attached on CDP port 9333; subsequent MCP restarts preserved the signed-in browser.

### Additional repairs

- Explicit project name/campaign now wins over remembered session state. Unreachable or ambiguous explicit scope cannot silently generate in another project.
- Character preparation uses bulk fill plus exact description read-back. Only visible native form controls qualify; hidden character hints and the sidebar's `accessibility_newCharacters` icon cannot masquerade as the creation form or New character action.
- Character confirmation supports the account owner's explicit zero-credit image policy, bound to the signed-in account, native character form and exact allowlisted Nano Banana model. Results identify the source as policy rather than inventing a UI quote. Video and conflicting credit labels are not exempted.
- Character creation can confirm and name the new character automatically. Rename waits for the debounced server acknowledgement and checks the returned library card; it no longer edits the unrelated header input or races a stale detail-page reload.
- Added `flow_rename_image`, with exact asset/title selection, ambiguity rejection, and title read-back.
- Character JSON imports reuse verified preparation and report missing models/references rather than claiming readiness.
- Downloads use an owned, GUID/URL-bound Chrome transfer directory for the correct browser context, avoiding missing/revoked temporary downloads across CDP clients. Downloaded media bytes are still verified.
- Fixed Veo 8s/720p settings are verified from the composer chip when the UI offers no selectable option. Tools gallery readiness no longer incorrectly requires a prompt editor.
- Ambiguous model-family requests no longer choose whichever matching model has the shortest name.

### Observed outcomes

| Tools | Outcome |
| --- | --- |
| `flow_connect`, `flow_disconnect`, `flow_open`, `flow_account_check`, `flow_status`, `flow_screenshot` | Exercised. Signed-in browser survives MCP-only restart after independent launch. |
| `flow_list_browser_targets`, `flow_list_projects`, `flow_queue_status`, `flow_queue_reset` | Exercised successfully; reset tested with no active remote generation. |
| `flow_create_project` | Created and named the dedicated test project. |
| `flow_generate_image`, `flow_generate_confirm` | Actual Nano Banana 2.1 image submitted at an observed 0-credit quote and rendered. |
| `flow_create_character`, `flow_generate_confirm` | Actual character submitted under the owner's free-image policy. `auto_confirm:true` also generated and automatically named `MCP QA Auto Courier`; naming read-back verified. |
| `flow_import_character`, `flow_open_characters` | Rechecked after the final rebuild/restart. JSON import reached `ready_for_confirmation` with the correct native model, description and project; character form opening targeted the dedicated project. Import was not submitted. |
| `flow_rename_character` | Renamed the test character to `MCP QA Courier Renamed`; acknowledged by Flow and verified on its library card. |
| `flow_rename_image` | Renamed the generated image to `MCP QA Blue Teapot Verified`. |
| `flow_download_latest` | Downloaded that exact image; JPEG, 60,836 bytes, SHA-256 `5fe7de2a355bfeb39ab57a972898fff284da41bde2b88aa8bd9ac242b1c28d3f`. |
| `flow_list_mention_options` | Listed both named characters and the renamed image; composer preserved. |
| `flow_generate_video` | `ready_for_confirmation`, requested 16:9/8s/720p and named image ingredient all verified. No video submitted. |
| Video `flow_generate_confirm` | Correctly refused the observed 20-credit quote against the authorized zero-credit ceiling. |
| `flow_list_models`, `flow_discover_ui` | Live model discovery and Images-page discovery succeeded. |
| `flow_open_tools_gallery` | Opened and correctly identified the current Tools gallery after repair. |
| `flow_use_grid_architect`, `flow_use_tool` | Expected account blocker: Flow displays `Upgrade to create`. No upgrade or paid action attempted. |
| `flow_create_scene` | Blocked: current Scenes view exposes no native scene creation form. No fake readiness or ordinary-composer submission. |
| `flow_export_reel` | Prepare-only prerequisite check exercised; test project lacks three matching video clips. Export itself not verified. |
| `flow_script_create`, `flow_script_status`, `flow_script_run`, `flow_script_resume`, `flow_script_review`, `flow_script_update` | Local create/status/candidate-intent/resume/review/update exercised. Zero spend; no client creative approval impersonated. |

The initial test image submission before the project-scope repair targeted the previously remembered project. Later tests used the dedicated project; existing user assets were not deleted or renamed.

Automated checks: full suite reached **956 passed, 6 skipped**. The final native-character library selector regression also passes. Build, lint and syntax checks pass. Account entitlement and missing-video prerequisites are not claimed as successful end-to-end generation/export tests.

Final `flow_status`: browser connected, account verified, project `ready`, no active job. The browser was left open in the test project's All media view.
