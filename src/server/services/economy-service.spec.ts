import { describe, expect, it } from "@rbxts/jest-globals";
import {
	COIN_CHEST_COST,
	FUSION_INPUT_COUNT,
	FUSION_TABLE,
	RARITIES,
	Rarity,
	RARITY_WEIGHTS,
	STARTING_COINS,
} from "shared/economy.config";

/**
 * The rules `EconomyService` runs on, and a note on what this file cannot reach.
 *
 * ## Why this file asserts tables rather than the service's methods
 *
 * `openCoinChest` and `fuseBalls` are thin once the I/O is removed: check the profile, check the cost, roll, mutate,
 * save, report. Every step past "check" needs a live DataStore and a `Player`, so what is worth asserting here is the
 * shape of the tables the service reads — a mistake there is silent until a player notices.
 *
 * - That the fusion table covers exactly the tiers that have a tier above them, and that each entry's `nextRarity` is
 *   **exactly one step** up `RARITIES`. A two-step jump would let two commons become an epic, and the odds display
 *   would still look fine.
 * - That every success chance is a whole number strictly between 0 and 100. A `0` or a `100` makes the wager a
 *   fiction, and a fraction makes the displayed integer a lie.
 * - That a new profile can afford a chest, which is what makes `STARTING_COINS` and `COIN_CHEST_COST` a coherent
 *   pair rather than two numbers that happen to sit next to each other.
 *
 * ## Why there is no read-only-policy test here
 *
 * The obvious test is "construct `EconomyService`, call a verb, expect `no-profile`". It cannot be written in this
 * runtime, and the reason bounds what the suite can ever cover: constructing the service constructs
 * `PlayerDataStore`, whose first act is `DataStoreService.GetDataStore`, and **an unpublished place throws
 * "You must publish this place to the web to access DataStore"** — verified by trying it. The failure is in the
 * constructor, before any assertion is reachable, and it cannot be worked around without publishing the place or
 * making the store lazy, which is a production change this round does not make.
 *
 * So the read-only refusal, the save-before-grant ordering, the session lock and `BindToClose` remain **Studio
 * observations against a published place**, named as such in the handoff.
 */
describe("FUSION_TABLE", () => {
	/** The tier one step above `rarity`, or `undefined` at the top of the ladder. */
	function tierAbove(rarity: Rarity): Rarity | undefined {
		for (let index = 0; index < RARITIES.size(); index++) {
			if (RARITIES[index] === rarity && index + 1 < RARITIES.size()) {
				return RARITIES[index + 1];
			}
		}

		return undefined;
	}

	it("has no entry for the top tier", () => {
		// The legendary decision, as data: no rule, so the service refuses and consumes nothing.
		expect(FUSION_TABLE.legendary).toBe(undefined);
	});

	it("has an entry for every tier that has a tier above it", () => {
		for (const rarity of RARITIES) {
			const above = tierAbove(rarity);

			if (above === undefined) {
				expect(FUSION_TABLE[rarity]).toBe(undefined);
				continue;
			}

			expect(FUSION_TABLE[rarity] !== undefined).toBe(true);
		}
	});

	it("upgrades exactly one tier, never two", () => {
		// The failure this catches: `common` -> `epic` would still display "60% success" and would still consume two
		// balls, so nothing in the UI or the log would look wrong.
		for (const rarity of RARITIES) {
			const rule = FUSION_TABLE[rarity];
			if (rule === undefined) {
				continue;
			}

			expect(rule.nextRarity).toBe(tierAbove(rarity));
		}
	});

	it("keeps every success chance a whole number strictly between 0 and 100", () => {
		for (const rarity of RARITIES) {
			const rule = FUSION_TABLE[rarity];
			if (rule === undefined) {
				continue;
			}

			expect(rule.successPercent > 0).toBe(true);
			expect(rule.successPercent < 100).toBe(true);
			expect(rule.successPercent % 1).toBe(0);
		}
	});

	it("gets harder as the tier gets rarer", () => {
		// Two commons becoming a rare should be more likely than two epics becoming a legendary. If that ever inverts,
		// the ladder is upside down and the odds panel is the only place it would show.
		const common = FUSION_TABLE.common;
		const rare = FUSION_TABLE.rare;
		const epic = FUSION_TABLE.epic;

		expect(common !== undefined && rare !== undefined && epic !== undefined).toBe(true);

		if (common !== undefined && rare !== undefined && epic !== undefined) {
			expect(common.successPercent > rare.successPercent).toBe(true);
			expect(rare.successPercent > epic.successPercent).toBe(true);
		}
	});
});

describe("economy costs", () => {
	it("consumes two inputs per fusion", () => {
		expect(FUSION_INPUT_COUNT).toBe(2);
	});

	it("lets a new profile open at least one chest", () => {
		// The whole testing story of a fresh profile is "press the chest at least once". If this ever fails, a new
		// player joins to a chest they cannot afford and a feature that looks broken.
		expect(STARTING_COINS >= COIN_CHEST_COST).toBe(true);
	});

	it("charges a positive whole number of coins", () => {
		expect(COIN_CHEST_COST > 0).toBe(true);
		expect(COIN_CHEST_COST % 1).toBe(0);
	});

	it("keeps every rarity weight positive", () => {
		// A zero weight would make a tier unreachable while `chestOdds` still listed it — the display and the roll
		// would disagree.
		for (const rarity of RARITIES) {
			expect(RARITY_WEIGHTS[rarity] > 0).toBe(true);
		}
	});
});
