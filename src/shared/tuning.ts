/**
 * Gameplay tuning that is deliberately **not** a Studio attribute.
 *
 * `attributes.ts` holds the per-part knobs a designer retunes without a rebuild: how fast a belt
 * drags, how often a spawner fires, where the kill plane sits. That file's contract is "tag the part,
 * the service writes the values". This file is the opposite case: values that are properties of the
 * *game* rather than of any one part, where a per-part attribute would be a way to make two identical
 * belts behave differently for no reason a player could perceive.
 *
 * The split matters because the two have different costs. An attribute is retunable in the Properties
 * panel but has to be derived, logged, type-checked and migrated; a constant is a rebuild but is
 * visible in a diff and impossible to half-configure. The bounce and the textures are the second
 * kind: they must look the same on every belt, so there is nothing for a per-part value to express.
 */

/**
 * Belt surface texture.
 *
 * **Not verified.** The asset id came from the user and has not been checked for availability,
 * tiling, or being an image at all. Nothing in code can detect a bad asset: a missing id renders as
 * a plain surface and a non-tiling image renders as visible seams. If it looks wrong, change the id
 * here — the code around it is asset-agnostic.
 */
export const BELT_TEXTURE_ASSET = "rbxassetid://6691394";

/**
 * **Placeholder.** Studs covered by one repeat of the belt texture.
 *
 * Arithmetic: the observed belt is 56 × 1 × 33. At 4 studs per tile that is 14 repeats along its
 * length and 8 across, which is enough repeats that motion is visible at `BeltSpeed = 10` (2.5 tiles
 * per second pass a fixed point) without the pattern becoming a shimmer. Halving it would double the
 * apparent speed and put ~29 repeats on a 56-stud belt, where the individual tile stops being
 * legible; doubling it would leave only 7 repeats and make the surface read as a few large panels
 * sliding rather than as a continuous belt.
 */
export const BELT_TEXTURE_STUDS_PER_TILE = 4;

/**
 * **Placeholder.** Sign applied to `OffsetStudsU` per second, × `BeltSpeed`.
 *
 * `-1` is the choice being shipped: on a part's `Top` face the texture's `U` axis runs along the
 * part's local +X, which is this belt's `+RightVector` and therefore its drag direction. Increasing
 * `OffsetStudsU` shifts the *sampled* texture the other way, so a **negative** rate is what makes the
 * pattern appear to travel toward `+RightVector` — the direction the surface is dragging. **This sign
 * is inferred, not verified.** If a Studio run shows the belt texture moving against the balls, flip
 * this one constant to `1`; nothing else needs to change.
 */
export const BELT_TEXTURE_SCROLL_SIGN = -1;

/**
 * Ball surface texture, applied to all six faces.
 *
 * **Not verified**, same caveat as the belt texture: the id came from the user and has not been
 * checked. A texture whose aspect ratio is very far from square will visibly stretch on faces of a
 * non-cubic shape.
 */
export const BALL_TEXTURE_ASSET = "rbxassetid://12971963723";

/**
 * **Placeholder.** Upper bound of the random per-ball texture offset, in studs.
 *
 * Why randomise at all: two ball-shaped bodies with identical geometry are indistinguishable under
 * rotation, so without an offset every sphere looks like the same sphere. The offset gives each one
 * a different visible feature at its starting point, which makes rolling legible even for a shape
 * whose silhouette does not change.
 *
 * Arithmetic: the tile size on a ball's face is the ball's own face extent, and the placeholder pool
 * is 1–2 studs across, so an offset drawn from `[0, 4)` covers two full tile widths for the largest
 * entry and four for the smallest. That is more than enough to decorrelate neighbours; the exact
 * upper bound barely matters because the phase wraps.
 */
export const BALL_TEXTURE_OFFSET_RANGE = 4;

/**
 * **Placeholder.** The random texture offset range for the ball's `V` axis.
 *
 * A separate `V` offset matters because a random `U` shift alone leaves every ball sharing the same
 * row of the texture — neighbouring balls would look like they are showing the same image, only
 * shifted sideways. Two independent offsets give a random 2D phase.
 */
export const BALL_TEXTURE_OFFSET_RANGE_V = 4;

/**
 * **Placeholder.** Upward impulse applied to a ball that is touching the belt and wins the bounce
 * roll, in studs/second. Purely vertical; no horizontal component is added anywhere.
 *
 * Arithmetic: a body given `v` upward reaches `v² / 2g` before gravity stops it. At the engine's
 * default `Workspace.Gravity` of 196.2, `15² / 392.4 = 0.573` studs. That is a visible hop for a
 * 1–2 stud object without clearing the belt by enough to look like a launch: it interrupts the roll
 * for roughly `2v / g = 0.153` s, then the ball is back on the surface. Doubling it to 30 would give
 * 2.3 studs and a 0.3 s airborne phase, which starts to read as bouncing rather than as an uneven
 * surface. The value is a nudge, not a trajectory: what happens after it is entirely the ball's own
 * physics.
 *
 * **This is the project's one sanctioned physics assist.** It is legitimate because it models a
 * physical property of the object (a real conveyor is not a perfect plane; seams, slats and grit make
 * bodies skip), not an outcome (it never chooses how far, where, or which way a ball ends up). The
 * physically correct alternative is a genuinely uneven collision surface — a mesh with real bumps, or
 * many small welded parts — which would be more faithful and cost both an asset pipeline and far more
 * collision work per ball. A random upward nudge buys the same feel for three constants.
 */
export const BELT_BOUNCE_IMPULSE = 15;

/**
 * **Placeholder.** Probability of a bounce per *eligible* check, where an eligible check is one that
 * passed the per-ball cooldown.
 *
 * The number only means anything in combination with the cooldown below: `Touched` fires whenever
 * contact state changes, and a ball resting on the belt re-fires it on essentially every physics step,
 * so per-touch probability alone would be a rate in disguise. With a 1 s cooldown the effective rate
 * is at most one roll per second per ball, and 5% therefore means roughly one hop every twenty seconds
 * per ball. Raising it to 1.0 would make every ball hop on a metronome, which reads as a mechanism
 * rather than as an imperfect surface.
 */
export const BELT_BOUNCE_CHANCE = 0.05;

/**
 * **Placeholder.** Minimum seconds between bounce rolls for one ball.
 *
 * **Not optional.** Without it, `BELT_BOUNCE_CHANCE` is evaluated per physics step — at 60 Hz a 5%
 * chance fires about three times a second per ball, and every ball on the belt becomes a popcorn
 * machine. The cooldown converts "chance per touch" into "chance per second", which is the thing that
 * was actually wanted. One second is long relative to a 0.15 s hop, so a bounce is a discrete event
 * rather than a sustained vibration.
 */
export const BELT_BOUNCE_COOLDOWN = 1;
