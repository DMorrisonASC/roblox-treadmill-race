import { Rarity } from "shared/economy.config";

/**
 * The two label derivations the tree needs: a ball id as a name, and a tier as a name.
 *
 * ## Why these are here rather than beside each caller
 *
 * They are pure string transformations with exactly one correct answer, and the tree had grown two copies of the ball one
 * already (`shop-controller`'s local `displayName` and a `ballLabel` in `shared/picker.ts`) within a single round of each
 * other. Two copies of a derivation are not two opinions — they are one opinion and one future bug, and the bug is
 * invisible until somebody opens two panels side by side and sees `Bully ball` next to `Bully Ball`.
 *
 * ## What is deliberately not here
 *
 * No display-name table. A table is a second place to update when a ball is added to `BALL_POOL`, and a ball missing from
 * it would render as nothing; derivation from the id cannot fall out of step because the id is the only input. The
 * trade-off is real and accepted: a rename of the id renames the label, so ids must stay human-legible — which they are,
 * and which is why the store's own docblock called them "the honest unit".
 *
 * No pluralisation, no abbreviations, no localisation. Each of those needs a second source of truth, and none is asked
 * for yet.
 */

/** A ball id as a label: `bully_ball` becomes `Bully ball`. */
export function ballName(ballId: string): string {
	const spaced = ballId.gsub("_", " ")[0];
	return `${spaced.upper().sub(1, 1)}${spaced.sub(2)}`;
}

/**
 * A tier as a label: `legendary` becomes `Legendary`.
 *
 * Derived rather than tabled, for the same reason as `ballName`: a map would be a second place to update when `RARITIES`
 * grows, and falling out of step with it is the drift the `Record<Rarity, ...>` in the theme prevents by type.
 */
export function rarityLabel(rarity: Rarity): string {
	return `${rarity.upper().sub(1, 1)}${rarity.sub(2)}`;
}
