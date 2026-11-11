/**
 * Where a pad may be put on a belt, and when two pads are in each other's way.
 *
 * ## Why this is a module rather than three lines inside `PickupService`
 *
 * Every rule here is arithmetic about two boxes and a surface, and each has a failure mode that reads as a *scene* bug
 * rather than a code bug: a pad hanging off the belt looks like a missing edge, two pads on the same spot look like one pad,
 * and a pad placed with world-space bounds on a rotated belt looks like a pad lying on the floor beside the belt. Pure
 * functions are the only form in which those can be asserted with literals — see `pickup-placement.spec.ts`.
 *
 * **Everything here is belt-local.** `X` runs along the belt, `Z` across it, and the origin is the belt's centre, because
 * that is what `CFrame.PointToObjectSpace` produces and what the world position is built from with
 * `CFrame.ObjectSpaceToPoint` (`beltLocalToWorld` below). The belt's own rotation is therefore not this module's business:
 * a rotated belt has the same *local* bounds, and the same arithmetic, because the frame is applied by the caller.
 */

/**
 * The centres in `X`/`Z` at which a pad's **entire collider** is still on the belt, in belt-local studs.
 *
 * Inclusive: a pad centred exactly at `maxX` has its outer face flush with the belt's edge, which is the largest a "fully on
 * the belt" pad can be.
 */
export interface PickupBounds {
	readonly minX: number;
	readonly maxX: number;
	readonly minZ: number;
	readonly maxZ: number;
}

/**
 * A pad's centre and half-extents in belt-local `X`/`Z`: the rectangle its collider occupies seen from above.
 *
 * Half-extents rather than full size because every test written against it is "do these two rectangles overlap", and that
 * question is `|dx| < a.half + b.half` — with full sizes it would need a `/ 2` in every comparison, which is where a factor of
 * two gets dropped.
 */
export interface PickupFootprint {
	readonly x: number;
	readonly z: number;
	readonly halfX: number;
	readonly halfZ: number;
}

/**
 * The band of pad centres for which the pad is wholly on the belt: **the belt's half-extents minus the pad's**, on both
 * horizontal axes.
 *
 * ## Why the subtraction is in `Size` and not in `PICKUP_X_MIN`-style constants
 *
 * The previous bounds were two absolute numbers (`-18`, `+23`) chosen against one 336-stud belt by eye. They could not move
 * when the scene did: a shorter belt put pads past its end, a longer one wasted the ends, and a belt rotated in Studio put
 * every pad in the wrong world axis while the numbers still looked plausible. A bound derived from `belt.Size` is right for
 * any belt the place contains, and the belt's frame is applied afterwards by the caller.
 *
 * ## Why there is no `Y`
 *
 * The pad's height is **not** constrained by the belt, and must not be. `positionFor` lifts the pad so its centre is
 * `belt.Size.Y / 2 + BELT_SURFACE_THICKNESS + PICKUP_SIZE.Y / 2` above the belt's centre — that is, resting on the top face
 * of the *invisible floor*, which is a separate part `TreadmillService` creates under the belt and is not the belt at all.
 * A 20-stud pad can never be "inside" a 0.1-stud belt, and it does not need to be: it is a `CanCollide = false` `Touched`
 * volume, and hanging above the surface with room for a ball to enter it is the whole of its job.
 *
 * ## The clamp, and the scene it refuses to pretend about
 *
 * `math.max(0, …)` collapses the band to the belt's centre when the pad is wider than the belt. There is no position at which
 * such a pad is wholly on the belt, so the honest answers are "the centre, and say so in the log" or an exception at boot;
 * returning an *inverted* band (`maxX < minX`) is the one that would be silently wrong, because the caller's `min + random *
 * (max - min)` would then place pads beyond the edge with a negative span that looks like a bug in the random draw.
 */
export function pickupBounds(beltSize: Vector3, padSize: Vector3): PickupBounds {
	const reachX = math.max(0, beltSize.X / 2 - padSize.X / 2);
	const reachZ = math.max(0, beltSize.Z / 2 - padSize.Z / 2);

	// `0 - reach` rather than `-reach`: negating zero gives `-0`, which is equal to `0` everywhere except the one place it
	// would be read — a log field, where `tostring` prints it as `-0` and a collapsed band looks like a broken sign.
	return { minX: 0 - reachX, maxX: reachX, minZ: 0 - reachZ, maxZ: reachZ };
}

/** The footprint of a pad centred at a belt-local `(localX, localZ)`. */
export function padFootprint(localX: number, localZ: number, padSize: Vector3): PickupFootprint {
	return { x: localX, z: localZ, halfX: padSize.X / 2, halfZ: padSize.Z / 2 };
}

/**
 * Whether two pads' colliders overlap when seen from above.
 *
 * ## Axis-aligned rectangles, not a centre distance
 *
 * A pad is a box, so its occupancy is a rectangle, and two 20 x 20 pads whose centres are 24 studs apart along a diagonal do
 * not touch — a distance test would reject that pair and then accept two pads 19 apart along an axis, i.e. exactly the pair
 * that *does* overlap. The boxes are axis-aligned **in the belt's frame** because `createPickup` orients each pad by
 * `belt.CFrame.RightVector`, so the belt-local rectangle is the true footprint rather than an approximation of it.
 *
 * ## Why `<` and not `<=`
 *
 * **Two pads flush against each other do not overlap.** Their colliders share a face and nothing else; a ball can sit between
 * them and neither volume contains any part of the other. `<` says exactly that, and it is the case a `<=` would report as a
 * collision — which, under a placement rule that rejects candidates, is a band of legal positions removed for no reason.
 */
export function rectsOverlap(a: PickupFootprint, b: PickupFootprint): boolean {
	const overlapX = math.abs(a.x - b.x) < a.halfX + b.halfX;
	const overlapZ = math.abs(a.z - b.z) < a.halfZ + b.halfZ;

	return overlapX && overlapZ;
}

/**
 * A belt-local point in world space: the one conversion every pickup position goes through.
 *
 * `PointToObjectSpace` is its inverse, and both are used — this one to build a pad's `Position`, that one to recover a live
 * pad's belt-local `Z` (and now its whole footprint) from where it ended up. Keeping the pair behind one function means a
 * rotated belt cannot be handled correctly in one place and incorrectly in the other, which is the mistake `PICKUP_X_MIN`
 * could not even report: it was a world-axis number, so it was right for exactly one belt orientation.
 */
export function beltLocalToWorld(beltCFrame: CFrame, localX: number, lift: number, localZ: number): Vector3 {
	return beltCFrame.mul(new CFrame(localX, lift, localZ)).Position;
}
