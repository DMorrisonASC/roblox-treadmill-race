/**
 * The ball picker's numbers, its wire types, and one label formatter — the half of the feature the client is allowed
 * to know.
 *
 * ## Why the generator is not here
 *
 * The offer is rolled on the server and stored there, and the client is told the result. A generator in this file would
 * be a function a modified client could call to produce a *different* three from the same collection — and the timeout
 * auto-pick ("a random one of those three") would then refer to options the server never recorded. The types and the
 * numbers are here because the panel must render a price and a count; the choice is not.
 */

/**
 * **Placeholder.** How many balls a normal offer contains.
 *
 * Three is the smallest number that makes a choice feel like one: two is a coin flip, and four cards at the sizes this
 * panel uses stop fitting on a phone. The value is read by both sides — the server fills an offer to it, the client lays
 * out its row from it — so a mismatch cannot happen by construction.
 */
export const PICKER_OPTION_COUNT = 3;

/**
 * **Placeholder.** Chance that a player's offer is upgraded to everything they own, rolled once per `Waiting` entry.
 *
 * Rolled **once per player per phase**, never per frame and never per offer: a per-frame roll would mean every player
 * gets a premium offer within a couple of seconds, which is a different (and worse) feature than a 10% one.
 */
export const PREMIUM_ROLL_CHANCE = 0.1;

/**
 * **Placeholder.** Coins one re-roll costs.
 *
 * Paid in coins, not Robux, and that is a decision rather than an oversight: a Developer Product cannot be exercised
 * without a published place and a real product id, so a Robux price would ship a button nobody could test. The Robux
 * re-roll is the named follow-up — the same `ProcessReceipt` machinery item 61 built for the premium chest, plus a
 * profile field for an unspent re-roll.
 */
export const REROLL_COST_COINS = 3;

/**
 * What the server sends a client when its offer is created, replaced or re-rolled.
 *
 * `deadline` is an **absolute server-clock time**, not a duration: the client subtracts `Workspace.GetServerTimeNow()`
 * from it, so latency shifts the start of the countdown rather than making it drift a round-trip longer than the phase.
 * A duration would be wrong by exactly the time it spent in flight, once, which nobody would notice until the timer and
 * the phase disagreed.
 *
 * `premium` and `fallback` are sent so the panel can say what kind of offer it is showing. Neither changes the layout:
 * a fallback is three cards of a real ball, not an empty state.
 */
export interface PickerOfferMessage {
	readonly options: Array<string>;
	readonly premium: boolean;
	readonly fallback: boolean;
	readonly deadline: number;
}

/** What the server answers a pick or a re-roll with. One shape for both, so the client has one handler. */
export type PickerResult =
	| { ok: true }
	| { ok: false; reason: string }
	/** A re-roll succeeded: the caller gets the replacement offer in the same message rather than waiting for a second. */
	| { ok: true; offer: PickerOfferMessage };
