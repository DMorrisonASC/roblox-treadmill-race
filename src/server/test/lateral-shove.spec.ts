import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_COLLISION_SHOVE_DECAY_SECONDS, BALL_COLLISION_SHOVE_SPEED } from "shared/tuning";
import {
	clampShove,
	forgetLateralShove,
	lateralShoveFor,
	shoveDirection,
	shoveLateral,
	shoveStep,
} from "../lateral-shove";

/**
 * The contact shove, as arithmetic.
 *
 * ## What this can and cannot prove
 *
 * The shove is a vector and an exponential decay, so both are assertable without a `BasePart` or a physics step — that is
 * why the module keeps its maths in exported functions and its map behind four thin wrappers. What it cannot prove is the
 * thing the change exists for: whether 1.5 studs of lateral movement reads as a hit under the belt camera, and whether
 * adding it to the sway's write produces the wave the sway already promised. Those are Studio observations.
 */

const DT = 1 / 60;

describe("shoveDirection", () => {
	it("is the horizontal unit vector from one body to the other", () => {
		const direction = shoveDirection(new Vector3(0, 3, 0), new Vector3(3, 9, 4), 1);

		// `1e-6`, not `1e-9`: a `Vector3`'s components are 32-bit floats, so `Unit` returns the nearest float to `0.6`,
		// which differs from the double literal by about `2e-8`. A tighter bound would be asserting float width, not the
		// direction.
		expect(math.abs(direction.Y) < 1e-6).toBe(true);
		expect(math.abs(direction.Magnitude - 1) < 1e-6).toBe(true);
		expect(math.abs(direction.X - 0.6) < 1e-6).toBe(true);
		expect(math.abs(direction.Z - 0.8) < 1e-6).toBe(true);
	});

	it("uses the tie break when the two bodies are coincident or stacked", () => {
		// Two `Touched` events can arrive for bodies whose horizontal offsets are zero; the sign then has to be decided
		// rather than drawn, so both halves of one pair agree.
		const coincident = shoveDirection(new Vector3(5, 1, 5), new Vector3(5, 1, 5), 1);
		const stacked = shoveDirection(new Vector3(5, 1, 5), new Vector3(5, 7, 5), 1);

		for (const direction of [coincident, stacked]) {
			expect(math.abs(direction.Y) < 1e-9).toBe(true);
			expect(math.abs(direction.Magnitude - 1) < 1e-9).toBe(true);
		}

		// The parity of the serial, not a coin, so the same pair always gets the same answer.
		expect(coincident.Z).toBe(shoveDirection(new Vector3(1, 0, 1), new Vector3(1, 0, 1), 1).Z);
		expect(coincident.Z !== shoveDirection(new Vector3(1, 0, 1), new Vector3(1, 0, 1), 2).Z).toBe(true);
		expect(coincident.Z === stacked.Z).toBe(true);
	});
});

describe("shoveStep", () => {
	it("decays by e^-1 over one time constant", () => {
		const decayed = shoveStep(new Vector3(4, 0, 0), BALL_COLLISION_SHOVE_DECAY_SECONDS);
		// Same float-width bound as the direction test: the component is stored as a 32-bit float.
		expect(math.abs(decayed.X - 4 / math.exp(1)) < 1e-6).toBe(true);
	});

	it("halves over ln(2) time constants", () => {
		const half = shoveStep(new Vector3(6, 0, 0), math.log(2) * BALL_COLLISION_SHOVE_DECAY_SECONDS);
		expect(math.abs(half.X - 3) < 1e-6).toBe(true);
	});

	it("does not depend on how the interval is sliced", () => {
		// Two half-steps and one whole step have to agree to within float noise, or the shove would last longer on a slow
		// frame. This is the property the per-frame multiplier would have failed.
		const once = shoveStep(new Vector3(0, 0, 5), BALL_COLLISION_SHOVE_DECAY_SECONDS);
		const twice = shoveStep(
			shoveStep(new Vector3(0, 0, 5), BALL_COLLISION_SHOVE_DECAY_SECONDS / 2),
			BALL_COLLISION_SHOVE_DECAY_SECONDS / 2,
		);
		expect(math.abs(once.Z - twice.Z) < 1e-9).toBe(true);
	});

	it("moves a body about speed x time constant in total", () => {
		// Summing the per-tick displacement of a decaying shove is the distance a ball actually travels sideways: the
		// number quoted in `BALL_COLLISION_SHOVE_SPEED`'s docblock.
		let travelled = 0;
		let current = new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED);
		for (let step = 0; step < 240; step++) {
			travelled += current.Z * DT;
			current = shoveStep(current, DT);
		}

		// The game's distance is the **discrete** sum, not the integral, so it lands slightly above
		// `speed * decay` (about 2.8% at 60 Hz): a right-endpoint sum of a decaying sequence overestimates it by
		// `x / (1 - e^-x)` with `x = dt / T`. `5%` covers that and the frame rate, which is what the docblock's
		// "about 1.5 studs" is claiming.
		const expected = BALL_COLLISION_SHOVE_SPEED * BALL_COLLISION_SHOVE_DECAY_SECONDS;
		expect(travelled > expected).toBe(true);
		expect(math.abs(travelled - expected) < expected * 0.05).toBe(true);
	});
});

describe("clampShove", () => {
	it("caps an accumulation at one impulse's speed", () => {
		const capped = clampShove(new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED * 3));
		expect(math.abs(capped.Magnitude - BALL_COLLISION_SHOVE_SPEED) < 1e-9).toBe(true);
	});

	it("leaves an under-cap sum alone", () => {
		const sum = new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED / 2);
		expect(math.abs(clampShove(sum).Magnitude - sum.Magnitude) < 1e-9).toBe(true);
	});

	it("lets two opposite impulses from one pile cancel", () => {
		// A ball squeezed from both sides should sit still, not take whichever impulse happened to be recorded last.
		const cancelled = clampShove(
			new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED).add(new Vector3(0, 0, -BALL_COLLISION_SHOVE_SPEED)),
		);
		expect(cancelled.Magnitude < 1e-9).toBe(true);
	});
});

describe("the shove state", () => {
	it("decays what was recorded and eventually forgets it", () => {
		// A plain table is enough of a map key; nothing here reads a property of the body.
		const body = {} as BasePart;

		expect(lateralShoveFor(body, DT).Magnitude).toBe(0);

		shoveLateral(body, new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED));
		const first = lateralShoveFor(body, DT);
		const second = lateralShoveFor(body, DT);

		expect(first.Z > 0).toBe(true);
		expect(second.Z > 0).toBe(true);
		expect(second.Z < first.Z).toBe(true);

		// Past the epsilon the entry is deleted rather than carried forever; a body that has settled reads zero.
		for (let step = 0; step < 240; step++) {
			lateralShoveFor(body, DT);
		}
		expect(lateralShoveFor(body, DT).Magnitude).toBe(0);
	});

	it("forgets a body that left the world", () => {
		const body = {} as BasePart;
		shoveLateral(body, new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED));
		forgetLateralShove(body);
		expect(lateralShoveFor(body, DT).Magnitude).toBe(0);
	});
});
