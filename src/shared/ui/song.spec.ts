import { describe, expect, it } from "@rbxts/jest-globals";
import { SONG_END_SECONDS, SONG_FADE_SECONDS, SONG_INTRO_END_SECONDS } from "shared/sounds.config";
import { songWrapTarget } from "./song";

/**
 * The loop rule: **the playhead wraps to the end of the intro, never to the start of the clip.**
 *
 * ## Why this is the whole point of the file
 *
 * `Sound.Looped = true` loops `0 -> TimeLength`, which replays the intro on every pass. Every other way this can go wrong —
 * a fade that ramps to the wrong level, a handle that outlives its phase — is visible in a log or on a screenshot. This one
 * is audible and nothing else: the song simply sounds subtly wrong for ever, and no build, lint or assertion about the
 * audio path would notice.
 *
 * So `songWrapTarget` is a pure function over two numbers and a boolean, and these cases pin it. What cannot be proved here
 * is that the asset is really 87 s, or that the engine's `TimePosition` behaves as documented at the boundary — both are
 * Studio observations in the round report.
 */

describe("songWrapTarget", () => {
	it("leaves the playhead alone in the middle of the loop body", () => {
		// The overwhelmingly common case: one call per frame for the length of a round.
		expect(songWrapTarget(0)).toBe(undefined);
		expect(songWrapTarget(SONG_INTRO_END_SECONDS)).toBe(undefined);
		expect(songWrapTarget(42)).toBe(undefined);
		expect(songWrapTarget(SONG_END_SECONDS - 0.001)).toBe(undefined);
	});

	it("wraps to the intro's end at the clip's end, and not to zero", () => {
		// **Criterion 3, and the single most important assertion in this repository's audio code.** `0` here would be a
		// working song that replays its intro every 82 seconds.
		expect(songWrapTarget(SONG_END_SECONDS)).toBe(SONG_INTRO_END_SECONDS);
		expect(songWrapTarget(SONG_END_SECONDS + 0.5)).toBe(SONG_INTRO_END_SECONDS);

		// Stated as a difference from zero as well, so an edit that changed `SONG_INTRO_END_SECONDS` to `0` fails here rather
		// than passing a comparison that only mentions the constant.
		expect(SONG_INTRO_END_SECONDS > 0).toBe(true);
	});

	it("leaves a freshly built sound alone, which is what keeps the intro audible", () => {
		// **The bug this replaces, kept as an assertion because it is the one that would have shipped.** An earlier version of
		// this function took an `isPlaying` flag and re-seated whenever it was false, on the theory that a dropped frame could
		// leave the sound stopped. But a `Sound` that has not finished loading reports `IsPlaying = false` **and**
		// `TimePosition = 0`, so every frame of the load would have jumped the playhead to the loop start: the song would open
		// at `0:05` and the intro would never be heard. The stopped case belongs to `Sound.Ended`, which fires only on real
		// completion; `songWrapTarget` now refuses to answer for a playhead that has not moved.
		expect(songWrapTarget(0)).toBe(undefined);
		expect(songWrapTarget(0.001)).toBe(undefined);
	});

	it("keeps the intro shorter than the loop body, which the wrap's meaning depends on", () => {
		// A typo that put the intro past the end would make every wrap a jump *backwards* past the clip's start: the sound
		// would restart, and nothing else in the tree would notice.
		expect(SONG_INTRO_END_SECONDS < SONG_END_SECONDS).toBe(true);
	});

	it("keeps the fade shorter than the loop body, so a fade can finish inside one pass", () => {
		// The fade-out is scheduled for `SONG_FADE_SECONDS` after the phase change. A fade longer than the loop body would
		// still work, but it would mean the last thing a round does spans a wrap, which is the interaction the module docblock
		// says the fade wins — worth pinning so a tuning edit cannot make that sentence quietly false.
		expect(SONG_FADE_SECONDS < SONG_END_SECONDS - SONG_INTRO_END_SECONDS).toBe(true);
		expect(SONG_FADE_SECONDS).toBe(2);
	});
});
