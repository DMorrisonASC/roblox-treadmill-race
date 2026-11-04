/**
 * The economy's numbers, and the only place they are written down.
 *
 * ## Why this is shared rather than server-only
 *
 * Every value here is needed on **both** sides and for different reasons. The server rolls against
 * `RARITY_WEIGHTS` and `FUSION_TABLE`; the client displays the same tables as odds. Two copies would let the
 * displayed probability drift from the rolled one, which is the one bug in this file that a player would
 * experience as a lie rather than as a defect. One source, imported by both, makes the display a *derivation*
 * of the roll instead of a description of it.
 *
 * ## What is deliberately not here
 *
 * No coin-earn rate, no purchase catalogue, no product ids. Coins are earned-only in this round (there is no
 * `MarketplaceService` anywhere in the tree), so the only economy numbers that exist are: what a chest costs,
 * what a chest can give, and what fusion can turn into.
 *
 * Every value below is **Placeholder.** — the shape is the point, the numbers are not.
 */

/** **Placeholder.** Rate limit for both economy remotes, in milliseconds, enforced per player per remote. */
export const ECONOMY_ACTION_COOLDOWN_MS = 500;

/** The four tiers, low to high. The order is load-bearing: it is the order the odds are displayed in. */
export const RARITIES = ["common", "rare", "epic", "legendary"] as const;

export type Rarity = (typeof RARITIES)[number];

/**
 * **Placeholder.** Weights out of 1000, not percentages.
 *
 * Weights rather than percentages because a weight can be added to the table without re-dividing every other
 * row: the sum is computed at read time, so "make legendaries rarer" is one number, not four.
 */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
	common: 600,
	rare: 300,
	epic: 90,
	legendary: 10,
};

/**
 * **Placeholder.** The ball ids each tier can grant.
 *
 * These are ids, not display names: nothing in this tree renders a ball yet, so an id is the honest unit — it
 * is exactly what gets stored in `ownedBalls` and exactly what a later round will look up. The names are
 * placeholders chosen to be distinguishable in a log line; the tree has no real ball catalogue to draw from.
 *
 * **At least one entry per tier is required**, because a tier with an empty pool would make a successful roll
 * grant nothing. The service refuses to roll a tier with no entries rather than granting a nameless ball.
 */
export const BALL_POOL: Record<Rarity, Array<string>> = {
	common: ["bully_ball", "bouncy_ball", "ghost_ball"],
	rare: ["heavy_ball", "split_ball"],
	epic: ["magnet_ball", "rocket_ball"],
	legendary: ["prism_ball", "eclipse_ball"],
};

/** **Placeholder.** Coins one chest costs. Earned coins only; there is no Robux path to this number. */
export const COIN_CHEST_COST = 100;

/**
 * **Placeholder.** Coins a brand-new profile starts with.
 *
 * Non-zero on purpose: the chest costs coins and there is no coin-earn path in this round, so a player who
 * started at zero could not exercise the feature the round exists to prove. This is a testing affordance, and
 * it is the number to set to `0` on the day the round starts granting coins.
 */
export const STARTING_COINS = 500;

/** **Placeholder.** Balls consumed per fusion attempt. The materials *are* the cost; no coins are charged. */
export const FUSION_INPUT_COUNT = 2;

/** What one input tier can become, and how often. */
export interface FusionRule {
	readonly nextRarity: Rarity;
	/**
	 * **Placeholder.** Integer percent, not a 0-1 chance.
	 *
	 * An integer percent so the number the service rolls against and the number the client prints are the
	 * *same* number rather than two conversions of one. `0.6` in floating point is not 60, and a displayed
	 * "60%" that is secretly rolled as 59.99999% is a discrepancy nobody can see and everybody can argue about.
	 */
	readonly successPercent: number;
}

/**
 * Same tier in, one tier up or nothing out.
 *
 * **`legendary` has no entry.** There is no tier above it, so the fusion is refused outright — the service
 * returns a refusal and the client explains — rather than inventing a fifth rarity or consuming two
 * legendaries for a legendary. Consuming the rarest thing in the game to receive the rarest thing in the game
 * is a loss dressed as a transaction, and a refusal that spends nothing is the only outcome that cannot cheat
 * the player.
 */
export const FUSION_TABLE: Partial<Record<Rarity, FusionRule>> = {
	common: { nextRarity: "rare", successPercent: 60 },
	rare: { nextRarity: "epic", successPercent: 40 },
	epic: { nextRarity: "legendary", successPercent: 20 },
};

/**
 * The tier a ball id belongs to, or `undefined` if it is in no pool.
 *
 * Linear over a table of nine entries. A reverse index would be faster and would be a second table to keep in
 * sync with `BALL_POOL` — the walk is O(9) at the frequency of a button press.
 *
 * `undefined` is a real answer: a profile saved by an older build can name a ball this build does not know,
 * and the fusion path has to refuse such a ball rather than guess a tier for it.
 */
export function rarityOfBall(ballId: string): Rarity | undefined {
	for (const rarity of RARITIES) {
		for (const candidate of BALL_POOL[rarity]) {
			if (candidate === ballId) {
				return rarity;
			}
		}
	}

	return undefined;
}

/** Whether a string is one of `RARITIES`. Used to validate data that came off the wire or out of a store. */
export function isRarity(value: string): boolean {
	for (const rarity of RARITIES) {
		if (rarity === value) {
			return true;
		}
	}

	return false;
}

/**
 * The `OwnedBalls` attribute's format: `ballId=count` pairs joined by `;`, sorted by id.
 *
 * ## Why a string attribute and not one attribute per ball
 *
 * Attributes are replicated with the instance and are cheap to read, but there is no "attribute added" signal a
 * client can subscribe to without polling the whole attribute set — so a client wanting "what do I own" would
 * have to poll. One string is a single value with a single `GetAttributeChangedSignal`, which is the same
 * mechanism `RoundState` and `RoundTransitionCount` already use.
 *
 * ## Why this format and not JSON
 *
 * `HttpService:JSONEncode` would work and would be the right call for a nested structure. This is a flat map of
 * id to count, and the honest requirement is that a human can read it in Studio's attribute pane while verifying
 * that a chest granted what it said it did. `bully_ball=2;ghost_ball=1` is legible; `{"bully_ball":2}` is
 * legible too but arrives with a library dependency and a decode that can fail. **Sorted**, so the same profile
 * always produces the same string and an attribute change means a change rather than a reorder.
 *
 * The pair is ordered `id=count` so a ball id may contain anything except `=` and `;` — true of the ids in
 * `BALL_POOL`, and the encoder is the only writer.
 */
export function encodeOwnedBalls(ownedBalls: Map<string, number>): string {
	const ids = new Array<string>();
	for (const [ballId] of ownedBalls) {
		ids.push(ballId);
	}

	// roblox-ts's comparator is a "less than" predicate returning `boolean`, not the JS three-way number.
	ids.sort((left, right) => left < right);

	const parts = new Array<string>();
	for (const ballId of ids) {
		parts.push(`${ballId}=${ownedBalls.get(ballId) ?? 0}`);
	}

	return parts.join(";");
}

/**
 * Reads back what `encodeOwnedBalls` wrote.
 *
 * **Never throws on malformed input**, because the input comes from an attribute a server wrote and a future
 * build may write differently. A malformed pair is skipped rather than failing the whole attribute: a client
 * showing eight of nine owned balls is more useful than a client showing none, and the count it displays is never
 * used to decide anything — the server decides.
 */
export function decodeOwnedBalls(encoded: string): Map<string, number> {
	const ownedBalls = new Map<string, number>();

	if (encoded === "") {
		return ownedBalls;
	}

	for (const part of encoded.split(";")) {
		const fields = part.split("=");
		if (fields.size() !== 2) {
			continue;
		}

		const ballId = fields[0];
		const count = tonumber(fields[1]);
		if (ballId === "" || count === undefined) {
			continue;
		}

		ownedBalls.set(ballId, count);
	}

	return ownedBalls;
}
