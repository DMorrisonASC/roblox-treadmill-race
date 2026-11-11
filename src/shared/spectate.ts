/**
 * **When a player may choose to watch, and what the arena camera does when they have.**
 *
 * ## Why this is a module rather than three `if`s split between two controllers
 *
 * Two controllers have to agree: the spectate button decides whether to *offer* the choice, and the camera decides whether
 * to *honour* it. Written separately they drift in the one direction that is invisible in a single run — a button labelled
 * `Stop spectating` over a camera that has already handed itself back, or a button that reads `Spectate` while the arena
 * pose is on screen. The rules here are plain values, so both callers ask the same function and a spec can assert the
 * matrix without a player, a phase machine or a camera.
 *
 * ## The three facts the camera's rule is a function of
 *
 * - **the phase** — the arena camera belongs to `Waiting`, `Playing` and `PostGame`, and to nothing else (item 186);
 * - **whether this player is competing** — a competitor gets the arena pose automatically, because that is the game;
 * - **whether this player has asked to spectate** — a non-competitor gets it only by pressing the button.
 *
 * Before item 193 the rule was phase-keyed alone, so a player who was not in the round at all still had their camera taken
 * away for the whole round: the arena pose, with nothing they could do about it and nothing they had asked for. The button
 * only has a meaningful *off* state if that automatic engage stops happening to them.
 */

/**
 * The phases the arena camera is for: the ones in which a round exists to watch.
 *
 * `Intermission` is excluded on purpose, and the reason is the same one the spectator button uses: the arena is empty (every
 * body was cleared on the way in), the wipe covers the screen for part of it, and the next round has not been drawn yet. A
 * spectator in `Intermission` has nothing to spectate — the honest view is their own character in the lobby.
 *
 * Exported because `TreadmillCameraController` used to hold this set privately; one definition is what keeps the two
 * controllers from disagreeing about which phases exist to watch.
 */
export const ARENA_CAMERA_PHASES = new Set<string>(["Waiting", "Playing", "PostGame"]);

/**
 * Whether the button should be on screen at all: **only for a player who is not competing, and only in a phase with
 * something to watch.**
 *
 * A competitor never sees it — they are driving a ball, and their camera is already the arena. A non-competitor sees it in
 * `Waiting`, `Playing` and `PostGame`, which is exactly the window the camera can be taken over for, so the control is
 * offered precisely when pressing it does something.
 */
export function spectateAvailable(phase: string, competing: boolean): boolean {
	return !competing && ARENA_CAMERA_PHASES.has(phase);
}

/**
 * Whether the arena camera should be engaged, given everything the rule knows.
 *
 * **A competitor keeps the automatic engage** (item 186's rule, unchanged for every player it was written for); a
 * non-competitor gets it only while they have asked. That is the one-line answer to "if the camera auto-engages, do
 * non-competitors get excluded", and the cost is stated where the camera reads this: the phase rule alone no longer decides,
 * so a spectator who never presses the button watches from their own character for the whole round.
 */
export function cameraWantsArena(phase: string, competing: boolean, spectating: boolean): boolean {
	if (!ARENA_CAMERA_PHASES.has(phase)) {
		return false;
	}

	return spectating || competing;
}
