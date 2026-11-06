import { DEFAULT_BELT_SPEED } from "./attributes";

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
 * **Placeholder.** Seconds between round ticks.
 *
 * This is the cadence of `RoundService.onTick` and of the elimination check, and it is the API future
 * powers will fire against — see the note in `round-service.ts`. One second is deliberately coarse:
 * a power that lasts "one tick" is legible to a player, and a per-frame callback would invite powers
 * that depend on frame timing, which then behave differently on a laggy client.
 *
 * Kept separate from the belt ramp, which needs ~60 Hz to look continuous. Conflating them would
 * either make the belt step in three visible jumps or run powers at 60 Hz.
 */
export const TICK_INTERVAL_SECONDS = 1;

/**
 * **Placeholder.** Length of the `Waiting` phase, in seconds.
 *
 * Balls spawn at the moment `Waiting` begins and rest on a stationary belt for this long, so every
 * contestant has settled before the belt moves. Fifteen seconds is far longer than the ~1 s a body
 * needs to fall and settle, and that is deliberate: `Waiting` is the lobby window a later pick prompt
 * uses, so it is sized for a person reading a prompt and choosing rather than for physics. A round
 * whose players have all chosen can leave early once that early-exit exists; until then the timer is
 * the only exit.
 */
export const WAITING_SECONDS = 15;

/**
 * **Placeholder.** Seconds for the belt to reach full speed once `Playing` begins.
 *
 * Linear, not eased. A linear ramp means the acceleration is constant and identical for every ball
 * regardless of when it lands, which is the property that makes a round reproducible; an eased ramp
 * would make the first second slower than the last and reward a ball that happened to spawn late.
 *
 * Three seconds is roughly the time the belt takes to carry a ball across its width, so the ramp
 * occupies the same window as the first meaningful movement rather than being a separate phase.
 */
export const BELT_RAMP_SECONDS = 3;

/**
 * **Placeholder.** Seconds of no eliminations before `Playing` says so, once, in the log.
 *
 * ## What this replaces, and what it deliberately is not
 *
 * There used to be a `PLAYING_CAP_SECONDS` (60 s) that **ended** the round on expiry and awarded the win
 * to whoever was furthest along. It is deleted: in the only runs that exercised it, it fired while a
 * competitor was still travelling and named a winner that the race did not support. A time limit that
 * invents a result is worse than no time limit.
 *
 * The consequence is that `Playing` can now run forever — a competitor wedged at the belt's edge, moving
 * backwards, or parked against a wall keeps the round alive. That is accepted and handled by hand in
 * Studio. This constant does **not** end anything: it produces one line naming the state so a stuck round
 * is visible in the log instead of looking like a server that stopped.
 *
 * 60 s is the same number the cap used, which is intentional and not laziness: it is the point at which
 * "no elimination" stops looking like a slow heat and starts looking like a stuck one, and keeping it
 * means logs from before and after the change are comparable on the same axis.
 *
 * **The clock behind it resets on every elimination**, so the line reports 60 s of *nothing happening*
 * rather than 60 s of wall time. A round shedding a competitor every ten seconds never warns.
 */
export const ROUND_IDLE_WARN_SECONDS = 60;

/**
 * **Placeholder.** Seconds the `PostGame` phase holds before returning to `Intermission`.
 *
 * The belt is stopped and the surviving balls stay where they are, so the player can see what
 * finished rather than watching the result vanish in the same frame it is logged. The round's own
 * numbers are frozen during this window (`getElapsedSeconds` stops counting), so anything reading the
 * result sees the value the round ended with, not a value drifting afterwards.
 *
 * This is the window a later results screen renders into. It is blank today by design: the phase exists
 * and holds for its five seconds with nothing in it, which is what makes it observable as a state
 * rather than as a gap between two other states.
 */
export const POST_GAME_SECONDS = 5;

/**
 * **Placeholder.** Seconds `Intermission` waits before opening the next round's `Waiting`.
 *
 * Thirty seconds is the gap between two rounds: long enough that the end of one round and the start of
 * the next are distinguishable events in the log and on screen, short enough that a player who joined
 * mid-round is not sitting in a lobby for a minute.
 *
 * **The timer re-arms rather than advancing when no player is connected.** A server that has been empty
 * for an hour must still be in `Intermission` on the first join, not part-way through a round nobody
 * watched — a round that ran to completion with no players would burn a round's worth of spawning,
 * physics and elimination against an empty scene and leave the first joiner watching its `PostGame`.
 * `RoundService` re-arms this same duration; it does not shorten or pause the phase.
 */
export const INTERMISSION_SECONDS = 30;

/**
 * **Placeholder.** Speed below which the markers do not turn at all, in studs/s.
 *
 * ## The offset it replaces, and the reversal
 *
 * The previous model was `SPIN_RATE_OFFSET + gain x |omegaPhysical|` with the offset at `8 rad/s`,
 * chosen so that a ball with zero physical spin still showed movement. **The offset is deleted and this
 * deadband takes its place**, because the user's requirement reversed: a *parked* ball must show
 * stationary markers. The constant was deleted rather than set to `0` because nothing else read it, and
 * this file's own rule is that a visible-but-inert constant is worse than none — `0` would have left a
 * knob that reads as tunable and does nothing.
 *
 * ## Why a deadband and not just "small"
 *
 * The `spin-probe` log reports `|v| = 0.003` studs/s on a ball that is sitting still: contact solver
 * noise and replication residual, not motion. Fed through the velocity branch at `4 x |v| / 0.5` that
 * is `0.024 rad/s` — utterly invisible as a rate, and yet it accumulates: `0.024 rad/s` is one full
 * revolution every 260 seconds, so a ball parked for a minute rotates its markers ~1.4 degrees. That is
 * not a visual artefact anyone would notice on its own, but it is *the marker angle drifting while the
 * ball is still*, which is a state nobody can explain from the picture and which would slowly desync
 * two balls parked side by side. Below the deadband the rate is exactly zero, so the angle is exactly
 * preserved.
 *
 * `0.5` studs/s is two orders of magnitude above the park noise and an eighth of the belt's steady-state
 * ~4 studs/s, so there is no chance of a genuinely moving ball falling inside it.
 */
export const SPIN_DEADBAND_SPEED = 0.5;

/**
 * **Placeholder.** Multiplier on `|v| / radius` — the sliding ball's drawn rate.
 *
 * This is the branch that actually runs today: the `[Spawner] spin-probe` lines report
 * `|omega| = 0` and `contactSlip = 10` on every body, so physical spin is identically zero and the
 * physical branch below never fires until the belt is fixed. A ball sliding at `|v| = 4` with
 * `radius = 0.5` gives `4 x 4 / 0.5 = 32 rad/s`, clamped to `30` — i.e. the steady state sits at the
 * ceiling, which is what the user asked for when they asked for "more spin when moving".
 *
 * ## Re-purposed twice, and the current meaning is the third
 *
 * It began as a multiplier on `|v| / radius` (model 1), became a multiplier on `|omega|` (model 2), and
 * is a multiplier on `|v| / radius` again (model 3). The name has survived all three because it has
 * always meant "how much faster than true rolling the markers are drawn"; what changed each time is
 * which quantity was being called "true rolling". The `|omega|` multiplier now lives separately in
 * `APPARENT_SPIN_GAIN_OMEGA`, because the two branches are in different units — one is `rad/s` per
 * `rad/s`, the other is `rad/s` per `(studs/s)/stud`, i.e. dimensionless against a *ratio* of geometry
 * and speed — so a single shared number would tie two unrelated scales together.
 */
export const APPARENT_SPIN_GAIN = 3;

/**
 * ## Why 1.5, and why the input is `BALL_SPEED` rather than the world velocity
 *
 * The rate is `GAIN x BALL_SPEED / radius`, so at `radius = 0.5` the drawn rate is `20 x GAIN` at spawn
 * (`BALL_SPEED = 10`) and proportionally less as the attribute decays. Two constraints fix the number:
 *
 * - **Spawn must not sit far above the clamp**, or the markers are pinned at `APPARENT_SPIN_MAX_RAD_PER_SEC`
 *   and the decay is invisible. At `1.5` the spawn rate is exactly `30`, i.e. at the ceiling.
 * - **The end of a ride must be visibly slower.** A ride lasts ~18 s at `BALL_SPEED_DECAY_RATE = 0.3`, by which
 *   point `BALL_SPEED` has fallen to ~4.6, so the drawn rate is `1.5 x 4.6 / 0.5 = 13.8 rad/s` (~2.2 rev/s) -
 *   less than half the spawn rate, clearly slower to the eye.
 *
 * At the previous values this could not work. With the input at `|v|` (the world velocity, i.e.
 * `RELATIVE_SPEED`) the ball spent most of a ride at 0.1-2 studs/s and read as stationary; doubling the gain to
 * 8 fixed the magnitude but, once the input became `BALL_SPEED`, put the clamp crossing at `BALL_SPEED = 1.875`
 * - 27 s into a ride that ends at ~18 s, so the markers would hold the same rate for the whole round.
 *
 * **The offset stays at zero.** A stationary ball must not spin, so there is no `SPIN_RATE_OFFSET` to carry the
 * rate when `BALL_SPEED` is zero; `SPIN_DEADBAND_SPEED` remains the only thing that holds the markers still.
 */

/**
 * **Placeholder.** Multiplier on `|AssemblyAngularVelocity|` — the genuinely-rolling branch.
 *
 * Separate from `APPARENT_SPIN_GAIN` because the units differ (see its docblock). `3` is a legibility
 * multiplier: true rolling at `|omega| = 12.4` (the theoretical `2u/7` equilibrium for `u = 10`,
 * `r = 0.5`) would draw at `37 rad/s` and clamp to `30`.
 *
 * **This branch is dead in the current build, and that is expected.** Every probe reports `|omega| = 0`,
 * so it would compute `0` and the model falls through to the velocity branch. It exists first in the
 * chain so that the day the belt actually imparts spin, the markers become physical with no code
 * change — and so that a body that *is* spinning is never drawn from its translation instead.
 */
export const APPARENT_SPIN_GAIN_OMEGA = 3;

/**
 * **Placeholder.** Ceiling on the drawn angular rate, radians/second.
 *
 * **Kept at 30, deliberately.** The clamp is the only thing standing between the velocity branch and
 * visible strobing: 30 rad/s is ~4.8 revolutions/second, and beyond roughly 5 rev/s a three-marker ball
 * on a 60 Hz display aliases — consecutive frames land the markers more than half a revolution apart
 * and the eye reads them as turning backwards.
 *
 * Under the current gain the clamp is reached at `BALL_SPEED = 30 x 0.5 / 1.5 = 10`, i.e. exactly at spawn, and
 * a pickup (`BALL_SPEED = 12`) sits above it. That is intended — the ceiling is the legibility limit, and beyond
 * ~4.8 rev/s three markers on a 60 Hz display alias into a backwards read.
 */
export const APPARENT_SPIN_MAX_RAD_PER_SEC = 90;

/**
 * **Placeholder.** Physical angular speed above which the drawn axis is taken from the body's own spin.
 *
 * Below this, `AssemblyAngularVelocity.Unit` is numerically meaningless — a vector whose length is
 * a rounding artefact has no trustworthy direction, and normalising it would aim the markers at
 * whatever direction the last float bit happened to point. 0.05 rad/s is ~0.008 rev/s: far below any
 * real rotation, far above solver noise.
 *
 * When the spin is below this the axis falls back to the direction of travel, and then to the belt's
 * own `+RightVector` when the body is not moving either. That chain still matters even though a parked
 * ball no longer rotates (`SPIN_DEADBAND_SPEED` holds the angle): the axis is computed every frame so
 * the log line can name which source it used, and because a ball that starts moving must begin turning
 * about a defined axis on its first moving frame rather than one frame later, when the previous frame's
 * zero rate would otherwise have left no axis at all.
 */
export const SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC = 0.05;

/**
 * **Placeholder.** Speed above which the fallback axis prefers the ball's travel over the belt's axis.
 *
 * `0.5` studs/s — the same number as `SPIN_DEADBAND_SPEED` above, but a different job: that one decides
 * whether the markers turn at all, this one decides *which way* they turn once they do. They coincide
 * because both answer "is the ball really moving", and there is no reason for a ball to be turning while
 * its direction is still being taken from the belt rather than from itself.
 *
 * The two fallbacks agree for a ball travelling straight down the belt, so this threshold only decides
 * *which* they agree on when the ball is deflected by a wall or a collision: a moving ball should read
 * as rolling the way it is actually going, not the way the belt is pointing. Below it, the ball's own
 * direction is noise and the belt is the stable truth.
 */
export const SPIN_FALLBACK_MIN_SPEED = 0.5;

/**
 * **Placeholder.** Exponential smoothing time constant for the drawn velocity, in seconds.
 *
 * The client has no authority over the body, so it sees a server-owned assembly through replicated
 * `CFrame` updates rather than a locally simulated one. Those updates arrive at the physics step rate,
 * not at the render rate, so a raw per-frame `|Δposition| / dt` alternates between "moved a lot" and
 * "moved nothing" — feeding that into a *direction* makes the markers jitter about an axis as the
 * ball creeps, which no amount of gain tuning fixes.
 *
 * `0.15 s` is short enough that a real acceleration still reads as an acceleration (the belt ramp is
 * 3 s) and long enough to average out roughly nine physics steps at 60 Hz. Smoothing the *vector*
 * rather than the scalar speed is what filters the direction, so the spin axis does not jump when the
 * ball grazes a wall.
 *
 * Note what this smoothing now feeds, which differs from the previous two models: it produces the `|v|`
 * that the velocity branch of the rate reads (`min(MAX, GAIN x |v| / radius)`) as well as the fallback
 * axis. It therefore *is* part of the rate path again — and that is why `SPIN_DEADBAND_SPEED` has to
 * exist, since a smoothed speed still settles to the `0.003` studs/s park residual rather than to zero.
 */
export const APPARENT_SPIN_SMOOTHING_SECONDS = 0.15;

/**
 * **Placeholder.** Sign applied to the drawn spin axis. `1` or `-1`, nothing else.
 *
 * Applied to *all three* axis sources, which is what keeps it a single knob: the physical spin axis and
 * both fallback rolling axes point the same way for a forward-rolling ball (all `-Z` for travel along
 * `+X`), so one flip reverses the picture without making a rolling ball disagree with a sliding one.
 *
 * `yAxis:Cross(direction)` is **forward rolling**: for a body travelling `+X` it is `-Z`, the sign that
 * moves the top of the ball toward `+X`. That is the negation of the *braking* axis
 * (`RightVector:Cross(yAxis)`), and the two must not be confused — using the braking axis would draw the
 * markers turning against the travel direction, which reads as the ball sliding backwards.
 *
 * A constant rather than a literal at the call site so the direction is a one-line edit to reverse,
 * which is what makes the direction criterion checkable by a single rerun rather than by reading the
 * cross-product justification again.
 *
 * ## Why this is now `-1`
 *
 * The reasoning above is right about a **rolling** ball and wrong about this one. Under the reference-speed
 * model the ball does not roll the way its travel implies: it is carried on a surface moving at `BELT_SPEED`
 * and slides slowly toward the exit. A ball in that situation is a ball on a treadmill - its contact point is
 * dragged the way the surface moves, so the top of the ball turns **against** the belt's travel. Drawing the
 * forward-rolling axis made the markers turn with the belt while the ball visibly crawled the other way, which
 * reads as the ball spinning backwards.
 *
 * The flip applies to the physical branch too — and since item 92 that branch is unreachable in practice, because
 * nothing in the tree writes `AssemblyAngularVelocity` on a ball any more. It is left signed consistently so that a
 * future mechanism that does spin a body cannot produce markers turning the wrong way, which is the one failure this
 * constant exists to prevent.
 */
export const APPARENT_SPIN_SIGN = -1;

// #region pickups (boost triangles)

/**
 * **Placeholder.** A triangle's size.
 *
 * **It was `(1.5, 0.1, 1.5)` and that was invisible in Studio.** A 0.1-stud-thick part on a brown belt, a few
 * studs from the camera, is a sliver ? and a `SpecialMesh` prism of that thickness is thinner still. The first
 * Studio run reported five pickups spawning and being collected while nothing at all was visible on the belt,
 * which is exactly what a 0.1-stud slab looks like. `Y = 1` makes it a standing wedge a player can see from the
 * chase camera; the ball passes through it (`CanCollide = false`) so the height costs nothing physically.
 */
export const PICKUP_SIZE = new Vector3(2, 1, 2);

/**
 * **Placeholder.** The random band a pickup's `X` is chosen from, in the belt's **local** `X`, in studs.
 *
 * ## Why each bound exists
 *
 * `-18` is the far side, and it sits **5 studs in front of where a ball spawns** (code-frame `-23`, user-X `5`). Balls
 * drift toward `+X` — toward the back, i.e. toward elimination — so a pickup behind the spawn line would be behind every
 * ball for its whole life: a marker that can never be touched is worse than no marker, because it looks like content.
 *
 * `+23` is the near side, chosen to stop well short of the exit at code-frame `+28` (user-X `56`). A ball's drift
 * accelerates as `BALL_SPEED` decays, so a pickup in the last few studs would only be collected after the ball had already
 * committed to leaving the belt.
 *
 * **Both numbers are code-frame X**, from `PointToObjectSpace` with the belt's centre as origin; user-frame they are `10`
 * and `51`. Both ends are inside the belt's own code-frame `-28 .. +28`, so a triangle is always on the surface rather than
 * floating past an end. The lane (`Z`) is not random: it is read from the bound spawner parts, so every round covers
 * every lane a ball can spawn in.
 */
export const PICKUP_X_MIN = -18;

/** **Placeholder.** The near end of the random `X` band. See `PICKUP_X_MIN` for why both bounds exist. */
export const PICKUP_X_MAX = 23;

/** **Placeholder.** Triangle colour — red, because nothing else on the belt is red. */
export const PICKUP_COLOR = Color3.fromRGB(200, 30, 30);

/**
 * **Placeholder.** Seconds between top-up attempts while `Playing`.
 *
 * A top-up never exceeds the bound-spawner count, so this is a *replacement* cadence, not a spawn rate: a
 * round that runs forever holds at most five triangles, and a triangle taken at `t = 3 s` is replaced at the
 * next multiple of 15. Longer than a ball takes to cross the belt, so a replacement never appears in front of
 * the ball that just took the last one.
 */
export const PICKUP_SPAWN_INTERVAL_SECONDS = 15;

/**
 * **Placeholder.** The speed a ball starts `Playing` with, in studs/second.
 *
 * Equal to the reference belt speed, which is what makes `RELATIVE_SPEED` exactly zero at the green light:
 * every ball begins stationary on the belt and the race is decided entirely by what happens to that number
 * afterwards. See the model note at the top of `BALL_SPEED_DECAY_RATE`.
 */
export const BALL_SPEED_START = DEFAULT_BELT_SPEED;

/**
 * **Placeholder.** How fast a ball's speed bleeds away, in studs/second per second.
 *
 * ## The model this constant belongs to
 *
 * The belt is no longer a physical surface. `BELT_SPEED` (`DEFAULT_BELT_SPEED`, 10) is a **reference number**
 * and nothing else: there is no moving slab, no constraint, no friction driving anything.
 *
 * Every ball carries its own **`BALL_SPEED`**, an attribute on the ball, starting at `BALL_SPEED_START` and
 * decaying toward `BALL_SPEED_MIN` at this rate. Each tick the server sets the ball's velocity along the belt
 * to `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED` times the belt's `RightVector`:
 *
 * - `BALL_SPEED = BELT_SPEED` -> `RELATIVE_SPEED = 0` -> the ball holds station on the belt.
 * - `BALL_SPEED < BELT_SPEED` -> negative -> the ball is dragged **backward**, toward the exit edge.
 * - `BALL_SPEED > BELT_SPEED` -> positive -> the ball drifts **forward**, toward the spawn edge, i.e. away
 *   from the exit.
 *
 * Because every ball starts at or above the reference speed and only ever decays, the drift is always backward and
 * every ball is eventually eliminated unless a pickup tops it up. A rate of `0.1` means the 10 studs/s of headroom takes
 * about 100 s to spend, and the drift is quadratic (`v = RATE * t`), so most of the travel happens late — the ball hangs
 * near the spawn end for the first half of its life and then accelerates away.
 *
 * Decay toward **zero**, not toward some terminal value: a terminal value would be an equilibrium a ball could
 * sit at forever, and a race where a ball can survive indefinitely is not a race. Zero is the floor that makes
 * every ride finite.
 */
export const BALL_SPEED_DECAY_RATE = 0.1;

/**
 * **Placeholder.** How far a ball's own starting speed may vary **above** `BALL_SPEED_START`, in studs/second.
 *
 * ## Why the start needs to differ at all
 *
 * Every ball shared one curve: `BALL_SPEED` decayed from the same `BALL_SPEED_START` at the same
 * `BALL_SPEED_DECAY_RATE`, and the only per-ball randomness was the lateral weave — which does not change *when*
 * a ball reaches the exit edge. A round therefore resolved as a stampede: sixteen balls spawned together crossed
 * the edge inside two seconds of each other and the round ended on the first wave, so the winner was decided by
 * spawn order rather than by anything that happened during the ride.
 *
 * `1` against `BALL_SPEED_START = 10` gives each ball a start in `10 .. 12`, i.e. an initial `RELATIVE_SPEED` in
 * `0 .. +2` against a belt at `10`. That is the same 2 stud/s spread the two-sided draw used to give, which at
 * `BALL_SPEED_DECAY_RATE = 0.1` is a 20 s spread in exit time — enough for the field to string out and for a pickup to
 * matter.
 *
 * ## Why the spread is now one-sided
 *
 * It used to be `10 +- 1`, so half the field launched *below* the reference and drifted toward the exit from the first
 * frame. That cost nothing mechanically, but it meant a ball could be losing ground for its whole life without ever being
 * at the speed the wind-boost effect represents — the effect would simply never play for that half of the field. Drawing
 * upward instead keeps the spread and guarantees every ball **launches at or above the reference**, so `Boosted` is
 * `true` at spawn for the whole field and the effect has a state to show from the green light.
 *
 * **The cost, stated:** `RELATIVE_SPEED` is never negative at spawn, so no ball starts by sliding backward; the losing
 * half of a ride now always begins *after* a boosted opening rather than for part of the field at `t = 0`.
 */
export const BALL_SPEED_START_JITTER = 1;

/**
 * **Placeholder.** How far below the reference a ball must fall before `Boosted` is cleared, in studs/second.
 *
 * The attribute has two edges and they are deliberately not the same number. A ball is `Boosted` at
 * `BALL_SPEED >= BELT_SPEED` and stops being `Boosted` once it is more than this far below; the gap is what keeps a
 * ball that decays *through* the reference from flipping the flag on every frame as it crosses — the effect it drives
 * would strobe. Inside the band the flag keeps whatever it had.
 *
 * **The arithmetic at the current decay rate.** `BALL_SPEED_DECAY_RATE = 0.1`, so the band is `0.5 / 0.1 = 5 s` of tail
 * after a ball crosses the reference, and the boosted window runs from the launch speed: a ball that drew `12` plays the
 * effect from `12` down to `9.5`, i.e. `(12 - 9.5) / 0.1 = 25 s`; one that drew the minimum `10` plays for `5 s`. Both
 * are a substantial fraction of a ride and neither is a flicker, which is what the number is choosing.
 *
 * `0.5` is five ticks' worth of decay (the loop runs on `Heartbeat`), which is enough that a single stalled frame cannot
 * cross the band, and small enough that the flag still tracks the ball rather than lagging the ride.
 */
export const BOOST_HYSTERESIS = 0.5;

/** **Placeholder.** The floor `BALL_SPEED` decays to. Zero, because a negative ball speed is meaningless. */
export const BALL_SPEED_MIN = 0;

/**
 * **Placeholder.** The ceiling nothing may push `BALL_SPEED` above, in studs/second.
 *
 * ## Why a ceiling exists at all
 *
 * Because exactly one mechanic has no natural bound. A `bully` collision moves speed from one ball to another, and two
 * balls wedged together exchange on a cooldown for as long as they stay in contact; item 22's log climbed **30 → 56.6
 * across 428 impulses**, which is a ball moving at five times the belt and a round that cannot end. Every other writer is
 * a designed value — a pickup's 12, a sprinter's 16, a rocket's 18 — and none of them needs bounding.
 *
 * ## Why 20 and not 12
 *
 * The argument against a ceiling is that nothing legitimate goes above 12. That was true before this round; it is not true
 * now, because `ROCKET_TARGET_SPEED` is 18 by design. A ceiling at 12 would silently erase the rocket on the very next
 * tick, which is the failure mode a clamp introduces when it is set to the *observed* maximum rather than to the
 * *designed* one. 20 sits above every designed value, so the clamp never binds in normal play and binds only on
 * accumulation — which is the only thing it is for.
 *
 * **This is a safety net, not a balance guard.** Nothing derives a power's magnitude from it, and the designer tunes the
 * powers.
 */
export const BALL_SPEED_MAX = 20;

/**
 * **Placeholder.** The speed a pickup sets a ball to, in studs/second. Above `BELT_SPEED` on purpose.
 *
 * ## Why above the reference, which is the opposite of the old model
 *
 * Before this rework the belt was a physical surface at ~10 and a pickup pushed a ball to **8** ? *below* the
 * belt ? because a physical surface moving faster than the ball can only pull it along, and a ball faster than
 * the surface gets braked by it. Under the faked model none of that applies: velocity is set directly, so a
 * boost above the reference is the only thing that flips `RELATIVE_SPEED` positive, and positive is the
 * direction that carries the ball **away from the exit** and back toward the spawn end. A boost of `8` under
 * this model would push the ball *toward* elimination faster, which is exactly backwards.
 *
 * The trade is stated rather than hidden: a pickup now buys time by reversing the drift, and the ball drifts
 * forward until its decay brings `BALL_SPEED` back under the reference, at which point it turns around and
 * resumes losing ground.
 */
export const BOOST_TARGET_BALL_SPEED = 12;

/**
 * **Placeholder.** Lateral speed of the decorative weave, in studs/second.
 *
 * ## Why this exists at all, and why it is decorative
 *
 * Under the reference-speed model a ball's motion is a straight line along the belt's `RightVector` (world X, the
 * **along-belt** axis — `RightVector` is not lateral here, see `stepBallSpeeds`): the along-belt component is written from
 * `BALL_SPEED` and nothing else acts on it. Correct, and visually dull — a row of balls slides like beads on a rail. This
 * adds a sideways weave so a ball "has some momentum of its own", which is the impression the game wants and which nothing
 * in the model provides.
 *
 * **The weave is on world Z** — the belt's local `+Z`, which is `RightVector:Cross(UpVector)`. Positive Z is the viewer's
 * right from the front looking toward the back (quad 1); negative Z is their left (quad 4).
 *
 * **It is a decoration, not physics.** There is no lateral force, no contact, no friction and no cause: the term is
 * written straight into the velocity every tick, exactly like the along-belt one. That has to be said plainly because the
 * belt is a reference number rather than a surface (item 18) — there is nothing here for a sideways force to come from.
 *
 * `0.05` studs/s across a ride of ~18 s is roughly `0.9` studs of lateral travel on a 12-stud belt — a slow drift rather
 * than a visible crossing, corrected by the reversals `LATERAL_BOUND` forces. (This docblock said `0.5` and "9 studs"
 * until item 93; the constant has been `0.05` for longer than either number was true.)
 */
export const Z_DRIFT_SPEED = 0.05;

/**
 * **Placeholder.** The furthest a ball's centre may wander from the belt's centreline, in studs of **code-frame Z**.
 *
 * Code-frame Z is belt-local `Z` from `PointToObjectSpace`, centred on the belt: the belt is 12 wide, so it runs `-6` to
 * `+6` and a ball of radius 0.5 is fully on the surface within `+-5.5`. In the **user frame** that is `0 .. 12`, so this
 * bound keeps a ball between user-Z `4` and `8` — never within 4 studs of either side edge. `2` leaves 3.5 studs of
 * margin on each side, far more than one tick of overshoot at 0.05 studs/s.
 *
 * **Positive code-frame Z is the viewer's right** from the front looking toward the back (quad 1); negative is their left
 * (quad 4). The bound is symmetric about the centreline, so a ball weaves into both quads.
 *
 * The reversal is a logic test, not a physical wall, so the bound has to sit far enough inside the geometry that the ball
 * never looks like it should have fallen off.
 */
export const LATERAL_BOUND = 2;

/**
 * **Placeholder.** The smallest distance from the centreline the weave can reverse at, in studs (code-frame Z).
 *
 * **Without this the weave degenerates.** A bound sampled uniformly from `0 .. LATERAL_BOUND` lands near zero often enough
 * to matter, and a ball reversing at `0.02` studs flips direction almost every tick — it vibrates in place instead of
 * weaving. Sampling the *magnitude* from `LATERAL_BOUND_MIN .. LATERAL_BOUND` and giving it the sign of the current
 * direction removes that case entirely, and an asymmetric weave (crossing from `+2` to `-1`) reads as more natural than a
 * symmetric one anyway.
 */
export const LATERAL_BOUND_MIN = 1;

/** **Placeholder.** The folder `PickupService` parents its triangles into, created on demand. */
export const PICKUPS_FOLDER_NAME = "SpawnedPickups";

/**
 * The folder the **client** parents its temporary hit-effect carriers into, created on demand.
 *
 * Client-side and per-client on purpose: the carrier and the clone exist for one burst on one machine, are never
 * replicated, and are destroyed by `Debris` a fraction of a second later. The folder is never emptied because it never
 * holds anything — its members destroy themselves.
 */
export const HIT_EFFECTS_FOLDER_NAME = "SpawnedHitEffects";
