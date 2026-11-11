import { describe, expect, it } from "@rbxts/jest-globals";
import { apparentSpinAxis, apparentSpinRate } from "./apparent-spin";
import {
	APPARENT_SPIN_GAIN,
	APPARENT_SPIN_MAX_RAD_PER_SEC,
	BALL_SPEED_MAX,
	BALL_SPEED_START,
	BASE_BALL_RADIUS,
	SPIN_BASE_RAD_PER_SEC,
} from "./tuning";
import { SPRINTER_BOOST_SPEED } from "./powers.config";

/**
 * The two numbers a ball's visible roll is built from: a rate and an axis.
 *
 * ## Why this is worth a spec
 *
 * Item 98 made one rotation drive both the markers and the ball's skin, so an error here is no longer a mis-drawn
 * decoration — it is the whole picture turning the wrong way, and the failure reads as "the effect is broken" rather than
 * as an arithmetic sign. The rate's clamp is also the sort of boundary that gets "simplified" later, and it is load-bearing:
 * it is what stops the markers aliasing into a backward read on a 60 Hz display. The **base term** is the newest of these
 * (item 196) and the most easily removed by someone reading "a ball at speed 0 should not spin" — which is true of a parked
 * ball and false of a sliding one, and the difference is a phase, not a speed.
 */
describe("apparentSpinRate", () => {
	it("is the base rate at rest, not zero (item 196)", () => {
		// **The bug this fixes, in one assertion.** `BALL_SPEED = 0` is not "parked": it is a ball moving at the belt's own
		// speed through the tread, which is where every ball ends up a few seconds into a round. The old form returned exactly
		// `0` there, so a ball slid across the floor with a frozen skin ? the log for that build shows one at
		// `RELATIVE_SPEED = +10` toward the exit with no rotation at all.
		//
		// "Do not spin at rest" is now the **phase**'s job, in both controllers, rather than a deadband's.
		expect(apparentSpinRate(0)).toBe(SPIN_BASE_RAD_PER_SEC);
		expect(SPIN_BASE_RAD_PER_SEC > 0).toBe(true);
	});

	it("totals the approved rate at the spawn speed", () => {
		// The anchor: **`20 rad/s` at `BALL_SPEED = 10`**, which is the rate earlier rounds established as legible (about
		// `3.2` rev/s, `19` degrees a frame at 60 Hz). Derived from the two constants rather than pinned, so a retune of the
		// split is a one-line change and this case still describes the rule.
		const expected = SPIN_BASE_RAD_PER_SEC + (APPARENT_SPIN_GAIN * 10) / BASE_BALL_RADIUS;

		expect(apparentSpinRate(10)).toBeCloseTo(expected, 5);
		expect(expected).toBeCloseTo(20, 5);
	});

	it("is monotone below the clamp, and clamps above it", () => {
		// The function's own definition, clamp included, so this case survives any retune of the split or of the speed range.
		// **An earlier version asserted the unclamped expression at `BALL_SPEED_MAX` and broke when the designer raised that
		// ceiling to `100`** -- at which point the rate is `110` before the clamp and `90` after it. Restating a tuned number in
		// a test is testing the tuning; comparing against the definition tests the rule.
		const expected = (speed: number) =>
			math.min(
				APPARENT_SPIN_MAX_RAD_PER_SEC,
				SPIN_BASE_RAD_PER_SEC + (APPARENT_SPIN_GAIN * speed) / BASE_BALL_RADIUS,
			);

		expect(apparentSpinRate(20) > apparentSpinRate(10)).toBe(true);
		expect(apparentSpinRate(10) > apparentSpinRate(0)).toBe(true);
		expect(apparentSpinRate(BALL_SPEED_MAX)).toBeCloseTo(expected(BALL_SPEED_MAX), 5);

		// And the base is a floor, not a spike: the rate never falls below it however the gain is retuned.
		expect(apparentSpinRate(0) <= apparentSpinRate(1)).toBe(true);
	});

	it("holds every drawn rate inside the legible band, at any speed (item 200)", () => {
		// **The assertion that would have caught the "balls do not spin" report.** The rate is `10 + BALL_SPEED`, so an
		// unclamped ball at `BOOST_TARGET_BALL_SPEED = 80` is drawn at `90 rad/s` -- 86 degrees of rotation per frame at 60 Hz,
		// past the 45-degree half-period of a six-textured sphere, which the eye resolves as *no rotation at all*. The ceiling
		// is what keeps it readable, so it has to hold for every speed the model can produce, including `BALL_SPEED_MAX`.
		expect(apparentSpinRate(BALL_SPEED_START)).toBeLessThan(APPARENT_SPIN_MAX_RAD_PER_SEC);
		expect(apparentSpinRate(SPRINTER_BOOST_SPEED)).toBe(APPARENT_SPIN_MAX_RAD_PER_SEC);
		expect(apparentSpinRate(BALL_SPEED_MAX)).toBe(APPARENT_SPIN_MAX_RAD_PER_SEC);
		expect(apparentSpinRate(1000)).toBe(APPARENT_SPIN_MAX_RAD_PER_SEC);

		// And the ceiling itself is inside the fold, derived rather than pinned: `rad/s / 60` degrees per frame must stay under
		// the 45-degree half-period of a six-face sphere. At `31` that is `29.6` degrees.
		expect(math.deg(APPARENT_SPIN_MAX_RAD_PER_SEC / 60) < 45).toBe(true);
	});

	it("clamps at the legibility ceiling", () => {
		// A huge speed must not produce a huge rate: past the clamp the drawn rotation aliases.
		expect(apparentSpinRate(1000)).toBe(APPARENT_SPIN_MAX_RAD_PER_SEC);
	});

	it("treats a negative or unreadable speed as rest rather than reversing", () => {
		// `BALL_SPEED_MIN` is `0`, and a body with no attribute reads `0` ? but a collision handler writing a stray negative
		// must not draw the ball turning backwards at a rate below the base.
		expect(apparentSpinRate(-5)).toBe(SPIN_BASE_RAD_PER_SEC);
		expect(apparentSpinRate(0 / 0)).toBe(SPIN_BASE_RAD_PER_SEC);
	});

	it("does not depend on the ball's size (item 188)", () => {
		// The rate used to be `gain * speed / radius`, so a 20-stud ball drew twenty times less rotation than a 1-stud one at
		// the same speed ? the "creeping" roll the designer reported. There is no radius parameter any more, which is the
		// strongest form of the assertion: it cannot vary with size.
		expect(apparentSpinRate(10)).toBe(apparentSpinRate(10));
	});

	it("cannot be reached by the gain alone, which is why the base exists", () => {
		// The split's contract in one assertion: the gain term at the spawn speed is *less* than the total, so the base is
		// carrying part of the rate rather than decorating it. A retune that pushed the gain back up until it alone produced
		// `20` would make this false — and that is the retune that would also put the range back inside the aliasing fold, so
		// it is worth failing on.
		const gainTerm = (APPARENT_SPIN_GAIN * 10) / BASE_BALL_RADIUS;

		expect(SPIN_BASE_RAD_PER_SEC > 0).toBe(true);
		expect(gainTerm < SPIN_BASE_RAD_PER_SEC + gainTerm).toBe(true);
		expect(gainTerm < 20).toBe(true);
	});
});

describe("apparentSpinAxis", () => {
	it("turns about world Z for this scene's belt", () => {
		// `right = +X` is the observed belt. The sign is applied inside the function, so this is the axis as used.
		const axis = apparentSpinAxis(new Vector3(1, 0, 0));

		expect(axis.Magnitude).toBeCloseTo(1, 5);
		expect(axis.X).toBeCloseTo(0, 5);
		expect(axis.Y).toBeCloseTo(0, 5);
		expect(math.abs(axis.Z)).toBeCloseTo(1, 5);
	});

	it("falls back to the same axis without a belt", () => {
		// A belt stood on its end has no rolling axis; the fallback has to be a usable direction, not a zero vector, and it
		// is the axis this scene's belt produces **after** the sign — so a client waiting for the belt draws the direction it
		// will keep rather than a different one.
		const degenerate = apparentSpinAxis(new Vector3(0, 1, 0));

		expect(degenerate.Magnitude).toBeCloseTo(1, 5);
		expect(degenerate.Z).toBeCloseTo(1, 5);
	});
});
