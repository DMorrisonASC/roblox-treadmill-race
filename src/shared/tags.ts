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
	/** Applied to every ball the server spawns, so cleanup can count them. */
	ball: "Ball",
} as const;
