/**
 * A 1-based place as English: `1st`, `2nd`, `3rd`, `11th`, `21st`.
 *
 * ## Why the teens are special-cased first
 *
 * The suffix comes from the **last two** digits when they form a teen, and from the last digit otherwise: `11`, `12` and `13`
 * end in `1`, `2` and `3` but take `th`, and so does every number whose last two digits are those. Checking that pair first
 * and returning early is what makes `111th` and `112th` fall out for free instead of needing a third rule.
 *
 * ## Why this is a module and not a line in the controller
 *
 * It is arithmetic with boundaries - `1`, `11`, `21`, `111` - and boundaries are what get "simplified" later. A pure function
 * in `shared` can be pinned by a spec without a DataModel, which is the same argument `apparent-spin` makes for the ball's
 * roll.
 *
 * `n` is floored because a caller can hand this a float, and `% 100` on a non-integer would produce the suffix for a number
 * that is about to be rounded to a different one. Values below `1` are not places; they are rendered as `0th`, which is
 * obviously wrong on screen rather than silently claiming a rank.
 */
export function getOrdinal(rank: number): string {
	const n = math.floor(rank);
	const lastTwo = n % 100;
	if (lastTwo >= 11 && lastTwo <= 13) {
		return `${n}th`;
	}

	const lastOne = n % 10;
	if (lastOne === 1) {
		return `${n}st`;
	}
	if (lastOne === 2) {
		return `${n}nd`;
	}
	if (lastOne === 3) {
		return `${n}rd`;
	}

	return `${n}th`;
}
