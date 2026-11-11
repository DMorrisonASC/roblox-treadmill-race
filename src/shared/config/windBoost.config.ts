/**
 * The `windBoost` trail's own settings: what it is called in the place, and how big it draws.
 *
 * ## Why this file exists (item 177)
 *
 * Every ball effect used to take its size from one `VFX_SCALE_MULTIPLIER` in `tuning.ts`. That is one number for three
 * effects, so "make the hit burst legible" resized both trails as a side effect — and the value was left alone twice for
 * exactly that reason. Item 101 introduced the shared number to stop *two copies of one effect* drifting apart; this splits
 * it because the three effects are not copies of each other.
 *
 * ## The contract with this number, in one sentence
 *
 * **`SCALE_MULTIPLIER` multiplies every stud-valued property of the cloned `windBoost` asset after the ball's own ratio
 * `ballRadius / BASE_BALL_RADIUS`, so the reference length is `BASE_BALL_RADIUS` (0.5 studs) — the radius the whole VFX pack
 * was drawn against — and `1.0` means "the authored asset mapped exactly onto a 0.5-stud-radius ball", not "authored size
 * on screen".**
 *
 * Worked at a 20-stud ball: radius `10`, so `10 / 0.5 = 20` design radii, and at `0.1` the clone draws at **2.0x** the
 * authored geometry.
 *
 * `BASE_BALL_RADIUS` deliberately stays in `tuning.ts`: it is the divisor every ball effect shares, so moving a copy of it
 * into each config would let the three disagree about what a design radius is. Only the multiplier — the part a designer
 * actually retunes per effect — is local.
 */

/**
 * The asset's name in `ReplicatedStorage`, searched recursively. **An identity, not a `Placeholder.`** — it is the name the
 * Studio asset is authored under, and renaming it here renames nothing.
 *
 * It moved out of the controller because this file is now the effect's only home: a reader asking "what is this effect and
 * how big is it" should not have to open a 300-line `@Controller` to find the second half of the answer.
 */
export const WIND_BOOST_ASSET_NAME = "windBoost";

/**
 * **Placeholder.** The effect's own scale multiplier. `0.1` reproduces the size this effect drew before the split, so
 * nothing moved in this round.
 *
 * **This number is not comparable with the other effects' numbers by eye.** It multiplies the *authored clone* after the
 * per-ball ratio, so it is meaningful only together with `BASE_BALL_RADIUS`; the hit burst's number passes through the same
 * formula but arrives from a radius the server sends, and the motion blur's is relative to nothing but the asset itself.
 */
export const WIND_BOOST_SCALE_MULTIPLIER = 0.1;

/**
 * **Placeholder.** The trail's heading, in **degrees clockwise-positive about the effect's own up axis**, measured from the
 * belt-ward direction the shared rule gives it. `0` means "pointing at the belt's start", which is what ships.
 *
 * ## What this number is, and what it is not
 *
 * It is a **heading**, not a correction: it says how far off belt-ward this effect should point, not how wrong the asset's
 * authored rotation is. `vfxFrameFor` builds the frame as "belt-ward forward, asset's up" and never consults the asset's own
 * yaw, so a Studio rotation of the trail asset about its vertical axis is discarded by design (item 176). This is the lever
 * that replaces it.
 *
 * ## The four headings worth trying first
 *
 * `0` — home, the shipped value. `180` — pointing away from home, toward the elimination edge. `90` and `-90` — across the
 * belt. Anything else is unlikely to read as deliberate at a belt camera. Positive turns the frame's `LookVector` from `-Z`
 * toward `-X` (a right turn about `+Y` by the engine's right-hand rule), so on a belt whose start is `+Z`, `+90` points the
 * effect across one way and `-90` across the other.
 *
 * **Relative to the ball, not the camera.** The trails are re-posed every frame from the ball's position, so this number is
 * the only thing that can make one trail face differently from another — and changing it changes nothing else, because each
 * effect reads its own.
 */
export const WIND_BOOST_HEADING_OFFSET_DEGREES = -90;
