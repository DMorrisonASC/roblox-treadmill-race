import { describe, expect, it } from "@rbxts/jest-globals";
import { formatClock, phaseHasClock, REFUSAL_NEED_PLAYERS } from "./round-status";

/**
 * The banner's clock and its refusal string (item 214).
 *
 * `formatClock` is pure arithmetic on a number, so the format is assertable without a `DataModel`. What it cannot prove is whether
 * `1:47` is legible at `h6` size over a bright sky - that is a screenshot.
 */
describe("formatClock", () => {
	it("formats minutes and seconds, with a padded second", () => {
		expect(formatClock(7)).toBe("0:07");
		expect(formatClock(80)).toBe("1:20");
		expect(formatClock(120)).toBe("2:00");
		expect(formatClock(59)).toBe("0:59");
		expect(formatClock(60)).toBe("1:00");
	});

	it("rounds up, so a clock never reads 0:00 while time remains", () => {
		// **The reason it is `ceil` and not `floor`.** A deadline 0.4 s away still has time left; flooring would print `0:00` for a
		// whole second before the phase changed, which reads as a stuck clock rather than as a race about to end.
		expect(formatClock(0.4)).toBe("0:01");
		expect(formatClock(0.0001)).toBe("0:01");
	});

	it("clamps a passed deadline to 0:00 rather than counting negative", () => {
		// A past deadline happens between the server's transition and this client's next frame; `-0:01` would be a visible glitch.
		expect(formatClock(-1)).toBe("0:00");
		expect(formatClock(-100)).toBe("0:00");
		expect(formatClock(0)).toBe("0:00");
	});

	it("never prints an unpadded minute", () => {
		// `0:07`, not `00:07`: the leading zero is noise for a clock that never exceeds two digits.
		expect(formatClock(7).size()).toBe(4);
		expect(formatClock(125).size()).toBe(4);
	});
});

describe("phaseHasClock", () => {
	it("runs in the two phases the designer named", () => {
		expect(phaseHasClock("Intermission")).toBe(true);
		expect(phaseHasClock("Playing")).toBe(true);
	});

	it("stays off in the phases that already have a clock or are too short", () => {
		// `Waiting` has the 3-2-1 (`CountdownController`) over the same span - two clocks there would disagree by a frame - and
		// `PostGame` is five seconds.
		expect(phaseHasClock("Waiting")).toBe(false);
		expect(phaseHasClock("PostGame")).toBe(false);
		expect(phaseHasClock("")).toBe(false);
		expect(phaseHasClock("intermission")).toBe(false);
	});
});

describe("REFUSAL_NEED_PLAYERS", () => {
	it("is the designer's string, spelling included", () => {
		// **`atleast` as one word is deliberate.** It is user-facing text the designer wrote; correcting it here would change what a
		// player reads to satisfy a style guide nobody asked the string to match.
		expect(REFUSAL_NEED_PLAYERS).toBe("Need atleast two players to start a race");
	});
});
