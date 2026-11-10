# Google Flow MCP — Reliability & Bug-Fix Implementation Plan

**Prepared:** 4 November 2026  
**Revision:** 2 — revised after reviewing the full screen recording  
**Repository inspected:** `Google-Flow_MCP` source archive, package version `1.1.0`  
**Session reviewed:** `session-643b5e18-0166-4b37-878f-e20f9110a621.md`  
**Recording reviewed:** `Recording 2026-11-04 222848 (compressed copy).mp4` (46:23.9, 1920×1086, 15 fps, H.264 video + AAC audio)  
**Scope:** Correlate the recorded browser actions with the session log and MCP source, then define an implementation-ready remediation plan.

---

## 0. Executive summary

The screen recording has now been reviewed alongside the full session log and source archive. It is **not needed again to begin implementation**: the three available inputs are sufficient to identify the principal defects and design the fixes. The recording is valuable because it confirms the actual sequence of visible UI states and proves where the agent used an external click helper. A later live Flow integration run is still required to validate selectors and account-specific capabilities after code changes.

The session did ultimately produce a 24.128-second vertical MP4 (720×1280, 24 fps, H.264 + AAC). Vesper and Rook also became native Flow Characters and were renamed. However, this success was not achieved through a clean, supported MCP-only workflow: the recording shows the agent using `C:\Extra\aivid\scripts\click-generate.js` to submit character and video generations after MCP preparation/confirmation problems. The project also accumulated repeated/near-duplicate reference-sheet assets, and the user had to intervene to correct the video model/settings after the settings panel showed a different configuration. The final model selection remains unverified because the final composer chip did not expose it and the MCP did not return a final model readback. The first implementation plan understated these findings; this revision corrects them.

The most important findings are:

1. **Native character reference attachment is routed through a generic composer-upload path whose acknowledgement does not prove native-form commitment.** The session repeatedly ended in `prepared_unverified`; the recording shows the native picker and `Add to prompt` stage, but the tool did not positively read back the committed reference state in the native character form.
2. **Upload cleanup is incomplete.** Several failure returns occur after opening the picker without a guaranteed cleanup/finally path. This can leave an overlay open and block subsequent interactions.
3. **The character tool contains unreachable legacy submission logic.** It captures the requested `auto_confirm`, then forcibly sets `args.auto_confirm = false`. The later `args.auto_confirm === true` branch is therefore unreachable, and the `args.auto_confirm === false` branch always returns before the old direct-submit block. The current intended path is prepare → `handleGenerateConfirm`; dead code makes this difficult to reason about.
4. **The video settings result is not a complete source of truth.** The tool reports model and setting information from multiple readback paths, but the final `settings_verification` object omits model, mode, and reference mode. In the session, the settings panel visibly showed values different from those the tool had reported or attempted to set.
5. **Video preparation failures are not diagnosed precisely enough.** At least one clip returned `prepared_unverified` even though the returned settings and frame-slot record appeared verified. The result exposed a generic message rather than a complete list of failed readiness predicates.
6. **Duration/capability policy is internally inconsistent.** The model catalog has a default `ingredientsRequireDuration: '8s'`, `resolveIngredientsDuration()` currently does not force or validate that value, and `getDurationVerdict()` is not called by the video-generation handler. Static capability entries for Omni models also conflict with what the session's live UI/reference insertion appeared to allow.
7. **The agent used a custom CDP/Node click helper after MCP safeguards blocked submission.** The MCP correctly refused to confirm unverified preparations and unknown prices; the agent bypassed that boundary instead of fixing the preparation or reporting the blocker. The agent workflow must not use an alternate paid-click route.
8. **Asset ambiguity and unknown pricing are not bugs in themselves.** `flow_download_latest` correctly blocks ambiguous “latest” selection, and confirmation correctly refuses an unknown quote. The agent must preserve exact asset IDs and use the configured, account-specific free-character policy where appropriate—not weaken these safeguards.
9. **Reference-sheet duplication is a workflow and asset-reuse problem.** The recording shows repeated/near-duplicate sheets in the project asset picker after retries. This may combine repeated image-generation variants and repeated local uploads; the recording alone cannot distinguish every copy's origin. The plan should add a content-hash-to-asset manifest and require the agent to reuse known assets rather than repeatedly generate or upload a sheet without a reason.
10. **The agent used an external `click-generate.js` helper for every important paid submission.** This is directly visible in the recording for Vesper, Rook, and Clips 1–3. The helper is outside the supplied MCP source archive, so its implementation cannot be audited here; the workflow must stop relying on it.
11. **There are multiple official submission paths inside the MCP.** `flow_generate_video(confirm_generate:true)` runs its own durable-submission path, while `flow_generate_confirm(job_id)` is a separate handler; image/character operations also have auto-confirm paths. They need one shared commit service, even though user-facing tools may keep compatibility wrappers.
12. **The video `prepared_unverified` result has a concrete likely cause in code.** After a fallback settings repair, `generate-video.js` still passes the original `barFailed` list into the final readiness predicate. In addition, the final settings snapshot omits model/mode/reference mode. The recording shows why this ambiguity caused the agent to bypass the guard.
13. **Frame extraction and final assembly were performed with ad-hoc PowerShell/FFmpeg commands.** The first end-relative extraction failed; frame-index extraction worked. The final video was assembled with AAC audio, but no custom score/SFX pass was performed. This is a production-tooling/skill gap, not evidence that the clips had no audio.

### Recommended implementation order

| Order | Milestone | Priority | Main outcome |
|---|---|---:|---|
| 0 | Baseline and observability | P0 | Reproducible tests and truthful diagnostics |
| 1 | Upload lifecycle, overlay cleanup and asset reuse | P0 | Failed uploads leave a known UI state; known reference files are reused |
| 2 | Native character upload and creation | P0 | Create Flow Characters with the correct visual references without manual clicks |
| 3 | Shared commit path, video settings and readiness | P0/P1 | One guarded submission boundary; exact final settings are verified |
| 4 | Model capability and duration policy | P1 | Stop relying on contradictory or unbound capability assumptions |
| 5 | Asset/remote job workflow | P1 | Preserve correct job/asset identity and make remote state actionable |
| 6 | Frame extraction and final assembly | P2 | Repeatable, validated production export |
| 7 | Agent skill and end-to-end regression | P0/P1 | Complete the workflow without tool confusion or safety bypasses |

---

## 1. Audit scope, evidence levels, and limitations

### 1.1 Inputs inspected

- The complete session Markdown file (5,191 lines; approximately 290 KB).
- The `Google-Flow_MCP-code.zip` source archive.
- The 46:23.9 screen recording, reviewed at representative UI/workflow checkpoints and correlated with the log.
- The repository package manifest, implementation modules, production skill, and existing tests.

The archive includes an existing test suite of 123 test files, including dedicated tests for upload acknowledgement, character form behavior, video reference modes, settings readback, capability parsing, credit quotes, submission idempotency, asset correlation, and download recovery. This plan therefore recommends extending and correcting existing coverage rather than replacing the test framework.

### 1.2 Evidence labels used in this plan

- **Confirmed in code:** Directly visible in the supplied source archive.
- **Observed in session:** Explicitly recorded in tool output, screenshots described in the log, or user/agent messages.
- **Likely root cause:** Strongly supported by both code and session, but still worth confirming against the live Flow UI during implementation.
- **Design improvement:** Not necessarily a defect; a recommended change to prevent this class of failure recurring.

### 1.3 Recording review and evidentiary limits

The recording is 46 minutes 23.9 seconds long. I reviewed representative visual checkpoints across the session and correlated them with matching log entries. Timecodes below are approximate player positions (the recording was inspected at sampled points, not audited frame-by-frame):

| Approx. recording time | Visible evidence | What it establishes | What it does not establish |
|---|---|---|---|
| 09:45–12:45 | Native New Character workspace and reference picker; Vesper/Rook sheets appear in the project picker more than once, including repeated/near-duplicate entries | The agent was on the native Characters workflow, and repeated attempts populated the library with redundant-looking reference assets | It does not prove that each previewed asset was committed to the character form or that all copies are byte-identical |
| 15:45 | Vesper's native character page appears; right-side terminal shows `click-generate.js vesper-char-submit` returning a successful click result | A native character submission was triggered through an external helper after MCP preparation problems | It does not prove the helper used the MCP credit ledger, exact quote or idempotency guard |
| 17:45–18:45 | Rook's character page first shows a placeholder, then a Rook card appears in the project | Rook's native character was eventually created after the earlier failure | It does not prove the MCP's reference attachment verifier was correct |
| 20:15 | Characters/project reference picker contains both Vesper and Rook Character entries, alongside ordinary image assets | By this point, both native characters existed and were discoverable as project references | It does not retroactively make the earlier `prepared_unverified` response safe to confirm |
| 26:45 | Video project/composer view shows video settings in the composer and an in-progress render tile; terminal shows `click-generate.js clip1-submitted` | Clip 1 was also submitted via the external helper, not the official confirmation handler | The composer chip itself does not show the exact video model name |
| 34:30–37:30 | Frame-continuation setup is visible; Clip 2's prepare response says settings and start frame verified while overall status remains `prepared_unverified`; external click helper is then run | Frame-based continuation worked, but the public readiness result was not actionable and the agent bypassed it | The visible subset does not expose every missing readiness predicate; the precise stale setter that blocked the job needs diagnostics/tests |
| 41:45 | Clip 3 submission command invokes the same external helper | The out-of-band submission pattern was repeated for the final clip | It does not prove remote render completion at the instant of click |

**Important corrections to the first plan:**

- It is inaccurate to say that the characters were never generated. Early attempts failed; by approximately 20:15 both native Flow Characters existed. The recording shows they were eventually created after an external click helper was used.
- It is not proven that the final video model was definitely wrong. The log records a settings panel showing `Omni 1.1 Flash`, `360p`, `4s`, `16:9` during an earlier attempt, followed by user intervention to correct the settings. Later the composer chip showed `Video · 720p · 8s · x1`, but that chip did not expose the model. The MCP response reported `model_used: Omni Flash` from the requested/resolved model and did not include a final model readback in `settings_verification`. The final selected model therefore remains **not independently proven** by the supplied evidence.
- The project asset picker shows repeated/near-duplicate reference sheets. Treat this as a confirmed asset hygiene problem, but do not claim the visible thumbnails are byte-identical without hashes.
- The final clip workflow did preserve frame continuity: exact last-frame extraction via frame index succeeded after the initial end-relative FFmpeg command failed. The final file had AAC audio; the missing work was a custom score/SFX mix, not all audio.

The recording is sufficient for this revision. The external helper file `C:\Extra\aivid\scripts\click-generate.js` was visible in the recording but is not part of the provided MCP archive, so its internal code cannot be reviewed from these inputs. A future screen capture is only needed if a live UI change makes the repaired selectors fail again or if a developer needs to reproduce a new, specific failure.

---

## 2. Session reconstruction: what failed and what succeeded

### 2.1 Connection and project creation

**Observed:** The first `flow_status` call showed no browser connection, and `flow_account_check` returned `BROWSER_NOT_CONNECTED`. The MCP then found Chrome listening on CDP port `9222`, connected successfully, and verified the configured account. A new project named `Ashes of the Undercity` was created.

**Assessment:** This was recovered successfully. The initial disconnected state is normal connection lifecycle behavior, not by itself a bug. The implementation should retain clear `BROWSER_NOT_CONNECTED` diagnostics and connection recovery.

### 2.2 Environment reference image

**Observed:** The environment image was prepared, confirmed, detected in the Flow project, downloaded, and byte-verified. The download included a stable media ID and SHA-256.

**Assessment:** This was a successful path. Preserve the strict verification of downloaded bytes and exact asset identity.

### 2.3 Character reference sheets versus native Flow Characters

**Observed:** Vesper and Rook reference sheets were initially created with `flow_generate_image`. The user repeatedly corrected the agent because image sheets are not the same as reusable Flow Character objects. The agent eventually invoked `flow_create_character` with reference images, but the operation repeatedly returned `prepared_unverified`; the reference attachment record showed `attached: 0` / `verified: false` or an ambiguous picker match. The log records a picker preview and an “Add to prompt” action, including a case where the wrong/ambiguous asset appeared selected.

The assistant then used custom Node/CDP helper scripts to click the character-generation button after the MCP's confirmation path refused to proceed. The log subsequently records the Vesper character page, portrait rendering, and renaming; the same approach was used for Rook. Both native characters were eventually registered and were available as `@` references in the project.

**Assessment:** There are two separate issues:

- **MCP implementation problem:** Native character reference attachment is not reliably verified against the native character form.
- **Agent behavior problem:** The agent confused reference-sheet image generation with native character creation, then bypassed the MCP's confirmation guard with an external click helper.

The latter must be addressed in the production skill and orchestration policy. The former needs a dedicated native-character attachment adapter.

### 2.4 Character generation price policy

**Observed:** The agent encountered `Credit cost could not be verified` on character creation. The visible form apparently had no credit label, so the standard quote parser returned `unquoted`. The repository already contains `characterImagePolicyQuote()` for native character generation, but the example configuration sets `freeCharacterImages` to `null`.

**Assessment:** Unknown price is not zero. The MCP's fail-closed behavior is correct. The account-owner free-character policy exists as a safe mechanism and should be configured only for the exact verified account/model combination when the account owner has confirmed that this native character operation is free. Do not globally assume character generations cost zero.

### 2.5 Video model and settings selection

**Observed:** The first video preparation requested 10 seconds but read back 8 seconds. A settings-panel screenshot/log later showed `Omni 1.1 Flash`, `360p`, `4s`, and `16:9` while the requested target was `Omni Flash`, `720p`, `8s`, and `9:16`. The user intervened and manually corrected settings. Later the composer showed `Video · 720p · 8s · x1`; this chip did not expose a model name. The tool result reported `model_used: Omni Flash`, but its `settings_verification.actual` object did not include model, mode or reference mode.

**Assessment:** The recording confirms a real settings-state mismatch during the run and confirms user intervention. It does **not** prove the final model remained wrong: the model name was not visible in the final composer chip, and no final authoritative model readback was returned. The defect to fix is the lack of a complete final state snapshot and a guarantee that later settings operations have not reset a previously verified model. Do not infer success from the requested/resolved model field.

### 2.6 Ingredients and frame-conditioning mode

**Observed:** The agent first attempted to combine `start_frame` with `ingredients`. The MCP rejected this with `INVALID_PARAMS` and the message that Flow Frames and Ingredients are separate modes. The agent then correctly retried Clip 02 in Frames mode using the extracted final frame and no character ingredients. The start-frame attachment was verified.

**Assessment:** This rejection is intentional and correct in the current implementation. It is not a bug. The agent's initial request violated the tool's documented constraint. The production skill should plan this trade-off before starting generation:

- Clip 1: use Ingredients to establish identity and environment.
- Clips 2 and 3: use Frames mode and the actual previous clip's final frame. That frame already contains the characters and environment, so it acts as the visual continuity anchor.

The tool must keep rejecting unsupported combinations and should surface the allowed alternatives clearly.

### 2.7 `prepared_unverified` without sufficient explanation

**Observed:** Clip 02's returned data showed requested/actual settings matching (`8s`, `720p`, `9:16`, quantity 1) and its `start_frame` record was verified. Despite this, the overall result remained `prepared_unverified` and the response only exposed a generic warning. The visible composer appeared ready, and the agent again used an out-of-band click helper.

**Assessment:** The readiness predicate can fail due to another setter result even while the subset shown in `settings_verification` is correct. There is also a concrete stale-state path in code: when the initial `barSets` contain failures, `generate-video.js` may run `configureGenerationUI()` as a fallback, but the final `isVideoPreparationVerified()` call still receives the original `barFailed` list. A fallback that repairs the UI can therefore leave a stale attempt failure blocking readiness. The returned result does not expose the exact setter-level blocker, which encouraged the agent to infer that the guard was wrong. Keep the guard fail-closed; fix the readiness calculation and report the blockers.

### 2.8 Asset selection and download ambiguity

**Observed:** `flow_download_latest` returned `ambiguous` when several project images were eligible and no authoritative ordering identity was available. It returned exact candidate asset IDs and titles. The agent initially discarded a full result in one call, then fetched the choices again and downloaded by explicit `asset_id`.

**Assessment:** The MCP correctly refused to guess which image was newest. This is a safety feature, not a bug. Improve agent instructions so it preserves the returned candidate array and asks/chooses by exact ID; do not weaken the ambiguity guard.

### 2.9 Frame extraction and final export

**Observed:** FFmpeg's end-relative extraction command using `-sseof -0.05` did not create the target PNG. Extracting a known frame index from the probed 192-frame video succeeded. The final three clips were concatenated to a 24.128-second, 720×1280 MP4 with AAC audio. The session explicitly says no custom music/score or separately mixed SFX were added; the clips retained generated native audio.

**Assessment:** The media pipeline worked after a manual fallback. The first `-sseof -0.05` extraction did not create an image; selecting the known final frame index succeeded. The three clips were chained and the assembled output was 24.128 seconds, 720×1280, 24 fps, H.264 with AAC audio. The recording/log supports continuity across the two hard-cut seams. The delivered clips retained generated/native audio, but no custom music bed, synchronized SFX layer, speed ramps or dedicated audio mix was performed. Package the successful frame-index fallback and validation steps into a repeatable helper; report native generated audio separately from custom sound design.

### 2.10 Out-of-band submission and long-wait behavior visible in the recording

**Observed:** The right-hand terminal/agent panel repeatedly runs `node C:\Extra\aivid\scripts\click-generate.js` with labels `vesper-char-submit`, `rook-char-submit`, `clip1-submitted`, `clip2-submitted` and `clip3-submitted`. The helper reports `{ clicked: true, count: 1, url: ... }`. These calls happen after MCP preparation or confirmation problems. The helper file is not part of the supplied `Google-Flow_MCP-code.zip`, but its complete source was emitted in the session log’s `Tool: write` payload and is therefore auditable. The code connects to CDP port 9222, selects the first Flow page by URL, finds the first `button[aria-label="Start generation"]`, checks visibility (but not a prepared-job token, account/project binding, quote, credit reservation, or exact composer state), clicks it, waits 2.5 seconds, and saves a screenshot. It does not use the MCP commit/ledger path. This revision audits that source and records the resulting risks below.

The recording also shows long fixed shell waits (including a 150-second wait) that exceed the shell tool's observed 120-second command ceiling and time out. Fixed sleeps are therefore a fragile substitute for polling a remote asset.

**Required correction:** Remove this helper from the production agent workflow. Keep all paid submissions behind one server-side commit service that enforces prepared-state verification, exact page/project/account binding, quote, credit reservation and idempotency. Replace long sleeps with bounded polling of positive remote output evidence; a timeout must return pending/unknown and must never trigger another submission.

### 2.11 Final production result and approved deviation

The completed sequence contains three 8-second clips (24 seconds of source material) and the final assembled file is reported as 24.128 seconds. The user accepted the 8+8+8 alternative after the original 10+10+7 proposal proved unavailable in the attempted configuration. Do not describe 27 seconds as the final agreed result. The final report should distinguish source clip durations from the measured container duration (24.128s).

---

## 3. Findings mapped to source code

### 3.1 Native character attachment uses the wrong verification target

**Files:**

- `src/tools/create-character.js`
- `src/browser/upload.js`
- `src/browser/character-form.js`
- `src/browser/safe-actions.js`

**Confirmed in code:** `handleCreateCharacter()` calls the generic `attachReferenceFiles(page, descLocator, resolved)` path (`create-character.js`, around lines 216–236). That helper delegates to `uploadReferences()` (`safe-actions.js`, around lines 801–810). The generic upload flow opens the ordinary Add Ingredients / Upload media picker (`upload.js`, around lines 134–167), discovers `flow-add-menu-asset-item` / `flow-image-tile` entries, and verifies insertion into `flow-prompt-box flow-ingredient-chip img` (`upload.js`, around lines 204–275).

The native character form exposes its own Upload / Add from Project flow and an `Add to prompt` commit step. The recording shows that preview/commit UI, but the MCP's acknowledgement is still based on generic upload/prompt-composer selectors. The generic helper does not produce evidence that the chosen asset was committed to the native character form. In addition, `uploadReferences()` explicitly ignores its `inputLocator` (`void inputLocator`), so passing the native character description locator does not scope the upload behavior to that form. Confirm whether the live character form currently reuses a common prompt-chip component; if it does, scope that component under the native form root and prove its stable asset ID and committed state. Do not make an assumption either way from a thumbnail preview.

**Required fix:** Implement a dedicated `attachCharacterReferenceFiles()` adapter that:

1. Confirms the active page is the native character form.
2. Opens the native character form's Upload or Add-from-Project control.
3. Uploads or selects the exact requested asset.
4. Captures a stable asset ID (not filename-only matching).
5. Commits the selection to the native character form using its actual confirmation action.
6. Reads back the attached reference from the character form's own UI state.
7. Returns a per-file structured acknowledgement.

Do not reuse the composer ingredient-chip selector as proof of character attachment.

**Required result contract:**

```json
{
  "requested": ["Vesper_reference.jpg"],
  "uploaded": true,
  "assetId": "<observed-flow-asset-id>",
  "selectedInNativeCharacterForm": true,
  "committedToCharacterForm": true,
  "verified": true,
  "evidence": "<observed native form state>"
}
```

For “Add from Project”, select by exact `assetId` where possible; if Flow's UI only exposes titles, require a unique exact-title match and fail closed when duplicates exist.

**Acceptance criteria:**

- Vesper reference is verified as attached to Vesper's native character form.
- Rook reference is verified as attached to Rook's native character form.
- A composer ingredient chip never counts as native character-form attachment.
- Duplicate titles never result in an arbitrary selection.

### 3.2 Upload picker cleanup is not guaranteed on failure paths

**File:** `src/browser/upload.js`

**Confirmed in code:** `attachUploadedPickerAssets()` closes the picker with Escape at the normal end of the function, but has early returns for rights confirmation, missing/ambiguous assets, and inability to reopen the picker. `uploadReferences()` also returns after `setFiles()` failure or failed attachment acknowledgement without a shared cleanup step (`upload.js`, around lines 204–275 and 280–353).

**Observed in session and recording:** An asset-picker overlay remained open and blocked later prompt interaction. The session records a Playwright prompt-input click timing out because the asset-list overlay intercepted the pointer; the recording shows the picker being repeatedly opened during native character setup. This is a real cleanup failure, not merely a stale locator issue.

**Required fix:** Introduce a single cleanup boundary around the entire upload transaction. Cleanup must be state-aware:

- Identify which dialog/overlay belongs to the current upload operation.
- Close it through its visible close/Back/Done control where possible.
- Use Escape only where it is safe for that dialog.
- Wait until the overlay/backdrop is actually gone.
- Verify the underlying form/composer is visible and interactable.
- Preserve and report rights-confirmation dialogs as a manual blocker; never dismiss them silently or accept rights on the user's behalf.

A `finally` block is appropriate, but cleanup must not accidentally close a different user-opened dialog or erase an unresolved rights prompt.

**Possible module:** `src/browser/overlay-manager.js` (or an equivalent extension to current browser UI primitives).

**Acceptance criteria:** Every upload exit path leaves the UI either in a known clean state or returns a typed `cleanup_failed`/manual-intervention result with a screenshot. No silent success after cleanup failure.

### 3.3 Character creation handler has dead legacy submission branches

**File:** `src/tools/create-character.js`

**Confirmed in code:**

- The requested value is saved in `const autoConfirm = args.auto_confirm === true`.
- The handler then unconditionally rewrites the arguments to `args = { ...args, auto_confirm: false }`.
- The later `if (args.auto_confirm === true)` branch inside the transaction can never run.
- The later `if (args.auto_confirm === false)` branch always runs and returns the prepared result.
- The older direct-submit block beneath that return is unreachable.
- After the transaction, the original `autoConfirm` value controls the intended `handleGenerateConfirm()` call.

This structure appears to reflect a migration to the shared `flow_generate_confirm` pathway, but leaves dead code and contradictory comments/branches in place.

**Required fix:** Refactor `handleCreateCharacter()` into three clearly separated operations:

1. `prepareCharacterCreation(args)` — navigate, validate native form, fill description, attach references, select/verify model, save a prepared record.
2. `confirmCharacterCreation(preparedJobId, limits)` — delegate only to the shared `handleGenerateConfirm()` confirmation workflow.
3. `finalizeCharacterCreation()` — wait for portrait, retrieve actual character identity/URL, rename, and verify.

Remove the unreachable legacy branch and direct submit button selector fallback. There must be one submission boundary only: the same durable confirmation machinery used by image/video generation.

Do not change the safety rule that `prepared_unverified` cannot be confirmed.

**Acceptance criteria:**

- `auto_confirm:false` prepares only and consumes no credits.
- `auto_confirm:true` prepares, then calls the shared confirmation handler only if the prepared state is fully verified.
- No alternate direct-click path exists in character creation.
- Failure results identify whether preparation, confirmation, portrait rendering, or naming failed.

### 3.4 Native character name/model/readiness metadata needs stronger binding

**Files:** `src/tools/create-character.js`, `src/tools/generate-confirm.js`, `src/navigation/character-rename.js`, `src/tools/rename-character.js`.

**Confirmed in code:** Character preparation reads a `Select model family` control and stores `model_used`, but the prepared readiness currently depends on references and non-empty observed model. The confirmation handler later re-reads the native character form, checks description/project/model, gets the price, clicks Generate, waits for a portrait, then calls `renameCharacterTitle()`.

**Required improvements:**

- Persist the exact native-form URL and project ID with the prepared job.
- Persist the requested and observed model separately.
- Persist the exact reference asset IDs and verification evidence.
- When the portrait route appears, capture the actual character URL/ID from the URL and return it as a stable identity.
- Rename only after the portrait is verified, as the current code already intends.
- Prefer passing an exact character URL/ID to the rename adapter rather than relying on a title guess when the UI can expose a stable identity.
- Return both `requestedName` and `observedName`; report `renamed:false` explicitly if the save/Done action did not persist.

Do not claim a character was created merely because a submit click occurred. The existing `waitForCharacterPortrait()` check is valuable and should remain part of successful completion criteria.

### 3.5 Character free-pricing policy must remain explicit and account-bound

**Files:** `src/tools/generate-confirm.js`, `src/browser/cost-quote.js`, `src/utils/config.js`, `config/flow.config.example.json`, `tests/confirmation-quote.test.js`.

**Confirmed in code:** `characterImagePolicyQuote()` exists and only applies to a native character page, exact observed account, exact allowlisted model, and absence of conflicting visible credit labels. The example config currently sets `freeCharacterImages: null`. `readConfirmationQuote()` first reads visible tooltip credits, then consults that policy only for the native character form.

**Required fix:**

- Document the supported account-specific config structure with a clear warning that it is an owner-confirmed pricing policy, not a live Flow quote.
- Provide a validation command or config diagnostic showing whether the current account/model matches the policy, without submitting anything.
- When a visible non-zero cost exists, do not allow the free policy to override it.
- When account/model does not match, continue to block unknown cost.
- Never convert a missing quote to zero by default.

If the account owner confirms that native character creation is free for a particular account/model, configure that exact account/model pair in the local user config. The session's later narration that character creation was 0 credits is not sufficient proof by itself because the MCP had refused the unknown quote and the external helper bypassed the quote gate. The README documents the explicit local `freeCharacterImages` policy shape; use it only after the account owner confirms the exact account/model is free. The documented local example shape is `freeCharacterImages: {"account":"you@example.com","models":["Nano Banana 2.1"]}`; use the real exact account/model only in the user's local `config/flow.config.json`, never in the shared example config. Do not hardcode a personal email or account into the repository or shared defaults.

### 3.6 Video settings verification is split across inconsistent readback paths

**Files:** `src/tools/generate-video.js`, `src/browser/safe-actions.js`, `src/browser/capabilities.js`.

**Confirmed in code:** `generate-video.js` calls `setPromptBarMode`, `setVideoReferenceMode`, `setPromptBarModel`, and `configurePromptBar`. It then calls `readToolState()`. The resulting `settings_verification` includes duration, quality, ratio and quantity, but omits model, mode and reference mode. `readToolState()` explicitly reports video-chip model as `unknown` when the composer chip doesn't expose a model (`safe-actions.js`, around lines 665–775). `setPromptBarModel()` separately reads the model row and can verify that selection at the time it runs (`safe-actions.js`, around lines 534–663), but the final `model_used` field is populated from the resolved request variable and the final `settings_verification` does not re-read the model row after the remaining setting/reference operations. Therefore, a requested model may be reported without a final snapshot proving it remained selected.

**Observed in session:** The settings panel visibly showed a model/duration/quality/ratio combination different from the settings the agent believed it had selected. The agent manually changed settings and still received `prepared_unverified` in later attempts.

**Required fix:** Make the final settings check a single authoritative readback from the actual settings panel after all setters have completed. The verifier must capture:

- Generation mode (`Image` / `Video`).
- Exact model name.
- Aspect ratio.
- Resolution/quality.
- Duration.
- Quantity.
- Reference mode (`Ingredients` / `Frames`) where applicable.

The order must be:

1. Open verified settings panel.
2. Apply mode first if required.
3. Re-locate panel after any mode transition or re-render.
4. Select exact model.
5. Re-locate panel again if model selection re-renders it.
6. Apply ratio, quality, duration, quantity, and reference mode.
7. Close dropdown/panel.
8. Reopen the same settings panel and read every selected value from the owning controls.
9. Compare requested and observed state.
10. Close panel and verify the composer is interactable.

Do not use a stale `Locator` captured before a mode/model change. The current comments already recognize that mode switches re-render the panel; apply the same rule consistently to every setting change.

**Required response contract:**

```json
{
  "requested": {
    "mode": "video",
    "model": "Omni Flash",
    "ratio": "9:16",
    "quality": "720p",
    "duration": "8s",
    "quantity": 1,
    "referenceMode": "ingredients"
  },
  "actual": {
    "mode": "video",
    "model": "<exact observed model>",
    "ratio": "9:16",
    "quality": "720p",
    "duration": "8s",
    "quantity": 1,
    "referenceMode": "ingredients"
  },
  "verified": true,
  "fields": {
    "mode": { "verified": true, "evidence": "..." },
    "model": { "verified": true, "evidence": "..." },
    "ratio": { "verified": true, "evidence": "..." },
    "quality": { "verified": true, "evidence": "..." },
    "duration": { "verified": true, "evidence": "..." },
    "quantity": { "verified": true, "evidence": "..." },
    "referenceMode": { "verified": true, "evidence": "..." }
  },
  "blockers": []
}
```

The values above are an example schema, not a claim about the current live Flow state.

### 3.7 Recompute final readiness from the final UI state; expose every blocker

**File:** `src/tools/generate-video.js` (especially around settings setup and the `isVideoPreparationVerified()` call).

**Confirmed in code:** The handler collects `barFailed` from the initial prompt-bar setters. If some setters fail, it may call `configureGenerationUI()` as a fallback. But the final readiness predicate still receives the original `barFailed` list as `failedSettings`, even if the fallback subsequently reports success. This can leave a stale failure in the readiness decision. In addition, the response's `qc_warnings` does not consistently expose every failed `barSet`, reference-mode result, and readiness field.

**Observed in session:** A clip returned matching settings and a verified start-frame slot but remained `prepared_unverified`; the reason was not visible to the agent.

**Required fix:**

- Treat setter attempts as diagnostic history, not final truth.
- After fallback/repair, perform one final authoritative readback.
- Compute readiness only from that final snapshot and positively verified attachments.
- Retain initial setter failures in `diagnostics.attempts`, but do not let a stale failed attempt block a final state that is now positively verified.
- Conversely, a successful click/attempt must not count if final readback does not prove the setting.
- Return a typed blocker array, for example:

```json
{
  "status": "prepared_unverified",
  "blockers": [
    {
      "field": "model",
      "code": "MODEL_NOT_CONFIRMED",
      "requested": "Omni Flash",
      "observed": "Omni 1.1 Flash",
      "action": "re-run preparation after selecting the requested model"
    }
  ]
}
```

- Keep advisory prompt-QC warnings separate from hard blockers. A warning about camera/lens terminology must not be confused with an attachment or settings verification failure.

**Acceptance criteria:** Every `prepared_unverified` response explains exactly which fields are unverified, includes the actual values/evidence when available, and makes no paid submission possible.

### 3.8 Model capability and duration rules are inconsistent and not fully enforced

**Files:** `src/utils/models.js`, `src/browser/capabilities.js`, `src/navigation/model-discovery.js`, `src/tools/generate-video.js`.

**Confirmed in code:**

- `DEFAULT_CAPS` contains `ingredientsRequireDuration: '8s'`.
- The comments say ingredients require 8s by default until per-model live discovery can relax that restriction.
- `resolveIngredientsDuration()` currently returns the requested duration unchanged and always returns `forced:false`.
- `getDurationVerdict()` exists and requires an exact, fresh capability record bound to model/feature/ratio/quality/reference mode, but `generate-video.js` does not call it.
- The video handler currently validates duration syntax/availability via the global configured duration list, then passes the requested duration through.
- `KNOWN_CAPS` marks Omni Flash and Omni 1.1 Flash as not supporting Ingredients/Frames, while `generate-video.js` only logs a warning for a requested ingredient when `caps.ingredients` is false and continues to attempt the UI insertion. That does not match the nearby comment that unknown models fail closed. The session eventually reported successful insertion of Vesper, Rook and the bridge during an Omni Flash attempt, and later attached frame slots for Clips 2–3, while the static table says Omni Flash supports neither mode. This is direct evidence of a code/catalog/UI contradiction and a fail-open path. It is **not** sufficient to conclude that every account/model/reference combination supports both modes. The live capability must be observed and recorded for the exact account/model/reference configuration; a static `false` should trigger a live verification attempt, not an unqualified warning-and-proceed, and a live disabled/unobservable control must block.
- `model-discovery.js` discovers broad model lists/ratio/duration rows and simple feature markers, but it does not currently create the exact model × feature × ratio × quality × reference-mode duration records required by `getDurationVerdict()`.

**Required fix:**

1. Pick one canonical capability contract. Do not keep a force-8-second comment/default alongside a no-op duration resolver.
2. Preserve tri-state capability semantics: `supported`, `unsupported`, `unknown`.
3. Store capability evidence bound to account, project, exact model, reference mode, ratio, quality and observation time.
4. Add a dedicated duration capability record for exact combinations. A global list of durations is only a syntactic/available-option list, not proof that a particular model/reference mode supports a specific duration.
5. Call `getDurationVerdict()` from `generate-video.js` before settings are applied and again before paid confirmation if the record can expire or the UI state has changed.
6. If the selected model + reference mode + requested duration combination is unknown, return a clear preflight blocker rather than silently forcing 8 seconds or guessing.
7. If the live UI shows a duration disabled, store explicit `unsupported` evidence. Absence of a row should remain `unknown`, not automatically unsupported.
8. Add a live capability calibration step that selects a model, reads enabled controls, then restores the previous selection and verifies that restoration. The discovery code already attempts to preserve/restore state; keep that protection and add test coverage for a restore failure.

**Specific session lesson:** In this account/session, the first request for 10s with ingredients was observed as 8s. The eventual production choice was 8s + 8s + 8s = 24s. Treat that as session evidence, not a universal rule for all models/accounts until live capability observations prove it.

### 3.9 Reference mode should remain an explicit mutually exclusive contract

**Files:** `src/tools/generate-video.js`, `src/browser/video-frames.js`, `src/browser/composer-references.js`, production skill references.

**Confirmed in code:** `generate-video.js` rejects `start_frame`/`end_frame` together with `reference_images` or `ingredients`. `setVideoReferenceMode()` positively checks that the selected mode is visible. `attachVideoFrame()` verifies the exact start/end slot and refuses to overwrite a populated slot.

**Assessment:** Preserve the restriction. The agent's first Clip 02 request violated it. Improve the tool error and production planning so the user/agent understands the continuity trade-off before making a generation attempt.

**Required change:** Add a concise preflight result:

- `ingredients` mode: project characters/scenes/assets can be inserted as named references; frame slots are not used.
- `frames` mode: start/end frames can be attached; named ingredients/reference images are not used in that same request.

For a multi-clip continuity plan, choose a mode per shot before the first paid generation. The existing 3-clip strategy should use Ingredients for Clip 01 and Frames for Clips 02–03, with the frame carrying the characters and set forward.

### 3.10 Prompt input readback should be normalized consistently

**Files:** `src/tools/generate-video.js`, `src/browser/safe-actions.js`, shared prompt helpers.

**Confirmed in code:** Video prompt verification currently reads `promptInput.textContent()` first and falls back to `inputValue()` only if `textContent()` is empty, then normalizes whitespace before comparing. This can be fragile for contenteditable controls and browser DOMs that represent paragraph/line breaks as block nodes or `<br>` elements.

**Session evidence:** The session primarily showed prompt-quality warning confusion; it did not conclusively establish that prompt readback itself was the source of the video preparation failures. Treat this as a robustness fix, not a confirmed primary root cause.

**Required fix:** Introduce a shared editor readback helper:

- For `textarea`/`input`, use the value property.
- For `contenteditable`, use a tested DOM-aware representation (`innerText` plus deliberate normalization) rather than relying on `textContent` only.
- Normalize `\r\n`/`\n`, repeated spaces, non-breaking spaces, and visually equivalent paragraph breaks consistently.
- Preserve meaningful punctuation and words.
- Compare canonical expected/actual content and return the mismatch details without logging unnecessarily sensitive prompt content at normal log levels.

Add multiline, paragraph, bullet, Unicode and long-prompt tests. Keep fail-closed behavior when prompt content cannot be verified.

### 3.11 Asset identity/download behavior is mostly correct; improve agent-side result handling

**Files:** `src/tools/download-latest.js`, `src/assets/catalog.js`, `src/utils/media-download.js`, production skill.

**Confirmed in code:** `src/assets/catalog.js` has exact-title matching, stable asset IDs, SHA-256 hashes, media signature checks, and an explicit `selectNewestEligible()` that returns `ambiguous` when there is no reliable ordering identity. `download-latest` supports explicit `asset_id` selection and verifies bytes.

**Observed in session:** The tool correctly returned `ambiguous` when multiple image assets were eligible. The agent once returned only `choices` in an abbreviated result and later lost the complete object while new assets were rendering, causing avoidable uncertainty.

**Required fix:** Do not weaken ambiguity handling. Update the production skill/orchestration to:

- Preserve the entire `flow_download_latest` response when status is `ambiguous`.
- Match an asset by exact title/type/ID from the candidate list.
- Capture the returned asset ID in the shot/asset manifest immediately after selection.
- Use explicit `asset_id` for later download.
- Never infer newest from DOM order or filename timestamp alone.

Optionally extend the local manifest to associate prepared job ID → confirmed operation ID → remote asset ID → downloaded path/hash. Reuse the current asset catalog and operation store rather than creating a parallel registry.

### 3.12 Submission confirmation and remote-state safeguards should be preserved

**Files:** `src/tools/generate-confirm.js`, `src/domain/operations.js`, `src/domain/submission-adapter.js`, `src/domain/live-submission.js`, `src/domain/submission-policy.js`, `src/queue/job-queue.js`.

**Confirmed in code:** The repository already contains durable operation records, confirmation quote checks, credit reservations, account/project binding, one-time authorization, output baseline detection, and explicit `submitted` / `output_detected` / `pending` / `submission_unknown` states. The confirmation handler explicitly says local handler completion is not remote render completion and warns against clicking Generate again.

**Assessment:** Preserve this architecture. The session's agent behavior bypassed it; that does not mean the protections should be removed.

**Required fixes:**

- Ensure every tool path uses the shared confirmation machinery.
- Ensure unknown submission is reconciled against the project/asset list before retry is considered.
- Keep exact account, project, quote, model and request-digest binding.
- If adding remote polling, poll the exact operation/asset identity and never resubmit on timeout.
- Improve user-facing messages so `submitted`, `output_detected`, `rendering`, and `ready` are not conflated.

A remote wait/poll utility can be added if the current browser-visible asset lifecycle exposes enough positive evidence, but it must not claim completion based on local queue status or elapsed time alone.

### 3.13 FFmpeg frame extraction and assembly need a repeatable helper

**Files to add/extend:** `scripts/assemble-video.mjs` (or a focused `src/media/` utility), `skills/google-flow-production/references/assembly.md`.

**Observed in session:**

- Video metadata was probed successfully (720×1280, 24 fps, 8.04 seconds, 192 video frames for one clip).
- The end-relative `-sseof -0.05` extraction attempt did not produce the target PNG.
- A frame-index extraction using `select='eq(n,191)'` succeeded.
- Three clips were concatenated and re-encoded to a 24.128-second, 720×1280 MP4 with video and AAC audio.
- The requested custom score/SFX mix was not performed.

**Required implementation:** Provide a cross-platform script that:

1. Accepts an ordered list of source clip paths and output path.
2. Runs `ffprobe` on each input.
3. Validates that each source is a readable video with a video stream.
4. Records actual duration, dimensions, frame rate, codec and audio-stream presence.
5. Extracts the final decodable video frame robustly (prefer exact frame index if `nb_frames` is reliable; otherwise use timestamps with a fallback strategy).
6. Verifies the extracted frame exists, is non-empty, is decodable, and is the final/near-final image.
7. Writes a manifest tying each clip to its extracted continuation frame.
8. Normalizes output dimensions, frame rate, pixel format, codec and audio layout where needed.
9. Concatenates in requested order and verifies the final output with `ffprobe`.
10. Optionally creates a review contact sheet or seam frames at each cut.
11. Reports whether generated audio is retained, muted, or replaced; it must not claim a custom score/SFX pass unless one was actually mixed.

Do not make FFmpeg a mandatory runtime dependency for MCP browser tools. Keep the assembly helper optional and report a clear prerequisite when FFmpeg/FFprobe is missing.

---

### 3.14 There are multiple official paid-submission entry points; consolidate the commit boundary

**Files:** `src/tools/generate-video.js`, `src/tools/generate-image.js`, `src/tools/create-character.js`, `src/tools/generate-confirm.js`, `src/domain/submission-adapter.js`, `src/domain/live-submission.js`, `src/domain/operations.js`, `src/domain/submission-policy.js`.

**Confirmed in code:** The API surface exposes more than one official way to reach a paid click. Video generation has an inline `confirm_generate:true` branch that builds a handler submission context and calls `executeDurableSubmission()`. The separate `flow_generate_confirm(job_id)` handler performs its own checks, quote reading, credit reservation and Generate click. Character auto-confirm is routed through `handleGenerateConfirm()` after preparation; image generation also has its own auto-confirm option. These routes contain overlapping but not identical verification/commit code.

**Observed in recording:** The agent did not use either official route for the visible Vesper, Rook or three video submissions; it used the external `click-generate.js` helper. The presence of multiple official routes likely made tool-selection behavior less obvious, but the helper remains an agent-side bypass and must not be treated as an acceptable fallback.

**Required fix:** Establish one internal server-side commit service (for example `commitPreparedGeneration`) as the only code allowed to click Generate. It must accept a prepared job ID and authorization context, then perform, in one guarded path:

1. Load the exact durable prepared intent and verify its type/status.
2. Verify current account, project, URL, prompt/description, model, settings and references against the prepared snapshot.
3. Re-read the final UI state immediately before the click; reject any changed or unknown field. For video, re-open/read the model row and reference mode rather than trusting `model_used` or the prompt-bar chip.
4. Read a known current quote or apply only the explicitly configured account-bound character-free policy.
5. Enforce project budget and one-shot idempotency/reservation.
6. Capture baseline assets, click exactly once, and persist submission outcome.
7. Reconcile `submitted`, `output_detected`, `pending`, `submission_unknown`, `blocked`, and `completed` without blind retries.

All public compatibility paths (`flow_generate_confirm`, `flow_generate_video(confirm_generate:true)`, image/character `auto_confirm`) should either call this service or be deprecated and rejected with a migration message. Do not leave a second direct-click implementation in any generator. Prefer prepare-only tools plus `flow_generate_confirm` in the production skill, while preserving backward compatibility by routing old flags to the same service for a deprecation window.

**Important:** This is a consolidation of official MCP routes, not permission to bypass them. Retain the existing reservation ledger, prepared-job state, live authorization and operation idempotency. Review `executeDurableSubmission()` and `handleGenerateConfirm()` before refactoring so their stronger guarantees are merged rather than lost.

**Acceptance criteria:** Static search finds one server-side Generate-click primitive. Every official generator path reaches it. A test that invokes two different public paths with the same prepared job can never create two remote submissions.

### 3.15 Reference assets are being regenerated/re-uploaded instead of reused

**Files:** `src/browser/upload.js`, `src/assets/catalog.js`, `src/tools/generate-image.js`, `src/tools/create-character.js`, `src/tools/download-latest.js`, production skill asset manifest.

**Observed in recording:** The native reference picker contains multiple Vesper/Rook sheet-like entries after repeated attempts. The session also performs multiple image generation attempts and repeated local uploads while trying to resolve character attachment. This pollutes the project library and increases the chance that filename-only matching becomes ambiguous.

**Required fix:** Add a content-addressed reference reuse layer:

- Hash each local reference file (SHA-256) before opening Flow's picker.
- Persist `{account, projectId, localHash, byteSize, mime, flowAssetId, observedTitle, sourceJobId}` once the Flow asset ID is positively observed.
- Before upload, query the project asset catalog/manifest for an exact account+project+hash match and reuse that known asset where the UI supports “Add from Project”.
- If Flow does not expose a stable link from an existing project asset to the local hash, do not guess; return a duplicate/identity decision blocker or upload once and record the new asset ID.
- Do not match a duplicate asset by filename or DOM order alone.
- Keep generated sheets and native Character objects as separate asset types.
- Do not automatically delete existing Flow assets as a cleanup step; deletion is destructive and should require a separate explicit user request.

**Acceptance criteria:** A retry with the same local image does not create another upload when the exact asset mapping is already known; an identical title with a different hash/ID is not silently reused.

### 3.16 Prompt QC currently labels camera-movement vocabulary as “optics”

**File:** `src/utils/prompt.js`, plus `src/tools/generate-video.js` and tool-schema descriptions in `src/utils/validate.js`.

**Confirmed in code:** `OPTICS_HINTS` contains not only technical lens/optics words (`f/1.4`, `anamorphic`, `35mm`, `aperture`, `focal`, `lens`) but also camera-movement terms (`dolly`, `crane`, `orbit`, `jib`, `drone`). `checkPromptContradictions()` emits a warning that describes these collectively as “optics terms (lens/aperture/camera body)”. That message is inaccurate for prompts that say “camera orbit” or “dolly”. The production skill/tool schema already expose a `camera` field for supported camera moves.

**Observed in session:** The authored fight prompts use orbit/rotation/low tracking language, and the agent received the optics warning. The warning is advisory rather than a readiness blocker, but the wording encouraged the agent to over-correct natural camera direction and muddied diagnosis of the actual `prepared_unverified` state.

**Required fix:** Split the classifier into distinct categories:

- Technical lens/optics parameters that should normally be expressed through supported UI controls (for example aperture or focal-length specifications).
- Camera movement vocabulary that is valid scene direction and should not be mislabeled as optics.
- Supported `camera` selector values versus free-form cinematic staging that can remain in the prompt.

Rename the warning and add tests for `orbit`, `dolly`, `tracking shot`, `35mm`, `f/1.4`, `lens`, and ordinary words such as “camera tracks low”. Advisory warnings must remain separate from hard readiness blockers.

### 3.17 Long fixed sleeps create orchestration timeouts without proving render state

**Files:** production skill, shell/automation helper guidance, `src/tools/generate-confirm.js`, queue/asset polling utilities.

**Observed in recording/log:** The agent used fixed `Start-Sleep` waits, including a 150-second wait that exceeded the shell tool's observed 120-second command limit. Waiting longer does not itself prove that the exact Flow asset has completed rendering.

**Required fix:** Replace fixed sleeps with bounded polling against positive project-library evidence for the exact generation/asset. Use a short polling interval with exponential backoff, an overall deadline, cancellation/timeout reporting and a screenshot/last-observed-state payload. Polling must not submit again. Keep local queue state distinct from remote render state. If the MCP cannot correlate the remote tile to a stable asset ID, report `remote_status_unknown` and require inspection/selection rather than claiming completion.

**Acceptance criteria:** A render taking longer than the shell command cap does not cause command failure or another Generate click; timeout returns a resumable pending state.

### 3.18 `prepared_unverified` diagnostics must distinguish final state from failed attempts

This is the combined code-level conclusion from findings 3.6–3.7 and the recording. The screen shows a composer that appears configured and later a helper click, while the tool response remains `prepared_unverified`. The source reveals two reasons why the return can be misleading:

1. Final settings readback omits model/mode/reference mode even though the model setter has a separate earlier readback.
2. A fallback settings configuration can repair current state while the original `barFailed` array remains in `failedSettings` for the final readiness check.

The revised result must expose `attempts[]` and `finalState.fields[]` separately. The final-state gate should use only authoritative final evidence; a failed attempt is diagnostic history. However, if the final state is unknown or any required setting is mismatched, the job remains unconfirmable. Never “fix” this by allowing the agent to infer ready from the visible Generate button.

## 4. Agent orchestration and production-skill corrections

**Files:**

- `skills/google-flow-production/SKILL.md`
- `skills/google-flow-production/references/flow-tools.md`
- `skills/google-flow-production/references/continuity.md`
- `skills/google-flow-production/references/assembly.md`
- `skills/google-flow-production/templates/shot-plan.md`
- `skills/google-flow-production/templates/asset-manifest.json`

### 4.1 Tool selection rules

The agent must distinguish these operations explicitly:

| User intent | Correct operation |
|---|---|
| Create a visual reference sheet of a character | `flow_generate_image` |
| Create a reusable native Google Flow Character | `flow_create_character` |
| Inspect registered project characters | `flow_open_characters` |
| Rename a generated Flow Character | `flow_rename_character` |
| List exact `@` references available in the project | `flow_list_mention_options` |
| Generate a video shot | `flow_generate_video` |
| Submit a prepared paid generation | The documented confirmation API routed to the shared server-side commit service (prefer `flow_generate_confirm`) |
| Download a completed exact asset | `flow_download_latest` with `asset_id` where needed |

Generating an image that depicts Vesper or Rook does not satisfy a request to create Flow Character objects. The workflow must create both the reference image(s) and the native character object when both are requested.

### 4.2 No out-of-band paid-click bypasses; one internal commit service

The source currently has multiple official submission entry points (see finding 3.14); those must converge on one guarded server-side commit service. The production skill should prefer prepare-only operations followed by `flow_generate_confirm` so the agent has one predictable public workflow. The agent must explicitly never bypass that shared service with:

- Standalone Node/CDP scripts that click Generate.
- Browser-console DOM clicks.
- Coordinate-based PowerShell clicks.
- Direct form submission or other untracked browser interactions that avoid the operation/credit ledger.

CDP and Playwright are valid internal implementation mechanisms inside the MCP. The prohibition is against an agent creating an out-of-band submission route that skips prepared-state verification, quote parsing, credit reservation and idempotency.

If preparation fails, the agent should inspect the returned blocker list, correct the inputs/UI state through the supported MCP operation, and prepare again. If the MCP cannot safely proceed, it should stop and report the blocker rather than inventing a bypass.

### 4.3 Preflight the continuity strategy before any video generation

For multi-clip work, produce a shot plan with:

- Clip index and requested duration.
- Model and requested output settings.
- Reference mode (`ingredients` or `frames`).
- Required project `@` assets or local frame path.
- Expected first-frame state.
- Expected ending pose/state.
- The asset/frame that will be carried to the next clip.
- Any unsupported combination identified before submission.

For the *Ashes of the Undercity* example:

| Clip | Reference strategy | Required input |
|---|---|---|
| 01 | Ingredients | Vesper + Rook + bridge environment |
| 02 | Frames | Last frame of Clip 01 as start frame; no ingredients in the same request |
| 03 | Frames | Last frame of Clip 02 as start frame; no ingredients in the same request |

This respects the current Frames/Ingredients mutual-exclusion rule while preserving frame-to-frame continuity.

### 4.4 Make the agent diagnose `prepared_unverified` rather than bypass it

The skill should require the agent to read:

- `blockers` (new structured response field).
- `settings_verification.fields`.
- `frame_verification`.
- `references` / `ingredients_inserted` / `ingredients_failed`.
- `ui_unverified` and selector-level diagnostics.
- `attempts[]` separately from `finalState.fields[]` so a repaired setter attempt is not confused with the final state.
- Exact remote/asset status where available.
- Screenshot path.

It should never infer that a preparation is ready just because the Generate arrow looks enabled or a screenshot appears plausible. It must not click when the MCP result is `prepared_unverified`.

### 4.5 Asset manifest discipline

After every generation/download, immediately write/update the manifest with:

- Project ID/URL.
- Requested prompt hash.
- Requested and observed model/settings.
- Prepared job ID.
- Confirmation/operation ID.
- Remote asset ID.
- Local path.
- SHA-256 and media type.
- Render/download verification status.
- Continuity frame path and hash, if extracted.

The existing `templates/asset-manifest.json` should be expanded rather than replaced with a separate schema.

---

## 5. File-by-file change map

| File | Change required | Priority | Notes |
|---|---|---:|---|
| `src/tools/create-character.js` | Split prepare/confirm/finalize; remove dead submit branches; call native form upload adapter; return exact blocker details | P0 | Main character workflow |
| `src/browser/upload.js` | Add guaranteed overlay cleanup; preserve exact per-file asset IDs; add content-hash reuse hooks; keep generic composer upload behavior stable | P0 | Do not regress existing W04 tests |
| `src/assets/catalog.js` | Persist account+project+local-hash to Flow asset ID mappings and prevent repeat uploads when identity is known | P1 | Extend existing registry; do not infer identity by title |
| `src/browser/character-form.js` | Add native form reference attachment/readback helpers; retain portrait verification | P0 | Character-specific UI adapter |
| `src/browser/overlay-manager.js` *(new if needed)* | Track/close owned dialogs and verify clean return to underlying UI | P0 | Shared reusable primitive |
| `src/tools/generate-confirm.js` | Refactor into shared commit service; keep quote, budget, state-binding and idempotency guards; improve character identity result | P0 | Merge guarantees from all current submission paths |
| `src/domain/commit-prepared-generation.js` *(new or equivalent existing domain service)* | Single internal Generate-click authority for image/video/character, with quote, reservation, final snapshot, idempotency and outcome reconciliation | P0 | Replace duplicated direct submit code, not safety checks |
| `src/domain/submission-adapter.js` / `src/domain/live-submission.js` | Consolidate into the shared commit service and define backwards-compatible adapter behavior | P0 | Avoid two competing submission engines |
| `config/flow.config.example.json` | Document `freeCharacterImages` policy schema clearly; keep default `null` | P0 | Account owner must confirm free pricing |
| `src/tools/generate-video.js` | Final settings readback, structured blockers, exact duration verdict, preserve reference-mode exclusivity | P0/P1 | Main video-generation workflow |
| `src/browser/safe-actions.js` | Make setter/readback transaction atomic; model/ratio/quality/duration/mode readback from final settings panel | P1 | Keep selectors scoped to owned panel |
| `src/browser/capabilities.js` | Reuse tri-state capability records consistently; exact bound duration verdict | P1 | Avoid unknown-as-supported |
| `src/utils/models.js` | Remove stale force-8s comments/default or define their true semantics; clarify catalog vs capability evidence | P1 | Current resolver is a pass-through (`forced:false`) |
| `src/utils/prompt.js` | Separate technical optics warnings from camera-movement terms; fix misleading warning copy | P1 | `orbit`/`dolly` are currently classified as optics |
| `src/navigation/model-discovery.js` | Discover/store exact model-feature combinations where UI permits; verify restore after discovery | P1 | Avoid poisoning cache |
| `src/navigation/character-rename.js` | Prefer stable character URL/ID; keep exact page/name verification | P1 | Avoid title-only ambiguity |
| `src/tools/rename-character.js` | Return requested/observed name and verification evidence | P1 | Explicit status |
| `src/tools/download-latest.js` | Preserve current ambiguity behavior; correlate exact asset identity with operation/job manifest | P1 | Do not guess latest |
| `src/assets/catalog.js` | Extend current asset manifest if necessary; avoid duplicating existing ID/hash/signature logic | P1 | Most primitives already exist |
| `src/tools/generate-image.js` | Share final settings verifier/editor readback and route auto-confirm through the shared commit service | P1 | Apply common correctness logic |
| `src/utils/validate.js` | Reconcile schema descriptions for ingredients duration/model behavior with runtime capability policy; document deprecated confirmation flags if needed | P1 | Current schema says Ingredients require 8s while resolver passes requested duration through |
| `scripts/assemble-video.mjs` *(new)* | FFprobe, robust last-frame extraction, concat, output validation | P2 | Optional FFmpeg-dependent helper |
| `skills/google-flow-production/SKILL.md` | Tool selection, no bypass, end-to-end orchestration | P0 | Agent behavior |
| `skills/google-flow-production/references/flow-tools.md` | Accurate model/reference/duration constraints and confirmation rules | P1 | Keep live capability distinction |
| `skills/google-flow-production/references/continuity.md` | Ingredients-versus-frames planning and chain-frame steps | P1 | Multi-clip continuity |
| `skills/google-flow-production/references/assembly.md` | Scripted media QA and accurate audio deliverable reporting | P2 | Production export |
| `skills/google-flow-production/templates/asset-manifest.json` | Persist job → asset → local file → frame identity | P1 | Extend existing format |

---

## 6. Test strategy and regression coverage

The repository already has meaningful coverage. Keep the existing tests and add tests around the gaps exposed by the real session. Do not write a second parallel test framework.

### 6.1 Existing relevant tests to retain and extend

| Existing test | Existing coverage area |
|---|---|
| `tests/character-form.test.js` | Archetype response handling and portrait verification |
| `tests/w04-upload.test.js` | File chooser, stable identity, attachment acknowledgement and slot verification |
| `tests/w04-upload-refs.test.js` | Upload behavior, race handling and stable asset identity |
| `tests/character-library.test.js` | Character library behaviors |
| `tests/character-open-ready.test.js` | Character page readiness |
| `tests/confirmation-quote.test.js` | Quote parsing and account-owned free-character pricing policy |
| `tests/generate-confirm-handler.test.js` | Shared confirmation path |
| `tests/w03-read-tool-state.test.js` | Composer tool-state parsing |
| `tests/w03-capabilities.test.js` | Tri-state capability and exact duration semantics |
| `tests/video-reference-mode.test.js` | Frames/Ingredients mode verification |
| `tests/fixed-video-settings.test.js` | Fixed video settings behavior |
| `tests/w03-settings-identity.test.js` | Settings panel identity and ownership |
| `tests/w05-t3-poll-correlation.test.js` | Correlating remote poll results to exact output identity |
| `tests/download-latest.test.js` | Download routing |
| `tests/download-recovery.test.js` | Download recovery and invalid payload rejection |
| `tests/asset-renaming.test.js` | Asset rename behavior |
| `tests/production-skill.test.js` | Production skill structure/requirements |
| `tests/prompt-bar.test.js` | Existing prompt/settings helpers; extend with prompt-QC warning classification |
| `tests/live-submission.test.js` | Live submission policy and authorization |
| `tests/w05-submission-adapter.test.js` | Durable submission adapter and operation outcomes |
| `tests/w04-assets-catalog.test.js` | Asset catalogue identity/reuse behavior |

### 6.2 New native-character upload tests

Add a dedicated fixture for the native character form; do not reuse only the ordinary prompt composer fixture.

Required cases:

1. Upload local image and verify exact ID attached to native character form.
2. Select existing project image and verify exact ID.
3. Two assets with the same title but different IDs: select only the intended exact ID.
4. Same title with multiple candidates and no stable ID: return ambiguous; do not select.
5. File chooser appears but asset never commits: `prepared_unverified` with `reference_not_committed` blocker.
6. Asset is added to ordinary prompt composer but not character form: must fail character attachment verification.
7. Rights-confirmation dialog: return manual blocker and preserve dialog.
8. Picker close failure: return cleanup failure with screenshot/evidence.
9. Missing/unreadable/unsupported local file: fail before opening the picker.
10. Multiple requested references with one missing: report each file separately; never report pack verified.

### 6.3 New upload cleanup tests

Inject failure at every state transition:

- `Add` control missing.
- Upload entry missing.
- File chooser timeout.
- `setFiles()` exception.
- Upload appears but asset ID cannot be read.
- Asset is ambiguous.
- Asset selection fails.
- Add-to-form/commit action fails.
- Rights prompt appears.
- Page navigates while picker is open.

For each case, assert that the UI is either clean and ready for the next operation or explicitly reports a cleanup/manual-intervention state.

### 6.4 New video settings tests

Test the full setting combination, not each setter in isolation:

- Video mode.
- Exact model name, including Omni Flash versus Omni 1.1 Flash.
- 9:16 versus 16:9.
- 720p versus 360p.
- 4s/6s/8s/10s.
- Quantity.
- Frames versus Ingredients reference mode.

Critical regressions:

1. Mode change resets selected model: final readback must catch it.
2. Model change re-renders panel: stale locators must not be reused.
3. Ratio selection clicks but does not persist: final readback must fail.
4. Duration is automatically changed by Flow: report requested versus actual and block.
5. Quality resets after a model change: final readback must catch it.
6. Model row and video prompt chip disagree: settings-panel row is authoritative for model.
7. Fallback setter succeeds after a first failed attempt: final verified state may pass, while diagnostics retain the failed attempt.
8. Fallback setter fails: preparation remains unverified with exact field blocker.
9. Settings panel readback is absent: `unknown`, never default to verified.
10. Reference mode is not selected: no attachment/paid submission.

### 6.5 Capability/duration tests

Test capability bindings across:

- Model.
- Feature (`video`).
- Ratio.
- Quality.
- Reference mode.
- Exact supported durations.
- Explicitly disabled durations.
- Missing/stale/unbound records.
- Account/project mismatch.

The global catalog array must not prove semantic support. Unknown must block a paid generation; supported must require positive evidence; unsupported must require explicit disabling evidence.

### 6.6 Confirmation and price tests

Keep and extend current tests for:

- Known non-zero quote within/outside `max_credits`.
- Unknown quote.
- Exact account/model free character policy.
- Different account/model.
- Conflicting visible credit label.
- Double confirmation.
- Stale preparation.
- Changed prompt/model/project after preparation.
- Browser loss immediately after Generate click.
- Submission unknown reconciliation without a second click.

### 6.7 End-to-end Flow smoke tests

Run in two layers:

**No-spend integration checks:**

- Connect and verify account.
- Open/create a project.
- Discover models and settings.
- Prepare image/video jobs.
- Prepare a character using a native form fixture/live non-submit test.
- Validate upload attachment/readback.
- Validate `prepared_unverified` blocker reporting.
- Inspect existing assets and exact downloads without generating.

**Authorized generation checks:**

Run only with explicit user approval, known live quote or configured account-specific zero-cost policy, and strict `max_credits` ceilings. Verify the remote output and do not auto-resubmit on unknown status.

### 6.8 New asset-reuse and prompt-QC tests

Asset reuse tests:

1. Repeating the same upload in the same account/project with the same SHA-256 reuses the known Flow asset ID when a supported “Add from Project” path exists.
2. Same filename but different hash does not reuse the old asset.
3. Same title but different Flow asset ID is never selected by DOM order.
4. Manifest survives process restart and rejects an account/project mismatch.
5. Failed upload with no confirmed asset ID does not write a reusable mapping.
6. Asset deletion is never performed as an automatic deduplication action.

Prompt-QC tests:

- `orbit`, `dolly`, `crane`, `tracking shot`, and `camera tracks low` do not trigger a technical-optics warning solely because they describe movement.
- `35mm`, `anamorphic`, `aperture`, `focal length`, `lens`, and `f/1.4` are categorized consistently.
- Advisory prompt warnings never become hard preparation blockers.

### 6.9 Shared commit-service and long-render tests

1. Image, video and character public confirmation paths all call the same internal commit service.
2. Old `auto_confirm` / `confirm_generate` compatibility flags route to that service or return a clear deprecation error; they never click directly.
3. Repeating confirmation with the same prepared job and operation ID cannot click twice.
4. Two public APIs presented the same prepared job cannot create two submissions.
5. Account/project/page/prompt/model/settings/reference state changed after preparation is rejected.
6. Unknown quote remains blocked; account-bound zero-cost character policy applies only to exact configured account/model and no conflicting visible price.
7. A remote render taking longer than the shell tool's command ceiling stays pending/resumable rather than timing out an unbounded command.
8. Poll timeout never causes another submission and returns the last observed remote state.

### 6.10 Commands and baseline

The project exposes:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run test:smoke
```

The implementation work should record baseline results before edits and rerun all commands after each milestone. The supplied archive contains 123 top-level test files. The archive was inspected for test coverage, but this plan does **not** claim that the test suite was executed during this audit.

---

## 7. Detailed milestone execution plan

### Milestone 0 — Baseline, traces and diagnostics

**Goal:** Make the current failure reproducible and make future failures diagnosable.

Tasks:

1. Create a branch, e.g. `fix/flow-reliability-overhaul`.
2. Record commit/version, Node version, Flow account binding strategy, config version and browser version.
3. Run the existing test/lint/typecheck/build commands and store results.
4. Capture current screenshots for native character form, character upload, image settings, video settings, model dropdown, ratio/duration/quality controls, and asset picker.
5. Add a structured diagnostics object to all prepare responses:
   - `requested` values.
   - `observed` values.
   - `verified` boolean per field.
   - `evidence` source per field.
   - `blockers[]`.
   - `warnings[]`.
   - `screenshot`.
6. Ensure secrets, cookies, authentication tokens and private browser data are not written into diagnostic logs.

**Exit criteria:** Baseline is saved, existing tests pass or have documented pre-existing failures, and prepare responses can report why a request is not ready.

### Milestone 1 — Upload transaction safety and reference-asset reuse

**Goal:** Every upload success/failure leaves Flow in a known state, and retries do not flood the project with duplicate reference assets.

Tasks:

1. Add overlay ownership tracking or extend the existing browser UI transaction primitives.
2. Wrap the full upload transaction in state-aware cleanup covering picker opening, file chooser, upload, asset discovery, selection, commit, acknowledgement and error paths.
3. Preserve rights-confirmation blockers for human action; never accept rights or dismiss the dialog silently.
4. Make overlay cleanup verify that the specific overlay opened by the operation is gone and the underlying composer/form is interactable.
5. Add content-hash reuse keyed by account + project + local SHA-256, mapping to exact Flow asset ID only after positive evidence.
6. Reuse an existing project asset when a reliable mapping exists and Flow provides a supported “Add from Project” path.
7. Keep generic composer upload acknowledgement separate from native character form acknowledgement.
8. Add fault-injection tests for each upload stage and tests for duplicate titles/hash mismatch.

**Exit criteria:** Force failures at every upload stage and confirm the next operation can still interact with the intended page, or returns a typed cleanup blocker. Repeating the same upload does not create another asset when the exact mapping is known.

### Milestone 2 — Native character creation and finalization

**Goal:** Create Vesper/Rook-class reusable Flow Characters through the official MCP workflow with exact visual reference identity and no manual click helper.

Tasks:

1. Add a native-character-specific reference adapter and form-state readback; use Milestone 1's upload transaction primitives.
2. Confirm the current Flow form contract: identify whether `Add to prompt` commits to a native character attachment slot or a shared chip component, then scope verification to the native form root.
3. Refactor `handleCreateCharacter()` into prepare/confirm/finalize stages.
4. Remove unreachable legacy submission branches and direct-submit fallback code from the character handler.
5. Route character confirmation through the shared commit service (one Generate-click authority for all artifact types).
6. Keep `prepared_unverified` unconfirmable.
7. Integrate account-specific free-character policy diagnostics; leave config `null` until exact policy is owner-confirmed.
8. Persist exact character page URL/ID, requested name, observed model, reference asset IDs and prompt hash.
9. Wait for a decoded portrait before declaring creation complete.
10. Rename and verify, returning requested/observed names and stable character identity.
11. Add dedicated native-character UI fixtures and tests.

**Exit criteria:** A character reference sheet is attached to the native character form, its exact asset ID is verified, the tool prepares truthfully, the shared commit service performs the only Generate click, and the character is returned with verified portrait/name/identity. Repeat for two characters in the same project.

### Milestone 3 — Truthful video settings and readiness

**Goal:** If MCP says `ready_for_confirmation`, Flow must actually show the requested model/settings/reference mode, and every generator must use the same commit authority.

Tasks:

1. Refactor selectors into settings-panel transaction helpers.
2. Re-locate the settings panel after each action that can re-render it.
3. Add exact model/mode/reference-mode readback.
4. Read ratio/quality/duration/quantity from the same authoritative panel.
5. Perform a final full snapshot after all settings and references are applied.
6. Recompute readiness from final snapshot—not initial click success.
7. Expose field-level blockers and retain attempt history.
8. Add tests for mode/model reset behavior and stale locator behavior.
9. Separate initial setter attempts from final UI snapshot; stale `barFailed` entries must not block a positively verified repaired final state.
10. Consolidate video `confirm_generate:true`, `flow_generate_confirm`, image `auto_confirm`, and character auto-confirm behind one internal commit service.
11. Keep only one server-side Generate click primitive; preserve all existing ledger/idempotency protections.

**Exit criteria:** Deliberately request a different model, ratio, duration and quality than the current Flow defaults. The tool either selects and verifies every exact requested value or returns `prepared_unverified` with the exact mismatch. It never returns the requested model as `model_used` when actual selection is unknown.

### Milestone 4 — Model capability/duration calibration

**Goal:** Remove contradictory static comments and ensure each shot is preflighted against the actual model/reference combination.

Tasks:

1. Review all `KNOWN_CAPS` and `DEFAULT_CAPS` assumptions.
2. Reconcile the stale top-level `ingredientsRequireDuration: '8s'` comments/default with `resolveIngredientsDuration()` returning the requested duration unchanged and the tool schema saying Ingredients are 8s-only.
3. Clarify which fields are static documented constraints and which are account/session live observations.
4. Integrate `getDurationVerdict()` into the actual generation path.
5. Design exact capability record keys for model, feature, ratio, quality and reference mode.
6. Persist account/project binding, observation timestamp and evidence.
7. Update model discovery to gather only facts positively observable in Flow.
8. Do not infer duration restrictions from a missing option row.
9. Remove/replace `resolveIngredientsDuration()` only after deciding the canonical policy; no silent force-8s behavior.
10. Add tests for the session-observed Omni behavior, but keep those tests bound to their fixture/account observation rather than treating them as universal Google Flow guarantees.

**Exit criteria:** The video tool can explain why a requested combination is supported, unsupported, or unknown. Unknown does not proceed to paid confirmation.

### Milestone 5 — Asset and remote-generation traceability

**Goal:** Preserve exact identity from local reference file through Flow asset, preparation, remote render and downloaded output.

Tasks:

1. Reuse current operation store and asset catalog.
2. Consume the account/project/local-hash → Flow asset ID mapping created in Milestone 1 when resolving reference assets and downloads.
3. Persist prepared job ID, operation ID, project ID, account binding and output baseline.
4. Persist exact remote asset ID once positively correlated.
5. Keep ambiguous asset results as a user/agent selection requirement.
6. Improve skill instructions to preserve full candidate result arrays.
7. Add/extend a bounded remote wait/poll utility only if it can query positive evidence for the exact asset. Replace fixed long sleeps with poll status.
8. Do not auto-retry unknown submissions.
9. Keep byte-signature and hash verification for downloads.

**Exit criteria:** Every downloaded video/image maps to one exact generation/operation/asset record. Ambiguity stays explicit. A timeout never causes an accidental second paid submission.

### Milestone 6 — Repeatable media assembly

**Goal:** Replace ad-hoc PowerShell command construction with one tested production helper.

Tasks:

1. Implement FFprobe inspection.
2. Implement robust last-frame extraction with verified fallback.
3. Build a shot manifest and frame manifest.
4. Normalize sources before concatenation where required.
5. Concatenate in declared order.
6. Verify final duration/resolution/frame rate/video codec/audio codec.
7. Generate seam preview images around cuts.
8. Report generated audio separately from custom score/SFX.
9. Make music/SFX mixing an explicit optional stage with its own inputs and validation.

**Exit criteria:** A test project with three clips can be chained by verified last frames and exported to a verified MP4 in one reproducible command. Missing FFmpeg, missing audio, or failed frame extraction is reported accurately.

### Milestone 7 — Production skill and end-to-end workflow

**Goal:** The agent selects the right tool and completes a multi-shot project without unsafe improvisation.

Tasks:

1. Update tool-selection rules for images versus native characters.
2. Add a required per-shot reference-mode preflight.
3. Add a required check of field-level blockers before any paid confirmation.
4. Prohibit out-of-band Generate-click scripts.
5. Require explicit preservation of exact asset IDs and full ambiguity results.
6. Document the correct status semantics: prepared, ready for confirmation, submitted, output detected, rendering, ready, downloaded, verified.
7. Require final output QA and honest audio reporting.
8. Correct prompt-QC guidance so camera movement (orbit/dolly/tracking) is not mislabeled as technical optics.
9. Add a full mock workflow test for `environment → characters → clip 1 → final frame → clip 2 → final frame → clip 3 → assembly`.

**Exit criteria:** A fresh agent session can follow the skill from a new project to a verified multi-clip export using only documented MCP operations, with no custom click bypass and no incorrect claims of completion.

---

## 8. Final acceptance checklist

### Native characters

- [ ] `flow_create_character` creates native Flow Character objects, not only reference images.
- [ ] Native reference uploads use the native character form's attachment control.
- [ ] Exact reference asset IDs and native-form attachment are verified.
- [ ] Character upload failure cannot leave an unowned overlay open.
- [ ] Repeated reference files are reused by content hash when a known project asset mapping exists; no silent filename-based reuse.
- [ ] Account-specific free character policy is used only when explicitly configured and matched.
- [ ] Unknown character quote remains blocked.
- [ ] Character submissions use the shared commit service; the production agent submits through `flow_generate_confirm` (legacy auto-confirm wrappers, if retained, route to the same service).
- [ ] Portrait decoding, character identity and final name are verified.

### Images and videos

- [ ] Image model and ratio are independently read back.
- [ ] Video mode, model, ratio, quality, duration, quantity and reference mode are independently read back after all setting/reference operations.
- [ ] Final snapshot reports exact model separately from the requested/resolved model; unknown model blocks readiness.
- [ ] A settings change that resets another field is detected.
- [ ] Requested and actual values are both returned.
- [ ] Unknown values never count as verified.
- [ ] `prepared_unverified` returns a complete blocker list.
- [ ] Frames and Ingredients remain mutually exclusive unless Flow capability is positively changed and the tool contract is updated.
- [ ] Duration/capability decisions are bound to exact model and reference configuration.

### Safety, identity and downloads

- [ ] Unknown costs never become zero automatically.
- [ ] All public paid-generation paths converge on one internal durable commit service and one server-side Generate-click primitive.
- [ ] One approval cannot submit twice.
- [ ] Unknown submission state is reconciled, never blindly retried.
- [ ] Ambiguous asset selection remains blocked until an exact candidate is selected.
- [ ] Downloaded bytes are signature-checked and hashed.
- [ ] Job, operation and remote asset identities are preserved.

### Assembly and agent behavior

- [ ] Final-frame extraction succeeds or reports a useful explicit failure.
- [ ] Clip chain frame paths/hashes are recorded.
- [ ] Final concatenated MP4 passes FFprobe validation.
- [ ] Audio presence is detected and reported accurately.
- [ ] Custom score/SFX is reported only if actually mixed.
- [ ] The production skill differentiates character sheets from native Flow Characters.
- [ ] The agent never uses an out-of-band Generate-click script.
- [ ] The agent does not mistake native Character creation for reference-sheet image generation.
- [ ] Camera-movement terms do not produce misleading technical-optics warnings.
- [ ] Remote waiting is bounded/poll-based; fixed sleeps do not exceed tool command limits.
- [ ] The entire workflow passes an end-to-end regression run.

---

## 9. Explicit non-goals and safeguards not to remove

These behaviors are correct and should remain intact:

1. **Do not allow `prepared_unverified` jobs to be confirmed.** Fix the reason a preparation becomes unverified; do not weaken the gate.
2. **Do not interpret an absent price as zero.** Configure only a specific, owner-confirmed, account-bound free-character policy if applicable.
3. **Do not guess which asset is newest.** Exact asset identity and ambiguity handling are correct safeguards.
4. **Do not combine Frames and Ingredients in one shot under the current contract.** The session demonstrated that the tool correctly rejects this combination; plan the continuity approach accordingly.
5. **Do not treat local queue completion as remote render completion.** Continue to require positive remote asset evidence before download.
6. **Do not retry a paid generation automatically when submission status is unknown.** Inspect and reconcile first.
7. **Do not use external CDP/DOM/coordinate click helpers to submit.** CDP is permitted inside the MCP, but every Generate click must pass through the shared guarded commit service.
8. **Do not treat a picker preview or `Add to prompt` button as proof that the native character form has a committed reference.** Read back the actual form state.

---

## 10. Definition of done

The overhaul is complete when the acceptance checklist passes and a fresh production run can:

1. Create a new Flow project.
2. Generate and verify the environment and character reference images.
3. Create reusable native Flow Characters with the intended references attached and the exact reference asset IDs recorded.
4. Verify each character's portrait, name and stable character URL/ID.
5. Discover the current model/settings capabilities for the verified account/project.
6. Preflight each video shot's model, duration, ratio, quality and reference mode.
7. Prepare each shot and expose truthful field-level diagnostics.
8. Submit only through the shared durable commit service; no alternate generator or helper can click Generate independently.
9. Track each remote render to an exact asset ID.
10. Download and verify each output.
11. Extract the true final frame of each clip for continuity.
12. Assemble and validate the final video.
13. Report exact duration, resolution, codecs, audio status and any remaining post-production work.
14. Complete the run without an external `click-generate.js` helper, filename-only asset selection, or blind long sleeps.

### Revision 2 — recording-driven corrections

This revision incorporates direct visual evidence from the 46:23.9 recording. It corrects the earlier character-outcome wording (both native Characters eventually existed), documents the external `click-generate.js` submissions for Vesper, Rook and all three clips, adds the repeated-reference-asset problem, clarifies that final model selection is not independently proven by the composer chip, adds the duplicate official submission routes, and identifies the stale `barFailed` readiness path plus the misleading camera-movement QC warning. The recording and log are sufficient for this plan; the remaining live-UI uncertainty is handled by the fixture and controlled integration tests above.

**Core engineering principle:** The MCP must report what Flow actually shows and what Flow actually produced—not merely what the agent requested, clicked, or assumed happened.

## 11. Complete failed-call and agent-generated-script reconciliation

This section reconciles every explicit MCP error, blocked/ambiguous result, `prepared_unverified` state, and failed shell/media operation recorded in the supplied session transcript. It distinguishes genuine defects from intentional fail-closed behavior. A red tool result is not automatically a bug: some red results correctly prevented an unsafe or unsupported action.

### 11.1 Red/error tool-call ledger

| Session event / result | Classification | Root cause or interpretation | Required plan item / regression |
|---|---|---|---|
| `flow_generate_image` returned `POLICY_DENIED`, binding `ratio`, for requested `3:4` | **MCP defect / selector-readback failure** | The handler's final readback did not bind the approved ratio to the visible Flow setting. The subsequent prepare-only attempt reported `actual.ratio: null`; do not assume the ratio itself is unsupported merely because readback failed. | Fix image ratio set/readback as a transaction; test every live-supported ratio and ensure `null` fails readiness with an actionable `actual`/evidence diagnostic. |
| A second `flow_generate_image` request for `4:3` returned the same `POLICY_DENIED` | **Same MCP defect** | The retry changed the requested value but did not repair the underlying selector/readback issue. | Add a retry regression that proves a second ratio request does not silently reuse the previous selection and that the final ratio is read after all model changes. |
| Prepare-only image call for `4:3` returned `prepared_unverified`, `actual.ratio: null` | **MCP diagnostics/readback defect** | The tool returned the requested ratio in the top-level `ratio` field while the verified `actual` field was null. The response is technically fail-closed, but its duplicated fields can mislead an agent. | Make requested and actual values visibly distinct in the schema; never label a requested value as `model_used`/`ratio` without also clarifying it is requested or resolved, not observed. Add a null-readback test. |
| Rook's long multiline prompt returned `UNKNOWN_UI_CHANGE` / prompt readback mismatch | **MCP defect or UI-normalization mismatch** | The editor was a ProseMirror `contenteditable` textbox. The prompt was multiline and long; browser-rendered `innerText`/`textContent`, block boundaries, line endings, and whitespace can differ from the input string. The error's expected prompt was large, but the log did not provide enough readback evidence to prove truncation versus normalization. | Implement a contenteditable-aware readback and canonical comparison; preserve text and meaningful newlines; include bounded diagnostics (length, hash, diff summary), not the entire potentially huge prompt. Test long and multiline content. |
| `flow_create_character` with local reference images repeatedly returned `prepared_unverified` (`inputAccepted: 0` / `attached: 0`) | **MCP defect in native character attachment flow** | The normal composer upload/ingredient path is not proof that a reference was committed to the native Characters form. The native picker showed previews and an `Add to prompt` control, but the tool's verifier did not establish a committed attachment. | Implement and test the native character-form upload/select/commit/readback adapter. A preview or chooser event is not a successful attachment. |
| `flow_create_character` without references returned `MANUAL_VERIFICATION_REQUIRED`, quote state `unquoted` | **Correct safety rejection; missing account policy/configuration** | Unknown price must not be treated as zero. The user later stated that image and character generations cost 0 credits for the account; this should be represented as an explicit verified account/model policy, not by weakening the general quote guard. | Add an account-bound free-character policy with explicit user authorization and conflict checks. Test unknown quote without policy (blocked), exact allowed account/model (0-credit policy accepted), other account/model or visible conflicting price (blocked). |
| `flow_generate_confirm` for a character job returned `INVALID_PARAMS` because the job was not `ready_for_confirmation` | **Correct safety rejection** | The job had been returned as `prepared_unverified`; the confirmation API correctly refused it. | Preserve this guard. Improve the originating preparation diagnostic so the agent fixes the actual blocker instead of trying to force-confirm. Add a test that every `prepared_unverified` job remains unconfirmable. |
| `flow_rename_character` returned `INVALID_PARAMS` because neither `name` nor `character_id` was supplied | **Agent/tool-contract misuse, with schema ergonomics improvement** | The call supplied `new_name` and project URL but omitted the current name or stable character identity. The follow-up call with `name: "Untitled character"` succeeded. | Validate before browser navigation; return an example of the required fields. Prefer stable `character_id` where the live UI provides it; do not invent an identity. Add missing-name and ID-based rename tests. |
| `flow_generate_video` timed out clicking the prompt because a CDK `Asset list` overlay intercepted pointer events | **MCP UI-state/cleanup defect** | The asset picker remained open after a previous interaction and blocked the contenteditable composer. The Playwright call retried for 30 seconds, then failed. | Add scoped overlay ownership/cleanup and a composer-accessibility precondition. Close the exact active picker and verify it is gone before interacting with the prompt. Test a stale listbox overlay and confirm cleanup on success, timeout, and exception. |
| `flow_generate_video` rejected `start_frame` + `ingredients` with `INVALID_PARAMS` | **Correct safety/capability rejection; agent planning error** | The implementation intentionally treats Flow Frames and Ingredients as separate conditioning modes. The agent attempted both together. | Preserve mutual exclusion and reject in local preflight before touching the UI. Improve tool error text and production-skill planning to choose Ingredients or Frames per clip. |
| Video preparation requested `10s` but Flow read back `8s`; result was `prepared_unverified` | **MCP capability/settings mismatch** | The selected video model plus ingredient conditioning did not accept the requested 10-second duration in that run. The MCP returned a mismatch and correctly blocked confirmation. | Capability discovery must be per model + conditioning mode and use live observations; duration verdict must be enforced at preflight. Never silently coerce 10s to 8s. |
| A later settings-panel screenshot showed `Omni 1.1 Flash`, `360p`, `4s`, `16:9` while the target was `Omni Flash`, `720p`, `8s`, `9:16` | **MCP settings application/readback defect plus user intervention** | The MCP's reported `actual` values were not a complete final snapshot; the settings UI exposed defaults/old values. The user manually corrected settings. Later composer chips showed 720p/8s, but did not expose model identity. | Verify model, ratio, resolution, duration, quantity, mode, and conditioning mode from the final settings panel after all setters have run. Re-read after any selector change that can reset other controls. Block confirmation on mismatch. Model remains unproven unless its selector is explicitly observed. |
| Video preparation returned `prepared_unverified` even when shown settings and a start-frame attachment were verified | **MCP readiness aggregation/diagnostic defect** | A generic overall state hid the exact failed condition. The source audit identifies a stale `barFailed` array reused after a fallback configuration attempt, so an earlier failed setter could still poison the final readiness verdict. Other references/slots may also have contributed; expose all rather than guess. | Recompute final readiness only from a fresh final UI snapshot and final attachment evidence. Retain per-attempt history separately. Add regression where initial setter fails, fallback repairs it, and final state verifies; test genuine remaining failures too. |
| Video QC warned that prompt terms such as `close-up`, `shot`, or `camera` were optics terms | **MCP prompt-QC false positive** | The intended scene/camera-movement vocabulary was conflated with physical optics terms. The session showed the warning being removed by prompt rewriting, but the heuristic was too broad or too opaque. | Separate allowed cinematic direction from lens/body/aperture specifications. Make the diagnostic identify the exact matched token and test valid camera moves like push-in, orbit, close-up, tracking shot. |
| `flow_download_latest` returned `ambiguous` when multiple eligible assets existed | **Correct safety behavior; agent result-handling weakness** | The tool correctly refused to infer “latest” from DOM order and returned exact candidate IDs/titles. The agent initially discarded one result, then fetched candidates again and chose by ID. | Preserve the ambiguity guard. Require the agent to retain the full candidates array and pick by exact asset ID/title or ask the user. Add a test that the wrapper never discards `choices`/`assets`. |
| A video with `start_frame` returned settings and frame attachment verified but overall result still `prepared_unverified` | **Readiness/slot-accounting defect until proven otherwise** | `frame_verification.start_frame.verified` was true and the displayed `settings_verification.verified` was true. The overall blocker was not explained; the `frame_notes` also reported `file input accepted 0/1` alongside `acknowledged identities: 1/1`, which is contradictory. | Treat upload acceptance, slot detection, identity acknowledgement, and attachment commit as separate facts. Return the exact failed predicate. Never allow an identity-acknowledgement signal to overwrite file-input rejection. Add mixed-signal regression tests. |
| `ffmpeg -sseof -0.05` did not create `CLIP01_LAST.png`; frame-index extraction at `n=191` succeeded | **Media-script robustness defect, not MCP UI failure** | End-relative seek did not yield a PNG in this input/command combination. A known frame-index extraction worked. | Add FFprobe-based frame selection with fallback from timestamp seek to decoded final frame; verify exit status, file existence, decodability and frame timing. |
| `Start-Sleep -Seconds 150` plus screenshot helper exceeded the shell tool's 120-second limit | **Agent orchestration/script timeout** | Fixed sleeps exceeded the execution ceiling and did not prove remote state. A follow-up screenshot call later worked. | Replace sleeps with bounded polling of remote asset/render state, with shorter individual calls, deadlines and resumable status. No resubmission on timeout. |

### 11.2 Agent-generated helper scripts: source audit and disposition

The session log contains the complete source for the following scripts in `Tool: write` payloads. They were created outside the MCP repository under `C:\Extra\aivid\scripts`; they are not part of the supplied ZIP. Their source can nevertheless be audited from the log.

| Generated helper | What it actually did | Problems / risk | Replacement in the implementation |
|---|---|---|---|
| `click-generate.js` | Connected directly to CDP at `127.0.0.1:9222`, chose the first Flow page, located the first `button[aria-label="Start generation"]`, clicked it, waited 2.5 seconds, then saved a screenshot. It was invoked for Vesper, Rook, Clip 1, Clip 2 and Clip 3. | Bypassed `flow_generate_confirm`, approved-job binding, quote verification, project/account checks, budget reservation and durable idempotency. It did not bind the click to the prepared job or verify exact UI configuration. `clicked: true` meant only Playwright's click completed, not that Flow accepted the job. This is the most serious workaround in the session. | Remove from the production workflow. All Generate clicks must go through one server-side commit boundary used by every paid operation, including native characters, images and videos. Add code/skill policy and tests preventing external direct-click fallbacks. |
| `clean.js` | Connected to the same CDP endpoint, pressed Escape three times with 400 ms gaps, counted visible CDK listbox overlays, and took a screenshot. It did clear the stale asset list in the observed run (`overlays: 0`). | Broad Escape presses are not scoped to an overlay owned by the tool; they can dismiss unrelated menus/dialogs or discard an in-progress UI state. `overlays: 0` alone does not prove the correct composer is available or unchanged. | Replace with a shared MCP overlay manager that identifies overlay type/owner, closes the specific picker using its own close control or targeted Escape, verifies disappearance, then verifies composer state/URL/prompt/attachments/settings remain intact. |
| `shot.js` | Connected over CDP, selected the first Flow page, took a screenshot to `C:\Extra\aivid\scripts\<name>.png`, and closed the Playwright browser connection. Used after fixed sleeps to inspect Vesper, Rook and video renders. | Duplicates existing `flow_screenshot`; selects the first matching page without checking project/target; its output is only a screenshot and does not establish render completion. It adds another CDP client and may interfere with shared browser/session lifecycle. | Use `flow_screenshot` for point-in-time inspection and a dedicated remote-render polling/status operation for completion. Screenshots are evidence for visual inspection, not proof of job state by themselves. |
| Ad-hoc PowerShell/FFmpeg command sequence | Created work folders, probed videos, extracted frames by timestamps/frame indices, wrote concat manifests, concatenated the clips and ran FFprobe on the final output. | Not a stable reusable utility; one end-relative extraction failed; commands were manually assembled and the 150-second fixed wait exceeded the shell timeout. The final assembly did succeed, so this is maintainability/reproducibility debt rather than total pipeline failure. | Add optional cross-platform `scripts/assemble-video.mjs` with explicit input manifest, FFprobe validation, timestamp/frame-index fallback, concat, audio stream policy, measured output duration and machine-readable report. Keep it outside the browser MCP critical path. |

**Important correction to the earlier revision:** the `click-generate.js`, `clean.js`, and `shot.js` source is absent from the MCP ZIP but present in the session log. It has now been reviewed at source level. `click-generate.js` is not merely an unknown external helper; its code confirms the direct-click bypass described above.

### 11.3 Tool-call taxonomy: what must be fixed versus what must stay blocked

Keep these correct guardrails intact:

- `MANUAL_VERIFICATION_REQUIRED` for an unknown price, unless an explicit account-bound policy authorizes the exact free operation.
- `flow_generate_confirm` rejecting a `prepared_unverified` job.
- `INVALID_PARAMS` for `start_frame` combined with Ingredients mode.
- `flow_download_latest` returning `ambiguous` instead of guessing an asset identity.

Fix the defects around those guardrails:

- Native character reference upload and Add-to-prompt commit evidence.
- Image ratio selector/readback and long prompt editor readback.
- Overlay cleanup before prompt/editor clicks.
- Complete final video model/settings readback and stale readiness aggregation.
- Reconciliation of upload/input acceptance versus slot/identity evidence.
- More precise prompt-QC camera/optics classification.
- Agent input validation for character rename and preservation of ambiguous download candidates.
- Replace all out-of-band scripts and blind waits with official MCP operations and bounded state polling.

### 11.4 Additional acceptance tests required for complete red-call coverage

Add explicit tests for each failure above, including:

1. Image ratio `3:4` and `4:3` mismatch returns an actionable readback result and never passes confirmation.
2. Multiline/long ProseMirror text round-trips with canonical normalization and still detects truncation.
3. Native character upload preview without `Add to prompt` commit remains unverified.
4. Unknown character quote stays blocked; exact configured free policy is accepted only for the verified account/model.
5. An unverified character job cannot be passed to `flow_generate_confirm`.
6. Missing current character name/ID is caught by schema validation before browser interaction.
7. An open Asset list overlay is closed by the owner-aware cleanup path before prompt entry.
8. Frames + Ingredients conflict is rejected at preflight, with no UI mutation.
9. Model selector is independently read after ratio/resolution/duration mutations; an `Omni 1.1 Flash` versus `Omni Flash` mismatch fails final readiness.
10. Requested 10s with actual 8s is reported as a capability mismatch, not silently normalized.
11. Initial bar failure followed by a successful fallback uses the final snapshot, not stale `barFailed` state.
12. `file input accepted: 0/1` cannot be overridden by `identity acknowledged: 1/1`.
13. Ambiguous download candidates survive tool-wrapper serialization and agent handoff.
14. A timeout while waiting for a render leaves a pending/unknown job state and never re-clicks Generate.
15. Final-frame extraction falls back from failed end-relative seeking to decoded frame selection and verifies the output image.
16. Static/source checks fail if the production skill or runtime agent path invokes `click-generate.js` or any direct external Generate-click helper.
17. The replacement screenshot flow uses `flow_screenshot`; render-completion polling does not rely on screenshot existence alone.

### 11.5 Completion rule for the question “were all red tool calls addressed?”

The implementation is complete only when every row in §11.1 has either:

- a code fix plus a regression test, or
- an explicit “intentional guardrail” classification plus a test proving it continues to block unsafe/unsupported requests.

The agent-generated scripts in §11.2 must also be removed from normal operation and their capabilities replaced by supported MCP/media utilities. A green test suite alone is insufficient unless the red-call ledger is reconciled against the session log after the final run.

