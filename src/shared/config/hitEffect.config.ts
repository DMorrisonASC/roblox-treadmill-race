/**
 * The ball-ball hit burst's own settings: what it is called in the place, and how big it draws.
 *
 * ## Why the burst has a tuner of its own (item 177)
 *
 * It draws where two balls met, so it is the effect a designer is most likely to want larger — and until this round its size
 * was welded to the two trails' by one shared `VFX_SCALE_MULTIPLIER`. Enlarging the burst moved both trails; the value was
 * left alone instead. Three effects, three numbers, and each config states its own reference.
 *
 * ## What this number is relative to (rewritten in item 179)
 *
 * **`SCALE_MULTIPLIER` multiplies the burst's particle size ramp, after the contact's own ratio
 * `contactRadius / BASE_BALL_RADIUS` — so its reference length is `BASE_BALL_RADIUS` (0.5 studs), and `1.0` means "the
 * authored particle sizes, mapped onto the ball".** Worked at a 20-stud ball: `10 / 0.5 = 20` design radii, so at `1.0` the
 * particles run `0.5 x 20 = 10` studs at birth to `3.22 x 20 = 64.4` at death — proportionally exactly what the asset author
 * drew against a 1-stud ball.
 *
 * **It no longer scales the clone's whole tree, and that is a correction rather than a retune.** Item 176 passed this number
 * to `scaleEffect`, which multiplies the root `Size`, every `Attachment.Position`, each emitter's `Speed` and its
 * `Acceleration` — while the controller then *replaced* each emitter's `Size` with a fixed ramp. The only property that makes
 * a burst visible was the one never scaled; everything that positions and launches it was. At `100` (a designer's reasonable
 * response to an invisible burst) that threw the emitter attachment hundreds of studs from the contact and launched its
 * particles at thousands of studs per second: `[HitEffect] burst … radius=10 scale=2000` with nothing on screen. The number
 * now scales the particles, which is the thing a burst reads by.
 *
 * **What still differs from the trails is where the radius comes from, not what it means.** A trail reads `ball.Size` from a
 * live body; the burst is drawn by a client that never sees the bodies, so the server sends the **larger** body's radius in
 * the `HitEffect` payload. Same divisor, same meaning.
 *
 * `BASE_BALL_RADIUS` stays in `tuning.ts` as the shared divisor; only the multiplier is per effect.
 */

/** The asset's name in `ReplicatedStorage`, searched recursively. **An identity, not a `Placeholder.`** */
export const HIT_EFFECT_ASSET_NAME = "hitEffect";

/**
 * **Placeholder.** The effect's own particle-size multiplier; `1.0` = authored sizes mapped onto the ball.
 *
 * `0.5` and `2` are the useful neighbours — quarter-size and four-times-size particles, `5..32` and `20..129` studs at a
 * 20-stud ball. Above about `31` the death keypoint saturates, because `ParticleEmitter.Size` is capped at 100 studs.
 *
 * The value before item 179 was `0.1`, which reproduced the size the burst drew when this number still scaled the whole
 * clone; that path put the emitter attachment and its ejection speed out of view, so `0.1` and `100` both drew nothing and the
 * number was never really in effect. It is `1.0` now because that is the one value with a definition that does not depend on
 * an asset anyone has to guess at.
 */
export const HIT_EFFECT_SCALE_MULTIPLIER = 1;
