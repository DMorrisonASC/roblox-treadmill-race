import {
	APPARENT_SPIN_GAIN,
	APPARENT_SPIN_MAX_RAD_PER_SEC,
	APPARENT_SPIN_SIGN,
	BASE_BALL_RADIUS,
	SPIN_BASE_RAD_PER_SEC,
} from "./tuning";

/**
 * The **apparent** spin of a ball: one rate and one axis, both derived from the model rather than from physics.
 *
 * ## Why this is a module and not a line in each caller
 *
 * Two client controllers need the same two numbers. `marker-spin-controller` draws three marker parts around a body, and
 * `ball-render-controller` rolls the body's visible skin. Item 98 made the second read the first's frame, but the *fallback*
 * — and the axis, which both resolve independently — still had to agree, and two copies of a formula is one copy that gets
 * edited. The formula is three terms and the axis is one cross product, so this is a small module; the point is that it is
 * the only one.
 *
 * ## What "apparent" means here
 *
 * Not the body's own angular velocity. The engine's solver spins these bodies at whatever rate and about whatever axis
 * contact resolution produced, and that is not the direction this model calls forward — driving the picture from it made
 * the markers reverse mid-ride with no change in `BALL_SPEED`. The apparent spin is a *depiction*: the ball is on a surface
 * moving at `BELT_SPEED`, so relative to that surface it travels at `BALL_SPEED`, and it is drawn rolling at the rate that
 * implies.
 *
 * Both functions are pure — numbers in, numbers out — so a spec can pin the rate and the axis without a DataModel.
 */

/**
 * The drawn angular rate for a ball travelling at `speed`, in radians/second.
 *
 * `min(APPARENT_SPIN_MAX_RAD_PER_SEC, SPIN_BASE_RAD_PER_SEC + APPARENT_SPIN_GAIN * speed / BASE_BALL_RADIUS)` ?
 * **base plus speed, with no deadband (item 196).**
 *
 * ## Why the deadband went, and what it got wrong
 *
 * The previous form was `min(MAX, GAIN * speed / BASE_BALL_RADIUS)` above a deadband and exactly `0` below it. That made
 * `0` stand for "parked", and `BALL_SPEED = 0` does **not** mean parked: it means the ball is moving at exactly the belt's
 * speed through the tread, which is where every ball ends up a few seconds into a round. The log from that build shows one
 * at `RELATIVE_SPEED = +10` toward the exit with a still skin ? **a ball sliding across the floor without turning**, which
 * is the single most obvious render bug this system can produce, and which no gain can fix because the term that would fix
 * it is zero by definition in that case.
 *
 * **`0` is now a real rate** (`SPIN_BASE_RAD_PER_SEC`), so a sliding ball rolls. "Do not spin at rest" is answered by the
 * **phase** instead: both controllers stop accumulating rotation outside `Playing`, where a ball on a stopped belt genuinely
 * is at rest. That is a fact about the round rather than about a number, and it is the fact the old deadband was standing
 * in for.
 *
 * ## Why the divisor is `BASE_BALL_RADIUS` and not the body's radius (item 188)
 *
 * It used to be the actual radius, which is **physically** correct and **visually** wrong: the rate is inversely
 * proportional to radius, so a 20-stud ball at the same `BALL_SPEED` drew **20x less rotation** than a 1-stud one. The roll
 * the designer tuned and liked at one stud became a visible creep - `3 rad/s`, half a turn a second - at twenty.
 *
 * Dividing by the design radius instead makes the drawn rate a function of **speed alone**, so the picture is the same at
 * any ball size and a future size change needs no retuning of this. **The cost, stated:** this is no longer a rolling rate.
 * A 20-stud ball drawn at the 1-stud rate *is* slipping: its surface does not move at the belt's speed, and a reader who
 * derives the contact speed from it will get a different number than the tread shows. That is the deliberate trade - the
 * belt's own texture scroll (`BELT_TEXTURE_SCROLL_MULTIPLIER`) is the number that owns "how fast the ground looks", and it
 * was already decoupled from the model for exactly this reason.
 *
 * ## Why the zero-radius guard is gone with it
 *
 * It existed to stop `speed / 0` producing `inf` from a body whose `Size` had not replicated, which would poison the
 * accumulated pose with a `NaN`. The divisor is now a constant, so there is nothing to divide by zero.
 */
export function apparentSpinRate(speed: number): number {
	// A negative or `NaN` speed is not motion: `BALL_SPEED_MIN` is `0` and a body with no attribute reads `0`, but a collision
	// handler writing a stray negative must not draw the ball turning backwards at the base rate.
	const sane = speed > 0 ? speed : 0;

	return math.min(
		APPARENT_SPIN_MAX_RAD_PER_SEC,
		SPIN_BASE_RAD_PER_SEC + (APPARENT_SPIN_GAIN * sane) / BASE_BALL_RADIUS,
	);
}

/**
 * The world-space axis a ball is drawn rolling about, given the belt's `RightVector`, with `APPARENT_SPIN_SIGN` applied.
 *
 * `yAxis:Cross(right)` is **forward rolling**: for `right = +X` it is `-Z`, the axis that moves the top of the ball toward
 * `+X`. `APPARENT_SPIN_SIGN` flips it, and the result for this scene is `+Z`, which moves the top of the ball toward `-X`
 * and therefore its **contact point toward `+X`** - the direction the belt's surface is drawn travelling (item 103). That
 * is what makes the drawn roll **no-slip** instead of a slip, and it is the sign the markers have always used: unchanged,
 * and applied **here** so a caller cannot half-apply it.
 *
 * The degenerate case is a belt stood on its end, where the cross product is zero and there is no rolling axis. The
 * fallback is `(0, 0, -1)` before the sign — the same axis this scene's belt produces — so a client that has not received
 * the belt yet draws motion in the direction it will continue to have, rather than none at all.
 */
export function apparentSpinAxis(beltRight: Vector3): Vector3 {
	const raw = Vector3.yAxis.Cross(beltRight);

	if (raw.Magnitude < 1e-3) {
		return new Vector3(0, 0, -1).mul(APPARENT_SPIN_SIGN);
	}

	return raw.Unit.mul(APPARENT_SPIN_SIGN);
}
