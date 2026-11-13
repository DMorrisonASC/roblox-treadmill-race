import { describe, expect, it } from "@rbxts/jest-globals";
import {
	BALL_POOL,
	decodeOwnedBalls,
	encodeOwnedBalls,
	isRarity,
	RARITIES,
	rarityOfBall,
	RARITY_WEIGHTS,
	ROBUX_CHEST_BUNDLE_PRICE_ROBUX,
	ROBUX_CHEST_BUNDLE_PRODUCT_ID,
	ROBUX_CHEST_PRICE_ROBUX,
	ROBUX_CHEST_PRODUCT_ID,
	ROBUX_CHEST_RARITIES,
	ROBUX_CHEST_WEIGHTS,
	robuxChestWeights,
} from "./economy.config";

/**
 * The stored format and the tables it points into.
 *
 * ## Why the encoding has its own spec
 *
 * `OwnedBalls` is the only part of a profile that is serialised by hand, and it is written by the server and read by
 * whatever looks at the attribute next. A round-trip that loses a ball is invisible until somebody rejoins and finds
 * their inventory short — which is the exact failure mode the DataStore work exists to prevent. So the round-trip is
 * asserted over the shapes that really occur: an empty profile, one ball, duplicates, and several balls whose
 * insertion order differs from their sorted order.
 *
 * The decoder is deliberately total — it skips malformed pairs rather than throwing — so the malformed cases below
 * assert *that it survives*, not that it rejects. A reader that threw on a bad attribute would take the whole HUD
 * down over a string.
 */
describe("encodeOwnedBalls", () => {
	it("encodes an empty profile as an empty string", () => {
		expect(encodeOwnedBalls(new Map())).toBe("");
	});

	it("encodes one ball as id=count", () => {
		const owned = new Map<string, number>();
		owned.set("bully_ball", 1);

		expect(encodeOwnedBalls(owned)).toBe("bully_ball=1");
	});

	it("keeps duplicates as counts rather than repeated ids", () => {
		const owned = new Map<string, number>();
		owned.set("bully_ball", 3);

		expect(encodeOwnedBalls(owned)).toBe("bully_ball=3");
	});

	it("sorts by id, so insertion order cannot change the attribute", () => {
		// The reason this matters: an attribute write that reorders is an attribute *change*, so the client would be
		// notified for a profile that did not actually change.
		const owned = new Map<string, number>();
		owned.set("ghost_ball", 1);
		owned.set("bully_ball", 2);

		expect(encodeOwnedBalls(owned)).toBe("bully_ball=2;ghost_ball=1");
	});
});

describe("decodeOwnedBalls", () => {
	it("round-trips an empty profile", () => {
		const decoded = decodeOwnedBalls("");

		expect(decoded.size()).toBe(0);
	});

	it("round-trips several balls with duplicates", () => {
		const owned = new Map<string, number>();
		owned.set("bully_ball", 2);
		owned.set("ghost_ball", 1);
		owned.set("recycle_ball", 4);

		const decoded = decodeOwnedBalls(encodeOwnedBalls(owned));

		expect(decoded.size()).toBe(3);
		expect(decoded.get("bully_ball")).toBe(2);
		expect(decoded.get("ghost_ball")).toBe(1);
		expect(decoded.get("recycle_ball")).toBe(4);
	});

	it("survives a malformed attribute instead of throwing", () => {
		// Every shape below could reach a client from a build that wrote the attribute differently.
		expect(decodeOwnedBalls("garbage").size()).toBe(0);
		expect(decodeOwnedBalls("x").size()).toBe(0);
		expect(decodeOwnedBalls("=5").size()).toBe(0);
		expect(decodeOwnedBalls("a=notanumber").size()).toBe(0);
		expect(decodeOwnedBalls("a=1=2").size()).toBe(0);
	});

	it("keeps the valid pairs out of a partly malformed attribute", () => {
		const decoded = decodeOwnedBalls("bully_ball=2;;garbage;ghost_ball=1");

		expect(decoded.size()).toBe(2);
		expect(decoded.get("bully_ball")).toBe(2);
		expect(decoded.get("ghost_ball")).toBe(1);
	});
});

describe("BALL_POOL", () => {
	it("has at least one ball in every tier", () => {
		// A tier with an empty pool would make a successful roll grant nothing — the service refuses it, but the
		// honest place to catch it is here, in the data.
		for (const rarity of RARITIES) {
			expect(BALL_POOL[rarity].size() > 0).toBe(true);
		}
	});

	it("never repeats an id across tiers", () => {
		// `rarityOfBall` walks the tiers in order and returns the first match, so a duplicated id would resolve to the
		// earlier tier and the fusion would upgrade the wrong thing.
		const seen = new Map<string, string>();

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				expect(seen.has(ballId)).toBe(false);
				seen.set(ballId, rarity);
			}
		}
	});
});

describe("rarityOfBall", () => {
	it("resolves every pool ball back to the tier that owns it", () => {
		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				expect(rarityOfBall(ballId)).toBe(rarity);
			}
		}
	});

	it("returns undefined for an id it does not know", () => {
		// A profile saved by an older build can name a ball this build has never heard of; the caller has to be able
		// to tell that apart from "common".
		expect(rarityOfBall("not_a_ball")).toBe(undefined);
		expect(rarityOfBall("")).toBe(undefined);
	});
});

describe("RARITY_WEIGHTS", () => {
	it("sums to the documented 1000", () => {
		let total = 0;
		for (const rarity of RARITIES) {
			total += RARITY_WEIGHTS[rarity];
		}

		expect(total).toBe(1000);
	});

	it("is strictly descending, so rarer really is rarer", () => {
		for (let index = 1; index < RARITIES.size(); index++) {
			expect(RARITY_WEIGHTS[RARITIES[index]] < RARITY_WEIGHTS[RARITIES[index - 1]]).toBe(true);
		}
	});
});

describe("isRarity", () => {
	it("accepts each shipped name and rejects anything else", () => {
		for (const rarity of RARITIES) {
			expect(isRarity(rarity)).toBe(true);
		}

		expect(isRarity("Common")).toBe(false);
		expect(isRarity("mythic")).toBe(false);
		expect(isRarity("")).toBe(false);
	});
});

describe("Robux chest pool", () => {
	it("excludes common and keeps every tier above it", () => {
		// The whole point of the product: a paid chest that can roll a common is a paid chest that feels like the free
		// one. This asserts the pool by content rather than by count, so adding a tier keeps the test meaningful.
		for (const rarity of ROBUX_CHEST_RARITIES) {
			expect(rarity === "common").toBe(false);
		}

		expect(ROBUX_CHEST_RARITIES.size()).toBe(RARITIES.size() - 1);
	});

	it("is non-empty and every entry has balls to give", () => {
		// An empty pool would make a purchased chest grant nothing ? the worst failure mode in the file, because the
		// player has already paid by the time it happens.
		expect(ROBUX_CHEST_RARITIES.size() > 0).toBe(true);

		for (const rarity of ROBUX_CHEST_RARITIES) {
			expect(BALL_POOL[rarity].size() > 0).toBe(true);
		}
	});

	it("gives common a weight of zero and every other tier its own paid weight", () => {
		const weights = robuxChestWeights();

		// Zero is the mechanism: `rollFromWeights` subtracts each weight from a roll that starts non-negative, so a
		// zero-weight tier can never satisfy `roll < 0`. Asserting the zero is asserting the exclusion.
		expect(weights.common).toBe(0);

		// From `ROBUX_CHEST_WEIGHTS`, not `RARITY_WEIGHTS`: the paid chest stopped sharing the free chest's table when the
		// legendary rate was raised to 10%, and asserting the old source would have quietly re-coupled them.
		for (const rarity of ROBUX_CHEST_RARITIES) {
			expect(weights[rarity]).toBe(ROBUX_CHEST_WEIGHTS[rarity]);
		}
	});

	it("pays more for every tier it offers than the free chest does", () => {
		// Both tables are stated over 1000, so a weight comparison here *is* a percentage comparison. Every paid tier must sit
		// above its free counterpart or the product is a downgrade somewhere - 650/250/100 against 300/90/10 does, on all
		// three. (The reach tier only went down against the *previous paid* table, 75 -> 65; it is still twice the free rate.)
		expect(ROBUX_CHEST_WEIGHTS.rare > RARITY_WEIGHTS.rare).toBe(true);
		expect(ROBUX_CHEST_WEIGHTS.epic > RARITY_WEIGHTS.epic).toBe(true);
		expect(ROBUX_CHEST_WEIGHTS.legendary > RARITY_WEIGHTS.legendary).toBe(true);
	});

	it("sums the surviving weights to a full table, so the odds are stated rather than derived", () => {
		// Under the old coupling the surviving total was 400 of the coin chest's 1000, and renormalisation was what made the
		// paid odds better. Now the table is its own and totals 1000, so the percentages are the weights - there is no
		// hidden renormalisation left to be surprised by.
		let surviving = 0;

		for (const rarity of ROBUX_CHEST_RARITIES) {
			surviving += ROBUX_CHEST_WEIGHTS[rarity];
		}

		expect(surviving).toBe(1000);
	});

	it("carries two live product ids, distinct from each other, and a display price for each", () => {
		// These were placeholder guards while the ids were fake - "replace these before the store can sell anything". Both are
		// real now (item 235), so the guard changes shape: what a reader must not do is give the two products **one id**, because
		// `ProcessReceipt` dispatches on `ProductId` and a shared id would deliver the single for a bundle purchase (or the
		// other way round) with no error anywhere.
		expect(ROBUX_CHEST_PRODUCT_ID > 0).toBe(true);
		expect(ROBUX_CHEST_BUNDLE_PRODUCT_ID > 0).toBe(true);

		// Widened through an array rather than compared directly: both ids are literal types, and TypeScript rejects
		// `3730790793 !== 3730801824` as an "unintentional" comparison because the two literals have no overlap.
		const ids: Array<number> = [ROBUX_CHEST_PRODUCT_ID, ROBUX_CHEST_BUNDLE_PRODUCT_ID];
		expect(ids[0] !== ids[1]).toBe(true);

		// The prices are display metadata only - Roblox charges what the Developer Product says, not these constants.
		expect(ROBUX_CHEST_PRICE_ROBUX > 0).toBe(true);
		expect(ROBUX_CHEST_BUNDLE_PRICE_ROBUX > 0).toBe(true);
	});
});
