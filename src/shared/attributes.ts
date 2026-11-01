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

/** Attribute on a `BallSpawner` part: ball radius in studs. Ball diameter is twice this. */
export const SPAWNER_RADIUS_ATTRIBUTE = "Radius";
/** **Placeholder** ball radius in studs. */
export const DEFAULT_SPAWNER_RADIUS = 0.5;

/** Attribute on a `BallSpawner` part: whether the timed stream is running. */
export const SPAWNER_ENABLED_ATTRIBUTE = "Enabled";
/**
 * **Placeholder** default for `Enabled`: a tagged spawner streams.
 *
 * Reversed from `false`. `false` meant tagging a part produced silence, which forced the Studio step
 * this file exists to remove, and that silence was indistinguishable from a dead service. The cost
 * of `true` is that a spawner you tagged only to inspect it starts dropping balls immediately; the
 * fix for that is to untick `Enabled`, which is one click and leaves a visible record that you did.
 */
export const DEFAULT_SPAWNER_ENABLED = true;

/** Attribute on a `BallSpawner` part: balls spawned per second while enabled. */
export const SPAWNER_RATE_ATTRIBUTE = "Rate";
/** **Placeholder** spawn rate in balls/second. */
export const DEFAULT_SPAWNER_RATE = 2;

/**
 * Attribute on a `BallSpawner` part: balls below this world Y are destroyed.
 *
 * Deliberately has no duration constant. It is derived from `Workspace.FallenPartsDestroyHeight`
 * plus one ball diameter — see `deriveKillY` in `BallSpawnerService`. A picked number cannot stay
 * correct if the place's floor changes, and the first draft's `-50` sat 450 studs above the engine's
 * own default floor of -500, so it would have culled balls while they were still visibly falling.
 */
export const SPAWNER_KILL_Y_ATTRIBUTE = "KillY";

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
