import { describe, expect, it } from "@rbxts/jest-globals";
import { decideRoundOutcome, RoundResultOwner } from "../round-outcome";

/**
 * The round's result rule: **one competitor left wins; none left is `no survivors`; two or more continue.**
 *
 * ## Why this file exists at all
 *
 * The rule has already been wrong once. Item 37 refused to name a winner for a round that began with one competitor, and
 * that refusal is now the defect: a solo session finished with `PostGame — no winner`, which a player cannot tell apart
 * from a broken round. A rule that reversed deserves assertions rather than a source read, and `RoundService` cannot be
 * constructed in this runtime — its dependencies reach `DataStoreService`, which throws in an unpublished place. So the
 * decision lives in `src/server/round-outcome.ts` over plain tables, and every branch is provable here.
 *
 * ## What this cannot prove
 *
 * The decision function does not know *when* it is called. Criteria about the count being current at the moment of the
 * call — a `1` or `3` spawn landing in the same frame as a loss, the tick's one-second cadence, the deferral that lets a
 * batch of destructions land before the check runs — are properties of `RoundService` and are listed as Studio
 * observations in the round report.
 */

/** **Placeholder.** An owner pair, built literally: a spec cannot construct a `Player`, and should not need to. */
function owner(userId: number, displayName: string): RoundResultOwner {
	return { userId, displayName };
}

describe("decideRoundOutcome", () => {
	it("continues a round with two competitors", () => {
		const outcome = decideRoundOutcome([owner(1, "One"), owner(2, "Two")]);
		expect(outcome.kind).toBe("continue");
	});

	it("continues a round with five competitors", () => {
		const outcome = decideRoundOutcome([
			owner(1, "One"),
			owner(2, "Two"),
			owner(3, "Three"),
			owner(4, "Four"),
			owner(5, "Five"),
		]);

		expect(outcome.kind).toBe("continue");
	});

	it("names the survivor of a two-competitor round", () => {
		// Criterion 1: a round that starts with two and loses one ends at that exit, with the other named.
		const outcome = decideRoundOutcome([owner(2, "Two")]);

		expect(outcome.kind).toBe("winner");
		expect(outcome.kind === "winner" ? outcome.winner.displayName : "wrong").toBe("Two");
		expect(outcome.kind === "winner" ? outcome.winner.userId : -1).toBe(2);
	});

	it("names a solo competitor as the winner, with no memory of how many started", () => {
		// **Criterion 3, and the whole point of the reversal.** The function cannot tell a round that began with one from a
		// round of five that lost four, because that distinction is exactly what item 37 used to refuse the win.
		const solo = decideRoundOutcome([owner(7, "Solo")]);

		expect(solo.kind).toBe("winner");
		expect(solo.kind === "winner" ? solo.winner.displayName : "wrong").toBe("Solo");
	});

	it("names a synthetic debug competitor like any other", () => {
		// Criterion 5: `Debug#N` owners carry a negative id and are competitors in every sense the rule cares about.
		const outcome = decideRoundOutcome([owner(-3, "Debug#3")]);

		expect(outcome.kind).toBe("winner");
		expect(outcome.kind === "winner" ? outcome.winner.userId : 0).toBe(-3);
		expect(outcome.kind === "winner" ? outcome.winner.displayName : "wrong").toBe("Debug#3");
	});

	it("reports no-survivors for an empty round, naming nobody", () => {
		// Criterion 7: `no survivors` is the zero-competitor outcome and only that. It is no longer how a solo round ends.
		const outcome = decideRoundOutcome(new Array<RoundResultOwner>());
		expect(outcome.kind).toBe("no-survivors");
	});

	it("does not name a winner in the no-survivors case", () => {
		// The type has no field for it, which is the strongest form of this assertion — a caller cannot invent one.
		const outcome = decideRoundOutcome(new Array<RoundResultOwner>());
		expect(outcome.kind === "winner").toBe(false);
	});

	it("does not mutate the list it is given", () => {
		const competitors = [owner(1, "One"), owner(2, "Two")];
		decideRoundOutcome(competitors);

		expect(competitors.size()).toBe(2);
		expect(competitors[0].displayName).toBe("One");
	});

	it("decides only from the count, so a repeated call is stable", () => {
		// Idempotence matters because the check runs on a tick *and* after every loss: the same list must produce the same
		// answer, or an extra loss would change a result that was already decided.
		const competitors = [owner(1, "One")];

		const first = decideRoundOutcome(competitors);
		const second = decideRoundOutcome(competitors);

		expect(first.kind).toBe(second.kind);
		expect(first.kind === "winner" ? first.winner.userId : -1).toBe(
			second.kind === "winner" ? second.winner.userId : -2,
		);
	});
});
