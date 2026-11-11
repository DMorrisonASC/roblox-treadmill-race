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
		// Enough steps to cover ten time constants, so the residual tail is under `1e-4` of the total. A shorter loop stops
		// while the shove is still moving and lands *below* `speed * decay`, which is the opposite of what the discrete sum
		// does once it has run out.
		const steps = math.ceil((BALL_COLLISION_SHOVE_DECAY_SECONDS * 10) / DT);
		let travelled = 0;
		let current = new Vector3(0, 0, BALL_COLLISION_SHOVE_SPEED);
		for (let step = 0; step < steps; step++) {
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

describe("the contact normal, resolved onto the belt's two model axes (item 203)", () => {
	// The axes `stepBallSpeeds` writes. **`RightVector` is the *along-belt* axis, not the lateral one** (item 93): this
	// scene's belt has `RightVector = (0, 0, -1)` and world up, so `right` is world `-Z` and `across = right:Cross(up)` is
	// world `+X`. Two bodies separated in world `Z` are therefore a **head-on** pair, and two separated in world `X` are
	// side by side — the opposite of what the axis names suggest if they are read as world axes.
	const RIGHT = new Vector3(0, 0, -1);
	const ACROSS = RIGHT.Cross(new Vector3(0, 1, 0)).Unit;

	it("puts a head-on contact's shove along the belt", () => {
		// The case that used to be thrown away. Both bodies are at the same `X`, 20 studs apart in `Z` — one behind the
		// other — so the normal is almost entirely `right`. Before item 203 the writer kept only the `across` projection and
		// this shove was nearly zero, while `[Powers] shove:` printed `dir.X = +-1` and looked correct.
		const direction = shoveDirection(new Vector3(0, 0, 0), new Vector3(0, 0, 20), 1);

		expect(math.abs(direction.Dot(RIGHT)) > math.abs(direction.Dot(ACROSS))).toBe(true);
		expect(math.abs(math.abs(direction.Dot(RIGHT)) - 1) < 1e-6).toBe(true);
	});

	it("puts a side-by-side contact's shove across the belt", () => {
		const direction = shoveDirection(new Vector3(0, 0, 0), new Vector3(20, 0, 0), 1);

		expect(math.abs(direction.Dot(ACROSS)) > math.abs(direction.Dot(RIGHT))).toBe(true);
	});

	it("gives a diagonal contact both components", () => {
		// Neither axis may dominate, or a 45-degree hit would collapse to one of the two behaviours above.
		const direction = shoveDirection(new Vector3(0, 0, 0), new Vector3(14, 0, 14), 1);
		const along = math.abs(direction.Dot(RIGHT));
		const lateral = math.abs(direction.Dot(ACROSS));

		expect(along > 0.5).toBe(true);
		expect(lateral > 0.5).toBe(true);
		expect(math.abs(along - lateral) < 1e-6).toBe(true);
	});

	it("gives the pair equal and opposite shoves, each still one impulse", () => {
		// `maybeShove` records `direction.mul(-SPEED)` on one body and `direction.mul(+SPEED)` on the other: **repulsive and
		// symmetric**, which is the sign convention the two-axis writer relies on. This is a pure restatement of that pair,
		// so a sign flipped at the call site shows up here rather than as two balls gliding the same way.
		const direction = shoveDirection(new Vector3(0, 0, 0), new Vector3(14, 0, 14), 1);
		const mine = clampShove(direction.mul(-BALL_COLLISION_SHOVE_SPEED));
		const theirs = clampShove(direction.mul(BALL_COLLISION_SHOVE_SPEED));

		expect(mine.add(theirs).Magnitude < 1e-6).toBe(true);
		expect(math.abs(theirs.Magnitude - BALL_COLLISION_SHOVE_SPEED) < 1e-4).toBe(true);
	});

	it("does not halve a dead-on shove between the two axes", () => {
		// The clamp is on the **vector**, so a head-on contact puts the whole `BALL_COLLISION_SHOVE_SPEED` on the along-belt
		// axis rather than `SPEED / sqrt(2)` on each. This is the number that makes "2D shove" the same strength as the old
		// sideways one instead of a weaker one spread over two directions.
		const direction = shoveDirection(new Vector3(0, 0, 0), new Vector3(6, 0, -20), 1);
		const shove = clampShove(direction.mul(BALL_COLLISION_SHOVE_SPEED));
		const along = math.abs(shove.Dot(RIGHT));
		const lateral = math.abs(shove.Dot(ACROSS));

		expect(math.abs(math.sqrt(along * along + lateral * lateral) - BALL_COLLISION_SHOVE_SPEED) < 1e-4).toBe(true);
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

		// Past the epsilon the entry is deleted rather than carried forever; a body that has settled reads zero. Ten time
		// constants rather than a fixed step count, so the assertion does not silently stop working when the decay constant
		// is retuned — that is exactly how this test broke once already.
		const steps = math.ceil((BALL_COLLISION_SHOVE_DECAY_SECONDS * 10) / DT);
		for (let step = 0; step < steps; step++) {
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
