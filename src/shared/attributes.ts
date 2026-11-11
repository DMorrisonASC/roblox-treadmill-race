/**
 * Attribute names and the values the services derive for them.
 *
 * ## Who writes these — a reversed decision
 *
 * The designer tags a part; the service writes the attributes. That is the whole contract.
 *
 * The first draft of this file argued the opposite: that services must never stamp attributes into
 * the scene, because a service that mutates the scene makes "what value is actually in effect?"
 * unanswerable from the place file alone, and because a default written by code is a default nobody
 * sees in Studio. That concern was real, but it lost to a worse one — the draft's own consequence
 * was that a freshly tagged part did nothing until someone opened the Properties panel and typed
 * five values by hand. A setup step that lives in a person's head is the step that gets skipped, and
 * when it is skipped the symptom is indistinguishable from broken code. The reported bug ("I tagged
 * a spawner and no balls came out") was exactly that: `Enabled` had no attribute, the reader fell
 * back to `false`, and nothing appeared — while the manual trigger, which never reads `Enabled`,
 * kept working and made the spawner look half-alive.
 *
 * So `ensureDerivedAttributes` runs at bind, fills in only the attributes that are *absent*, and
 * leaves anything already present untouched. That satisfies the original concern the way it deserves
 * to be satisfied: after the first run the values are visible in the Properties panel, and a
 * designer can override any of them by hand without the override being reset on rebind.
 */

/**
 * Attribute on a `TreadmillBelt` part: the **reference speed**, in studs/second, along the belt's `RightVector`
 * (world X — the along-belt axis; `RightVector` is not lateral here, see `BallSpawnerService.stepBallSpeeds`).
 *
 * It is a number a ball's own `BALL_SPEED` is **compared against**, not a surface that moves: a ball whose `BALL_SPEED`
 * equals it holds station, one below it drifts toward the **back** (toward elimination, `+X`), and one above it — after a
 * pickup — drifts toward the **front** (`-X`, where it spawned). Negative reverses which direction is "with the belt":
 * `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED` flips sign, so a negative reference sends a ball toward the front at rest.
 */
export const BELT_SPEED_ATTRIBUTE = "BeltSpeed";

/** **Placeholder** belt speed in studs/second. A gameplay constant with no other config to derive it from. */
export const DEFAULT_BELT_SPEED = 10;

/**
 * Attribute on a belt: the **visual** scroll rate, in studs/second, for `BeltScrollController`.
 *
 * ## This is the second half of a split, and the split is the point
 *
 * `BELT_SPEED` (the `BeltSpeed` attribute) is the **reference number** the `BALL_SPEED` model compares
 * against. It is a constant while `Playing` and it never ramps. This attribute is the **effect**: the rate the
 * surface texture scrolls at, which does ramp from 0 over `BELT_RAMP_SECONDS` so the belt does not appear to
 * snap to full speed the instant a round begins.
 *
 * They were one number for one round, and that was a bug: `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED` briefly
 * read `+10`, `+6`, `+2` during the ramp, so **every ball drifted forward at the start of every round with no
 * pickup involved** ? the one thing only a pad is supposed to cause. A value that ramps is a value the
 * physics model did not consent to; the reference is the comparison, the visual is the effect.
 *
 * The wire name stays `BeltSpeedActual` so nothing already reading it has to change.
 */
export const BELT_VISUAL_SPEED_ATTRIBUTE = "BeltSpeedActual";

/**
 * Attribute on a ball: its own speed in the reference-speed model, in studs/second.
 *
 * Written by `BallSpawnerService` (seeded at spawn, decayed every tick, zeroed when the round stops) and by
 * `PickupService` (boost). Kept **on the ball** rather than in a service-side map for the same reason the owner
 * is: the body is what gets destroyed and replicated, so a map entry would need cleanup on every death path.
 *
 * **A scalar, not a direction.** It is compared against `BELT_SPEED` and the difference — `RELATIVE_SPEED`, along the
 * belt's `RightVector`, which is world X — becomes the ball's velocity: negative moves it toward the **back** (toward
 * elimination), zero holds station, positive moves it toward the **front** where it spawned. Nothing here says which way
 * a ball is pointing; `stepBallSpeeds` derives that every tick from the comparison alone.
 */
export const BALL_SPEED_ATTRIBUTE = "BALL_SPEED";

/**
 * Attribute on a ball: whether it is running at or above the belt's reference speed, with hysteresis.
 *
 * Written by `BallSpawnerService.stepBallSpeeds` — the one function that already reads both numbers — and by nothing
 * else. **A client-side effect reads it** (`WindBoostController`) to play a wind trail while a ball is fast, so the
 * attribute is a replicated fact rather than a second source of truth: the same tick that writes `BALL_SPEED` and the
 * velocity also settles this flag, and a client reading both in one frame cannot see them disagree.
 *
 * `true` at or above the reference, `false` once the ball is more than `BOOST_HYSTERESIS` below it, unchanged in
 * between. The band is what stops a ball decaying through the reference from strobing the effect on and off across
 * consecutive frames.
 */
export const BOOSTED_ATTRIBUTE = "Boosted";

/**
 * Attribute on a ball: whether it is in **regular motion** and should wear the tail-wind trail.
 *
 * `true` when the ball is slower than the belt reference (losing ground), moving faster than
 * `TAIL_WIND_MIN_BALL_SPEED` (so it is travelling through the world rather than parked), and **not** `Boosted`. Written by `BallSpawnerService.stepBallSpeeds` immediately after `Boosted`, on the
 * same tick, from the same numbers ? which is what makes the two effects mutually exclusive at the source rather than on each
 * client. A client reads this attribute and plays a trail; it never re-derives the condition, because a second copy of a
 * precedence rule is a rule that will disagree with itself.
 */
export const TAIL_WIND_ATTRIBUTE = "TailWind";

/**
 * `Radius` is retired. There is deliberately no constant for it below.
 *
 * ## Why the sphere radius stopped being an attribute
 *
 * The paragraph at the top of this file argues that services derive attributes at bind, and that
 * argument still holds for everything here except this. `Radius` is the exception because it stopped
 * being a property *of the spawner*: once the spawner chooses from a shape pool, the size a spawn
 * uses is a property of the chosen pool entry, and the pool is code (`shared/shape-pool.ts`). A
 * "radius" attribute on a part that spawns cylinders and blocks is ambiguous in two directions at
 * once — a cylinder has no radius, and a 1x3x1 block has three different ones — so any number left
 * in those slots would be a value that is displayed, editable, and ignored. A visible-but-inert
 * attribute is worse than no attribute, because the next person tunes it and watches nothing happen.
 *
 * The alternative — keeping `Radius` and scaling pool sizes by it — was rejected because it makes
 * every shape's silhouette a function of a scalar, which cannot express "the block is 3x taller than
 * it is wide". The pool carries explicit `Vector3` sizes precisely so that ratio is visible in code.
 *
 * A spawner carrying `Radius` from an earlier round keeps the attribute (nothing here deletes a
 * designer's data) but the code ignores it, and the bind log says so once.
 */

/**
 * `Enabled` and `Rate` are retired. Neither name is read anywhere any more.
 *
 * ## A reversal, recorded rather than appended
 *
 * `Enabled` has now been through three positions, and the last one is the one being undone. It
 * started as `false`; that was reversed to `true` on the argument that tagging a part should start a
 * stream with no Properties-panel step, and that the cost of `true` — a tagged spawner immediately
 * dropping balls — was one untick away. That argument assumed a *stream* was the point.
 *
 * It is not, for two reasons that only became visible once the stream existed. First, the user's
 * actual game is one body per round, so eight bodies a second across four spawners modelled a scene
 * that does not exist. Second, and worse, it actively prevented the question being answered: at
 * `Rate = 2` × 4 spawners against `MaxLiveBalls = 50` the scene is a permanent mosh pit of
 * overlapping bodies in four lanes, where collisions and the 1 s bounce cooldown interrupt any
 * rolling every ~150 ms. Every observation about whether a body *rolls* or *slides* was being made
 * inside that pit. The default was not merely unused, it was confounding the measurement.
 *
 * So the spawner now spawns **exactly one body per bound `BallSpawner`, once, at server start**, and
 * never again. `Rate` goes with `Enabled` because with no timer there is no rate to express.
 *
 * Both are *removed* rather than left derived-but-unread. This file's own rule is that a
 * visible-but-inert attribute is worse than no attribute, because the next person tunes it and
 * watches nothing happen — the same reason `Radius` was retired above. A later round that
 * reintroduces timing adds both back, with a consumer.
 *
 * The manual `1` key path is untouched by this: it never read either attribute, and it remains the
 * way to spawn additional bodies for collision testing without a code change.
 */

/**
 * Attribute on a `BallSpawner` part: balls below this world Y are destroyed.
 *
 * Deliberately has no duration constant. It is derived from `Workspace.FallenPartsDestroyHeight`
 * plus the largest dimension in the shape pool — see `deriveKillY` in `BallSpawnerService`. A picked
 * number cannot stay correct if the place's floor changes, and the first draft's `-50` sat 450 studs
 * above the engine's own default floor of -500, so it would have culled balls while they were still
 * visibly falling.
 *
 * The offset used to be one ball diameter (`2 * radius`). Retiring `Radius` removed the only input
 * that expression had, so it is now `poolMaxExtent()`: the same idea — "one body-size above the
 * floor" — measured against the largest body the pool can produce rather than against a single
 * sphere. That keeps the plane below every shape in the pool instead of below an arbitrary one.
 */
export const SPAWNER_KILL_Y_ATTRIBUTE = "KillY";

/**
 * Attributes on every `Ball`-tagged body naming who the body competes for.
 *
 * ## Why an id and not just a name
 *
 * `OwnerDisplayName` is what a results screen shows and what the log prints, and it is **not** the
 * identity: display names can change, and two accounts can share one. `OwnerUserId` is the identity, and
 * it is a signed integer specifically so a synthetic debug owner can be `-1`, `-2`, ... — a value no real
 * `Player.UserId` can ever take, so a "competitor" that is not a person is indistinguishable in type from
 * one that is and needs no second flag to decode.
 *
 * ## Why the body and not one of its markers
 *
 * `RoundService` enumerates bodies, so an owner it has to reach through a child marker would be a lookup
 * per body per tick. The body is also the thing that gets destroyed, so the owner goes away with it
 * rather than needing cleanup.
 *
 * **A body with no `OwnerUserId` is an orphan and does not compete.** It is not counted, it does not
 * start or end a round, and it cannot win. That is the rule that makes a stray body harmless: the
 * alternative — treating "no owner" as an owner — would let a body nobody bet on hold a round open
 * forever.
 */
export const OWNER_USER_ID_ATTRIBUTE = "OwnerUserId";
export const OWNER_DISPLAY_NAME_ATTRIBUTE = "OwnerDisplayName";

/**
 * **Who a body should be *drawn* as, when that is not who it is.** Read only by the client's avatar overlay (item 193).
 *
 * ## Why this is a second key and not `OwnerUserId` on the twin
 *
 * A `decoy` twin is deliberately **ownerless** — `OwnerUserId` is the field `getCompetitors()` filters on, so writing it to
 * the twin would make the fake a competitor, change the winner rule, and let it hold a round open. That absence is load
 * bearing and it is not negotiable.
 *
 * It also means the twin is a bare ball to every viewer, and a bare ball beside an identical one is **the fake**, instantly.
 * Items 77 and 129 spent two rounds making the pair indistinguishable, so the avatar cannot be keyed on a field the twin
 * must not have.
 *
 * ## The rule, in one line
 *
 * **`OwnerUserId` is the competition key; `AvatarUserId` is a display key.** They agree on every real body and only this
 * one exists on a twin. Nothing in the simulation reads it: `RoundService`, the tick loop, the powers and the winner rule
 * never look at it, and a body carrying a `AvatarUserId` and no `OwnerUserId` is still an orphan that competes for nothing.
 *
 * ## Where it is written, and where it deliberately is not
 *
 * **Only on a decoy twin, at spawn, beside the parent's identity it copies** (`spawnDecoy`). The real body needs no copy —
 * its `OwnerUserId` *is* the answer — so a lone extra key would be a second place for one fact to live and drift. The
 * client's rule is therefore `OwnerUserId ?? AvatarUserId`, which gives the twin its parent's face and every other body its
 * own.
 */
export const AVATAR_USER_ID_ATTRIBUTE = "AvatarUserId";

/**
 * The **lane this body was spawned into**, as an index into the spawner lane list — written once, at spawn, and never
 * rewritten.
 *
 * ## Why it is recorded rather than derived (item 184)
 *
 * The question it answers is "does this lane already hold a body", and the only alternative is comparing the body's
 * `Position` against each spawner's — which stops being true one frame after the spawn, because the whole point of a lane
 * is that the body *leaves* it. A recorded index keeps answering after the body has ridden away, which is what makes the
 * debug spawn's lane choice a read instead of a scene scan.
 *
 * It is a **label**, like `ChosenBallId`: nothing in the simulation branches on it, and no mechanic changes because of it.
 * A body without one (a decoy twin, which never came from a lane choice of its own; or a body from an older build) simply
 * is not counted as occupying anything.
 */
export const SPAWN_LANE_ATTRIBUTE = "SpawnLane";

/**
 * The ball a body is racing as, this round.
 *
 * **Written before `Parent`, like the owner attributes, and for the same reason:** a body that existed in the world for
 * one frame without its chosen id would be a body whose round result cannot be attributed to a pick. It is a *label*, not
 * a grant ? the id is not added to `OwnedBalls` and nothing about the body's appearance changes yet. A later round reads
 * it to render the ball; this one only records it.
 */
export const CHOSEN_BALL_ID_ATTRIBUTE = "ChosenBallId";

/**
 * The power a body races with, written at spawn from the chosen ball's id and rewritten when the player's pick changes.
 *
 * ## Why a derived attribute and not a lookup at the point of use
 *
 * Every reader of this is on the hot path — the tick loop, a `Touched` handler, `PickupService` — and each would otherwise
 * have to resolve `ChosenBallId` through `BALL_POOL` and `POWERS` on every read. Attributes replicate with the instance and
 * die with it, so the power is available to a client (for the badge) and to any future consumer without an API call, and
 * needs no cleanup on any of the four death paths.
 *
 * **A body with no `Power` attribute has no power**, and that is load-bearing rather than incidental: an ownerless decoy is
 * exactly such a body, and "no attribute" must never be read as "the default power".
 */
export const POWER_ATTRIBUTE = "Power";

/**
 * Whether a body's owner attribute pair names a competitor.
 *
 * ## Why this is pure, and why it is here
 *
 * "An ownerless body does not compete" used to be a fact about stray bodies. It is now load-bearing for a feature: the
 * `decoy` power spawns one body per `decoy_ball` with **no** owner attributes at all, so this predicate returning `false`
 * is the whole reason a decoy cannot win, cannot hold a round open and cannot be reported as somebody's elimination. A
 * spec cannot construct a `BasePart`, so the rule is written over the two attribute *values* — which is also the only form
 * in which it can be tested.
 *
 * Both attributes are required. A body with an id but no display name would log as `winner=`, and a body with a name but no
 * id cannot be identified, so a half-written pair is not an owner.
 */
export function hasOwnerIdentity(userId: unknown, displayName: unknown): boolean {
	return typeIs(userId, "number") && typeIs(displayName, "string");
}

/** Attribute on a `BallSpawner` part: hard cap on live balls. */
export const SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE = "MaxLiveBalls";
/**
 * **Placeholder** live-ball cap.
 *
 * Left as a constant on purpose: the honest derivation would be `Rate x lifetime`, and a ball's
 * lifetime is decided by gravity, the belt and the kill plane rather than by anything readable here,
 * so computing it would be inventing a number with extra steps. 50 is `Rate` (2) x 25 s, which is
 * comfortably longer than a ball takes to leave the belt in the test scene.
 */
export const DEFAULT_MAX_LIVE_BALLS = 50;

/**
 * Attributes written by `BallSpawnerService` on each welded-turned-anchored visual marker.
 *
 * ## Why the local offset has to be sent at all
 *
 * The markers used to inherit the body's rotation through a `WeldConstraint`, so nothing had to
 * describe where a marker sat: the weld did. The client-side spin controller has to reconstruct a
 * marker's pose itself, as `body.CFrame * spin * localFrame`, and `localFrame` is not recoverable on
 * the client — a marker anchored at its spawn pose and a body that has since moved no longer share a
 * reference frame, so `body.CFrame:Inverse() * marker.CFrame` is only correct in the spawn frame, and
 * the controller never runs in that frame.
 *
 * Three `Vector3` attributes rather than one: a `CFrame` is not an attribute type. Position plus two
 * basis vectors determines the rotation exactly (`CFrame.fromMatrix` derives the third column), which
 * covers the equatorial ring's 90° tilt — the poles are rotationally symmetric and would survive a
 * lossy encoding, but the ring's plane would not.
 */
export const MARKER_LOCAL_POSITION_ATTRIBUTE = "MarkerLocalPosition";
export const MARKER_LOCAL_RIGHT_ATTRIBUTE = "MarkerLocalRight";
export const MARKER_LOCAL_UP_ATTRIBUTE = "MarkerLocalUp";

/**
 * The player's coin balance, written by `EconomyService` and read by the HUD.
 *
 * On `Player` for the reason `RoundTransitionCount` is: a `Player` attribute replicates only to that player,
 * so "what is in my wallet" does not arrive at every client on the server. The server is the only writer.
 */
export const PLAYER_COINS_ATTRIBUTE = "Coins";

/** The player's owned balls as an encoded string; see `encodeOwnedBalls` for the format and the reason. */
export const PLAYER_OWNED_BALLS_ATTRIBUTE = "OwnedBalls";

/**
 * Whether the economy can act for this player: `"loading"`, `"ready"`, or `"readonly"`.
 *
 * **Explicit rather than inferred.** A missing `Coins` attribute is three different situations at once — still
 * loading, load failed, locked by another session — and a client that guessed would either show a wallet that
 * is about to appear or hide a wallet that exists. One attribute names the state, and the controller renders it.
 */
export const PLAYER_ECONOMY_STATE_ATTRIBUTE = "EconomyState";

/**
 * **Whether this player is in the round that is running** — written `true` when a body is spawned for them and `false` when
 * the round's bodies are cleared. Read by the client's spectate button and the arena camera (item 193).
 *
 * ## Why a `Player` attribute and not "does the scene hold a body of mine"
 *
 * The scan is possible — `OwnerUserId` is on every real body — but it is wrong in three ways at once. It is a walk of the
 * tagged body list on every phase change; it answers **no** during the window between the phase changing and the body
 * replicating, which is exactly when the camera decides what to do; and it answers **no again** for a player whose ball was
 * eliminated mid-round, who is still watching a round they were in and must not be offered a `Spectate` button that would
 * take a camera they already have.
 *
 * The attribute is one write per spawn and one per teardown, it replicates to its own player only (a `Player` attribute is
 * not broadcast to everyone), and it is correct the moment the client reads it.
 *
 * ## Why it is cleared at teardown and not when the body dies
 *
 * "Competed this round" is the question the camera asks, and an eliminated competitor still has the arena camera — they are
 * watching the rest of the race, which is the behaviour item 186 shipped. Clearing on death would hand an eliminated player
 * their own camera mid-round, which is a regression dressed as a feature.
 *
 * **It is deliberately not `enrolledUserIds`.** Enrollment is the picker's record and closes before the round starts; this is
 * "a body exists for you", which is also true of the debug paths that bypass enrollment.
 */
export const PLAYER_COMPETING_ATTRIBUTE = "Competing";
