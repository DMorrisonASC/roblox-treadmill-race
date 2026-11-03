/**
 * CollectionService tags are the only coupling between the scene and these systems: a part in
 * Studio becomes a belt by carrying a tag, not by being in a particular folder or having a
 * particular name. That keeps the code free of hardcoded instance paths and lets a designer move,
 * copy or re-CFrame a fixture without touching TypeScript.
 *
 * No part is created by this repository. The Rojo project defines nothing under `Workspace`, so
 * Rojo never resets, recreates or deletes the tagged parts — the tags are applied by hand in
 * Studio, which means this file is the only place the strings are declared, and renaming one here
 * means re-tagging the parts by hand.
 */
export const TAGS = {
	/** BaseParts are dragged along by `TreadmillService`. */
	treadmillBelt: "TreadmillBelt",
	/** BaseParts that act as ball factories for `BallSpawnerService`. */
	ballSpawner: "BallSpawner",
	/**
	 * Applied to every ball the server spawns, so cleanup can count them.
	 *
	 * Deliberately **not** applied to the welded pole markers and equator ring. Those are children of
	 * the ball and would otherwise be counted as live bodies by the cleanup pass and by the diagnostic
	 * lane-occupancy count, which would inflate both by a factor of four.
	 */
	ball: "Ball",
	/**
	 * Applied to each welded visual marker (two poles, one ring) so a later cleanup or debugging pass
	 * can find them without walking every ball's children. Nothing reads this tag today: the markers
	 * are children of the ball, so `Destroy()` on the ball takes them with it.
	 */
	ballDecoration: "BallDecoration",
	/**
	 * BaseParts that act as a "speed giver" — a ball touching one gets a small forward impulse. See
	 * `WALL_ASSIST_*` in `tuning.ts` for the arithmetic and `TreadmillService.applyWallAssist`.
	 *
	 * **The tag is the only thing that makes a part a wall.** There is no wall geometry in this
	 * repository and no code that creates, moves, or resizes one; the user places them in Studio and
	 * tags them. Untagging a wall stops the assist on the next bind cycle and leaves the part exactly
	 * where it was, still colliding — which is the guard-rail behaviour, minus the boost.
	 *
	 * Deliberately not called "Wall": a bare `Wall` would collide with any future scene object that
	 * happens to be a wall, and the assist is specifically a treadmill-side affordance rather than a
	 * general property of vertical geometry.
	 */
	treadmillWall: "TreadmillWall",
	/**
	 * The elimination boundary. A ball whose **centre** leaves this part's box is out of the round.
	 *
	 * **Distinct from `TreadmillWall`, and the distinction is load-bearing.** A wall is a barrier
	 * *inside* the playable area — a ball touching one is still racing. A zone is the boundary *around*
	 * it, and only leaving it ends a ball's round. `RoundService` reads this tag and only this tag;
	 * it never connects to a wall's `Touched` and never asks whether a ball is touching a wall. The two
	 * systems are deliberately unaware of each other, because conflating them would mean a ball that
	 * brushed a guard rail was eliminated, which is the opposite of what the wall is for.
	 *
	 * The part is user-placed and invisible-by-design; nothing in this repository creates one. If the
	 * tag is absent the round still runs — `RoundService` warns once and treats every ball as alive.
	 */
	eliminationZone: "EliminationZone",
	/**
	 * A stationary boost marker sitting on the belt's surface. A ball touching one has its along-belt speed
	 * raised to `BOOST_TARGET_BALL_SPEED` and the marker is consumed.
	 *
	 * **Not `TreadmillWall`, deliberately.** The wall assist exists to keep a ball that is already racing
	 * from stalling against a barrier; a pickup is a one-shot reward that is destroyed on use. Sharing the
	 * tag would mean every wall became a consumable and every pickup became a permanent push, and the two
	 * behaviours cannot be told apart from geometry alone.
	 *
	 * Server-only: these parts are created by `PickupService`, never by the scene, so unlike the belt and
	 * the spawner there is nothing for a designer to tag by hand. The tag still exists so cleanup can find
	 * them by the same mechanism as `Ball` rather than by folder position.
	 */
	pickup: "Pickup",
} as const;
