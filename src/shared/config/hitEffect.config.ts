/**
 * The ball-ball hit burst's own settings: what it is called in the place, and how big it draws.
 *
 * ## Why the burst has a tuner of its own (item 177)
 *
 * It draws where two balls met, so it is the effect a designer is most likely to want larger — and until this round its size
 * was welded to the two trails' by one shared `VFX_SCALE_MULTIPLIER`. Enlarging the burst moved both trails; the value was
 * left alone instead. Three effects, three numbers, and each config states its own reference.
 *
 * ## What this number is relative to — and the distinction that matters
 *
 * **`SCALE_MULTIPLIER` multiplies every stud-valued property of the cloned `hitEffect` asset after the contact's own ratio
 * `contactRadius / BASE_BALL_RADIUS`, so its reference length is `BASE_BALL_RADIUS` (0.5 studs) exactly as the trails' is.**
 * Worked at a 20-stud ball: `10 / 0.5 = 20` design radii, and at `0.1` the clone draws at **2.0x** authored.
 *
 * **What differs from the trails is where the radius comes from, not what it means.** A trail reads `ball.Size` from a live
 * body it is attached to; the burst is drawn by a client that never sees the two bodies, so the server sends the **larger**
 * body's radius in the `HitEffect` remote payload and the client scales from that. So the same number produces the same
 * multiple of authored size in both — and a reader who assumes the burst's number is "bigger units" because its radius
 * arrives over the wire will be wrong.
 *
 * `BASE_BALL_RADIUS` stays in `tuning.ts` as the shared divisor; only the multiplier is per effect.
 */

/** The asset's name in `ReplicatedStorage`, searched recursively. **An identity, not a `Placeholder.`** */
export const HIT_EFFECT_ASSET_NAME = "hitEffect";

/**
 * **Placeholder.** The effect's own scale multiplier. `0.1` reproduces the size the burst drew before the split.
 *
 * Unlike the two trails, this one is applied to a clone whose per-emitter `Size` ramp is then **overwritten** by the
 * designed particle growth — a separate property that composes with the clone's scale rather than replacing it. That is why
 * `scaleEffect` must be called before that loop; see `hit-effect-controller`.
 */
export const HIT_EFFECT_SCALE_MULTIPLIER = 0.1;
