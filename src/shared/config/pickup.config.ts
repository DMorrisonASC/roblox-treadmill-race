import { poolBallRadius } from "../shape-pool";
import { PICKUP_SPRITE_STUDS } from "../tuning";
import { effectScaleForRadius } from "../vfx-scale";

/**
 * The pickup's own visual scale, in the same shape item 177 gave the ball effects: **one multiplier, in the effect's own
 * config file, applied through `shared/vfx-scale.ts`.**
 *
 * **`PICKUP_SCALE_MULTIPLIER` is `0.2`, and it scales the SPRITE ONLY (item 190).** The disc is the collider's inscribed
 * circle and takes no multiplier. `pickupDrawRadius` reads this number to derive how far a pad's *picture* reaches, which is
 * what a placement bound has to keep on the belt (item 199).
 *
 * ## Why the pickup needed one at all (item 188)
 *
 * Every pickup visual was sized when a ball was one stud across. At twenty studs the sprite is `2.6 / 20 = 0.13` ball
 * widths — a speck beside the thing it is meant to be collected by — and the footprint disc is a point the ball's *centre*
 * has to land on. Nothing was wrong with the numbers; they simply never joined the per-effect scale work.
 *
 * ## The contract with this number, in one sentence
 *
 * **`PICKUP_SCALE_MULTIPLIER` multiplies the sprite's world size and the footprint disc's diameter after the ball's own
 * ratio `ballRadius / BASE_BALL_RADIUS`, so its reference length is `BASE_BALL_RADIUS` (0.5 studs) and `1.0` means "the
 * authored sprite, scaled to a ball of the design radius".**
 *
 * Worked at a 20-stud ball: radius `10`, so `10 / 0.5 = 20` design radii, and at `0.2` the sprite draws at **4x** its
 * authored size — `2.6 x 4 = 10.4` studs, or about half a ball's width. At `1.0` it would draw at `20x` — a `52`-stud
 * sprite, two and a half ball-widths, which is not a pickup any more.
 *
 * **What reproduces the old size:** `0.05` — `2.6 x 1 = 2.6` studs, exactly what shipped. It is *not* the shipped value
 * because reproducing a size that was invisible beside a 20-stud ball is the bug, not the target.
 */

/**
 * **Placeholder.** The multiplier applied to the pickup's **sprite** — and only the sprite (item 190).
 *
 * ## What changed, and why the disc is not in this number
 *
 * This used to multiply the painted footprint disc as well, which made the picture a promise the collider could not keep: at
 * a 20-stud pad and a scale of `4` the disc was drawn **80 studs** across while the collider was `20`, so a ball visibly
 * inside the ring never collected. The disc is now **the collider's inscribed circle** (`pickupDiscDiameter`, no multiplier at
 * all), because a circle is a *statement about reach* and a statement cannot be tuned independently of the thing it
 * describes.
 *
 * **A sprite is a different kind of thing.** It is a picture of what is on the pad — an icon, not a boundary — so it may be
 * authored at whatever size reads well, and it must be at or below the disc so it never promises more than the disc already
 * does. That is the whole remaining job of this number.
 *
 * ## The contract with this number, in one sentence
 *
 * **`PICKUP_SCALE_MULTIPLIER` multiplies the sprite's authored world size after the ball's own ratio
 * `ballRadius / BASE_BALL_RADIUS`, so its reference length is `BASE_BALL_RADIUS` (0.5 studs) and `1.0` means "the authored
 * sprite, scaled to a ball of the design radius".**
 *
 * Worked at a 20-stud ball: radius `10`, so `10 / 0.5 = 20` design radii, and at `0.2` the sprite draws at **4x** authored —
 * `2.6 x 4 = 10.4` studs, which sits inside a `20`-stud disc.
 */

/**
 * **Placeholder.** The multiplier applied to the pickup **sprite**. `0.2` draws it at `4x` authored on a 20-stud ball —
 * `10.4` studs, a little over half the disc's diameter, which reads as an icon inside the target rather than as a second
 * target.
 *
 * `0.4` would draw it at `20.8` studs — larger than the disc, which is the contradiction this round removed. `0.05` is
 * "exactly as before the per-effect scaling" (`2.6` studs, a speck beside a 20-stud ball).
 */
export const PICKUP_SCALE_MULTIPLIER = 0.2;

/**
 * The painted footprint disc's diameter, in studs: **the largest circle that fits inside the pad's cross-section, with no
 * multiplier applied** (item 190).
 *
 * ## Why this is `min(X, Z)` and nothing else
 *
 * The disc is the only visual that makes a claim about *reach* — "put the ball's centre in here and it collects". A circle
 * inscribed in the pad's square footprint is the largest circle every point of which is inside the collider, so it is the
 * most generous truthful picture. Anything larger overhangs the box (a ball inside the paint that does not collect — the
 * reported bug), and anything smaller understates it.
 *
 * **It therefore cannot be scaled by `PICKUP_SCALE_MULTIPLIER`.** That number is a look, and a look must not change what the
 * player is told about where the boundary is. The two are deliberately uncoupled: the disc follows `PICKUP_SIZE`, the sprite
 * follows the multiplier, and the sprite is kept at or below the disc so the picture never contradicts the promise.
 *
 * `min` rather than `PICKUP_SIZE.X` because the pad is a box, not a square: a designer who makes it `20 x 1 x 12` should get a
 * `12`-stud circle, not one that overhangs the narrow axis.
 *
 * ## What this does **not** fix, stated so nobody "fixes" it by shrinking the disc (item 199)
 *
 * The disc is still **bigger than the collider whenever the pad is not square**: on a `20 x 1 x 12` pad the circle is `12`
 * across while the box is `20` on its long axis, so a ball whose centre is inside the paint can be outside the collection
 * volume along that axis. That is deliberate and out of scope: the designer chose to keep the large disc and constrain
 * **placement** instead, so `pickupBounds` subtracts the largest *drawn* radius (`pickupDrawRadius`) and no pad's picture
 * crosses the belt's edge. **Do not make the visual consistent by shrinking the disc** — the collider is the gameplay value,
 * and a disc smaller than the box would understate the reach a ball actually has.
 *
 * Pure, so the equality with the collider is asserted in the spec rather than trusted — see
 * `pickup.config.spec.ts`. The alternative to a function here would be the same `math.min(padSize.X, padSize.Z)` written at
 * the call site, which is a rule that a later reader can only check by eye.
 */
export function pickupDiscDiameter(padSize: Vector3): number {
	return math.min(padSize.X, padSize.Z);
}

/**
 * **The largest radius a pickup actually draws**, in studs — the number a placement bound has to subtract (item 199).
 *
 * ## Why this exists, given the disc already equals the collider
 *
 * It does not overhang *today*: `pickupDiscDiameter` is the pad's inscribed circle, so the disc's radius is exactly the pad's
 * half-width, and the sprite is smaller than both. A bound derived from `padSize / 2` is therefore correct by accident of two
 * numbers happening to agree.
 *
 * **The sprite is the part that can move.** Its drawn width is
 * `PICKUP_SPRITE_STUDS x effectScaleForRadius(poolBallRadius(), PICKUP_SCALE_MULTIPLIER)`, which today is
 * `2.6 x 4 = 10.4` studs — but `PICKUP_SCALE_MULTIPLIER` is a *look* that a designer retunes by eye, and one step up makes the
 * sprite wider than the pad with no code change anywhere. The bound would then silently place a picture past the belt's edge,
 * which is the exact report this function exists to prevent. Reading the largest of the three radii makes that retune safe
 * instead of silent.
 *
 * ## The three things measured, and which wins
 *
 * - **the pad's own footprint**, `min(X, Z) / 2` — the narrow axis, because that is the axis a circle has to fit;
 * - **the disc**, `pickupDiscDiameter / 2` — equal to the pad radius by construction (item 190), listed separately so the
 *   equality is stated rather than assumed;
 * - **the sprite**, `PICKUP_SPRITE_STUDS x scale / 2` — the only one that is free to grow.
 *
 * Pure, and asserted in `pickup.config.spec.ts` against a literal pad and a literal multiplier, including the case that breaks
 * the accident: a multiplier large enough for the sprite to exceed the pad.
 */
export function pickupDrawRadius(padSize: Vector3, scaleMultiplier: number): number {
	const padRadius = math.min(padSize.X, padSize.Z) / 2;
	const discRadius = pickupDiscDiameter(padSize) / 2;
	const spriteRadius = (PICKUP_SPRITE_STUDS * effectScaleForRadius(poolBallRadius(), scaleMultiplier)) / 2;

	return math.max(padRadius, math.max(discRadius, spriteRadius));
}
