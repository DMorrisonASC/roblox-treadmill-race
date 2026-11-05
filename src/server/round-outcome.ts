/**
 * Who wins a round, given who is still in it.
 *
 * ## Why this is a module and not four lines inside `RoundService`
 *
 * The rule is the whole of the round's result, and it just reversed: item 37 refused to name a winner for a round that
 * began with a single competitor, and that refusal is now the defect instead of the fix. A rule that has already been
 * wrong once deserves an assertion rather than a source read — and `RoundService` cannot be constructed in this runtime,
 * because its dependencies reach `DataStoreService`, which throws in an unpublished place. Taking owners as an array means
 * every branch is a table comparison.
 *
 * ## The rule
 *
 * - **Zero competitors** → `no-survivors`. Reachable only when more than one competitor left in the same instant, or a
 *   body was destroyed without going through elimination. It is no longer the solo-round outcome.
 * - **Exactly one competitor** → that competitor wins. No guard on how many the round started with: a round with one
 *   entrant is a round that entrant wins, and pretending otherwise meant a solo player finished a race with no result.
 * - **Two or more** → the round continues.
 *
 * ## What is deliberately absent
 *
 * No elapsed time, no `initialLiveCount`, no furthest-along tie-break. A round ends because of the count and nothing else,
 * so there is exactly one thing to reason about when a result looks wrong.
 */

/** The only fields a result needs. `BallOwner` satisfies this structurally, so callers pass their own values. */
export interface RoundResultOwner {
	readonly userId: number;
	readonly displayName: string;
}

/** What the count says should happen next. */
export type RoundOutcome =
	| { readonly kind: "continue" }
	| { readonly kind: "winner"; readonly winner: RoundResultOwner }
	| { readonly kind: "no-survivors" };

/**
 * Decides the round from the current competitor list.
 *
 * ## Why the caller passes the list rather than a count
 *
 * A count is a snapshot of an answer; the list is the answer. The winner has to be read out of it anyway, and a caller that
 * counted first and looked up second would be holding two facts that can disagree — which is how a round names a winner
 * that had already been destroyed.
 */
export function decideRoundOutcome(competitors: ReadonlyArray<RoundResultOwner>): RoundOutcome {
	if (competitors.size() === 0) {
		return { kind: "no-survivors" };
	}

	if (competitors.size() === 1) {
		const winner = competitors[0];
		if (winner === undefined) {
			// Unreachable: a one-element list has an element. The guard exists so the function is total rather than trusting
			// an index, and it reports the same outcome the empty case does — nobody left is nobody left.
			return { kind: "no-survivors" };
		}

		return { kind: "winner", winner };
	}

	return { kind: "continue" };
}
