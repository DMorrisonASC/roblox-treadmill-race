import { describe, expect, it } from "@rbxts/jest-globals";
import {
	COIN_CHEST_COST,
	FUSION_INPUT_COUNT,
	FUSION_TABLE,
	RARITIES,
	Rarity,
	RARITY_WEIGHTS,
	STARTING_COINS,
	ROBUX_CHEST_RARITIES,
	robuxChestWeights,
} from "shared/economy.config";
import {
	applyRobuxChestBundleGrant,
	applyRobuxChestGrant,
	receiptDecision,
	rollFromWeights,
} from "../services/economy-service";
import { Profile } from "../services/player-data-store";

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

/**
 * The Robux chest grant, exercised through `applyRobuxChestGrant` with a fake save.
 *
 * ## Why this is possible now and was not before
 *
 * `EconomyService`'s constructor builds a `PlayerDataStore`, whose first act is `DataStoreService.GetDataStore` ? which
 * throws in an unpublished place, so the service cannot be constructed in this runtime at all. The grant was therefore
 * factored out into a function that takes its save and its roll as parameters; the service method is a four-line wrapper
 * around it. Everything worth asserting about the money path lives on this side of that line.
 *
 * The `save` fake is where the ordering claim becomes testable: it records that it was called, and it can refuse, which
 * is the only way to prove that a refused save leaves `ownedBalls` untouched.
 */
describe("applyRobuxChestGrant", () => {
	function profileWith(balls: Record<string, number>, purchases: Array<string> = []): Profile {
		const ownedBalls = new Map<string, number>();
		for (const [ballId, count] of pairs(balls)) {
			ownedBalls.set(ballId, count);
		}

		return { version: 1, coins: 0, ownedBalls, purchases };
	}

	it("grants one ball from the rare pool and records the purchase", () => {
		const profile = profileWith({});
		let saves = 0;

		const outcome = applyRobuxChestGrant(
			profile,
			"purchase-1",
			() => {
				saves++;
				return true;
			},
			() => "rare",
			() => "heavy_ball",
		);

		expect(outcome).toBe("granted");
		expect(saves).toBe(1);
		expect(profile.ownedBalls.get("heavy_ball")).toBe(1);
		expect(profile.purchases.size()).toBe(1);
	});

	it("saves before it reports success", () => {
		// The save callback runs while the mutation is already in the profile, so a save that inspects the profile sees
		// the granted ball ? which is what makes "the write contains the grant" true rather than hopeful.
		const profile = profileWith({});
		let sawBallDuringSave = false;

		applyRobuxChestGrant(
			profile,
			"purchase-2",
			(candidate) => {
				sawBallDuringSave = (candidate.ownedBalls.get("heavy_ball") ?? 0) === 1;
				return true;
			},
			() => "rare",
			() => "heavy_ball",
		);

		expect(sawBallDuringSave).toBe(true);
	});

	it("grants nothing for a purchase id already in the profile", () => {
		const profile = profileWith({ heavy_ball: 1 }, ["purchase-3"]);
		let saves = 0;

		const outcome = applyRobuxChestGrant(
			profile,
			"purchase-3",
			() => {
				saves++;
				return true;
			},
			() => "legendary",
			() => "prism_ball",
		);

		expect(outcome).toBe("duplicate");
		// Not merely "did not add a second ball": it did not write at all, because a duplicate has nothing to persist.
		expect(saves).toBe(0);
		expect(profile.ownedBalls.get("prism_ball")).toBe(undefined);
		expect(profile.ownedBalls.get("heavy_ball")).toBe(1);
	});

	it("reverts the ball and the purchase id when the save fails", () => {
		const profile = profileWith({ heavy_ball: 1 });

		const outcome = applyRobuxChestGrant(
			profile,
			"purchase-4",
			() => false,
			() => "rare",
			() => "heavy_ball",
		);

		expect(outcome).toBe("save-failed");
		expect(profile.ownedBalls.get("heavy_ball")).toBe(1);
		// The id must be gone too, or the retry would be treated as a duplicate of a grant that never happened.
		expect(profile.purchases.size()).toBe(0);
	});

	it("removes the ball entry entirely when the save fails and none was owned", () => {
		const profile = profileWith({});

		applyRobuxChestGrant(
			profile,
			"purchase-5",
			() => false,
			() => "epic",
			() => "magnet_ball",
		);

		// `magnet_ball = 0` would be a ball the player "owns" none of, which the fusion UI would offer to fuse.
		expect(profile.ownedBalls.has("magnet_ball")).toBe(false);
	});

	it("refuses rather than granting a ball from an empty pool", () => {
		const profile = profileWith({});

		const outcome = applyRobuxChestGrant(
			profile,
			"purchase-6",
			() => true,
			() => "legendary",
			() => undefined,
		);

		expect(outcome).toBe("save-failed");
		expect(profile.ownedBalls.size()).toBe(0);
	});
});

describe("receiptDecision", () => {
	it("answers PurchaseGranted for a fresh grant and for a duplicate", () => {
		// A duplicate answering NotProcessedYet would make Roblox retry forever, and each retry would also be a
		// duplicate ? an infinite loop that also blocks the player's next purchase.
		expect(receiptDecision("granted")).toBe(Enum.ProductPurchaseDecision.PurchaseGranted);
		expect(receiptDecision("duplicate")).toBe(Enum.ProductPurchaseDecision.PurchaseGranted);
	});

	it("answers NotProcessedYet when the player got nothing", () => {
		// Both of these are "the player paid and has no ball", so a retry is the only outcome that can still deliver.
		expect(receiptDecision("no-profile")).toBe(Enum.ProductPurchaseDecision.NotProcessedYet);
		expect(receiptDecision("save-failed")).toBe(Enum.ProductPurchaseDecision.NotProcessedYet);
	});
});

describe("rollFromWeights with the Robux weights", () => {
	it("never returns common across many rolls", () => {
		// The exclusion is arithmetic (common has weight 0, so `roll < 0` cannot fire on its turn), and this is the
		// assertion that the arithmetic actually holds. A thousand rolls makes the absence of a 0-weight tier
		// overwhelming rather than merely plausible; before the filter, common would appear roughly 600/1000 of the time.
		const weights = robuxChestWeights();

		for (let attempt = 0; attempt < 1000; attempt++) {
			expect(rollFromWeights(weights) === "common").toBe(false);
		}
	});

	it("only ever returns a tier the paid pool contains", () => {
		const weights = robuxChestWeights();

		for (let attempt = 0; attempt < 200; attempt++) {
			const rarity = rollFromWeights(weights);
			let found = false;

			for (const allowed of ROBUX_CHEST_RARITIES) {
				if (allowed === rarity) {
					found = true;
				}
			}

			expect(found).toBe(true);
		}
	});
});

/**
 * The bundle: ten balls, one purchase, all-or-nothing.
 *
 * ## What these tests are actually protecting
 *
 * Not "ten balls arrive" ? that is the easy half. The failure this design exists to prevent is a **partial** grant: some
 * balls applied in memory for a purchase whose record never landed, which the next unrelated save would then persist.
 * Every assertion below is therefore about what is left behind after a failure, not only about the success path.
 */
describe("applyRobuxChestBundleGrant", () => {
	function profileWith(balls: Record<string, number>, purchases: Array<string> = []): Profile {
		const ownedBalls = new Map<string, number>();
		for (const [ballId, count] of pairs(balls)) {
			ownedBalls.set(ballId, count);
		}

		return { version: 1, coins: 0, ownedBalls, purchases };
	}

	it("grants count balls and one purchase id, saving once", () => {
		const profile = profileWith({});
		let saves = 0;

		const result = applyRobuxChestBundleGrant(
			profile,
			"bundle-1",
			10,
			() => {
				saves++;
				return true;
			},
			() => "rare",
			() => "heavy_ball",
		);

		expect(result.outcome).toBe("granted");
		expect(result.granted.size()).toBe(10);
		expect(profile.ownedBalls.get("heavy_ball")).toBe(10);
		// One id for the purchase, not ten for the balls.
		expect(profile.purchases.size()).toBe(1);
		expect(saves).toBe(1);
	});

	it("reports every granted ball id, in roll order", () => {
		const profile = profileWith({});
		const picks = ["heavy_ball", "split_ball", "magnet_ball"];
		let picked = 0;

		const result = applyRobuxChestBundleGrant(
			profile,
			"bundle-2",
			3,
			() => true,
			() => "rare",
			() => {
				// Indexed on the pick, not on the roll: `roll` runs before `pickBall`, so a counter incremented there
				// would be one ahead and the assertion would silently test the wrong sequence.
				const ballId = picks[picked] ?? picks[0];
				picked++;
				return ballId;
			},
		);

		expect(result.outcome).toBe("granted");
		expect(result.granted.size()).toBe(3);
		expect(result.granted[0]).toBe("heavy_ball");
		expect(result.granted[1]).toBe("split_ball");
		expect(result.granted[2]).toBe("magnet_ball");
	});

	it("grants nothing and saves nothing for a redelivered purchase id", () => {
		const profile = profileWith({ heavy_ball: 1 }, ["bundle-3"]);
		let saves = 0;

		const result = applyRobuxChestBundleGrant(
			profile,
			"bundle-3",
			10,
			() => {
				saves++;
				return true;
			},
			() => "legendary",
			() => "prism_ball",
		);

		expect(result.outcome).toBe("duplicate");
		expect(result.granted.size()).toBe(0);
		expect(saves).toBe(0);
		expect(profile.ownedBalls.get("prism_ball")).toBe(undefined);
	});

	it("restores ownedBalls and purchases exactly when the save fails", () => {
		// A profile that already owns something, so the restore has a real prior state to reproduce rather than an empty
		// one where "correct" and "wiped" would look the same.
		const profile = profileWith({ split_ball: 2, ghost_ball: 1 }, ["older-purchase"]);
		const ballsBefore = profile.ownedBalls.size();
		const purchasesBefore = profile.purchases.size();

		const result = applyRobuxChestBundleGrant(
			profile,
			"bundle-4",
			10,
			() => false,
			() => "epic",
			() => "rocket_ball",
		);

		expect(result.outcome).toBe("save-failed");
		expect(result.granted.size()).toBe(0);
		expect(profile.ownedBalls.size()).toBe(ballsBefore);
		expect(profile.ownedBalls.get("rocket_ball")).toBe(undefined);
		expect(profile.ownedBalls.get("split_ball")).toBe(2);
		expect(profile.ownedBalls.get("ghost_ball")).toBe(1);
		expect(profile.purchases.size()).toBe(purchasesBefore);
		expect(profile.purchases[0]).toBe("older-purchase");
	});

	it("undoes the history trim as well as the balls", () => {
		// The trim runs before the save, so a rollback that only removed the pushed id would still have discarded the
		// oldest receipts ? quietly making those purchases re-grantable.
		const purchases = new Array<string>();
		for (let index = 0; index < 50; index++) {
			purchases.push(`old-${index}`);
		}

		const profile = profileWith({}, purchases);

		applyRobuxChestBundleGrant(
			profile,
			"bundle-5",
			10,
			() => false,
			() => "rare",
			() => "heavy_ball",
		);

		expect(profile.purchases.size()).toBe(50);
		expect(profile.purchases[0]).toBe("old-0");
	});

	it("aborts and reverts when a roll lands on an empty pool mid-loop", () => {
		const profile = profileWith({});
		let rolls = 0;

		const result = applyRobuxChestBundleGrant(
			profile,
			"bundle-6",
			10,
			() => true,
			() => {
				rolls++;
				return "rare";
			},
			() => {
				// Grant the first three, then fail ? proving the balls already added are removed.
				return rolls <= 3 ? "heavy_ball" : undefined;
			},
		);

		expect(result.outcome).toBe("save-failed");
		expect(result.granted.size()).toBe(0);
		expect(profile.ownedBalls.size()).toBe(0);
		expect(profile.purchases.size()).toBe(0);
	});

	it("lets the retry after a failed save succeed with the same purchase id", () => {
		// Criterion 7, and the reason the purchases array is restored rather than left with the id pushed: if the id had
		// survived the rollback, this second call would report "duplicate" and be answered PurchaseGranted ? the player
		// charged, the receipt consumed, and nothing granted.
		const profile = profileWith({});
		let saves = 0;

		const first = applyRobuxChestBundleGrant(
			profile,
			"bundle-7",
			10,
			() => {
				saves++;
				return false;
			},
			() => "rare",
			() => "heavy_ball",
		);

		expect(first.outcome).toBe("save-failed");
		expect(profile.purchases.size()).toBe(0);

		const second = applyRobuxChestBundleGrant(
			profile,
			"bundle-7",
			10,
			() => {
				saves++;
				return true;
			},
			() => "rare",
			() => "heavy_ball",
		);

		expect(second.outcome).toBe("granted");
		expect(second.granted.size()).toBe(10);
		expect(profile.ownedBalls.get("heavy_ball")).toBe(10);
		expect(profile.purchases.size()).toBe(1);
		expect(saves).toBe(2);
	});
});
