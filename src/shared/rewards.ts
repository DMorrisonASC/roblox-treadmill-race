/**
 * The two time-based rewards: when one is due, and what the client is told.
 *
 * ## Why the predicate is a module and not an `if` at the call site
 *
 * Both rewards are **coin grants decided by a clock**, and a clock is the one input this codebase cannot test through a
 * service: `EconomyService` reaches `DataStoreService`, which throws in an unpublished place, so a cooldown written inline
 * is only checkable by waiting fifteen minutes. A coin rule that has never been exercised is a coin rule that mints twice
 * the first time a boundary is wrong.
 *
 * ## Why `RewardToastMessage` lives here rather than beside the remote
 *
 * The remote's file holds names, not payloads (see `shared/remotes.ts`). This is the *shape* of what a reward says, and it
 * is shared by the server that composes it and the client that draws it - so it belongs with the rule that produced it, the
 * way `RoundPayoutMessage` belongs with `round-payout`.
 */

/** What the toast is told to show. Composed on the server, because the server is what decided the amount. */
export interface RewardToastMessage {
	/**
	 * **Sentence case, and the client decides how to set it.** `"Daily Login"`, not `"DAILY LOGIN"`: the payload is a
	 * description of an event, and the panel uppercases it as a typographic choice. A server that shouted would force the
	 * next surface that shows the same event to shout too.
	 */
	readonly label: string;
	/** Coins granted. Always the amount actually added, never the schedule's nominal value. */
	readonly amount: number;
}

/** The label for the once-a-day grant. One string, so the toast and the log cannot describe the same event differently. */
export const DAILY_LOGIN_LABEL = "Daily Login";

/** The label for the per-interval stipend. */
export const PLAYTIME_LABEL = "Playtime";

/**
 * Whether a reward of the given cooldown is due at `now`.
 *
 * ## The `<= 0` case is the migration, not an edge case
 *
 * A profile written before these fields existed has no timestamp at all, and `readStored` fills the gap with `0`. Epoch zero
 * is then "never paid", which is exactly true - `now - 0` would also be true by arithmetic, but only because every real
 * timestamp is larger than the whole cooldown, which is a coincidence rather than a rule. Stated explicitly so a clock that
 * somehow reads small cannot silently mean "pay me".
 *
 * ## A clock that runs backwards does not pay
 *
 * `os.time()` is server wall time; if it is ever corrected backwards, `now - last` goes negative and the comparison is
 * false. That is the safe direction: a missed reward is retried within one cooldown, while a bad comparison pays early
 * every time the clock is nudged.
 */
export function rewardDue(now: number, last: number, cooldownSeconds: number): boolean {
	if (last <= 0) {
		return true;
	}

	return now - last >= cooldownSeconds;
}

/**
 * The playtime clock a session starts with.
 *
 * ## Why loading does not simply trust the stored timestamp
 *
 * The stored value answers "when was this player last paid for playing", and it can be days old. Using it unchanged means a
 * player returning after an absence is paid `PLAYTIME_REWARD_COINS` on the **first tick after joining** - a login bonus
 * wearing a playtime label, arriving in the same second as the actual daily login and paying twice for one arrival.
 *
 * So a stored value that is already past its interval is **moved forward to now**: the reward then means "fifteen minutes of
 * playing", which is what it says. A stored value *inside* the interval is kept, and that is what stops a rejoin from
 * resetting progress toward the next stipend - otherwise leaving and returning every fourteen minutes would pay nothing,
 * every time, forever.
 *
 * The write is in memory only. Nothing is persisted until the next save, and the next load recomputes the same answer, so a
 * session that ends before its first stipend costs nothing and loses nothing.
 */
export function playtimeBaselineAtLoad(now: number, last: number, intervalSeconds: number): number {
	if (last <= 0) {
		return now;
	}

	return now - last >= intervalSeconds ? now : last;
}
