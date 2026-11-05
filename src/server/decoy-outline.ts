/**
 * Whether a caller is allowed to see the outline on their own decoy's twin — and if not, why not.
 *
 * ## Why this is a module rather than four `if`s in the handler
 *
 * Because "I asked and got `nil`" is the same symptom for four different causes, and a client cannot tell them apart. The
 * only place that distinction can live is the server's log, so the decision has to produce a *reason* rather than a
 * boolean — and a reason is worth naming in a file a spec can call. `RoundService` cannot be constructed in the Jest
 * runtime (its dependencies reach `DataStoreService`), so a decision written inside it could only ever be a source read.
 * `round-outcome.ts` is the precedent.
 *
 * ## The rule, in one sentence
 *
 * A player may be told the identity of the twin that their own body spawned, while the round is running, and nothing else.
 *
 * The twin is deliberately indistinguishable from a real body (item 77) — same badge, same textures, same markers — so a
 * spectator who could see the outline would have the whole power given away. Per-viewer information is the only shape that
 * keeps the deception intact, which is why the client asks and the server answers instead of the answer being an attribute
 * on the body.
 *
 * ## The four refusals, and why each is separate
 *
 * | reason        | what it means                                                        |
 * | ------------- | -------------------------------------------------------------------- |
 * | `wrong-phase` | asked outside `Playing`; there is no round for a decoy to belong to   |
 * | `no-body`     | the caller has no live body, so there is nothing they could have spawned |
 * | `no-decoy`    | the caller's body exists but it is not a `decoy` ball                 |
 * | `not-owner`   | the decoy carries somebody else's `OwnerUserId` — a server-side bug   |
 *
 * `not-owner` is a guard rather than a client condition: **a decoy must never carry an `OwnerUserId`**, because that is
 * the field `getCompetitors()` filters on and setting it would make the twin a competitor and change the winner rule. If
 * one ever does, and it is not the caller's, this refuses — outlining another player's body would hand one player
 * information about another's ball.
 */

/** Why a request was refused. Every value is logged, so a client's `nil` is never ambiguous on the server side. */
export type DecoyOutlineRefusal = "wrong-phase" | "no-body" | "no-decoy" | "not-owner";

/** What the server knows at the moment of the request. Plain values only, so the rule is testable without an instance. */
export interface DecoyOutlineFacts {
	/** The round's current phase. */
	readonly phase: string;
	readonly callerUserId: number;
	/**
	 * The `OwnerUserId` of the live body found for the caller, or `undefined` when they have none.
	 *
	 * Read back off the body rather than assumed from the search that found it: the search is by user id, so a mismatch
	 * here would mean the body is not theirs, and the honest answer to "where is my body" is then "you have none".
	 */
	readonly bodyOwnerUserId: number | undefined;
	/** Whether a decoy is registered against that body. */
	readonly hasDecoy: boolean;
	/** The decoy's own `OwnerUserId`, which should always be `undefined`. See `not-owner`. */
	readonly decoyOwnerUserId: number | undefined;
}

/** Either permission, or a reason. */
export type DecoyOutlineDecision =
	{ readonly kind: "granted" } | { readonly kind: "refused"; readonly reason: DecoyOutlineRefusal };

/**
 * Decides one request.
 *
 * The order is deliberate and is the order the reasons are logged in: phase first because a request outside `Playing` is a
 * client that has not understood the round, body second because a player without a body cannot have spawned anything,
 * decoy third because that is the ordinary "your ball has no twin" case, and ownership last because it should be
 * unreachable.
 */
export function decideDecoyOutline(facts: DecoyOutlineFacts): DecoyOutlineDecision {
	if (facts.phase !== "Playing") {
		return { kind: "refused", reason: "wrong-phase" };
	}

	if (facts.bodyOwnerUserId !== facts.callerUserId) {
		return { kind: "refused", reason: "no-body" };
	}

	if (!facts.hasDecoy) {
		return { kind: "refused", reason: "no-decoy" };
	}

	if (facts.decoyOwnerUserId !== undefined && facts.decoyOwnerUserId !== facts.callerUserId) {
		return { kind: "refused", reason: "not-owner" };
	}

	return { kind: "granted" };
}
