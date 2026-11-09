/**
 * The pure half of the `/dev` command: who may run it, what a coin amount may be, how one chat line is read, and whether
 * the dangerous verbs are armed at all (item 150).
 *
 * ## Why this file is under `src/server` and not `src/shared`
 *
 * `default.project.json` mounts `out/shared` at `ReplicatedStorage.TS` and `out/server` at `ServerScriptService.TS`.
 * Every module here is therefore **unreachable from a client script** by construction — not by convention, not by a
 * review rule, but because the instance does not replicate to the client at all.
 *
 * The alternative was considered and rejected. A shared list would only be useful if the client needed to know who is
 * an admin to alter its own display, and this round adds **no client code at all** (the chat command is created and
 * handled entirely on the server). A shared admin list with no client reader would be a list of who to attack, shipped
 * to everybody, in exchange for nothing.
 *
 * ## What this module is not
 *
 * It is **not** a group rank, not a game pass, not an attribute, and not a replicated value. A client cannot influence
 * any decision made here, because no client ever sends anything that reaches this file. It must never be read on the
 * client to decide whether to show a UI: the moment a client gates an interface on the admin list, the list is a hint
 * about which account to compromise, and the gate is cosmetic anyway.
 *
 * Everything here is a pure function over plain values, which is what makes criteria about "refuses without writing"
 * testable in Jest Lua — no `Player`, no `DataStore`, no engine service is constructed by any of it.
 *
 * The one exception is the arming gate at the bottom of this file (item 150): it holds a `let` per server session and
 * seeds it from `isStudioSession()`. The **rule** is still pure (`armDev`/`disarmDev` take a state and return one); the
 * three wrappers around it are the only code here that touches a module variable.
 */

import { isStudioSession } from "./services/player-data-store";

/**
 * The UserIds allowed to run `/dev`. **The only authorisation check in the tree.**
 *
 * ## Why an array of numbers and not a `Record<string, boolean>`
 *
 * The UserId *is* the identity. A map keyed by anything else invites a key that is not a number — a username, which can
 * be changed and re-registered by someone else, or a display name, which is not unique and is not even the account.
 * An array of numbers cannot hold anything but an identity.
 *
 * ## Why it is not marked `**Placeholder.**`
 *
 * Every other number in this tree is a tuning value. This one is not a value to tune, it is a fact about which account
 * exists — `41354175` is a specific player, not a guess. Marking it a placeholder would invite somebody to "adjust" it
 * and quietly ship an admin list that contains the wrong account.
 *
 * ## Adding an entry
 *
 * Append the UserId. Nothing else changes: membership is read on every invocation, so there is no cache to invalidate.
 */
export const ADMIN_USER_IDS: ReadonlyArray<number> = [41354175];

/**
 * **Placeholder.** The largest balance `setCoins` will accept.
 *
 * A cap exists because `setCoins` is an absolute setter driven by a hand-typed argument, and the two failures that
 * matter are both typos: `5000000000` (a finger on the wrong key) and a missing digit. A five-billion balance does not
 * corrupt anything arithmetically — Luau integers are 64-bit — but it overflows the coin pill's fixed-width layout, makes
 * every future economy number meaningless, and cannot be told apart from an exploit after the fact.
 *
 * `1_000_000` is 10,000 chests at the shipped `COIN_CHEST_COST`. It is a sanity bound, not a balance target: if a real
 * economy ever needs more than this, the number to raise is this one and the reason to raise it is a design decision
 * somebody should write down.
 */
export const ADMIN_COIN_CAP = 1_000_000;

/** Whether `userId` may run `/dev`. Linear over a list that is expected to stay under ten entries. */
export function isAdmin(userId: number): boolean {
	for (const adminId of ADMIN_USER_IDS) {
		if (adminId === userId) {
			return true;
		}
	}

	return false;
}

/** The verdict on one `setCoins` amount. `reason` is a log token, not a sentence, so grep can count refusals by cause. */
export type CoinAmountCheck = { ok: true; amount: number } | { ok: false; reason: string };

/**
 * Validates an amount for `setCoins`.
 *
 * ## Why `unknown` and not `number`
 *
 * The argument arrives as chat text and is converted with `tonumber`, which yields `undefined` for anything that is not
 * a number. Typing the parameter as `number` would mean the conversion is the only check, and the four cases below would
 * each be a silent success: `tonumber("1.5")` is a perfectly good number that must still be refused.
 *
 * ## Why NaN and infinity are named, and why they are checked first
 *
 * Both are numbers, so both pass a `typeIs(value, "number")` guard, and both break a coin balance in ways that outlive
 * the command: a `NaN` makes every later comparison false — `coins < COIN_CHEST_COST` stops refusing, so every chest
 * becomes free — and `math.huge` makes the balance permanently unspendable in practice while displaying as `inf`.
 *
 * They are checked **before** the integer test because that test cannot see them. `math.huge % 1` is NaN in Luau, so
 * infinity would be reported as a fractional amount; every comparison against NaN is false, so NaN would fall through
 * the fractional test and be reported as a negative or an integer depending on the order. Naming them first is what
 * makes each refusal a distinct, honest cause rather than a misleading one.
 *
 * Negative infinity reports `infinite` rather than `negative`: it is refused either way, and "you typed an infinity" is
 * the more useful of the two facts about it.
 *
 * ## Why the cap is checked last
 *
 * `above-cap` should mean "a plausible number that is too big". Checking it after the other four means a value that is
 * both fractional and huge is reported as `not-an-integer`, which is the cause that would actually be fixed first.
 */
export function checkCoinAmount(value: unknown): CoinAmountCheck {
	if (!typeIs(value, "number")) {
		return { ok: false, reason: "not-a-number" };
	}

	if (value !== value) {
		return { ok: false, reason: "nan" };
	}

	if (value === math.huge || value === -math.huge) {
		return { ok: false, reason: "infinite" };
	}

	if (value % 1 !== 0) {
		return { ok: false, reason: "not-an-integer" };
	}

	if (value < 0) {
		return { ok: false, reason: "negative" };
	}

	if (value > ADMIN_COIN_CAP) {
		return { ok: false, reason: "above-cap" };
	}

	return { ok: true, amount: value };
}

/** The word the chat alias is built from, so the alias and the parser cannot disagree about it. */
const DEV_COMMAND_WORD = "dev";

/** One parsed `/dev` invocation. */
export type DevCommand =
	| { ok: true; kind: "setCoins"; target: string; amount: string }
	| { ok: true; kind: "wipeData"; target: string }
	| { ok: true; kind: "arm"; token: string }
	| { ok: true; kind: "disarm" }
	| { ok: false; reason: string };

/**
 * Reads `/dev <subcommand> <args...>` out of the text a chat command receives.
 *
 * ## Why the subcommand is a word in the text and not an alias
 *
 * `PrimaryAlias` is typed `string`, so the type system permits `"/dev setCoins"`. Whether the chat matcher treats a
 * space in an alias as part of the alias or as the end of it is engine behaviour, and it is not observable from the
 * typings — so relying on it would mean a command that either works or silently never fires, with no compile error to
 * warn anybody. One alias (`/dev`) plus a subcommand token depends only on `unfilteredText`, which the typing *does*
 * promise is a string.
 *
 * ## Why the leading token is dropped rather than assumed
 *
 * `Triggered` is typed `(originTextSource, unfilteredText)`, and whether `unfilteredText` retains the alias the engine
 * just matched is not stated anywhere in the typings. Dropping a leading `/dev`, a leading `dev`, or any other
 * slash-prefixed token means the parser is correct under both conventions instead of being correct under one and
 * off-by-one under the other. The accepted forms are therefore:
 *
 * - `/dev setCoins prospeed1 500`
 * - `dev setCoins prospeed1 500`
 * - `setCoins prospeed1 500`
 *
 * ## Why the subcommand is case-insensitive but the arguments are not
 *
 * `setCoins` is a word a person types from memory, and `setcoins` is the same intention. A username is not: it is an
 * identifier, and folding its case is `findPlayerByName`'s job, done in one place with the ambiguity named there.
 *
 * ## Why an unknown subcommand echoes the token
 *
 * The refusal is only ever logged for an admin, so echoing costs nothing and turns "unknown subcommand" into a line
 * that says which word was wrong — which is the difference between a typo and a wrong command.
 */
export function parseDevCommand(text: string): DevCommand {
	// Whitespace runs collapse first: `str.split(" ")` is a single-space split, so a double space or a tab would produce
	// an empty token and shift every argument by one.
	const normalised = text.gsub("%s+", " ")[0];

	const tokens = new Array<string>();
	for (const piece of normalised.split(" ")) {
		if (piece !== "") {
			tokens.push(piece);
		}
	}

	let index = 0;
	if (tokens.size() > 0) {
		const first = tokens[0];
		if (first.sub(1, 1) === "/" || first.lower() === DEV_COMMAND_WORD) {
			index = 1;
		}
	}

	if (tokens.size() <= index) {
		return { ok: false, reason: "missing-subcommand" };
	}

	const subcommand = tokens[index].lower();
	index++;

	if (subcommand === "setcoins") {
		if (tokens.size() < index + 2) {
			return { ok: false, reason: "setCoins needs a player name and an amount" };
		}

		if (tokens.size() > index + 2) {
			return { ok: false, reason: "setCoins takes exactly two arguments" };
		}

		return { ok: true, kind: "setCoins", target: tokens[index], amount: tokens[index + 1] };
	}

	if (subcommand === "wipedata") {
		if (tokens.size() < index + 1) {
			return { ok: false, reason: "wipeData needs a player name" };
		}

		if (tokens.size() > index + 1) {
			return { ok: false, reason: "wipeData takes exactly one argument" };
		}

		return { ok: true, kind: "wipeData", target: tokens[index] };
	}

	// **The two arming subcommands (item 150).** They are parsed here rather than recognised in the handler because the
	// handler only ever sees a `DevCommand`: `arm` used to fall into the `unknown subcommand` branch, so there was no route
	// from the chat line to an arming call at all. Parsing is also what gives `arm` its arity refusal and keeps the
	// handler's dispatch exhaustive.
	//
	// `arm` accepts **zero or one** token: `/dev arm` with nothing is a legitimate keystroke, and it must fail on the token
	// comparison (a `bad-token` refusal) rather than on a parse error, so the answer to "did I arm it" is the same shape
	// whichever way the typist was wrong.
	if (subcommand === "arm") {
		if (tokens.size() > index + 1) {
			return { ok: false, reason: "arm takes at most one argument" };
		}

		return { ok: true, kind: "arm", token: tokens[index] ?? "" };
	}

	if (subcommand === "disarm") {
		if (tokens.size() > index) {
			return { ok: false, reason: "disarm takes no arguments" };
		}

		return { ok: true, kind: "disarm" };
	}

	return { ok: false, reason: `unknown subcommand "${tokens[index - 1]}"` };
}

/**
 * The fields target resolution needs. `Player` satisfies this structurally, so the real list and a test's plain tables
 * are the same call — which is the only way a resolver over `Player` instances can be tested at all, since a spec
 * cannot construct a `Player`.
 */
export interface NamedPlayer {
	readonly Name: string;
	readonly DisplayName: string;
}

/**
 * Finds a connected player by username, case-insensitively.
 *
 * ## Why a scan of connected players and not `GetUserIdFromNameAsync`
 *
 * `GetUserIdFromNameAsync` answers a *different* question — "does this Roblox account exist" — and every answer it can
 * give beyond "yes, and they are here" is unusable here: a target who is not in this server is refused (there is no
 * profile to change), and the call **yields and can throw** on an unknown name, so the handler would need a `pcall` and
 * would be at the mercy of a web request to produce a refusal it can already produce locally. The scan yields nothing,
 * cannot fail, and is the only mechanism whose successful answer is exactly the set of legal targets.
 *
 * The cost is that the two differ when the target is offline: the scan reports "no player named X in this server",
 * where `GetUserIdFromNameAsync` could have distinguished "no such account". That distinction has no consequence —
 * neither case writes anything — so the log names the one fact that matters.
 *
 * ## Why the match is on `Name` and not `DisplayName`
 *
 * `Name` is the unique username; `DisplayName` is neither unique nor stable. The display name is still what the log
 * prints, which is the same rule the rest of the tree uses: address by identifier, show the human the name they saw.
 */
export function findPlayerByName<T extends NamedPlayer>(candidates: ReadonlyArray<T>, name: string): T | undefined {
	const wanted = name.lower();

	for (const candidate of candidates) {
		if (candidate.Name.lower() === wanted) {
			return candidate;
		}
	}

	return undefined;
}

// #region the arming gate (item 150)

/**
 * **Placeholder.** The word `/dev arm <token>` has to be given before `setCoins` or `wipeData` will run.
 *
 * ## This is not a secret, and the docblock says so on purpose
 *
 * A leaked token is **not** a breach: `ADMIN_USER_IDS` is the access control, and it is the only thing standing between a
 * stranger and the economy. The token's whole job is to stop an admin's own slip of the hand — an admin who meant
 * `/dev setCoins` in a playtest and types the same thing on Live — from changing a real player's balance in one
 * keystroke. Two words of friction, not two factors of authentication.
 *
 * Writing that down matters because the opposite belief is the dangerous one: if this looked like a secret, somebody would
 * eventually move it into a `Secret`, replicate it, or gate a client on it. It lives in `src/server`, which
 * `default.project.json` mounts at `ServerScriptService` — an instance that does not replicate to a client — and it is
 * never logged (`grep DEV_ARM_TOKEN src` finds it here and nowhere else).
 */
export const DEV_ARM_TOKEN = "arm-dev";

/**
 * The environment, **read once for this entire file** (item 150).
 *
 * Both the seed below and the boot line's `reason=` want the same answer, and two `RunService.IsStudio()` calls are two
 * chances to disagree about which environment this server is in. One read, one constant, one file — the same habit
 * `PlayerDataStore.profileKey` and `EconomyService`'s Studio preview already follow with `isStudioSession()`.
 */
const IS_STUDIO = isStudioSession();

/**
 * Whether the dangerous `/dev` verbs are allowed right now.
 *
 * **Seeded from the environment, which is the whole point:** Studio auto-arms (a playtest is where these verbs are used)
 * and Live auto-disarms (a live server is where a slip of the hand is expensive). `let` rather than `const` because an
 * admin can arm a Live session, and because an arming admin leaving disarms it again.
 *
 * **Session state, not player state.** It does not survive a server shutdown, is not written to any store, and is not
 * visible to a client — there is no remote, no attribute and no value for it, on purpose: a client that could read it
 * would learn that the door is open.
 */
let devArmed = IS_STUDIO;

/** Who armed it, for the disarm log. `undefined` when it was seeded by the environment rather than by a person. */
let armedByUserId: number | undefined;
let armedByDisplayName: string | undefined;

/** The arming state, as a plain value. The pure functions below take one and return one; nothing else is injectable. */
export interface DevArmState {
	readonly armed: boolean;
	readonly byUserId: number | undefined;
	readonly byDisplayName: string | undefined;
}

/** The player a wrapper needs: an identity to compare and two names to log. `Player` satisfies this structurally. */
export interface DevArmPlayer extends NamedPlayer {
	readonly UserId: number;
}

/**
 * What one arm or disarm attempt did. `result` is a log token, not a sentence, so a refusal can be counted by cause.
 *
 * `bad-token` and the handler's non-admin refusal are deliberately indistinguishable **in the log** — see
 * `onDevCommand`'s refusal helper — so the shared token is not a way to discover whether a stranger is looking at an
 * armed door.
 */
export type DevArmResult = "armed" | "already-armed" | "bad-token" | "disarmed" | "already-disarmed";

/**
 * Arms the session if the token matches. **Pure:** it takes the state and returns the next one, which is what makes the
 * four branches assertable in Jest Lua without a `Player`, a server, or an arming side effect.
 *
 * ## Why the token is compared before the armed test
 *
 * Order is the rule here, not a preference. Checking `already-armed` first would tell a caller with the wrong token that
 * the session is armed — a small leak, but a free one to close: a wrong token always reports `bad-token`, whatever the
 * state, so the answer to "is the door open" never comes out of a failed attempt.
 *
 * `already-armed` therefore only means "armed, and you had the right token", which is the reading that makes the handler's
 * no-op branch safe to write.
 */
export function armDev(state: DevArmState, token: string): { result: DevArmResult; state: DevArmState } {
	if (token !== DEV_ARM_TOKEN) {
		return { result: "bad-token", state };
	}

	if (state.armed) {
		return { result: "already-armed", state };
	}

	return { result: "armed", state: { armed: true, byUserId: state.byUserId, byDisplayName: state.byDisplayName } };
}

/**
 * Disarms the session. Pure, for the same reason `armDev` is.
 *
 * The `by*` fields are cleared rather than kept: "armed by nobody" is the honest description of a disarmed session, and a
 * surviving name would make the next arming's log read as if it had never been disarmed. A disarmed session is a no-op
 * rather than an error — `/dev disarm` on an already-safe server is a person checking, not a mistake.
 */
export function disarmDev(state: DevArmState): { result: DevArmResult; state: DevArmState } {
	if (!state.armed) {
		return { result: "already-disarmed", state };
	}

	return { result: "disarmed", state: { armed: false, byUserId: undefined, byDisplayName: undefined } };
}

/**
 * Whether the dangerous verbs may run. **The only reader of the arming state outside this file.**
 *
 * The handler calls this once per `/dev` invocation; nothing else in the tree may. A second reader would be a second
 * opinion about whether the door is open, and the failure would be silent in whichever reader was wrong.
 */
export function isDevArmed(): boolean {
	return devArmed;
}

/**
 * Arms this server's session, and records who did it. **One of the two functions allowed to touch the module state.**
 *
 * The pure rule is `armDev`; this is the imperative shell around it — read the state, apply the rule, write the result.
 * Keeping the write here means `/dev`'s handler never names a module variable, which is what lets the rule be tested with
 * literals.
 */
export function armSessionDev(player: DevArmPlayer, token: string): { result: DevArmResult; state: DevArmState } {
	const outcome = armDev({ armed: devArmed, byUserId: armedByUserId, byDisplayName: armedByDisplayName }, token);

	devArmed = outcome.state.armed;
	armedByUserId = outcome.result === "armed" ? player.UserId : outcome.state.byUserId;
	armedByDisplayName =
		outcome.result === "armed" ? `${player.Name}/${player.DisplayName}` : outcome.state.byDisplayName;

	return outcome;
}

/**
 * Disarms this server's session. The other function allowed to touch the module state.
 *
 * Deliberately **not** restricted to the admin who armed it: any admin may close a door they found open. Restricting that
 * would mean a session could be left armed for the rest of its life by an admin who disconnected, except that the leave
 * handler closes that case anyway — see `disarmSessionDevFor`.
 */
export function disarmSessionDev(): DevArmResult {
	const outcome = disarmDev({ armed: devArmed, byUserId: armedByUserId, byDisplayName: armedByDisplayName });

	devArmed = outcome.state.armed;
	armedByUserId = outcome.state.byUserId;
	armedByDisplayName = outcome.state.byDisplayName;

	return outcome.result;
}

/**
 * Disarms on behalf of a *departing* player, but only if they are the one who armed it.
 *
 * Returns `"disarmed"` when they were the armer, `"already-disarmed"` when the session was not armed, and
 * `"not-the-armer"` when somebody else opened the door — in which case it stays open, because one admin leaving is not
 * permission for another admin's session to close.
 *
 * The comparison lives here rather than in the handler for the reason the whole region exists: `armedByUserId` is module
 * state, and only the three wrappers above and below this comment may read or write it.
 */
export function disarmSessionDevFor(userId: number): DevArmResult | "not-the-armer" {
	if (!devArmed) {
		return "already-disarmed";
	}

	if (armedByUserId !== userId) {
		return "not-the-armer";
	}

	return disarmSessionDev();
}

/** Whether this server is a Studio session, for the boot line's `reason=`. Cached — see `IS_STUDIO`. */
export function isStudioEnvironment(): boolean {
	return IS_STUDIO;
}

// #endregion
