import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_COLORS, colorForBall } from "./ball-color";
import { BALL_POOL, RARITIES, rarityOfBall } from "./economy.config";

/**
 * The colour table's cross-validation, the fourth table a ball id has to survive.
 *
 * ## Why this file exists
 *
 * `ball-tables.spec.ts` already refuses a ball id that is in `BALL_POOL` and missing a power or a model. A ball missing a
 * colour is the *same* omission with a worse failure mode than either: no power means the ball plays dull, no model means it
 * looks like every other ball, and **no colour means it looks like every other ball too - but the table still claims to have
 * ten**. That claim is what this suite checks, because nothing in the game can: `colorForBall` answers `undefined` and the
 * spawner silently paints the fallback, which is exactly the "configured but inert" shape this tree keeps having to remove.
 *
 * **The other direction matters as much.** An entry naming a ball the pool does not have is an orphan: it resolves to a
 * colour no body can ever be, and a renamed id leaves one behind that reads as configuration.
 *
 * ## The distinctness check, and what it can and cannot prove
 *
 * Two balls sharing a `Color3` is a real defect - the whole point of the table is that ten balls look like ten balls - so
 * equality is a hard check. **Luminance is compared as well, because a phone at 300 studs discriminates by value far better
 * than by hue**: two colours of equal lightness read as one ball even when their hues differ. It is asserted at a floor
 * rather than a target, because a floor is what a future addition can be held to.
 */
describe("ball colours", () => {
	it("resolves a colour for every ball id in BALL_POOL, in every tier", () => {
		let checked = 0;

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				const color = colorForBall(ballId);
				expect(color !== undefined).toBe(true);
				checked++;
			}
		}

		// Non-vacuous by construction - the loop is over the pool - so this is the tripwire for the day a tier is emptied and
		// the assertions above stop running at all.
		expect(checked > 0).toBe(true);
	});

	it("gives every ball a colour no other ball has", () => {
		const seen = new Set<string>();

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				const color = colorForBall(ballId);
				if (color === undefined) {
					// Reported by the previous case; skipping here keeps this one about duplicates rather than repeating a
					// failure the reader has already been told about.
					continue;
				}

				// `ToHex` rather than the `Color3` itself: `toBe` on a userdata compares identity in some runtimes, so two
				// separately-constructed equal colours could pass as distinct - the one thing this case exists to catch.
				const key = color.ToHex();
				expect(seen.has(key)).toBe(false);
				seen.add(key);
			}
		}
	});

	it("names no ball outside BALL_POOL", () => {
		for (const [ballId] of pairs(BALL_COLORS)) {
			expect(rarityOfBall(ballId) !== undefined).toBe(true);
		}
	});

	it("separates the ten colours by luminance as well as by hue", () => {
		// Rec. 709 luma coefficients, the same weighting `Color3`'s own perception uses closely enough for a floor test.
		const luma = (color: Color3) => 0.2126 * color.R + 0.7152 * color.G + 0.0722 * color.B;

		const values = new Array<number>();
		for (const [, color] of pairs(BALL_COLORS)) {
			values.push(luma(color));
		}

		let closest = math.huge;
		for (let i = 0; i < values.size(); i++) {
			for (let j = i + 1; j < values.size(); j++) {
				const a = values[i];
				const b = values[j];
				if (a !== undefined && b !== undefined) {
					closest = math.min(closest, math.abs(a - b));
				}
			}
		}

		// `0.03` of full scale, i.e. about 8 of 255. Below that two balls read as the same value on a phone and only the hue
		// separates them, which is the case this floor exists to refuse. At the values shipped the closest pair is roughly
		// `0.032` (bouncy_ball green against recycle_ball cyan), so the margin is thin by design - a retune of either should
		// move them further apart, not closer.
		expect(closest >= 0.03).toBe(true);
	});

	it("answers undefined for a ball id the table does not have", () => {
		expect(colorForBall("unknown_id")).toBeUndefined();
	});
});
