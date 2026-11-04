/**
 * Odds, computed from the tables the server actually rolls against.
 *
 * ## Why these exist when nobody is obliged to publish them
 *
 * **Odds are disclosed voluntarily.** The coins are earned-only, so the chest is not a paid random item and
 * policy does not require disclosure — but a hidden probability is a betrayal when the player is spending a
 * material, and the fusion spends two of something they had to earn. The chest's cost is coins, which cost
 * time; the fusion's cost is a ball the player already owns. Neither is money, and both are still a wager.
 *
 * ## Why this is a pair of pure functions rather than a panel
 *
 * The numbers belong to the game, not to a screen. A future banner, tooltip, or web page can print them
 * because `chestOdds()` returns data and nothing else: no instances, no services, no side effects, no clock.
 * The panel that renders this file is one caller, and the formatting decision (integer vs one decimal) is made
 * here so two callers cannot disagree about it.
 *
 * Every function here is total over its input: no throws, no missing cases. `fusionOdds("legendary")` is `[]`
 * rather than an error, because "there is no tier above legendary" is an answer, not a failure.
 */
import { FUSION_TABLE, RARITIES, RARITY_WEIGHTS, Rarity } from "./economy.config";

/** One row of the chest table. */
export interface ChestOdd {
	readonly rarity: Rarity;
	/** Percent, with at most one decimal place. The rows always sum to exactly 100. */
	readonly percent: number;
}

/** One row of a fusion table. */
export interface FusionOdd {
	readonly outcome: "success" | "fail";
	/** Percent, always an integer. The two rows sum to exactly 100. */
	readonly percent: number;
}

/** Tenths of a percent per percent — the unit the apportionment below works in. */
const TENTHS_PER_PERCENT = 10;

/** The whole table's size in tenths of a percent. Fixed at 100%, because a probability table has no choice. */
const TOTAL_TENTHS = 100 * TENTHS_PER_PERCENT;

/**
 * `Math.round` to one decimal place.
 *
 * Needed because the value under test is a float: `2 / 3 * 100` is `66.66666666666666`, and a percentage
 * displayed with 14 significant figures reads as a measurement rather than as a probability.
 */
function toOneDecimal(value: number): number {
	return math.round(value * TENTHS_PER_PERCENT) / TENTHS_PER_PERCENT;
}

/**
 * The chest's odds as percentages, in `RARITIES` order.
 *
 * ## Why this is apportionment and not `weight / total * 100`
 *
 * Rounding each row independently does not preserve the total: three rows at 33.33% each display 99.99% and
 * the fourth displays 100.01%, and a table of probabilities that does not sum to 100 is not a table of
 * probabilities any more. **Largest-remainder apportionment** fixes the total by construction: every row gets
 * its floor, and the leftover tenths go to the rows that were rounded down hardest. With the shipped weights
 * the floors are already exact (600, 300, 90, 10 tenths-of-percent-of-1000), so nothing is redistributed — the
 * algorithm is here for the day somebody edits a weight to `7`.
 *
 * ## Why the multiply comes before the divide
 *
 * `(weight / total) * TOTAL_TENTHS` in floating point evaluates `600 / 1000` as `0.5999999999999999…`, and
 * multiplying that by 1000 floors to 599 — a whole tenth lost to representation error. `weight * TOTAL_TENTHS`
 * first is exact for every weight below 2^52: integers stay integers until the single division at the end.
 */
export function chestOdds(): Array<ChestOdd> {
	let total = 0;
	for (const rarity of RARITIES) {
		total += RARITY_WEIGHTS[rarity];
	}

	// An all-zero table has no meaningful distribution. An empty array is the honest answer: a caller renders
	// no rows rather than a table of zeroes that looks like a bug in the display.
	if (total <= 0) {
		return [];
	}

	const tenths = new Array<number>();
	const remainders = new Array<number>();
	let assigned = 0;

	for (const rarity of RARITIES) {
		const exact = (RARITY_WEIGHTS[rarity] * TOTAL_TENTHS) / total;
		const floor = math.floor(exact);
		tenths.push(floor);
		remainders.push(exact - floor);
		assigned += floor;
	}

	let leftover = TOTAL_TENTHS - assigned;
	while (leftover > 0) {
		let bestIndex = 0;
		for (let index = 1; index < remainders.size(); index++) {
			if (remainders[index] > remainders[bestIndex]) {
				bestIndex = index;
			}
		}

		tenths[bestIndex] += 1;
		// Spent: this row has taken its extra tenth, so it must not be the largest remainder again while
		// another row still has one to collect.
		remainders[bestIndex] -= 1;
		leftover -= 1;
	}

	const rows = new Array<ChestOdd>();
	for (let index = 0; index < RARITIES.size(); index++) {
		rows.push({ rarity: RARITIES[index], percent: toOneDecimal(tenths[index] / TENTHS_PER_PERCENT) });
	}

	return rows;
}

/**
 * A fusion's outcome odds for one input tier.
 *
 * **`legendary` returns an empty array**, and that is the whole of the legendary decision: `FUSION_TABLE` has
 * no entry because there is no tier above legendary, so there is no outcome to display. The client reads an
 * empty table as "this cannot be fused" — the same answer the server gives when it refuses — instead of the
 * client inventing a probability for a transaction that will not happen.
 *
 * The two rows are derived from one number, so they sum to 100 by construction rather than by coincidence.
 */
export function fusionOdds(inputRarity: Rarity): Array<FusionOdd> {
	const rule = FUSION_TABLE[inputRarity];
	if (rule === undefined) {
		return [];
	}

	return [
		{ outcome: "success", percent: rule.successPercent },
		{ outcome: "fail", percent: 100 - rule.successPercent },
	];
}
