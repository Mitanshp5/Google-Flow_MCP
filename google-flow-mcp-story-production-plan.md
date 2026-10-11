# Google Flow MCP — Reliability and End-to-End Story Production Plan

Date: October 10, 2026 (Asia/Kolkata)  
Baseline: `master`, revision `6d56c2467df7922d4766c74a1d81626d65232cce`  
Status: **DESIGN / IMPLEMENTATION PLAN ONLY — nothing in this document is implemented or newly live-verified.**

## 1. Goal, evidence and decisions

### 1.1 The product we are building

A filmmaker should be able to give a story brief, establish recognizable characters and a coherent world, explore zero-credit images, select a consistent storyboard, generate only justified video takes, assemble the chosen clips, and receive a verified final film—not a set of browser screenshots or an optimistic success message.

The intended sequence is:

**Brief → story beats → continuity bible → canonical references → image candidates → compare/select → locked storyboard → animatic → budgeted video clips → temporal QA → edit/audio/subtitles → verified export.**

Design priorities, in order:

1. Never lie about preparation, generation, continuity, file availability or cost.
2. Preserve approved character/location/prop identity and intentional state transitions.
3. Spend time on zero-credit image exploration before spending video credits.
4. Do not lose work, double-submit unknown operations, silently change projects or rerender already accepted outputs.
5. Deliver actual usable media, with provenance and resumability.
6. Keep native Flow Characters, Scenes and Grid Architect as optional accelerators, not single points of failure for the story pipeline.

This plan cannot guarantee that a stochastic generator will always produce identical characters or never fail. It makes drift and uncertainty observable, blocks unsafe progression, and specifies recovery rather than pretending perfect consistency.

### 1.2 Evidence hierarchy

- **Primary local evidence:** `qa-output/2026-10-10/report.md`, `tool-matrix.json`, `manifest.json`, recorded MCP responses, UI snapshots and single-client download retests.
- Baseline: 21 registered tools, 81 recorded calls; 6 working / 7 partial / 8 failed tested paths. 127 unit tests pass; build/lint/current entry-file syntax gate pass.
- **Current source:** the actual `src/`, `scripts/`, `tests/`, `package.json` and example config at the revision above.
- **Historical context only:** `google-flow-mcp-implementation-plan.md`. Its DONE labels document previous patches; they do not close the newer live failures. Do not redo already-working quantity validation or CDP detach because an old/static review says otherwise.
- Official Google Flow, Playwright and FFmpeg references are listed in Sources. Runtime UI/account evidence remains necessary; documentation is not proof that this account can use a feature today.
- Two isolated OpenCode workers contributed remediation and story-pipeline designs. Parent reconciliation rejects unsupported assumptions about remote job APIs, exactly-once submission, unconditional retries, invalid FFmpeg examples and automatic perfect visual scoring.

The existing plan is preserved. This new file is the implementation roadmap for the latest QA and the expanded story product.

### 1.3 Zero-credit images: honor the premise without creating a spending bug

Use **zero-credit image generation as the default exploration strategy for this account**. The previous UI showed a zero-credit image quote, and the user explicitly wants image quality constrained primarily by generation/review time. Official documentation identifies Nano Banana 2 Lite as available at no charge; it does not establish that every image model, editing feature or account is perpetually free.[7]

Therefore the proposed policy is:

- `zero_credit_images`: only submit when the current selected image model, quantity, references and feature have a freshly verified total quote of zero and the story has an approved bounded image-generation policy.
- Zero price does not bypass account verification, feature/slot checks, rate/quota signals, safety checks, storage budgets or duplicate-submission protection.
- A nonzero or unreadable quote pauses the batch. It is not silently substituted with another model or converted into paid authorization.
- Compare multiple images freely within an agreed candidate/time budget; do not generate indefinitely merely because the credit cost is zero.
- Optional external visual-scoring/voice services may have separate costs. They are disabled unless explicitly configured and authorized; Flow image pricing does not make those services free.

Google states that costs can change and that credit costs are per generation, not necessarily per request; a request can produce multiple generations. Read the selected UI quote and its unit, and do not multiply a displayed batch total twice.[1][2]

### 1.4 8–10-second clips: capability-aware, not a global hardcode

Plan nominal shots around 8–10-second source clips, with shorter usable portions where the edit needs them. Google lists Veo Lite/Fast ingredient clips as 8 seconds and Omni Flash 1.1 as supporting 10-second clips and other durations. These are model-specific constraints, not a reason to force every ingredient request to 8 seconds forever.[7]

Important documentation conflicts to handle explicitly:

- The model-features page lists multiple Quality durations, while the credits table lists Quality 8-second generations.
- The credits page lists some Extend entries that the feature page does not list as supported for those models.

Do not “resolve” these differences by guessing. Treat the current account's feature selection and verified settings as the operational authority, record the documentation discrepancy, and leave unsupported/unknown combinations blocked.[1][7]

A 10-second request must either verify 10 seconds on an eligible model or require a deliberate storyboard/timing revision. Never return 10 seconds while producing 8, switch model automatically, or hold/repeat frames to conceal the difference.

### 1.5 MVP defaults — proposals, not service guarantees

- Creative reasoning and visual judgment belong to the MCP client/filmmaker. The server validates, executes and records the plan; it does not secretly call an additional LLM.
- Human/client visual review is required initially. An optional vision adapter can suggest scores later, but cannot waive a failed continuity gate.
- One browser UI transaction at a time on a bound profile/context; one consequential submission at a time initially. Local contact-sheet/probe/render work may run independently within resource limits.
- Explicit account and project binding; zero-credit image exploration enabled only by approved policy; video quantity defaults to 1.
- Local FFmpeg is the primary assembly path; native Scenebuilder is optional. Google documents sequencing, trimming, preview and scene download in Scenebuilder, but the current MCP scene implementation is not that verified assembly workflow.[11]
- Core completion does not require native Characters, Grid Architect, tool remix entitlement, camera-specific paid controls or any undocumented API.
- Output framing/fps/audio policy is chosen before storyboarding, not repaired silently at export.

## 2. Existing code versus proposed architecture

### 2.1 What exists today

| Existing area | Current files | Reuse or repair |
|---|---|---|
| MCP definitions/dispatch and validation | `src/index.js`, `src/utils/validate.js`, `src/utils/errors.js` | Repair contract drift; keep legacy tools registered |
| CDP connection, account and UI primitives | `src/browser/connect.js`, `launch-profile.js`, `account-check.js`, `safe-actions.js` | Preserve working detach; add explicit ownership, positive guards and verified UI adapters |
| Projects, references, model discovery | `src/navigation/project-navigator.js`, `mentions.js`, `model-discovery.js`, `character-rename.js` | Repair navigation, labels, state preservation, identity and feature discovery |
| Per-feature handlers | `src/tools/*.js` | Convert to thin orchestration over verified adapters; eliminate success after a no-op |
| In-memory single-flight jobs | `src/queue/job-queue.js` | Preserve terminal guards; add durable operations, cancellation/fencing and honest remote-state reporting |
| Config, files, logs, screenshots, selectors | `src/utils/config.js`, `file-manager.js`, `logger.js`, `screenshots.js`, `selectors.js`, `sanitize.js`, `models.js`, `prompt.js` | Version and isolate storage, protect production assets, fix catalog/selector semantics |
| Build, setup/smoke scripts, CI | `build.js`, `package.json`, `scripts/*`, `.github/workflows/ci.yml` | Honest negative smoke, outside-CWD and installed-tarball checks |

There is **no existing story manifest engine, candidate-ranking engine, durable story DAG, media assembly module or configured visual-scoring service**. FFmpeg and ffprobe were found on this machine, reporting `n9.0.1-11-ge47273f4d9-20260831`; the actual version-command results are retained in `qa-output/2026-10-10/planning/toolchain-preflight.json`. Their presence here is not a shipped npm dependency or a cross-platform guarantee.

### 2.2 Proposed module boundaries — all paths below are NEW proposals

Avoid a wholesale rewrite. Extract one tested vertical slice at a time and keep stable legacy exports as adapters during migration.

| Proposed module/path | Responsibility | Must not own |
|---|---|---|
| `src/browser/pages/` | Scoped Project, Sidebar, Composer, Settings, ModelPicker, AssetPicker, Character, Gallery/ToolFrame and Error/Auth surface adapters | Story creativity, spending policy or unchecked URL guesses |
| `src/browser/session-lease.js` | Bind the actual Flow tab/context; serialized UI ownership, abort/fencing and manual-interference checks | Claim remote render cancellation |
| `src/domain/contracts.js` | Canonical schemas for tool arguments/results, readiness, capability and asset identities | Duplicate handwritten definitions that drift from validation |
| `src/domain/submission-policy.js` | Account/feature/settings/cost checks and request-bound approval decisions | Clicking Generate without durable intent |
| `src/domain/operations.js` | Durable attempt state, request digests, correlation evidence and uncertain-outcome reconciliation | Assume local UUIDs exist in Google's backend |
| `src/storage/runtime-store.js` | Atomic versioned manifests/journal, lock metadata, migrations, hash checks and recovery | Sweep approved stories/assets as disposable debug data |
| `src/assets/catalog.js` | Stable local/remote asset mapping, safe import/download/reacquire, content metadata and provenance | Treat filename/first tile as identity |
| `src/story/` | Brief/bible/shot validation, dependency graph, stage scheduler, selection/approval locks and resume | Mandatory hidden inference service or speculative geometry |
| `src/media/` | ffprobe, decode validation, image contact sheets, frame strips, animatics, timeline compilation, normalization, audio/subtitles and export | Browser automation or silently spending Flow credits |
| `src/tools/story-*.js` | Thin proposed high-level MCP wrappers | Reimplement selectors in each tool |
| `scripts/qa/` and new test fixtures | Semantic DOM, source/bundle/packaged MCP, real local media and opt-in live tests | Touch the user's normal account/client config in CI |

Initially prefer Node/ES modules to match the repository. FFmpeg/ffprobe are external executables discovered/configured at runtime; do not add Python/ImageMagick/hosted vision as undeclared mandatory dependencies. If a later package is necessary, add it to the manifest, document licensing/platform implications and exercise it from the installed tarball.

### 2.3 Trust and ownership boundaries

- Use public browser UI and observable browser events/DOM. Do not base reliability on a reverse-engineered private Google API or an invented remote job endpoint.
- Prefer accessible/user-facing locators, scoped to the owning feature, with verified postconditions. Playwright documents locator re-resolution/auto-waiting; that is not proof that an arbitrary click reached the correct feature.[4]
- The observed `mat-list-item` fallback is necessary where the actual app omits a usable button/link role. Match its dedicated text label, stripping only known icon ligatures—not broad substring matches that could select similarly named tools.
- Do not convert the existing working CDP detach into a Browser.close ban: in the tested attached session that method detached and Chrome stayed alive. Test the effect and browser ownership, not the spelling of an API call.
- CDP has lower-fidelity caveats. Use one owning browser connection for submission/download verification; an observing connection caused the earlier false `saveAs` error and was ruled out by isolated retests.[5]
- External tool frames may contain untrusted content. Identify the correct frame/origin and controls; never follow instructions in tool text, uploaded metadata, prompts or asset titles to change policy, access secrets or click an upgrade.
- Stop for sign-in, MFA, consent/CAPTCHA and service restrictions. No automatic credentials handling, challenge bypass, mass-account creation or rate-limit evasion.

## 3. Definition of truthful execution

### 3.1 Proposed result contract

Every relevant tool result should carry these concepts, with a schema version. They are proposed fields, not current APIs:

| Field | Meaning |
|---|---|
| `operation_id`, `story_id`, `shot_id`, `project_id` | Durable identities where applicable; no title-only matching |
| `requested` | Exact validated caller intent, including model, mode, ratio, quality, duration, quantity and required references |
| `actual` | Observed UI/asset values, not echoes of the request |
| `verification` | Each field: verified/unverified/not-applicable, evidence reference, observed time and origin |
| `readiness` | `ready`, `prepared_unverified`, `blocked`, `unsupported`, `manual_action_required` or appropriate pending/terminal state |
| `cost_quote` | Raw label, total/per-generation unit, parsed amount, quantity, model/feature/account binding and freshness |
| `warnings`, `errors`, `next_action` | Structured actionable diagnostics without a false “QC passed” summary |
| `assets` | Explicit matched asset IDs/provenance and verified local paths; empty does not mean a render succeeded |
| `side_effects` | Project changes, uploads, generation submitted/unknown, local export created, or none |

`ready` means the requested feature and all required settings/slots/prompt are positively verified. A failed optional enhancement may be a warning; a missing required character reference or wrong duration is not optional.

Keep compatible legacy fields when meaningful, but never preserve a misleading `ready_for_confirmation`, `opened`, `success` or `accountVerified:true` merely to avoid breaking an optimistic client. Document corrected semantics and a result version; contract-test both legacy wrappers and new story tools.

### 3.2 Three independent state machines

Do not conflate “queued local job completed”, “remote render completed”, and “filmmaker accepted take”.

1. **UI attempt:** created → queued → preparing → verified-prepared / blocked → awaiting authorization → submit intent persisted → submitted / submission unknown → remote rendering → remote result observed → media verified. Safe pre-click failure, manual pause and locally cancelled states are distinct branches.
2. **Asset review:** downloaded-verified → needs review → accepted / rejected / superseded. Uncertain visual identity stays needs review.
3. **Story stage:** planned → runnable → running → paused / needs review / failed-safe → approved-complete. A completed stage cannot be inferred from the local queue's old `completed` entry alone.

Any early return, error screenshot failure, upload miss, modal failure or disconnected page must leave a durable, accurate operation state and release/fence UI ownership appropriately. An unknown submission is **not** a safe failure to auto-retry.

### 3.3 Request-bound approvals and zero-cost policies

Replace a proliferation of loosely related booleans with one internal submission policy; retain current image/video flags only as compatibility request inputs.

A proposed authorization binds:

- verified account key + project ID + story/shot revision;
- operation/attempt nonce and request digest;
- selected model and feature, exact prompt digest, duration, quality, ratio, quantity;
- required local asset hashes, remote IDs and slot assignment;
- quote unit/total, maximum authorized credits, capability evidence freshness and expiry;
- selected storyboard/bible revision and actor who approved it.

An edit, different model/version, changed quantity, stale quote, account/project switch, reference replacement or expired authorization invalidates it. Immediately before clicking, acquire the correct UI lease and reread account, prompt, slots, settings, quote and page identity. A digest of requested inputs alone does not prove the current UI matches.

Zero-cost image approval can be a bounded **story-stage policy**: approved bible/shot prompts, eligible exact models, max candidates, zero-only quote, deadline and review gates. It is not an unlimited authorization for arbitrary new prompts/features. Video authorization is per concrete take or a deliberately approved finite set of identical bound take specifications; rerenders consume their own authorized allowance.

Every submit attempt gets a unique nonce and a **single-use approval child**. For an approved finite set, enumerate the permitted children/counters and reserve their allowances; there is no reusable blanket token. Atomically commit child consumption, reservation and submit intent before the click. Concurrent requests cannot consume the same child. A proven pre-click recovery resumes the same journalled attempt; it does not mint a second child or click after an uncertain first click. Unknown outcomes require a fresh child and explicit duplication-risk authorization for any retry. Proposed tests: `approval-single-use`, `concurrent-approval-consumption`, `unknown-retry-new-approval`.

Proposed initial freshness policy (configurable, not a Google guarantee): cached capabilities are for planning; reverify the exact combination during preparation and after any relevant UI/account change. Quote evidence expires after 30 seconds; account/project/settings/reference read-back must finish within five seconds before submit, with no intervening edit/navigation. Repeat verification if those deadlines expire. Observe composer/panel/tab changes and check the current lease epoch before each consequential event. These checks reduce, but cannot make atomic, a human edit or a service-side price change between read-back and click; detectable changes invalidate preparation, and post-submit mismatches become incidents/uncertain accounting rather than retroactively verified success. Do not promise a browser-only hard cap on unobservable service-side charges.

Maintain a credit reservation ledger before submission. Reserve the verified upper bound including quantity. Unknown outcomes keep their reservation until reconciled; do not book an automatic refund or zero spend. Account balance changes alone are not attribution proof because credits can be consumed from other devices/operations.[1]

Track expected versus landed variants separately from spend settlement. A landed, missing, duplicate-by-content or rejected variant does not establish its charge/refund. For a q4 attempt, keep the original upper bound until attributable charge/refund evidence permits settlement; do not release three quarters because only one file is visible. Preserve separate remote variant/attempt records even when their bytes deduplicate to one local file. Do not double-book both an attempt-level batch charge and per-variant charges. When only total-batch attribution is available, settle the attempt total and leave the variant allocation unknown. Proposed regression: `partial-variant-ledger`.

### 3.4 Idempotency without an impossible exactly-once guarantee

A local idempotency key prevents this server from knowingly submitting the same authorized operation twice. It does **not** make a browser click and a remote render one transaction.

Protocol:

1. Persist intent, approval digest, baseline visible asset identities and lease epoch before the first consequential UI event.
2. Reverify and attempt the click once. Persist observable acknowledgement immediately when available.
3. If interrupted before the submit invocation and the code can prove no submit action was invoked, a pre-click retry may be safe.
4. If interrupted during/after invocation or if the acknowledgement is missing, set `submission_unknown`; pause and reconcile rather than clicking again.
5. Reattach to the exact account/project; inspect visible pending/new assets, progress, result type, prompt/settings metadata where actually exposed and time/order evidence.
6. Automatic linkage requires a stable observable remote asset identity, a pre-submit baseline proving newness in the bound account/project, the expected media type and positive attempt-to-result evidence actually exposed by the UI. Time/order or one plausible thumbnail alone is not positive attribution. A new asset ID is not itself a remote request ID. Multiple plausible results, missing IDs/baselines, hidden/late results or unavailable attribution remain uncertain and require a user choice. A user may explicitly adopt a reviewed asset into the story, but the original attempt/spend uncertainty remains recorded; manual adoption is not automatic generation verification. Proposed tests: `no-id-no-link`, `new-id-without-attribution-unknown`.
7. No new asset yet, no balance delta, an old screenshot or an elapsed timeout is **not proof that nothing was submitted**.
8. Never invent or query `parentJob == localOperationId`, a Google `clientOperationId` endpoint, or remote deduplication support. If no remote request ID is exposed, say so.
9. A user choosing to retry an unresolved attempt must acknowledge possible duplication and provide fresh bounded authorization. Keep both attempts in the ledger.

## 4. Continuity-first story design

### 4.1 Brief and beats

Before generating, record:

- logline, beginning/change/resolution, audience, tone, language and target duration;
- final aspect ratio, fps, output profiles, intended viewing platform and whether framing variants are needed;
- cast, locations, recurring props, dialogue/narration/music/SFX intent;
- content constraints, reference rights/consent, required shots and prohibited additions;
- image time/candidate budget, video credit cap, maximum takes, review authority and delivery location.

Compile ordered **beats** into **shots**. A beat is narrative purpose; it may need multiple shots. A scene groups shots in a location/time continuity context. A generated clip is a take for a shot—not a whole scene or the film.

Each shot specifies one tractable action, screen direction, camera/view, expected start/end world state, required entities, storyboard reference IDs, source duration request, usable edit duration and dialogue/audio needs. Avoid squeezing multiple complex actions into one 8-second prompt merely to reduce clip count.

Use rational frame/tick times for the edit. Story target duration is the sum of trimmed usable clips minus overlaps plus explicit holds/slates, not the sum of generation settings.

The current legacy `shots[]` parameter is limited to six metadata entries. That is not a six-shot limit on the proposed film: the new story scheduler validates its own bounded shot graph and executes one concrete clip request per shot. Compile prompts against actual input-length/reference-count limits; reject an overlong or impossible specification instead of silently truncating identity/state constraints.

### 4.2 Canonical bible: characters, environments and objects

**Character record**:

- immutable semantic ID, display name, fictional/reference origin and consent where relevant;
- face/head silhouette, hair, eye/skin details that matter, body proportions, distinguishing marks;
- outfit variants, accessories, handedness, character-specific exclusions;
- approved front/three-quarter/profile/full-body references where useful;
- voice/language descriptor and a reusable approved voice asset only if an authorized source exists;
- intentional state changes: wet clothing, dirt/injury, disguise, carried props, emotional state and which shots require them.

**Location record**:

- stable semantic ID, authored layout/topology and recurring background anchors;
- door/window/table relationships, material palette, time-of-day/weather/light sources;
- approved wide and reverse-angle reference images and shot-specific camera side;
- explicit allowed changes such as sunset/time jump or a moved chair.

**Prop record**:

- identity, color/material/dimensions/silhouette, markings, approved views and attachment details;
- owner/holder and placement; state such as closed/open/broken/repaired/on/off;
- rules preventing a prop from vanishing, multiplying or changing hands without a story event.

Keep **world relationships** separate from **screen coordinates**. A cup can appear on screen-right after a reverse angle without moving in the world. Do not enforce a fixed pixel position across different views, or claim accurate 3-D reconstruction from a single generated frame.

### 4.3 Canonical references and reference packs

Generate or import a compact canonical library first. Select and freeze it before shot-level exploration. Reuse those same accepted identities in every shot, in addition to any adjacent-frame continuity anchor.

- A character sheet/contact sheet is a review aid; it is not automatically a suitable single video ingredient. Export clean single-view anchors where needed.
- Separate clean character/object references from composited shot frames. A background/style reference should not accidentally introduce unwanted people or a second copy of the hero prop.
- For models with limited ingredient slots, compile a **shot-specific reference pack**: choose the necessary canonical cast/location/prop subset or produce an approved composited hero frame that already contains them.
- Do not silently omit the fourth required reference to fit a three-slot limit. Options are a newly reviewed composite frame, a different verified model, or splitting the shot; all require a declared change.
- A start frame, end frame, generic ingredient and “anchor” have different roles. Uploaded file acceptance is not slot verification; the same image must not be reused in a wrong slot merely because its name is visible.
- Negative or exclusion constraints are stored separately from positive identity descriptions; the compiler must not accidentally mention a prohibited prop as a subject to render.

Google documents ingredients for consistent character/object references and distinct frame-based generation. The implementation must exercise the actual picker and slot UI, not infer these roles from upload order.[12]

### 4.4 State transitions and shot dependency graph

For each shot, store `expected_state_before` and `expected_state_after`: cast location, costume variant, prop ownership/state, world placement, light/time, gaze/screen direction and action completion.

A successor shot consumes an explicitly approved predecessor state. Track intentional discontinuities (time jumps, cutaways, wardrobe changes) as authored transitions, not visual drift exceptions.

Dependencies include:

- bible revision → relevant reference assets → shot candidates;
- selected panel/start/end/reference pack → each video take;
- accepted clip end frame → successor clip when an actual continuous handoff is required;
- accepted clip selection + edit decisions → normalization/audio/subtitles/final exports.

Changing one prop may invalidate only affected shots and their continuity successors, not the entire unrelated film. Keep old assets/takes recoverable but mark dependent outputs stale. Changing a selected end state must invalidate previously generated downstream continuity-dependent clips even if their prompt text has not changed.

Use canonical references to reset identity regularly; chaining only the last generated frame compounds drift. If a previous clip's ending is wrong, do not promote that error into the next clip's “truth”. Repair/reselect the predecessor or redesign the handoff.

## 5. Image exploration, comparison and selection

### 5.1 Bounded zero-credit candidate generation

For each canonical entity and storyboard shot:

1. Validate account/project, the approved stage policy, exact live model and zero quote.
2. Attach the frozen required references and verify identity/roles.
3. Prepare an explicit prompt, model, ratio and quantity. Do not depend on the currently mismatched defaults.
4. Submit via the common safe operation protocol; correlate only newly generated image assets.
5. Download the actual full-resolution images, not a screenshot/thumbnail, then decode and record dimensions, orientation, format, source IDs and local hashes.
6. Keep every candidate immutable. Give it a unique candidate ID and a source operation/variant index; identical bytes are a content duplicate, not an extra successful creative variation.
7. Produce labelled contact sheets and preserve full-size links for review.
8. Generate a targeted revision batch only for a specific diagnosed problem; retain the prior candidates and comparison record.

Proposed starting policy: four candidates per decision unit if the live account/model supports that quantity at zero cost, one initial batch, up to two deliberately requested improvement rounds. Measure latency; adjust the policy with the filmmaker instead of hardcoding unlimited free generation.

A reference/candidate asset can be reused across compatible shots. Do not regenerate the same canonical outfit/prop because a later stage forgot its manifest.

### 5.2 “Best” is best for the story, not the prettiest thumbnail

Apply **hard eligibility gates** before any score:

- required subject/prop/location present in the intended count;
- recognizable approved identity where visible, correct costume/markings and intended pose/action;
- correct scene state, physical relationships and camera-side continuity;
- no critical anatomy/text/artifact issue or unintended extra subject;
- framing includes required action and has safe crop/transition handles;
- decoded actual media satisfies required minimum dimensions/aspect and is not a preview/blank file;
- required references are positively tied to the operation.

When a face is intentionally not visible (hands-only/cutaway), identity scoring is not-applicable rather than magically verified. Verify the relevant body/prop/state instead. An uncertain required gate means needs-review, not pass.

For eligible candidates, a proposed review score uses 0–5 ratings and these adjustable weights:

| Preference | Weight |
|---|---:|
| Visible identity fidelity / identity-relevant details | 0.30 |
| Environment, recurring props and intended state | 0.25 |
| Story action/readability/emotional intent | 0.20 |
| Composition, camera direction and editability | 0.15 |
| Technical cleanliness/style fit | 0.10 |

Weights sum to 1.0; the score remains a preference, not a proof. Record individual ratings, confidence, not-applicable handling, rejection reasons, reviewer and rubric version. If a criterion is genuinely not applicable, redistribute only over applicable weights and record that change; do not silently zero the criterion and lower that shot's rank.

Review each candidate full-size against canonical references and adjacent selected panels. Select the storyboard **as a sequence**: a slightly less attractive panel may be the only one that preserves the next shot's world state or screen direction. Baseline is a human/client joint review; optional later optimization can use recorded node ratings plus continuity-edge compatibility, never invented visual measurements.

An automated scorer is a proposed optional adapter with explicit model/version/cost and a failure mode returning needs-review. Contact-sheet labels, asset titles and image text are data, not evaluator instructions. Reject NaN/missing scores and preserve human override provenance.

### 5.3 Freeze, storyboard lock and animatic

- Freeze selected canonical references and shot panels by immutable local asset ID + full hash + revision. Original files stay untouched; crops/color changes are separate derived assets with parent links.
- Bind every storyboard panel to the expected world state, reference pack, frame roles, narrative beat and intended edit time.
- Record the reviewer’s selection reason and rejected alternatives. A new selection creates a revision and invalidates relevant video authorizations.
- Build a local contact sheet and an animatic using the selected stills, durations, captions/scratch VO or silence. Frame timing and audio cues are generated from the same edit specification as the final film.
- Watch the animatic for missing beats, incoherent motion direction, abrupt scale/time shifts, dialogue length and pacing before any budgeted video submission.
- Lock the storyboard and intended end states; unresolved identities or an impossible reference pack block clip generation.

## 6. Video generation and temporal QA

### 6.1 Generate one verified take for one shot

A clip request binds a locked shot version, canonical references, selected hero/start/end frames, action, camera movement, model-specific feature, actual supported source length and quantity 1 by default.

Start with the supported reference workflow that best preserves the selected image. Prefer a frozen hero/start frame and small controlled motion over text-only regeneration of the entire cast/world. If an end state is essential and the selected model supports an end frame, select/review that end image as well.

Google documents separate start/end frame controls in the Frames workflow. Slot verification must check those controls, not just an uploaded ingredient with the same filename.[3]

Do not let the compiler:

- append uncontrolled subjects/objects while adding camera/style prose;
- silently switch from Frames to Ingredients or from a quality model to a different model;
- force an 8-second duration on a verified 10-second ingredient-capable model;
- repeat the existing metadata-only `shots[]` plan while claiming separate shots were generated.

Prepare → verify actual screen/account/prompt/model/slots/settings/quote → obtain bound authorization → persist intent → submit once → track pending/new remote assets → download/validate → review.

Native dialogue/speaker controls are optional, model/account-specific capabilities. Do not pretend that a voice descriptor guarantees the same voice between clips. The reliable baseline is authorized recorded/provided narration or a separately configured consistent voice adapter, with dialogue visuals planned accordingly.

### 6.2 Preview/final strategy and budget discipline

- Images are the primary low-credit-risk exploration tool. Do not generate multiple video variants merely to choose lighting that could have been settled in the storyboard.
- Optionally produce a lower-cost verified preview for a difficult motion shot. That preview is still a separately authorized operation, not “free because images are free”.
- Acceptable previews can be final takes if they meet the delivery brief. Regeneration at another model/resolution is a new stochastic take; it may change identity, background and action, so rerun temporal QA.
- Upscaling is a separate operation/policy with a current quote and entitlement, not an automatic consequence of export. Local resizing does not create genuine source detail; document source and delivery resolutions separately.
- Propose a finite retake allowance per story and per shot. Require a diagnosed rejection reason before using it. Store rejected/uncertain takes; do not overwrite them.
- If quota/cost/model availability changes, pause and ask for an explicit plan/budget change rather than downgrade or stretch content silently.

### 6.3 Temporal QA and continuity handoff

For every downloaded take:

1. Probe and fully decode to detect missing/truncated video, duration/codec errors and bad timestamps.
2. Extract first/last usable frames and a sample strip (for example one per second), plus denser samples around visible speech, fast motion and joins. Derive sample indices from verified decoded/probed frame counts and timestamps; duration × fps alone is not a reliable frame count for variable-frame-rate media. Exercise first/last-frame selection against real local fixtures before using it for handoffs.
3. Compare start/end and interior frames with canonical characters, props, selected panels and expected before/after state.
4. Watch the entire take with audio. Sparse sampling can miss a morph, flash, extra hand, broken lip-sync or prop teleport; it is evidence assistance, not a guarantee.
5. Hard-reject missing required subject/object, unacceptable drift, unplanned state change, unusable dialogue, missing essential action or corrupt media.
6. Rank the remaining takes by story readability, temporal stability, motion/camera quality, join compatibility and technical delivery requirements.
7. Select one accepted take by immutable ID/hash; preserve ratings and rejection reasons.
8. For continuous handoff, save a verified actual ending frame as a derived local asset and, when needed, an explicitly correlated Flow asset. Compare it to the next shot's planned start. Do not use a low-resolution screenshot as a canonical end frame.
9. An intentional cut/reverse angle need not match pixels; it must preserve approved state and screen/world logic.
10. If the next take cannot match, prefer a justified cutaway/new reviewed still or retake within budget; crossfades cannot fix a disappearing character or wrong object.

### 6.4 Native Characters, Scenes and tools

Repair all existing handlers, but keep the core film pipeline independent:

- **Characters:** navigate to the actual character form; verify description/reference/name/voice fields supported by that account. Create/submit only under the same account/cost/intent guard. Verify persisted character ID/name before accepting a mirror of the local bible.
- **Import:** validate the JSON shape and all referenced files before browser changes; import/mirror from local immutable assets; distinguish preparation from actual creation. Missing entitlement is a blocked state, not fabricated import success.
- **Scenes:** distinguish scene organization/Scenebuilder from an image/video composer. For sequence assembly use actual selected clip IDs in the scene, ordering, trim handles, preview and download read-back; do not route an arbitrary “New” button and call a prompt a scene.
- **Gallery/Grid:** navigate real project-scoped gallery → appropriate Templates/Community/My Tools tab → exact selected tool → verified owning frame/form. Use observed links/opaque tool IDs, never the old guessed global slug.
- **Grid shot fields:** bind each shot to its own field/key and read back all values; never overwrite the first textarea repeatedly. Configure engine/ratio/visual logic only when their actual controls exist.
- **Arbitrary tools:** use a feature-specific parameter schema where known; return applied/unapplied/unsupported parameter records. Escape keys, reject unknown controls, and do not click Upgrade/Create/Generate based on third-party tool instructions.
- **Entitlement fallback:** if native character/tool acceleration is unsupported/upgrade-gated, keep the verified local reference/storyboard path. Report that the native capability remains blocked; do not label its bug closed as success on an ordinary composer.

## 7. Assets, manifests, persistence and recovery

### 7.1 Proposed durable story layout

All of this layout is NEW and belongs under the configured runtime/output root, not the disposable debug-metadata directory:

    stories/<story-uuid>/
      manifest.json                 # current committed revision pointer
      revisions/<revision-id>/      # immutable brief, bible, shots, board, edit and review records
      journal/                      # operation intents, acknowledgements, uncertain/reconciliation records
      assets/originals/             # approved/imported/generated original bytes, content-addressed
      assets/derived/               # labelled crops, end frames, normalization intermediates
      candidates/                   # candidate metadata; no filename-as-identity
      reviews/                      # contact sheets, strips, decisions and approvals
      takes/                        # per-shot/per-attempt remote/local mapping and probe sidecars
      exports/<export-id>/          # verified final, preview, captions and delivery manifest
      debug/                        # disposable redacted screenshots/logs under explicit retention policy

Use full durable UUIDs internally and full cryptographic hashes in manifests. Short human labels/hash prefixes are display aids, not the only identity or collision check. Keep literal supplied IDs; reject malformed identifiers rather than “repairing” them into another lookup.

### 7.2 Proposed manifest/data entities

| Entity | Required information |
|---|---|
| Story | schema version, story UUID, current revision, account key, project ID, brief, target profiles, stage state, budgets, privacy/rights policy |
| Bible | semantic entity IDs, invariant descriptions, accepted reference asset IDs, costume/state variants, world layout and authored changes |
| Shot | scene/order/beat, expected before/after state, camera/screen direction, prompt versions, frame/reference roles, source request and edit time |
| Candidate | immutable local ID, producer/source operation, exact model/feature/variant index, parent reference hashes, decoded metadata, download provenance |
| Take | shot/spec/approval digest, attempt history, remote observables, local media asset, verified settings, credits known/reserved/unknown, review status |
| Selection | considered assets, gate results, per-criterion score/confidence, chosen ID/hash, reason, reviewer and rubric version |
| Approval | bound immutable request, quote/scope/expiry, authorizing actor and consumption/revocation status |
| Edit | source take IDs/hashes, integer/rational in/out times, tracks, transitions/handles, crop/color/audio/subtitle instructions |
| Export | exact edit/dependency digest, output profiles, tool versions/commands, actual decoded results, hashes, review/release decision |

Do not store fake seeds, remote job IDs, measured scores or asset timestamps that the UI does not expose. Nullable/unknown fields must remain explicit.

### 7.3 Asset identity and download correctness

- Prefer observable stable remote asset identifiers such as the `data-media-id` seen in QA, scoped to the exact project and source attempt. A signed image URL is a locator with expiry, not a durable identity.
- Add a proposed explicit `flow_download_asset` path. Repair `flow_download_latest` as a wrapper selecting the latest eligible **verified generation result**, not the first visible download button, an upload or an unrelated old tile.
- Reacquire expired downloads through the owning asset UI. Hover/select → More → Download → verify desired format/resolution. This matches Google's documented asset-menu flow.[8]
- Listen before clicking, save to a controlled temporary path, validate completion/bytes/MIME/decode and expected asset identity, then atomically promote.
- If stable ordering/identity cannot be established, return ambiguity with choices. Never treat the current first control as a successful “latest” fallback.
- An upload may be transcoded: QA's PNG downloaded as JPEG. Store the local import hash and the downloaded export hash separately. Do not demand equality of upload/download bytes, use filename extension as truth, or rename JPEG bytes to PNG without a real conversion.
- Content hashes prove byte identity locally, not that the pictured character/asset is the correct one. Remote mapping and visual/content verification remain necessary.
- Keep original media and metadata after acceptance. Browser cache and expiring remote URLs alone are insufficient recovery storage.

### 7.4 Atomic writes, migrations and invalidation

- Schema-validate before commit. Use controlled same-volume temporary files, durable intent/journal, atomic rename and expected-revision compare-and-swap under the story lease.
- A multi-file update is not automatically atomic. Commit immutable child files first; update the root pointer last. On restart, recover/discard only incomplete uncommitted artifacts by journal evidence.
- Reject unsupported future schema versions; back up malformed legacy JSON before migration. Never overwrite corrupt project/selector/story files with empty success-state defaults.
- Preserve project/campaign identities; use explicit conflict resolution if title matches multiple projects or an MRU guess differs from the requested story binding.
- A title rename failure records pending/failed naming while preserving the actual project ID. Do not create a second project to fix a naming problem.
- Approved assets, authorizations, journals, manifests and releases are not disposable `outputs/metadata`. Update retention rules so connect-time cleanup cannot erase the evidence necessary to resume a story.
- Store checksummed dependencies; changes mark affected nodes stale/review-required. Do not erase old versions or automatically pay to recreate them.
- Local review-only changes need not invalidate media unless they change selection/constraints. A subtitle-only edit should re-export captions/final, not regenerate characters or clips.

Proposed invalidation matrix; downstream propagation follows explicit dependency edges, not every asset in the directory:

| Changed dependency | Mark stale/review-required | Preserve/reuse |
|---|---|---|
| Character/prop/location identity or required bible state | Affected references/packs, panels, takes, dependent continuity successors, edit and exports; revoke corresponding approvals | Unrelated scenes/entities and all original bytes/history |
| Canonical reference, shot pack or selected panel/frame | That shot's preparation/approvals/takes and downstream dependent handoffs/edit/export | Independent accepted shots and unchanged bible records |
| Accepted take or actual end state | Dependent successor takes even with identical prompts, join review, edit/audio cue placement/exports | Unrelated take selections; prior rejected/accepted revisions |
| Shot order, action or source-duration specification | State adjacency/handoffs/animatic, affected shot takes where requirements change, edit and all timing-linked tracks/exports | Takes still compatible after explicit review; never infer compatibility from filename |
| Delivery fps/codec/color profile | Timeline compilation, normalized derivatives, output verification and exports | Accepted original takes unless the changed requirements make their motion/detail unusable |
| Delivery aspect/framing profile | Re-review crops/visible required entities, animatic/edit/exports; invalidate generation only where existing sources cannot meet the new framing | Original refs/takes; no automatic paid rerender |
| Subtitle text/timing or music/mix policy only | Related track/cue validation, mix/burn-in and exports | Character refs, panels and video takes |
| Review notes or display names only | Review metadata/release record where relevant | Media and approvals unless names alter actual prompt/reference identity |

Compare expected revision/digests at every stage commit and release. Proposed tests: `selective-invalidation`, `end-state-propagates`, `profile-change-local-only`, `stale-take-blocked`.

### 7.5 Resume/cancel semantics

On startup/resume: verify account/project, load and validate committed state, inspect pending intents, verify local file hashes, and list the exact missing/stale/uncertain units.

- Reuse valid accepted references/candidates/takes; download a recoverable missing file by its explicit remote identity before regenerating it.
- Regenerate only safe missing/rejected units authorized by current policy. An unknown remote attempt first enters reconciliation.
- Restore an interrupted local encode from valid step outputs or rerun only that local derivation; no Flow generation is needed because an export failed.
- Cancel sets an abort request and fences the UI actor; it does not assert remote render cancellation/refund.
- Check abort and lease epoch before every meaningful UI side effect and at bounded polling checkpoints. Stale workers must not later click or publish terminal success.
- A lease TTL/old PID alone is not proof that the old actor stopped. Confirm actor shutdown/release or fence it before another actor controls the same browser.
- Keep a remote-unknown operation visible after local reset. Default to pausing the affected story/profile; do not clear its history and permit duplicate submissions.
- Independent local media/review tasks may continue without controlling the uncertain browser session. Multi-tab/parallel remote generation is a later opt-in capability with tests, not an MVP optimization.

Before any inspection/picker/discovery transaction that might mutate the composer, snapshot text plus structured mention-chip asset identities/order, slot assignments, attachments/pending uploads, model/mode/settings and account/project binding. Use supported UI events/adapters to restore; never rebuild chips by setting text or trusting stale DOM node references. If restoration or pending-upload identity cannot be verified, invalidate preparation/approval and return the missing state; do not claim an unchanged composer. Tests must compare chips/slots/settings as well as the prompt string.

For UI takeover, request abort, fence the old epoch, obtain an actor stop/release acknowledgement, and verify no old browser-owning process can still issue commands. If a stalled actor cannot be safely stopped, block takeover and request manual closure/detach of that dedicated connection/session; never trust TTL expiry alone or kill a user's unrelated browser. Proposed tests: `lease-takeover-fenced`, `quote-stale-blocks`, `manual-edit-invalidates`.

Proposed starting operational limits: one UI owner, one local encoder, bounded queued stage units, user-configured candidate/time/disk limits recorded at story creation. Use a 30-minute remote-observation watchdog as an initial configurable pause threshold, not a render failure/cancellation or permission to resubmit; resume reconciles the same attempt. Every image batch checks deadline/quota/free space before the next intent. If the deadline arrives while a render is pending, checkpoint and report pending/unknown honestly. Missing agreed caps block unattended exploration; no infinite zero-cost loop. `flow_story_status` must expose completed/remaining decision units, missing/stale/uncertain assets, known/reserved credits, active owner and exact pause/recovery reason. Measure p50/p95 stage latencies before tuning these defaults.

## 8. Local editing, assembly and final delivery

### 8.1 Primary assembly choice

Use **local FFmpeg assembly as the primary reliable output path**. Repair native Scenebuilder for optional organization/preview/export, but do not make a paid tool or an unverified native Scene form the only way to finish a film.

ffprobe exposes machine-readable media/container/stream information; use actual probe results, not requested generation metadata, when validating files.[10]

The primary edit specification names accepted immutable takes and defines exact trims, overlaps, crop/framing, track choices and output profiles. Avoid hidden editor defaults.

### 8.2 Normalize before joining

For each chosen source:

1. Probe codecs, dimensions, duration, fps/timebase, orientation/SAR, color range/transfer/primaries, audio presence/layout/sample rate and corruption.
2. Verify selected in/out range exists in decoded media and leaves required transition handles.
3. Apply the selected crop/letterbox/pillarbox policy; do not stretch portrait material into landscape or crop a required face/prop without approval.
4. Normalize rotation/SAR, even dimensions where the codec requires them, CFR/timebase, pixel format and a declared color pipeline. Reset clip start timestamps and normalize corresponding audio.
5. Unknown/missing color metadata must not be “fixed” just by relabelling it. Decide a reviewed interpretation or block a color-critical deliverable. HDR→SDR requires a deliberate supported conversion, not a tag change.
6. Preserve original sources and save derived normalized media plus its exact command/probe record.

FFmpeg's concat demuxer requires compatible streams/codecs/timebases. Its video crossfade filter requires matching CFR, resolution, pixel format, frame rate and timebase. Therefore raw mixed generated clips are not eligible for blind stream-copy concatenation.[6][9]

Prefer a deterministic normalized concat/filter pipeline for MVP. A stream-copy fast path is a later tested optimization for truly compatible inputs. `xstack` creates a spatial composite; it is not sequential story concatenation.

### 8.3 Timeline compiler

- Represent edit times as integer frames at a declared rational fps, or a rational timebase where needed. Validate ranges/order/overlaps; do not accumulate floating-point join error.
- Hard cuts are default. Crossfades are only an authored transition and consume overlap from the runtime; ensure both clips have adequate handles.
- Compile video and audio from the same timeline. A video crossfade needs compatible audio handling; do not shorten video while concatenating audio at full source lengths.
- Retime subtitle/dialogue/music cues from that same compiled timeline and revalidate all cue ranges after overlaps. Validate sufficient handles on both sides of every transition before encoding. Proposed tests: `crossfade-overlap-math`, `cue-retime`, `insufficient-handles-blocked`.
- Do not truncate spoken lines, essential action or last-frame closure to force an exact target without a reviewed edit decision.
- The final runtime includes titles/credits/slates/holds if selected. Report predicted and measured durations; a broad per-join tolerance must not conceal seconds of drift.
- For the proposed 24-fps example, visual duration tolerance is one frame after decoding; compare audio timing with a separately declared codec/sample-based allowance, not a universal magic value.
- Unknown/unsupported edit operations fail at compile/preflight, before overwriting any export.

### 8.4 Audio, dialogue and subtitles

Proposed baseline:

- Prefer consistent authorized narration/recorded dialogue and a continuous ambience/music bed. Generated clip audio can be selected or muted explicitly; do not double-layer it by default.
- Lock speaker/voice asset identities and language per character. If lip-visible dialogue is required, include full take review and speaker/lip timing gates before acceptance.
- Normalize sample rate/layout, preserve intentional silence, align trims, pad/trim only by a declared policy, fade joins, and duck music around speech.
- Choose and record editorial loudness/true-peak targets. Use an actual measured/validated mix, not “loudnorm ran, therefore the mix is good”. Account for silent audio and invalid/infinite loudness measurements. Two-pass loudness normalization is a supported FFmpeg option, not a universal platform target prescription.[6]
- Validate caption text, UTF-8, ordered/nonnegative/in-range timing, overlap policy, readability and actual language. Keep sidecar SRT/VTT and optional burned-in output separately specified.
- Native generated speech/transcription may not match intended lines. Use supplied/verified transcription or an explicitly configured ASR adapter; do not fabricate a subtitle transcript from the prompt.
- Verify fonts/glyphs for burn-in. Missing fonts or unsupported characters block that profile or fall back to an approved sidecar-only delivery, not silently missing captions.
- Source music/voice permissions are explicit. No unapproved voice cloning, hidden TTS/API spend or copyrighted track scraping is part of MVP.

### 8.5 Safe process execution and resource handling

- Discover/configure FFmpeg/ffprobe, record actual version and required filters/encoders. Test required features; do not demand exactly 9.0.1 on every user's machine just because that is installed here.
- Spawn with argv and `shell:false`; separate and validate paths, numeric options and filtergraph construction. Never interpolate story titles, subtitle text or tool parameters into a shell command.
- Escape FFmpeg filter/concat-file syntax separately from OS shell syntax. Controlled short working filenames help, but do not bypass validation. No invented working command should be copied from the unreviewed worker notes.
- Resolve symlinks/junctions, assess containment and enforce authorized input/output roots before admitting paths. An explicit outside-root import authorization binds the resolved input identity, not a traversal string or broad output exception. Stage approved inputs into a controlled root, verify their digest after copy and use that immutable staged copy for rendering to reduce path-swap races. Recheck output-parent containment immediately before creation/promotion; never allow output traversal/overwrite. Proposed tests: `traversal-order`, `junction-swap-blocked`.
- Treat media decoding as untrusted input: local-only protocol policy where possible, duration/dimension/file-size caps, resource/time limits, validated executables and cancellation.
- Preflight disk/free space; cap encoder concurrency and review cache. CPU/GPU differences, hardware encoder fallback and missing filters are surfaced, not silently accepted as the same pipeline.
- Use temporary outputs and final atomic promotion; never overwrite accepted source files. On failure retain logs/step state and the last valid export.

### 8.6 Deliverable contract

A story is released only when all required output profiles are verified. Proposed delivery bundle:

- `final.mp4`: the approved cut; declared H.264/AAC/SDR/CFR compatibility profile unless the brief chooses another;
- `review.mp4`: optional smaller review encode, clearly labelled;
- `storyboard.png/pdf` and `animatic.mp4` as requested, with frame/shot labels;
- `captions.srt` / `captions.vtt` and optional burned-caption profile, or explicit not-requested status;
- `delivery-manifest.json`: expected versus measured duration/streams/fps/dimensions/color/audio, actual bytes, full hashes, input revision and toolchain;
- story/reference/selected-take provenance and an edit decision file for reproducibility, subject to privacy choices;
- credit/time ledger with known, reserved and unresolved amounts—no invented actual spend;
- absolute local paths or client-readable resources, with verified existence/access. In this CLI, give paths; do not claim an attachment or upload happened.

Final validation:

1. Verify input revisions/dependency hashes and no missing/stale required node.
2. Verify all selected references/takes passed required continuity/review gates.
3. Reconcile submission-unknown attempts or obtain an explicit user acknowledgement adopting/abandoning them for delivery while retaining unresolved credit reservations and duplicate risk. A story with accepted verified media may be delivered with an **incomplete cost-accounting** label; never claim exact final spend, release its uncertain allowance or permit an automatic retry merely to satisfy the release gate. Exact settlement may be unavailable; Google's credit-activity view is subscriber-specific.[1]
4. Probe every output and decode the full film; validate intended frame order, video/audio stream count, durations, timing, orientation/SAR and sample continuity.
5. Check for unintended black/frozen frames, missing shots, audio gaps/clipping, cut-off dialogue and subtitle misalignment; use technical checks plus complete human watch-through.
6. Rehash outputs after final writes; compare actual delivery files and permissions, not just ffmpeg exit 0.
7. Publish a release record only after the filmmaker/client signs off. Bind the full watch-through decision to the actual final output hash/edit revision, reviewer and timestamp; any changed output requires renewed review. Automated generation and assembly completion is not creative approval.
8. Remote sharing/upload/publication is a separate explicitly authorized action. A local MP4 does not imply it is uploaded to YouTube or otherwise delivered remotely.

## 9. Complete QA remediation map

All tests, work-package names, modules and new result fields below are **PROPOSED**. Existing file paths are current targets. Each row needs a failing behavioral test, a minimal repair, a green test, then applicable recorded/live verification.

| Finding | Existing targets | Planned repair | Acceptance / proposed regression |
|---|---|---|---|
| F01 sidebar misses DOM | `project-navigator.js`, feature callers in `src/tools/` | Sidebar adapter supports current list items/label spans/icon-bearing links; verify selection; every caller checks navigation outcome | Characters/Scenes/Images/Tools reach intended view; failed navigation changes no composer. `sidebar-mat-list-item`, `sidebar-icon-label`, `caller-blocks-nav-failure` |
| F02 obsolete routes / 404 success | `open-characters.js`, `import-character.js`, `use-flow-tool.js`, `discover-ui.js` | Discover actual scoped routes/links; remove blind plural/slug fallbacks; verify owning feature and 404/auth state | Real singular character form; actual opaque tool route; nonexistent tool blocked. `character-route-discovery`, `tool-route-identity`, `404-not-opened` |
| F03 wrong-screen feature readiness | `create-character.js`, `create-scene.js`, `grid-architect.js`, `open-tools-gallery.js` | Feature-specific assertions before filling; verify all prepared fields; no success on missing entry/form | Ordinary composer unchanged by failed feature handlers; real feature readiness only. `wrong-composer-untouched`, `scene-noop-blocked`, `grid-per-shot-fields` |
| F04 requested ≠ actual / panel confusion | `safe-actions.js`, `generate-image.js`, `generate-video.js`, validation/defs | Validate settings panel identity; fix serialized callback closure; verify actual settings/prompt; align defaults; expose mismatches | 4s/360p request cannot claim ready on 8s/720p; first-run changelog rejected; actual x1/model/ratio required. `settings-panel-identity`, `actual-not-echoed`, `evaluate-no-free-closure` |
| F05 discovery / current names | `model-discovery.js`, `models.js`, `selectors.js`, `src/index.js`, example config | Enumerate both image/video dropdowns via scoped composer; exact/version-aware model IDs; live/cache/unknown provenance; restore UI; combination-specific capabilities | Current 2.1/Lite identities selectable when seen; old config/fallback not falsely available; failed scan unknown, not unsupported. `live-catalog-exact-names`, `failed-scan-not-false-caps` |
| F06 upload / slot failure | `safe-actions.js`, image/video/character/grid/scene import callers | Real Add→Upload picker/file chooser, upload acknowledgement, explicit asset selection and exact slot checks | Valid fixture lands and required start/end roles verify; accepted file alone cannot pass slot QC. `filechooser-landing`, `start-end-slot-swap-blocked` |
| F07 mention failure / stray @ | `mentions.js`, image/video/scene callers | Boundary-aware picker trigger, root-scoped lookup, stable asset ID/chip read-back, rich composer rollback | Listed exact asset inserts; missing/ambiguous identity blocks required references and restores prompt/chips. `punctuation-at-trigger`, `mention-rollback-rich-state` |
| F08 destructive listing | `project-navigator.js`, `list-mentions.js`, discovery/model adapters | In-place reuse for same target/campaign; snapshot/restore non-destructive inspection; no session/MRU override of explicit binding | Prepare→list returns identical prompt/reference state; account/project retained. `campaign-list-preserves-composer`, `no-cross-campaign-session-reuse` |
| F09 status omissions/parsing | `src/index.js`, `flow-status.js`, `safe-actions.js`, account helper | Honor full screenshot; share positive account extraction; decode observed crop icons; model/settings read-back and explicit unknown | Square yields 1:1 / clean model; full returns actual PNG; no empty account-as-verification. `status-full-png`, `crop-square-model`, `account-label-readback` |
| F10 URL ≠ usable app | `flow-open.js`, `flow-status.js`, `launch-profile.js`, shell helper | Separate allowed origin/browser/account/app readiness; wait semantic shell; detect 404/loading/auth/consent | Flow 404 can remain allowed URL while app_ready=false; do not infer logged-out solely from 404. `loading-not-ready`, `404-independent-account`, `auth-interstitial-blocked` |
| F11 discovery persistence | `discover-ui.js`, `selectors.js`, storage/config helpers | Initialize dirs; version selector arrays separately from human observations; atomic storage; aliases explicit; strict ratio extraction | Fresh FLOW_HOME works; dates not ratios; map round-trips to consumer; wrong sidebar cannot be discovered-success. `fresh-runtime-discovery`, `selector-map-migration`, `ratio-not-date` |
| F12 false smoke pass | `scripts/test-flow-image.ps1/.sh`, `run.js`, new portable QA client | SDK initialization/result assertions, deadlines, expected account verification, nonzero negative exit; bundled target | Intentionally missing Chrome and tool errors fail; missing response/timeouts fail; healthy initialized source/bundle fixtures pass. `smoke-negative-tool-error`, `smoke-timeout`, `initialized-stdio-smoke` |
| F13 missing packaged scripts | `package.json`, scripts/build/CI | Ship public-command dependencies or explicitly separate repo-only commands; install-tarball tests outside repo/CWD | Every advertised entry/script resolves in clean install; config/env isolation; no fictional current --help flag assumed. `packed-command-dependencies`, `outside-cwd-package-smoke` |
| F14 intermittent new-project name | `project-navigator.js`, project adapter | Hydration-aware title edit/read-back, bounded retry, named/pending/failed result and ID-based registry | Empty-new-project name verifies or pending is explicit; no 30s blind stall/duplicate ID; later retry safe. `empty-project-title`, `rename-time-budget`, `rename-no-duplicate` |
| F15 menu-only download / latest unknown | `download-latest.js`, `file-manager.js`, asset catalog/adapter | Explicit source-result ID; hover/menu/format selection; preserve working save; newest verified result wrapper, no first-tile guess | Multi-asset fixture downloads requested generation, not uploaded/old asset; single-client bytes/decode verified. `download-explicit-asset`, `latest-not-upload`, `download-menu-format` |
| F16 metadata-only multi-shot | `generate-video.js`, validation/defs, proposed story executor | Immediate honest plan-only semantics; new durable per-shot operations using locked refs and actual handoffs; local assembly | Each requested shot maps to a separate verified take/explicit blocker; strings such as shot-1-strongest-frame never count as real assets. `shot-plan-not-execution`, `per-shot-ledger`, `real-handoff-asset` |
| R01 account not guarded at spend | `account-check.js`, `src/index.js`, all submitting handlers | Exact positive identity and common pre-submit policy; connect can be browser-connected but account-unverified/blocked | Every submit path, including native creation and edits, refuses wrong/unverified account; no Generate/Accept event. `all-submit-account-guard`, `mid-session-switch` |
| R02 completion not correlated / unverified settings | image/video polling, `safe-actions.js`, proposed operation/asset modules | Baseline/new-result evidence, observed remote IDs when available; no invented backend correlation; strict setting verification | Old media never satisfies new render; ambiguous/late outcome unknown; requested reference role mismatch blocks. `old-thumbnail-not-new-video`, `ambiguous-results-pause`, `no-blind-resubmit` |
| R03 reset ≠ remote cancel | `job-queue.js`, reset dispatch, UI lease and operation journal | Abort/fence local actor; durable remote unknown/submitted state survives reset; no refund/cancellation lie | Stale actor cannot click/complete after reset; recovery blocks duplicate submit; existing terminal guards retained. `reset-fences-actor`, `late-result-reconciliation` |
| R04 contracts/tests/config | `src/index.js`, `validate.js`, `use-flow-tool.js`, config/logger/selectors, package/CI | One schema source, documented aliases/defaults, strict/explicit unknown params, safe selector input, all-source syntax coverage, optional gradual checkJs, unified runtime root | Valid quantity range remains enforced; unsupported params visible; logs isolated; schema/client surface agree. `contract-parity`, `parameter-injection`, `runtime-log-root` |

Paths such as `project-navigator.js` in this table refer to the existing `src/navigation/` file; handler names refer to `src/tools/`; helpers to their existing `src/browser/` or `src/utils/` locations.

### 9.1 Catalog/capability correction in detail

Current `models.js` merges config, cache and fallback into one apparently available universe, has version-insensitive matching risks, and defaults unknown capabilities too optimistically for frames while forcing ingredient duration to 8s. Replace that operational authority with provenance-aware candidates and a per-combination capability record:

    model identity + account/region + feature mode + ratio + duration + resolution + quantity
    → supported / unsupported / unknown + evidence + observed_at + expiry

A missing panel/row is unknown, not proof unsupported. A disabled feature with an explicit app restriction is unsupported for that context. Display caches for planning, but reverify the exact combination before any submission. Do not merge stale aliases into a fresh list of available models.

Probing changes the UI: snapshot relevant state, use the verified settings/model roots, read dynamic nested controls, restore selection/composer, and invalidate a preparation/approval if restoration cannot be verified. No capability test needs a paid click merely to record control availability.

### 9.2 Project identity correction in detail

Explicit project/story binding always wins. A campaign/name lookup can propose a target, but duplicate names require disambiguation and account-scoped IDs. An existing session project does not override a new explicit campaign. Reuse the exact current project without reload; title updates are separate, verified mutations. Account change invalidates bindings/catalog/reference remote IDs until checked again.

### 9.3 Queue/storage correction in detail

Keep the existing terminal-job guards and honest single-flight rejection while adding persistent attempts. Serialize *all UI mutations*, including navigation/settings/discovery/picker listing; merely locking generation calls does not prevent another tool from destroying preparation during a spend.

An async story stage returns a durable operation/job handle promptly. Polling/status/review/resume are ordinary proposed MCP tools; do not assume a particular experimental SDK Tasks API. Stdio client disconnect/process termination may interrupt the local runner; persistence supports later resume, not a promise the process survives indefinitely. Remote render may continue, so reconnect reconciles.

## 10. All existing MCP tools: required post-fix contract

| Existing tool | Required behavior after repair |
|---|---|
| `flow_connect` | Prefer existing Flow tab or dedicated new tab; attach before demanding a source profile; report browser/account/app/catalog states separately; safe ownership/cold-launch errors |
| `flow_disconnect` | Detach user-owned Chrome, preserve its tabs; handle self-launched cleanup separately; durable operations accurately interrupted/unknown |
| `flow_open` | Validate origin/URL, serialize navigation, wait/return real app state; do not silently destroy a locked preparation |
| `flow_status` | Truthful account/app/prompt/settings/queue state with full screenshot option; read-only, explicit unavailable values |
| `flow_account_check` | Positive exact account identity, mismatch/inconclusive states; shared pre-submit guard, no substring identity shortcut |
| `flow_discover_ui` | Documented aliases resolved/verified; versioned observations and usable selectors; no invented capabilities or unsafe self-healed clicks |
| `flow_generate_image` | Explicit or aligned defaults; verified image mode/settings/references/zero policy or explicit paid authorization; new image identities and real outputs |
| `flow_generate_video` | Verified model-feature-duration/ref roles/quantity/quote; one concrete take; real observed render state and explicit media identity |
| `flow_list_models` | Live/catalog provenance, version-aware names, model-specific capabilities; reversible inspection |
| `flow_download_latest` | Latest eligible verified generation in the bound scope or explicit ambiguity; auto expose real menu; preserve proven single-client save |
| `flow_create_character` | Actual character-specific form, validated preparation/creation, bound cost guard and verified persisted name/ID |
| `flow_import_character` | Validated file/object/references, correct scoped form, explicit prepared versus imported/persisted result |
| `flow_open_characters` | Actual list/form route, stable character identities when visible, no 404 success |
| `flow_list_mention_options` | Scoped asset IDs/names/types, pagination where needed, empty-versus-failed distinction and preserved composer |
| `flow_create_scene` | Correct scene/Scenebuilder surface and explicit organize/prepare/create semantics; no generic composer no-op success |
| `flow_open_tools_gallery` | Correct project gallery/tab, available templates and entitlement; no All media-as-gallery result |
| `flow_use_grid_architect` | Exact tool/frame identity, individual shot-field read-back, quote/entitlement policy; blocked means blocked |
| `flow_use_tool` | Verified chosen tool, schema-aware applied/skipped params and safe keys; unsupported/third-party restrictions explicit |
| `flow_screenshot` | Actual file/resource exists, disconnected errors honest, privacy/redaction/storage/retention policy enforced |
| `flow_queue_status` | Active UI owner and local/remote/recovery states accurately distinct; durable per-operation history, not fictitious pending work |
| `flow_queue_reset` | Local abort/fencing and unresolved remote state preserved; no remote cancellation/refund claim; safe explicit recovery |

### 10.1 Proposed new public tools — NOT currently registered

Prefer a small high-level surface, with canonical schemas and async handles. Exact names/arguments are proposals to implement and contract-test, not tools available now.

| Proposed tool | Scope and default |
|---|---|
| `flow_story_create` | Validate client-authored structured brief/bible/shots, create local revision/budgets; no remote submission |
| `flow_story_update` | Expected-revision patch, DAG invalidation report; no implicit rerender/credit spend |
| `flow_story_run` | Schedule a named bounded stage (references, storyboard, animatic, clips, review-artifacts); prepare-only unless valid matching stage/attempt policy authorizes submission |
| `flow_story_status` | Durable stage/shot/candidate/take/credit/time/blocked/uncertain state and exact next actions |
| `flow_story_review` | Typed record-score/select/reject/lock action by immutable IDs and revision; no fabricated autonomous scoring |
| `flow_story_approve` | Issue/expire/revoke request-bound authorization or zero-only bounded policy; no UI click itself |
| `flow_story_resume` | Reconcile/repair safe missing local derivations, resume eligible units; unknown attempts do not auto-resubmit |
| `flow_story_cancel` | Request abort/fence locally and report real remote state; no implied refund/remote cancel |
| `flow_story_export` | Local timeline validation/assembly/verification and delivery handles; no remote upload or hidden generation |
| `flow_list_assets` | Non-destructive account/project-scoped asset identities/types/pending states; paginated observations |
| `flow_download_asset` | Explicit verified remote/local asset mapping, selected format/resolution, actual validated file |

The current client/agent supplies creativity and review decisions; these tools supply an auditable workflow. File resources/contact sheets may be exposed through authorized MCP resources or image content where the client supports it; large media files remain verified paths/resources, not oversized base64 tool results.

## 11. Phased implementation work packages

Every work package is a future vertical TDD slice: write and observe the right failure first, implement the smallest repair, exercise it, then integrate. Do not write a giant pile of guessed tests followed by a wholesale rewrite.

### W00 — Evidence and reproducible contracts

- Pin the QA revision and preserve current failing cases/DOM snippets as sanitized semantic fixtures.
- Record which behaviors are good: detach/reconnect, quantity rejection, real single-client JPEG saving and terminal queue guards.
- Add registry/dispatch/validation parity checks and a test-only injectable page/session boundary so real HTML fixtures can exercise handlers without changing global browser state.
- Declare all new API fields/modules as proposed until landed; inventory production modules/dependencies before coding.
- Exit: baseline green plus harness and the first vertical reproductions for F01/F03/F04/F12/F13, not failures from broken test imports. These are starter slices, not the entire finding closure: maintain a registry assigning every remaining finding/risk its reproduction and owning work package, and observe each relevant RED before that slice's fix.

### W01 — Shared contracts, protected runtime storage and policy skeleton

- Introduce truthful requested/actual/readiness schemas, positive account state and common submission policy.
- Version/init runtime directories; separate protected story state from debug/legacy metadata; fix logger root and nested selector-observation formats.
- Add minimal durable intent/approval/attempt/reservation journal primitives, explicit errors, corruption backup and migration tests. Protect future story paths now; defer the full content-addressed bible/story DAG store to W08 rather than implement a big-bang storage rewrite.
- Add an internal denial guard so incomplete new verification cannot accidentally reach a live submit during the migration.
- Exit: fresh runtime works, storage errors are not UI-change errors, every early result is typed, current prepare-only/defaults cannot spend.

### W02 — Session ownership, app readiness and navigation

- Prefer/reuse Flow tab, avoid navigating another personal tab; attach to live CDP before failing because a configured source profile is missing.
- Implement scoped page adapters, semantic shell waits, sidebar label/list-item support, auth/error/loading/feature identity and UI transaction serialization.
- Replace obsolete route/slug guesses; fix initial title rename with bounded verified states.
- Preserve working attached detach behavior; add safe cold-launch/platform fixtures, port conflicts and explicit unsupported headless cases rather than assuming those branches work.
- Exit: account/app/404 independence correct; all navigation callers block on failure; same project/campaign inspection preserves composer.

### W03 — Models, settings, capability combinations and cost quote

- Fix settings-panel identity and browser callback closure; single verified composer driver replaces redundant broad “settings” routines.
- Enumerate exact current models including version/variant; separate fallback candidates from actual availability.
- Probe exact feature combinations with tri-state evidence and restore UI. Align definitions/defaults; remove model-blind duration force from verified supported combinations.
- Keep syntactic duration parsing separate from semantic validation: accepting a numeric/string representation does not make arbitrary 1–30-second durations supported. Require membership in the live verified model-feature duration set before preparation/submission; unknown combinations block. Seed documentation values with provenance only, including the Quality documentation conflict in §1.4, not a fixed hardcoded allowlist that contradicts the current account. Proposed test: `duration-allowlist-per-model-feature`.
- Add cost-unit parsing, quantity-aware total quote, freshness/entitlement/rate signals and explicit unknown cost.
- Exit: live 2.1 name accepted when observed; wrong panel/4s versus 8s/360p versus 720p never ready; quoted zero policy and any paid quote enforced in fixtures.

### W04 — Assets, upload, picker and non-destructive references

- Introduce explicit local/remote asset records, import validation, real Add/Upload/filechooser flow and upload acknowledgement.
- Verify picker identity, slot assignment and full required reference set; fix mention trigger/scope and rich composer restoration.
- Repair explicit/newest eligible asset download/menu/format selection, preserving existing working `saveAs` and single-browser ownership.
- Handle missing/renamed/duplicate assets, conversion, signed URL expiry and incomplete downloads without false identity claims.
- Exit: no-spend semantic fixtures plus opt-in fixture upload→list→insert→prepare→explicit download work without generation; no stray @, no state loss, no start/end swap pass. Actual generated-image attribution is a separate authorized live gate, not required to merge an upload repair.

### W05 — Durable safe submissions, polling, queue fencing and recovery

- Add durable intent/approval/attempt/reservation before submit; verified account/settings/refs/cost immediately before each consequential click.
- Poll correlated new assets/progress, not any old thumbnail. Unknown acknowledgement/outcome persists and pauses.
- Persist the mandatory baseline and apply the attribution rule in §3.4; insufficient live observability remains blocked/unknown even if mocks would produce an ID. Consume approval children once and test partial/multi-variant reservations independently of output landing.
- Return operation handles; preserve existing terminal protections; add abort checks, UI lease epochs and reset/cancel semantics across restart.
- Exit: mocked crash at each submit boundary never causes silent retry; old result cannot satisfy new render; stale actors cannot submit/complete after reset; no lost intent/reservation.

### W06 — All legacy feature handlers and truthful diagnostics

- Migrate image/video and native character/import/scene/gallery/grid/arbitrary-tool handlers onto the verified adapters and common operation policy.
- Fix feature-form and individual-grid-shot read-back; account/entitlement/modals/unsupported params reported honestly.
- Fix status full/account/crop/model fields and all discovery aliases/outputs/persistence.
- Correct metadata-only multi-shot descriptions now; do not claim per-shot execution until W11 exists.
- Exit: all 21 repaired tools have valid, negative and applicable UI fixture cases; unsupported native features have explicit blockers, never no-op success.

### W07 — Package, smoke, CI and runtime portability

- Replace unconditional platform smoke assertions with a small initialized portable SDK test client; platform wrappers can delegate rather than duplicate brittle parsing.
- Include all published-command dependencies or clearly separate repo-only scripts; add installed-tarball execution/config tests from an unrelated CWD.
- Check every source JS file, preserve lint, optionally introduce gradual JSDoc/checkJs with an explicit new dependency/config; do not call entry-only syntax checking a full type gate.
- Test controlled process spawn/platform paths, Chrome port conflicts, runtime roots, newline/Unicode handling and sandbox registration configs.
- Do not assume current commands implement `--help`/`--dry-run`. Add/document any needed safe test modes first; never run register against a real user's client config in CI.
- Exit: positive initialized fixture smoke passes; intentional tool error/missing executable/timeout fails; packed public surface resolves. Live signed-in tests remain opt-in and never store sessions in CI.

### W08 — Story schemas, bible/state DAG and revisioned planner

- Implement client-authored brief/bible/shot/edit validation, stable identities, conflict checks, time math and DAG invalidation.
- Add first high-level create/update/status/review operations, bounded generation policies and explicit account/project binding.
- Build a one-scene/two-shot plan with deliberate prop/state continuity and revision tests; no generation required yet.
- Exit: malformed/cyclic state graphs, impossible edit timing, missing refs and conflicting project IDs fail; selective invalidation preserves unrelated accepted work.

### W09 — Zero-credit canonical references and image selection

- Add bounded candidate jobs, measured timing, actual image correlation/download/probe, labelled contact sheets and manual/client scoring.
- Freeze approved character/location/prop assets and versioned shot reference packs; add duplicate/transcode/privacy/retention handling.
- Exercise an opt-in zero-cost image submission only after its quote/policy is verified; stop if quote changes.
- Exit: real candidates can be compared and a correct immutable selection is saved; no screenshot/thumbnail promoted as original; quota or time exhaustion returns a resumable stage.

### W10 — Storyboard sequence and local animatic

- Produce shot panels, joint continuity review, start/end state locks, EDL frame durations and local still-image animatic.
- Implement safe FFmpeg/ffprobe discovery/process wrapper, contact sheets/frame strip support and subtitle/scratch-audio validation.
- Exit: reviewed animatic matches the declared shot sequence/duration; changing a panel invalidates the exact dependent clips/approvals but not unrelated source assets.

### W11 — Per-shot video execution and temporal review

- Add one concrete clip/take operation for each approved shot, using valid model-specific refs and source duration.
- Implement authorizations/reservations/uncertain reconciliation, actual output correlation/download, frame sampling and full take review.
- Save accepted actual end frames and invalidate successor handoffs when a predecessor changes; native “shots[]” is only an input plan for this scheduler, not hidden multi-shot magic.
- Start with a single explicitly authorized video take, then a two-shot handoff before full-film runs.
- Exit: one accepted real clip and two coherent linked shots with measured output and truthful credit ledger; paid live tests cannot run under default CI or without matching user authorization.

### W12 — Editing, audio/subtitles, verified film assembly

- Implement timeline compiler, normalization, hard cuts/crossfades with actual runtime accounting, audio policy, captions and output profiles.
- Use synthetic local media fixtures for mixed codec/fps/orientation/audio/color cases; these test the renderer, not fabricated Flow results.
- Add expected-versus-decoded duration/frame/stream checks and full-decode outputs before promotion.
- Exit: local accepted-take fixtures produce the correct final order/time/audio; exact clip hashes and commands recorded; an export failure never rerenders Flow content.

### W13 — Delivery, recovery, performance and release

- Implement delivery manifest/resources, final hash/access checks and human release sign-off.
- Exercise story restart/resume, missing derived files, deleted remote refs, stale revisions, quota exhaustion, dependency changes and interrupted exports.
- Add realistic scheduling/resource limits and latency instrumentation; optimize only after measured critical paths are known.
- Exit: full opt-in story from approved references through verified final film, no unresolved required creative/media review, and an honest known/reserved/unknown credit ledger. Delivery with user-acknowledged abandoned uncertainty follows §8.6 and cannot claim complete cost settlement. Reproduce from retained sources and EDL without regeneration.

### 11.1 Dependency order and parallel work ownership

Main path:

    W00 → W01 → W02 → W03 → W04 → W05 → W06
                  \____________________________→ W07 (package/CI lane)
    W01 + corrected low-level contracts → W08 → W09 → W10 → W11 → W12 → W13

W10/W12 local media fixture work can be developed in parallel with browser fixes, but cannot claim an actual generated-film release before W11.

Land W00–W07 as the first reliability milestone; add proposed story tools only as their W08–W13 behavior becomes real. Optional numerical scoring, hosted vision, native Scenebuilder, advanced transitions/HDR and speech adapters are not blockers for a truthful minimal pipeline. Start assembly with reviewed normalized SDR hard cuts and explicit audio policy; unsupported profiles remain blocked until tested. Do not call the 14 packages a single rewrite or require paid video validation just to merge no-spend repairs.

Suggested OpenCode workstreams for the later implementation:

- Browser reliability owner: page/session/navigation/settings/reference adapters. Own shared `safe-actions.js` during integration.
- Durable domain/story owner: contracts/storage/policy/operations/DAG. One owner for dispatch/Zod/schema changes to avoid conflicting edits.
- Media/release owner: local renderer, probes, captions, packaging/CI fixtures. No browser connection needed for fixture work.
- Independent reviewer: adversarial contract/cost/crash/media audit after each vertical integration slice.

Use isolated worktrees/copies, exact model selection, task-specific permitted paths and artifact/test outputs. Parent integrates and independently runs gates. Only one worker owns the live QA browser at a time; do not parallelize exploratory UI actors on the same profile to “go faster”. No commits/pushes without user authorization.

## 12. Failure register: things that can break and required response

This list is not a claim of exhaustive certainty. Each row is a future test obligation and a runtime response, not a reason to improvise silent repairs.

| ID | Failure | Required containment/recovery |
|---|---|---|
| K01 | CDP absent, wrong port, another process or remote binding | Validate loopback/endpoint; fail or attach verified instance; never kill an arbitrary user process |
| K02 | First HTTP tab is mail/personal instead of Flow | Select verified Flow tab or dedicated new tab; do not repurpose personal content |
| K03 | Configured source profile missing but valid CDP already exists | Attach/check first; profile source validation only for authorized launch path |
| K04 | Login/MFA/consent/CAPTCHA/region interstitial | Manual pause; no credentials/challenge bypass or fake authenticated state |
| K05 | Account changes after connect or wrong email substring matches | Exact fresh positive account guard; invalidate remote bindings and approvals |
| K06 | Two browser clients/processes or manual settings edit | UI lease, epoch/fresh read-back; abort/invalidate preparation; one download owner |
| K07 | Slow SPA hydration, detached nodes, hidden recaptcha textarea | Semantic feature waits/re-resolved scoped inputs; no fixed-delay success |
| K08 | Changelog/asset/grid modal mistaken for settings | Owning-panel identity required; restore/close safe overlay or explicit blocked state |
| K09 | Sidebar labels/icons/locale/custom elements change | Role/semantic adapter with fixture fallback; explicit unknown UI with evidence, no loose “Create/New” click |
| K10 | 404/same-origin error page or redirect | Allowed URL separate from account/app/feature; no opened/ready success |
| K11 | Model rename/version or stale cached catalog | Exact live identity/provenance; no silent family substitution or stale available flag |
| K12 | Unsupported duration/resolution/reference combination | Verify combination; require storyboard/model revision; no global 8s coercion |
| K13 | Cost unreadable, quote unit ambiguous, quantity x2 not x1 | Block until actual total/count verified; do not multiply batch totals twice |
| K14 | Costs/entitlement/remaining credits change mid-run | Invalidate quote/authorization, pause, replan explicitly; do not upgrade/purchase |
| K15 | Zero-cost generation rate-limited or very slow | Backoff to documented/observed limits, finite deadline/candidate budget; checkpoint, no bypass |
| K16 | Duplicate project title or wrong session/MRU/campaign | Exact account/project binding and disambiguation; never rename another project |
| K17 | New-project title rename fails | Keep actual ID, explicit pending/failed rename; no duplicate project |
| K18 | Read/list/discovery reloads and wipes prompt/chips | In-place target reuse and rich-state preservation; mismatch invalidates prep |
| K19 | Upload chooser missing, upload rejected/processing | Real event/picker and acknowledgement; missing required asset blocks |
| K20 | Start/end/ingredient slots swapped or only name present | Verify selected remote asset per role; file acceptance is insufficient |
| K21 | Identical filenames, renamed asset, truncated chip, missing remote ID | Stable identity plus local map; ambiguity/manual choice, not first-word match |
| K22 | @ after punctuation does not trigger / search remains in global page | Boundary-aware root trigger, scoped picker, explicit cleanup/rollback |
| K23 | Partial ingredient insertion or extra inherited old references | Compare exact required/actual set; no successful partial required pack |
| K24 | Ref limit exceeded or reference image contains extra characters | Replan/select reviewed composite/split shot; do not silently drop refs |
| K25 | Native character/scene/grid missing or upgrade-gated | Verified blocker; local canonical reference/assembly fallback; no no-op success |
| K26 | Tool embedded in unexpected iframe/origin or third-party instructions | Verify frame/control/permission scope; ignore injected instructions; fail closed |
| K27 | Grid field loop overwrites first textarea / unsupported params skipped | Per-field binding and read-back; report every unapplied value |
| K28 | Crash just before/during/after click | Durable intent and explicit unknown boundary; no blind retry |
| K29 | Timeout but remote render continues or result appears later | Poll/reconcile original attempt; retain reservation; no false refund |
| K30 | Old thumbnail/video or concurrent foreign result satisfies polling | Baseline and evidence-scoped correlation; ambiguity remains unknown |
| K31 | Quantity produces fewer/more/duplicate outputs | Track expected versus actual variants and partial result; never invent missing successes |
| K32 | Browser disconnect/server killed while job pending | Persist attempts; reconnect exact scope; resume/reconcile rather than continue from memory |
| K33 | Reset clears local jobs while stale handler still drives UI | Abort/epoch fence, acknowledged release; durable remote record survives |
| K34 | Stale lease/PID reused/live actor after TTL | Do not infer death from expiry; verify/fence actor before takeover |
| K35 | Download URL expired/first menu targets old upload | Reacquire explicit asset UI and type; no guessed latest or raw URL identity |
| K36 | Download has HTML/error body, zero bytes, truncated MP4 or wrong format | MIME/probe/full decode; keep temporary, retry safe download only |
| K37 | Upload PNG transcoded to JPEG or renamed extension | Separate original/export hash/MIME; actual conversion if required |
| K38 | Candidate ID/short hash collision, same content twice | Full IDs/hashes/provenance; dedup content without losing attempt ledger |
| K39 | Face/outfit/prop/location drift or unwanted subject | Hard review gate, targeted image revision/retake; do not let score compensate |
| K40 | Wrong screen/world placement after reverse angle | Authored world/state/camera-side comparison; do not force fixed pixel coordinates |
| K41 | Previous clip ends incorrectly and successor inherits it | Reject/repair predecessor; invalidate dependent handoff; retain canonical references |
| K42 | Sparse frame checks miss mid-clip morph/lip-sync/flash | Full take review plus dense targeted strip; no sample-only guarantee |
| K43 | Scorer unavailable/NaN/hallucinated certainty/injected image text | Human/client baseline, explicit confidence/needs review, no hidden cost |
| K44 | “Best” panel looks good alone but breaks adjacent shots | Joint sequence and edge/state compatibility review before board lock |
| K45 | Changing bible/selection/shot order after approvals | Revision digest and dependency invalidation; no reuse of stale spending approval |
| K46 | Corrupt/partial JSON, interrupted multi-file commit, future schema | Backup/journal/recovery/version rejection; no silent empty reset |
| K47 | Cleanup deletes approved refs/manifests or remote asset deleted | Protected retention and local copies; explicit recovery map; no global rerender |
| K48 | Disk full, locked files, antivirus, long/Unicode/quoted Windows paths | Preflight and controlled temp names/argv; preserve old valid export; bounded retry |
| K49 | FFmpeg/encoder/filter/font missing or version feature drift | Feature preflight and explicit dependency/blocker; no assumed current-machine portability |
| K50 | Mixed fps/VFR/timebase/SAR/rotation/dimensions/codecs | Declared normalized pipeline; verify derived outputs before joins |
| K51 | HDR/SDR/full/limited range/color metadata mixed/unknown | Explicit conversion/review; no mere metadata relabel as color correction |
| K52 | Bad trim boundaries, wrong ordering, insufficient handles | Timeline compiler/decoded validation; review action/dialogue; no silent stretching |
| K53 | Crossfade shortens film but audio/subtitles keep old positions | Single timing authority, overlap math and retimed tracks/cues |
| K54 | Missing/silent/too-long audio, clipping, variable generated voice | Explicit mute/pad/trim/mix policy; real measurements and voice/dialogue review |
| K55 | Captions out of range/wrong text/Unicode/font failures | Verified transcript/timing/font; explicit sidecar fallback only if approved |
| K56 | Export crash/cancel leaves partial file or overwrites source | Temp+atomic promote; retain source/last release; retry local derivation only |
| K57 | Output probes but cannot decode fully / wrong content downloaded | Full decode and frame/order/content checks plus human watch-through |
| K58 | Final path exists only on server inaccessible to client | Verify permitted client resource/path delivery; do not claim an attachment/upload |
| K59 | Asset/story metadata injects shell/filter/path traversal | Structured argv/schema, separate escaping, realpath/roots, untrusted-media sandboxing |
| K60 | Credits shared with other devices or balance delta misattributed | Reservation + attempt evidence; actual spend unknown unless attributable, no guessed refund |
| K61 | Published tarball/source CWD difference breaks config/scripts | Installed package/outside-CWD/env precedence/negative smoke tests |
| K62 | Cold launch/headless/cross-platform branch untested | Explicit opt-in fixtures/live gates; no cross-platform certification from Windows attach |
| K63 | Stdio host timeout kills local worker but result still renders | Durable handle/restart reconciliation; no promise of indefinite detached execution |
| K64 | Unauthorized rights/voice/real-person references or public sharing | Obtain appropriate permissions; block unavailable policy; remote publication separate approval |
| K65 | All approved video takes fail quality within finite budget | Pause with evidence, preserve stills/animatic; ask to revise shot/budget; do not spend indefinitely or fabricate a final film |
| K66 | Compiled prompt or reference graph exceeds legacy/model limits | Validate lengths/counts/dependencies before UI work; split/review explicitly, no silent identity truncation or six-shot film cap |

## 13. Test strategy and acceptance ladder

### 13.1 Layers

**A — Pure/domain tests:** schemas, model/version/capability semantics, quote units, score/not-applicable math, identity/state transitions, request digests, budgets, DAG invalidation, timeline frame math, storage revisions and corruption recovery.

**B — Real semantic DOM fixtures:** mount sanitized captured HTML, exercise the actual adapter/handler against Mat list items, icon labels, changed crop tokens, dynamic menus, nested frames, changelog overlays and asynchronous rerenders. Prefer these to mocks that blindly return true for every selector.

**C — Process/protocol/package tests:** initialized SDK stdio calls, all registered definitions versus validators/dispatch, tool errors and timeouts, source/bundle inventory, installed tarball outside CWD, environment precedence, isolated register targets and Chrome launch ownership fixtures.

**D — Real local media tests:** generate clearly labelled synthetic fixtures to test the proposed renderer (different fps, audio/no audio, orientation, dimensions, corrupt/truncated files, silence, Unicode captions, cuts/crossfades). Execute FFmpeg, ffprobe and decode, compare actual frame/time/order outcomes. These are local media tests, not fabricated Google outputs.

**E — Opt-in signed-in live tests:** replay QA failures with a dedicated test project/profile and bounded policies; zero-credit image submissions only when verified and authorized. Actual video submission requires fresh explicit budgeted authorization; CI defaults never spend. Keep one browser owner.

**F — Story acceptance:** one approved image/reference; then one shot; then a two-shot continuity handoff; finally a short multi-shot film with decoded output, cost reconciliation and full human review. Expand only after each gate passes.

### 13.2 Required crash/negative tests

Inject failures at: before journal commit, after intent/before click, during click, after acknowledgement/before save, during poll, download event/before rename, metadata child writes/before root-pointer update, frame extraction, FFmpeg encode and export promotion. Test browser closure/reset/account switch simultaneously with pending jobs.

Assertions include **what must not happen**: no second submit, no accepted wrong asset, no old approval reuse, no false terminal success, no source overwrite, no hidden model switch, no erased uncertain reservation, no remote cancel/refund claim.

Also retain `concurrent-prepare-rejected`, `stale-actor-after-reset-blocked`, negative installed-tarball execution and outside-CWD config isolation. Named UI cases include `alias-home-blocked`, `mention-empty-vs-failed`, `model-field-decontaminated` (no crop icon token in model name, square ratio decoded), and `loading-not-ready`; cover them in W02/W04/W06/W07 respectively rather than relying on table-row presence.

### 13.3 Release gates

**Gate A — reliability implementation/merge, no generation spend:** mapping/contracts, semantic fixture regressions, non-generating browser read-back where available, crash/negative/installed-package tests and protected journal state must pass. Correct blocked/unsupported outcomes are valid for entitlement-limited native paths, not proof those features work. A source-inferred risk can be mitigated in fixtures without being called live-verified. F16 becomes honest plan-only here; its new per-shot executor is not complete until Gate B.

**Gate B — live story certification/delivery, opt-in authorization:** actual zero-cost image submissions, approved paid/zero-quote eligible video submissions, continuity, per-shot execution and the final-film gates below must be exercised. If authorization/eligibility is unavailable, report Gate A passed and Gate B unverified/blocked; do not certify a real film pipeline using synthetic fixtures alone. Gate B is not required just to merge Gate A.

- Every F01–F16 and R01–R04 row maps to an implemented repair/test, not an old DONE label.
- All 21 existing tools return a truthful tested outcome. Correct native blocked/unsupported responses can pass contract/negative tests; availability or success of those native features remains separately unverified. Core local fallback is certified only at its actual story milestone, never inferred from a native blocker.
- Zero ready/opened/success results on the wrong feature, failed required setting/reference, 404 or unverified required state.
- Source/bundle/packed contracts match; quality gates, negative smoke and installed-package tests pass.
- Opt-in real image generation confirms zero cost and correct new downloadable candidate; real authorized clip generation confirms actual mode/model/duration/refs/outputs.
- Unknown submissions survive restart and cannot be retried automatically; reset cannot allow a stale actor to spend or overwrite state.
- Story image/cast/prop/location/shot consistency is reviewed and recorded; per-shot outputs and accepted real handoffs exist.
- Final media is actually assembled, probed, fully decoded, watched, hashed and accessible, at the declared duration/profiles; no fabricated clip or delivery result.
- Accepted sources/manifests remain protected from retention cleanup; restart/resume does not regenerate accepted work.

Do not set a test-count vanity target. Baseline is 127 tests; new coverage is justified by behaviors and failure boundaries above.

## 14. Worked story blueprint and checked budget/timing example

This is a **proposed example**, not a generated story or a claim about current render timings/prices.

### 14.1 A one-minute story: “The Music Box”

Fixed world: warm workshop, window on one wall, door on another, central wooden table; approved teal outfit for Mara, cream apron for Eli, one brass music box, one replacement gear. Same location/light baseline throughout; camera reverses preserve world relationships.

| Shot | Narrative/action | Required continuity | Nominal source |
|---|---|---|---:|
| SH01 | Establish workshop; Mara notices the silent box | Box broken/closed; table/window/door anchors | 8s |
| SH02 | Mara opens the box and finds a damaged gear | Same box and outfit; box now open | 8s |
| SH03 | Eli brings a replacement gear to the table | Eli identity/apron; one gear, declared handoff | 8s |
| SH04 | They fit the replacement gear | Same box geometry; intentional repaired state | 8s |
| SH05 | First turn jams; both react | Repaired but jammed, not a new broken box | 8s |
| SH06 | A small adjustment frees it | Declare adjustment; no extra object/hand | 8s |
| SH07 | Box plays; Mara smiles | Box now playing; consistent music/prop | 8s |
| SH08 | Wider closing beat together in the workshop | Same cast/world; box still playing | 8s |

Use close-up hand actions only if the take passes anatomy/action QA; a reviewed cutaway is an acceptable deliberate redesign if those motions prove unreliable. Narration/ambience can carry the story without requiring unstable cross-clip lip-sync.

### 14.2 Image exploration example

Illustrative reference decisions: two characters × four useful views = 8; three location views = 3; two hero-prop views = 2. Total: **13 reference decisions**.

At four candidates per reference decision plus four per eight storyboard shots:

- references: 13 × 4 = **52 candidates**;
- storyboard: 8 × 4 = **32 candidates**;
- initial total: **84 candidates**, or **21 x4 batches**, if that exact zero-cost quantity is supported.

This is an upper exploratory example, not a compulsory minimum. Start smaller, reuse good assets and skip views the story does not need. Extra end-frame panels, composite reference packs and improvement rounds add explicit decision units/batches.

Zero quote makes initial Flow image credits zero; generation/review time, quotas and storage still need limits. A hypothetical 120-second generation time per x4 batch gives 21 × 120 / 60 = **42 minutes of generation-only time**. This is **not a measured latency estimate**. Actual planning should use sampled latency plus preflight/upload/download/review/wait time and checkpoint after the agreed deadline.

### 14.3 Exact hard-cut runtime

Eight verified 8-second sources produce **64 seconds raw**. For a 24-fps hard-cut example, select 7.5 seconds per shot by trimming six frames at each end:

- each normalized 8s source: 192 frames;
- retain 192 − 6 − 6 = **180 frames** = 7.5s;
- eight shots: **1,440 frames / 24 = 60 seconds**.

This trim is only valid if all required action/dialogue fits. Otherwise revise pacing/shot duration or the brief—do not force the arithmetic by cutting the story's resolution.

With crossfades, runtime changes. Example: three 8-second clips with two 0.5-second overlaps yield **23 seconds**, not 24. For the one-minute cut, a fade variant needs a newly compiled timing plan and sufficient handles rather than blindly reusing the 60-second hard-cut math.

### 14.4 Credit/time ledger formulas

Let `q_i` be outputs for attempt i and `c_i` the freshly verified cost per generation (when that is the quote unit):

    authorized upper bound = Σ(q_i × c_i), plus separately approved edit/upscale operations
    total-batch-quote mode uses that batch total directly, not multiplied again
    available-to-authorize = approved story cap − confirmed spend − reserved/uncertain upper bounds

If eight q1 video takes share a verified cost C, the first pass is 8C. An explicitly permitted three additional q1 takes has an upper bound 11C total; this is a symbolic bound, not a claim of actual charges or an authorization granted by this document. Mixed models/lengths use their own quotes; failed/unknown attempts remain separately accounted for until attributable settlement.

Time accounting separates active UI work, remote render latency, local media work, review and paused/quota/authorization waits. Measure p50/p95 at relevant stages; do not label a 30-second preparation stall as render time. Low UI latency is an optimization target only after semantic verification and journaling remain correct.

## 15. Open decisions and implementation start criteria

Defaults above allow work to start without guessing artistic preferences, but confirm these at story creation:

- actual story/brief, target duration, aspect/output profiles and spoken language;
- voice/dialogue/narration/music assets and permissions;
- how much human review versus configured optional vision assistance is wanted;
- bounded image time/candidate cap and video credit/retake cap;
- exact zero-cost image model(s) and runtime eligibility for 8/10-second clips;
- native feature entitlement, desired offline/native scene workflow and output destination/privacy.

Before implementation begins, reconcile the live revision with this plan, choose work-package scope, retain the existing plan/evidence, and record acceptance gates. Before any real generation, obtain stage/attempt authorization against the implemented verified policy.

No source changes, installs, story generation, credit spend, commits or pushes are authorized by this planning artifact alone. Completion of the later implementation means real artifacts and test output satisfy the gates—not that every paragraph of this plan has been turned into a stub.

## Sources

[1] https://support.google.com/flow/answer/16526234?ms=pt%3A2232%3Bs%3A954%3Bvp%3A9 — Manage your Google Flow credits - Computer - Google Flow Help
[2] https://support.google.com/flow/answer/16353333?co=GENIE.Platform%3DDesktop&hl=en — Get started with Google Flow - Computer - Google Flow Help
[3] https://support.google.com/flow/answer/16353334?co=GENIE.Platform%3DDesktop&hl=en-GB — Create videos in Google Flow - Computer - Google Flow Help
[4] https://playwright.dev/docs/locators — Locators | Playwright
[5] https://playwright.dev/docs/api/class-browsertype — BrowserType | Playwright
[6] https://www.ffmpeg.org/ffmpeg-filters.html — FFmpeg Filters Documentation
[7] https://support.google.com/flow/answer/16352836?hl=en — Learn about Google Flow models & supported features - Google Flow Help
[8] https://support.google.com/flow/answer/16935308?co=GENIE.Platform%3DDesktop&hl=en — Manage your Google Flow projects, assets & collections - Computer - Google Flow Help
[9] https://ffmpeg.org/ffmpeg-formats.html — FFmpeg Formats Documentation
[10] https://ffmpeg.org/ffprobe.html — ffprobe Documentation
[11] https://support.google.com/flow/answer/16935718?co=Desktop&hl=en — Edit videos & build scenes in Google Flow - Computer - Google Flow Help
[12] https://support.google.com/flow/answer/16353334?co=GENIE.Platform%3DDesktop&hl=en — Create videos in Google Flow - Computer - Google Flow Help
