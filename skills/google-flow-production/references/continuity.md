# Reference and Continuity Review

## Build the smallest useful reference set

Use an approved character, product, and location description before generating more assets. Keep identity, wardrobe, palette, lighting direction, product proportions, labels, and scene layout stable across shots. Prefer an authorized real product photograph when the product must be accurate. Never replace unavailable factual product views with invented features.

For an original synthetic character, establish one accepted portrait before attempting another angle. Add views only if a shot needs them; compare identity and wardrobe visually. Multiple generated images do not prove the same identity. A Flow character can be reusable, but native character creation and a collection of image references are different mechanisms. Do not claim training, a multi-view identity embedding, or a permanent likeness lock without actual support.

Use a clean location reference when a background matters. Avoid extra people in environment/style images. A face, product, and setting can consume the available mention slots; prioritize the references most important to the shot rather than silently dropping one.

## Pick one conditioning mode per shot

Ingredients are suitable when the subject and product need flexible placement. Discover actual project names with `flow_list_mention_options`; select exact returned names. Record uploaded reference files separately from project mentions. Treat uploaded files as pending until attachment read-back verifies them.

Frames are suitable when exact opening or closing composition matters. Build a reviewed start image with the required subject and product already composed together. Use an end image only when it is consistent with that start and the desired action. Do not attach separate Ingredients in Frames mode. A prior strongest frame can anchor a new shot, but only as the single chosen start frame, not as an additional conflicting image.

### Multi-Clip Continuity Strategy

For multi-clip sequences (such as a 3-shot fight or narrative sequence):
1. **Clip 01 (Ingredients mode):** Set up characters and setting using `@` mentions (`ingredients`).
2. **Continuation Frame Extraction:** Once Clip 01 is rendered and downloaded, extract its true final decodable video frame using `scripts/assemble-video.mjs` (or exact frame index `select=eq(n,total-1)`).
3. **Clip 02 (Frames mode):** Use the extracted Clip 01 last frame as `start_frame`. Do NOT supply `ingredients` or uploaded `reference_images` in this request.
4. **Clip 03 (Frames mode):** Extract Clip 02's final frame and attach as `start_frame` to continue the action seamlessly.

## Review before confirmation

Check every expected reference, not merely a nonempty attachment list:

- Correct account and project, exact selected model, ratio, duration, quality, and quantity.
- All required references present; no unexpected references or stale chips.
- Correct role for each image: ingredient versus start/end slot.
- Face identity, wardrobe, product geometry, logo placement, lighting, and environment match the approved continuity description.
- Motion is feasible from the selected framing; hands and product are not occluded at the critical moment.

Missing, ambiguous, wrongly placed, or failed references block confirmation. If discovery or navigation changes the prepared composer, prepare the shot again. Do not repair readiness by editing reported verification values.

## Preserve evidence

Record the source asset, local path, intended role, rights, selected project name/identity, and reviewed shot in the asset manifest. Keep original verified downloads; descriptive working copies may be renamed without overwriting them. If the user requests a recurring character, reuse only explicitly approved references; do not assume a new campaign should cast a new person or reuse the old one.
