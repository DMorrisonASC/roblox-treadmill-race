import { describe, expect, it } from "@rbxts/jest-globals";
import { pickupDiscDiameter, pickupDrawRadius } from "./pickup.config";
import { PICKUP_SIZE } from "../tuning";

/**
 * The painted disc against the collider it describes.
 *
 * ## Why this is a spec and not a log line
 *
 * The bug it guards is arithmetic, not perception: the disc was drawn **at the scale multiplier** while the collider was not,
 * so at a 20-stud pad it painted an 80-stud ring around a 20-stud box. A ball inside the paint collected nothing, and every
 * number in the log was individually defensible — the pad's `Size` was right, the multiplier was right, and only the product
 * was wrong. The one assertion that catches it is "the disc equals the collider's inscribed circle", and it is cheap enough to
 * keep.
 */

describe("pickupDiscDiameter", () => {
	it("equals the pad's own width for a square pad", () => {
		// **The assertion the whole round exists for.** No multiplier, no scale, no ball ratio: the disc is the collider's
		// inscribed circle, so its diameter is the pad's width exactly. If this ever drifts above `1.00` of the pad the paint
		// promises reach the collider does not have.
		expect(pickupDiscDiameter(PICKUP_SIZE)).toBe(math.min(PICKUP_SIZE.X, PICKUP_SIZE.Z));
	});

	it("is the narrow axis for a pad that is not square", () => {
		// A designer may make the pad `20 x 1 x 12`; the circle must fit the narrow axis or it overhangs the box on that side.
		expect(pickupDiscDiameter(new Vector3(20, 1, 12))).toBe(12);
		expect(pickupDiscDiameter(new Vector3(12, 1, 20))).toBe(12);
	});

	it("is unaffected by the pad's height", () => {
		// The footprint is a horizontal circle; `Y` is depth into the floor, not reach.
		expect(pickupDiscDiameter(new Vector3(10, 1, 10))).toBe(10);
		expect(pickupDiscDiameter(new Vector3(10, 40, 10))).toBe(10);
	});
});

describe("pickupDrawRadius", () => {
	it("is the pad's own half-width for the shipped pad and multiplier", () => {
		// The awkward fact this case records: **the disc already equals the collider** (item 190), and the sprite is smaller
		// than both, so the drawn radius and the pad radius agree today. The bound is therefore unchanged on the shipped belt --
		// the derivation exists so that the next retune cannot move it silently in the wrong direction.
		expect(pickupDrawRadius(PICKUP_SIZE, 0.2)).toBe(math.min(PICKUP_SIZE.X, PICKUP_SIZE.Z) / 2);
	});

	it("becomes the sprite when the multiplier grows past the pad", () => {
		// **The case the function exists for.** `PICKUP_SCALE_MULTIPLIER` is a look a designer retunes by eye, and it sizes the
		// sprite only. At `1.0` the sprite draws `2.6 x 20 = 52` studs wide -- a `26`-stud radius, more than double the pad's
		// `10` -- and a bound that only knew about the pad would put a picture past the belt's edge with no code change anywhere.
		expect(pickupDrawRadius(PICKUP_SIZE, 1)).toBeGreaterThan(PICKUP_SIZE.X / 2);
		expect(pickupDrawRadius(PICKUP_SIZE, 1)).toBeCloseTo(26, 5);
	});

	it("never reports less than the pad, whatever the multiplier", () => {
		// A multiplier of zero shrinks the sprite to nothing; the pad is still there and is still what has to stay on the belt.
		expect(pickupDrawRadius(PICKUP_SIZE, 0)).toBe(PICKUP_SIZE.X / 2);
	});

	it("follows a non-square pad's narrow axis", () => {
		// The drawn things are circles, so they are bounded by the narrow axis -- the same reason `pickupDiscDiameter` uses
		// `min`. A `20 x 1 x 12` pad is `6` at its narrowest however wide the other axis is.
		expect(pickupDrawRadius(new Vector3(20, 1, 12), 0.2)).toBe(6);
	});
});
