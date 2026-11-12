import { describe, expect, it } from "@rbxts/jest-globals";
import { bannerHeaderText, bannerMessageText, bannerWinnerText } from "./phase-banner";

/**
 * The banner's three strings, as a table (item 210).
 *
 * The controller cannot be constructed in Jest - it reaches `GuiService` and `WaitForChild` - so the mapping is exported as
 * three pure functions from `shared/` and asserted here. Same split as `round-outcome` and `round-payout`, and the reason "the
 * header says `LOBBY` in `Intermission`" is a checked fact rather than a claim in a report.
 *
 * What this cannot prove: that the two rows are legible over the arena, that they sit under the topbar, or that removing the
 * panel reads as deliberate HUD rather than as floating text. Those are screenshot judgements.
 */
describe("bannerHeaderText", () => {
	it("maps the four real phases to the player's vocabulary, not the machine's", () => {
		// `Intermission` in a header is a debug readout; `LOBBY` is the state the player is in.
		expect(bannerHeaderText("Intermission")).toBe("LOBBY");
		expect(bannerHeaderText("Waiting")).toBe("MATCH");
		expect(bannerHeaderText("Playing")).toBe("RACE");
		expect(bannerHeaderText("PostGame")).toBe("RESULT");
	});

	it("renders anything else as UNKNOWN", () => {
		// Exact strings only: a trailing space or a different case is a defect in the writer and must not silently map to a real
		// phase, which is what a `lower()`-based comparison would do.
		expect(bannerHeaderText("")).toBe("UNKNOWN");
		expect(bannerHeaderText("Intermission ")).toBe("UNKNOWN");
		expect(bannerHeaderText("postgame")).toBe("UNKNOWN");
	});
});

describe("bannerWinnerText", () => {
	it("is empty outside PostGame, whatever the winner says", () => {
		// The `WinnerName` value keeps its last content until the next round clears it, so a stale name must not appear in a header
		// that is not reporting a result.
		expect(bannerWinnerText("Playing", "BestDefault")).toBe("");
		expect(bannerWinnerText("Waiting", "BestDefault")).toBe("");
		expect(bannerWinnerText("", "BestDefault")).toBe("");
	});

	it("carries the name on PostGame, and nothing when nobody won", () => {
		expect(bannerWinnerText("PostGame", "BestDefault")).toBe("BestDefault");
		// Both spellings of "no winner" collapse to empty: the server writes `none`, and an empty value is the same fact one
		// assignment earlier. Neither may leave `RESULT` bulleted with nothing after it.
		expect(bannerWinnerText("PostGame", "none")).toBe("");
		expect(bannerWinnerText("PostGame", "")).toBe("");
	});
});

describe("bannerMessageText", () => {
	it("says what the player can do in each phase", () => {
		expect(bannerMessageText("Intermission", "")).toBe("Next round starting soon.");
		expect(bannerMessageText("Waiting", "")).toBe("Pick your ball.");
		expect(bannerMessageText("Playing", "")).toBe("Race in progress.");
	});

	it("reports the result on PostGame, both ways", () => {
		expect(bannerMessageText("PostGame", "BestDefault")).toBe("BestDefault wins!");
		expect(bannerMessageText("PostGame", "none")).toBe("No winner this round.");
		expect(bannerMessageText("PostGame", "")).toBe("No winner this round.");
	});

	it("ignores the winner outside PostGame", () => {
		// A name left over from the previous round must not turn `Playing` into a result line.
		expect(bannerMessageText("Playing", "BestDefault")).toBe("Race in progress.");
	});

	it("lets a refusal replace the phase's message (item 214)", () => {
		// **Not appended - replaced.** The message slot answers "what now", and "Next round starting soon" is a promise the machine
		// is currently declining to keep. The refusal wins in every phase, including ones with no refusal case of their own.
		expect(bannerMessageText("Intermission", "", "Need atleast two players to start a race")).toBe(
			"Need atleast two players to start a race",
		);
		expect(bannerMessageText("Playing", "someone", "Need atleast two players to start a race")).toBe(
			"Need atleast two players to start a race",
		);
		// And the default is still item 213's table.
		expect(bannerMessageText("Intermission", "")).toBe("Next round starting soon.");
	});

	it("falls back to Unknown for an unrecognised phase", () => {
		expect(bannerMessageText("Intermission ", "")).toBe("Unknown");
		expect(bannerMessageText("", "")).toBe("Unknown");
	});

	it("agrees with bannerWinnerText about who won", () => {
		// The two functions are read by the same refresh, so a disagreement here would print `RESULT` bulleted with one name while
		// the message named another (or nobody). Asserted as a pair rather than trusted to stay in step.
		for (const winner of ["BestDefault", "none", ""]) {
			const named = bannerWinnerText("PostGame", winner) !== "";
			const claims = bannerMessageText("PostGame", winner) !== "No winner this round.";

			expect(named).toBe(claims);
		}
	});
});
