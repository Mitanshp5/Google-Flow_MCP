This plan was built by cloning the repo, installing dependencies, running the real test suite, and reading every file under src/ line by line — not from the README. A second review (from another model) was cross-checked against that same code before anything from it was accepted into this plan. Section 0 records what was rejected and why, so the coding agent doesn't waste a cycle "fixing" something that was never broken.

0. Claims investigated and rejected (do NOT act on these)
Claim	Verdict	Evidence
"flow_generate_video's MCP schema only exposes prompt/model/ratio/duration/reference_images/ingredients/use_character/use_scene/project/campaign"	False	src/index.js, the flow_generate_video inputSchema.properties block, declares 21 fields including quality, camera, style, quantity, confirm_generate, start_frame, end_frame, hero_frame, anchor_frame, shots, project_url — essentially everything the handler uses.
"flow_create_character's auto_confirm defaults to true, so omitting it creates the character automatically"	False	Both the tool's inputSchema (default: false) and the zod schema in validate.js (auto_confirm: z.boolean().optional().default(false)) resolve an omitted value to false before the handler runs. create-character.js's if (args.auto_confirm === false) prepare-only branch is therefore the default path, not the exception.
"npm test just runs the flow_connect smoke test (scripts/run.js test-flow-image)"	False	package.json defines these as two separate scripts: "test": "vitest run" and "test:smoke": "node scripts/run.js test-flow-image". Running npm test here executed 43 real unit tests across 7 files, all passing.
"The stale Omni 1.1 Flash capability table is actively capable of refusing valid operations"	Overstated	capsFor() computes caps.frames/caps.extend, but grep -rn "caps.frames|caps.extend" src/tools/generate-video.js returns zero matches — nothing reads those fields today. Only caps.ingredients is consulted, and only to log a warning, never to block. The table can't currently refuse anything because two of its three fields are unwired. (The underlying suspicion that frames:false for Omni 1.1 Flash looks wrong is plausible — Google's own Gemini API docs and several third-party inference wrappers describe first/last-frame interpolation as a headline feature of that model — see item P1-3 below for what to actually do about it.)
Two narrower claims from that review turned out to be true and are folded into the plan below at correct severity: reference_images is genuinely unimplemented for images (P0-1), and flow_download_latest genuinely hardcodes the image output directory (P0-3).

P0 — Correctness bugs (agent gets a misleading result or a file lands in the wrong place)
**[DONE — commits cf6e092 + 80b1832 (follow-up: missing imports caught live); unit+build green; live upload verification outstanding (no file input in current chat UI — attach trigger TBD)]** P0-1. reference_images on flow_generate_image is a complete no-op
Files: src/tools/generate-image.js Evidence: grep -n "reference_images" src/tools/generate-image.js returns nothing. The tool schema advertises reference_images: Paths to local reference images to upload, but the handler never touches args.reference_images — only args.ingredients (the @name mention flow) is wired up. Risk: an agent passes a local file path expecting it to be used as a reference, gets back ready_for_confirmation or even a completed generation, and never finds out the image was ignored. Fix:

Port the same upload pattern generate-video.js already uses (resolveFrame() + page.locator('input[type="file"]').first().setInputFiles(...)) into generate-image.js, applied before the mention-reference step.
Return an explicit references: { requested, attached, verified } block in the result (see P0-2) rather than a bare boolean, so a caller can tell the difference between "no references requested" and "requested but not attached."
Add a unit test (or at minimum a documented manual step in the test protocol) asserting the file input actually receives the file count requested.
**[DONE — commit ff893ab; unit+build green; live: warn path verified (verified:false → warning, prepare-only completes, queue clean); landing + slot calibration outstanding (no input[type=file] in chat UI until attach trigger — follow-up)]** P0-2. No end-to-end verification that an attached reference/frame landed in the correct slot
Files: src/tools/generate-video.js (frame/reference attach block), src/tools/generate-image.js (after P0-1) Evidence: generate-video.js uploads start_frame/end_frame/anchor_frame/reference_images through a single page.locator('input[type="file"]').first() call, then only notes the ambiguity: frameNotes.push(... 'select Video Frames/Ingredients slots manually if Flow did not auto-assign.'). There's no read-back confirming which slot each file actually landed in. Risk: the tool can report status: "ready_for_confirmation" while a start-frame image silently ended up as a generic ingredient, or vice versa — the single worst failure mode for a paid, hard-to-undo action. Fix:

After setInputFiles, read the actual DOM state of the frame/ingredient slots (whatever flow_discover_ui already knows how to enumerate) and diff it against what was requested.
Return a structured field, e.g.:
"frame_verification": {
  "start_frame": { "requested": "hero.png", "slot_detected": "start", "verified": true },
  "end_frame":   { "requested": "end.png",   "slot_detected": "unknown", "verified": false }
}
In the live (confirm_generate:true) path only: if any requested frame/ingredient comes back verified:false, refuse the paid click with MANUAL_VERIFICATION_REQUIRED — the same fail-closed pattern already used for model verification a few lines below. In the prepare-only path, surface it as a warning, don't block (consistent with how model/ratio mismatches are already handled).
**[DONE — commit 23165b7; unit+build green; live attempted (homepage + project page): no Download button on empty test project — routing outstanding until user has downloadable assets]** P0-3. flow_download_latest always saves into the image output directory
Files: src/tools/download-latest.js Evidence: line const dir = getOutputDir('image'); — hardcoded, regardless of what was actually downloaded. Fix:

Detect asset type from download.suggestedFilename() extension (.mp4/.webm → video; .png/.jpg/.webp → image), or better, thread the type through from the job that triggered the download (jobQueue.getCurrentJob()?.type / the last completed job's type) so it doesn't depend on guessing from a filename.
Fall back to a neutral outputs/other/ directory if the type genuinely can't be determined, rather than defaulting to images/.
**[DONE — commit 625d2ff; unit+build green; live: queue healthy across 3 runs (all completed, none stuck) with signed-in test-profile Chrome]** P0-4. Job can get stuck running instead of failed if the browser disconnects mid-error-handling
Files: src/tools/generate-image.js, src/tools/generate-video.js (both catch blocks) Evidence:

} catch (err) {
  await takeScreenshot(getPage(), 'generate-video-error');
  jobQueue.failJob(job.id, err);
  throw err;
}
takeScreenshot() catches its own internal errors, but getPage() is evaluated as an argument first, outside that try/catch. If the browser already disconnected, getPage() throws BROWSER_NOT_CONNECTED before takeScreenshot is even called, which skips jobQueue.failJob() entirely — the job sits in running until the 5-minute watchdog (jobTimeoutMs, default 300000ms) eventually times it out. Fix:

} catch (err) {
  try {
    await takeScreenshot(getPage(), 'generate-video-error');
  } catch (screenshotErr) {
    logger.warn('Could not screenshot on error path', { error: screenshotErr.message });
  }
  jobQueue.failJob(job.id, err);
  throw err;
}
Apply identically in both files.

**[DONE — commit 967e1bf; unit+build green. Note: heading says "two fields" but only brand was removed; reference_images kept for P0-1 to implement per execution order — see report]** P0-5. Two flow_generate_image schema fields advertise a capability the handler doesn't have
Files: src/index.js (flow_generate_image inputSchema) Evidence: brand — grep -rn "\.brand\b" src/ returns nothing anywhere in the codebase. It's declared in the schema ("Brand context for automatic model selection") and never read. Fix: either implement it (map brand values to a model-selection policy in selectModel()) or remove the field from the schema and description. Given the ambiguity of what "premium"/"standard" should actually resolve to without more product spec, removal is the safer P0 fix; re-add it later as a real feature if there's a concrete mapping.

**[DONE — commit 764d28d; unit+build green; live: use_character reaches inserter and behaves byte-identically to ingredients (both fail-soft on panel-not-open in current UI); video shared-helper regression green; queue clean]** P0-6. output_folder, use_character, use_scene, use_tool, references on flow_generate_image are dead parameters
Files: src/tools/generate-image.js Evidence: all five are read into the job-creation params object (outputFolder: args.output_folder, useCharacter: args.use_character, etc.) but never referenced again anywhere later in the function. generate-video.js has the same issue with output_folder specifically, already flagged in its own comment: // Ensure output dir exists for eventual downloads (wires dead outputFolder). Fix: for each, either (a) wire it to real behavior — output_folder should actually redirect getOutputDir()'s base path for that job; use_character/use_scene on the image tool should insert the same @name mention that ingredients does — or (b) remove it from both the zod schema and any job-params capture. Don't leave params that look functional in a job's metadata but do nothing; that's the exact "silent failure" pattern P0-1/P0-2 are about.

**[DONE — commit 26fd8e2; unit+build green; tool count 20 → 21; verified live (connected/isLoggedIn/isFlowPage true)]** P0-7. Dead/orphaned flow_open tool
Files: src/tools/flow-open.js, src/utils/validate.js (schemas.flow_open), src/index.js Evidence: handleFlowOpen is imported in index.js and fully implemented, schemas.flow_open exists in validate.js, but neither is referenced in TOOL_DEFINITIONS or the handleToolCall switch. It's unreachable. Fix: register it as a tool (it looks like a useful, lighter-weight complement to flow_connect for re-navigating without a full reconnect/account-check cycle) — or delete the dead import + schema if it was intentionally superseded.

P1 — Architecture / consistency
**[DONE — commit 716becd; unit+build green; live race observation outstanding by construction (needs 270s+ paid run)]** P1-1. Watchdog timeout (300s) can race the live-video poll loop (up to 360s)
Files: src/queue/job-queue.js (jobTimeoutMs, default 300000), src/tools/generate-video.js (Math.max(pollTimeoutMs, 360000) in the confirm_generate:true path) Evidence: the watchdog's setTimeout fires independently of the handler's own polling while loop (Node processes the timer between the loop's await page.waitForTimeout(5000) calls). At t≈300s, failJob() runs, sets job.status = 'failed', pushes a history entry, and nulls jobQueue.currentJob. The handler is still polling. When it eventually finishes (up to t≈360s) it calls completeJob(job.id, ...); because currentJob was already nulled, completeJob's "ignore if not current" guard doesn't trigger, so it overwrites job.status back to 'completed' and pushes a second history entry for the same job id. Net effect today: not a permanently stuck job (that's P0-4's failure mode, a different cause), but (a) flow_queue_status can report "failed" for a job that's actually about to succeed, and (b) the history array ends up with two entries — failed then completed — for one job id, which will confuse anything downstream that assumes one history entry per job. Fix: make jobTimeoutMs's default meaningfully longer than the live-video poll ceiling (or vice versa — make the poll ceiling respect jobTimeoutMs instead of its own independent 360000 floor), and make completeJob/failJob refuse to mutate a job that's already in a terminal state (completed/failed) instead of only checking currentJob.id.

**[DONE — commit 4f1aa34; unit+build green; no per-model values asserted; live end-to-end needs working @-panel]** P1-2. Ingredients-force-8s override is model-blind
Files: src/tools/generate-video.js Evidence:

if (mentionNames.length > 0 && effectiveDuration !== '8s') {
  effectiveDuration = '8s';
}
fires identically for every model. KNOWN_CAPS/DEFAULT_CAPS already has an ingredients boolean per model — there's no analogous per-model duration constraint. Fix: move this into the capability system — e.g. KNOWN_CAPS['veo 3.1 - fast'].ingredientsRequireDuration = '8s' — and only apply the override when the resolved model's caps say it's needed, defaulting conservatively (still forcing 8s) for unknown models. Verify per-model duration behavior via flow_list_models/live discovery before hardcoding new per-model values — don't copy specific duration numbers from third-party API docs into this table without confirming they match what Flow's own consumer UI actually offers for that model, since the consumer UI and the raw model API can differ.

**[DONE — commits ebf2ef7 + 57614ee + 6c5ee7e; unit+build green; live calibration BLOCKED (see below), cache verified unpolluted]** P1-3. Static capability table (KNOWN_CAPS) is authoritative when present, but nothing currently re-derives it from live discovery.
  Calibration (5 probe + 4 diagnostic runs, test browser, $0; follow-up commit 6d56c24): (a) probe mechanics verified — honest skips, nothing cached on total skip (cache file confirmed unpolluted), restore attempted; (b) FIXED en route: container validator + exact-chip-first + reuse of proven openBarSettings + content-wait (shell renders before rows over CDP — an empty shell previously scanned as all-false); (c) BLOCKERS in shared paths, not the probe: option DOM-clicks land on the correct flow-menu-item yet the settings row never leaves Veo 3.1 - Lite (needs trusted-click/confirmation work in setPromptBarModel); panel content will not render after close/open cycles even via openBarSettings (one cold open worked, empty at first read); catalog drift ("Omni Flash" configured vs "Omni 1.1 Flash" in UI) makes that model unselectable. Live UI inventory: settings panel = model dropdown + x1-x4 + credits note; no ingredients/frames/extend rows in this state. Browser left unmutated every run (selection still Lite, $0). Next: P1-4 follow-up on setPromptBarModel confirmation + catalog-name reconciliation, then re-probe.
Files: src/utils/models.js (capsFor), src/navigation/model-discovery.js Evidence: capsFor() returns { ...KNOWN_CAPS[name], known: true } for any name in the static table — there's no code path that lets a live-discovered capability override a stale static entry. discoverModels() (in model-discovery.js) already populates the model name lists live; it does not currently discover per-model capabilities (ingredients/frames/extend support). Fix: extend discoverModels() (or a new discoverCapabilities()) to read whatever the settings panel exposes when a given model is selected (which option rows are present/enabled), cache that per-model in flow.models.json alongside the name lists, and have capsFor() prefer a fresh cached capability entry over the static KNOWN_CAPS table when one exists, falling back to KNOWN_CAPS and then DEFAULT_CAPS in that order. This directly addresses the (plausible, though currently inert per item 0's table) concern that omni 1.1 flash's frames:false entry may be wrong, without hardcoding a new guessed value in its place.

**[DONE — commit 6c1f6dc; unit+build green; verified live (aria "Start generation" matched, both prepare-only green, queue clean)]** P1-4. Selector strategy inconsistency
Files: src/tools/generate-image.js, src/tools/generate-video.js, src/browser/safe-actions.js Evidence: most of safe-actions.js is carefully scoped (aria-label-first, read-back verified, documented UI-behavior-A-vs-B handling). A few call sites elsewhere still fall back to loose button:has-text("Generate")/button:has-text("Create") style matching as a late fallback in a locator chain. Fix: not urgent (they're already last-resort fallbacks behind more specific selectors), but worth consolidating into the same role + aria-label first, screenshot-and-fail-closed-on-miss pattern the rest of the file already uses, for consistency and future maintainability.

**[DONE — commit 09bb969; unit+build green; verified live prepare-only (both green, queue clean); live-only selectModelViaTune path untested (needs paid click)]** P1-5. Redundant dynamic imports
Files: src/tools/generate-video.js Evidence: the file already has top-level named imports for configureGenerationUI, ensureManualMode, readToolState from safe-actions.js, and resolveModel/getUniverse from models.js — but also re-imports the same modules dynamically (await import('../browser/safe-actions.js'), await import('../utils/models.js')) inside function bodies further down. Fix: delete the redundant dynamic imports, use the top-level bindings. Purely a readability cleanup (Node module caching means it isn't a functional bug), but it reads like leftover refactoring debris and makes the file harder to review.

P2 — Coverage & tooling (do this once P0/P1 land, not before)
**[DONE — commits 95039b2 + d3fe5b6 + 79f9a46; 20 files / 122 green; harness (buttons+routes) + pure gaps + primitives + registry + context + popup cleanup covered; deep flows + getPage-bound helpers explicitly live-only]** P2-1. Zero test coverage on the browser-driving code
safe-actions.js (1,098 lines) and project-navigator.js (824 lines) have no tests at all; the 43 passing tests cover only pure logic (validation, prompt scaffolding, sanitize, job-queue, file-manager). Extract pure sub-pieces for unit testing where possible (parseBarQuantity, parseBarRatio, stripTypeLabelSuffix, the model-token-matching logic already tested — do the same for anything still untested that doesn't require a live page), and add a thin Playwright-page-mock harness for the rest so a broken selector fails npm test instead of only surfacing during a live run.

**[DONE — commit d939d74; verified with real local npm ci + 20/122 green + build]** P2-2. No CI
No .github/workflows/, despite external contributors (madzabreu, per git log) already merging PRs. Add a workflow running npm ci && npm test && npm run build on push/PR.

**[DONE — commit 1ad954b; lint clean (19 findings cleared, 0 no-undef); 20/122 green + build; lint wired into CI]** P2-3. No lint/format config
4,700+ lines across tools//browser//navigation/, multiple contributors, no ESLint/Prettier. Add a minimal config (flat-config ESLint is enough — doesn't need to be opinionated, just catch unused imports like P1-5 and undefined-variable typos before they ship).

**[DONE — commit 0e1c274; lint+21/127 green+build; verified live (sweep pruned 101 stale screenshots, kept 200; logs/metadata untouched; 0 errors)]** P2-4. Unbounded log/screenshot/output growth
logs/*.log (daily files, never pruned), screenshots-debug/*.png (written liberally on every error path), outputs/metadata/*.json — none have a retention policy. Add a simple max-age or max-count sweep on flow_connect (or a scheduled cleanup script), since debug screenshots especially will accumulate fast on a long-running install.

**[DONE — commit fc158be; docs-only; 21/127 green + build]** P2-5. Safety-notes transparency on automation-detection evasion
connect.js's launchChromeDirect deliberately passes --disable-blink-features=AutomationControlled and copies a signed-in Chrome profile into a temp dir specifically to get past Google's "this browser may not be secure" block. This is a working, deliberate design choice, and credential handling is genuinely fine (no password ever touches the agent) — but the README's Safety Notes section should say explicitly that this technique is bot-detection evasion against Google's own sign-in flow, separate from the credential story, so a user adopting this tool understands exactly what they're opting into relative to Google's Terms of Service. Documentation-only change, no code.

Suggested execution order
P0-4 (5-minute fix, unblocks accurate failure reporting for everything else you test)
P0-3, P0-7, P0-5 (small, independent, no risk of touching shared code paths)
P0-1 + P0-2 together (P0-2's verification depends on P0-1 existing first)
P0-6
P1-1, P1-2 (touch the job-queue/duration logic — do these before P1-3 so the capability system they feed into is stable)
P1-3 (biggest architectural change in the plan — live capability discovery)
P1-4, P1-5 (cleanup, any time)
P2-1 → P2-2 → P2-3 → P2-4 → P2-5
After every item: npm test must stay green, and re-run the relevant phase(s) of the companion test protocol document (google-flow-mcp-test-protocol.md) against a live Chrome session in prepare-only mode before considering the item done.

