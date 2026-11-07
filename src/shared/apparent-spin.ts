import { APPARENT_SPIN_GAIN, APPARENT_SPIN_MAX_RAD_PER_SEC, APPARENT_SPIN_SIGN, SPIN_DEADBAND_SPEED } from "./tuning";

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
 * The drawn angular rate for a ball of `radius` travelling at `speed`, in radians/second.
 *
 * `min(APPARENT_SPIN_MAX_RAD_PER_SEC, APPARENT_SPIN_GAIN * speed / radius)` above `SPIN_DEADBAND_SPEED`, and exactly `0`
 * at or below it. The deadband is a real hold rather than a near-miss: `0` here feeds `CFrame.fromAxisAngle(axis, 0)`,
 * which is the identity, so a parked ball's pose is preserved bit-for-bit instead of drifting by a thousandth of a degree
 * per frame.
 *
 * `radius <= 0` is treated as `0` rather than dividing by zero: a body whose `Size.Y` has not replicated yet would
 * otherwise produce `inf` and poison the accumulated pose with a `NaN`, which is unrecoverable once multiplied in.
 */
export function apparentSpinRate(speed: number, radius: number): number {
	if (!(speed > SPIN_DEADBAND_SPEED) || !(radius > 0)) {
		return 0;
	}

	return math.min(APPARENT_SPIN_MAX_RAD_PER_SEC, (APPARENT_SPIN_GAIN * speed) / radius);
}

/**
 * The world-space axis a ball is drawn rolling about, given the belt's `RightVector`, with `APPARENT_SPIN_SIGN` applied.
 *
 * `yAxis:Cross(right)` is **forward rolling**: for `right = +X` it is `-Z`, the axis that moves the top of the ball toward
 * `+X`. `APPARENT_SPIN_SIGN` flips it, and the result for this scene is `+Z`, which moves the top of the ball toward
 * `-X` — the direction a ball gains ground under a boost, and the direction a treadmill's surface would carry its surface
 * texture. That is the sign the markers have always used and it is unchanged; the sign is applied **here** so a caller
 * cannot half-apply it.
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
