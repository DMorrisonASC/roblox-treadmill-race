/**
 * What a finished round pays, and who earned it.
 *
 * ## Why the rule is a module and not eight lines inside `endPlaying`
 *
 * `RoundService` cannot be constructed in the Jest runtime — its dependencies reach `DataStoreService`, which throws in an
 * unpublished place — so a payout rule written inside `endPlaying` can only be checked by playing a round. `round-outcome`
 * was extracted for exactly this reason, and this is its sequel: the branch that decides *who* won is provable, so the
 * branch that decides *what winning is worth* has to be provable the same way, or half the result stays unasserted.
 *
 * It is `shared/` rather than `server/` because the payload below is one more fact both sides describe: the client draws a
 * progress bar whose full width is the first place's bonus, and a literal `15` on the client would be a second copy of the
 * reward table that nothing compares against the first.
 *
 * ## Two tiers, and why the participation tier is not optional
 *
 * A round that pays nothing for losing teaches a player to stop racing the moment they are behind, which is the opposite of
 * what a race wants. The base rate is paid to every participant regardless of result; the bonus is what makes first worth
 * chasing. `PARTICIPATION_REWARD_COINS` is therefore not a consolation prize that could be tuned to zero — it is the floor
 * that keeps a lost round worth running.
 */

/**
 * **Placeholder.** Coins for turning up: paid to every player who had a competitor on the belt, winner or not.
 *
 * Ten is chosen against the chest's price rather than against the round: a chest is `COIN_CHEST_COST` (100), so a player
 * needs ten clean rounds to buy one, and a first place shortens that to five. Retuning either this or the chest price moves
 * that ratio, which is the number to check before changing this one.
 */
export const PARTICIPATION_REWARD_COINS = 10;

/**
 * **Placeholder.** The performance bonus by placement: `[first, second, third]`. Fourth and beyond earn the base only.
 *
 * ## Why the ladder is `[10, 5, 0]` and not a descending prize for every place
 *
 * Three names, three *different* answers. `[15, 10, 5]` paid the whole paid podium a coin figure above the base rate, which
 * made third place indistinguishable from a lucky fourth once the numbers were on screen: there was no rung where the bonus
 * stopped. This ladder makes the top step worth **double** the base and the third step worth **nothing**, so the shape of the
 * table says what the game values - winning - rather than merely that some places are better than others.
 *
 * It also balances the passive income added beside it. A round now pays 10-20 against a daily login's 50 and a playtime
 * stipend's 25: **playing is still the fastest way to a chest, and not by so much that a session without a win feels
 * pointless.** That is the ratio to preserve if either side is retuned.
 */
export const PLACEMENT_BONUS_COINS: ReadonlyArray<number> = [10, 5, 0];

/**
 * The only fields a payout needs from an owner. `BallOwner` satisfies this structurally, so callers pass their own values
 * and this module never imports the server's type.
 *
 * `userId` is signed in the game's own scheme — synthetic `Debug#N` owners are negative — so `userId > 0` is the whole test
 * for "there is a profile to pay", which is the same test `shared/leaderboard` and `elimination-signal` make.
 */
export interface RoundPayoutOwner {
	readonly userId: number;
	readonly displayName: string;
}

/** One player's result: what they are owed and why. */
export interface RoundPayoutAward {
	readonly userId: number;
	readonly displayName: string;
	/** **1-based** finishing place among every *owned* competitor, including the synthetic debug bodies this player raced. */
	readonly placement: number;
	readonly base: number;
	readonly bonus: number;
	readonly total: number;
}

/**
 * The race as the round recorded it.
 *
 * ## Why three lists and not the live competitor set
 *
 * By the time a round ends, `getCompetitors()` holds **one** body — the winner — because every other competitor has already
 * been destroyed. The participants can only come from a record kept while the round ran, and the order can only come from
 * the sequence in which bodies left. `RoundService` keeps both and hands them over unprocessed; nothing here reads an
 * instance.
 */
export interface RoundPayoutRace {
	/** Every owned competitor that raced, in no particular order. Duplicates are tolerated — see `payoutAwards`. */
	readonly participants: ReadonlyArray<RoundPayoutOwner>;
	/** Competitors in the order they left the belt, **worst first**: the first entry was eliminated first. */
	readonly eliminated: ReadonlyArray<RoundPayoutOwner>;
	/** `undefined` when the round ended with no survivors, which is a definite result and not a missing one. */
	readonly winner: RoundPayoutOwner | undefined;
}

/**
 * The wire payload of one player's payout.
 *
 * ## Why the balances travel with it instead of being read on the client
 *
 * The brief for this feature had the client read `Coins` before and after the grant and derive the roll from the two. It
 * cannot: `grantCoins` publishes the new balance **before** the remote is fired, so by the time the client's handler runs,
 * "before" is gone — and a client that cached the attribute a second earlier would roll from a value that had already moved
 * for some other reason. The two numbers are known for certain in exactly one place, which is the server that changed them.
 */
export interface RoundPayoutMessage {
	readonly base: number;
	readonly bonus: number;
	readonly total: number;
	/** `0` when the round named no winner — see `payoutAwards`. */
	readonly placement: number;
	readonly balanceBefore: number;
	readonly balanceAfter: number;
}

/**
 * The bonus for one finishing place: `0` for anything past the paid podium, and `0` for place `0` (unranked).
 *
 * Total rather than trusting the caller, because `placement` is printed in the log and drawn on the client: a place past the
 * table returning `nil` would print `bonus=nil` and size a progress bar from `nil`, and the two failures would look like
 * different bugs.
 */
export function placementBonus(placement: number): number {
	if (placement < 1) {
		return 0;
	}

	const bonus = PLACEMENT_BONUS_COINS[placement - 1];
	return bonus === undefined ? 0 : bonus;
}

/**
 * Turns one round's record into one award per real player.
 *
 * ## The order, and why it is the reverse of the elimination list
 *
 * A round here is survival, not a sprint: a body is eliminated when it *leaves* the belt, so the first body out finished
 * **last**. Placements are therefore the winner first, then the elimination list read backwards. The winner is prepended
 * rather than appended because the last survivor never appears in the elimination list at all — it is still on the belt when
 * the round ends.
 *
 * ## Why a round with no winner pays no bonus
 *
 * `no survivors` means the last competitors left the belt in the same instant (a `KillY` cull or one spawner cleanup pass).
 * The round publishes `winner=none`, the banner says so, and the alternative here was to promote whichever body the batch
 * loop happened to destroy last into first place — a result the player would be told about in coins and contradicted about
 * on screen. Base only: they turned up, and the race produced no ranking.
 *
 * ## Why `participants` drives the loop and the order only decorates it
 *
 * Every competitor either wins or is eliminated, so the two sets agree today — but they are recorded from different signals
 * (a spawn, a destruction), and a body destroyed by teardown between the two would be in one and not the other. Iterating
 * the spawn record means **every player who raced is paid**, and a missing order entry costs them a bonus rather than the
 * whole award.
 *
 * ## Why duplicates are collapsed to the best place
 *
 * One player normally races one body. The guard exists because the payout is a coin grant: paying twice for one round
 * because two entries share a `userId` — a spawn recorded twice, or a player reconnecting mid-round — is a duplicated
 * reward, which is the failure that costs real economy, where the opposite only under-pays a once-per-round bonus.
 *
 * Synthetic owners (`userId < 0`) occupy their places in the ranking — a `Debug#3` really did finish where it finished —
 * and are then skipped, because there is no profile to pay.
 */
export function payoutAwards(race: RoundPayoutRace): Array<RoundPayoutAward> {
	// Best first: the winner, then the eliminations read backwards.
	//
	// **Only when there is a winner.** A round that ended with no survivors publishes `winner=none`, so it has produced no
	// ranking at all — and a `no survivors` round that still reported `placement=1` would print a place beside a zero bonus
	// and put an ordinal on a panel that the banner says was a race nobody won. Empty here means "unranked for everybody",
	// which `placeOf` and `placementBonus` already handle.
	const ranked = new Array<RoundPayoutOwner>();
	if (race.winner !== undefined) {
		ranked.push(race.winner);

		const lastIndex = race.eliminated.size() - 1;
		for (let index = lastIndex; index >= 0; index--) {
			const owner = race.eliminated[index];
			if (owner !== undefined) {
				ranked.push(owner);
			}
		}
	}

	const awards = new Array<RoundPayoutAward>();
	const paid = new Set<number>();

	for (const participant of race.participants) {
		if (participant.userId <= 0 || paid.has(participant.userId)) {
			continue;
		}
		paid.add(participant.userId);

		const placement = placeOf(ranked, participant.userId);
		const bonus = placement === 0 ? 0 : placementBonus(placement);

		awards.push({
			userId: participant.userId,
			displayName: participant.displayName,
			placement,
			base: PARTICIPATION_REWARD_COINS,
			bonus,
			total: PARTICIPATION_REWARD_COINS + bonus,
		});
	}

	return awards;
}

/** This player's best place in the ranked field, or `0` when the round produced no ranking at all. */
function placeOf(ranked: ReadonlyArray<RoundPayoutOwner>, userId: number): number {
	for (let index = 0; index < ranked.size(); index++) {
		const owner = ranked[index];
		if (owner !== undefined && owner.userId === userId) {
			return index + 1;
		}
	}

	return 0;
}
