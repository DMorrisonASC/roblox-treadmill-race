import { describe, expect, it } from "@rbxts/jest-globals";
import {
	PARTICIPATION_REWARD_COINS,
	PLACEMENT_BONUS_COINS,
	placementBonus,
	payoutAwards,
	RoundPayoutAward,
	RoundPayoutOwner,
	RoundPayoutRace,
} from "shared/round-payout";

/**
 * The payout rule: **base to everybody who raced, the podium bonus to the top three, nothing for a round that ranked nobody.**
 *
 * ## Why this file exists
 *
 * The rule decides how many coins a player receives, and the only other way to check it is to play a round to completion —
 * the same argument `round-outcome.spec.ts` makes, and the reason that rule was extracted. What cannot be proved here, and
 * is listed as a Studio observation in the round report, is *what the round records*: the participant list and the
 * elimination order are produced by `RoundService` from instance signals and cannot be built in this runtime.
 */

/** **Placeholder.** An owner pair, built literally: a spec cannot construct a `Player`, and should not need to. */
function owner(userId: number, displayName: string): RoundPayoutOwner {
	return { userId, displayName };
}

const first = owner(1, "First");
const second = owner(2, "Second");
const third = owner(3, "Third");
const fourth = owner(4, "Fourth");

/** The race as `RoundService` records it: who raced, who left in what order, and who survived. */
function race(
	participants: ReadonlyArray<RoundPayoutOwner>,
	eliminated: ReadonlyArray<RoundPayoutOwner>,
	winner: RoundPayoutOwner | undefined,
): RoundPayoutRace {
	return { participants, eliminated, winner };
}

/** The awards keyed by user id, so an assertion names a player instead of an array index. */
function byUser(awards: ReadonlyArray<RoundPayoutAward>): Map<number, RoundPayoutAward> {
	const map = new Map<number, RoundPayoutAward>();
	for (const award of awards) {
		map.set(award.userId, award);
	}
	return map;
}

/** A missing award reads as `-1`, so a broken lookup fails an assertion instead of silently comparing `nil`. */
function placeIn(awards: ReadonlyArray<RoundPayoutAward>, userId: number): number {
	const award = byUser(awards).get(userId);
	return award === undefined ? -1 : award.placement;
}

function totalIn(awards: ReadonlyArray<RoundPayoutAward>, userId: number): number {
	const award = byUser(awards).get(userId);
	return award === undefined ? -1 : award.total;
}

function bonusIn(awards: ReadonlyArray<RoundPayoutAward>, userId: number): number {
	const award = byUser(awards).get(userId);
	return award === undefined ? -1 : award.bonus;
}

describe("placementBonus", () => {
	it("pays the table for the paid places", () => {
		expect(placementBonus(1)).toBe(PLACEMENT_BONUS_COINS[0]);
		expect(placementBonus(2)).toBe(PLACEMENT_BONUS_COINS[1]);
		expect(placementBonus(3)).toBe(PLACEMENT_BONUS_COINS[2]);
	});

	it("pays nothing for third, which is the rung the ladder was retuned to remove", () => {
		// The tuned table is `[10, 5, 0]`: the third step is deliberately worth nothing, so a third place and a fourth place
		// differ by a place and not by coins. Asserted as a literal rather than against the table, because a table-only
		// assertion would pass just as happily if the row went back to `5`.
		expect(PLACEMENT_BONUS_COINS.size()).toBe(3);
		expect(placementBonus(1)).toBe(10);
		expect(placementBonus(2)).toBe(5);
		expect(placementBonus(3)).toBe(0);
	});

	it("pays nothing past the podium", () => {
		expect(placementBonus(4)).toBe(0);
		expect(placementBonus(17)).toBe(0);
	});

	it("pays nothing for an unranked result", () => {
		// `0` is what `payoutAwards` uses for "this round ranked nobody", and a place past the table must not be `nil`:
		// `bonus=nil` in the log and a progress bar sized from `nil` would be two different bugs.
		expect(placementBonus(0)).toBe(0);
		expect(placementBonus(-1)).toBe(0);
	});
});

describe("payoutAwards", () => {
	it("pays the winner the base plus first place", () => {
		// Criterion 2: 1st gets 10 + 10.
		const awards = payoutAwards(race([first], [], first));

		expect(placeIn(awards, 1)).toBe(1);
		expect(bonusIn(awards, 1)).toBe(10);
		expect(totalIn(awards, 1)).toBe(20);
	});

	it("reads the elimination list backwards, because the first body out finished last", () => {
		// Participants deliberately in the wrong order: the ranking comes from the elimination record, not the spawn record.
		const awards = payoutAwards(race([fourth, third, second, first], [fourth, third, second], first));

		expect(placeIn(awards, 1)).toBe(1);
		expect(placeIn(awards, 2)).toBe(2);
		expect(placeIn(awards, 3)).toBe(3);
		expect(placeIn(awards, 4)).toBe(4);
	});

	it("pays the whole field the base rate, and only the top two the bonus", () => {
		// Criterion 1: every competitor gets at least 10.
		const awards = payoutAwards(race([first, second, third, fourth], [fourth, third, second], first));

		expect(totalIn(awards, 1)).toBe(20);
		expect(totalIn(awards, 2)).toBe(15);
		expect(totalIn(awards, 3)).toBe(PARTICIPATION_REWARD_COINS);
		expect(totalIn(awards, 4)).toBe(PARTICIPATION_REWARD_COINS);
		expect(bonusIn(awards, 3)).toBe(0);
		expect(bonusIn(awards, 4)).toBe(0);
	});

	it("pays base only when the round named no winner", () => {
		// `no survivors`: two bodies left the belt in the same instant. Promoting whichever the batch loop destroyed last
		// into first place would pay a bonus the banner contradicts.
		const awards = payoutAwards(race([first, second], [second, first], undefined));

		expect(awards.size()).toBe(2);
		for (const award of awards) {
			expect(award.placement).toBe(0);
			expect(award.bonus).toBe(0);
			expect(award.total).toBe(PARTICIPATION_REWARD_COINS);
		}
	});

	it("pays a participant the base even when the round never recorded a place for them", () => {
		// A body lost to teardown between the two records: in the spawn record and not in the elimination one. The player
		// turned up, so they are paid; the missing place costs the bonus, not the award.
		const stray = owner(9, "Stray");
		const awards = payoutAwards(race([first, stray], [], first));

		expect(totalIn(awards, 9)).toBe(PARTICIPATION_REWARD_COINS);
		expect(placeIn(awards, 9)).toBe(0);
	});

	it("skips synthetic owners but keeps the places they occupy", () => {
		// A debug body really did finish second, so the human behind it is third. Paying the bot is impossible - there is no
		// profile - and renumbering the humans to close the gap would report a race that did not happen.
		const bot = owner(-2, "Debug#2");
		const awards = payoutAwards(race([first, bot, third], [third, bot], first));

		expect(placeIn(awards, -2)).toBe(-1);
		expect(placeIn(awards, 1)).toBe(1);
		expect(placeIn(awards, 3)).toBe(3);
		// Third place is on the base rate now, so the *place* is what this asserts rather than a bonus the tuned table no
		// longer pays - the synthetic-owner rule is about the numbering, not about the rungs.
		expect(totalIn(awards, 3)).toBe(PARTICIPATION_REWARD_COINS);
	});

	it("pays a duplicated participant once", () => {
		// A spawn recorded twice must not become two grants: a duplicated reward costs the economy, where under-paying a
		// once-per-round bonus only costs a bonus.
		expect(payoutAwards(race([first, first], [first], undefined)).size()).toBe(1);
	});

	it("pays nobody when nobody raced", () => {
		expect(payoutAwards(race([], [], undefined)).size()).toBe(0);
	});

	it("ranks a capped round's survivors between the winner and the fallen (item 208)", () => {
		// **The case the cap creates and elimination-only ranking cannot express.** Two survivors were still racing when the
		// clock ran out, so neither fell and the derived order knows nothing about them: without `survivors` both would be
		// `placement = 0` (base only) while an already-eliminated body collected second place - the opposite of "rewarded by
		// position". Read best-first, so `second` is ahead of `third`.
		const first = owner(1, "first");
		const second = owner(2, "second");
		const third = owner(3, "third");
		const fallen = owner(4, "fallen");

		const capped = payoutAwards({
			participants: [first, second, third, fallen],
			eliminated: [fallen],
			winner: first,
			survivors: [second, third],
		});
		const places = byUser(capped);

		expect(places.get(1)?.placement).toBe(1);
		expect(places.get(2)?.placement).toBe(2);
		expect(places.get(3)?.placement).toBe(3);
		// The body that actually left the belt is behind every survivor, however long ago it fell.
		expect(places.get(4)?.placement).toBe(4);
	});

	it("changes nothing on a natural end when survivors is absent", () => {
		// The additive guarantee: an elimination-ended round passes no `survivors`, and the ranking there is
		// `winner ++ reversed(eliminated)` - untouched by the cap's new field.
		const winner = owner(1, "winner");
		const firstOut = owner(2, "first out");
		const lastOut = owner(3, "last out");
		const natural = payoutAwards(race([winner, firstOut, lastOut], [firstOut, lastOut], winner));
		const places = byUser(natural);

		expect(places.get(1)?.placement).toBe(1);
		// Last eliminated takes second; first eliminated takes third.
		expect(places.get(3)?.placement).toBe(2);
		expect(places.get(2)?.placement).toBe(3);
	});

	it("does not double-count a winner listed in survivors", () => {
		// `RoundService` builds the survivor list without the winner, but the rule must not depend on that: a caller that
		// included it would otherwise push the winner twice and shift every place below it.
		const first = owner(1, "first");
		const second = owner(2, "second");
		const awards = byUser(
			payoutAwards({ participants: [first, second], eliminated: [], winner: first, survivors: [first, second] }),
		);

		expect(awards.get(1)?.placement).toBe(1);
		expect(awards.get(2)?.placement).toBe(2);
	});
});
