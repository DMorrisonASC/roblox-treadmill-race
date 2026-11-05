import { describe, expect, it } from "@rbxts/jest-globals";
import { rarityOfBall } from "shared/economy.config";
import { readStored, SCHEMA_VERSION } from "../services/player-data-store";

/**
 * The ball-id rename migration: a stored profile written before the rename still owns its balls.
 *
 * ## The bug this exists to prevent
 *
 * `ownedBallsFrom` — and `rarityOfBall` under it — drops any id `BALL_POOL` does not know. So renaming a ball without a
 * read-time mapping does not delete anything: the count stays in the profile, the inventory does not list it, the picker
 * does not offer it, and **nothing logs that a ball disappeared**. Silent, permanent and unlogged is the same shape as
 * item 64's key-prefix bump, which is why the translation happens at the one gate every load passes through rather than
 * at each reader.
 *
 * ## Why the version is not bumped
 *
 * `readStored` refuses any profile whose `version` is not `SCHEMA_VERSION`, and a refusal puts the session in
 * `readonly`. A rename is not a schema change — same field, same shape, and an exact mapping — so a bump would cost every
 * player their account to record something that needs no recording. Asserted below rather than trusted to a comment.
 */
describe("ball id migration", () => {
	/** A stored table shaped the way `flattenOwned` writes one, at the current version. */
	function stored(ownedBalls: Record<string, number>): unknown {
		return { version: SCHEMA_VERSION, coins: 250, ownedBalls };
	}

	it("reads a stored retired id as the current id, keeping the count", () => {
		const parsed = readStored(stored({ split_ball: 2 }));

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.ownedBalls.get("decoy_ball")).toBe(2);

		// And the retired key is gone rather than duplicated: two entries for one ball would make the inventory show the
		// ball twice while `OwnedBalls` carried both ids.
		let entries = 0;
		for (const [, count] of parsed.profile.ownedBalls) {
			entries += 1;
			expect(count).toBe(2);
		}
		expect(entries).toBe(1);
	});

	it("reads a stored retired prism id as the current recycle id, keeping the count", () => {
		// The second row of the same table, asserted separately so a rename that forgot to add its row fails here rather
		// than in a player's inventory.
		const parsed = readStored(stored({ prism_ball: 2 }));

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.ownedBalls.get("recycle_ball")).toBe(2);
		expect(parsed.profile.ownedBalls.size()).toBe(1);
	});

	it("migrates several retired ids in one profile", () => {
		const parsed = readStored(stored({ split_ball: 1, prism_ball: 2, bully_ball: 3 }));

		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.ownedBalls.get("decoy_ball")).toBe(1);
		expect(parsed.profile.ownedBalls.get("recycle_ball")).toBe(2);
		expect(parsed.profile.ownedBalls.get("bully_ball")).toBe(3);
		expect(parsed.profile.ownedBalls.size()).toBe(3);
	});

	it("resolves the migrated id against the pool, which is the point of the mapping", () => {
		const parsed = readStored(stored({ split_ball: 1 }));
		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		for (const [ballId] of parsed.profile.ownedBalls) {
			expect(rarityOfBall(ballId) !== undefined).toBe(true);
		}
	});

	it("leaves every other id alone", () => {
		const parsed = readStored(stored({ bully_ball: 3, ghost_ball: 1 }));
		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.ownedBalls.get("bully_ball")).toBe(3);
		expect(parsed.profile.ownedBalls.get("ghost_ball")).toBe(1);
	});

	it("sums an old and a new id rather than letting one overwrite the other", () => {
		// Only reachable from a profile written by two builds, and losing a grant silently is exactly the failure this
		// whole table exists to prevent.
		const parsed = readStored(stored({ split_ball: 2, decoy_ball: 1 }));
		expect(parsed !== undefined).toBe(true);
		if (parsed === undefined) {
			return;
		}

		expect(parsed.profile.ownedBalls.get("decoy_ball")).toBe(3);
	});

	it("still loads a profile at the current version, because the version was not bumped", () => {
		expect(SCHEMA_VERSION).toBe(1);

		const parsed = readStored(stored({ decoy_ball: 1 }));
		expect(parsed !== undefined).toBe(true);
	});

	it("still refuses a profile at any other version", () => {
		// The rename is a translation, not a licence to accept unknown versions: refusal is what keeps an old experimental
		// build's data untouched for a build that understands it.
		expect(readStored({ version: SCHEMA_VERSION + 1, coins: 0, ownedBalls: {} })).toBe(undefined);
		expect(readStored({ version: SCHEMA_VERSION - 1, coins: 0, ownedBalls: {} })).toBe(undefined);
	});
});
