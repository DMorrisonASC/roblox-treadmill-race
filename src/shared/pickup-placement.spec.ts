import { describe, expect, it } from "@rbxts/jest-globals";
import { beltLocalToWorld, padFootprint, pickupBounds, rectsOverlap } from "./pickup-placement";
import { pickupDiscDiameter } from "./config/pickup.config";
import { PICKUP_EDGE_MARGIN, PICKUP_MAX_COUNT } from "./tuning";

/**
 * The belt the place contains, and the pad the designer set — **literals on purpose.**
 *
 * These are scene facts, not code constants: the whole point of `pickupBounds` is that it is given a belt size instead of
 * assuming one, so a test that read the size from `tuning.ts` would pass on a belt that had never been mentioned. `336 x 173`
 * is the belt in the place today; `20` is `PICKUP_SIZE`, which is a code value and is imported.
 */
const BELT_SIZE = new Vector3(336, 0.1, 173);
const PAD_SIZE = new Vector3(20, 20, 20);

/** `expect` has no reliable `toBeCloseTo` across this jest build (see `ui-scale.spec.ts`), so a tolerant compare is stated. */
function isNear(actual: number, expected: number): boolean {
	return math.abs(actual - expected) < 1e-3;
}

describe("pickupBounds", () => {
	it("subtracts half the pad on both horizontal axes for the scene's belt", () => {
		const bounds = pickupBounds(BELT_SIZE, PAD_SIZE, PAD_SIZE.X / 2);

		// 336 / 2 - 20 / 2 = 158, and 173 / 2 - 20 / 2 = 76.5. A pad centred here has its outer face flush with the belt edge
		// — which is the largest a wholly-on-the-belt pad can be, so the arithmetic is worth pinning.
		expect(bounds.maxX).toBe(158);
		expect(bounds.minX).toBe(-158);
		expect(bounds.maxZ).toBe(76.5);
		expect(bounds.minZ).toBe(-76.5);
	});

	it("leaves every corner of a pad placed at the bound exactly on the belt", () => {
		// **The assertion the change exists for.** "Entire collider on the belt" is not "the centre is on the belt": the
		// centre could sit half a pad outside it. At the bound, centre plus half-size touches the belt's half-extent and does
		// not pass it.
		const bounds = pickupBounds(BELT_SIZE, PAD_SIZE, PAD_SIZE.X / 2);

		expect(bounds.maxX + PAD_SIZE.X / 2).toBe(BELT_SIZE.X / 2);
		expect(bounds.maxZ + PAD_SIZE.Z / 2).toBe(BELT_SIZE.Z / 2);
		expect(bounds.minX - PAD_SIZE.X / 2).toBe(-BELT_SIZE.X / 2);
		expect(bounds.minZ - PAD_SIZE.Z / 2).toBe(-BELT_SIZE.Z / 2);
	});

	it("is strictly tighter than the belt's own half-extents", () => {
		// The old `PICKUP_X_MIN`/`PICKUP_X_MAX` pair was inside these bounds but knew nothing about them; the deliberate
		// difference here is that the band is a *derived* fraction of the belt, so a shorter belt cannot produce a pad past
		// its end.
		const bounds = pickupBounds(BELT_SIZE, PAD_SIZE, PAD_SIZE.X / 2);

		expect(bounds.maxX).toBeLessThan(BELT_SIZE.X / 2);
		expect(bounds.maxZ).toBeLessThan(BELT_SIZE.Z / 2);

		const shortBelt = pickupBounds(new Vector3(40, 0.1, 40), PAD_SIZE, PAD_SIZE.X / 2);
		expect(shortBelt.maxX).toBe(10);
	});

	it("uses the drawn radius when it reaches further than the pad (item 199)", () => {
		// **The case the signature exists for.** A picture wider than the collider is what the bound has to keep on the belt, so
		// the subtraction takes whichever reaches further. `168 - 30 = 138` here, against the pad's own `158`.
		const wide = pickupBounds(BELT_SIZE, PAD_SIZE, 30);

		expect(wide.maxX).toBe(138);
		expect(wide.maxZ).toBe(56.5);

		// And the reverse: a drawn radius smaller than the pad changes nothing, which is the shipped case.
		expect(pickupBounds(BELT_SIZE, PAD_SIZE, 5).maxX).toBe(158);
		expect(pickupBounds(BELT_SIZE, PAD_SIZE, 0).maxX).toBe(158);
	});

	it("keeps a visible margin of belt between the disc and the edge", () => {
		// **The fix for two rounds of "the pads are off the belt" (item 201).** Subtracting only the drawn radius leaves a pad at
		// the region's corner with its disc *tangent* to the belt edge: arithmetically inside, visually identical to overhanging.
		// The caller passes `drawRadius + PICKUP_EDGE_MARGIN`, so the clearance is the margin itself, at every legal placement.
		const margin = PICKUP_EDGE_MARGIN;
		const bounds = pickupBounds(BELT_SIZE, PAD_SIZE, PAD_SIZE.X / 2 + margin);

		expect(BELT_SIZE.X / 2 - bounds.maxX - PAD_SIZE.X / 2).toBe(margin);
		expect(BELT_SIZE.Z / 2 - bounds.maxZ - PAD_SIZE.X / 2).toBe(margin);

		// And the band is still wide enough to place the whole field: `12` pads on a `14 x 6` grid of 20-stud cells.
		const cells = math.floor((bounds.maxX * 2) / PAD_SIZE.X) * math.floor((bounds.maxZ * 2) / PAD_SIZE.Z);
		expect(cells >= PICKUP_MAX_COUNT).toBe(true);
	});

	it("keeps the disc inside the belt at every legal placement", () => {
		// **The assertion the round exists for, with literals (item 199/200).** A pad at the corner of the region draws its disc
		// as far as `bound + discRadius`; that must be **at or inside** the belt's half-extent, or the picture hangs over the
		// side. `168 - 10 + 10 = 168` and `86.5 - 10 + 10 = 86.5`: flush, which is the most a wholly-on-the-belt pad can do.
		const discRadius = pickupDiscDiameter(PAD_SIZE) / 2;
		const bounds = pickupBounds(BELT_SIZE, PAD_SIZE, discRadius);

		expect(bounds.maxX + discRadius).toBe(BELT_SIZE.X / 2);
		expect(bounds.maxZ + discRadius).toBe(BELT_SIZE.Z / 2);
		expect(bounds.minX - discRadius).toBe(-BELT_SIZE.X / 2);
		expect(bounds.minZ - discRadius).toBe(-BELT_SIZE.Z / 2);
	});

	it("leaves slack for the pad the log actually placed", () => {
		// The tightest placement in the reported run was `localZ = 74.255` on a `173`-stud belt. Its disc reaches `84.255`,
		// which is `2.245` studs inside the `86.5` edge — the number that disproves "the pads are off the belt".
		const discRadius = pickupDiscDiameter(PAD_SIZE) / 2;
		const placedLocalZ = 74.255;

		expect(placedLocalZ + discRadius).toBeLessThan(BELT_SIZE.Z / 2);
		expect(math.abs(placedLocalZ) <= BELT_SIZE.Z / 2 - discRadius).toBe(true);
	});

	it("keeps the wide axis of a non-square pad, whatever the drawn radius", () => {
		// The pad's half-extents are per-axis; the drawn circle is not. A `20 x 1 x 12` pad on a 40-wide belt: `X` keeps its
		// own 10 where the circle's 6 is smaller, and both axes are bounded by the 10 when the circle is that big.
		const narrowPad = new Vector3(20, 1, 12);

		expect(pickupBounds(new Vector3(100, 0.1, 100), narrowPad, 6).maxX).toBe(40);
		expect(pickupBounds(new Vector3(100, 0.1, 100), narrowPad, 6).maxZ).toBe(44);
	});

	it("collapses to the centre for a pad wider than the belt", () => {
		// There is no position at which such a pad is wholly on the belt. Returning an *inverted* band would make the drawn
		// candidate's span negative and place pads off the edge; collapsing to `0..0` is the honest degenerate answer. The
		// expected value is `0` and not `-0`: the log prints the bounds, and `-0` in a bounds field reads as a broken sign.
		const bounds = pickupBounds(new Vector3(10, 0.1, 10), new Vector3(20, 1, 20), 10);

		expect(bounds.minX).toBe(0);
		expect(bounds.maxX).toBe(0);
		expect(bounds.minZ).toBe(0);
		expect(bounds.maxZ).toBe(0);
	});

	it("ignores the belt's height", () => {
		// **No `Y` case, deliberately.** The pad rests on the invisible *floor* under the belt (`positionFor` adds
		// `BELT_SURFACE_THICKNESS` to the belt's own half-height), the pad is `CanCollide = false`, and a 20-stud pad can never
		// be inside a 0.1-stud slab. A Y bound would be a rule about the wrong part.
		const thin = pickupBounds(new Vector3(336, 0.1, 173), PAD_SIZE, PAD_SIZE.X / 2);
		const thick = pickupBounds(new Vector3(336, 40, 173), PAD_SIZE, PAD_SIZE.X / 2);

		expect(thin.maxX).toBe(thick.maxX);
		expect(thin.maxZ).toBe(thick.maxZ);
	});
});

describe("rectsOverlap", () => {
	it("reports false for two pads flush against each other", () => {
		// **The case `<=` would get wrong.** Two 20-stud pads 20 studs apart share a face and nothing else; a ball can pass
		// between them because neither volume contains any part of the other.
		const left = padFootprint(0, 0, PAD_SIZE);
		const right = padFootprint(20, 0, PAD_SIZE);

		expect(rectsOverlap(left, right)).toBe(false);
		expect(rectsOverlap(right, left)).toBe(false);

		const behind = padFootprint(0, 20, PAD_SIZE);
		expect(rectsOverlap(left, behind)).toBe(false);
	});

	it("reports true for pads that share area", () => {
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(19, 0, PAD_SIZE))).toBe(true);
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(0, 19.9, PAD_SIZE))).toBe(true);
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(5, 5, PAD_SIZE))).toBe(true);
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(0, 0, PAD_SIZE))).toBe(true);
	});

	it("reports true when one pad sits inside another", () => {
		const small = padFootprint(2, 2, new Vector3(4, 4, 4));
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), small)).toBe(true);
	});

	it("reports false for a corner-to-corner pair that a centre distance would reject", () => {
		// **Why this is rectangles and not `|Δ| < some radius`.** These centres are `sqrt(20^2 + 20^2) = 28.3` studs apart,
		// comfortably beyond any sensible distance threshold, and their colliders do not touch — yet the pair one stud closer
		// on each axis *would* touch whole faces. The axis test answers both correctly and a distance test answers one of them
		// wrongly whichever threshold it picks.
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(20, 20, PAD_SIZE))).toBe(false);
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(19, 19, PAD_SIZE))).toBe(true);
	});

	it("reports false for pads in different rows entirely", () => {
		expect(rectsOverlap(padFootprint(0, 0, PAD_SIZE), padFootprint(0, 40, PAD_SIZE))).toBe(false);
	});
});

describe("beltLocalToWorld", () => {
	it("survives a belt rotated by 90 degrees, because the frame is applied rather than assumed", () => {
		// **The test the deleted constants could not pass.** `PICKUP_X_MIN = -18` was a number on the world `X` axis, so on a
		// belt turned a quarter turn it would bound the *wrong* axis while still looking plausible. Here the bounds are local,
		// the conversion goes through the belt's own `CFrame`, and the pad at the bound is still exactly on the belt's edge.
		const rotated = new CFrame(0, 0, 0).mul(CFrame.Angles(0, math.rad(90), 0));
		const bounds = pickupBounds(BELT_SIZE, PAD_SIZE, PAD_SIZE.X / 2);

		const world = beltLocalToWorld(rotated, bounds.maxX, 0, bounds.maxZ);
		const back = rotated.PointToObjectSpace(world);

		// Round trip: a quarter turn maps local `(158, 0, 76.5)` to world `(76.5, 0, -158)`, and back again.
		expect(isNear(back.X, bounds.maxX)).toBe(true);
		expect(isNear(back.Z, bounds.maxZ)).toBe(true);

		// The world coordinates are *not* the local ones — which is the whole reason the numbers had to stop being absolute.
		expect(isNear(world.X, bounds.maxZ)).toBe(true);
		expect(isNear(world.Z, -bounds.maxX)).toBe(true);

		// And the pad is still wholly on the rotated belt, measured in the frame the rule is written in.
		expect(back.X + PAD_SIZE.X / 2 <= BELT_SIZE.X / 2).toBe(true);
		expect(back.Z + PAD_SIZE.Z / 2 <= BELT_SIZE.Z / 2).toBe(true);
	});
});

describe("the pad count against the belt", () => {
	it("can pack far more pads than a round asks for, so a draw rarely needs a retry", () => {
		// A grid packing of the belt is `floor(336 / 20) x floor(173 / 20) = 16 x 8 = 128` pads. Twelve is under a tenth of
		// that, which is what makes bounded rejection sampling the right rule: the band is sparse, so overlap is rare, and the
		// attempt bound is a guard against a broken scene rather than a load-bearing part of the algorithm.
		const capacity = math.floor(BELT_SIZE.X / PAD_SIZE.X) * math.floor(BELT_SIZE.Z / PAD_SIZE.Z);

		expect(capacity).toBe(128);
		expect(capacity).toBeGreaterThanOrEqual(PICKUP_MAX_COUNT);
	});
});
