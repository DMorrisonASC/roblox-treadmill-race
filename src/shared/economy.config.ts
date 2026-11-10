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
function compareStringsAscending(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

export function encodeOwnedBalls(ownedBalls: Map<string, number>): string {
	const ids = new Array<string>();
	for (const [ballId] of ownedBalls) {
		ids.push(ballId);
	}

	for (let index = 1; index < ids.size(); index++) {
		const value = ids[index];
		let insertIndex = index;
		while (insertIndex > 0 && compareStringsAscending(ids[insertIndex - 1], value) > 0) {
			ids[insertIndex] = ids[insertIndex - 1];
			insertIndex--;
		}
		ids[insertIndex] = value;
	}

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
 * The weight map the Robux chest rolls against: **its own table**, not a filtering of `RARITY_WEIGHTS`.
 *
 * ## Why the two chests no longer share numbers
 *
 * Until the coin economy gained participation, daily and playtime income, `robuxChestWeights()` copied
 * `RARITY_WEIGHTS` and zeroed commons - so "make legendaries rarer" moved both chests at once, which was the point.
 * That coupling is now a liability: a **free** chest and a **paid** product answer different questions, and the
 * monetisation tune that has to happen when the free track gets faster would otherwise silently change the free chest
 * as well. Retuning the paid one must not move the earned one, so the numbers are stated separately and a change here
 * is visibly a change to *this* product.
 *
 * ## The numbers, and what they trade
 *
 * `650 / 250 / 100` over a total of 1000 is **65% rare, 25% epic, 10% legendary**. The legendary rate is the point: a
 * 1-in-10 top tier is a reason to spend Robux where a 1-in-40 was not.
 *
 * | tier | coin chest | paid, before | paid, now |
 * | --- | --- | --- | --- |
 * | rare | 30% | 75% | 65% |
 * | epic | 9% | 22.5% | 25% |
 * | legendary | 1% | 2.5% | 10% |
 *
 * **What pays for it is the rare tier**: ten points of reach moved into the two tiers worth having. Every tier the paid
 * chest offers is still *strictly better* than the same tier on the free chest - rare 65 against 30, epic 25 against 9,
 * legendary ten times over - so the product remains a straight upgrade rather than a sideways move, which is the
 * property to check before any future retune. (The first draft of this docblock claimed epics had been *reduced* in
 * exchange for legendaries. That was arithmetic on the wrong row: the coin chest's epic rate is `90 / 1000 = 9%`, not
 * the `300` rare weight read as a percentage. The spec caught it, and it is left here as the concrete reason the two
 * tables are compared tier by tier rather than eyeballed.)
 */
export const ROBUX_CHEST_WEIGHTS: Record<Rarity, number> = {
	common: 0,
	rare: 650,
	epic: 250,
	legendary: 100,
};

/**
 * The weight map the Robux chest rolls against.
 *
 * ## Why a function and not just the constant
 *
 * `rollFromWeights` takes a `Record<Rarity, number>` and only reads it, but a caller holding the exported table could
 * mutate it - a shared config value is one stray `weights.legendary = 0` away from a silent product bug that no type
 * catches. A fresh copy per roll makes that impossible, and it costs one small table per chest.
 *
 * ## Why a full `Record<Rarity, number>` with zeros, not a smaller table
 *
 * Because then the roll needs **one** implementation. `rollFromWeights` walks `RARITIES` and subtracts each weight from
 * a running roll; a tier with weight `0` cannot satisfy `roll < 0` on its own step, so **zero weight is unreachable by
 * construction** - the exclusion is arithmetic, not a separate branch that could be forgotten. A second, smaller table
 * would need a second pick function, and two pick functions are two places for the pools to diverge.
 *
 * The zeros are therefore load-bearing even though `ROBUX_CHEST_WEIGHTS` states them: this function is what makes
 * "every tier is present in the map" a property of the code rather than a property of somebody remembering to type
 * `common: 0` in a table edit.
 */
export function robuxChestWeights(): Record<Rarity, number> {
	const weights = {} as Record<Rarity, number>;

	for (const rarity of RARITIES) {
		weights[rarity] = ROBUX_CHEST_WEIGHTS[rarity];
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
 *
 * ## The bundle floor, which is the reason to buy this instead of ten singles
 *
 * **One of the ten rolls is guaranteed to be `ROBUX_CHEST_BUNDLE_GUARANTEE`** if the bundle has not produced one on its
 * own. That is the product's whole pitch, and it has to live beside the product id because it is a *term of the sale*:
 * ten singles at `ROBUX_CHEST_PRICE_ROBUX` would cost more and could return no legendary at all, while this purchase
 * cannot. A player who reads the store's copy and this constant must find the same promise.
 *
 * **Written as a value, not as an if.** The guarantee is a `Rarity` passed into the grant function, so the rule is one
 * constant that a caller proves it honoured (`floored` in the result) rather than a branch inside a roll loop that a
 * later refactor can drop. Nothing about it changes the odds table above: the other nine rolls are ordinary paid rolls.
 */
export const ROBUX_CHEST_BUNDLE_PRODUCT_ID = 1234567891;

/** **Placeholder.** Balls granted per bundle purchase. One charge, one receipt, `count` grants. */
export const ROBUX_CHEST_BUNDLE_COUNT = 10;

/**
 * The tier the bundle cannot fail to deliver: **at least one of `ROBUX_CHEST_BUNDLE_COUNT` rolls is this tier.**
 *
 * A `Rarity` rather than a `boolean` because "guaranteed legendary" is a *tier promise*, and the shape lets the floor
 * move - a future bundle that guarantees an epic would change one word here rather than invert a flag at two call
 * sites. `legendary` is the shipped value: it is the tier the free track virtually never gives (1% a chest, so about
 * one in a hundred coin chests), which makes it the only tier a paid purchase can promise that grinding cannot.
 */
export const ROBUX_CHEST_BUNDLE_GUARANTEE: Rarity = "legendary";

/**
 * **Placeholder.** The bundle's Robux price, **for display only**.
 *
 * Exactly as with `ROBUX_CHEST_PRICE_ROBUX`: the dashboard charges; this constant only labels a button. If the two
 * disagree the player sees the dashboard's number at the prompt, so a stale value here is a cosmetic lie rather than a
 * billing error.
 */
export const ROBUX_CHEST_BUNDLE_PRICE_ROBUX = 250;

// #endregion

// #region time-based rewards

/**
 * **Placeholder.** Coins for the first join of the day.
 *
 * Chosen against a round rather than against a chest: a win pays 20 and a loss 10, so fifty is **two and a half wins** -
 * enough that a player who cannot play today still feels their account moved, small enough that a full session is still the
 * better deal. It is also exactly half a chest, which is the number to keep in mind before raising it.
 */
export const DAILY_LOGIN_REWARD_COINS = 50;

/**
 * **Placeholder.** How long between daily logins, in seconds: **twenty hours**, not twenty-four.
 *
 * The gap is deliberately shorter than a day. At exactly 24 hours a player who plays at eight every evening is paid late
 * every evening, and one who plays at eight one day and seven the next is paid **nothing** - the cooldown is a rate, not an
 * appointment, and 20 hours absorbs that drift while still being one reward a day for anyone playing a normal schedule.
 */
export const DAILY_LOGIN_COOLDOWN_SECONDS = 20 * 60 * 60;

/**
 * **Placeholder.** Coins per playtime interval.
 *
 * A quarter of a chest every fifteen minutes: about four chests an hour of *staying connected*, against roughly six from
 * winning rounds. The ordering matters - the stipend should not out-earn playing - and that is the relation to preserve.
 */
export const PLAYTIME_REWARD_COINS = 25;

/**
 * **Placeholder.** How long a player must be in the server to earn the stipend, in seconds.
 *
 * Measured from **load**, not from the epoch: see `playtimeBaselineAtLoad`. A stored timestamp that has already expired is
 * moved forward at load rather than paid immediately, so an absence is never billed as playtime.
 */
export const PLAYTIME_REWARD_INTERVAL_SECONDS = 15 * 60;

/**
 * **Placeholder.** How often the playtime pass runs, in seconds.
 *
 * **A ticker, not a timer per player.** One thread walks the player list once a minute and asks each profile a question,
 * which for a fifteen-minute interval is at most sixty seconds of lateness - invisible for a stipend - and costs one
 * iteration over a list that is at most a few dozen long. A `task.spawn` per player would be a thread and a `task.wait` per
 * joiner, all of them awake at once, for a 0.2% accuracy gain nobody asked for.
 */
export const PLAYTIME_TICK_SECONDS = 60;

// #endregion
