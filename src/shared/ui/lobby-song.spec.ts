import { describe, expect, it } from "@rbxts/jest-globals";
import {
	LOBBY_SONG_ASSET_IDS,
	LOBBY_SONG_MIN_SPAN_SECONDS,
	LOBBY_SONG_TAIL_CUTOFF_SECONDS,
} from "shared/sounds.config";
import { drawLobbyStart, pickLobbySong } from "./lobby-song";

/**
 * The lobby song's two random rules: **where the first pass starts**, and **which clip it starts in**.
 *
 * ## Why these are worth a spec and the numbers are not
 *
 * Every other part of the lobby song is visible when it is wrong: a fade that does not happen is heard, a missing asset
 * logs, a controller that outlives its phase leaves two `Sound` instances in `SoundService`. The draw is different — it is
 * correct *almost always*, and the ways it can be wrong are all quiet: a start past the ceiling (one round in a hundred, on
 * a boundary only the loop would notice), a start of exactly `0` on every clip (every round opening the same way, exactly
 * the thing the random start exists to prevent), or a draw taken before the clip loads (silence, indistinguishable from a
 * broken asset).
 *
 * So the arithmetic is pinned against literals with an injected `random`, and what cannot be proved here — that either
 * upload loads, that a mid-phrase start reads as intentional rather than as a bug — is a Studio observation in the report.
 *
 * The three cases the brief names are the first three `it`s: `start = maxStart` yields exactly `minSpan`, a length of
 * `tailCutoff + minSpan - epsilon` is refused, and a drawn start never exceeds `maxStart`.
 */

describe("drawLobbyStart", () => {
	it("cuts the tail, and says so with the ceiling it returns", () => {
		// The ceiling is the number the loop wraps at, and it is returned rather than recomputed by the caller so the loop and
		// the draw cannot disagree about where the song ends. 60 s with a 5 s tail is 55 s of playable clip.
		const drawn = drawLobbyStart(60, 5, 10, () => 0);

		expect(drawn).toBeDefined();
		if (drawn === undefined) {
			return;
		}

		expect(drawn.ceiling).toBe(55);

		// The tail is never played: the wrap instant is strictly inside the clip, and by exactly the cutoff. Stated as a
		// difference rather than as `toBe(55)` alone, so a change to the cutoff fails here instead of moving the ceiling
		// silently with it.
		expect(60 - drawn.ceiling).toBe(5);
	});

	it("draws across the whole legal range, and pins both of its ends", () => {
		// `maxStart = ceiling - minSpan = 55 - 10 = 45`, so a start is uniform over `[0, 45]`.
		const smallest = drawLobbyStart(60, 5, 10, () => 0);
		const largest = drawLobbyStart(60, 5, 10, () => 1);
		const middle = drawLobbyStart(60, 5, 10, () => 0.5);

		expect(smallest?.start).toBe(0);
		expect(middle?.start).toBe(22.5);
		expect(largest?.start).toBe(45);
	});

	it("gives exactly minSpan when the draw lands on maxStart", () => {
		// **The first boundary the brief names.** `random() = 1` is the largest draw the range allows, and it has to leave the
		// first pass *exactly* at the floor: one more and the clip would open inside the region the rule reserves, and the
		// brief's "at least 10 s" would be a number nothing enforced.
		//
		// Stated on integers because this is an exactness claim: `a - (a - b)` is `b` in binary floating point only where the
		// subtraction does not round, and 55/10 is one of those places. The non-round cases are covered by the range assertion
		// below, which uses `>=` for that reason rather than pretending floats are decimals.
		const drawn = drawLobbyStart(60, 5, 10, () => 1);

		expect(drawn).toBeDefined();
		if (drawn === undefined) {
			return;
		}

		expect(drawn.ceiling - drawn.start).toBe(LOBBY_SONG_MIN_SPAN_SECONDS);
		expect(drawn.ceiling - drawn.start).toBe(10);
	});

	it("never draws past maxStart or before zero, whatever the random source returns", () => {
		// The sweep is the reason the draw is clamped rather than trusted: Luau's `math.random()` is `[0, 1)`, but the parameter
		// is any `() => number`, and a caller that handed in a `math.random(0, n)`-shaped closure would get `1` back about
		// `1/(n+1)` of the time. `1.5` and `-0.25` are not sources anyone intends to pass and are exactly the inputs that
		// prove the bounds are inside the function rather than in its caller's good behaviour.
		const randoms = [-0.25, 0, 0.01, 0.5, 0.99, 1, 1.5];

		for (const value of randoms) {
			const drawn = drawLobbyStart(60, 5, 10, () => value);
			expect(drawn).toBeDefined();
			if (drawn === undefined) {
				return;
			}

			expect(drawn.start >= 0).toBe(true);
			expect(drawn.start <= drawn.ceiling - LOBBY_SONG_MIN_SPAN_SECONDS).toBe(true);

			// And the first pass honours the floor at every draw, which is the property the clamp exists to protect.
			expect(drawn.ceiling - drawn.start >= LOBBY_SONG_MIN_SPAN_SECONDS - 0.000001).toBe(true);
		}
	});

	it("refuses a clip shorter than the tail plus the floor", () => {
		// **The second boundary the brief names, and the one that turns a broken `Play()` into a logged skip.** `14.999` gives a
		// ceiling of `9.999` and a `maxStart` of `-0.001`: no start satisfies both rules, so there is no clamp that could.
		expect(
			drawLobbyStart(LOBBY_SONG_TAIL_CUTOFF_SECONDS + LOBBY_SONG_MIN_SPAN_SECONDS - 0.001, 5, 10, () => 0),
		).toBe(undefined);

		// Exactly at the sum is refused too, and that is a decision rather than an oversight: a `maxStart` of `0` is a draw
		// range of zero width, i.e. a "random" start that is always the same one. Silence is more honest than a fictional
		// randomisation. See `drawLobbyStart`.
		expect(drawLobbyStart(LOBBY_SONG_TAIL_CUTOFF_SECONDS + LOBBY_SONG_MIN_SPAN_SECONDS, 5, 10, () => 0)).toBe(
			undefined,
		);

		// A hair above it is legal, and the range is the hair — so the refusal is a boundary and not a blanket. The excess is
		// `0.5` rather than `0.02` because every assertion below has to be exact: `15.5 - 5` and `10.5 - 10` are exact in binary
		// floating point, where `10.02 - 10` is `0.019999999999999574` and a `toBe` on it would fail for a reason that has
		// nothing to do with the rule.
		const barely = drawLobbyStart(
			LOBBY_SONG_TAIL_CUTOFF_SECONDS + LOBBY_SONG_MIN_SPAN_SECONDS + 0.5,
			5,
			10,
			() => 1,
		);
		expect(barely).toBeDefined();
		expect(barely?.ceiling).toBe(10.5);
		expect(barely?.start).toBe(0.5);
	});

	it("refuses an unloaded clip, which is the whole reason the caller waits for Loaded", () => {
		// **The failure this module is shaped around, as a test.** `Sound.TimeLength` is `0` until the asset arrives, so a draw
		// taken one frame too early is `drawLobbyStart(0, ...)` — a ceiling of `-5` and a refusal. That is deliberately the same
		// branch as the short clip, because it is the same fact: the clip cannot hold a first pass. The alternative, clamping to
		// `0`, would be a `Play()` at the top of the clip that looks for all the world like a working song.
		expect(drawLobbyStart(0, 5, 10, () => 0.5)).toBe(undefined);

		// And the real constants, so the numbers this ships with are the ones exercised.
		expect(drawLobbyStart(0, LOBBY_SONG_TAIL_CUTOFF_SECONDS, LOBBY_SONG_MIN_SPAN_SECONDS, () => 0.5)).toBe(
			undefined,
		);
	});
});

describe("pickLobbySong", () => {
	it("picks from the configured pair and nothing else", () => {
		// The ids come from the config, not from a literal here: a test that hard-coded them would pass while the picker and
		// the boot check read two different arrays.
		expect(LOBBY_SONG_ASSET_IDS.size()).toBe(2);
		expect(pickLobbySong(LOBBY_SONG_ASSET_IDS, () => 0)).toBe(LOBBY_SONG_ASSET_IDS[0]);
		expect(pickLobbySong(LOBBY_SONG_ASSET_IDS, () => 0.99)).toBe(LOBBY_SONG_ASSET_IDS[1]);
	});

	it("clamps an out-of-range index to the last element", () => {
		// `math.floor(1 * 2)` is `2`, which is not an index of a two-element array — the one way this arithmetic can be wrong,
		// and it is wrong by one element, so it would surface as a rare "no music" rather than as a crash. Negative is the same
		// guard from the other end.
		expect(pickLobbySong(LOBBY_SONG_ASSET_IDS, () => 1)).toBe(LOBBY_SONG_ASSET_IDS[1]);
		expect(pickLobbySong(LOBBY_SONG_ASSET_IDS, () => -0.5)).toBe(LOBBY_SONG_ASSET_IDS[0]);
	});

	it("answers undefined when every asset is missing", () => {
		// Both uploads failing to fetch leaves nothing to pick, and the controller's response is one line and silence. An empty
		// array is also what a future "the picker skips a missing id" leaves behind when *everything* was skipped, so this is the
		// live case rather than a hypothetical.
		expect(pickLobbySong([], () => 0.5)).toBe(undefined);
	});
});
