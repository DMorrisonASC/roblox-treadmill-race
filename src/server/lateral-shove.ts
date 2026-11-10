/**
 * The sideways shove a ball contact leaves behind.
 *
 * ## Why an impulse here and not a velocity write in the handler
 *
 * `stepBallSpeeds` sets the lateral (world Z) component of a ball's velocity **every tick** — the decorative sway owns that
 * axis (item 151). A velocity written from a collision handler is therefore erased before it moves anything: the ball is
 * displaced for exactly one physics step, about `1/60` of a stud, which is the "no sideways push" a Studio log reported
 * while hits and pops were both firing. The engine's own lateral separation is erased the same way, so "let physics do it"
 * is not an option either.
 *
 * An **impulse** survives instead, because it is not a velocity — it is a number the one writer is handed. The collision
 * handler records a shove per body here; `stepBallSpeeds` projects it onto the belt's lateral axis, adds it to the sway's
 * own rate, and decays it. The axis still has exactly one writer, and the shove cannot race it.
 *
 * ## Why a separate module
 *
 * `powers` cannot import `BallSpawnerService`: the service already imports `powers`, and a service is constructed by
 * Flamework against a DataModel, so the collision handler could not reach an instance of it anyway. A module with a map is
 * the same seam `elimination-sound.ts` uses — the rule lives where both sides can see it, and the instance-touching stays
 * in the service.
 *
 * ## What is deliberately absent
 *
 * No connection and no timer: the shove decays because the tick reads it, so there is nothing to schedule. No attribute:
 * this is a tick-local number with no client consumer, and an attribute would replicate a write per contact for nothing.
 */
import { BALL_COLLISION_SHOVE_DECAY_SECONDS, BALL_COLLISION_SHOVE_SPEED } from "shared/tuning";

/** Below this a shove is dropped rather than carried forever as a rounding error. */
const SHOVE_EPSILON = 0.01;

/** Returned instead of `new Vector3()` on the common path, where a ball has no shove at all. */
const NO_SHOVE = new Vector3(0, 0, 0);

const shoves = new Map<BasePart, Vector3>();

/**
 * The horizontal unit vector from one body to another: the contact normal, flattened onto the belt's plane.
 *
 * ## Why the caller's axis is not resolved here
 *
 * The sign that matters is the one along the belt's `across` vector, and only `BallSpawnerService` holds the belt frame.
 * Storing the full horizontal normal and letting the writer project it keeps this module free of any assumption that the
 * belt is axis-aligned — the same reason the sway computes `across` from the frame instead of using world Z.
 *
 * ## Why a tie break is needed
 *
 * `Touched` can fire for two bodies stacked vertically or momentarily coincident, where the horizontal separation says
 * nothing about which way to knock. `tieBreak` is the lower-serial body's serial, so the answer is deterministic and both
 * halves of one `Touched` pair compute the same direction rather than each drawing its own.
 */
export function shoveDirection(from: Vector3, to: Vector3, tieBreak: number): Vector3 {
	const delta = new Vector3(to.X - from.X, 0, to.Z - from.Z);
	if (delta.Magnitude < 1e-4) {
		return new Vector3(0, 0, tieBreak % 2 === 0 ? 1 : -1);
	}

	return delta.Unit;
}

/**
 * One tick of decay, exponential in wall time.
 *
 * `e^(-dt / T)` rather than a per-frame multiplier, so the shove lasts the same `BALL_COLLISION_SHOVE_DECAY_SECONDS`
 * whatever the frame rate does. A multiplier per frame would make the shove shorter on a fast server and longer on a
 * paused one, which is exactly the class of bug the sway's own clock avoids.
 */
export function shoveStep(current: Vector3, dt: number): Vector3 {
	return current.mul(math.exp(-dt / BALL_COLLISION_SHOVE_DECAY_SECONDS));
}

/**
 * Caps an accumulated shove at one impulse's magnitude.
 *
 * A body in a pile can be hit from several neighbours inside one cooldown window; summing those without a cap would let
 * four contacts add up to a shove that crosses the belt. The cap makes the second and third contact refresh the shove
 * rather than multiply it.
 */
export function clampShove(sum: Vector3): Vector3 {
	const magnitude = sum.Magnitude;
	if (magnitude <= BALL_COLLISION_SHOVE_SPEED) {
		return sum;
	}

	return sum.Unit.mul(BALL_COLLISION_SHOVE_SPEED);
}

/**
 * Records an impulse on a body. `direction` carries both the axis and the sign, and its length is the peak speed, so a
 * caller passes `shoveDirection(...).mul(BALL_COLLISION_SHOVE_SPEED)` for the body being pushed away and the negation of
 * it for the other.
 */
export function shoveLateral(ball: BasePart, direction: Vector3): void {
	const existing = shoves.get(ball);
	shoves.set(ball, clampShove(existing === undefined ? direction : existing.add(direction)));
}

/**
 * The shove this body should carry this tick, decayed once — or zero.
 *
 * Called only by `stepBallSpeeds`, which is the only writer of the lateral axis. The entry deletes itself once the shove
 * is small enough to be invisible, so the map holds only bodies that are currently being knocked.
 */
export function lateralShoveFor(ball: BasePart, dt: number): Vector3 {
	const current = shoves.get(ball);
	if (current === undefined) {
		return NO_SHOVE;
	}

	// `decayed`, not `next`: `next` is a Lua global and roblox-ts rejects the identifier outright, the same reason
	// `stepBallSpeeds` calls its intermediates `decayed` and `advanced`.
	const decayed = shoveStep(current, dt);
	if (decayed.Magnitude < SHOVE_EPSILON) {
		shoves.delete(ball);
		return NO_SHOVE;
	}

	shoves.set(ball, decayed);
	return decayed;
}

/** Drops a body's remaining shove. Called from the spawner's two death paths so the map tracks the live set. */
export function forgetLateralShove(ball: BasePart): void {
	shoves.delete(ball);
}
