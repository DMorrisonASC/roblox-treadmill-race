import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_POOL, RARITIES, rarityOfBall } from "./economy.config";
import { BALL_MODELS, modelEntryForBallId, modelTemplateNameFor } from "./models.config";
import { describeBallPower, POWERS, powerForBallId } from "./powers.config";

/**
 * The table's naming convention, derived **here in the spec** rather than imported from the config.
 *
 * That is the whole value of this helper: `models.config.ts` holds ten template names as literals, so a test that asked the
 * config how to spell `bully_ball` would be comparing an implementation with itself. Deriving the expected name in the test
 * file makes a typo in the table (`bullyball`, `BullyBall`, `bullyBalll`) a suite failure instead of a ball that draws its
 * sphere in silence.
 *
 * Only the shape this table actually uses is handled: a `snake_case` word list whose first word is untouched and whose later
 * words are capitalised. A single-word id passes through unchanged, which is `camelCase`'s own rule.
 */
function camelCaseOf(ballId: string): string {
	let out = "";
	let capitaliseNext = false;

	for (const character of ballId.split("")) {
		if (character === "_") {
			capitaliseNext = true;
		} else if (capitaliseNext) {
			out += string.upper(character);
			capitaliseNext = false;
		} else {
			out += character;
		}
	}

	return out;
}

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
 * That a template *exists in the scene*. The table is a declaration and the lookup is `ServerStorage`'s at spawn, so this
 * spec proves that every ball id has a name and that the name follows the convention — it cannot prove that
 * `ServerStorage.BallModels` has an Instance called `bullyBall`. That is what the spawner's boot-time layout check and its
 * per-id warning are for, and the reason both exist rather than being left to this file.
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
				// **And the template name, not just the entry** (item 242). An entry with `model: undefined` passes every other
				// line in this loop, which is exactly the hole the model swap had to close: the body spawns, races, and simply
				// looks like every other ball.
				expect(modelTemplateNameFor(ballId) !== undefined).toBe(true);

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

			// **A model whose name is the camelCase of its id** (item 242). The value is asserted, not merely its presence:
			// `templateName` is a hand-authored Instance name, so a typo is a ball that draws nothing, and the only place a
			// typo can be caught without Studio is a derivation stated independently of the table.
			expect(entry.model === undefined || entry.model.templateName === camelCaseOf(entry.ballId)).toBe(true);
		}

		// One entry per ball, computed from the pool rather than typed in: the pair of loops above already implies it, and
		// stating the count makes "the table grew a stale row" and "the table lost a row" both fail loudly.
		expect(BALL_MODELS.size()).toBe(poolSize);
	});

	it("names every template in camelCase, and answers nothing for a ball it does not describe", () => {
		// The **naming asymmetry** the config documents: the id is `snake_case` data, the template is a `camelCase` Instance
		// name. Asserted as a shape as well as a value, because "camelCase" is the half a reader will be tempted to normalise:
		// a template with an underscore in it would still pass an equality check against a mis-derived name, and would then be
		// an Instance name in the Explorer that no `Instance.Name` convention in this tree produces.
		for (const entry of BALL_MODELS) {
			const name = entry.model === undefined ? undefined : entry.model.templateName;
			if (name === undefined) {
				continue;
			}

			// A character walk, for `countSentences`' reason below: no pattern engine to escape, and no risk of a metacharacter
			// turning a substring test into something else.
			let hasSeparator = false;
			for (let index = 0; index < name.size(); index++) {
				if (name.sub(index, index + 1) === "_") {
					hasSeparator = true;
				}
			}

			expect(hasSeparator).toBe(false);
			expect(name !== string.lower(name)).toBe(true);
		}

		// **`undefined`, never a default** (item 242). A function that answered the first template would make a missing entry
		// indistinguishable from a working one — the ball would wear somebody else's art and no log line would say so.
		expect(modelTemplateNameFor("unknown_id")).toBe(undefined);
		expect(modelTemplateNameFor("")).toBe(undefined);
		expect(modelEntryForBallId("unknown_id")).toBe(undefined);

		// A known id resolves, so the two assertions above are not "this function always answers `undefined`".
		expect(modelTemplateNameFor("bully_ball")).toBe("bullyBall");
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
