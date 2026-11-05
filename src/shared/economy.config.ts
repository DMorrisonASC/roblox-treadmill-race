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
	common: ["bully_ball", "bouncy_ball", "ghost_ball", "sprinter_ball"],
	rare: ["heavy_ball", "decoy_ball"],
	epic: ["magnet_ball", "rocket_ball"],
	legendary: ["recycle_ball", "eclipse_ball"],
};

/** **Placeholder.** Coins one chest costs. Earned coins only; there is no Robux path to this number. */
export const COIN_CHEST_COST = 100;

/**
 * **Placeholder.** The most chests one bulk call may buy.
 *
 * ## Why this is shared and not a server constant
 *
 * The store's `Open 10` button is *built* from this number: its label, its price line and whether it is enabled all
 * derive from it. A cap the server enforces while the client guesses would be a button that can ask for something the
 * server always refuses — which is the shape of the bug this round exists to remove. One number means the client cannot
 * be wrong about the limit, because it is not permitted to have an opinion.
 *
 * ## Why a cap at all
 *
 * The count arrives from a client. Without an upper bound, `count = 1e9` is a request to roll a billion rarities and
 * write one profile — a denial of service with a friendly name. The bound is also the largest batch a single save can
 * describe, so the store sees one write rather than a queue of them.
 */
export const MAX_BULK_OPEN = 10;

/** What `count` chests cost. One definition, so the button's price and the server's debit cannot disagree. */
export function chestBatchCost(count: number): number {
	return count * COIN_CHEST_COST;
}

/**
 * Whether a balance covers `count` chests.
 *
 * Shared for the same reason as `MAX_BULK_OPEN`: the button's enabled state and the server's up-front affordability
 * check are the same question, and two implementations of it would be one place for an off-by-one to hide. `NaN` in
 * either argument makes every comparison false, which correctly reports "cannot afford" — the safe direction.
 */
export function canAffordChests(coins: number, count: number): boolean {
	return coins >= chestBatchCost(count);
}

/** The verdict on one bulk `count`. `reason` is a log token, not a sentence, so refusals can be counted by cause. */
export type BulkCountCheck = { ok: true; count: number } | { ok: false; reason: string };

/**
 * Validates a bulk open count.
 *
 * ## Why the order of these checks is the same as `checkCoinAmount`'s
 *
 * Because it is the same problem: a number arrives from outside and four of its shapes defeat naive tests. `NaN` makes
 * every comparison false, so it passes a range check and reaches the loop as "not above the cap and not below one".
 * `math.huge % 1` is `NaN`, so infinity is reported as fractional by an integer test that runs first. Checking
 * `not-a-number`, then `nan`, then `infinite`, then `not-an-integer`, then `not-positive`, then `above-cap` means each
 * refusal names the cause a person would actually fix.
 *
 * ## Why zero is refused rather than treated as a no-op
 *
 * `count = 0` is not "buy nothing", it is a malformed request: the client has exactly two buttons, one and ten, and
 * neither can produce a zero. A zero that reached the batch would take a snapshot, roll nothing, save nothing new and
 * report success — a write per press that changes nothing, which is worse than a refusal because it costs a DataStore
 * request and logs a purchase that did not happen.
 */
export function checkBulkOpenCount(value: unknown): BulkCountCheck {
	if (!typeIs(value, "number")) {
		return { ok: false, reason: "not-a-number" };
	}

	if (value !== value) {
		return { ok: false, reason: "nan" };
	}

	if (value === math.huge || value === -math.huge) {
		return { ok: false, reason: "infinite" };
	}

	if (value % 1 !== 0) {
		return { ok: false, reason: "not-an-integer" };
	}

	if (value < 1) {
		return { ok: false, reason: "not-positive" };
	}

	if (value > MAX_BULK_OPEN) {
		return { ok: false, reason: "above-cap" };
	}

	return { ok: true, count: value };
}

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

// #region Robux chest

/**
 * **Placeholder.** The Developer Product id for the Robux chest.
 *
 * **This is a fake number.** It must be replaced with the real id from the Creator Dashboard before the store can sell
 * anything; until it is, `ProcessReceipt` will never match a real purchase and the place charges nobody.
 *
 * **Debt carried here on purpose:** there is no `PolicyService` gate and no client UI in this round. The moment a
 * button that calls `PromptProductPurchase` is added, it must check `PolicyService:IsPaidRandomItemsRestricted` for that
 * player and refuse the prompt when restricted ? a paid random item is not allowed for every account. Putting the note
 * next to the product id means the file itself carries the debt rather than a prompt somebody has to remember.
 */
export const ROBUX_CHEST_PRODUCT_ID = 1234567890;

/**
 * **Placeholder.** The Robux price, for display only.
 *
 * **This constant charges nobody.** The real price is configured on the Developer Product in the Creator Dashboard and
 * is enforced by Roblox, not by this file. Value is metadata for the store UI to print next to the button, and it will
 * drift if the dashboard price changes ? so a reader must never treat it as authoritative.
 */
export const ROBUX_CHEST_PRICE_ROBUX = 30;

/**
 * The tiers the Robux chest can grant: everything in `RARITIES` except `common`.
 *
 * Derived by filtering rather than typed out, so the two chests cannot drift: if a tier is added to `RARITIES` it
 * joins the Robux pool automatically, and if `common` were renamed the filter would be a compile error rather than a
 * silently permissive list.
 */
export const ROBUX_CHEST_RARITIES: Array<Rarity> = RARITIES.filter((rarity) => rarity !== "common");

/**
 * The weight map the Robux chest rolls against: `RARITY_WEIGHTS` with every excluded tier set to **zero**.
 *
 * ## Why a full `Record<Rarity, number>` with zeros, not a smaller table
 *
 * Because then the roll needs **one** implementation. `rollFromWeights` walks `RARITIES` and subtracts each weight from
 * a running roll; a tier with weight `0` cannot satisfy `roll < 0` on its own step, so **zero weight is unreachable by
 * construction** ? the exclusion is arithmetic, not a separate branch that could be forgotten. A second, smaller table
 * would need a second pick function, and two pick functions are two places for the pools to diverge.
 *
 * The weights themselves are copied from `RARITY_WEIGHTS`, so "make legendaries rarer" remains a one-number edit that
 * moves both chests at once.
 */
export function robuxChestWeights(): Record<Rarity, number> {
	const weights = {} as Record<Rarity, number>;

	for (const rarity of RARITIES) {
		weights[rarity] = rarity === "common" ? 0 : RARITY_WEIGHTS[rarity];
	}

	return weights;
}

// #endregion

// #region purchase receipts

/**
 * **Placeholder.** How many processed `PurchaseId`s a profile remembers.
 *
 * A receipt can be delivered more than once (retries, a rejoin mid-grant), and a second grant of the same purchase is a
 * duplicate ball the player did not pay for twice. The record is a bounded list rather than an unbounded one because
 * a DataStore value has a size limit and a profile that grows forever eventually fails to save.
 *
 * **The trade-off, stated plainly:** a duplicate arriving after its id has been trimmed out of the list would be granted
 * again. At fifty ids that means a retry would have to be delayed by fifty chest purchases to be missed, which is why
 * the cap is generous rather than tight ? Roblox's own receipt retry window is far shorter than that.
 */
export const PURCHASE_HISTORY_CAP = 50;

// #endregion

// #region Robux bundle

/**
 * **Placeholder.** The Developer Product id for the ten-ball bundle.
 *
 * A **second** product on the Creator Dashboard, not a quantity on the first: Roblox charges per product, so "ten for the
 * price of eight" has to exist as its own product with its own price. Also fake ? replace both ids together.
 */
export const ROBUX_CHEST_BUNDLE_PRODUCT_ID = 1234567891;

/** **Placeholder.** Balls granted per bundle purchase. One charge, one receipt, `count` grants. */
export const ROBUX_CHEST_BUNDLE_COUNT = 10;

/**
 * **Placeholder.** The bundle's Robux price, **for display only**.
 *
 * Exactly as with `ROBUX_CHEST_PRICE_ROBUX`: the dashboard charges; this constant only labels a button. If the two
 * disagree the player sees the dashboard's number at the prompt, so a stale value here is a cosmetic lie rather than a
 * billing error.
 */
export const ROBUX_CHEST_BUNDLE_PRICE_ROBUX = 250;

// #endregion
