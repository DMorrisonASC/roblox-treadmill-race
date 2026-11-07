import { describe, expect, it } from "@rbxts/jest-globals";
import { DAILY_LOGIN_COOLDOWN_SECONDS, PLAYTIME_REWARD_INTERVAL_SECONDS } from "shared/economy.config";
import { playtimeBaselineAtLoad, rewardDue } from "shared/rewards";

/**
 * The two clock rules behind the time-based rewards: **when a grant is due, and what a session starts its playtime clock at.**
 *
 * ## Why these are asserted rather than read
 *
 * Both decide coin grants, and neither can be exercised through `EconomyService` in this runtime - the service reaches
 * `DataStoreService`, which throws in an unpublished place. The alternative is waiting twenty hours to learn that a boundary
 * is off by one, which in this direction means either paying every join or never paying at all.
 *
 * The one thing this cannot prove is that the *stored* timestamps survive the DataStore; that is `toStored`/`readStored` and
 * is asserted in `reward-schema.spec.ts`.
 */

/** A fixed "now" for every case, so no assertion depends on when the suite runs. */
const NOW = 1_700_000_000;

describe("rewardDue", () => {
	it("pays an account that has never been paid", () => {
		// The migration case: every profile written before these fields existed reads back as `0`.
		expect(rewardDue(NOW, 0, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(true);
	});

	it("does not pay twice inside the cooldown", () => {
		expect(rewardDue(NOW, NOW, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(false);
		expect(rewardDue(NOW, NOW - 1, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(false);
	});

	it("pays exactly on the boundary and past it", () => {
		// `>=`, not `>`. An off-by-one here is a reward that lands a second late forever; it is asserted rather than assumed.
		expect(rewardDue(NOW, NOW - DAILY_LOGIN_COOLDOWN_SECONDS, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(true);
		expect(rewardDue(NOW, NOW - DAILY_LOGIN_COOLDOWN_SECONDS - 1, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(true);
	});

	it("does not pay on a clock that has been corrected backwards", () => {
		// `now - last` is negative. Paying here would pay again on every nudge; the missed reward retries within one cooldown.
		expect(rewardDue(NOW, NOW + 60, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(false);
	});

	it("treats a negative stored value as never paid", () => {
		// Not reachable from `readStored`, which clamps to `0`. Asserted so the rule is total rather than trusting its caller.
		expect(rewardDue(NOW, -5, DAILY_LOGIN_COOLDOWN_SECONDS)).toBe(true);
	});
});

describe("playtimeBaselineAtLoad", () => {
	it("starts a first-ever session now, rather than at the epoch", () => {
		// The bug this exists to prevent: with a stored `0`, the literal condition is already true and a brand-new player is
		// paid a "playtime" bonus in the same second as their daily login - 75 coins for one arrival.
		expect(playtimeBaselineAtLoad(NOW, 0, PLAYTIME_REWARD_INTERVAL_SECONDS)).toBe(NOW);
	});

	it("keeps a recent timestamp, so a rejoin does not reset progress", () => {
		// Fourteen minutes in: the player is one minute from a stipend, and leaving must not send them back to zero.
		const last = NOW - 14 * 60;
		expect(playtimeBaselineAtLoad(NOW, last, PLAYTIME_REWARD_INTERVAL_SECONDS)).toBe(last);
	});

	it("moves a stale timestamp forward, so an absence is not paid as playtime", () => {
		// A player back after a day: the elapsed time was not playing, and the daily login already covers "you returned".
		expect(playtimeBaselineAtLoad(NOW, NOW - 24 * 60 * 60, PLAYTIME_REWARD_INTERVAL_SECONDS)).toBe(NOW);
	});

	it("moves the value forward exactly on the interval boundary", () => {
		expect(
			playtimeBaselineAtLoad(NOW, NOW - PLAYTIME_REWARD_INTERVAL_SECONDS, PLAYTIME_REWARD_INTERVAL_SECONDS),
		).toBe(NOW);
	});
});
