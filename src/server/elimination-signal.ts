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
export type EliminationCause = "left-belt" | "culled" | "teardown";

/** Anything with a user id. `BallOwner` satisfies this structurally, so callers pass their own value. */
export interface OwnedBody {
	readonly userId: number;
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
	if (cause === "teardown" || owner === undefined) {
		return undefined;
	}

	if (owner.userId <= 0) {
		return undefined;
	}

	return owner.userId;
}
