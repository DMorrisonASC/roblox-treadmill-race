import { decodeOwnedBalls, Rarity, rarityOfBall } from "./economy.config";
import { FusionOdd, fusionOdds } from "./odds";

/**
 * What the inventory is allowed to show, derived from the profile rather than from the catalogue.
 *
 * ## Why this exists as a pure module
 *
 * The single most likely way to get the inventory wrong is to build it like the store: enumerate `BALL_POOL` and draw a
 * card per ball. That produces a shop that looks like a collection, listing balls the player does not own. The two look
 * identical on screen and differ only in where the list comes from, so the distinction is worth a function that has one
 * input — the `OwnedBalls` attribute — and cannot reach the pool at all.
 *
 * It is also the only part of the inventory that can be tested without a UI, which is why it is here and not inside the
 * controller.
 */

/** One ball the player owns, resolved against the pool. */
export interface OwnedBall {
	id: string;
	rarity: Rarity;
	count: number;
}

/**
 * The player's balls, in `RARITIES` order then alphabetically, from the encoded `OwnedBalls` attribute.
 *
 * ## Why an unknown id is dropped rather than shown
 *
 * A profile written by an older build can name a ball this build no longer has. There is no rarity to tint it with, no
 * name to show, and no way to fuse it — a card for it would be a blank rectangle the player cannot act on and cannot
 * remove. Dropping it keeps the ledger honest about what it can explain; the ball itself is still in the profile and
 * still counted, just not rendered.
 *
 * ## Why the order is fixed
 *
 * Rarity descending-to-ascending rather than insertion order, so the grid is stable between two reads of the same
 * profile. An attribute write that only reordered would otherwise look like a change and rebuild the whole grid.
 */
export function ownedBallsFrom(encoded: string): Array<OwnedBall> {
	const owned = decodeOwnedBalls(encoded);

	const balls = new Array<OwnedBall>();
	for (const [id, count] of owned) {
		const rarity = rarityOfBall(id);
		if (rarity === undefined || count <= 0) {
			continue;
		}

		balls.push({ id, rarity, count });
	}

	for (let index = 1; index < balls.size(); index++) {
		const value = balls[index];
		let insertIndex = index;
		while (insertIndex > 0) {
			const previous = balls[insertIndex - 1];
			if (previous.rarity === value.rarity) {
				if (previous.id < value.id) {
					break;
				}
			} else if (rarityRank(previous.rarity) <= rarityRank(value.rarity)) {
				break;
			}

			balls[insertIndex] = previous;
			insertIndex--;
		}
		balls[insertIndex] = value;
	}

	return balls;
}

/** A tier's position in `RARITIES`, for sorting. Local because the union is ordered and this is the only reader. */
function rarityRank(rarity: Rarity): number {
	if (rarity === "common") {
		return 0;
	}
	if (rarity === "rare") {
		return 1;
	}
	if (rarity === "epic") {
		return 2;
	}

	return 3;
}

/**
 * The fusion odds for a ball, or `[]` when it cannot be fused.
 *
 * A thin wrapper on purpose: the point is that the display **calls** `fusionOdds` rather than carrying a copy of the
 * percentages, so retuning `FUSION_TABLE` moves the UI without touching it. An unknown ball and a legendary both come
 * back empty, which is the same answer the server gives when it refuses either.
 */
export function fusionOddsForBall(ballId: string): Array<FusionOdd> {
	const rarity = rarityOfBall(ballId);
	if (rarity === undefined) {
		return [];
	}

	return fusionOdds(rarity);
}
