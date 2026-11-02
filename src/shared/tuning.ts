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
 * **Placeholder.** Material of the invisible moving collider — i.e. the friction half of the
 * ball/surface pair.
 *
 * `Rubber` is the shipped choice for this round, and it is the **only** thing this round changes about
 * friction: no `CustomPhysicalProperties`, no `FrictionWeight`, on either the slab or the ball. That
 * restriction is the point — a single material swap is attributable, whereas material *and* weights
 * would not be.
 *
 * Arithmetic, with the caveat below: the engine combines two parts' friction by a weight-averaged
 * blend, and both parts are at the default `FrictionWeight = 1`. Commonly cited defaults are
 * `SmoothPlastic ≈ 0.2`, `Plastic ≈ 0.3`, `Rubber ≈ 0.8`, giving:
 *  - before: `(0.2 + 0.3) / 2 = 0.25`
 *  - after:  `(0.8 + 0.3) / 2 = 0.55`
 *
 * **The per-material friction values are not documented in the engine API reference.** The
 * `PhysicalProperties` page documents that `Friction` exists and that material sets its defaults, but
 * publishes no table of those defaults; 0.2/0.3/0.8 are the widely repeated figures and should be
 * treated as approximate. The *ratio* is what matters for the experiment: Rubber should roughly
 * double the grip, and if it does not, the material is not the lever and the next step is
 * `CustomPhysicalProperties` rather than a different material.
 *
 * `Rubber` at ~0.8 is above the range a real treadmill belt runs at (belt-to-sole is about 0.4–0.6).
 * The milder alternative, if Rubber reads as too grippy or the ball starts to judder, is
 * `Enum.Material.Plastic` (≈0.3), which would blend to `(0.3 + 0.3) / 2 = 0.3` — closer to the low
 * end of the real range and only slightly above the current 0.25, so it is a small step rather than a
 * step back. `SmoothPlastic` is not offered as the fallback because it is what this round replaced.
 */
export const BELT_SURFACE_MATERIAL = Enum.Material.Rubber;

/**
 * **Placeholder.** Whether the belt's imperfect-surface bounce assist is active.
 *
 * **Set to `false` deliberately, for this round only.** The bounce applies a vertical impulse that
 * lifts a ball off the surface, which interrupts the transfer of tangential momentum into the ball:
 * every hop is a window where friction does nothing. That makes it a confound — the belt material is
 * also being changed this round, and watching both change at once would make it impossible to say
 * which one produced what. Off, the only variable is friction.
 *
 * This is a *gate*, not a deletion. `BELT_BOUNCE_IMPULSE`, `BELT_BOUNCE_CHANCE` and
 * `BELT_BOUNCE_COOLDOWN` are all still here, the `Touched` connection is still made, and
 * `rollBounce` still exists — it returns early. Set this to `true` and rebuild to restore exactly the
 * previous behaviour with no other change, which is the whole reason the gate is a boolean read at the
 * top of the handler rather than a commented-out connection.
 *
 * Why the gate is checked first, before the tag test and the cooldown prune: if the assist is off, the
 * handler should cost one boolean read and nothing else. Putting it after the prune would still scan
 * the cooldown map on every contact of every body for a feature that is disabled.
 */
export const BELT_BOUNCE_ENABLED = false;

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

/**
 * **Placeholder.** Thickness of the invisible moving collider that gives balls a real surface, in
 * studs.
 *
 * Thin enough to be invisible under a 1-stud ball and too thin to read as a second floor if a ball
 * ever falls past it; thick enough not to tunnel. Arithmetic: at `BeltSpeed = 10` and the engine's
 * 60 Hz step the slab advances `10 / 60 = 0.167` studs per frame, so a 0.2-stud slab always overlaps
 * its previous position and a resting ball can never fall through the gap. At `BeltSpeed = 60` the
 * step becomes 1 stud and a 0.2 slab *would* tunnel; that is the number to raise if the belt speed
 * ever goes far above 10.
 */
export const BELT_SURFACE_THICKNESS = 0.1;

/**
 * **Placeholder.** How far the moving collider is allowed to overhang the belt's own footprint, in
 * studs.
 *
 * **This replaced a `BELT_SURFACE_LENGTH_MULTIPLIER = 2` that was wrong.** The first version made the
 * slab twice the belt's length so that a full belt-length of travel never uncovered the belt. It
 * achieved that and produced a `112 x 0.2 x 33` invisible collidable floor on a `56 x 1 x 33` belt —
 * 28 studs of invisible ground past each end that a ball can rest and ride on, which is a worse bug
 * than the one it solved. A Studio run showed the size directly in the `surface created` line.
 *
 * The fix is to bound the *travel* instead of lengthening the slab. With a slab of
 * `belt.Length + LIP` studs that starts `LIP/2` behind the belt's centre and travels `LIP` studs,
 * the belt footprint is covered at every point of the pass, and the slab never extends more than
 * `LIP` beyond either end. Derivation, with belt half-length `h` and slab half-length `(L + LIP)/2`:
 * at the start of the pass the slab spans `[-h - LIP, h]`, so it covers the belt and overhangs
 * `LIP` at the back; at the end it spans `[-h, h + LIP]`, so it covers the belt and overhangs `LIP`
 * at the front. Coverage is continuous because both extremes contain `[-h, h]`.
 *
 * `LIP` is a straight trade: larger means less frequent resets (one per `LIP / BeltSpeed` seconds) and
 * more invisible lip past the belt. At 1 stud and `BeltSpeed = 10` the reset fires every 0.1 s, which
 * is cheap because a reset preserves the slab's velocity and only rewinds its position — the ball
 * sees an unchanged flat surface moving at an unchanged speed, so nothing it experiences changes.
 */
export const BELT_SURFACE_LIP = 1;

/**
 * **Placeholder.** Remaining travel, in studs, at which the moving collider is rewound to the start of
 * its pass.
 *
 * The reset has to fire *before* the constraint reaches `UpperLimit`, because once it is against the
 * limit the motor is pushing into a wall: the slab stops, and every ball on it decelerates as though
 * the belt had stopped. Firing 0.1 studs early costs 0.01 s of travel at `BeltSpeed = 10` and
 * guarantees the motor never fights the limit. This is a distance, not a fraction, so it stays
 * correct if `BELT_SURFACE_LIP` is retuned.
 */
export const BELT_SURFACE_RESET_THRESHOLD = 0.1;

/**
 * **Placeholder.** `PrismaticConstraint.MotorMaxForce` for the moving collider, in the engine's force
 * units.
 *
 * Arithmetic: a 0.367-mass ball (measured, `Plastic` at `Size = (1,1,1)`) resting on the slab presses
 * down with `0.367 x 196.2 = 72`. The friction it can apply back along the belt is at most
 * `μ_eff x N`, and `μ_eff` measured from the round-1 log is `<= 0.22`, so the worst-case drag the
 * motor must overcome is about `16`. 100000 is therefore roughly 6000x the load and cannot be the
 * limiting factor; the constraint will hold speed unless something is badly wrong elsewhere.
 *
 * It is deliberately not tighter. A force chosen to just exceed the load would make the slab sag
 * briefly under every impulse (a ball landing, the reset) and would couple the surface's speed to how
 * many bodies are on it, which is the sort of hidden feedback that is miserable to debug. The cost of
 * a huge number is that the slab behaves as though welded to a rail — which is exactly what this
 * mechanism wants, since it is not supposed to be a physical object but a moving ground plane. Tune
 * down only if the surface reads as magnetically rigid when something collides with it edge-on.
 */
export const BELT_SURFACE_MOTOR_MAX_FORCE = 100000;

/**
 * **Placeholder.** `PrismaticConstraint.MotorMaxAcceleration` for the moving collider, studs/s².
 *
 * Arithmetic: reaching `BeltSpeed = 10` from rest takes `10 / 10000 = 0.001` s, which is under one
 * physics step, so the slab is at speed from its first frame. The number exists to be *finite*
 * rather than infinite: an unbounded acceleration makes the constraint's solver impulse unbounded on
 * the first step, which is what produces the classic "part launched on spawn" artefact when a
 * constrained body starts inside another.
 */
export const BELT_SURFACE_MOTOR_MAX_ACCELERATION = 10000;

/**
 * **Placeholder.** Whether a ball-vs-ball collision adds angular velocity to the ball, producing
 * occasional backspin and a brief backward scoot against the belt.
 *
 * A single switch so the whole mechanic can be turned off without deleting the handler, the constants,
 * or the `Touched` connection it installs.
 */
export const BALL_BACKSPIN_ENABLED = true;

/**
 * **Placeholder.** How far ahead of the belt surface the ball's contact point is driven, in studs per
 * second, when a collision applies backspin.
 *
 * ## Why this replaced a rad/s impulse (`BALL_BACKSPIN_IMPULSE = 60`), which was wrong twice over
 *
 * The previous version *added* a fixed `60 rad/s` on every qualifying contact. A Studio log showed two
 * independent failures of that design:
 *
 *  1. **It accumulated without bound.** 20 balls produced **428 impulses**, and the measured
 *     `omega * r` climbed monotonically from `30` to **`56.6`** — a contact point moving 5.6x the belt
 *     speed. The 0.25 s cooldown spaces repeats out; it never stops them, so a ball resting against
 *     another gained another `+60 rad/s` every quarter second for the whole session.
 *  2. **Even one impulse was far too big.** The impulse does not translate into velocity one-for-one.
 *     Adding slip `s` to a rolling ball resolves to `dv = -s / 3.5` for a solid sphere (the `3.5` is
 *     `1 + m*r^2/I` with `I = (2/5)m*r^2`), so a single `60 rad/s` impulse is `s = 30` studs/s of
 *     overspeed and a `-8.6` studs/s kick. The log's exits at `-6.75`, `-7.07` and `-9.45` studs/s are
 *     exactly that, plus accumulation.
 *
 * Against a `u = 10` belt that threw 14 of 18 balls off the **back** edge, most within 0.6 s.
 *
 * ## Why a target rather than an impulse
 *
 * A collision cannot pump energy into a body that is already spinning faster than the collision can
 * justify, so repeated contact should *converge* to a limit, not compound. Targeting the contact-point
 * overspeed makes the operation idempotent: the handler computes the current slip, and adds only
 * enough angular velocity to reach the target — so the second, third and four-hundredth contact in a
 * sustained pile-up are no-ops instead of another full kick. It also puts the knob in physical units
 * (how fast the contact point outruns the belt) rather than in `rad/s`, which is the quantity the
 * effect is actually about.
 *
 * ## The arithmetic of 15
 *
 * `dv = -slip / 3.5`. At `slip = 15` the velocity change is `15 / 3.5 = 4.3` studs/s. From rolling
 * equilibrium on a `u = 10` belt (`v = 2u/7 = 2.86`) that lands the ball at `2.86 - 4.3 = -1.4`
 * studs/s: a slow, clearly visible backward roll, not a launch.
 *
 * Note that the backward motion is **persistent, not brief**, and that is correct physics rather than a
 * bug: once rolling is re-established with excess spin, the contact point is back at belt speed, friction
 * is zero again, and the ball keeps its `-1.4` studs/s until it reaches an edge. There is nothing to
 * stop it. Raising this to `30` would roughly double the backward speed to `-4`; lowering it to `8`
 * gives `-0.5`, a visible hesitation rather than travel.
 */
export const BALL_BACKSPIN_TARGET_SLIP = 15;

/**
 * **Placeholder.** Minimum seconds between backspin impulses on one ball.
 *
 * **Not optional.** `Touched` fires on contact-*state* changes, and a ball wedged against another
 * re-fires it on essentially every physics step. 0.25 s is ~15 physics steps: long enough that a
 * collision does not run the handler repeatedly within one impact.
 *
 * **It is no longer what bounds the effect.** With `BALL_BACKSPIN_TARGET_SLIP` the handler is
 * idempotent — a repeat call finds the slip already at target and does nothing — so the cooldown is now
 * purely a cost control, not a safety limit. The version that added a fixed impulse needed the cooldown
 * to bound accumulation and failed to: 428 impulses still drove `omega*r` from 30 to 56. See the target
 * constant's comment.
 */
export const BALL_BACKSPIN_COOLDOWN = 0.25;
/**
 * **Placeholder.** Whether a ball touching a `TreadmillWall`-tagged part is pushed forward.
 *
 * Single switch so the assist can be turned off without deleting the handler or the constants.
 */
export const WALL_ASSIST_ENABLED = true;

/**
 * **Placeholder.** Forward velocity added per ball-wall contact event, in studs/s.
 *
 * ## This is the same shape as `BALL_BACKSPIN_TARGET_SLIP`, on purpose
 *
 * The wall assist is a copy of the ball-ball backspin handler: one `Touched` connection per ball, a
 * tag filter, a convergent check against a target, and a single velocity write. `applyBackspin` has
 * been the working mechanism for several rounds; the wall spent three rounds on bespoke designs (a
 * cooldown-gated impulse, then a `VectorForce`) and neither produced observable motion. Reusing the
 * proven shape is the decision, and the constant is deliberately the same *kind* of thing: a small
 * per-event nudge that the convergence check bounds, never a rate.
 *
 * ## The arithmetic of 1
 *
 * The per-event delta is `min(1, WALL_ASSIST_TARGET_SPEED - v)`, so from rest a ball needs 8 events to
 * reach the target. How much wall that is depends entirely on how often `Touched` re-fires during
 * sustained contact, and that rate is **not under this code's control**:
 *  - at ~10 events/s (one per physics-decimated contact step) that is `10` studs/s^2, reaching 8 in
 *    `0.8 s` of contact
 *  - at ~60 events/s (one per physics step) it is `60` studs/s^2, reaching 8 in `0.13 s` ? fast enough
 *    to look like the impulse this replaced
 *
 * So `1` is a `Placeholder` in the honest sense: the *outcome* is fixed by the target, but the *rate*
 * is emergent. If the ride to target turns out too sharp, lower this rather than raising the target;
 * the target is the safety bound and the impulse is only the resolution.
 *
 * Contrast with `BALL_BACKSPIN_TARGET_SLIP = 15`: that handler adds the **whole** remaining deficit in
 * one event (`(target - slip) / radius`), so it converges in a single contact. This one deliberately
 * does not, because a linear velocity write is far larger per unit and a single-event jump to
 * `8` studs/s is exactly the "not a push" behaviour the force round was trying to fix.
 */
export const WALL_ASSIST_IMPULSE = 1;

/**
 * **Placeholder.** Forward speed the wall will not push a ball past, in studs/s.
 *
 * **Below `BeltSpeed = 10`, deliberately.** A wall cannot plausibly explain a ball outrunning the
 * surface carrying it, and anything above belt speed would make the wall a motor.
 *
 * This is the constant that makes the assist bounded, and it is what allowed the cooldown to be
 * deleted. The check runs per contact event: once `v >= 8` the handler returns without writing, so a
 * ball pressed against a wall forever produces zero further change. The bound is on the *outcome*, not
 * on the event rate, which is why an unknown `Touched` frequency cannot produce a runaway.
 *
 * History, kept because it explains why the number survived two mechanism changes: it was introduced
 * to bound a per-firing impulse, deleted by the round that tried a constant `VectorForce` (which has no
 * ceiling of its own and would have reached `50` studs/s in ten seconds), and reinstated here because
 * the convergent velocity delta needs exactly the same bound.
 */
export const WALL_ASSIST_TARGET_SPEED = 8;
