import { ROUND_STATE_VALUE_NAME } from "shared/remotes";

/**
 * The round banner's three strings: **a header token, an optional winner, and a status sentence.**
 *
 * ## Why this is a module and not three functions in the controller
 *
 * The controller reaches `GuiService` and `ReplicatedStorage.WaitForChild`, so nothing inside it can be constructed in the Jest
 * runtime - which means a rule kept there can only be checked by playing a round. `round-outcome` and `round-payout` were
 * extracted for exactly this reason, and this is the same trade: the mapping is pure, so "the header says `LOBBY` in
 * `Intermission`" becomes an assertion instead of a claim in a report.
 *
 * It is `shared/` rather than `client/` because the strings are a statement about the round, not about a widget. A future
 * spectator HUD or an end-of-round summary wants the same words.
 *
 * ## Three answers, because the banner is two rows
 *
 * The previous banner was one label reading `PostGame — BestDefault`. A two-row strip separates the *state* from the
 * *sentence*, so the state is a short token and the sentence is the thing a player reads: the header answers "where am I", the
 * message answers "what now". Composing them back into one string (which `bannerText` still does, for the earlier rounds'
 * reports) is therefore presentation glue rather than a rule.
 */

/** The four phase values `RoundService` writes. Anything else is a defect and renders as `UNKNOWN` / `Unknown`. */
export const KNOWN_PHASES = new Set<string>(["Intermission", "Waiting", "Playing", "PostGame"]);

/** Distinct unknown phase values already reported, so a wrong phase cannot print on every refresh. */
const reportedUnknown = new Set<string>();

/**
 * One line per distinct unrecognised phase value.
 *
 * `RoundState` is written by one service and compared here by literal, so a rename or a fifth phase would silently render as
 * `UNKNOWN` with nothing anywhere saying which string arrived. The `Set` is what makes it one line per distinct bad value
 * rather than one per transition: a phase that is wrong tends to stay wrong. Two *different* unknown strings are two different
 * defects and both are worth a line.
 */
export function reportUnknownPhase(phase: string): void {
	if (reportedUnknown.has(phase)) {
		return;
	}

	reportedUnknown.add(phase);
	print(`[PhaseBanner] unknown ${ROUND_STATE_VALUE_NAME} value="${phase}"`);
}

/**
 * The header's phase token: **one word, upper case, describing the state the player is in.**
 *
 * ## Why these are not the `RoundState` strings
 *
 * `Intermission`, `Waiting`, `Playing`, `PostGame` are the *machine's* names and they are what the log prints. A header that
 * repeats them is a debug readout; `LOBBY` / `MATCH` / `RACE` / `RESULT` say the same four things in the vocabulary the player
 * is actually in - waiting for the next round, choosing a ball, racing, reading the result. The mapping is presentation only:
 * nothing in the phase machine changes.
 *
 * `UNKNOWN` is the fifth answer and it is deliberately not a phase name: it is what a value the machine should never write
 * renders as. It does not report here - `bannerMessageText` does, so one bad value prints one line however many of these are
 * evaluated.
 */
export function bannerHeaderText(phase: string): string {
	if (phase === "Intermission") {
		return "LOBBY";
	}

	if (phase === "Waiting") {
		return "MATCH";
	}

	if (phase === "Playing") {
		return "RACE";
	}

	if (phase === "PostGame") {
		return "RESULT";
	}

	return "UNKNOWN";
}

/**
 * The header's winner token, or `""` when there is nothing to put there.
 *
 * `""` rather than the word "none": the message below already says `No winner this round.`, and a header reading
 * `RESULT • none` would be a second, terser announcement of the same fact.
 *
 * **An empty token must be hidden together with its bullet** by the caller. A `UIListLayout` skips an invisible child, so
 * hiding both leaves a one-token row; leaving the bullet visible prints `RESULT •` with nothing after it, which reads as a typo
 * rather than as "nobody won".
 */
export function bannerWinnerText(phase: string, winner: string): string {
	if (phase !== "PostGame") {
		return "";
	}

	if (winner === "" || winner === "none") {
		return "";
	}

	return winner;
}

/**
 * The status line under the header: **one sentence about what the player can do right now.**
 *
 * ## Why these are not the reference effect's words
 *
 * The reference reads `Race in progress. You're up next!`, which assumes a queued matchmaking model. This game has no queue:
 * every enrolled player is in the round, and in `Playing` most of them have already been eliminated and are watching. That
 * sentence would be false in every non-`Playing` phase and false in `Playing` for anyone whose ball is already out. Each string
 * here is one of the game's real states instead.
 */
export function bannerMessageText(phase: string, winner: string, refusal = ""): string {
	// **A refusal replaces the phase's message, it is not appended to it** (item 214). The message slot is where a player looks for
	// "what now", and "Next round starting soon" is a promise the machine is currently declining to keep. Empty means "no
	// refusal", which is every round that starts normally.
	if (refusal !== "") {
		return refusal;
	}

	if (phase === "Intermission") {
		return "Next round starting soon.";
	}

	if (phase === "Waiting") {
		return "Pick your ball.";
	}

	if (phase === "Playing") {
		return "Race in progress.";
	}

	if (phase === "PostGame") {
		return bannerWinnerText(phase, winner) === "" ? "No winner this round." : `${winner} wins!`;
	}

	reportUnknownPhase(phase);

	return "Unknown";
}
