import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_POOL, RARITIES, rarityOfBall } from "./economy.config";
import { BALL_MODELS, modelEntryForBallId } from "./models.config";
import { powerForBallId } from "./powers.config";

/**
 * The cross-validation every ball id has to survive.
 *
 * ## Why this file exists
 *
 * Three tables now describe a ball, and until this round two of them had no cross-check at all: an id could be added to
 * `BALL_POOL` and forgotten in `powers.config.ts` with no failure anywhere. A ball with no power is the defect item 74
 * removed; a ball with no model is worse in one way, because the body still spawns, still races, and simply looks like
 * every other ball — the omission is invisible in a Studio session and only shows up as "why does this one not look
 * like the art".
 *
 * **Anything added to the pool without a power or a model now fails here**, and so does a table entry naming a ball the
 * pool does not have — the second direction matters because a renamed id would otherwise leave an orphan entry that
 * resolves to nothing and reads as configuration.
 *
 * ## What this cannot prove
 *
 * That a model is *loaded* — the table is a declaration and nothing reads it yet. That is the point: this round makes the
 * omission loud, and the swap is a later round's work.
 */
describe("ball tables", () => {
	it("resolves a pool entry, a power and a model entry for every ball id, in one pass", () => {
		let checked = 0;

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				// The pool lookup itself: an id in a tier has to resolve back to that tier, or `rarityOfBall` — which the
				// inventory, the picker and the fusion path all use — is walking a table it disagrees with.
				expect(rarityOfBall(ballId)).toBe(rarity);

				expect(powerForBallId(ballId) !== undefined).toBe(true);
				expect(modelEntryForBallId(ballId) !== undefined).toBe(true);

				checked++;
			}
		}

		// The loop is over `BALL_POOL`, so it is non-vacuous by construction; this is the tripwire for the day somebody
		// empties a tier and the three assertions above stop running at all.
		expect(checked > 0).toBe(true);
	});

	it("has no model entry for a ball outside BALL_POOL, and exactly one per ball", () => {
		const seen = new Set<string>();
		let poolSize = 0;

		for (const rarity of RARITIES) {
			poolSize += BALL_POOL[rarity].size();
		}

		for (const entry of BALL_MODELS) {
			expect(rarityOfBall(entry.ballId) !== undefined).toBe(true);
			expect(seen.has(entry.ballId)).toBe(false);
			seen.add(entry.ballId);

			// `undefined` means "this ball is still its sphere", which is the shipped state. Asserted as a *shape* rather
			// than as a value, so the day an asset lands this line keeps passing.
			expect(entry.model === undefined || entry.model.assetId !== undefined).toBe(true);
		}

		// One entry per ball, computed from the pool rather than typed in: the pair of loops above already implies it, and
		// stating the count makes "the table grew a stale row" and "the table lost a row" both fail loudly.
		expect(BALL_MODELS.size()).toBe(poolSize);
	});
});
