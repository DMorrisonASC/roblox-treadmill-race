/**
 * The `ghost` power's cycle: how long a ghost is intangible, how long it is solid again, and how visible it is while it
 * is passing through everything.
 *
 * ## Why the cycle exists at all
 *
 * A ghost used to be intangible for the whole round: `presentPower` sets `ball.CollisionGroup = collisionGroupFor(power)`
 * once at spawn and nothing ever moved it back. That made `ghost` a permanent immunity - the body could not be popped,
 * shoved or transferred from, and the only thing that could remove it was decay - which is not a power so much as a
 * spectator slot. A break window is what makes it a *decision*: a ghost that is solid for fifteen seconds out of every
 * twenty-five can be caught.
 *
 * ## Why the numbers are shaped as "on for `ACTIVE`, then off for `BREAK`"
 *
 * The cycle length is `ACTIVE + BREAK` and it is **derived**, never authored: two constants that must add to a third are
 * three places to introduce a disagreement, and the phase arithmetic below is the only thing that needs the sum.
 */

/**
 * **Placeholder.** Seconds per cycle that a ghost is intangible (`GhostBall`).
 *
 * The window the power exists for. Long enough to cross a lane and pass through a body rather than merely through a
 * corner of one, short enough that the solid window below is a real threat rather than a technicality.
 */
export const GHOST_ACTIVE_SECONDS = 10;

/**
 * **Placeholder.** Seconds per cycle that a ghost is solid again (`CompetitorBall`).
 *
 * The break. This is the half that makes the power a trade: during it the body collides like every other, so the pops,
 * shoves and steals it spent the active window avoiding all apply. `15` makes the solid state the majority of the cycle,
 * which is what the design asked for.
 */
export const GHOST_BREAK_SECONDS = 15;

/** One full cycle, in seconds. **Derived** - see this file's header for why it is not its own constant. */
export const GHOST_CYCLE_SECONDS = GHOST_ACTIVE_SECONDS + GHOST_BREAK_SECONDS;

/**
 * **Placeholder.** How transparent a ghost's *visible skin* is while it is intangible, from `0` (solid) to `1` (invisible).
 *
 * `0.5` because the state has to read as "present but not quite there" rather than as "gone": at `1` the body would be
 * invisible and a player could not see what they are about to be hit by when the break ends. The write is the client's
 * (see `BallRenderController`) and it is applied to the phantom **and** to each of its cloned `Texture`s, because a
 * `Texture` draws on a fully transparent part.
 */
export const GHOST_TRANSPARENCY_WHILE_ACTIVE = 0.5;

/**
 * Whether the cycle runs at all.
 *
 * A kill switch rather than a tuning value: with it `false` the server leaves every ghost body in the group
 * `presentPower` gave it - intangible for the whole round, the old behaviour - and never writes `GhostActive`, so the
 * client draws an opaque skin. That is the shape a broken cycle is reverted with, without deleting the code that has to
 * come back.
 */
export const GHOST_CYCLE_ENABLED = true;

/**
 * Whether a ghost is intangible `elapsed` seconds after `Playing` entry.
 *
 * Pure, so the cycle's phase can be asserted without a `DataModel` - the same reason `pickupDiscDiameter` lives beside
 * its constants rather than inside a service.
 *
 * ## Why the seed is the round's clock and not each body's spawn
 *
 * Because the cycle is a property of the **power**, and a player reading the field needs to be able to predict it. Seeded
 * per body, two ghosts spawned a second apart would blink a second apart, and a decoy twin - which goes through
 * `presentPower` and is therefore a ghost too - would blink on its own phase as well. One clock means every ghost is
 * solid at the same moment, which is the version a player can learn.
 *
 * `elapsed` may be negative (a body ticked before the clock has been stamped); it is treated as phase `0`, so a body that
 * exists a frame early starts in the active window rather than being wrapped into the break.
 */
export function ghostActiveAt(elapsed: number): boolean {
	if (GHOST_CYCLE_SECONDS <= 0) {
		return false;
	}

	const at = math.max(0, elapsed);
	const wrapped = at - math.floor(at / GHOST_CYCLE_SECONDS) * GHOST_CYCLE_SECONDS;

	return wrapped < GHOST_ACTIVE_SECONDS;
}
