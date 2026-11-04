import { describe, expect, it } from "@rbxts/jest-globals";
import { RARITIES } from "./economy.config";
import { chestOdds, fusionOdds } from "./odds";

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
