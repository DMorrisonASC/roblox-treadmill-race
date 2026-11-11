import { describe, expect, it } from "@rbxts/jest-globals";
import { pickupDiscDiameter } from "./pickup.config";
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
