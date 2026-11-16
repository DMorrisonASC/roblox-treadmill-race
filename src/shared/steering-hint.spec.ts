import { describe, expect, it } from "@rbxts/jest-globals";
import { steeringHintActionFor, steeringHintFadeOutAtSeconds, steeringHintScale } from "./steering-hint";
import {
	STEERING_HINT_FADE_IN_SECONDS,
	STEERING_HINT_FADE_OUT_SECONDS,
	STEERING_HINT_MIN_SCALE,
	STEERING_HINT_REFERENCE_SHORT_AXIS,
	STEERING_HINT_SECONDS,
} from "./tuning";

/**
 * The steering hint's matrix: **who is taught, when, and once.**
 *
 * Every case here is a sequence that is invisible in a single round. A hint shown on `Playing` entry rather than on the show
 * looks perfect in round one and silently withholds itself from the spectator who only starts racing in round two; a hint that
 * is re-shown on `Playing -> Playing` looks perfect until a debug restart puts it back over the countdown; and a teardown that
 * is not immediate leaves an arrow pointing at a belt that is no longer the player's.
 */

/** Rounded comparison, because `toBeCloseTo` is not dependable across this jest build (see `pickup-placement.spec.ts`). */
function rounded(value: number, places = 4): number {
	const factor = 10 ** places;

	return math.round(value * factor) / factor;
}

describe("steeringHintActionFor", () => {
	it("shows the hint to a competing player entering Playing for the first time", () => {
		expect(steeringHintActionFor("Playing", true, false)).toBe("show");
	});

	it("shows the hint to a mid-round joiner, whose first frame is already Playing", () => {
		// This is the same call as the case above, and it is stated separately because it is a different player: nothing about
		// the rule may depend on having *seen* the transition into `Playing`.
		expect(steeringHintActionFor("Playing", true, false)).toBe("show");
	});

	it("withholds the hint from a spectator and leaves the session unmarked, so their first race still gets it", () => {
		// **The two-call sequence is the assertion.** A spectator's `Playing` answers `nothing`, which leaves `shown` false on the
		// controller - and the round they actually compete in then answers `show`. Marking the session on phase entry instead
		// would return `nothing` on the second call and silence the hint exactly for the player who has never held a ball.
		expect(steeringHintActionFor("Playing", false, false)).toBe("nothing");
		expect(steeringHintActionFor("Playing", true, false)).toBe("show");
	});

	it("never replays it, whatever the phase does afterwards", () => {
		// `Playing -> Playing` is the debug restart (item 38): the competitors are rebuilt and the phase is written again. The
		// session flag is what makes that free, with no second suppression flag to keep in step.
		expect(steeringHintActionFor("Playing", true, true)).toBe("nothing");
	});

	it("tears down the moment the phase leaves Playing", () => {
		expect(steeringHintActionFor("PostGame", true, true)).toBe("teardown");
		expect(steeringHintActionFor("Waiting", true, true)).toBe("teardown");
		expect(steeringHintActionFor("Intermission", true, true)).toBe("teardown");
	});

	it("tears down the moment the player stops competing", () => {
		// An elimination during the three seconds is the case: the arrows would otherwise keep pointing at a belt the player is
		// no longer driving.
		expect(steeringHintActionFor("Playing", false, true)).toBe("teardown");
	});

	it("does nothing at all before Playing, or in Intermission after it", () => {
		expect(steeringHintActionFor("Waiting", true, false)).toBe("nothing");
		expect(steeringHintActionFor("Intermission", true, false)).toBe("nothing");
		expect(steeringHintActionFor("Intermission", false, true)).toBe("teardown");
	});

	it("does nothing for a phase this build has never heard of", () => {
		// Fail closed, like every other phase-keyed rule in the tree: an unknown value is not a reason to draw an arrow.
		expect(steeringHintActionFor("", true, false)).toBe("nothing");
		expect(steeringHintActionFor("playing", true, false)).toBe("nothing");
		expect(steeringHintActionFor("Scores", true, false)).toBe("nothing");
	});
});

describe("steeringHintFadeOutAtSeconds", () => {
	it("starts the fade-out so that the hint is gone exactly at STEERING_HINT_SECONDS", () => {
		// The fade-in is inside the three seconds, so the fade-out is the only phase that has to be subtracted: 3 - 0.5 = 2.5,
		// and 2.5 + 0.5 lands on the total. Subtracting the fade-in as well would destroy the hint at 2.75 s.
		expect(rounded(steeringHintFadeOutAtSeconds())).toBe(
			rounded(STEERING_HINT_SECONDS - STEERING_HINT_FADE_OUT_SECONDS),
		);
		expect(rounded(steeringHintFadeOutAtSeconds() + STEERING_HINT_FADE_OUT_SECONDS)).toBe(
			rounded(STEERING_HINT_SECONDS),
		);
	});

	it("leaves a hold long enough to read two arrows", () => {
		// Held from the end of the fade-in to the start of the fade-out. If this ever falls below a second the hint is a flash.
		expect(steeringHintFadeOutAtSeconds() - STEERING_HINT_FADE_IN_SECONDS).toBeGreaterThan(1);
	});
});

describe("steeringHintScale", () => {
	it("draws at the designed size from the reference axis upward", () => {
		expect(steeringHintScale(new Vector2(960, STEERING_HINT_REFERENCE_SHORT_AXIS))).toBe(1);
		expect(steeringHintScale(new Vector2(1920, 1080))).toBe(1);
	});

	it("shrinks on the logged phone viewport rather than filling a quarter of the screen", () => {
		// 750 x 381 is the viewport this round's log reports. 381 / 540 = 0.7055, i.e. a 96 px glyph drawn at 68 px - the size
		// the brief floated as an alternative to 96, and the reason the constant is a reference rather than a literal.
		expect(rounded(steeringHintScale(new Vector2(750, 381)), 3)).toBe(0.706);
	});

	it("floors at STEERING_HINT_MIN_SCALE, so a portrait phone still shows an arrow", () => {
		expect(steeringHintScale(new Vector2(750, 200))).toBe(STEERING_HINT_MIN_SCALE);
		expect(steeringHintScale(new Vector2(200, 750))).toBe(STEERING_HINT_MIN_SCALE);
	});

	it("measures the short axis, so a rotation does not change the size", () => {
		expect(steeringHintScale(new Vector2(750, 381))).toBe(steeringHintScale(new Vector2(381, 750)));
	});

	it("never exceeds 1, whatever the screen", () => {
		for (const axis of [200, 381, 540, 720, 1080, 2160]) {
			expect(steeringHintScale(new Vector2(axis * 2, axis)) <= 1).toBe(true);
			expect(steeringHintScale(new Vector2(axis * 2, axis)) >= STEERING_HINT_MIN_SCALE).toBe(true);
		}
	});
});
