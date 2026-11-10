import { BALL_POOL, decodeOwnedBalls } from "shared/economy.config";
import { PICKER_OPTION_COUNT, PREMIUM_ROLL_CHANCE } from "shared/picker";

/**
 * The picker's decisions, as pure functions.
 *
 * ## Why this file is under `src/server`
 *
 * `default.project.json` mounts `out/server` at `ServerScriptService`, so nothing here is reachable from a client script.
 * The offer must be rolled where a modified client cannot reach it: a client that generated its own three would be
 * offered a set the server never stored, and the timeout auto-pick — "a random one of those three" — would refer to
 * options that never existed. The client is told the result and renders it.
 *
 * ## Why `random` is a parameter everywhere
 *
 * Every function here takes a `() => number` in `[0, 1)` instead of calling `math.random` directly, so the four
 * properties that actually matter — uniform over distinct ids, repetition only when the collection is smaller than the
 * offer, one premium roll per phase, and a timeout pick drawn from the offer rather than from the collection — are
 * assertions in a spec rather than things somebody has to observe in a playtest. The service passes `math.random`.
 */

/** One player's stored offer. `pick` is always present after `openOffers`, because the default is decided there. */
export interface StoredOffer {
	readonly options: Array<string>;
	/** True when this offer is every distinct owned ball rather than `PICKER_OPTION_COUNT` draws. */
	readonly premium: boolean;
	/** True when the player owned nothing and the offer is a repeated fallback id. */
	readonly fallback: boolean;
	/** The id the body will race as. Set to a random option at creation, replaced by a valid client pick. */
	pick: string;
	/** Whether a client actually chose `pick`, as opposed to the creation-time default. Drives the `source=` log. */
	pickedByClient: boolean;
}

/** An index in `[0, size)`. `math.floor` rather than a rounded product so the distribution stays uniform at the ends. */
function randomIndex(size: number, random: () => number): number {
	return math.floor(random() * size);
}

/**
 * Whether this phase's offer should be premium — rolled **once**, by the caller, at `Waiting` entry.
 *
 * A separate function rather than an inline comparison so the "once per phase" property is visible at the call site: the
 * thing that must not be per-frame is the *call*, and naming it makes a loop over it obvious in review.
 */
export function rollPremium(random: () => number): boolean {
	return random() < PREMIUM_ROLL_CHANCE;
}

/**
 * `count` options drawn from `ownedIds`.
 *
 * ## One of each distinct id first, then repetition to fill
 *
 * The brief's rule is "repeating when they own fewer than three", which is a statement about *when* repetition is
 * allowed, not merely about what is legal. Drawing each slot independently from the distinct list would give a player
 * who owns five balls three identical cards often enough to look broken, and it would make the two-versus-three
 * difference invisible. So the first pass takes distinct ids without replacement, and only the shortfall is filled by
 * independent draws.
 *
 * **Uniform over distinct ids, not over the multiset.** A player owning `ghost_ball` five times and `heavy_ball` once
 * must not see `ghost_ball` five times as often — the picker is choosing *which ball to race*, and owning duplicates is
 * a fusion stock, not a preference. Weighting by count would make the picker a second, hidden fusion display.
 *
 * The caller is responsible for a non-empty `ownedIds`; an empty list returns an empty array so a caller that forgot
 * cannot get a surprise fallback id out of this function.
 */
export function drawOptions(ownedIds: ReadonlyArray<string>, count: number, random: () => number): Array<string> {
	const options = new Array<string>();
	if (ownedIds.size() === 0 || count <= 0) {
		return options;
	}

	// Distinct ids only, in a copy that can be drawn from without replacement.
	const pool = new Array<string>();
	for (const ballId of ownedIds) {
		if (!pool.includes(ballId)) {
			pool.push(ballId);
		}
	}

	while (options.size() < count && pool.size() > 0) {
		const index = randomIndex(pool.size(), random);
		options.push(pool[index]);
		pool.remove(index);
	}

	// Only reachable when the collection is smaller than the offer: fill with independent draws from the same distinct
	// set, so "owning two receives one of them twice" is what the code does rather than what it approximates.
	while (options.size() < count) {
		options.push(pool.size() > 0 ? ownedIds[randomIndex(ownedIds.size(), random)] : ownedIds[0]);
	}

	return options;
}

/**
 * The fallback id for a player who owns nothing.
 *
 * A **single** id drawn uniformly from `BALL_POOL["common"]` and repeated, not `count` independent draws: the brief says
 * "a random, common ball", singular, and three *different* balls would imply a collection the player does not have. The
 * alternative — one draw per card — would also make the offer's three cards disagree about what the body is racing as,
 * which is the one thing the offer exists to decide.
 *
 * Returns `undefined` when the common pool is empty, which is a build bug rather than a player state: the caller refuses
 * to spawn that player instead of inventing an id, because an invented id is a body nothing can name.
 */
export function fallbackBallId(random: () => number): string | undefined {
	const pool = BALL_POOL["common"];
	if (pool.size() === 0) {
		return undefined;
	}

	return pool[randomIndex(pool.size(), random)];
}

/**
 * Charges for a re-roll and only then produces the replacement.
 *
 * ## Why this is a function at all
 *
 * It is two statements in the service, and the order of those two statements is the whole safety property: a replacement
 * generated before the charge leaves a player holding new cards and an unchanged balance when the save fails, which is
 * free value created by a failure. Making the order explicit ? and giving it a name ? lets a test assert that a refused
 * payment **never calls the rebuild**, which is the assertion that would otherwise have to be read out of a service that
 * cannot be constructed here.
 *
 * `pending` is the "still paying" outcome: nothing was rebuilt, and the caller's old offer is untouched by construction,
 * because the only thing that replaces it is `rebuild`.
 */
export function applyReroll(
	pay: () => boolean,
	rebuild: () => StoredOffer | undefined,
): { outcome: "ok"; offer: StoredOffer } | { outcome: "payment-failed" | "no-offer" } {
	if (!pay()) {
		return { outcome: "payment-failed" };
	}

	const offer = rebuild();
	if (offer === undefined) {
		return { outcome: "no-offer" };
	}

	return { outcome: "ok", offer };
}

/** The distinct ids a player owns, from the replicated `OwnedBalls` attribute. */
function compareStringsAscending(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

export function ownedIdsFrom(encoded: string): Array<string> {
	const owned = decodeOwnedBalls(encoded);
	const ids = new Array<string>();

	for (const [ballId, count] of owned) {
		// A zero or negative count is not ownership. `decodeOwnedBalls` never writes one, but the attribute is client
		// visible and this list decides what a player can race as, so the filter is on the read side too.
		if (count > 0) {
			ids.push(ballId);
		}
	}

	// Sorted so the *draw* order is the only randomness: two offers built from the same profile and the same roll must be
	// identical, which is what lets a test assert a draw rather than a set.
	for (let index = 1; index < ids.size(); index++) {
		const value = ids[index];
		let insertIndex = index;
		while (insertIndex > 0 && compareStringsAscending(ids[insertIndex - 1], value) > 0) {
			ids[insertIndex] = ids[insertIndex - 1];
			insertIndex--;
		}
		ids[insertIndex] = value;
	}

	return ids;
}

/**
 * Builds one player's offer.
 *
 * The order of the branches is the rule:
 *
 * 1. **Nothing owned** — the fallback. It takes precedence over premium, because a premium roll on an empty collection
 *    has nothing to expand to; the caller logs `premium=false` for that case rather than claiming the roll fired.
 * 2. **Premium** — every distinct owned id, in the sorted order above. Note this can be *fewer* than
 *    `PICKER_OPTION_COUNT` for a player with one or two balls; that is the definition the brief gives ("every ball they
 *    own"), and padding it with duplicates would be a different offer wearing the premium label.
 * 3. **Normal** — `PICKER_OPTION_COUNT` draws.
 *
 * `pick` starts as a uniformly random option, which is the timeout answer computed early: the body is spawned at
 * `Waiting` entry, before any player can press anything, and it must carry a chosen id from birth. A client pick
 * replaces it; if none arrives, the value that was already there stands.
 */
export function buildOffer(
	ownedIds: ReadonlyArray<string>,
	premium: boolean,
	random: () => number,
): StoredOffer | undefined {
	if (ownedIds.size() === 0) {
		const ballId = fallbackBallId(random);
		if (ballId === undefined) {
			return undefined;
		}

		const options = new Array<string>();
		for (let index = 0; index < PICKER_OPTION_COUNT; index++) {
			options.push(ballId);
		}

		return { options, premium: false, fallback: true, pick: ballId, pickedByClient: false };
	}

	const options = premium ? copyOf(ownedIds) : drawOptions(ownedIds, PICKER_OPTION_COUNT, random);

	return {
		options,
		premium,
		fallback: false,
		pick: options[randomIndex(options.size(), random)],
		pickedByClient: false,
	};
}

function copyOf(source: ReadonlyArray<string>): Array<string> {
	const copy = new Array<string>();
	for (const value of source) {
		copy.push(value);
	}

	return copy;
}

/**
 * Whether `ballId` may be picked from this offer.
 *
 * **Checked against the offer, not against `OwnedBalls`.** The two differ in exactly the cases that matter: a premium
 * offer is a subset of the collection, and an offer can be older than the profile (a chest opened during `Waiting`
 * cannot be picked, because no card for it was ever shown). Validating against ownership would accept a pick the player
 * was never offered, and the body would race as a ball whose card was never on screen.
 */
export function isPickAllowed(offer: StoredOffer, ballId: string): boolean {
	return offer.options.includes(ballId);
}

/** The id a body races as when no client pick arrives: uniform over the player's **own offer**. */
export function timeoutPick(offer: StoredOffer, random: () => number): string {
	return offer.options[randomIndex(offer.options.size(), random)];
}
