/**
 * Who, if anyone, should be told they were eliminated.
 *
 * ## Why this is a function rather than an `if` at the two call sites
 *
 * Three of the four rules here are the kind that get dropped one at a time. A body can be removed for four reasons, and
 * only two of them are "you lost": leaving the belt, and the spawner culling it (`KillY` or the live-ball cap). A teardown
 * removes every body at once because the phase changed, and a synthetic `Debug#N` body belongs to nobody at all — splash
 * either of those and a player is told they were eliminated by the round ending or by somebody else's debug press.
 *
 * Written once and asserted in a spec, the rules survive the next person adding a fifth removal path.
 */

/** Why a body left the round. The distinction that matters is whether a player should be told. */
/**
 * Why a body left the round.
 *
 * - **`left-belt`** - it crossed the elimination zone. The normal way to lose.
 * - **`culled`** - it fell below `KillY` or was removed by the `MaxLiveBalls` cap. A loss the round did not control.
 * - **`left-game`** - its **owner disconnected** while it was still racing (item 211). The body never left the belt; the
 *   player did. Treated as an elimination because the alternative is a body nobody is driving holding a rank and keeping the
 *   round from ending.
 * - **`teardown`** - the round cleared the field. Not an elimination at all, which is why every recipient rule returns
 *   `undefined` for it.
 */
export type EliminationCause = "left-belt" | "culled" | "left-game" | "teardown";

/** Anything with a user id. `BallOwner` satisfies this structurally, so callers pass their own value. */
export interface OwnedBody {
	readonly userId: number;
}

/**
 * Whether a user id belongs to a real player, as opposed to nobody at all.
 *
 * The three sentinels this repo already carries are `undefined` (no owner), `0` (a destroyed body's default attribute
 * read) and a negative id (a synthetic `Debug#N` competitor). All three mean "there is no player behind this", and every
 * rule that turns a body into a recipient has to agree about that or the disagreements show up as one path splashing a
 * debug press and another staying quiet.
 *
 * **Exported so the elimination-sound rule (item 87) reuses this test rather than writing a second `> 0`.** Two copies of
 * a boundary is one copy that gets changed; the boundary here is `<= 0` and the fail-closed direction is not obvious from
 * a call site.
 */
export function isRealOwner(userId: number): boolean {
	return userId > 0;
}

/**
 * The `UserId` to notify, or `undefined` when nobody should be.
 *
 * - **`teardown`** → nobody. The phase is changing and every body goes at once; a splash per body would read as a mass
 *   elimination the player did not cause.
 * - **no owner** → nobody. An orphan body is not a competitor.
 * - **`userId <= 0`** → nobody. Synthetic competitors (`Debug#N`) carry negative ids and there is no player behind them.
 * - **otherwise** → that player.
 *
 * The owner is read *before* the body is destroyed, because every property of a destroyed instance reads as its default
 * and a post-destroy read would silently report `userId 0` — which the third rule would then quietly treat as synthetic.
 */
export function splashTargetUserId(owner: OwnedBody | undefined, cause: EliminationCause): number | undefined {
	// **`left-game` is not told either (item 211).** The recipient of a splash is the *owner of the eliminated body*, and on a
	// disconnect that owner's client is already gone - the remote would fire at nothing. The result is the same as `teardown`
	// for a different reason: a teardown has no elimination to report, and a disconnect has nobody left to report it to.
	if (cause === "teardown" || cause === "left-game" || owner === undefined) {
		return undefined;
	}

	if (!isRealOwner(owner.userId)) {
		return undefined;
	}

	return owner.userId;
}
