import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_ICON_PREFIX, BALL_ICONS, iconForBall } from "./ball-icon";
import { BALL_POOL, RARITIES, rarityOfBall } from "./economy.config";

/**
 * The icon table's cross-validation, the fifth table a ball id has to survive.
 *
 * ## Why this file exists
 *
 * `ball-tables.spec.ts` refuses a pool id with no power or no model, and `ball-color.spec.ts` refuses one with no colour. A
 * ball with no icon is that same omission, and its failure mode is the quietest of the four: the swatch still draws, still
 * carries the ball's colour, and simply never shows the drawing - so "the icon is missing" and "the icon has not loaded yet"
 * look identical on screen. Nothing in the game can tell them apart; this suite can.
 *
 * **The id-shape case is why this is not another walk inside `ball-tables.spec.ts`.** A colour is a `Color3`, which cannot be
 * misspelled into something that renders; an image id is a *string*, and it can be wrong in three ways that all draw nothing -
 * prefixed twice, not numeric at all, or the same as another ball's. Those are checks on the table's own values rather than on
 * the pool, which is exactly the case `ball-color.spec.ts` makes for living in its own file.
 *
 * ## What this cannot prove
 *
 * That the ten assets exist, are usable by the experience, and are square with a transparent background. Only Studio answers
 * that, and the round's report says so.
 */
describe("ball icons", () => {
	it("resolves an icon for every ball id in BALL_POOL, in every tier", () => {
		let checked = 0;

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				expect(iconForBall(ballId) !== undefined).toBe(true);
				checked++;
			}
		}

		// Non-vacuous by construction - the loop is over the pool - so this is the tripwire for the day a tier is emptied and
		// the assertion above stops running at all.
		expect(checked > 0).toBe(true);
	});

	it("names no ball outside BALL_POOL, and no ball twice", () => {
		const seen = new Set<string>();

		for (const [ballId] of pairs(BALL_ICONS)) {
			// The other direction from the case above: an entry left behind by a renamed id reads as configuration and resolves
			// to a drawing no body can ever be.
			expect(rarityOfBall(ballId) !== undefined).toBe(true);
			expect(seen.has(ballId)).toBe(false);
			seen.add(ballId);
		}

		// Stated as a count as well, so "the table lost a row" and "the pool gained one" both fail loudly.
		let poolSize = 0;
		for (const rarity of RARITIES) {
			poolSize += BALL_POOL[rarity].size();
		}

		expect(seen.size()).toBe(poolSize);
	});

	it("stores every id as a bare decimal, so no id can carry the prefix twice", () => {
		for (const [ballId, id] of pairs(BALL_ICONS)) {
			const parsed = tonumber(id);

			// A prefixed id is not a number at all; a leading zero, a stray space or a decimal point survives `tonumber` but not
			// the round trip. Both draw nothing once `iconForBall` has added a prefix, and neither is visible in a screenshot.
			expect(parsed !== undefined).toBe(true);
			expect(tostring(parsed) === id).toBe(true);
			expect(ballId !== "").toBe(true);
		}
	});

	it("gives every ball an id no other ball has", () => {
		const seen = new Set<string>();

		for (const [, id] of pairs(BALL_ICONS)) {
			expect(seen.has(id)).toBe(false);
			seen.add(id);
		}
	});

	it("returns the prefixed uri for every ball", () => {
		for (const [ballId, id] of pairs(BALL_ICONS)) {
			expect(iconForBall(ballId)).toBe(`${BALL_ICON_PREFIX}${id}`);
		}
	});

	it("answers undefined for a ball id the table does not have", () => {
		expect(iconForBall("unknown_id")).toBeUndefined();
	});
});
