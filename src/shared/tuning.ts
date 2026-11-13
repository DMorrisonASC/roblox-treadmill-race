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
 * How many **enrolled** players a live server needs before `Intermission` is allowed to become `Waiting`. **The designer's
 * number, not a Placeholder.**
 *
 * ## Why enrolled and not connected
 *
 * `enrolledUserIds` is frozen when the enrollment window closes (`ENROLLMENT_CUTOFF_SECONDS` before the phase ends), so a player
 * who joined after that cutoff is connected and **not** racing this round. Counting connected players would let the round start
 * with one competitor and one spectator - the same broken round this guard exists to prevent, with a log line claiming the
 * count was satisfied.
 *
 * ## Why Studio is exempt
 *
 * A Studio session has one player by definition, and `spawnStudioBots` fills the field for it. Applying this rule there would make
 * every Studio test sit in `Intermission` forever - the one environment where "wait for a second human" cannot be satisfied.
 */
export const MIN_ENROLLED_PLAYERS = 2;

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
 * How long a `Playing` phase may run before the round ends on position, in seconds. **The designer's number, not a
 * Placeholder.**
 *
 * ## This reverses item 37, deliberately
 *
 * Item 37 deleted a 60-second cap of the same name. Its argument was that "a time limit that invents a result is worse than
 * no time limit", and its evidence was real: in the runs that exercised it, the cap fired while a competitor was still
 * travelling, and it named a winner the race did not support.
 *
 * **What item 37 was right about is still true** - a cap does cut rounds where an elimination was about to happen, and the
 * body it stops is not necessarily the body that would have won. That cost has not gone away and is not argued away here.
 *
 * **What has changed is where the winner comes from.** The old cap awarded the win on a different reading from the board.
 * The cap now takes its winner from `distanceFromSpawnEdge` - the same function the leaderboard ranks with - so the body named
 * at 120 seconds is the body the HUD was already showing at rank 1. The result is still *cut short* rather than earned, but it
 * is no longer a *contradiction* of the race in progress, and that was the specific failure item 37 recorded.
 *
 * The second reason is the one item 37 could not have known: an uncapped round in a Studio session can run until somebody
 * manually ends it, which makes the payout, the leaderboard and every `PostGame` transition untestable without intervention.
 *
 * ## Why it does not replace the natural end
 *
 * "Last standing" fires first and is unchanged. This is a third branch that only reaches bodies which survived the cap - so a
 * decisive round never reaches it, and the cap only decides the rounds that were never going to end.
 */
export const PLAYING_CAP_SECONDS = 120;

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
 * **Placeholder.** The drawn rate at `BALL_SPEED = 0`, in radians/second: **the part of the roll that does not depend on
 * the attribute.**
 *
 * ## Why a base term exists at all (item 196)
 *
 * `apparentSpinRate` used to be `GAIN x BALL_SPEED / BASE_BALL_RADIUS` and nothing else, so `BALL_SPEED = 0` gave no
 * rotation — and `BALL_SPEED = 0` does **not** mean "not moving". It means the ball is travelling at exactly the belt's own
 * speed *through* the tread, which is the ordinary state of a ball that has decayed for a few seconds: the log shows one at
 * `RELATIVE_SPEED = +10` toward the exit with a completely still skin. **A ball sliding across the floor with a frozen
 * texture is the most obvious render bug in the game**, and no gain can fix it, because the term that would fix it
 * (`BALL_SPEED`) is zero by definition in exactly that case.
 *
 * The physical reading is the argument: rolling speed equals **speed relative to the surface**, and on a treadmill a ball
 * holding station in the world is moving at `BELT_SPEED` relative to the tread under it. That component is a constant, so
 * the term is a constant.
 *
 * ## Why `10` and not the full `BELT_SPEED` worth
 *
 * A base of the full belt speed would draw `20 rad/s` for a ball that is merely holding station, leaving the whole
 * `BALL_SPEED` range an addition on top of a rate that already looks fast. `10` is **half** the spawn rate: a sliding ball
 * reads as rolling (about `1.6` revolutions a second) and a ball at full `BALL_SPEED_START` still reads as the fastest
 * thing on screen. The split is what makes the two states distinguishable at a glance, which is the whole point of drawing
 * the spin.
 */
export const SPIN_BASE_RAD_PER_SEC = 30;

/**
 * **Placeholder.** Speed below which a ball is treated as not moving **for the tail-wind trail**, in studs/s.
 *
 * ## Why this is its own constant (item 196)
 *
 * This threshold used to be `SPIN_DEADBAND_SPEED`, borrowed from the spin rate because both wanted "is the ball actually
 * moving". The spin rate no longer has a deadband — a ball at `BALL_SPEED = 0` rolls at `SPIN_BASE_RAD_PER_SEC`, because it
 * *is* moving relative to the tread — so the two questions have come apart and must not share a name. A trail is about the
 * ball losing ground in the world; a roll is about the ball meeting the floor. They coincide today and the constant is
 * named for the one that still needs it.
 *
 * ## The value, and what it protects
 *
 * `0.5` studs/s is two orders of magnitude above the `0.003` studs/s park residual the `spin-probe` log reports on a
 * resting body, and an eighth of the belt's steady-state drift, so a genuinely moving ball never falls inside it. Above it
 * `writeBoosted` may raise `TailWind`; below it the trail is off, which is what stops a parked ball trailing wind it is not
 * generating.
 */
export const TAIL_WIND_MIN_BALL_SPEED = 0.5;

/**
 * **Placeholder.** Multiplier on `BALL_SPEED / BASE_BALL_RADIUS` — the **speed-following part** of the drawn rate.
 *
 * ## The formula, as it actually runs (rewritten in place, item 196)
 *
 * `apparentSpinRate` returns
 * `min(APPARENT_SPIN_MAX_RAD_PER_SEC, SPIN_BASE_RAD_PER_SEC + APPARENT_SPIN_GAIN * speed / BASE_BALL_RADIUS)`,
 * where `speed` is the body's `BALL_SPEED` attribute. At the `0.5`-stud design radius the second term is
 * `2 * GAIN * speed`, so with `GAIN = 0.5` **the drawn rate is simply `10 + BALL_SPEED`**: `10 rad/s` at rest, `20` at the
 * spawn speed of `10`, `28` at a rocket's `18`.
 *
 * **There is no deadband any more.** The old model returned exactly `0` below `SPIN_DEADBAND_SPEED`, which was the right
 * answer to "should a *parked* ball spin" and the wrong answer to "should a *sliding* ball roll" — and `BALL_SPEED = 0` is
 * the sliding case, not the parked one. The phase now decides: `ball-render-controller` and `marker-spin-controller` stop
 * accumulating rotation outside `Playing`, so a ball in `Waiting` or `PostGame` is still, and a ball inside `Playing` always
 * turns. `SPIN_DEADBAND_SPEED` is deleted; its one remaining reader (the tail-wind gate) now reads
 * `TAIL_WIND_MIN_BALL_SPEED`, its own constant with its own reason.
 *
 * ## Why `0.5` and not `1` — the no-slip argument does not survive a base term
 *
 * `1` was chosen as the **no-slip** rate: the tread is drawn travelling at `BELT_SPEED`, so for the contact point to keep up
 * its velocity must be `BALL_SPEED`, i.e. `omega * radius`, i.e. `GAIN = 1`. That argument is only about the
 * speed-following term, and adding a constant term means the *total* is no longer the rolling rate no matter what the gain
 * is. The total is the thing that has to be legible, and `0.5 + base 10` puts every speed in the range the eye can read:
 *
 * - **`20 rad/s` at `BALL_SPEED = 10`**, which is the anchor the earlier rounds established as the legible rate — about
 *   `3.2` rev/s, `19` degrees per frame at 60 Hz, unambiguous on a six-textured sphere.
 * - **`28 rad/s` at a rocket's `ROCKET_TARGET_SPEED = 18`**, still inside the legible band.
 *
 * **Above `BALL_SPEED ≈ 21` the rate is inside the aliasing fold**, and that is stated rather than hidden: a sprinter's
 * `30` draws `40 rad/s`, and the `BALL_SPEED_MAX = 50` safety ceiling draws `60`. No base-plus-linear split can put `20` at
 * speed `10` *and* `31` at speed `50`; the anchor is what matters because almost every drawn frame of a round is between
 * the seeded start and a few points of decay. A rate that folds during a boosted second is a smaller fault than one that
 * folds at the green light, which is what the previous gain of `3` did.
 *
 * **The anchor was not actually being met before this change, and that is worth recording.** `APPARENT_SPIN_GAIN` was `3`,
 * so `BALL_SPEED = 10` drew `60 rad/s` — `9.5` rev/s, `57` degrees per frame, which is exactly the aliasing regime `3` was
 * rolled back for twice. Halving the gain and adding the base is what lands the ordinary range back inside the legible band.
 *
 * **The literal "20x faster" was tried and rejected on arithmetic, not taste.** Twenty times the old `3.3 rad/s` is
 * `66 rad/s`, the same fold — the defect `3` was rolled back for.
 *
 * **The rest of the visual coupling lives in `BELT_TEXTURE_SCROLL_MULTIPLIER`.** No ball rotation can match a tread drawn
 * faster than the belt model's `BELT_SPEED`; the two only agree at a gain of `1` with no base term, which is a painting no
 * longer strictly true and is called out here rather than silently abandoned.
 */
export const APPARENT_SPIN_GAIN = 0.3;

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
 * **Placeholder.** Ceiling on the drawn angular rate, radians/second ? **and it is now the aliasing fold itself, not a distant
 * safety net (item 200).**
 *
 * ## The arithmetic that sets it
 *
 * A sphere carrying six face textures repeats every `90` degrees, so a 60 Hz frame may advance it **at most `45` degrees**
 * before two neighbouring frames land on the same-looking face and the eye reads the ball as *not turning at all* ? the report
 * that has come back more than once. `45` degrees a frame is `2700` degrees/second, `47` rad/s; `31` draws `29.6` degrees a
 * frame, which leaves margin for a hitch.
 *
 * ## Why `90` was wrong
 *
 * It was described as "a safety net, not a rate", which was defensible while the fastest ball drew `40` rad/s. It stopped
 * being defensible when `BOOST_TARGET_BALL_SPEED` moved to `80`: the rate is then `10 + 80 = 90` ? **86 degrees of rotation per
 * frame**, deep inside the fold. An aliased ball is not "a fast ball", it is a ball that appears frozen, which is the symptom
 * this ceiling exists to prevent.
 *
 * ## Clamping is not the compromise the earlier docblock claimed
 *
 * That note argued clamping "would make a fast ball stop turning while it kept moving, which looks worse than the alias". The
 * comparison is between a ball drawn at a constant, obviously-fast rate and a ball drawn as a still image; the still image is
 * worse, and it is also the state that becomes a bug report. The speed-following part is what gives, and only above about
 * `BALL_SPEED = 21` ? a boosted ball rather than an ordinary one.
 */
export const APPARENT_SPIN_MAX_RAD_PER_SEC = 31;

/**
 * **Placeholder.** Physical angular speed above which the drawn axis is taken from the body's own spin.
 *
 * Below this, `AssemblyAngularVelocity.Unit` is numerically meaningless — a vector whose length is
 * a rounding artefact has no trustworthy direction, and normalising it would aim the markers at
 * whatever direction the last float bit happened to point. 0.05 rad/s is ~0.008 rev/s: far below any
 * real rotation, far above solver noise.
 *
 * When the spin is below this the axis falls back to the direction of travel, and then to the belt's own
 * `+RightVector` when the body is not moving either. That chain still matters now that the rate has no deadband and the
 * *phase* holds the angle instead: the axis is computed every frame so the log line can name which source it used, and
 * because a ball that starts moving must begin turning about a defined axis on its first moving frame rather than one
 * frame later.
 */
export const SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC = 0.05;

/**
 * **Placeholder.** Speed above which the fallback axis prefers the ball's travel over the belt's axis.
 *
 * `0.5` studs/s — the same number as `TAIL_WIND_MIN_BALL_SPEED`, but a different job: that one decides whether a trail is
 * drawn at all, this one decides *which way* the markers turn once they do. They coincide because both answer "is the ball
 * really moving", and there is no reason for a ball to be turning while its direction is still being taken from the belt
 * rather than from itself.
 *
 * **This was `SPIN_DEADBAND_SPEED`'s number until item 196**, when the spin rate's deadband was deleted: the rate no
 * longer asks whether the ball is moving (a ball at `BALL_SPEED = 0` is sliding and must roll), so the two questions came
 * apart and this one kept its own name.
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
 * that the fallback axis reads (`SPIN_FALLBACK_MIN_SPEED`) rather than a rate. The rate is a function of `BALL_SPEED`
 * alone, so the smoothed speed no longer has a path into it — and that is why the `SPIN_DEADBAND_SPEED` this docblock used
 * to justify is gone (item 196).
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
export const PICKUP_SIZE = new Vector3(20, 20, 20);

/**
 * **Placeholder.** How many pads a round tries to keep on the belt at once.
 *
 * ## This used to be the spawner count, and deliberately is not any more (item 191)
 *
 * The old cap was `BallSpawnerService.getBoundSpawners().size()` — **one pad per lane** — so the pad count and the
 * competitor cap were the same number by accident of construction: both read how many spawner parts the place happened to
 * hold. They answer different questions. A pad is scenery a ball may touch; it is not a body, it holds no `BALL_SPEED`, and
 * it consumes no slot against `MaxLiveBalls` (`50`). Twelve pads with eight spawners is **twelve pads and eight competitors**,
 * and neither number constrains the other.
 *
 * **The coupling is intentionally gone, not merely dormant.** A future round that wants "one pickup per lane" back must write
 * that as its own stated constant with its own reason. Reconnecting this one to `getBoundSpawnerCount()` would silently cap
 * the pads at whatever the scene contains, which is the same class of bug item 45 was fixing from the other side — a count
 * that comes from the place cannot say what it meant.
 *
 * ## Why the count is still low enough to place by rejection rather than by a grid
 *
 * A 20-stud pad on a `336 x 173` belt has centres ranging over `316 x 153`; a grid packing of the surface holds
 * `floor(336 / 20) x floor(173 / 20) = 16 x 8 = 128` pads, so twenty pads occupy about a sixth of the packable cells - and
 * every pad's *drawn* radius, plus `PICKUP_EDGE_MARGIN`, is what has to clear its neighbours, not its centre. That is still
 * sparse enough that almost every draw lands free, which is what makes `PICKUP_PLACEMENT_ATTEMPTS` a guard against a broken
 * scene rather than a load-bearing part of the algorithm.
 *
 * **Raised from 12 to 20 in item 220, and the reason is steering.** With the decorative sway gone, the only lateral motion a
 * player's ball has is what that player chooses, so what makes steering *matter* is how often a reason to cross the belt
 * arrives. Twelve pads over `333 x 173` is one per `4,800` square studs; twenty is one per `2,880` - a target roughly every
 * 1.5 seconds of belt travel rather than every 2.5. The shortfall line reports it if the placement cannot keep up.
 */
export const PICKUP_MAX_COUNT = 20;

/**
 * **Placeholder.** How far the drawn disc's edge is kept from the belt's edge, in studs — a margin *beyond* the arithmetic
 * that keeps the picture on the belt.
 *
 * ## Why a margin exists at all (item 201)
 *
 * `pickupBounds` subtracts the largest drawn radius, which makes a pad at the region's corner have its disc **tangent** to the
 * belt edge — geometrically inside, and visually indistinguishable from hanging over. Two reports in a row described pads "off
 * the belt" while every placement was, by arithmetic, inside by up to `2.2` studs, and the tangency is why: a circle that
 * touches a boundary has no visible belt between it and the drop, and at the game camera's shallow angle the far edge is
 * compressed to a few pixels.
 *
 * So the bound subtracts `drawRadius + PICKUP_EDGE_MARGIN`. The margin is the width of belt a player can see *between* the
 * paint and the edge, which is the thing that makes "on the belt" legible rather than merely true.
 *
 * ## Why `12`
 *
 * Wider than the disc's own radius (`10`) by a little, so a pad near the region's corner still shows a gap at least as wide as
 * the pad is from the edge. On a `333 x 173` belt that leaves `+-144.5` and `+-64.5` — still a `289 x 129` band, which packs
 * `12` pads with room to spare (`14 x 6 = 84` grid cells at a 20-stud pad).
 */
export const PICKUP_EDGE_MARGIN = 12;

/**
 * **Placeholder.** Draws allowed per pad before that pad is reported as unplaceable.
 *
 * ## Why a bound, and why the bound is not the mechanism
 *
 * "The band is sparse, so overlap is rare" is a probability, not a guarantee, and an unbounded retry loop is a loop that can
 * starve the thread that runs it. Twenty draws against a surface that packs 128 pads is a count that will not be reached in a
 * well-formed scene; reaching it means the scene is wrong (a pad larger than the belt, a belt shrunk in Studio, a pad count
 * raised past what the surface holds). That case is **reported with a count**, not retried forever and not swallowed: a pad
 * that quietly did not appear is indistinguishable from a placement bug.
 */
export const PICKUP_PLACEMENT_ATTEMPTS = 20;

/**
 * **Placeholder.** Seconds between top-up attempts while `Playing`.
 *
 * A top-up never exceeds `PICKUP_MAX_COUNT`, so this is a *replacement* cadence, not a spawn rate: a
 * round that runs forever holds at most `PICKUP_MAX_COUNT` pads, and a pad taken at `t = 3 s` is replaced at the
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
 * to tell from the pad it marks. It is not a crowding risk in practice: `PickupService` places pads with a non-overlap rule
 * (item 191), so no two colliders share space, and the sprite is centred on its own pad rather than reaching sideways.
 */
export const PICKUP_SPRITE_STUDS = 2.6;

/**
 * **Placeholder.** How far above the pad's centre the sprite floats, in studs.
 *
 * The pad is `PICKUP_SIZE.Y` tall and a ball is a stud across, so a sprite sitting at the pad's origin would be behind the
 * ball that is collecting it. This lifts it clear without putting it above the camera's eye line.
 */
export const PICKUP_SPRITE_LIFT_STUDS = 3;

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
 * smooth that edge is. There is nothing left to buy by raising it, and the cost of a higher value is paid once per pad.
 *
 * **The canvas is `4000 x 4000`, and this docblock used to say `400 x 400` (corrected in item 202).** The `400` was true of
 * the 2-stud *ring* the annulus drew; the disc is `pickupDiscDiameter(padSize)` — `20` studs for `PICKUP_SIZE` — so
 * `200 x 20 = 4000` per axis, and one pad's fill is a 16-megapixel raster. That is a **memory** cost, not the visibility
 * bug: it is paid once per pad, it is cheap on the GPU precisely because the content is one flat colour, and item 202
 * deliberately left it alone rather than bundling a texture-budget change into a rendering fix.
 */
export const RING_PIXELS_PER_STUD = 200;

/**
 * **Placeholder.** How far from the camera, in studs, the ring's `SurfaceGui` is allowed to draw.
 *
 * **The engine's default is `1000`, and it is a hard cut rather than a fade.** From the Roblox documentation for
 * `SurfaceGui.MaxDistance`: *"This property controls how far from the camera the SurfaceGui will be displayed before it
 * stops rendering. A value of `0` means there is no limit and it will render infinitely far away. The default value of
 * `1000` works fine for most cases."* A pad that stops drawing past a fixed distance is exactly the reported symptom, and
 * the belt alone is `333` studs long, so the limit is removed rather than reasoned around.
 *
 * **`1e6` rather than the documented `0`.** The docs say both mean "no limit", but `0` also reads to the next person as
 * "cull at zero distance" — one careless "fix" away from switching the ring off. A million studs is past any camera this
 * place can have, and says what it means without a reader needing the documentation.
 *
 * The same check applies to the sprite's `BillboardGui`, whose `MaxDistance` **defaults to infinity** — that asymmetry is
 * why only the ring had a finite limit to remove.
 */
export const PICKUP_RING_MAX_DISTANCE = 1e6;

/**
 * **Placeholder.** The footprint ring's own vertical thickness, in studs.
 *
 * It exists only because a `SurfaceGui` needs a face to sit on, and a `Part` needs a size on all three axes. The cylinder is
 * stood on its side, so this is the extent along world **Y**: the part spans `RING_LIFT_STUDS` to
 * `RING_LIFT_STUDS + RING_THICKNESS_STUDS` above the pad's bottom face, and the `SurfaceGui` is on its top (`Face = Right`
 * after the turn).
 *
 * **The value is `2`, and this docblock used to say `0.05` (corrected in item 202).** The old text argued for "a twentieth
 * of a stud: thin enough that the ring reads as paint on the floor rather than as a plate" — at `2` it *is* a plate, and the
 * consequence is worth stating because nothing else in the tree records it: with `BELT_SURFACE_THICKNESS = 0.1` and
 * `RING_LIFT_STUDS = 0.12`, the painted face sits **2.22 studs above the belt's top surface**, not the 0.12 the lift alone
 * suggests. A ball standing on a pad therefore covers the disc for the bottom 2.22 studs of its own 20-stud height, which is
 * the mechanism item 147's "the ball hides the middle of a disc" is really describing.
 *
 * Not changed in item 202: it is a shape decision, and the round that fixed the ring's distance cut was not the round to
 * retune it.
 */
export const RING_THICKNESS_STUDS = 2;

/**
 * **Placeholder.** How far above the pad's bottom face the ring floats, in studs.
 *
 * **Not zero, and the reason is a coplanarity, not a look.** `PickupService.positionFor` puts the pad's bottom face exactly
 * on the surface a ball rests on — the invisible moving collider, itself `BELT_SURFACE_THICKNESS` thick and sitting on the
 * belt. A ring at exactly that height z-fights with the thing it is lying on: two coplanar surfaces, decided per frame, per
 * pixel.
 *
 * **The value is `0.12`, and this docblock used to say `0.02` (corrected in item 202).** The argument above still holds, but
 * the number no longer does the work it claims: `RING_THICKNESS_STUDS = 2` means the painted face ends up `2.22` studs above
 * the belt, so the lift is a rounding error next to the thickness. It is left as written because it is the right *rule* —
 * never coplanar — and `.12` is still above the depth buffer's resolution at belt distances.
 */
export const RING_LIFT_STUDS = 0.12;

/**
 * **Placeholder.** The pickup marker's diameter on screen, in pixels (item 219).
 *
 * ## Why pixels, and why this is a different mechanism from the ring
 *
 * A `BillboardGui`'s `Size` is not a `GuiObject`'s: its **scale** components are studs in 3D space and shrink with distance,
 * while its **offset** components are screen pixels pinned to a fixed on-screen size. The sprite above the pad uses scale
 * (`PICKUP_SPRITE_STUDS`), which is why it is a `19`-pixel speck from the game camera's `260-390` studs - the number item 200
 * measured and could not explain.
 *
 * The marker therefore uses **offset only**: `28` pixels at any distance, which is what "a marker that reads from the camera"
 * means. No `DistanceStep`/`SizeOffset` machinery is needed, and none is used - see `buildMarker` in
 * `client/controllers/pickup-sprite-controller.ts` for why those two properties do not do what their names suggest.
 */
export const PICKUP_MARKER_PIXELS = 28;

/**
 * **Placeholder.** How far above the pad's top face the marker floats, in studs (item 219).
 *
 * **One stud, not the sprite's three.** The sprite is a sign held above the pad so a ball cannot hide it; the marker is a
 * locator read from far away, and the higher it floats the more it reads as a separate object rather than as a dot on the pad.
 * A ball standing on a pad does cover it - that pad is about to be collected, which is item 147's argument for the ring's
 * fill applied to the same geometry.
 */
export const PICKUP_MARKER_LIFT_STUDS = 1;

/**
 * **Placeholder.** The marker's fill transparency (item 219).
 *
 * Denser than `RING_TRANSPARENCY` (`0.6`) on purpose: the ring is read from a few studs away and is paint on the floor, while a
 * `28`-pixel dot on a dark moving belt at `300` studs needs more than `40%` of its colour to read as a dot at all.
 */
export const PICKUP_MARKER_TRANSPARENCY = 0.3;

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
export const BALL_SPEED_DECAY_RATE = 2;

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
export const BALL_SPEED_MAX = 100;

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
export const BALL_COLLISION_POP_UPWARD_SPEED = 80;

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
 * **Placeholder.** Peak speed one contact gives each body, in studs/second, **in whichever horizontal direction the contact
 * normal points**.
 *
 * ## Why this is a number at all, when the engine already separates the bodies
 *
 * Because the engine's separation is erased. The model sets the lateral component of every ball's velocity on every tick
 * (item 151) and replaces the along-belt component on every tick, so a collision imparts one physics step of motion — about
 * `1/60` of a stud — and the next tick replaces it. A Studio log showed `hit` and `pop` lines with no visible movement,
 * which is that arithmetic, not a missing shove in the engine.
 *
 * ## Direction: full plane, not sideways (item 203)
 *
 * This used to be described as "peak sideways speed", and it was: the writer projected the contact normal onto the belt's
 * lateral axis and dropped the rest, so a rear-end hit — whose normal is almost entirely along the belt — shove almost
 * nothing. Both components are applied now, so the same number describes a push in any direction in the belt plane, and a
 * head-on contact is a push along the belt.
 *
 * **The effective strength of an along-belt contact is therefore larger than it was**, by roughly the inverse of the
 * lateral projection it used to be reduced to. The number is deliberately unchanged in item 203 — this is a direction fix,
 * and the retune is its own round.
 *
 * ## The displacement this buys
 *
 * A shove of `s` decaying with time constant `T` moves a body `s * T` studs in total. At the current `100` and
 * `BALL_COLLISION_SHOVE_DECAY_SECONDS = 1` that is **100 studs**, or its full length in whichever direction it points, on a
 * belt `173` wide and `333` long. A docblock here claimed `10` studs and "about 2.8 studs per second at the peak, which is
 * below `BELT_SPEED`"; that described the value this constant shipped with in item 175's retune, not `100`, and both claims
 * are false at `100` (the peak is `100` studs/second, ten times `BELT_SPEED`). Corrected in item 203, value left alone.
 *
 * This was `5` / `0.3` (1.5 studs) when it shipped in item 175, against 1-stud balls: 1.5 studs is one and a half *ball
 * diameters* there, and a tenth of one on a 20-stud ball, which is why it was retuned with the size change. The pair is one
 * displacement (`s * T`), so raising either without the other moves twice.
 *
 * **What settles a lateral shove now (item 220).** The sway's position correction used to walk a shoved ball back toward its
 * wave. The sway is gone, and the lateral axis belongs to the player's steering (`STEER_SPEED`); what keeps a shove from
 * compounding with it is the tick's `sub(across * carriedLateral)`, which rewrites the axis every tick so only the decaying
 * impulse (its own time constant, below) survives. It does nothing about the along-belt component: that axis has no lane to
 * return to, so an along-belt shove is a real change of position on the belt, bounded only by the belt's ends.
 */
export const BALL_COLLISION_SHOVE_SPEED = 100;

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
export const BOOST_TARGET_BALL_SPEED = 80;

/**
 * **Placeholder.** How often a bot's ball sways across the belt: **full left-right cycles per second**.
 *
 * ## What this governs now (item 221, restoring items 107/151/153 for bots only)
 *
 * A **player's** ball is steered - `SteerController` sends an axis and `stepBallSpeeds` writes `axis * STEER_SPEED` into the
 * lateral component. A **bot's** ball has no player behind it, so `OwnerUserId` is negative (a `Debug#N` body) or absent (a
 * `decoy` twin), and it gets this wave instead:
 *
 * `z(t) = SWAY_AMPLITUDE * sin(2 * pi * SWAY_FREQUENCY_HZ * t + phase)`
 *
 * where `t` is that ball's own time since it spawned and `phase` is its random start - see `SWAY_PHASE_JITTER`. The tick
 * loop writes the **derivative** of that position, `SWAY_AMPLITUDE * omega * cos(omega * t + phase)` with
 * `omega = 2 * pi * SWAY_FREQUENCY_HZ`, because physics integrates velocity and the derivative is the only thing that makes
 * the position follow the wave. Plus a correction toward the wave's position, explained on `SWAY_TRACK_SECONDS`.
 *
 * **Why the wave survives at all after item 220 removed it.** Removing it was right for player bodies: a sine wave over a
 * player's input is two writers to one axis, and the player loses. A bot has **no input to fight** - it has no intent at all -
 * so for a bot the wave is not interference, it is the only lateral motion the body will ever have. A field of bots sitting
 * perfectly in their lanes is what "the arena looks empty" describes.
 *
 * **Frequency and amplitude are independent, which is the point of the rewrite.** `0.1` here is one full cycle every
 * `1 / 0.1 = 10` seconds; change it alone and a ball sways more or less often and nothing else moves. Change
 * `SWAY_AMPLITUDE` alone and it covers more or less ground per sway at the same rhythm.
 *
 * **This is the base rate, not every ball's rate (item 153).** Each bot draws its own multiplier from
 * `SWAY_FREQUENCY_JITTER`, because a field sharing one period can only ever be a fixed arrangement of offsets — see that
 * constant for why the phase jitter alone was not enough.
 *
 * ## The numbers
 *
 * At `0.1` Hz with `SWAY_AMPLITUDE = 2`, peak lateral speed is `A * omega = 1.26` studs/s against an along-belt speed of
 * up to 10 - a slow drift with a rhythm, well under `STEER_SPEED`'s 25, so a swaying bot is a *target* a steering player can
 * cross to rather than an opponent that dodges.
 *
 * **The axis.** Lateral is world Z - the belt's local `+Z`, which is `RightVector:Cross(UpVector)`.
 */
export const SWAY_FREQUENCY_HZ = 0.1;

/**
 * **Placeholder.** How much each bot's sway frequency may differ from `SWAY_FREQUENCY_HZ`, as a fraction of it.
 *
 * A phase offset alone gives a field of **identical periods**, and identical periods never drift apart: two balls stay
 * exactly the offset they were drawn with for the whole round, so a field drawn from `0 .. pi` still reads as synchronised. A
 * **frequency** difference is the only thing that makes two balls drift in and out of step. `0.3` gives each ball a period
 * between `10 / 1.3 = 7.7 s` and `10 / 0.7 = 14.3 s`, so the arrangement never repeats within a ride.
 *
 * `0` restores one period for the field, phase offsets only.
 */
export const SWAY_FREQUENCY_JITTER = 0.3;

/**
 * **Placeholder.** How far from the belt's centreline a swaying bot reaches, in studs of **code-frame Z**.
 *
 * Code-frame Z runs `-6 .. +6` across this belt and a 20-stud ball sits fully on the surface within `+-5.5`, so `2` keeps a
 * ball between `-2` and `+2` - leaving **3.5 studs of margin on each side**. That margin is the point of the number: a bot's
 * wave must never look as though the belt is pushing it off.
 *
 * **This is a distance, not a speed.** A ball reaches exactly `+-SWAY_AMPLITUDE` regardless of how fast or slow the wave
 * runs; changing this does not change the rhythm, and changing `SWAY_FREQUENCY_HZ` does not change this distance.
 */
export const SWAY_AMPLITUDE = 2;

/**
 * **Placeholder.** The largest random offset applied to a bot's starting phase, in radians.
 *
 * Every bot draws its own phase from `0 .. SWAY_PHASE_JITTER`, which is the knob that decides whether a field of bots sways
 * as one body or as a crowd. `math.pi` (180 degrees) is **fully out of phase**; `0` makes them sway in lockstep, a whole belt
 * breathing side to side in unison.
 *
 * **`math.pi` is enough, even though a full circle is `2 * math.pi`.** `sin(x + pi) = -sin(x)`, so the half circle already
 * produces both branches of the wave once; drawing from the other half would only re-create phases that are exact negatives
 * of ones already possible.
 */
export const SWAY_PHASE_JITTER = math.pi;

/**
 * **Placeholder.** Time constant, in seconds, of the correction that holds a swaying bot on the wave's position.
 *
 * ## Why the derivative alone is not enough
 *
 * The tick loop writes velocity and physics integrates it. Integrating `A * omega * cos(omega * t + phase)` returns the wave
 * **plus a constant**: `A * sin(...) - A * sin(phase)` added to wherever the ball already was. So a bot spawned in a `+-3`
 * lane would sway `+-2` around *its lane*, reaching `+-5` of the `+-5.5` the surface allows, and `SWAY_AMPLITUDE` would stop
 * meaning "from the centreline". The correction is `(target - localZ) / this`, so the offset decays with this time constant
 * and nothing else: `e' = -e / SWAY_TRACK_SECONDS`.
 *
 * **It is a separate constant from the wave on purpose.** A gain scaled by the wave's own angular rate would correct faster
 * as the frequency rose, which re-couples the two numbers. A fixed time constant means a frequency change alters only the
 * rhythm and an amplitude change alters only the distance.
 *
 * `0` is invalid: division by zero.
 */
export const SWAY_TRACK_SECONDS = 4;

/**
 * **Placeholder.** How fast a player's steering moves their ball across the belt, in studs per second.
 *
 * ## What replaced the sway, and why (item 220)
 *
 * Items 107, 151 and 153 gave every ball a sine-wave lateral offset, then a per-ball frequency so the field did not read as
 * synchronised. The reasoning was sound for the game it was written in: **a field of identical spheres in identical lanes
 * needs lateral motion from somewhere**, or it reads as a conveyor rather than as a race.
 *
 * **That premise is gone for player bodies.** A player now drives their own ball's lateral position, so the field is varied
 * because eight people are steering, not because a wave moved them. Two writers to one axis is the failure the playtest
 * reported - "the game plays itself" - and the decorative one is the one to remove from a *player's* ball: a sine wave
 * fights the player holding a lane toward a pickup.
 *
 * **It is not gone for bots (item 221).** A bot has no intent to fight, so the wave is the only lateral motion it will ever
 * have; removing it from bot bodies left the belt reading as empty. The five sway constants above are back and apply to
 * bodies with no positive `OwnerUserId`; this number applies to bodies with one. One axis, two sources, and the source is
 * decided by whether anybody is holding a key. The history is kept here because the reasoning will be re-invented by the next reader who sees a
 * uniform field: **the answer to that is bot AI or denser pickups, not a sine wave over the player's input.**
 *
 * ## The number
 *
 * At the current `45` studs/s a ball crosses the belt's `173` studs in **3.8 s** edge to edge, and reaches either edge from the
 * centre in **1.9 s**. A lane change of 25 studs - one ball width plus clearance - takes **0.56 s**, against a ball closing
 * along the belt at `BELT_SPEED = 10`: a player can dodge a single contact with a fraction of a second's notice, and cannot
 * outrun two. That is the intended reading: steering is a choice with a cost, not a strafe.
 *
 * **The arithmetic above is stated for the value that ships.** It has been `25` and is `45`; retuning this constant means
 * redoing these three numbers, and a docblock that still says `25` is how a designer ends up tuning against a value the game
 * does not use.
 *
 * **The along-belt axis is not steerable.** Forward motion is `BALL_SPEED`, decayed every tick, and this number never touches
 * it - see `stepBallSpeeds` for the two-component write.
 */
export const STEER_SPEED = 45;

/**
 * **Placeholder.** How much `BALL_SPEED` a held slow input removes, in studs per second per unit of `slowAxis`.
 *
 * ## The arithmetic
 *
 * The tick's natural decay is `BALL_SPEED_DECAY_RATE` (`0.1`/s). At `SLOW_DRAIN_RATE = 5` a fully held slow input drains
 * **fifty times** as fast, so a ball at `BALL_SPEED = 10` reaches `BALL_SPEED_MIN = 0` in **2 s**, and a ball at the
 * `BALL_SPEED_START` ceiling of `12` takes **2.4 s**.
 *
 * **What that does to the ball is the mechanic, not a bug.** `relative = BALL_SPEED - BELT_SPEED` and the along-belt velocity
 * is `-relative`, so dropping `BALL_SPEED` below the reference moves the ball **toward the exit edge** - away from where it
 * spawned, not back toward it. With `BALL_SPEED` at `0` it travels that way at the full `BELT_SPEED = 10`. See
 * `BALL_SPEED_DECAY_RATE` for the axis statement: **low speed is the losing direction**, and a pickup is what buys a ball
 * back toward the spawn end.
 *
 * So this control is a **brake that costs ground**, and the ball's own spin reports it honestly: the roll is driven by
 * `BALL_SPEED`, so the ball looks like it is turning more slowly while the belt keeps moving under it.
 *
 * Two seconds is the whole budget, so this reads as a **brake you hold for a moment**, not a lever you toggle and leave on.
 * Held for the full two seconds the ball has spent all of its speed and is travelling toward the exit at belt speed; a
 * designer who wants a gentler brake halves this, and one who wants a trap doubles it.
 *
 * It is a term in the same `tickDelta` sum the powers use, not a second clamp: one writer per tick (item 74), so a power's
 * delta and this drain land in the same arithmetic and the single `math.clamp` applies to the total.
 */
export const SLOW_DRAIN_RATE = 5;

/**
 * **Placeholder.** The upward velocity a player's jump gives their ball, in studs per second.
 *
 * ## The same number as `BALL_COLLISION_POP_UPWARD_SPEED`, deliberately as a separate value
 *
 * `BALL_COLLISION_POP_UPWARD_SPEED` is `80` - the vertical impulse a qualifying ball-to-ball contact gives both bodies
 * (item 173). This constant is **`80` as its own literal**, and the two are kept apart on purpose: a designer retuning the
 * pop's strength must not silently retune the jump, and vice versa. The jump is a player's input and the pop is a collision
 * outcome, so they are different decisions that happen to agree today.
 *
 * **Do not write this as `const JUMP_IMPULSE = BALL_COLLISION_POP_UPWARD_SPEED`.** The tree's rule for two values that share
 * a number by coincidence is two constants, each with a docblock naming the other - the same argument `TINTS` makes about
 * two colours that happen to be equal.
 *
 * ## The arc
 *
 * At `Workspace.Gravity = 196.2` (the engine default) an upward velocity of `80` gives airtime
 * `2 * 80 / 196.2 = 0.816 s` and an apex of `80^2 / (2 * 196.2) = 16.3` studs - about four-fifths of a 20-stud ball's
 * diameter above where it started, which clears a contact and is visible from the camera without reading as a launch.
 */
export const JUMP_IMPULSE = 80;

/**
 * **Placeholder.** The minimum interval between two accepted player jumps, in seconds.
 *
 * ## Why it is longer than the airtime
 *
 * Airtime at `JUMP_IMPULSE = 80` is `0.816 s`, so `0.9` guarantees the ball has landed before another jump is accepted: **no
 * double jump**, without a grounded check and without asking the physics engine whether the ball is touching anything.
 *
 * **It is a lever, not a derivation.** If `JUMP_IMPULSE` is retuned the airtime moves and this number does not, which is the
 * intended shape: a designer who makes the jump a 40-stud hop gets an over-long cooldown and lowers this, one who makes it a
 * 160-stud launch raises it. Deriving the cooldown from the impulse would be one number pretending to be two.
 *
 * The gate lives on the **server** - the client sends on every press and is refused silently. A client-side cooldown would put
 * the only rate limit on the side of the wire a hack can delete.
 */
export const JUMP_COOLDOWN_SECONDS = 0.9;

/**
 * **Placeholder.** The colour a ball is painted when its id has no entry in `BALL_COLORS` (item 226).
 *
 * **Near-white, and deliberately not one of the ten.** A body with no `ChosenBallId` - a `Debug#N` spawned before the debug
 * path drew an id, or any body built without one - has no ball to be, so the honest colour is "unpainted" rather than a
 * plausible-looking member of the palette. Near-white also cannot be mistaken for a *rarity* colour, which is what every card
 * border still uses.
 *
 * `ball-color.spec.ts` asserts every `BALL_POOL` id has a colour, so this is only reachable for an id the pool does not have.
 */
export const BALL_COLOR_FALLBACK = Color3.fromRGB(240, 240, 240);

/**
 * **Placeholder.** The upward velocity a trampoline gives a player character, in studs per second.
 *
 * ## The arithmetic
 *
 * At `Workspace.Gravity = 196.2` (the engine default) a launch of `130` peaks at `130^2 / (2 x 196.2) = 43.1` studs and hangs
 * for `2 x 130 / 196.2 = 1.33 s`. A default R15 character is about 5 studs tall, so that is roughly eight body heights - a
 * launch rather than a step up, and short enough that a player is back on the pad before the joke wears out.
 *
 * **The value is a launch speed, not a height.** A designer who wants a specific apex computes
 * `sqrt(2 x GRAVITY x height)`; halving this quarters the height, because height goes as the square. `130` is about twice the
 * height the `100` of items 227-229 actually produced (`31.5` studs including that build's own launch window), which is the
 * step the playtest asked for after `170` overshot the lobby.
 *
 * **The real apex is higher than the ballistic number**, because the servo holds this velocity for
 * `TRAMPOLINE_LAUNCH_SECONDS` before letting go: `130 x 0.06 + 43.1 = 50.9` studs. The launch window is part of the height,
 * not an implementation detail.
 *
 * **`TRAMPOLINE_COOLDOWN_SECONDS` is deliberately far below the airtime** - see there for why the longer value it used to hold
 * refused exactly the touch that should always bounce.
 */
export const TRAMPOLINE_BOUNCE_VELOCITY = 130;

/**
 * **Placeholder.** How long the launch servo holds its target velocity, in seconds.
 *
 * ## Why the launch has a duration at all
 *
 * The launch is a `LinearVelocity` constraint rather than a velocity write, because a write loses a race with the humanoid
 * controller: the controller rewrites the root assembly's velocity every step, so whether this handler's write is the last word
 * depends on where in the step it landed. That is item 231 - the "short bounce, then a higher one" a playtest reported, from a
 * handler that was demonstrably running. A constraint is solved *after* the controller has written, so it always wins, but
 * only for as long as it is enabled.
 *
 * `0.06` is four physics steps at 60 Hz: the shortest window that survives one dropped step on a busy server, and short enough
 * that the character is back under pure ballistics well before the apex.
 *
 * ## What it adds
 *
 * `130 x 0.06 = 7.8` studs of rise at a held velocity, on top of the ballistic arc. See `TRAMPOLINE_BOUNCE_VELOCITY`.
 */
export const TRAMPOLINE_LAUNCH_SECONDS = 0.06;

/**
 * **Placeholder.** The maximum upward force the launch servo may apply, in newtons.
 *
 * ## Why it is a number at all
 *
 * A `LinearVelocity` with its force limit switched off applies an unlimited force on *every* axis it targets, which is how a
 * velocity constraint ends up cancelling a character's horizontal walk. The alternative is a per-axis limit with force on `Y`
 * only, and that needs a magnitude.
 *
 * ## The arithmetic
 *
 * An R15 rig masses roughly `15`. Holding a launch against gravity needs `m x g = 15 x 196.2 = 2943` N, and *restoring* a
 * velocity the controller has just zeroed within a single step needs `m x v / dt = 15 x 130 / 0.0167 = 116,766` N. `5 x 10^5`
 * is about four times the second figure, which is the one that matters - the servo targets a velocity, so surplus force is
 * never a bigger launch on its own.
 */
export const TRAMPOLINE_LAUNCH_FORCE = 5e5;

/**
 * **Placeholder.** The minimum interval between two launches for one player, in seconds.
 *
 * ## It is a contact guard, and it is shorter than the airtime on purpose
 *
 * `Touched` fires repeatedly while a character stands on a part, and it fires again the moment they land, so the guard has one
 * job: collapse one landing's burst of contacts into one launch. `0.3` is about a fifth of the `1.33 s` airtime, and by the
 * time it expires the character is about thirty studs up, where no contact with the pad is possible.
 *
 * **The value this replaces was `1.2`, which was longer than the airtime it guarded, and that was a bug wearing a safety
 * rule's clothes** (item 231). A character launched at `t = 0` under the old `1.02 s` airtime landed at `t = 1.02`, so the
 * landing `Touched` arrived `0.18 s` *inside* the `1.2` cooldown and was refused; a character standing still on a part
 * produces no further contact, so the next launch came whenever something finally re-touched the pad. In a round where the
 * launch itself failed, nothing ever left the pad and *every* touch was a refused one - which is the "it sometimes does
 * nothing, then bounces at a random later moment" half of the report.
 *
 * **So the rule is the other way round from the one written here before: cooldown far below airtime**, and
 * `trampoline.spec.ts` asserts it against the engine's gravity rather than leaving it to a playtest.
 */
export const TRAMPOLINE_COOLDOWN_SECONDS = 0.3;

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
 * **Placeholder.** The folder the client's ball trail parents its fading copies into, created on demand.
 *
 * **Client-side only.** A trail copy is made by `BallTrailController` on each client from that client's own phantom, so the
 * folder exists separately in every client's `Workspace` and is never replicated - the same shape `HIT_EFFECTS_FOLDER_NAME`
 * has, and the reason a copy can be tuned without a server round trip.
 */
export const BALL_TRAIL_FOLDER_NAME = "SpawnedBallTrail";

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
 * The name of the client-only avatar overlay, created by `BallAvatarController` as a child of the ball it belongs to.
 *
 * Same reason as `BALL_PHANTOM_NAME`: as a child of the body it is destroyed with it, and "does this body have exactly one
 * avatar" is a name lookup rather than a walk. A name, not a folder path — the overlay belongs to one body.
 */
export const BALL_AVATAR_NAME = "BallAvatar";

/**
 * **Placeholder.** The avatar's drawn size, in pixels, on both axes.
 *
 * **A square, and it must be:** the thumbnail is a player's `HeadShot`, which is square, and a non-square frame would crop
 * the head or letterbox it. A `BillboardGui`'s offset `Size` is a **pixel** size held constant with distance — the same
 * mechanic as the power badge's, and the reason this is pixels rather than studs.
 *
 * `36` is deliberately about the badge's `20`-pixel height plus its own clearance: the avatar is a second label in the same
 * vertical stack on the same body, so it has to be big enough to be recognisable at the distance the arena camera sits and
 * small enough that eight of them do not become a wall of faces over the belt.
 */
export const BALL_AVATAR_SIZE = 36;

/**
 * **Placeholder.** How far above the ball's surface the avatar floats, in studs, measured from the ball's **centre**.
 *
 * **It does not reuse `POWER_BADGE_OFFSET_STUDS` (14), and that is a measured decision rather than a preference.** The badge
 * sits at `radius + 14` — for a 20-stud ball, `10 + 14 = 24` above the centre — and it is `20` pixels tall, so the avatar has
 * to clear the badge as well as the body. `40` is `radius (10) + badge offset (14) + 16` of clearance, which leaves a gap
 * at the game camera's distance without pushing the face so high that it stops reading as belonging to its ball.
 *
 * **The honest caveat:** the badge's height is in pixels and this offset is in studs, so the clearance is exact at one
 * camera distance and only approximate at others. That is the same trade the badge itself makes (`POWER_BADGE_OFFSET_STUDS`
 * above the radius), and a studs offset is the only kind a `BillboardGui` accepts for this.
 */
export const BALL_AVATAR_OFFSET_STUDS = 40;

/**
 * **Placeholder.** The thumbnail resolution requested per player, in pixels, and the largest `Enum.ThumbnailSize` whose
 * squareness matches `BALL_AVATAR_SIZE`.
 *
 * Asked for at the size it is drawn rather than at `420x420`: the call is a web request, and every player in the round is one
 * of them. `48x48` against a `36`-pixel frame is the smallest option that is still down-sampled rather than up-sampled.
 */
export const BALL_AVATAR_THUMBNAIL_SIZE = Enum.ThumbnailSize.Size48x48;

/**
 * **Placeholder.** The spectate button's drawn size, in pixels. Wide enough for `Stop Watching` — the longer of its two (item 208)
 * labels — at the control text size, and tall enough for a chunky face plus its bezel.
 */
export const SPECTATE_BUTTON_WIDTH = 200;

/** **Placeholder.** See `SPECTATE_BUTTON_WIDTH`. */
export const SPECTATE_BUTTON_HEIGHT = 56;

/** **Placeholder.** How far the button sits above the bottom of the HUD, in pixels. */
export const SPECTATE_BUTTON_MARGIN = 32;

/**
 * **Placeholder.** The button's label size, in pixels.
 *
 * Fixed rather than big-ui's: a chunky face is a fixed box, and the label is drawn on it with a stroke, so it is a
 * `TextLabel` inside the face rather than a themed bar — the same shape every other chunky control uses.
 */
export const SPECTATE_LABEL_TEXT_SIZE = 20;

/**
 * The two labels the spectate control flips between.
 *
 * In `tuning.ts` rather than in the controller because the *words* are the design: a button that says what it does is a
 * requirement of the brief, and `Stop spectating` is long enough that a change to it is a size change here.
 */
export const SPECTATE_LABEL_OFF = "Watch Race";
export const SPECTATE_LABEL_ON = "Stop Watching";

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
