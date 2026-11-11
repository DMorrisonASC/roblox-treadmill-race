import { describe, expect, it } from "@rbxts/jest-globals";
import { apparentSpinAxis, apparentSpinRate } from "./apparent-spin";
import {
	APPARENT_SPIN_GAIN,
	APPARENT_SPIN_MAX_RAD_PER_SEC,
	BALL_SPEED_MAX,
	BASE_BALL_RADIUS,
	SPIN_DEADBAND_SPEED,
} from "./tuning";

/**
 * The two numbers a ball's visible roll is built from: a rate and an axis.
 *
 * ## Why this is worth a spec
 *
 * Item 98 made one rotation drive both the markers and the ball's skin, so an error here is no longer a mis-drawn
 * decoration — it is the whole picture turning the wrong way, and the failure reads as "the effect is broken" rather than
 * as an arithmetic sign. The rate's clamp and deadband are also the sort of boundary that gets "simplified" later, and both
 * are load-bearing: the deadband is what holds a parked ball still, and the clamp is what stops the markers aliasing into a
 * backward read on a 60 Hz display.
 */
describe("apparentSpinRate", () => {
	it("is exactly zero inside the deadband", () => {
		// Not "very small": `0` is what makes the pose hold bit-for-bit rather than drift.
		expect(apparentSpinRate(SPIN_DEADBAND_SPEED)).toBe(0);
		expect(apparentSpinRate(0)).toBe(0);
	});

	it("is the gain term just above the deadband", () => {
		// The first sample above the band, so the discontinuity at the deadband is visible: the rate jumps from 0 to the
		// gain term rather than easing in. That is intended — a ball that is moving is drawn rolling.
		const speed = SPIN_DEADBAND_SPEED + 0.001;
		expect(apparentSpinRate(speed)).toBeCloseTo((APPARENT_SPIN_GAIN * speed) / BASE_BALL_RADIUS, 5);
	});

	it("clamps at the legibility ceiling", () => {
		// A huge speed must not produce a huge rate: past the clamp the drawn rotation aliases.
		expect(apparentSpinRate(1000)).toBe(APPARENT_SPIN_MAX_RAD_PER_SEC);
	});

	it("does not depend on the ball's size (item 188)", () => {
		// **The change that round made.** The rate used to be `gain * speed / radius`, so a 20-stud ball drew twenty times
		// less rotation than a 1-stud one at the same speed — the "creeping" roll the designer reported. There is no radius
		// parameter any more, which is the strongest form of the assertion: it cannot vary with size.
		//
		// **Derived, not pinned.** An earlier version asserted the literal `20` and broke when the gain was retuned to `2`;
		// this one then broke again at a gain of `3`, because it assumed the clamp was not reached at `BALL_SPEED_MAX`. Both
		// were the same mistake — restating the designer's number instead of the rule — so the expectation is now the function's
		// own definition, clamp included, and it holds for any gain the designer picks.
		const perSpeed = APPARENT_SPIN_GAIN / BASE_BALL_RADIUS;
		const expected = (speed: number) => math.min(APPARENT_SPIN_MAX_RAD_PER_SEC, perSpeed * speed);

		expect(apparentSpinRate(10)).toBeCloseTo(expected(10), 5);
		expect(apparentSpinRate(20)).toBeCloseTo(expected(20), 5);
		expect(apparentSpinRate(BALL_SPEED_MAX)).toBeCloseTo(expected(BALL_SPEED_MAX), 5);

		// The size-independence in one number: a rate that grew with the body would have to read its size from somewhere, and
		// the function has no argument for it.
		expect(apparentSpinRate(10)).toBe(apparentSpinRate(10));
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
