import { describe, expect, it } from "@rbxts/jest-globals";
import { ROBUX_CHEST_RARITIES, ROBUX_CHEST_WEIGHTS, RARITIES } from "./economy.config";
import { chestOdds, fusionOdds, robuxChestOdds } from "./odds";

/**
 * The odds tables.
 *
 * ## What these tests are actually protecting
 *
 * Not "does the arithmetic work" — it obviously does once — but **"does the number the player is shown equal the
 * number the server rolls against"**. `chestOdds()` and `fusionOdds()` are pure derivations of `RARITY_WEIGHTS` and
 * `FUSION_TABLE`, so the failure they guard against is a future edit to a weight that silently produces a table
 * summing to 99.9% or a fusion row whose two halves no longer add up.
 *
 * A probability table that does not sum to 100 is not a rounding inconvenience. It is a disclosure that is wrong,
 * which is worse than no disclosure — so the sum assertions here are the point of the file, not a formality.
 */
describe("chestOdds", () => {
	it("returns one row per rarity, in RARITIES order", () => {
		const rows = chestOdds();

		expect(rows.size()).toBe(RARITIES.size());

		for (let index = 0; index < RARITIES.size(); index++) {
			expect(rows[index].rarity).toBe(RARITIES[index]);
		}
	});

	it("sums to exactly 100", () => {
		let total = 0;
		for (const row of chestOdds()) {
			total += row.percent;
		}

		expect(total).toBe(100);
	});

	it("gives every rarity a positive chance", () => {
		// A zero would mean a tier that cannot drop while still being displayed as an outcome. Either it should be
		// removed from the pool or the weight is a mistake; this asserts nobody shipped the second case silently.
		for (const row of chestOdds()) {
			expect(row.percent > 0).toBe(true);
		}
	});

	it("derives the shipped weights as 60 / 30 / 9 / 1", () => {
		const rows = chestOdds();

		expect(rows[0].percent).toBe(60);
		expect(rows[1].percent).toBe(30);
		expect(rows[2].percent).toBe(9);
		expect(rows[3].percent).toBe(1);
	});
});

describe("fusionOdds", () => {
	it("returns success then fail, summing to exactly 100", () => {
		for (const rarity of RARITIES) {
			const rows = fusionOdds(rarity);

			if (rows.size() === 0) {
				continue;
			}

			expect(rows.size()).toBe(2);
			expect(rows[0].outcome).toBe("success");
			expect(rows[1].outcome).toBe("fail");
			expect(rows[0].percent + rows[1].percent).toBe(100);
		}
	});

	it("derives the shipped success chances as 60 / 40 / 20", () => {
		expect(fusionOdds("common")[0].percent).toBe(60);
		expect(fusionOdds("rare")[0].percent).toBe(40);
		expect(fusionOdds("epic")[0].percent).toBe(20);
	});

	it("has no table for legendary, because nothing is above it", () => {
		// The empty array is the legendary decision expressed as data: the server refuses the fusion and the client
		// renders no rows, from the same missing entry. A non-empty table here would mean the two had diverged.
		expect(fusionOdds("legendary").size()).toBe(0);
	});
});

describe("robuxChestOdds", () => {
	it("returns exactly three rows", () => {
		// Three, not four: the pool is rare and above. A fourth row would mean the exclusion had been dropped.
		expect(robuxChestOdds().size()).toBe(3);
	});

	it("never includes common", () => {
		for (const row of robuxChestOdds()) {
			expect(row.rarity === "common").toBe(false);
		}
	});

	it("sums to exactly 100", () => {
		let total = 0;
		for (const row of robuxChestOdds()) {
			total += row.percent;
		}

		// `toBe`, not `toBeCloseTo`: the apportionment is exact by construction, and a table that sums to 99.9 is a lie
		// told to the player rather than a rounding artefact to tolerate.
		expect(total).toBe(100);
	});

	it("is ordered rare, epic, legendary", () => {
		const rows = robuxChestOdds();

		expect(rows[0].rarity).toBe("rare");
		expect(rows[1].rarity).toBe("epic");
		expect(rows[2].rarity).toBe("legendary");
	});

	it("is strictly descending, so rarer really is rarer", () => {
		const rows = robuxChestOdds();

		for (let index = 1; index < rows.size(); index++) {
			expect(rows[index].percent < rows[index - 1].percent).toBe(true);
		}
	});

	it("derives 65 / 25 / 10 from the paid table's own weights", () => {
		// Read from `ROBUX_CHEST_WEIGHTS`, not from `RARITY_WEIGHTS`: the two chests no longer share a table, and this
		// assertion is what ties the displayed percentage to the number the roll actually uses.
		let total = 0;
		for (const rarity of ROBUX_CHEST_RARITIES) {
			total += ROBUX_CHEST_WEIGHTS[rarity];
		}

		const rows = robuxChestOdds();
		for (let index = 0; index < rows.size(); index++) {
			const expected = (ROBUX_CHEST_WEIGHTS[rows[index].rarity] / total) * 100;
			expect(rows[index].percent).toBe(expected);
		}

		// And the shipped numbers, spelled out: a table-only assertion would pass just as happily if every row moved.
		expect(rows[0].percent).toBe(65);
		expect(rows[1].percent).toBe(25);
		expect(rows[2].percent).toBe(10);
	});

	it("beats the coin chest for every tier it offers, and by more than before", () => {
		// The point of the Robux chest: not merely "no commons", but better odds for everything left in it. This invariant
		// held under the old shared table (75 / 22.5 / 2.5) and must hold under the paid table's own numbers, because a
		// renormalisation that made any tier worse would make the paid chest a downgrade for that tier.
		const coin = chestOdds();
		const robux = robuxChestOdds();

		for (const row of robux) {
			let coinPercent = 0;
			for (const candidate of coin) {
				if (candidate.rarity === row.rarity) {
					coinPercent = candidate.percent;
				}
			}

			expect(row.percent > coinPercent).toBe(true);
		}

		// And the retune's real shape: the reach tier paid for the top one, ten points of rare moved into legendary.
		expect(robux[0].percent).toBe(65);
		expect(robux[2].percent).toBe(10);
		// Ten times the free chest's legendary rate, exactly - the number the whole rebalance exists to move.
		expect(robux[2].percent).toBe(coin[3].percent * 10);
	});
});
