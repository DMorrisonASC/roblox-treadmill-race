import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_POOL, encodeOwnedBalls, RARITIES } from "./economy.config";
import { fusionOddsForBall, ownedBallsFrom } from "./inventory";

/**
 * The inventory's ledger rules.
 *
 * Criterion 2 in one sentence: a player who owns nothing sees nothing. The tempting implementation — walk `BALL_POOL`
 * and draw a card per ball — passes every visual check and is wrong, because it lists things the player does not have.
 * These tests assert the input, not the rendering.
 */
function encode(balls: Record<string, number>): string {
	const owned = new Map<string, number>();
	for (const [id, count] of pairs(balls)) {
		owned.set(id, count);
	}

	return encodeOwnedBalls(owned);
}

describe("ownedBallsFrom", () => {
	it("returns nothing for an empty profile", () => {
		expect(ownedBallsFrom("").size()).toBe(0);
	});

	it("returns only the balls that are in the profile", () => {
		// One common and one epic. The other seven pool entries must not appear.
		const balls = ownedBallsFrom(encode({ bully_ball: 2, magnet_ball: 1 }));

		expect(balls.size()).toBe(2);

		const ids = new Array<string>();
		for (const ball of balls) {
			ids.push(ball.id);
		}

		expect(ids.includes("bully_ball")).toBe(true);
		expect(ids.includes("magnet_ball")).toBe(true);

		for (const rarity of RARITIES) {
			for (const poolId of BALL_POOL[rarity]) {
				if (poolId === "bully_ball" || poolId === "magnet_ball") {
					continue;
				}

				expect(ids.includes(poolId)).toBe(false);
			}
		}
	});

	it("carries the owned count, not a constant one", () => {
		const balls = ownedBallsFrom(encode({ bully_ball: 7 }));

		expect(balls.size()).toBe(1);
		expect(balls[0].count).toBe(7);
	});

	it("resolves each ball's rarity", () => {
		const balls = ownedBallsFrom(encode({ bully_ball: 1, recycle_ball: 1 }));

		for (const ball of balls) {
			if (ball.id === "bully_ball") {
				expect(ball.rarity).toBe("common");
			} else {
				expect(ball.rarity).toBe("legendary");
			}
		}
	});

	it("orders by rarity, so the grid is stable between reads", () => {
		const ascending = ownedBallsFrom(encode({ recycle_ball: 1, bully_ball: 1, magnet_ball: 1 }));

		// Common first, legendary last, regardless of the order the ids happen to appear in the attribute.
		expect(ascending[0].rarity).toBe("common");
		expect(ascending[ascending.size() - 1].rarity).toBe("legendary");
	});

	it("drops an id it cannot resolve rather than showing a blank card", () => {
		// A profile from an older build can name a ball this build has never heard of.
		expect(ownedBallsFrom(encode({ not_a_ball: 3 })).size()).toBe(0);
	});

	it("ignores a zero or negative count", () => {
		expect(ownedBallsFrom(encode({ bully_ball: 0 })).size()).toBe(0);
	});
});

describe("fusionOddsForBall", () => {
	it("returns success then fail, summing to 100", () => {
		const odds = fusionOddsForBall("bully_ball");

		expect(odds.size()).toBe(2);
		expect(odds[0].outcome).toBe("success");
		expect(odds[1].outcome).toBe("fail");
		expect(odds[0].percent + odds[1].percent).toBe(100);
	});

	it("returns nothing for a legendary, which cannot be fused", () => {
		expect(fusionOddsForBall("recycle_ball").size()).toBe(0);
	});

	it("returns nothing for a ball it does not know", () => {
		expect(fusionOddsForBall("not_a_ball").size()).toBe(0);
	});
});
