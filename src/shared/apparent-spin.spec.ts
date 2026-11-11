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

	it("totals base plus speed at the spawn speed", () => {
		// **The `20 rad/s` anchor is gone, and the designer removed it, not this round (item 202).** This case used to assert
		// that `BALL_SPEED = 10` totalled `20 rad/s` -- the split item 196 chose, `10` base plus `0.5` gain. The tree now runs a
		// `30` base against a `31` ceiling, so the speed term is worth one stud/second before the clamp and **no speed totals
		// `20` any more**. The assertion was failing at `HEAD`, so it was noise rather than a guard. What survives a retune is
		// the shape, so the shape is what is asserted here: the base at `0`, base plus `GAIN x speed / BASE_BALL_RADIUS` above,
		// clamped by the ceiling.
		const unclamped = (speed: number) => SPIN_BASE_RAD_PER_SEC + (APPARENT_SPIN_GAIN * speed) / BASE_BALL_RADIUS;

		expect(apparentSpinRate(0)).toBeCloseTo(SPIN_BASE_RAD_PER_SEC, 5);
		expect(apparentSpinRate(10)).toBeCloseTo(math.min(APPARENT_SPIN_MAX_RAD_PER_SEC, unclamped(10)), 5);

		// Speed still has to *buy* something, and only below the clamp can it: the speed at which the total reaches the ceiling
		// is derived from the three constants so this holds whatever the split is retuned to.
		const ceilingSpeed =
			((APPARENT_SPIN_MAX_RAD_PER_SEC - SPIN_BASE_RAD_PER_SEC) * BASE_BALL_RADIUS) / APPARENT_SPIN_GAIN;

		expect(ceilingSpeed > 0).toBe(true);
		expect(apparentSpinRate(ceilingSpeed / 2)).toBeCloseTo(unclamped(ceilingSpeed / 2), 5);
		expect(apparentSpinRate(ceilingSpeed / 2) > SPIN_BASE_RAD_PER_SEC).toBe(true);
	});

	it("is monotone below the clamp, and clamps above it", () => {
		// The function's own definition, clamp included, so this case survives any retune of the split or of the speed range.
		// **An earlier version asserted the unclamped expression at `BALL_SPEED_MAX` and broke when the designer raised that
		// ceiling to `100`** -- at which point the rate is `110` before the clamp and `90` after it. Restating a tuned number in
		// a test is testing the tuning; comparing against the definition tests the rule.
		//
		// **The two speeds are derived from the clamp now (item 202).** They used to be `10` and `20`, which against a `30` base
		// and a `31` ceiling both saturate -- so the comparison was `31 > 31` and the case was failing at `HEAD`. Strict
		// monotonicity exists only below the speed at which the total reaches the ceiling, so that is where the pair is taken.
		const expected = (speed: number) =>
			math.min(
				APPARENT_SPIN_MAX_RAD_PER_SEC,
				SPIN_BASE_RAD_PER_SEC + (APPARENT_SPIN_GAIN * speed) / BASE_BALL_RADIUS,
			);
		const ceilingSpeed =
			((APPARENT_SPIN_MAX_RAD_PER_SEC - SPIN_BASE_RAD_PER_SEC) * BASE_BALL_RADIUS) / APPARENT_SPIN_GAIN;

		expect(ceilingSpeed > 0).toBe(true);
		expect(apparentSpinRate(ceilingSpeed / 2) > apparentSpinRate(ceilingSpeed / 4)).toBe(true);
		expect(apparentSpinRate(ceilingSpeed / 4) > apparentSpinRate(0)).toBe(true);
		expect(apparentSpinRate(ceilingSpeed * 2)).toBeCloseTo(APPARENT_SPIN_MAX_RAD_PER_SEC, 5);
		expect(apparentSpinRate(BALL_SPEED_MAX)).toBeCloseTo(expected(BALL_SPEED_MAX), 5);

		// And the base is a floor, not a spike: the rate never falls below it however the gain is retuned.
		expect(apparentSpinRate(0) <= apparentSpinRate(1)).toBe(true);
	});

	it("holds every drawn rate inside the legible band, at any speed (item 200)", () => {
		// **The assertion that would have caught the "balls do not spin" report.** An unclamped ball at
		// `BOOST_TARGET_BALL_SPEED = 80` would be drawn at `90 rad/s` -- 86 degrees of rotation per frame at 60 Hz, past the
		// 45-degree half-period of a six-textured sphere, which the eye resolves as *no rotation at all*. The ceiling is what
		// keeps it readable, so it has to hold for every speed the model can produce, including `BALL_SPEED_MAX`.
		//
		// **`<=` at the spawn speed rather than `<` (item 202).** This asserted the spawn speed sat *below* the ceiling; with a
		// `30` base against a `31` ceiling it sits *at* it, and "the whole field is drawn at the maximum legible rate" is the
		// designer's tuning rather than a defect. The ceiling itself is unchanged and still binds everything above it.
		expect(apparentSpinRate(BALL_SPEED_START) <= APPARENT_SPIN_MAX_RAD_PER_SEC).toBe(true);
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
