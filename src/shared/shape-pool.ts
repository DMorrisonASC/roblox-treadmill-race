/**
 * What the spawner can spawn, and how spawn orientation is chosen.
 *
 * ## The spawner spawns spheres. That is a constraint, not an oversight.
 *
 * `SHAPE_POOL` has exactly one entry — `Ball`. Every spawn is a primitive `Part` sphere of the same
 * size. This is deliberate and it is the current instruction: spheres only, until the mesh pipeline
 * exists.
 *
 * **A reversal, recorded rather than appended.** The previous version of this file argued the
 * opposite case at length: that shape variety was the design goal, that a sphere is degenerate under
 * rotation while a cylinder or a corner wedge is not, and that the pool should therefore carry
 * `Ball`, `Cylinder` (1×1×2), `Block` (1×3×1) and `CornerWedge`. That argument was not wrong about
 * the physics; it was answering a question the designer had not settled. The survey behind it
 * (HANDOFF item 10 and its round report) still holds every measurement it made — the ~0.22 effective
 * friction, the tipping threshold, which shapes give bimodal outcomes under random rotation — and
 * that is precisely why it is kept as history: when meshes land, the pool is where that reasoning
 * gets reused. It is **not** a live decision today.
 *
 * `Cylinder`, `Block` and `CornerWedge` were therefore removed from the pool at the user's
 * instruction. The type still permits them, and re-adding one is a single array entry — the point of
 * keeping the pool shape at all is that the mesh/shape work will need exactly this structure, and
 * deleting it now would mean rebuilding it then.
 *
 * ## What the module still does besides the pick
 *
 * Three helpers here are load-bearing today even with a singleton pool, which is why the module is
 * not folded into `tuning.ts`:
 *
 *  - `randomSpawnRotation` supplies the spawn rotation. For a sphere that is geometrically a no-op —
 *    no orientation of a sphere is distinguishable from any other — but the spawn path is exercised
 *    on every spawn, so the future non-sphere case needs no new code.
 *  - `rotatedHalfHeight` computes the spawn clearance.
 *  - `poolMaxExtent` derives the kill plane.
 *
 * ## Why this is a repo constant and not a Studio attribute
 *
 * A shape is a `Enum.PartType` and a size is a `Vector3`; an attribute can hold only one scalar,
 * string, boolean or `Vector3`. Encoding a pool into attributes would mean either one attribute per
 * entry (`Shape1Type`, `Shape1Size`, …) or a string mini-language parsed at runtime. Both push a
 * config format onto the person who only wants to tag a part, and `Part.Shape` is not an
 * `AttributeValue` type at all — it would have to be stored as a name string and looked up. The pool
 * is therefore code: visible in a diff, type-checked, and impossible to half-configure.
 *
 * The cost is that retuning needs a rebuild, so it cannot be done from the Properties panel. That is
 * the right trade because the pool is a *design* decision — which silhouettes the game has — not a
 * per-instance tuning constant like `Rate`. If a later slice needs a different pool per spawner, the
 * honest mechanism is a new tag (one tag per pool) rather than widening this constant into a config
 * language.
 *
 * ## Why the pool is global rather than per-spawner
 *
 * Every spawner pulls from the same list, so "what can this game spawn?" has exactly one answer. A
 * per-spawner pool would make the answer "it depends which tag you happen to be standing next to",
 * and would need a selection mechanism (attribute? child folder? tag?) whose cost dwarfs the feature.
 * If per-spawner pools are wanted later, that is a tag per pool and a lookup at bind — additive, not
 * a rewrite.
 */

/** One entry in the spawn pool. `size` is the full `Part.Size`, not a radius. */
export interface ShapePoolEntry {
	/**
	 * `Enum.PartType` value for the spawned `Part`.
	 *
	 * `Enum.PartType` has six members and nothing here restricts which may be added: `Ball`, `Block`,
	 * `Cylinder`, `Wedge`, `CornerWedge`, `Capsule`. Only `Ball` is in the pool today, by instruction.
	 */
	readonly shape: Enum.PartType;
	readonly size: Vector3;
	/**
	 * Which power this entry's body carries, if any.
	 *
	 * **Nothing reads this today.** It exists so the next slice has a seam to fill rather than a type
	 * to change: a power that depends on the body's identity needs the body to *have* an identity
	 * before the power can be looked up, and adding the field later would mean touching the pool, the
	 * spawner, and every spawn call site at once.
	 *
	 * A string rather than a boolean or an enum because the pool is data: the set of powers is not
	 * known yet, and an enum here would force a code change to add one. `"standard"` means "no power",
	 * named rather than omitted so a later `undefined` cannot be read as "forgot to set it".
	 */
	readonly power?: string;
}

/**
 * **The only shape the spawner spawns.** One entry, so every spawn is a 1×1×1 `Part` sphere.
 *
 * `Size` is uniform because a `Part` of `Shape = Ball` is a sphere inscribed in its `Size` box, so
 * sizing all three axes equally is the only thing that expresses "a ball" unambiguously — a
 * non-uniform `Size` on a sphere would be a stretched ellipsoid, which is not what any part of this
 * design wants.
 *
 * The array is kept as a `ReadonlyArray<ShapePoolEntry>` rather than collapsed to a single exported
 * const because `pickPoolEntry`, `poolMaxExtent` and the spawner's logging all consume it as a list.
 * Collapsing it would mean rewriting three call sites to special-case "there is one shape", and then
 * rewriting them back when the pool grows. The cost of the indirection today is one array of length
 * one.
 *
 * `weight` was considered and is **not implemented**: an optional field that silently does nothing is
 * worse than no field, because the next person sets it, sees no change, and concludes the pool is
 * broken. With a singleton pool, weighting would be meaningless anyway.
 */
export const SHAPE_POOL: ReadonlyArray<ShapePoolEntry> = [
	{
		// The current and only shape. A perfect sphere is invariant under rotation, so the random spawn
		// rotation changes nothing about how this body behaves — which makes it the honest baseline for
		// every future non-sphere: when a cylinder or a corner wedge is added, its behaviour is
		// measured against this one, on this belt, at this `BeltSpeed`.
		shape: Enum.PartType.Ball,
		size: new Vector3(1, 1, 1),
		// No power yet. Named rather than omitted so a reader can tell "deliberately standard" from
		// "someone forgot the field" — the two look identical when a value is absent.
		power: "standard",
	},
];

/**
 * Uniform pick across the pool.
 *
 * Safe on a singleton: `math.random()` is `[0, 1)`, so `floor(r * 1)` is always `0`. There is no
 * assertion that the pool has more than one entry, and no division anywhere, so nothing here breaks
 * when the list is short — which matters because a one-entry pool is now the normal case rather than
 * a degenerate one.
 */
export function pickPoolEntry(): ShapePoolEntry {
	// roblox-ts arrays are 0-indexed in TypeScript and compile to 1-indexed Luau, so indexing with this
	// computed value is correct in source and in the emitted Lua.
	return SHAPE_POOL[math.floor(math.random() * SHAPE_POOL.size())];
}

/**
 * The largest single dimension across the pool, in studs. Used to size the kill plane.
 *
 * With the singleton ball this is exactly its diameter (1 stud), which is the same quantity the old
 * `2 * Radius` expression produced — so the kill plane is unchanged in value by the pool shrinking.
 * It stays a loop over the pool rather than a constant because its whole purpose is to remain correct
 * when the pool grows a longer body.
 */
export function poolMaxExtent(): number {
	let max = 0;
	for (const entry of SHAPE_POOL) {
		max = math.max(max, entry.size.X, entry.size.Y, entry.size.Z);
	}
	return max;
}

/**
 * A uniformly random rotation, returned as the two basis vectors `CFrame.fromMatrix` takes.
 *
 * ## This is currently inert, on purpose
 *
 * The only shape in the pool is `Ball`, and a sphere is invariant under rotation — so every rotation
 * this function returns produces a body that behaves identically to every other. It still runs on
 * every spawn so the spawn path never has a "shapes that need rotation" branch, and so the mesh case
 * later needs no new code here. If it is ever measured as waste, the honest removal is one call site
 * in `spawnBall`, not a rewrite of this function.
 *
 * ## Why not three uniform Euler angles
 *
 * `CFrame.Angles(math.random() * 2π, math.random() * 2π, math.random() * 2π)` is **not** uniform on
 * the rotation group. Three independent uniform angles cluster the result: frames pile up near
 * particular orientations and thin out elsewhere, and the distribution depends on the Euler order.
 * The visible symptom would be bodies that seem to "prefer" a landing angle — which reads as a
 * physics bug. Euler sampling is biased; a uniform quaternion is not, and it is barely longer to
 * write.
 *
 * ## What is used instead
 *
 * Shoemake's method: sample uniformly on the 4D unit sphere and read the result as a quaternion.
 * That is uniform on SO(3) by construction (the map S³ → SO(3) is a uniform double cover), needs
 * only three uniform randoms, and has no poles or division-by-zero singularities — unlike
 * axis-angle, which needs the correct non-uniform angle density and blows up as the angle
 * approaches zero.
 *
 * The quaternion is expanded to the first two *columns* of its rotation matrix, which are the images
 * of the world X and Y axes — precisely the `RightVector` and `UpVector` that `CFrame.fromMatrix(pos,
 * right, up)` expects. `fromMatrix` derives the third column itself as `right:Cross(up)`, so no
 * matrix multiplication or column-order assumption appears anywhere in this file.
 *
 * // Placeholder. The *method* is what is a placeholder here, not a number. Uniform-on-SO(3) is
 * // chosen because no orientation should be preferred. With a sphere in the pool it makes no
 * // observable difference; with a non-sphere it is the difference between an unbiased landing
 * // distribution and one with visible favourite angles.
 */
export function randomSpawnRotation(): { right: Vector3; up: Vector3 } {
	const u1 = math.random();
	const u2 = math.random() * 2 * math.pi;
	const u3 = math.random() * 2 * math.pi;

	const s1 = math.sqrt(1 - u1);
	const s2 = math.sqrt(u1);

	const qx = s1 * math.sin(u2);
	const qy = s1 * math.cos(u2);
	const qz = s2 * math.sin(u3);
	const qw = s2 * math.cos(u3);

	// Columns 1 and 2 of the rotation matrix for quaternion (qx, qy, qz, qw).
	return {
		right: new Vector3(1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw)),
		up: new Vector3(2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw)),
	};
}

/**
 * Half-height of a `Size`-shaped box after rotation, in studs.
 *
 * The standard rotated-AABB extent: project each half-axis onto Y and add the absolute values. This
 * is what guarantees the *lowest point* of the spawned part clears the belt, which a bare `Size.Y/2`
 * does not for a body that is not axis-aligned and not cubic — a 1×3×1 block is 3 tall upright and 1
 * tall lying down, and using the unrotated height would leave a lying block floating and an upright
 * one intersecting.
 *
 * ## It over-estimates for a sphere, and that is now visible on every spawn
 *
 * For `Ball` the true half-height is always `Size.Y / 2 = 0.5` regardless of rotation, because a
 * sphere is rotation-invariant. This function instead measures the rotated *box*, so for the 1×1×1
 * ball it returns the sum of the three basis vectors' absolute Y components times 0.5 — which for a
 * sphere evaluates to something in `[0.5, 0.866]` (minimum when one basis vector is vertical, maximum
 * `√3 / 2` when all three sit at equal angles to Y). **So a ball now spawns between 0.5 and 0.366
 * studs higher than the old unrotated spawn, varying randomly per spawn.**
 *
 * That is safe — it can only add clearance, never intersect — but it is not tight, and with a
 * singleton sphere pool it is pure noise: the drop height differs between otherwise identical spawns
 * for no reason a player could perceive as intentional. The tight fix is one line in `spawnBall`
 * (`entry.shape === Enum.PartType.Ball ? entry.size.Y / 2 : rotatedHalfHeight(...)`), deliberately
 * **not** applied, because spawn clearance is out of scope for the round that shrank the pool. It is
 * recorded here so the next person measures the spawn heights rather than assuming they are equal.
 */
export function rotatedHalfHeight(rotation: { right: Vector3; up: Vector3 }, size: Vector3): number {
	const back = rotation.right.Cross(rotation.up);

	return (
		math.abs(rotation.right.Y) * (size.X / 2) +
		math.abs(rotation.up.Y) * (size.Y / 2) +
		math.abs(back.Y) * (size.Z / 2)
	);
}
