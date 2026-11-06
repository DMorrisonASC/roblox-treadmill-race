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
	 * The elimination boundary. A ball whose **centre** leaves this part's box is out of the round.
	 *
	 * **A wall is a barrier *inside* the playable area; this is the boundary *around* it.** A ball touching a wall is
	 * still racing — only leaving the zone ends a ball's round. `RoundService` reads this tag and only this tag, never a
	 * wall's `Touched`, because conflating the two would mean a ball that brushed a guard rail was eliminated, which is the
	 * opposite of what a wall is for. **Walls need no tag of their own:** they block balls as ordinary scene geometry, and
	 * nothing in the code looks for a wall tag (item 94 deleted the last reader).
	 *
	 * The part is user-placed and invisible-by-design; nothing in this repository creates one. If the
	 * tag is absent the round still runs — `RoundService` warns once and treats every ball as alive.
	 */
	eliminationZone: "EliminationZone",
	/**
	 * A stationary boost marker sitting on the belt's surface. A ball touching one has its along-belt speed
	 * raised to `BOOST_TARGET_BALL_SPEED` and the marker is consumed.
	 *
	 * **Not a wall, deliberately.** A wall is permanent scene geometry that blocks a ball; a pickup is a one-shot reward
	 * that is destroyed on use. Sharing a tag between them would mean every wall became a consumable, and the two cannot be
	 * told apart from geometry alone.
	 *
	 * Server-only: these parts are created by `PickupService`, never by the scene, so unlike the belt and
	 * the spawner there is nothing for a designer to tag by hand. The tag still exists so cleanup can find
	 * them by the same mechanism as `Ball` rather than by folder position.
	 */
	pickup: "Pickup",
} as const;
