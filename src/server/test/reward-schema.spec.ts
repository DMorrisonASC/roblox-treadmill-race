import { describe, expect, it } from "@rbxts/jest-globals";
import { Profile, readStored, SCHEMA_VERSION, toStored } from "../services/player-data-store";

/**
 * The reward timestamps' trip through the store: **absent reads as `0`, and a written profile keeps what it was given.**
 *
 * ## The failure this is aimed at is the write path, not the read
 *
 * `readStored` defaulting a missing key is the obvious half, and it is wrong only in the harmless direction (one reward
 * arrives early for an account that predates the feature). The expensive half is `toStored`: a save constructs the stored
 * value from scratch, so a field it forgets is **erased on every save**. A forgotten timestamp would not look like a bug at
 * all - the daily login would simply pay again after any round, any chest, any admin command - which is why the round trip
 * is asserted here rather than inferred from the two literals agreeing.
 *
 * `release`'s rebuild is the same obligation and cannot be asserted: it runs inside an `UpdateAsync` transform, and the store
 * requires a live DataStore. It is listed as a Studio observation in the round report.
 */

/** A profile as the in-memory type wants it, with both stamps set. */
function profile(lastDailyRewardAt: number, lastPlaytimeRewardAt: number): Profile {
	return {
		version: SCHEMA_VERSION,
		coins: 250,
		ownedBalls: new Map(),
		purchases: [],
		lastDailyRewardAt,
		lastPlaytimeRewardAt,
	};
}

describe("reward timestamps in the store", () => {
	it("defaults both to 0 when the stored profile predates them", () => {
		// The migration case: a profile written before this feature existed.
		const parsed = readStored({ version: SCHEMA_VERSION, coins: 250, ownedBalls: {} });

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.lastDailyRewardAt).toBe(0);
		expect(parsed.profile.lastPlaytimeRewardAt).toBe(0);
	});

	it("keeps both across a save and a load", () => {
		// The write path. `toStored` builds the value from scratch, so this fails the moment either field is left out of it.
		const stored = toStored(profile(1_700_000_000, 1_699_999_000), "session-a");
		const parsed = readStored(stored);

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.lastDailyRewardAt).toBe(1_700_000_000);
		expect(parsed.profile.lastPlaytimeRewardAt).toBe(1_699_999_000);
	});

	it("writes both keys even when they are still zero", () => {
		// A brand-new profile saves `0`, and the next read must not be able to tell it from one that never had the keys -
		// both mean "never paid", and both are due.
		const stored = toStored(profile(0, 0), "session-a");

		expect(stored.lastDailyRewardAt).toBe(0);
		expect(stored.lastPlaytimeRewardAt).toBe(0);
	});

	it("reads a malformed value as never paid rather than refusing the profile", () => {
		// A string where a number belongs is a hand-edited or foreign value. Refusing would put the whole account into
		// `readonly` over a field the player never wrote; `0` costs at most one reward granted early.
		const parsed = readStored({
			version: SCHEMA_VERSION,
			coins: 10,
			ownedBalls: {},
			lastDailyRewardAt: "yesterday",
			lastPlaytimeRewardAt: {},
		});

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.lastDailyRewardAt).toBe(0);
		expect(parsed.profile.lastPlaytimeRewardAt).toBe(0);
	});

	it("clamps a negative or fractional value the same way", () => {
		// `rewardDue` treats `<= 0` as never paid, so a negative stored value would otherwise read as due forever. The floor
		// is for the same reason `readOwner` floors an owner id: a float that arrived by accident must not compare unequal to
		// an integer that did not.
		const parsed = readStored({
			version: SCHEMA_VERSION,
			coins: 10,
			ownedBalls: {},
			lastDailyRewardAt: -12,
			lastPlaytimeRewardAt: 1_700_000_000.75,
		});

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.lastDailyRewardAt).toBe(0);
		expect(parsed.profile.lastPlaytimeRewardAt).toBe(1_700_000_000);
	});

	it("still refuses a profile at another version, because the fields did not earn a bump", () => {
		// `SCHEMA_VERSION` stays at 1: these are additive fields with safe defaults, and a bump would make every existing
		// profile unreadable to record two timestamps.
		expect(SCHEMA_VERSION).toBe(1);
		expect(readStored({ version: SCHEMA_VERSION + 1, coins: 10, ownedBalls: {} })).toBe(undefined);
	});
});
