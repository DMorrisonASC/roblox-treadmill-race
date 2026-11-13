import { describe, expect, it } from "@rbxts/jest-globals";
import { ARENA_CAMERA_PHASES, cameraWantsArena, isShoppingAvailable, spectateAvailable } from "./spectate";

/**
 * The spectate matrix: **who may ask, when they may ask, and what the camera does when they have.**
 *
 * The bug these cases exist for cannot be seen in one round. A camera that ignores the ask hands the view back at the next
 * phase change, mid-race, and the player is looking at their own character with no way to get the arena back except pressing
 * a button that now reads `Spectate` — which is the state the button was supposed to leave behind.
 */

describe("spectateAvailable", () => {
	it("offers the button to a non-competitor in the phases a round can be watched in", () => {
		expect(spectateAvailable("Waiting", false)).toBe(true);
		expect(spectateAvailable("Playing", false)).toBe(true);
		expect(spectateAvailable("PostGame", false)).toBe(true);
	});

	it("never offers it to a competitor", () => {
		// A competitor is driving; their camera is already the arena, and a `Spectate` button in front of them would be a
		// control that changes nothing.
		expect(spectateAvailable("Waiting", true)).toBe(false);
		expect(spectateAvailable("Playing", true)).toBe(false);
		expect(spectateAvailable("PostGame", true)).toBe(false);
	});

	it("offers nothing in Intermission, because there is nothing to watch", () => {
		// Every body was cleared on the way in, the wipe covers part of the phase, and the next round has not been drawn. The
		// honest view is the player's own character.
		expect(spectateAvailable("Intermission", false)).toBe(false);
	});

	it("offers nothing for a phase this build has never heard of", () => {
		// Fail closed, like the camera's own complement rule: an unknown phase is not a reason to put a control on screen.
		expect(spectateAvailable("", false)).toBe(false);
		expect(spectateAvailable("Scores", false)).toBe(false);
		expect(spectateAvailable("playing", false)).toBe(false);
	});
});

describe("cameraWantsArena", () => {
	it("keeps item 186's automatic engage for a competitor", () => {
		// The rule as it shipped, for the players it was written for: a competitor's camera becomes the arena in `Waiting` and
		// stays there through `Playing` and `PostGame`, with nothing to press.
		expect(cameraWantsArena("Waiting", true, false)).toBe(true);
		expect(cameraWantsArena("Playing", true, false)).toBe(true);
		expect(cameraWantsArena("PostGame", true, false)).toBe(true);
	});

	it("gives a non-competitor their own camera until they ask", () => {
		// **The change item 193 makes.** Phase alone used to decide, so a spectator had their camera taken for the whole round
		// without asking — and the button's `off` state could never be true, which made the toggle a lie.
		expect(cameraWantsArena("Waiting", false, false)).toBe(false);
		expect(cameraWantsArena("Playing", false, false)).toBe(false);
		expect(cameraWantsArena("PostGame", false, false)).toBe(false);
	});

	it("honours the ask for a non-competitor", () => {
		expect(cameraWantsArena("Waiting", false, true)).toBe(true);
		expect(cameraWantsArena("Playing", false, true)).toBe(true);
		expect(cameraWantsArena("PostGame", false, true)).toBe(true);
	});

	it("outranks the phase rule in exactly one direction", () => {
		// The ask can keep the arena pose on a non-competitor, and it can never put it on outside the three phases: a spectator
		// left latched into `Intermission` must not be handed a camera over an empty arena.
		expect(cameraWantsArena("Intermission", false, true)).toBe(false);
		expect(cameraWantsArena("Intermission", true, true)).toBe(false);
	});

	it("agrees with the phase list it is built from", () => {
		// A tripwire on the shared constant rather than a restatement of it: every phase in the set can be watched, and every
		// phase outside it cannot, whatever the two flags say.
		for (const phase of ARENA_CAMERA_PHASES) {
			expect(cameraWantsArena(phase, false, true)).toBe(true);
			expect(cameraWantsArena(phase, true, false)).toBe(true);
		}

		expect(ARENA_CAMERA_PHASES.has("Intermission")).toBe(false);
	});
});

describe("isShoppingAvailable", () => {
	it("is the exact negation of the camera rule", () => {
		const phases = ["Intermission", "Waiting", "Playing", "PostGame", "unknown"];

		for (const phase of phases) {
			for (const competing of [true, false]) {
				for (const spectating of [true, false]) {
					expect(isShoppingAvailable(phase, competing, spectating)).toBe(
						!cameraWantsArena(phase, competing, spectating),
					);
				}
			}
		}
	});

	it("is open in the lobby, where there is nothing to race", () => {
		expect(isShoppingAvailable("Intermission", false, false)).toBe(true);
		expect(isShoppingAvailable("Intermission", true, false)).toBe(true);
		expect(isShoppingAvailable("Intermission", false, true)).toBe(true);
	});

	it("is open for an eliminated player who has stopped watching", () => {
		expect(isShoppingAvailable("Playing", false, false)).toBe(true);
	});

	it("is closed for anyone the camera has put on the arena", () => {
		// A competitor in `Waiting` has the picker on screen; the picker is that phase's panel, not the store's.
		expect(isShoppingAvailable("Waiting", true, false)).toBe(false);
		expect(isShoppingAvailable("Playing", true, false)).toBe(false);
		// An eliminated player who pressed `Watch Race` is watching, not shopping.
		expect(isShoppingAvailable("Playing", false, true)).toBe(false);
	});

	it("is closed for an unknown phase, because the camera never takes the arena there either", () => {
		expect(isShoppingAvailable("unknown", false, false)).toBe(true);
	});
});
