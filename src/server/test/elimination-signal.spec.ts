import { describe, expect, it } from "@rbxts/jest-globals";
import { EliminationCause, splashTargetUserId } from "../elimination-signal";

/**
 * Who is told they were eliminated.
 *
 * ## Why this is worth a spec
 *
 * There are four ways a body leaves the round and only two of them mean "you lost". The rules are one line each, which is
 * exactly why they get dropped: a future removal path copies the two-line call site, forgets the cause, and either splashes
 * every player when the phase ends or tells nobody when the spawner culls a ball. Written once behind a function, the rules
 * are assertable; written as `if`s at each site, they are a review habit.
 *
 * ## What this cannot prove
 *
 * That the call sites read the owner *before* destroying the body. A destroyed instance returns its defaults, so a late read
 * would look like a synthetic owner and this function would correctly — and wrongly — return `undefined`. That ordering is a
 * source read of `settleEliminations` and `handleExternalDestruction`.
 */

/** **Placeholder.** A plain owner, because a spec cannot construct a `Player` and should not need to. */
function owner(userId: number): { userId: number } {
	return { userId };
}

describe("splashTargetUserId", () => {
	it("notifies the player who left the belt", () => {
		// Criterion 4: one signal, to the owner of the body that left.
		expect(splashTargetUserId(owner(41354175), "left-belt")).toBe(41354175);
	});

	it("notifies the player whose ball was culled", () => {
		// `KillY` and the live-ball cap remove a competitor the same way the zone does: the ball is out of the round.
		expect(splashTargetUserId(owner(41354175), "culled")).toBe(41354175);
	});

	it("notifies nobody on a teardown", () => {
		// A phase change removes every body at once. Splashing each owner would read as a mass elimination the player
		// did not cause — and at `PostGame` it would contradict the banner naming a winner.
		expect(splashTargetUserId(owner(41354175), "teardown")).toBeUndefined();
	});

	it("notifies nobody for a synthetic competitor", () => {
		// Criterion 5: `Debug#N` owners are negative ids. There is no player behind one, so there is nobody to tell.
		expect(splashTargetUserId(owner(-1), "left-belt")).toBeUndefined();
		expect(splashTargetUserId(owner(-4), "culled")).toBeUndefined();
	});

	it("notifies nobody for a body with no owner", () => {
		// An orphan is not a competitor at all; the round's own winner rule ignores it, and so does this.
		expect(splashTargetUserId(undefined, "left-belt")).toBeUndefined();
	});

	it("treats a zero id as synthetic", () => {
		// The boundary the rule turns on: `<= 0` is "no player", not "player zero". A late attribute read — after the body is
		// destroyed and every property reports its default — produces exactly this value, so it must fail closed.
		expect(splashTargetUserId(owner(0), "left-belt")).toBeUndefined();
	});

	it("is exhaustive over the causes", () => {
		// Every cause is decided: no branch falls through to "notify", which would be the silent wrong answer.
		const causes: Array<EliminationCause> = ["left-belt", "culled", "teardown"];
		let notified = 0;

		for (const cause of causes) {
			if (splashTargetUserId(owner(1), cause) !== undefined) {
				notified++;
			}
		}

		expect(notified).toBe(2);
	});

	it("never notifies for a cause the round did not produce", () => {
		// The surviving body is never removed, so it never reaches this function at all — but if a future path asked about
		// a teardown, the answer is still nobody.
		expect(splashTargetUserId(owner(1), "teardown")).toBeUndefined();
	});

	it("tells nobody when the owner has left the game (item 211)", () => {
		// A disconnect is an elimination for the round's accounting and **not** something to splash: the owner's client is gone, so
		// a remote fired at them is a `FireClient` into nothing. Same answer as a teardown, for a different reason - hence its own
		// cause rather than reusing `teardown`, which would also have claimed there was no elimination to report.
		expect(splashTargetUserId(owner(1), "left-game")).toBeUndefined();
	});

	it("still splashes a real owner for the two causes that are a player's doing", () => {
		// The boundary of the change above: `left-belt` and `culled` are unchanged, so this round did not turn the splash off.
		expect(splashTargetUserId(owner(1), "left-belt")).toBe(1);
		expect(splashTargetUserId(owner(1), "culled")).toBe(1);
	});
});
