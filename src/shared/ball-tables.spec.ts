import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_POOL, RARITIES, rarityOfBall } from "./economy.config";
import { BALL_MODELS, modelEntryForBallId } from "./models.config";
import { describeBallPower, POWERS, powerForBallId } from "./powers.config";

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

/**
 * The power descriptions, which became player-facing text in item 230 when the inventory's detail pane started rendering them.
 *
 * ## Why these are asserted here and not in a new file
 *
 * The three tables that describe a ball are already cross-checked in this file, and a description is the fourth thing a ball id
 * has to survive. A separate file would be a second place to look for "did a ball get added properly".
 *
 * ## What the sentence cap is really protecting
 *
 * The detail pane is one fixed-width column in a fixed-height row, so a description's length is a *layout* fact, not a style
 * preference - which is why it is a failing test rather than a review note. Three sentences at `body2` is what the row was sized
 * for; a fourth would push the pane's hint under the sheet's clip.
 *
 * **The count is deliberately crude**: a period, exclamation or question mark followed by a space, plus one. That mis-counts
 * an abbreviation and a decimal, and it is still the right test - it fails on a string that has grown a paragraph, which is
 * the only failure mode worth catching, and a stricter parser would be more machinery than the rule deserves.
 */
/**
 * Sentences in a description: a `.`, `!` or `?` that ends the string or is followed by a space, plus one.
 *
 * **Written as a character walk rather than with `string.find`, and that is not style.** In Luau, `find`'s first argument is a
 * **pattern**, so searching for `". "` means "any character followed by a space" - which counts every word boundary and fails
 * every description in the table. The first version of this test did exactly that. A walk has no pattern engine to escape and
 * says what the rule is.
 *
 * **Crude on purpose.** It over-counts `e.g.` and `3.5`, and that is the right trade: the failure it exists to catch is a
 * description that grew into a paragraph, and a stricter parser would be more machinery than the rule deserves.
 */
function countSentences(text: string): number {
	let sentences = 1;

	for (let index = 0; index < text.size(); index++) {
		const character = text.sub(index, index + 1);
		if (character !== "." && character !== "!" && character !== "?") {
			continue;
		}

		const trailing = text.sub(index + 1, index + 2);
		if (trailing === "" || trailing === " ") {
			sentences++;
		}
	}

	return sentences;
}

describe("power descriptions", () => {
	it("gives every power a non-empty description", () => {
		for (const definition of POWERS) {
			expect(definition.effect.size() > 0).toBe(true);
		}
	});

	it("keeps every description to three sentences or fewer", () => {
		for (const definition of POWERS) {
			const sentences = countSentences(definition.effect);

			if (sentences > 3) {
				// Named so a failure says which string grew rather than only that one did.
				print(`[spec] description too long (${sentences} sentences): ${definition.ballId}`);
			}

			expect(sentences <= 3).toBe(true);
		}
	});

	it("describes every ball in the pool", () => {
		let checked = 0;

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				expect(describeBallPower(ballId).size() > 0).toBe(true);
				checked++;
			}
		}

		// Non-vacuous: the loop is over the pool, so this is the tripwire for an emptied tier.
		expect(checked > 0).toBe(true);
	});

	it("answers an empty string for a ball it cannot describe", () => {
		// The real cases this covers: a body with no `ChosenBallId`, a profile id written by an older build, and a ball added to
		// `BALL_POOL` before its `POWERS` row exists. An empty string is what lets the label collapse instead of drawing
		// placeholder prose about a ball that has no power.
		expect(describeBallPower("unknown_id")).toBe("");
	});
});
