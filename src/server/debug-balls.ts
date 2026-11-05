/**
 * The debug spawn's ball picks: `count` ids drawn from `BALL_POOL`, distinct within one press.
 *
 * ## Why this is a module in `src/server/` and not a method on `RoundService`
 *
 * `RoundService` cannot be constructed in the Jest runtime — its dependencies reach `DataStoreService`, which throws in an
 * unpublished place — so a draw written inside it could only ever be a source read. `round-outcome.ts` is the precedent:
 * the decision lives in a pure module over plain values, the service calls it, and the branch is provable.
 *
 * ## Why the random source is a parameter
 *
 * `math.random` is not seedable, so a function that called it directly could only be tested for "returned something". With
 * the source injected, a spec can drive exact draws — including the worst case, a source that always returns `0` — and pin
 * the two properties that matter: distinct ids within one press, and termination for any count.
 *
 * ## Why the pick is not in `spawnBall`
 *
 * `BallSpawnerService.spawnBall` treats a missing `ChosenBallId` as "no ball id, no power", and two things depend on that:
 * a player who never picked gets a plain body rather than a random power, and the `decoy` twin — which carries no owner
 * attributes at all — stays power*less*. Moving the draw into that fallback would give the decoy whatever it drew, and a
 * decoy with `eclipse` would freeze the field from a body the winner rule cannot see. The random pick belongs to the debug
 * owner, which is the only caller that has no player to ask.
 */
import { BALL_POOL, RARITIES } from "shared/economy.config";

/** A source of numbers in `[0, 1)`, the contract `math.random` satisfies with no arguments. */
export type RandomSource = () => number;

/** Every ball id in `BALL_POOL`, in rarity order and then pool order — the deck every draw is made from. */
export function allBallIds(): Array<string> {
	const ids = new Array<string>();
	for (const rarity of RARITIES) {
		for (const ballId of BALL_POOL[rarity]) {
			ids.push(ballId);
		}
	}

	return ids;
}

/**
 * `count` ball ids, uniformly drawn, **distinct within one press**, and total for any input.
 *
 * ## Distinct within a press, not against the live field
 *
 * The rule is "four bodies from four different balls", not "four balls that are not already on the belt". A live-field
 * check would make the button refuse because somebody else's ball was on the belt, which is a rule about the scene rather
 * than about the pool, and with ten ids and four per press it would refuse for no reason most of the time. The pool is the
 * only thing that can be too short.
 *
 * ## Why a partial Fisher-Yates and not "draw and retry"
 *
 * Drawing from the whole pool and rejecting duplicates is unbounded in the worst case: a source that keeps returning `0`
 * would retry forever. Taking the pick *out* of a working copy makes each distinct draw cost exactly one removal, so the
 * first `poolSize` picks are distinct by construction and no retry loop exists to be stuck in.
 *
 * ## What happens when `count` exceeds the pool
 *
 * The deck is refilled once it empties, so `count = 14` over a pool of ten returns ten distinct ids followed by four that
 * repeat. **This cannot fire today** — a press spawns one body per bound spawner and there are five lanes against ten ids —
 * and it is written anyway so the function is total: a caller asking for more ids than exist gets the repeats it asked for
 * rather than an infinite loop or a silently short array. It is a fallback, not dead code.
 */
export function pickDistinctBallIds(count: number, random: RandomSource = math.random): Array<string> {
	const picked = new Array<string>();
	const wanted = math.max(math.floor(count), 0);
	if (wanted === 0) {
		return picked;
	}

	let deck = allBallIds();

	for (let index = 0; index < wanted; index++) {
		if (deck.size() === 0) {
			deck = allBallIds();
			if (deck.size() === 0) {
				// An empty pool cannot produce an id at all. Returning what was picked beats returning a made-up string.
				return picked;
			}
		}

		// Clamped rather than trusted: `math.random` is `[0, 1)`, but the source is a parameter and a caller-supplied one
		// that returns exactly `1` would index past the end and yield `undefined` in the array.
		const slot = math.clamp(math.floor(random() * deck.size()), 0, deck.size() - 1);
		picked.push(deck[slot]);
		deck.remove(slot);
	}

	return picked;
}
