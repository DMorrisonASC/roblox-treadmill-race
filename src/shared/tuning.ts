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
 * Belt surface texture: **a two-diamond tread pattern, drawn to read as motion.**
 *
 * The asset is the user's own upload and is deliberately not a continuous surface. Its tile holds **two diamonds, offset left
 * and right**, and the point of the design is that scrolling the surface past a fixed camera makes the alternation between
 * them read as travel - a tread passing underfoot rather than a texture sliding. That intent is why the picture has structure
 * rather than being a noise or a gradient, and it is recorded here because the constant itself is a bare number with no story
 * in it.
 *
 * **The scheme prefix is required and is part of the constant.** `Content.fromUri` takes a URI, and the legacy `Texture` slot
 * is a `ContentId` string the engine resolves the same way; `treadmill-service` passes this value to both verbatim. A bare
 * numeric id here renders nothing at all - the silent failure `BALL_TEXTURE_ASSET` avoids the same way.
 *
 * **Not verified from here.** Nothing in code can detect a bad asset: a missing id renders as a plain surface, an image that
 * does not tile renders as visible seams, and a tile whose *aspect* is not the aspect the diamonds were drawn at renders as
 * stretched diamonds, because `StudsPerTileU` and `StudsPerTileV` are independent. If the belt looks wrong, the id is one knob
 * and `BELT_TEXTURE_STUDS_PER_TILE_U` / `_V` are the others; the code around all three is asset-agnostic.
 */
export const BELT_TEXTURE_ASSET = "rbxassetid://95297464580788";

/**
 * **Placeholder.** Studs covered by one repeat of the belt texture, **per axis**: `_U` along the belt's length (56 studs),
 * `_V` across its width (12 studs). Both are the belt's size divided by how many repeats the design wants on that axis.
 *
 * ## Why these are two constants (item 105)
 *
 * They were one square value - `4` - on the theory that a square tile is the only setting that cannot distort an image whose
 * aspect nothing here can measure. The two-diamond asset settled it the other way. **It was drawn wide, 1920x768, an aspect of
 * 2.5:1**, so a 4-stud square tile squeezed every diamond to 47% of its natural width *and* repeated the picture three times
 * across the belt's 12-stud width - the columns a Studio run showed. That docblock ended by predicting this exact split
 * ("a design that wants a wide repeating unit has to be drawn wide, and then this becomes two constants"), so this is the
 * predicted move rather than a reversal.
 *
 * ## The arithmetic, both axes
 *
 * - **`_V = 12`** is the belt's width, so the image maps **exactly once across it**: `12 / 12 = 1`. That is what turns the
 *   figure's own horizontal banding into continuous stripes running the belt's length instead of three columns of stripes.
 * - **`_U = 28`** gives **two repeats along the length**: `56 / 28 = 2`. With one left diamond and one right diamond per
 *   tile, the belt shows **four diamonds at any instant**, one every 14 studs - large enough to follow as a beat, which is the
 *   point of a two-diamond design.
 *
 * ## Why `28` and not `14`
 *
 * `14` also divides 56 exactly (four repeats, eight diamonds) and is the other obvious candidate. It loses on aspect: a
 * `14 x 12` tile is 1.17:1 against the asset's 2.5:1, stretching the diamonds **about 2.1x across the belt** - squat, wide
 * shapes rather than diamonds. `28 x 12` is 2.33:1 against 2.5:1, a **7% squeeze on the length axis** that nothing on screen
 * will show. The number that keeps the diamonds diamond-shaped is therefore also the number that keeps the repeats whole; the
 * exact no-distortion value for `_V = 12` is `30`, which does not divide 56 and would leave partial diamonds at both ends.
 *
 * **Not verified from here.** Nothing in code can tell a correct aspect from a stretched one. Only a Studio run shows whether
 * the diamonds read as diamonds at the game's camera angle: if they look stretched, `_U` is the knob and `30` is the
 * arithmetic's answer; if columns reappear across the belt, `_V` is not the belt's width.
 */
export const BELT_TEXTURE_STUDS_PER_TILE_U = 28;

/**
 * See `BELT_TEXTURE_STUDS_PER_TILE_U`. This one is the belt's width, so the image maps exactly once across it.
 */
export const BELT_TEXTURE_STUDS_PER_TILE_V = 12;

/**
 * **Placeholder.** How fast the belt texture scrolls, as a multiple of the belt's own visual rate.
 *
 * ## The decoupling, which is the whole point of this constant
 *
 * The scroll rate is `BeltSpeedActual * this` - **the belt's visual rate times this multiplier, then signed for direction by
 * `BELT_TEXTURE_SCROLL_SIGN`, and nothing else.** Before this existed the tread moved at exactly `BeltSpeedActual`, so "make
 * the belt look faster" and "make the belt carry balls faster" were the same edit. They are not the same thing: `BeltSpeed` is
 * the *reference number* the `BALL_SPEED` model compares against, so raising it changes `RELATIVE_SPEED`, the decay arithmetic
 * and therefore the race. This multiplier changes the **apparent** speed of the tread and touches none of that: no
 * `BALL_SPEED`, no `RELATIVE_SPEED`, no ramp, no physics write, and it lives entirely on the client.
 *
 * Read it as a plain scale on the picture:
 *
 * - `1` - the tread scrolls at the belt's speed, which is what shipped before this constant existed.
 * - `2` - the tread reads twice as fast; the balls are untouched.
 * - `0.5` - the tread reads half as fast; the balls are untouched.
 *
 * ## Why not fold it into `BELT_TEXTURE_STUDS_PER_TILE_U` / `_V`
 *
 * They are two different properties that happen to look similar in a formula. The tile size changes how **big** the pattern is
 * and how often it repeats; this changes how **fast** it slides past. Raising the tile size to make the motion legible is the
 * mistake that then requires a scroll multiplier to undo, so the two knobs are kept apart deliberately.
 *
 * ## A negative value is legal, and the sign is still the intended direction knob
 *
 * `BELT_TEXTURE_SCROLL_SIGN` exists for direction; this is documented as a magnitude. Nothing clamps it, though, because a
 * clamp (`math.abs`) would silently turn a deliberate `-1` into `+1` and leave the reader wondering why the tread would not
 * reverse. A negative multiplier therefore works and composes with the sign: the two flips cancel. **Use the sign to choose a
 * direction and this to choose a speed**, and the combination is the product of two explicit numbers rather than a surprise.
 */
export const BELT_TEXTURE_SCROLL_MULTIPLIER = 12;

/**
 * The sign applied to `OffsetStudsU` per second, x `BeltSpeed`: **`+1`**, so the tread travels the way the balls do.
 *
 * ## What this number means, and why it is the only one
 *
 * `BeltScrollController` advances `OffsetStudsU` by `speed * BELT_TEXTURE_SCROLL_MULTIPLIER * this * dt` and wraps it modulo
 * the tile. The offset moves the *sampled* image rather than the surface, so the sign that makes the pattern appear to travel
 * one way is the opposite of the sign in the arithmetic. That inversion is the whole reason this is a named constant instead
 * of a literal: getting it wrong produces a belt that animates perfectly and in the wrong direction, which reads as a physics
 * bug rather than a texture one.
 *
 * ## The direction it now asserts
 *
 * **The tread moves toward `+X` - the same way a decaying ball drifts, toward the back edge and elimination.** That is the
 * direction a treadmill belt surface actually moves under the thing it is carrying, and it is the direction the balls go.
 *
 * ## Why it is `+1` and not `-1` (item 103)
 *
 * `-1` was shipped on an *inference*: that on a part's `Top` face the texture's `U` axis runs along the part's local `+X`, so
 * a negative rate would be needed to make the pattern travel that way. **A Studio run with the two-diamond asset showed the
 * opposite** - the tread ran against the balls' drift - so the inference was wrong about which way `U` maps on the `Top` face
 * in this engine build, and the constant is now set from what was seen rather than from what was reasoned. The old docblock
 * said "flip this one constant to `1`; nothing else needs to change", and that turned out to be exactly right: one edit, no
 * other file.
 *
 * **This is the one visual direction the client owns and cannot verify from source.** If a future engine change, a re-exported
 * asset or a re-parented belt flips it again, this constant is the whole fix.
 */
export const BELT_TEXTURE_SCROLL_SIGN = 1;

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
 * **Placeholder.** Restitution of the invisible floor each belt creates under itself.
 *
 * ## Why raising the ball made this number move (item 174)
 *
 * The engine's pair rule is a weighted average of the two bodies' elasticity, not the ball's alone. The floor used to be
 * `0.5` against a ball of `0.8`, which is a pair of `(0.8 + 0.5) / 2 = 0.65`. Left at `0.5` against the new `0.95` ball,
 * the pair would be `0.725` — every landing would return about 11% more speed, which is a bouncier belt nobody asked for.
 * `0.35` holds the pair at `(0.95 + 0.35) / 2 = 0.65`, exactly the number that shipped at item 173, so the only pair that
 * changed is ball-ball.
 *
 * `0.1` is the other obvious answer and is deliberately not used: it gives `(0.95 + 0.1) / 2 = 0.525`, roughly 19% less
 * restitution than the floor has today, so landings would read **deader** than before. "Not bouncier" is the requirement;
 * "deader" would be a second, unrequested change to the same contact.
 *
 * Not `1` and not `0` either: both are different mechanics rather than quieter versions of this one. A perfectly
 * inelastic floor never rebounds at all, and a perfectly elastic one never settles, which is the failure this constant is
 * choosing away from.
 *
 * Friction is untouched at `0` in `TreadmillService`: it is load-bearing for the `BALL_SPEED` model, and this constant is
 * about bounce only.
 */
export const BELT_SURFACE_ELASTICITY = 0.35;

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
 * **Placeholder.** How long the ball picker stays open inside `Waiting`, in seconds.
 *
 * ## Why this is shorter than `WAITING_SECONDS` rather than equal to it
 *
 * The two numbers used to be one: the pick window closed when the phase did, so the panel and the phase ended together.
 * They are separate facts now (item 149) because the last stretch of `Waiting` is given to a **3-2-1-Start! countdown**,
 * and a countdown that plays under a picker still taking clicks is two things asking for the same attention.
 *
 * ## Why eleven and not twelve (item 152)
 *
 * **The countdown grew and the window had to pay for it.** The countdown ends exactly at `Playing` entry — `Start!` is a
 * start cue, so it lands where the race does — which means the runway between the picker closing and the phase ending has
 * to be at least the countdown's own length. That length is `3.05 s` at item 152's durations (`0.4` in, `0.2` out, held
 * `0.6`, faded `0.25`), and a twelve-second window leaves only `15 - 12 = 3.0 s` — the first caption would have appeared
 * three frames *before* the panel closed.
 *
 * Eleven leaves four, so the sequence fits with **0.95 s of "the balls are settled, have a look at the belt"** in front of
 * it. That gap is the same breath the twelve-second window had against the shorter countdown, which is the point: the
 * picker gave up a second so the countdown could have one, and the pause between them did not move.
 *
 * The constraint is `PICKER_WINDOW_SECONDS + countdownLength <= WAITING_SECONDS`, and the second term is derived in
 * `shared/ui/countdown.ts` rather than written here — so raising a countdown duration is what forces this number down, not
 * a second guess about it. Above that, a window longer than the phase would put picks after the round had started, and
 * `closeOffers` at `Playing` entry would silently drop them.
 */
export const PICKER_WINDOW_SECONDS = 11;

/**
 * **Placeholder.** How long before `Intermission` ends a player must already be connected to be enrolled in the next round,
 * in seconds.
 *
 * ## What it exists for
 *
 * The competitor list is decided at `Waiting` entry (`spawnRoundCompetitors`), which is `INTERMISSION_SECONDS` after
 * `Intermission` begins — and `Waiting` itself does not spawn anyone who joins during it. So without a cutoff a player could
 * arrive with two seconds of lobby left, be handed a body, and race a round they never saw announced; and a player arriving
 * twenty-nine seconds in would get the same treatment. The cutoff says: **you are in this round if you were here before the
 * last five seconds of the lobby**, and otherwise you watch it and play the next one (item 159).
 *
 * ## Why five, and why it is not the wipe's length
 *
 * The transition wipe covers `Intermission → Waiting` and holds for roughly 2.5 s, all of it inside this window, so a player
 * joining under the wipe is *always* inside the cutoff and never enrolled. That is the intended reading — the wipe is the
 * last moment of the lobby, and somebody arriving under it has not seen the lobby at all — but it means the constant must be
 * comfortably larger than the hold, or the rule would be "the wipe decides". Five is twice the hold, so a client that arrives
 * just as the wipe opens is still (correctly) excluded while a client that arrives a second and a half earlier was already
 * excluded by the cutoff itself rather than by an effect.
 *
 * ## Why it is a separate constant from `PICKER_WINDOW_SECONDS`
 *
 * They are two different questions about the same phase — "can you still choose a ball" and "are you in this round at all" —
 * and they are answered in opposite order: the pick window opens *after* the cutoff closes. Sharing one number would tie the
 * enrollment rule to the countdown's arithmetic and move both whenever either was retuned.
 *
 * This is a duration, not an instant, and it is subtracted from the phase's whole length (including any wipe hold) so that
 * the window is the same five seconds regardless of whether the lobby arrived behind a transition.
 */
export const ENROLLMENT_CUTOFF_SECONDS = 5;

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
 * **Placeholder.** Multiplier on `speed / radius` - the drawn rate, and the number that decides whether a ball looks like
 * it is *rolling on the belt* or *sliding across it*.
 *
 * ## The formula, as it actually runs
 *
 * `apparentSpinRate` returns `min(APPARENT_SPIN_MAX_RAD_PER_SEC, APPARENT_SPIN_GAIN * speed / radius)` above
 * `SPIN_DEADBAND_SPEED`, where `speed` is the body's `BALL_SPEED` attribute and `radius` its `Size.Y / 2`. At this game's
 * `0.5`-stud radius that is `2 * GAIN * BALL_SPEED`, i.e. `20 rad/s` at spawn with `GAIN = 1`.
 *
 * ## Why the input is `BALL_SPEED` and **not** `RELATIVE_SPEED` (item 108)
 *
 * `BALL_SPEED` **is** the belt-relative speed in this model, by construction rather than by convention. `stepBallSpeeds`
 * writes the along-belt velocity as `-(BALL_SPEED - BELT_SPEED)`, and `BALL_SPEED_START` is literally
 * `DEFAULT_BELT_SPEED` - the ball starts at the belt's own speed so that it **holds station** (plus up to
 * `BALL_SPEED_START_JITTER`, so a fresh ball is holding station or gaining slightly). A ball whose *world* velocity is zero
 * on a moving belt is travelling at `BELT_SPEED` relative to the surface under it.
 *
 * `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED` is the world velocity (negated), so driving the roll from it would draw a
 * ball that is motionless **and not rotating** while the tread streams past underneath - which is the definition of
 * sliding, not the cure for it. Rolling speed equals world speed on static ground; on a treadmill it equals speed relative
 * to the *belt*, and this game is a treadmill.
 *
 * ## Why `1`, and what `3` did
 *
 * `1` is the **no-slip** rate. The surface under the ball is drawn travelling at `BELT_SPEED` toward `+X` (the scroll
 * sign, item 103), so for the contact point to keep up with it, its velocity must be `BALL_SPEED` toward `+X` - and that
 * is `omega * radius`, exactly. `GAIN = 1` satisfies it; nothing else does.
 *
 * `3` shipped for one round and produced the very symptom it was meant to cure. At `BALL_SPEED = 10` it drew
 * `3 * 10 / 0.5 = 60 rad/s`, which is **9.5 revolutions per second** - and at 60 Hz that is **`57` degrees of rotation
 * between consecutive frames**. A sphere carrying six face textures only repeats every `90` degrees, so `57` degrees is
 * more than half a symmetry period: neither the sign nor the rate is recoverable from two neighbouring frames, and the eye
 * resolves it as a slow crawl, often backwards. `1` draws `20 rad/s` (`19` degrees per frame, `3.2` rev/s), which is
 * unambiguous. The report that motivated this was "sliding forward while rotating far too slowly", which is exactly what
 * that fold looks like.
 *
 * **The rest of the visual coupling lives in `BELT_TEXTURE_SCROLL_MULTIPLIER`.** No ball rotation can match a tread drawn
 * faster than the belt model's `BELT_SPEED`; the two only agree at `1`.
 */
export const APPARENT_SPIN_GAIN = 3;

/**
 * **Placeholder, and not read by anything.** Kept as the placeholder for a multiplier on a body's *own*
 * `AssemblyAngularVelocity`, which was one branch of an earlier three-branch rate model (physical spin, then translation,
 * then deadband). That model is gone: `apparentSpinRate` is one formula over `BALL_SPEED`, and no code multiplies by this
 * constant. It stays declared so the name is reserved rather than invented again, and so the units argument below is not
 * lost.
 *
 * **Its units genuinely differ from `APPARENT_SPIN_GAIN`**, which is why it was never merged into it: `rad/s` per `(studs/s)
 * per stud` is a gain on a *ratio*, while `rad/s` per `rad/s` is dimensionless. A single shared number would tie two
 * unrelated scales together. Anything that starts reading this must also decide what a *physical* spin should look like on
 * a belt that is itself moving, which is not the same question as the one `APPARENT_SPIN_GAIN` answers.
 */
export const APPARENT_SPIN_GAIN_OMEGA = 3;

/**
 * **Placeholder.** Ceiling on the drawn angular rate, radians/second.
 *
 * **A safety net now, not a rate.** With `APPARENT_SPIN_GAIN = 1` and a `0.5`-stud radius the drawn rate is
 * `2 * BALL_SPEED`, so this value is only reached at `BALL_SPEED = 45` - above `BALL_SPEED_MAX` (`20`), i.e. never. It
 * stays because a future gain, radius or speed range must not be able to produce an `inf` or a meaningless number, and
 * because `apparentSpinRate` reads it on every call.
 *
 * **It does not police legibility, deliberately.** Past roughly `5` revolutions a second (about `31 rad/s`) a textured
 * ball on a 60 Hz display aliases - consecutive frames land features more than half a symmetry period apart and the eye
 * reads the ball as turning backwards. That is `BALL_SPEED ~ 15.7` at this radius. Clamping *at* that point would make a
 * fast ball stop matching the tread while it kept moving, which looks worse than the alias; the earlier `60 rad/s`
 * problem came from the gain (`3`), not from this ceiling being absent.
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

// #region pickups (boost pads)

/**
 * **Placeholder.** A pickup's collider size: the box `Touched` is measured against.
 *
 * **The part it sizes is invisible** (item 144). `Size` is no longer a visual decision at all - it is the volume a ball has to
 * enter for the pad to fire, and it is kept at the wedge's old value so collection behaves exactly as it did.
 *
 * **The history is worth keeping, because it is why this constant exists.** It was `(1.5, 0.1, 1.5)` and that was invisible in
 * Studio: a 0.1-stud-thick part, a few studs from the chase camera, is a sliver. `Y = 1` made it a standing wedge a player
 * could see; the ball passes through it (`CanCollide = false`) so the height cost nothing physically. Now that the body is a
 * collider behind a billboard, `Y = 1` still matters - it is what a ball's height has to intersect - but nothing about the
 * *appearance* depends on it.
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
 * and `51`. Both ends are inside the belt's own code-frame `-28 .. +28`, so a pad is always on the surface rather than
 * floating past an end. The lane (`Z`) is not random: it is read from the bound spawner parts, so every round covers
 * every lane a ball can spawn in.
 */
export const PICKUP_X_MIN = -18;

/** **Placeholder.** The near end of the random `X` band. See `PICKUP_X_MIN` for why both bounds exist. */
export const PICKUP_X_MAX = 23;

/**
 * **Placeholder.** Seconds between top-up attempts while `Playing`.
 *
 * A top-up never exceeds the bound-spawner count, so this is a *replacement* cadence, not a spawn rate: a
 * round that runs forever holds at most five pads, and a pad taken at `t = 3 s` is replaced at the
 * next multiple of 15. Longer than a ball takes to cross the belt, so a replacement never appears in front of
 * the ball that just took the last one.
 */
export const PICKUP_SPAWN_INTERVAL_SECONDS = 15;

/**
 * **Placeholder.** The pickup sprite's image, used when no Studio instance provides one.
 *
 * ## The visible half of a pickup, and why the id lives here
 *
 * Since item 144 the pickup body is an **invisible collider**; everything a player sees is a billboard the client builds,
 * and a billboard needs an image id. The id is a repo value for the reason `sounds.config.ts` argues about its own ids: it
 * is one string, and an edit here is the whole of a change.
 *
 * A `Decal`/`Texture`/`ImageHandleAdornment` named `pickupSprite` under `ReplicatedStorage` **overrides** this, because a
 * designer swapping a sprite should not need a rebuild and because a `Decal` is how an image lands in the place to begin
 * with. Both inputs produce a `ContentId` handed to the same `ImageLabel.Image`, so there is no second render path - only
 * two sources for one string, and the client's boot line names which one won.
 */
export const PICKUP_SPRITE_ASSET_ID = "135266450823195";

/**
 * **Placeholder.** The sprite's width and height, in studs.
 *
 * A `BillboardGui` reads the two components of `Size` differently, and reading them the wrong way round is what made the
 * first pass invisible (item 145). Per the engine's own guide: *"the scale components of the BillboardGui.Size property
 * set the billboard's stud size in 3D space... [and it] scales larger or smaller depending on its distance from the
 * camera"*, while the offset components are screen pixels held at a fixed on-screen size. `UDim2.fromOffset(2.6, 2.6)`
 * is therefore a **2.6-pixel** smudge rather than a 2.6-stud sign, which is exactly the pale dot a playtest reported on
 * the belt. This number is only meaningful through `UDim2.fromScale`: as a scale value it is studs, and it shrinks with
 * distance the way the pad it sits on does.
 *
 * Slightly wider than the 2-stud pad on purpose - the sprite is a marker, and a marker the pad's own size or smaller is hard
 * to tell from the pad it marks. It is not a lane-crowding risk in practice: `PickupService` spreads the live pads along the
 * belt's length, so two of them rarely share an X, and the sprite is centred on its own pad rather than reaching sideways.
 */
export const PICKUP_SPRITE_STUDS = 2.6;

/**
 * **Placeholder.** How far above the pad's centre the sprite floats, in studs.
 *
 * The pad is `PICKUP_SIZE.Y` tall and a ball is a stud across, so a sprite sitting at the pad's origin would be behind the
 * ball that is collecting it. This lifts it clear without putting it above the camera's eye line.
 */
export const PICKUP_SPRITE_LIFT_STUDS = 1.2;

/**
 * The pickup footprint ring's colour: `#00BFFF`, "deep sky blue" in the web palette — the user's hex, not a placeholder.
 *
 * ## Why it is written as `fromRGB` and not as a `Color3.new` decimal
 *
 * Because the hex is the source of truth: `(0, 191, 255)` is the number a colour picker shows, and a reader comparing this
 * line against the design cannot check `Color3.new(0, 0.749, 1)` without a calculator. This file is full of the same
 * argument applied to studs and seconds — the value is stored in the unit a human reads it in.
 *
 * ## What it is a colour *of*, and what it is not
 *
 * The ring is a filled disc — one `Frame` at `BackgroundTransparency = RING_TRANSPARENCY` inside a `SurfaceGui` on the pad's
 * footprint (see `PickupSpriteController`) — so this colour is the fill and nothing else. On a dark belt at
 * `RING_TRANSPARENCY` it reads as a saturated cyan zone rather than as a soft haze: the palette's "sky blue" is `#87CEEB`,
 * which is markedly paler than this. That is deliberate — it is a marked area on a dark surface, not a light.
 *
 * The shape was an annulus in item 146 and became a disc in item 147; this hex survived both, which is the point of it living
 * here rather than at the call site.
 */
export const RING_COLOR = Color3.fromRGB(0, 191, 255);

/**
 * **Placeholder.** How transparent the footprint disc is, from `0` (solid) to `1` (invisible).
 *
 * **This is the knob if the ring reads as too electric, not `RING_COLOR`.** The colour is the user's hex and is fixed; how
 * much of it lands on the belt is this number. `0.6` is the user's starting point, and it stays marked `Placeholder.` because
 * a *fill* is far more sensitive to it than the 6-pixel outline it replaced: the same value reads heavier on a bright asset
 * than on a dark one, and heavier from a low pitch than from above. Toward `0.75` softens it toward a tint; toward `0.4`
 * turns the belt under it into a plate.
 */
export const RING_TRANSPARENCY = 0.6;

/**
 * **Placeholder.** How densely the ring's `SurfaceGui` is rasterised, in canvas pixels per stud.
 *
 * A `SurfaceGui` does not draw vectors: the disc is rasterised at `PixelsPerStud x studs` and the circle's smoothness is that
 * resolution. At the default `50` a 2-stud ring is a `100 x 100` canvas, whose circle is a visible polygon at the game
 * camera's distance; `200` gives a `400 x 400` canvas, which is still trivial for one gui per pad and reads as a circle.
 *
 * **Item 147 kept `200` after the fill replaced the outline, and the argument is not the same one.** The annulus's
 * legibility *was* its stroke width in canvas pixels, so the density and the thickness were coupled; a filled disc's edge is
 * a boundary between `RING_COLOR` at `RING_TRANSPARENCY` and whatever is under it, so the density now only decides how
 * smooth that edge is. `200` draws a 400-pixel circle, where the corner tessellation is finer than a stud by an order of
 * magnitude — there is nothing left to buy by raising it, and the cost of a higher value is paid once per pad.
 */
export const RING_PIXELS_PER_STUD = 200;

/**
 * **Placeholder.** The footprint ring's own vertical thickness, in studs.
 *
 * It exists only because a `SurfaceGui` needs a face to sit on, and a `Part` needs a size on all three axes. `0.05` is a
 * twentieth of a stud: thin enough that the ring reads as paint on the floor rather than as a plate, thick enough that the
 * disc it makes is not degenerate.
 */
export const RING_THICKNESS_STUDS = 0.05;

/**
 * **Placeholder.** How far above the pad's bottom face the ring floats, in studs.
 *
 * **Not zero, and the reason is a coplanarity, not a look.** `PickupService.positionFor` puts the pad's bottom face exactly
 * on the surface a ball rests on — the invisible moving collider, itself `BELT_SURFACE_THICKNESS` thick and sitting on the
 * belt. A ring at exactly that height z-fights with the thing it is lying on: two coplanar surfaces, decided per frame, per
 * pixel. `0.02` studs is below the perceptual floor and above the depth buffer's.
 */
export const RING_LIFT_STUDS = 0.02;

/**
 * **Placeholder.** How long one collection spin takes, in seconds.
 *
 * One full turn on an `Exponential`/`Out` curve: fast at the start, easing to a stop. The curve is what reads as "this was
 * taken" rather than as "this is rotating" - a linear spin looks mechanical and reads as an idle animation.
 */
export const PICKUP_SPIN_SECONDS = 1;

/**
 * **Placeholder.** The **floor** under a spin's visible duration, in seconds.
 *
 * The effective duration is `math.max(PICKUP_SPIN_SECONDS, PICKUP_SPIN_VISIBLE_SECONDS)`, so a later "make it snappier" edit
 * that set the tween to `0.2` cannot cut the cue below the time it takes to notice. It is a floor and not a second timer:
 * one duration comes out of the pair, and the tween uses it. The name is the brief's; what it really protects is
 * *perceptibility*, since the sprite is always visible and nothing hides it.
 */
export const PICKUP_SPIN_VISIBLE_SECONDS = 0.6;

/**
 * **Placeholder.** The shortest gap between two spins on one pad, in seconds.
 *
 * A `recycle` ball resting on its surviving pad re-touches it every **14-24 ms** (item 91's measurement, taken for the pickup
 * sound). Half a second is the same order as the sound's own 0.3 s and the shared sound interval's 0.5 s, and it is shorter
 * than one spin - so a genuine second collection, which takes a ball longer than half a second to produce, still restarts the
 * cue, while a resting ball produces one spin rather than fifty.
 */
export const PICKUP_SPIN_MIN_INTERVAL_SECONDS = 0.5;

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

/** **Placeholder.** Density shared by every spawned body; this matches Plastic's current default density. */
export const BALL_PHYSICAL_DENSITY = 0.7;

/** **Placeholder.** Low friction for ball-to-ball contacts, so contacts separate rather than drag. */
export const BALL_PHYSICAL_FRICTION = 0.05;

/**
 * **Placeholder.** Restitution for every spawned ball — the coefficient of restitution, where `1` returns all of the
 * closing speed and `0` returns none.
 *
 * `0.95` is a contact that separates at 95% of the speed it closed at, so two bodies meeting at belt speeds shove each
 * other visibly apart instead of reading as a nudge. It is deliberately not `1`: a perfectly elastic pair loses no energy,
 * so nothing settles and a resting pair would keep trading a small bounce forever. `0.95` is the top of the usable band
 * below that.
 *
 * ## The pair rule, and why the floor moved with it (item 174)
 *
 * The engine does not use one part's elasticity. The pair value is the weighted average
 * `(a.Elasticity * a.ElasticityWeight + b.Elasticity * b.ElasticityWeight) / (a.ElasticityWeight + b.ElasticityWeight)`,
 * the same function the Roblox `PhysicalProperties` docs give for friction (verified 2026-11-10).
 *
 * Ball-ball is therefore exactly this number: both bodies share the profile and share the same default weight, so the
 * weights cancel and the result is `(0.95 + 0.95) / 2 = 0.95`. Ball-floor is the mean of this and
 * `BELT_SURFACE_ELASTICITY`, which is why the floor's own number is not left alone — see there.
 */
export const BALL_PHYSICAL_ELASTICITY = 0.95;

/** **Placeholder.** Minimum upward velocity for a successful contact pop, in studs/second. */
export const BALL_COLLISION_POP_UPWARD_SPEED = 30;

/**
 * **Placeholder.** Seconds after a `decoy` ball spawns before its twin appears, in seconds (item 183).
 *
 * ## Why a twin is deferred at all
 *
 * A `decoy` ball is **one competitor and two bodies** — the parent, which carries the owner and can win, and an ownerless
 * twin. Spawning the pair together put nine bodies on an eight-lane belt at `Playing` entry, which read as "an extra ball"
 * and was chased twice as a counting error. The counting was right; the twin simply belongs later in the round.
 *
 * Deferring it means the opening field is exactly one body per lane, and the twin arrives while the race is already moving —
 * which is also when a decoy is *least* conspicuous, since its whole purpose is to be mistaken for a real ball.
 *
 * ## Why five
 *
 * Long enough that it is not part of the opening pile-up (the bodies are still settling for the first ~2.5 s, and
 * `HIT_EFFECT_MIN_ROUND_AGE_SECONDS` already treats that window as noise), short enough that a round still has most of its
 * ride left for the twin to matter. It is measured from **that ball's spawn**, so a ball spawned mid-round by key `4` gets its
 * twin five seconds later rather than instantly.
 *
 * Deliberately *not* a per-power value: only one power spawns a twin, so a table would have one row.
 */
export const DECOY_SPAWN_DELAY_SECONDS = 5;

/**
 * **Placeholder.** Peak sideways speed one contact gives each body, in studs/second.
 *
 * ## Why this is a number at all, when the engine already separates in Z
 *
 * Because the engine's lateral separation is erased. The sway sets the lateral component of every ball's velocity on every
 * tick (item 151), so a collision imparts one physics step of sideways motion — about `1/60` of a stud — and the next tick
 * replaces it. A Studio log showed `hit` and `pop` lines with no visible sideways movement, which is that arithmetic, not
 * a missing shove in the engine.
 *
 * ## The displacement this buys
 *
 * A shove of `s` decaying with time constant `T` moves a body `s * T` studs in total. At `10` and
 * `BALL_COLLISION_SHOVE_DECAY_SECONDS = 1` that is **10 studs** on a belt `173` wide, against a 20-stud ball — visible as a
 * knock rather than as a nudge, and about 2.8 studs per second at the peak, which is below `BELT_SPEED` so the sideways
 * motion never outruns the along-belt picture.
 *
 * This was `5` / `0.3` (1.5 studs) when it shipped in item 175, against 1-stud balls: 1.5 studs is one and a half *ball
 * diameters* there, and a tenth of one on a 20-stud ball, which is why it was retuned with the size change. The pair is one
 * displacement (`s * T`), so raising either without the other moves twice.
 *
 * The sway's own position correction (`SWAY_TRACK_SECONDS = 1.5`) then walks the ball back to its wave, so the shove
 * settles instead of permanently changing lane.
 */
export const BALL_COLLISION_SHOVE_SPEED = 10;

/**
 * **Placeholder.** Time constant of a contact shove, in seconds.
 *
 * Exponential: the shove is at 37% of its peak after one of these, 14% after two, and effectively gone after five. Long
 * enough that the knock reads as a slide across the belt rather than as a puff, and long enough that the peak itself is not
 * a single frame — a single tick would move a body `speed / 60` studs, which is invisible at any ball size.
 *
 * Retuned from `0.3` with the ball-size change; see `BALL_COLLISION_SHOVE_SPEED` for why the two move together.
 */
export const BALL_COLLISION_SHOVE_DECAY_SECONDS = 1;

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
 * **Placeholder.** How often a ball sways across the belt: **full left-right cycles per second**.
 *
 * ## What the lateral motion is now (item 107)
 *
 * Each ball's lateral offset is a sine wave in code-frame Z:
 *
 * `z(t) = SWAY_AMPLITUDE * sin(2 * pi * SWAY_FREQUENCY_HZ * t + phase)`
 *
 * where `t` is that ball's own time since it spawned and `phase` is its random start - see `SWAY_PHASE_JITTER`. The tick
 * loop writes the **derivative** of that position, `SWAY_AMPLITUDE * omega * cos(omega * t + phase)` with
 * `omega = 2 * pi * SWAY_FREQUENCY_HZ`, because physics integrates velocity and the derivative is the only thing that
 * makes the position follow the wave. Plus a correction toward the wave's position, explained on `SWAY_TRACK_SECONDS`.
 *
 * **Frequency and amplitude are independent, which is the point of the rewrite.** `0.1` here is one full cycle every
 * `1 / 0.1 = 10` seconds; change it alone and a ball sways more or less often and nothing else moves. Change
 * `SWAY_AMPLITUDE` alone and it covers more or less ground per sway at the same rhythm.
 *
 * **This is the base rate, not every ball's rate (item 153).** Each ball draws its own multiplier from
 * `SWAY_FREQUENCY_JITTER`, because a field sharing one period can only ever be a fixed arrangement of offsets — see that
 * constant for why the phase jitter alone was not enough.
 *
 * The model this replaced was a **bounce**: a ball drifted at `Z_DRIFT_SPEED` (0.05 studs/s) and reversed when it reached
 * a random bound between `LATERAL_BOUND_MIN` and `LATERAL_BOUND` (1..2 studs from the centreline), so one full cycle took
 * `4 * bound / speed` - **40 to 80 seconds** - and the only way to sway more often was to speed up the drift or shrink the
 * bound, which changed how far it travelled. All three of those constants are gone; this pair replaces them.
 *
 * ## The numbers
 *
 * At `0.1` Hz with `SWAY_AMPLITUDE = 2`, peak lateral speed is `A * omega = 1.26` studs/s against an along-belt speed of
 * up to 10 - a slow drift with a rhythm rather than a strafe. A ride of about 18 seconds shows **1.8 full cycles**, which
 * is roughly the most that still reads as swaying rather than vibrating; much past `0.5` Hz the decoration starts to cost
 * the player the ability to track their own ball.
 *
 * **The axis.** Lateral is world Z - the belt's local `+Z`, which is `RightVector:Cross(UpVector)`. Positive Z is the
 * viewer's right from the front looking toward the back (quad 1); negative is their left (quad 4).
 */
export const SWAY_FREQUENCY_HZ = 0.1;

/**
 * **Placeholder.** How much each ball's sway frequency may differ from `SWAY_FREQUENCY_HZ`, as a fraction of it.
 *
 * ## Why a per-ball frequency, when there is already a per-ball phase (item 153)
 *
 * A phase offset alone gives a field of **identical periods**, and identical periods never drift apart: two balls stay
 * exactly the offset they were drawn with for the whole round. That is why a field drawn from `0 .. pi` still reads as
 * synchronised — a 10-second cycle means a `pi` spread is only five seconds of the cycle, so at any instant roughly half
 * the belt is moving the same way and the whole pattern repeats on a 10-second loop. The user reported exactly that, twice,
 * with the phases on the log to prove the draw was working.
 *
 * A **frequency** difference is the only thing that makes two balls drift in and out of step, so the field stops having a
 * period at all. `0.3` gives each ball a period between `10 / 1.3 = 7.7 s` and `10 / 0.7 = 14.3 s`; two balls at opposite
 * ends of that range pass through every relative phase inside half a minute, so the arrangement never repeats within a
 * ride.
 *
 * `0` restores item 107's behaviour exactly — one period for the field, phase offsets only.
 *
 * **The base is still `SWAY_FREQUENCY_HZ`.** This number never sets an absolute rate; it multiplies, so a designer retuning
 * the rhythm moves every ball together and the spread stays proportional.
 */
export const SWAY_FREQUENCY_JITTER = 0.3;

/**
 * **Placeholder.** How far from the belt's centreline a swaying ball reaches, in studs of **code-frame Z**.
 *
 * Code-frame Z is belt-local `Z` from `PointToObjectSpace`, centred on the belt: the belt is 12 wide, so it runs `-6 .. +6`
 * and a ball of radius 0.5 sits fully on the surface within `+-5.5`. `2` keeps a ball between `-2` and `+2` - user-frame
 * Z `4` to `8` - leaving **3.5 studs of margin on each side**. That margin is the point of the number: the sway is
 * decorative, so it must never look as though a ball is being pushed off the belt.
 *
 * **This is a distance, not a speed**, and separating the two is the rewrite. The old model's travel was
 * `Z_DRIFT_SPEED * time`, so how far a ball went depended on how long it had been drifting; here it reaches exactly
 * `+-SWAY_AMPLITUDE` regardless of how fast or slow the wave runs.
 *
 * Changing this does **not** change the rhythm, and changing `SWAY_FREQUENCY_HZ` does **not** change this distance.
 */
export const SWAY_AMPLITUDE = 2;

/**
 * **Placeholder.** The largest random offset applied to a ball's starting phase, in radians.
 *
 * Every ball draws its own phase from `0 .. SWAY_PHASE_JITTER`, which is the knob that decides whether a field of balls
 * sways as one body or as a crowd. `math.pi` (180 degrees) is **fully out of phase**: no two balls stay pinned to the same
 * point of the wave, which is what a belt full of balls needs. `0` makes them start together and sway in lockstep - a whole
 * belt breathing side to side in unison, worth knowing before setting it.
 *
 * **`math.pi` is enough, even though a full circle is `2 * math.pi`.** `sin(x + pi) = -sin(x)`, so the half circle
 * `0 .. pi` already produces both branches of the wave once; drawing from the other half would only re-create phases that
 * are exact negatives of ones already possible. A designer who wants the full circle wants a random **sign**, not a wider
 * range.
 */
export const SWAY_PHASE_JITTER = math.pi;

/**
 * **Placeholder.** Time constant, in seconds, of the correction that holds a swaying ball on the wave's position.
 *
 * ## Why the derivative alone is not enough
 *
 * The tick loop writes velocity and physics integrates it. Integrating `A * omega * cos(omega * t + phase)` returns the wave
 * **plus a constant**: `A * sin(...) - A * sin(phase)` added to wherever the ball already was. So a ball spawned in a `+-3`
 * lane would sway `+-2` around *its lane*, reaching `+-5` of the `+-5.5` the surface allows, and `SWAY_AMPLITUDE` would stop
 * meaning "from the centreline". The correction is `(target - localZ) / this`, so the offset decays with this time constant
 * and nothing else: `e' = -e / SWAY_TRACK_SECONDS`.
 *
 * **It is a separate constant from the wave on purpose.** A gain scaled by the wave's own angular rate would correct faster
 * as the frequency rose, which re-couples the two numbers this rewrite exists to separate. A fixed time constant means a
 * frequency change alters only the rhythm and an amplitude change alters only the distance.
 *
 * Small values converge faster and push harder: at `1.5` the worst spawn error (`SWAY_AMPLITUDE` plus a `+-3` lane, five
 * studs) leaves at about 3.3 studs/s and is gone in roughly four time constants - about 6 seconds of an 18-second ride.
 * Large values are gentler but let a ball spend most of its life finding the wave. `0` is invalid: division by zero.
 */
export const SWAY_TRACK_SECONDS = 4;

/** **Placeholder.** The folder `PickupService` parents its pads into, created on demand. */
export const PICKUPS_FOLDER_NAME = "SpawnedPickups";

/**
 * The folder the **client** parents its temporary hit-effect carriers into, created on demand.
 *
 * Client-side and per-client on purpose: the carrier and the clone exist for one burst on one machine, are never
 * replicated, and are destroyed by `Debris` a fraction of a second later. The folder is never emptied because it never
 * holds anything — its members destroy themselves.
 */
export const HIT_EFFECTS_FOLDER_NAME = "SpawnedHitEffects";

/**
 * The folder the **client** parents its round-wide `motionBlur` clone into, created on demand.
 *
 * A folder rather than `Workspace` itself for the reason `SpawnedHitEffects` and `SpawnedPickups` exist: an arena-wide
 * particle tree among the arena's own parts is indistinguishable from scene geometry in the Explorer, and the one debugging
 * session that matters is exactly when somebody is looking there.
 *
 * **Not a child of the `EliminationZone`**, even though the clone sits at the zone's position: a `BasePart` child's `CFrame`
 * is world-space, so parenting it to the zone would not make it follow anything, and it *would* make the effect a
 * `Destroying` casualty if the zone is ever replaced in Studio. The zone's transform is read once per `Playing`; the effect
 * does not belong to it.
 *
 * Unlike `SpawnedHitEffects`, this folder holds **one** member at a time and is empty between rounds — the clone is destroyed
 * on the fade-out rather than by `Debris`.
 */
export const MOTION_BLUR_FOLDER_NAME = "SpawnedMotionBlur";

/**
 * The name of the client-only part that carries a ball's **visible skin**, created by `BallRenderController` as a child of
 * the ball it stands in for.
 *
 * A name rather than a folder path because the phantom belongs to one body: as a child of the ball it is destroyed with it,
 * and the marker controller — which poses both the markers and this skin — finds it with one `FindFirstChild`. The markers
 * themselves are children of the same ball for the same reason, so this is the existing pattern rather than a new one.
 */
export const BALL_PHANTOM_NAME = "BallPhantom";

/**
 * **Placeholder.** The ball radius, in studs, that the VFX pack was drawn against.
 *
 * Every ball effect divides the contact's radius by this and multiplies every distance in its clone by the result, so changing
 * the ball's `Size` in `ball-spawner-service` resizes the effects without touching an asset or a controller. It lives here
 * rather than in a config file because it is a property of **the pack**, not of one effect: it is the one number all three
 * effects must agree on, and a copy per config would let them disagree about what a design radius is.
 *
 * **The per-effect multiplier that rides on top of it moved out of this file** (item 177). `VFX_SCALE_MULTIPLIER` used to sit
 * below, shared by every cloned effect; it is deleted, and each effect's own number now lives in its own config
 * (`shared/config/windBoost.config.ts`, `tailWind.config.ts`, `hitEffect.config.ts`). The reason is short: one shared number
 * meant "make the hit burst legible" also resized both trails, so the value was left untouched twice. See
 * `shared/vfx-scale.ts`, whose item 101 docblock is rewritten in place to say what changed.
 */
export const BASE_BALL_RADIUS = 0.5;
