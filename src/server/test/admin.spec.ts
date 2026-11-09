import { describe, expect, it } from "@rbxts/jest-globals";
import {
	ADMIN_COIN_CAP,
	ADMIN_USER_IDS,
	armDev,
	checkCoinAmount,
	DEV_ARM_TOKEN,
	DevArmState,
	disarmDev,
	findPlayerByName,
	isAdmin,
	parseDevCommand,
} from "../admin";
import { applyCoinSet, applyProfileReset } from "../services/economy-service";
import { Profile } from "../services/player-data-store";
import { STARTING_COINS } from "shared/economy.config";

/**
 * The admin command's two halves: what it will accept, and what it does to a profile.
 *
 * ## What this file can and cannot reach
 *
 * Everything here is a pure function over plain values or over a `Profile` with a fake `save`, so the refusals, the
 * ordering and the reverts are all provable. What it cannot reach is the transport: a `TextChatCommand.Triggered`
 * handler cannot be fired from Jest Lua, and neither can a `Player` be constructed to target. So "a non-admin produces
 * one log line and changes nothing" is verified by source read of `onDevCommand`, and the chat command itself needs a
 * Studio session. Both are stated in the round report rather than implied by a green suite.
 *
 * ## Why the fixtures are plain tables
 *
 * A `Profile` is an interface over a number, a `Map` and an array. Building one literally is the same thing the bundle
 * tests do, and it means a failing assertion points at the admin verb rather than at a mock of the store.
 */

function profileWith(coins: number, balls: Record<string, number>, purchases: Array<string> = []): Profile {
	const ownedBalls = new Map<string, number>();
	for (const [ballId, count] of pairs(balls)) {
		ownedBalls.set(ballId, count);
	}

	return { version: 1, coins, ownedBalls, purchases, lastDailyRewardAt: 0, lastPlaytimeRewardAt: 0 };
}

/** Everything a reset touches, flattened, so "unchanged" is a string comparison rather than five assertions. */
function snapshot(profile: Profile): string {
	const ids = new Array<string>();
	for (const [ballId, count] of profile.ownedBalls) {
		ids.push(`${ballId}=${count}`);
	}

	// Sorted, so a restore that refilled the map in a different order is not reported as a change when it is not one.
	ids.sort((left, right) => left < right);

	return `${profile.coins}|${ids.join(",")}|${profile.purchases.join(",")}`;
}

describe("the admin list", () => {
	it("contains exactly one UserId", () => {
		expect(ADMIN_USER_IDS.size()).toBe(1);
	});

	it("contains the shipped admin and nobody else", () => {
		expect(ADMIN_USER_IDS[0]).toBe(41354175);
	});

	it("admits the listed UserId", () => {
		expect(isAdmin(41354175)).toBe(true);
	});

	it("refuses an unlisted UserId", () => {
		expect(isAdmin(0)).toBe(false);
		expect(isAdmin(41354176)).toBe(false);
		// A display-name-shaped value and a group rank are both numbers somewhere in some other system; neither is an
		// identity, and neither may pass.
		expect(isAdmin(-1)).toBe(false);
	});
});

describe("checkCoinAmount", () => {
	it("accepts zero", () => {
		// Criterion: a zero is a value, not a refusal. This is the case a `if (!amount)` guard would break.
		const check = checkCoinAmount(0);
		expect(check.ok).toBe(true);
		expect(check.ok ? check.amount : -1).toBe(0);
	});

	it("accepts a normal balance", () => {
		const check = checkCoinAmount(500);
		expect(check.ok).toBe(true);
		expect(check.ok ? check.amount : -1).toBe(500);
	});

	it("accepts the cap itself", () => {
		expect(checkCoinAmount(ADMIN_COIN_CAP).ok).toBe(true);
	});

	it("refuses a negative amount", () => {
		const check = checkCoinAmount(-1);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("negative");
	});

	it("refuses a fractional amount", () => {
		const check = checkCoinAmount(1.5);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-an-integer");
	});

	it("refuses NaN", () => {
		// NaN defeats every comparison, so it is refused by identity rather than by range. A NaN balance would make
		// `coins < COIN_CHEST_COST` false forever, and every chest would be free.
		const check = checkCoinAmount(0 / 0);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("nan");
	});

	it("refuses infinity", () => {
		const check = checkCoinAmount(math.huge);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("infinite");
	});

	it("refuses negative infinity as infinite, not as negative", () => {
		// Both are true of it. The infinity is the fact that would be fixed first, so it is the one named.
		const check = checkCoinAmount(-math.huge);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("infinite");
	});

	it("refuses an amount above the cap", () => {
		const check = checkCoinAmount(ADMIN_COIN_CAP + 1);
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("above-cap");
	});

	it("refuses a non-number", () => {
		// This is what `tonumber` returning `undefined` for "abc" looks like by the time it arrives here.
		const check = checkCoinAmount("500");
		expect(check.ok).toBe(false);
		expect(check.ok ? "accepted" : check.reason).toBe("not-a-number");

		const missing = checkCoinAmount(undefined);
		expect(missing.ok).toBe(false);
		expect(missing.ok ? "accepted" : missing.reason).toBe("not-a-number");
	});
});

describe("parseDevCommand", () => {
	it("reads the slash-prefixed form", () => {
		const command = parseDevCommand("/dev setCoins prospeed1 500");
		expect(command.ok).toBe(true);
		expect(command.ok && command.kind === "setCoins" ? command.target : "wrong").toBe("prospeed1");
		expect(command.ok && command.kind === "setCoins" ? command.amount : "wrong").toBe("500");
	});

	it("reads the same command without the alias", () => {
		// Whether `unfilteredText` retains the alias is not in the typings, so both shapes have to parse.
		const command = parseDevCommand("setCoins prospeed1 500");
		expect(command.ok).toBe(true);
		expect(command.ok && command.kind === "setCoins" ? command.target : "wrong").toBe("prospeed1");
	});

	it("reads the alias without a slash", () => {
		const command = parseDevCommand("dev setCoins prospeed1 500");
		expect(command.ok).toBe(true);
		expect(command.ok && command.kind === "setCoins" ? command.amount : "wrong").toBe("500");
	});

	it("is case-insensitive about the subcommand and the alias", () => {
		const command = parseDevCommand("/DEV SETCOINS Prospeed1 500");
		expect(command.ok && command.kind === "setCoins" ? command.target : "wrong").toBe("Prospeed1");
	});

	it("collapses runs of whitespace", () => {
		// A tab or a double space would otherwise produce an empty token and shift the arguments by one.
		const command = parseDevCommand("/dev   setCoins\tprospeed1    500");
		expect(command.ok && command.kind === "setCoins" ? command.amount : "wrong").toBe("500");
	});

	it("reads wipeData", () => {
		const command = parseDevCommand("/dev wipeData prospeed1");
		expect(command.ok).toBe(true);
		expect(command.ok ? command.kind : "wrong").toBe("wipeData");
	});

	it("refuses an empty command", () => {
		const command = parseDevCommand("/dev");
		expect(command.ok).toBe(false);
		expect(command.ok ? "accepted" : command.reason).toBe("missing-subcommand");
	});

	it("refuses an unknown subcommand and names it", () => {
		const command = parseDevCommand("/dev setBall prospeed1 500");
		expect(command.ok).toBe(false);
		expect(command.ok ? "accepted" : command.reason).toBe('unknown subcommand "setBall"');
	});

	it("refuses setCoins with a missing argument", () => {
		const command = parseDevCommand("/dev setCoins prospeed1");
		expect(command.ok).toBe(false);
	});

	it("refuses setCoins with a surplus argument", () => {
		const command = parseDevCommand("/dev setCoins prospeed1 500 900");
		expect(command.ok).toBe(false);
	});

	it("refuses wipeData with a missing target", () => {
		const command = parseDevCommand("/dev wipeData");
		expect(command.ok).toBe(false);
	});

	it("refuses wipeData with a surplus argument", () => {
		const command = parseDevCommand("/dev wipeData prospeed1 extra");
		expect(command.ok).toBe(false);
	});
});

describe("findPlayerByName", () => {
	const candidates = [
		{ Name: "Prospeed1", DisplayName: "Prospeed" },
		{ Name: "Builder", DisplayName: "The Builder" },
	];

	it("finds a player by exact username", () => {
		expect(findPlayerByName(candidates, "Builder")?.DisplayName).toBe("The Builder");
	});

	it("matches a username case-insensitively", () => {
		// Usernames are unique case-insensitively, so two candidates can never differ only by case; folding is safe.
		expect(findPlayerByName(candidates, "prospeed1")?.Name).toBe("Prospeed1");
	});

	it("does not match a display name", () => {
		// The display name is not an identity and is not unique. Addressed by identifier, displayed by name.
		expect(findPlayerByName(candidates, "Prospeed")).toBeUndefined();
		expect(findPlayerByName(candidates, "The Builder")).toBeUndefined();
	});

	it("returns undefined for a name that is not connected", () => {
		expect(findPlayerByName(candidates, "Nobody")).toBeUndefined();
	});

	it("returns undefined for an empty list", () => {
		expect(findPlayerByName(new Array<{ Name: string; DisplayName: string }>(), "Prospeed1")).toBeUndefined();
	});
});

describe("applyCoinSet", () => {
	it("sets an absolute balance and saves once", () => {
		const profile = profileWith(500, {});
		let saves = 0;

		const outcome = applyCoinSet(profile, 1200, (candidate) => {
			saves++;
			// The save sees the new balance, which is what makes "the written value contains the change" true.
			expect(candidate.coins).toBe(1200);
			return true;
		});

		expect(outcome).toBe("ok");
		expect(saves).toBe(1);
		expect(profile.coins).toBe(1200);
	});

	it("sets a balance down to zero", () => {
		const profile = profileWith(500, {});

		expect(applyCoinSet(profile, 0, () => true)).toBe("ok");
		expect(profile.coins).toBe(0);
	});

	it("reverts the balance when the save fails", () => {
		const profile = profileWith(500, {});

		const outcome = applyCoinSet(profile, 9999, () => false);

		expect(outcome).toBe("save-failed");
		expect(profile.coins).toBe(500);
	});

	it("touches nothing but coins", () => {
		const profile = profileWith(500, { bully_ball: 2 }, ["purchase-1"]);

		applyCoinSet(profile, 42, () => true);

		expect(profile.ownedBalls.get("bully_ball")).toBe(2);
		expect(profile.purchases.size()).toBe(1);
	});
});

describe("applyProfileReset", () => {
	it("resets to a brand-new profile and saves once", () => {
		const profile = profileWith(9000, { bully_ball: 3, ghost_ball: 1 }, ["purchase-a", "purchase-b"]);
		let saves = 0;

		const outcome = applyProfileReset(profile, () => {
			saves++;
			return true;
		});

		expect(outcome).toBe("ok");
		expect(saves).toBe(1);
		expect(profile.coins).toBe(STARTING_COINS);
		expect(profile.ownedBalls.size()).toBe(0);
		expect(profile.purchases.size()).toBe(0);
	});

	it("keeps the schema version", () => {
		// The reset is a content change, not a migration: a version bump would make `readStored` refuse the profile
		// next session and drop the player into a read-only state.
		const profile = profileWith(500, {});

		applyProfileReset(profile, () => true);

		expect(profile.version).toBe(1);
	});

	it("leaves the profile byte-identical when the save fails", () => {
		const profile = profileWith(9000, { bully_ball: 3, ghost_ball: 1 }, ["purchase-a", "purchase-b"]);
		const before = snapshot(profile);

		const outcome = applyProfileReset(profile, () => false);

		expect(outcome).toBe("save-failed");
		expect(snapshot(profile)).toBe(before);
	});

	it("restores the purchases array in full, not merely emptied", () => {
		// The array is cleared before the save, so a revert that only "removes nothing" would leave the history gone.
		const profile = profileWith(500, {}, ["purchase-a", "purchase-b", "purchase-c"]);

		applyProfileReset(profile, () => false);

		expect(profile.purchases.size()).toBe(3);
		expect(profile.purchases[0]).toBe("purchase-a");
		expect(profile.purchases[2]).toBe("purchase-c");
	});

	it("writes the reset before reporting success", () => {
		// The save callback runs while the profile is already cleared: a save that inspected the profile sees the empty
		// one, which is what makes "the persisted value is the reset" true rather than hopeful.
		const profile = profileWith(9000, { bully_ball: 3 });

		applyProfileReset(profile, (candidate) => {
			expect(candidate.coins).toBe(STARTING_COINS);
			expect(candidate.ownedBalls.size()).toBe(0);
			return true;
		});
	});
});

/**
 * The arming gate (item 150).
 *
 * ## What is asserted here, and what is not
 *
 * `armDev` and `disarmDev` take a state and return one, so every branch is reachable with a literal. What is **not**
 * asserted: the module-level seed (`devArmed = isStudioSession()`), `isDevArmed()`, and the three wrappers that read and
 * write it. Those depend on the environment the suite happens to run in — Studio, where `IsStudio()` is true — and on a
 * module singleton that the rest of the file would then see mutated. They are verified by reading `admin.ts` and by a
 * playtest, and the round report says so rather than implying a green suite covers them.
 */
function armState(armed: boolean, byUserId: number | undefined = undefined): DevArmState {
	return { armed, byUserId, byDisplayName: byUserId === undefined ? undefined : "Tester/Tester" };
}

describe("armDev", () => {
	it("arms an unarmed state with the right token", () => {
		const outcome = armDev(armState(false), DEV_ARM_TOKEN);

		expect(outcome.result).toBe("armed");
		expect(outcome.state.armed).toBe(true);
	});

	it("refuses a wrong token and leaves the state alone", () => {
		const before = armState(false);
		const outcome = armDev(before, "wrong");

		expect(outcome.result).toBe("bad-token");
		expect(outcome.state.armed).toBe(false);
		// Identity, not equality: a refusal must not hand back a rewritten table, because the caller writes it back.
		expect(outcome.state === before).toBe(true);
	});

	it("refuses a wrong token even when the session is already armed", () => {
		// The leak this closes: answering `already-armed` to a wrong token would tell a failed attempt whether the door is
		// open. A wrong token always reports the same thing, whatever the state.
		const outcome = armDev(armState(true, 7), "wrong");

		expect(outcome.result).toBe("bad-token");
		expect(outcome.state.armed).toBe(true);
	});

	it("reports already-armed for a right token at an open door", () => {
		const outcome = armDev(armState(true, 7), DEV_ARM_TOKEN);

		expect(outcome.result).toBe("already-armed");
		expect(outcome.state.armed).toBe(true);
	});

	it("refuses the empty token a bare `/dev arm` produces", () => {
		// `parseDevCommand` turns `/dev arm` into `token = ""`, so this is the keystroke a distracted admin actually sends.
		expect(armDev(armState(false), "").result).toBe("bad-token");
	});
});

describe("disarmDev", () => {
	it("disarms and clears who armed it", () => {
		const outcome = disarmDev(armState(true, 7));

		expect(outcome.result).toBe("disarmed");
		expect(outcome.state.armed).toBe(false);
		// Cleared, not kept: "armed by nobody" is the honest description of a disarmed session, and a surviving name would
		// make the next arming's log read as if it had never been disarmed.
		expect(outcome.state.byUserId).toBe(undefined);
		expect(outcome.state.byDisplayName).toBe(undefined);
	});

	it("is a no-op on an already-disarmed state", () => {
		const before = armState(false);
		const outcome = disarmDev(before);

		expect(outcome.result).toBe("already-disarmed");
		expect(outcome.state === before).toBe(true);
	});
});

describe("parseDevCommand's arming subcommands", () => {
	it("parses arm with a token", () => {
		const command = parseDevCommand("/dev arm arm-dev");

		expect(command.ok).toBe(true);
		expect(command.ok ? command.kind : "none").toBe("arm");
		expect(command.ok && command.kind === "arm" ? command.token : "").toBe("arm-dev");
	});

	it("parses a bare arm as an empty token rather than a parse error", () => {
		// The refusal must come from the token comparison, not from the parser, so every wrong arm attempt reads the same.
		const command = parseDevCommand("/dev arm");

		expect(command.ok).toBe(true);
		expect(command.ok && command.kind === "arm" ? command.token : "missing").toBe("");
	});

	it("refuses arm with two arguments", () => {
		const command = parseDevCommand("/dev arm one two");

		expect(command.ok).toBe(false);
	});

	it("parses disarm", () => {
		const command = parseDevCommand("/dev disarm");

		expect(command.ok).toBe(true);
		expect(command.ok ? command.kind : "none").toBe("disarm");
	});

	it("refuses disarm with an argument", () => {
		expect(parseDevCommand("/dev disarm now").ok).toBe(false);
	});
});
