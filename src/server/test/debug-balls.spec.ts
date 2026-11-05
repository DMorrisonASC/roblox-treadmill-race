import { describe, expect, it } from "@rbxts/jest-globals";
import { rarityOfBall } from "shared/economy.config";
import { allBallIds, pickDistinctBallIds, RandomSource } from "../debug-balls";

/**
 * The debug spawn's draw.
 *
 * ## Why this is testable at all
 *
 * The random source is a parameter, so a spec can drive exact draws instead of asserting "it returned four strings". The
 * two properties that matter are the ones a `math.random`-calling implementation could not be held to: **distinct within
 * one press**, and **termination for any count**. The second is why the draw is a partial Fisher-Yates rather than
 * "draw and reject duplicates" — a rejecting loop against a source that keeps returning a duplicate has no bound.
 *
 * ## What this cannot prove
 *
 * That four distinct bodies appear on the belt with visible powers: the ids are one thing and `spawnBall` carrying them
 * through `setPower` into a `Power` attribute, a badge and a collision group is another. That is a Studio observation.
 */

/** A Lehmer LCG: deterministic, seeded, and small enough that no product exceeds 2^47 (so no float precision is lost). */
function seeded(seed: number): RandomSource {
	let state = seed % 2147483647;
	if (state <= 0) {
		state += 2147483646;
	}

	return () => {
		state = (state * 48271) % 2147483647;
		return (state - 1) / 2147483646;
	};
}

/** A source that always returns the same value, for the worst case of the draw. */
function constant(value: number): RandomSource {
	return () => value;
}

describe("allBallIds", () => {
	it("returns every ball id in the pool exactly once", () => {
		const ids = allBallIds();
		const seen = new Set<string>();

		for (const ballId of ids) {
			expect(seen.has(ballId)).toBe(false);
			seen.add(ballId);
			expect(rarityOfBall(ballId) !== undefined).toBe(true);
		}
	});
});

describe("pickDistinctBallIds", () => {
	it("returns exactly the count asked for", () => {
		for (let count = 0; count <= 10; count++) {
			expect(pickDistinctBallIds(count, seeded(7 + count)).size()).toBe(count);
		}
	});

	it("returns distinct ids for every count within the pool, across many seeds", () => {
		const poolSize = allBallIds().size();

		for (let seed = 1; seed <= 40; seed++) {
			for (let count = 1; count <= poolSize; count++) {
				const ids = pickDistinctBallIds(count, seeded(seed * 31 + count));
				const seen = new Set<string>();

				expect(ids.size()).toBe(count);
				for (const ballId of ids) {
					expect(seen.has(ballId)).toBe(false);
					seen.add(ballId);
				}
			}
		}
	});

	it("returns distinct ids even when the source cannot advance", () => {
		// The worst case for "draw and reject duplicates": a source pinned at 0. Removal from the deck is what makes this
		// terminate with distinct ids rather than loop forever on the same slot.
		const ids = pickDistinctBallIds(4, constant(0));
		const seen = new Set<string>();

		expect(ids.size()).toBe(4);
		for (const ballId of ids) {
			expect(seen.has(ballId)).toBe(false);
			seen.add(ballId);
		}
	});

	it("draws the whole pool when asked for it, in some order", () => {
		const ids = pickDistinctBallIds(allBallIds().size(), seeded(3));
		const seen = new Set<string>();

		for (const ballId of ids) {
			seen.add(ballId);
		}

		expect(seen.size()).toBe(allBallIds().size());
	});

	it("allows repeats rather than looping forever when count exceeds the pool", () => {
		const poolSize = allBallIds().size();
		const ids = pickDistinctBallIds(poolSize + 4, seeded(11));

		// Total, not truncated: the function is asked for 14 and answers 14.
		expect(ids.size()).toBe(poolSize + 4);

		// The first pass through the deck is still distinct — repeats only begin once it is exhausted.
		const firstPass = new Set<string>();
		for (let index = 0; index < poolSize; index++) {
			firstPass.add(ids[index]);
		}
		expect(firstPass.size()).toBe(poolSize);

		// And every id, repeats included, is a real ball.
		for (const ballId of ids) {
			expect(rarityOfBall(ballId) !== undefined).toBe(true);
		}
	});

	it("only ever returns ids that the pool knows", () => {
		for (let seed = 1; seed <= 20; seed++) {
			for (const ballId of pickDistinctBallIds(6, seeded(seed))) {
				expect(rarityOfBall(ballId) !== undefined).toBe(true);
			}
		}
	});

	it("treats a count of zero, a negative count and a fraction as the nearest sensible answer", () => {
		expect(pickDistinctBallIds(0, seeded(1)).size()).toBe(0);
		expect(pickDistinctBallIds(-3, seeded(1)).size()).toBe(0);
		expect(pickDistinctBallIds(2.9, seeded(1)).size()).toBe(2);
	});

	it("stays in range even if the source breaks its contract", () => {
		// `math.random` is `[0, 1)`, but the source is a parameter: a `1` must clamp into the deck rather than index past
		// the end and push `undefined` into the result.
		const ids = pickDistinctBallIds(4, constant(1));

		expect(ids.size()).toBe(4);
		for (const ballId of ids) {
			expect(rarityOfBall(ballId) !== undefined).toBe(true);
		}
	});
});
