import { describe, expect, it } from "@rbxts/jest-globals";
import {
	canAffordChests,
	checkBulkOpenCount,
	chestBatchCost,
	COIN_CHEST_COST,
	MAX_BULK_OPEN,
	Rarity,
} from "shared/economy.config";
import { applyChestBatch } from "../services/economy-service";
import { Profile } from "../services/player-data-store";

/**
 * The bulk open: its count validation, and what one batch does to a profile.
 *
 * ## Why this is a separate file
 *
 * The single-chest tests in `economy-service.spec.ts` are untouched by this round, and keeping the batch beside them
 * would have meant editing a file whose value is that it describes the *old* path exactly. A new file adds coverage
 * without moving a line of it.
 *
 * ## What it can and cannot reach
 *
 * `applyChestBatch` takes its save and its roll as callbacks, so the ordering, the atomicity and the restore are all
 * provable here with a fake save and a fixed roll — the same seam `applyRobuxChestGrant` and `applyProfileReset` use,
 * and for the same reason: `EconomyService`'s constructor builds a `PlayerDataStore`, which cannot exist in this
 * runtime. The remote handler and the button's rendering are Studio-only and are named in the round report.
 */

function profileWith(coins: number, balls: Record<string, number>): Profile {
	const ownedBalls = new Map<string, number>();
	for (const [ballId, count] of pairs(balls)) {
		ownedBalls.set(ballId, count);
	}

	return { version: 1, coins, ownedBalls, purchases: [], lastDailyRewardAt: 0, lastPlaytimeRewardAt: 0 };
}

/** Everything a batch touches, flattened, so "byte-identical" is one comparison rather than a list of assertions. */
function snapshot(profile: Profile): string {
	const ids = new Array<string>();
	for (const [ballId, count] of profile.ownedBalls) {
		ids.push(`${ballId}=${count}`);
	}

	for (let index = 1; index < ids.size(); index++) {
		const value = ids[index];
		let insertIndex = index;
		while (insertIndex > 0 && ids[insertIndex - 1] > value) {
			ids[insertIndex] = ids[insertIndex - 1];
			insertIndex--;
		}
		ids[insertIndex] = value;
	}

	return `${profile.coins}|${ids.join(",")}`;
}

/** A roll that always returns commons, and a picker that walks a fixed list — so the batch is deterministic. */
function fixedRoll(): Rarity {
	return "common";
}

function pickerFromSequence(ballIds: Array<string>): (rarity: Rarity) => string | undefined {
	let index = 0;
	return () => {
		const ballId = ballIds[index % ballIds.size()];
		index++;
		return ballId;
	};
}

describe("checkBulkOpenCount", () => {
	it("accepts one", () => {
		const check = checkBulkOpenCount(1);
		expect(check.ok).toBe(true);
		expect(check.ok ? check.count : -1).toBe(1);
	});

	it("accepts the cap itself", () => {
		expect(checkBulkOpenCount(MAX_BULK_OPEN).ok).toBe(true);
	});

	it("refuses zero", () => {
		// Not "buy nothing": the store has two buttons and neither can produce a zero, so a zero is a malformed request
		// and a batch of it would save a profile that changed nothing.
		const check = checkBulkOpenCount(0);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-positive");
	});

	it("refuses a negative count", () => {
		const check = checkBulkOpenCount(-1);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-positive");
	});

	it("refuses a fractional count", () => {
		const check = checkBulkOpenCount(1.5);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-an-integer");
	});

	it("refuses NaN", () => {
		// Checked before every comparison, because every comparison against NaN is false: an order that tested the range
		// first would let a NaN through as "not above the cap and not below one".
		const check = checkBulkOpenCount(0 / 0);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("nan");
	});

	it("refuses infinity", () => {
		const check = checkBulkOpenCount(math.huge);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("infinite");
	});

	it("refuses a count above the cap", () => {
		const check = checkBulkOpenCount(MAX_BULK_OPEN + 1);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("above-cap");
	});

	it("refuses a non-number", () => {
		// This is what a hostile or sloppy client looks like once the value crosses the remote.
		const check = checkBulkOpenCount("10");
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-a-number");

		const absent = checkBulkOpenCount(undefined);
		expect(absent.ok).toBe(false);
		expect(absent.ok ? "accepted" : absent.reason).toBe("not-a-number");
	});

	it("refuses a table", () => {
		const check = checkBulkOpenCount({ count: 10 });
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-a-number");
	});
});

describe("chestBatchCost and canAffordChests", () => {
	it("charges the unit cost times the count", () => {
		expect(chestBatchCost(1)).toBe(COIN_CHEST_COST);
		expect(chestBatchCost(10)).toBe(10 * COIN_CHEST_COST);
	});

	it("is affordable at exactly the cost", () => {
		// An off-by-one here is a button disabled for a player who can afford it, or enabled for one who cannot.
		expect(canAffordChests(10 * COIN_CHEST_COST, 10)).toBe(true);
	});

	it("is unaffordable one coin short", () => {
		expect(canAffordChests(10 * COIN_CHEST_COST - 1, 10)).toBe(false);
	});

	it("is unaffordable for every count when the balance is NaN", () => {
		// The safe direction: a NaN balance must not read as "yes".
		expect(canAffordChests(0 / 0, 1)).toBe(false);
	});
});

describe("applyChestBatch", () => {
	it("grants exactly count balls and debits exactly count times the cost", () => {
		const profile = profileWith(1000, {});
		let saves = 0;

		const result = applyChestBatch(
			profile,
			10,
			() => {
				saves++;
				return true;
			},
			fixedRoll,
			pickerFromSequence(["bully_ball"]),
		);

		expect(result.outcome).toBe("ok");
		expect(saves).toBe(1);
		expect(profile.coins).toBe(1000 - 10 * COIN_CHEST_COST);
		expect(profile.ownedBalls.get("bully_ball")).toBe(10);
		expect(result.outcome === "ok" ? result.balls.size() : 0).toBe(10);
	});

	it("reports the balls in roll order", () => {
		const profile = profileWith(1000, {});

		const result = applyChestBatch(
			profile,
			3,
			() => true,
			fixedRoll,
			pickerFromSequence(["bully_ball", "bouncy_ball", "ghost_ball"]),
		);

		expect(result.outcome === "ok" ? result.balls.join(",") : "wrong").toBe("bully_ball,bouncy_ball,ghost_ball");
	});

	it("reports the balance the batch computed", () => {
		const profile = profileWith(1000, {});

		const result = applyChestBatch(profile, 2, () => true, fixedRoll, pickerFromSequence(["bully_ball"]));

		// Captured before the save, because the save yields and the field is shared: reading it afterwards is how the
		// 14:47 log printed the same balance for two accepted chests.
		expect(result.outcome === "ok" ? result.coins : -1).toBe(800);
	});

	it("increments an owned ball rather than replacing its count", () => {
		const profile = profileWith(1000, { bully_ball: 2 });

		applyChestBatch(profile, 3, () => true, fixedRoll, pickerFromSequence(["bully_ball"]));

		expect(profile.ownedBalls.get("bully_ball")).toBe(5);
	});

	it("restores coins and balls byte-identically when the save fails", () => {
		const profile = profileWith(1000, { bully_ball: 2, ghost_ball: 1 });
		const before = snapshot(profile);

		const result = applyChestBatch(
			profile,
			5,
			() => false,
			fixedRoll,
			pickerFromSequence(["bully_ball", "ghost_ball"]),
		);

		expect(result.outcome).toBe("save-failed");
		expect(snapshot(profile)).toBe(before);
	});

	it("leaves nothing behind after a failed save, so a retry grants the full batch", () => {
		// Criterion: a failed call must be invisible. If it left a ball or a debit behind, the retry would compound it.
		const profile = profileWith(1000, {});
		let attempts = 0;

		const failed = applyChestBatch(
			profile,
			10,
			() => {
				attempts++;
				return false;
			},
			fixedRoll,
			pickerFromSequence(["bully_ball"]),
		);

		expect(failed.outcome).toBe("save-failed");
		expect(profile.coins).toBe(1000);
		expect(profile.ownedBalls.size()).toBe(0);

		const retried = applyChestBatch(
			profile,
			10,
			() => {
				attempts++;
				return true;
			},
			fixedRoll,
			pickerFromSequence(["bully_ball"]),
		);

		expect(retried.outcome).toBe("ok");
		expect(attempts).toBe(2);
		expect(profile.coins).toBe(0);
		expect(profile.ownedBalls.get("bully_ball")).toBe(10);
	});

	it("aborts the whole batch when a roll finds an empty pool", () => {
		// A partial batch would charge for chests that granted nothing. Two balls roll fine, the third does not.
		const profile = profileWith(1000, {});
		const before = snapshot(profile);
		let index = 0;

		const result = applyChestBatch(
			profile,
			5,
			() => true,
			fixedRoll,
			() => {
				index++;
				return index <= 2 ? "bully_ball" : undefined;
			},
		);

		expect(result.outcome).toBe("empty-pool");
		expect(snapshot(profile)).toBe(before);
	});

	it("writes nothing when the count is zero", () => {
		// Unreachable from the service, which validates first — the guard exists so the function is total.
		const profile = profileWith(1000, {});
		let saves = 0;

		const result = applyChestBatch(
			profile,
			0,
			() => {
				saves++;
				return true;
			},
			fixedRoll,
			pickerFromSequence(["bully_ball"]),
		);

		expect(result.outcome).toBe("bad-count");
		expect(saves).toBe(0);
		expect(profile.coins).toBe(1000);
	});

	it("saves once for ten chests, not once per chest", () => {
		// The DataStore queue line in the 14:47 run was ten writes in five seconds. One write is the whole point.
		const profile = profileWith(1000, {});
		let saves = 0;

		applyChestBatch(
			profile,
			10,
			() => {
				saves++;
				return true;
			},
			fixedRoll,
			pickerFromSequence(["bully_ball"]),
		);

		expect(saves).toBe(1);
	});
});
