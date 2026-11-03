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

/** Attribute on a `TreadmillBelt` part: drag speed in studs/second. Negative reverses the belt. */
export const BELT_SPEED_ATTRIBUTE = "BeltSpeed";

/** **Placeholder** belt speed in studs/second. A gameplay constant with no other config to derive it from. */
export const DEFAULT_BELT_SPEED = 10;

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
