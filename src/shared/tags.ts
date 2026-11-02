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
} as const;
