import { describe, expect, it } from "@rbxts/jest-globals";
import {
	canPlay,
	CLICK_SOUND_ASSET_ID,
	COIN_SOUND_ASSET_ID,
	DEFAULT_SOUND_TUNING,
	ELIMINATION_SOUND_ASSET_ID,
	HIT_SOUND_ASSET_ID,
	LOBBY_SONG_A_ASSET_ID,
	LOBBY_SONG_ASSET_IDS,
	LOBBY_SONG_B_ASSET_ID,
	PICKUP_SOUND_ASSET_ID,
	PICKUP_SOUND_MIN_INTERVAL_SECONDS,
	PURCHASE_SOUND_ASSET_ID,
	SONG_ASSET_ID,
	SOUND_MIN_INTERVAL_SECONDS,
	SOUND_TUNING,
	soundTuningFor,
	soundUri,
} from "./sounds.config";

/**
 * The three rules a spec can prove about the sound config: the scheme is added in exactly one place, the throttle's
 * boundary is where it says it is, and every id answers with playback values.
 *
 * Nothing here can prove a sound is audible, or that 0.8 is the right volume for the coin — that is Studio's job. What it
 * can prove is the arithmetic and the tables the audio code is built on, so a later edit cannot quietly turn "half a
 * second" into "half a minute" or a missing tuning row into a silent sound.
 */
const ALL_IDS: ReadonlyArray<string> = [
	ELIMINATION_SOUND_ASSET_ID,
	PURCHASE_SOUND_ASSET_ID,
	CLICK_SOUND_ASSET_ID,
	HIT_SOUND_ASSET_ID,
	PICKUP_SOUND_ASSET_ID,
	COIN_SOUND_ASSET_ID,
	SONG_ASSET_ID,
	LOBBY_SONG_A_ASSET_ID,
	LOBBY_SONG_B_ASSET_ID,
];

/** The ids that deliberately keep the engine's defaults, so a tuning row that drifts fails here rather than in the mix. */
const DEFAULT_TUNED_IDS: ReadonlyArray<string> = [
	ELIMINATION_SOUND_ASSET_ID,
	PURCHASE_SOUND_ASSET_ID,
	CLICK_SOUND_ASSET_ID,
];

describe("sounds.config", () => {
	it("prefixes an asset id with the rbxassetid scheme", () => {
		expect(soundUri("118488367803012")).toBe("rbxassetid://118488367803012");
		expect(soundUri("98790672104771")).toBe("rbxassetid://98790672104771");
	});

	it("turns the real hit id into the uri the engine loads", () => {
		// The one id in the file that is not a placeholder — it is the user's upload, so pinning it is worth a line: a
		// digit lost in a copy or a scheme added by hand are both silent failures at runtime and both fail here.
		expect(HIT_SOUND_ASSET_ID).toBe("140025518477459");
		expect(soundUri(HIT_SOUND_ASSET_ID)).toBe("rbxassetid://140025518477459");
	});

	it("turns the real pickup id into the uri the engine loads", () => {
		// Same reasoning as the hit id: the user's upload, and one digit is all that stands between a sound and silence.
		expect(PICKUP_SOUND_ASSET_ID).toBe("111254855668531");
		expect(soundUri(PICKUP_SOUND_ASSET_ID)).toBe("rbxassetid://111254855668531");
	});

	it("turns the real coin id into the uri the engine loads", () => {
		// The third of the user's own uploads, and the one item 138 added. Pinned digit for digit because the asset id is
		// quoted from a chat message: a transposed pair loads a different asset, or nothing, and reports no error either way.
		expect(COIN_SOUND_ASSET_ID).toBe("79302475372626");
		expect(soundUri(COIN_SOUND_ASSET_ID)).toBe("rbxassetid://79302475372626");
	});

	it("turns the round song's id into the uri the engine loads", () => {
		// The same argument as the other two user uploads, and it matters more here: a music bed that fails to load is a round
		// of silence with no error, and the loop points would be the first thing blamed.
		expect(SONG_ASSET_ID).toBe("130554552490423");
		expect(soundUri(SONG_ASSET_ID)).toBe("rbxassetid://130554552490423");
	});

	it("gives the round song a tuning row, which is the fade's target", () => {
		// Criterion 2. The row is not decoration: `createSongHandle` reads `sound.Volume` back **after** `buildSound` applied
		// this row and ramps the fade to *that*, so a missing row would silently ramp to `1.0` — a music bed at effect level,
		// which is the loudest possible failure of a mix and the quietest possible failure of a config.
		const song = soundTuningFor(SONG_ASSET_ID);

		expect(song).toEqual({ volume: 0.35, playbackSpeed: 1 });
		expect(song.volume < DEFAULT_SOUND_TUNING.volume).toBe(true);

		// No pitch shift, and this is load-bearing rather than tidy: `playbackSpeed` scales wall-clock time, so a value other
		// than 1 would invalidate both loop points without changing either constant.
		expect(song.playbackSpeed).toBe(1);
	});

	it("keeps the nine ids bare and distinct", () => {
		// The constants must not carry the scheme themselves: `soundUri` is the one place it is written, and a constant
		// that already had it would produce `rbxassetid://rbxassetid://…` at the only call site.
		//
		// Typed as `string` deliberately: the constants are literal types, and comparing two different literals with
		// `!==` is a compile error ("no overlap"), which is the compiler being right about a test that is trying to
		// restate what the file already says. Counting distinct strings through a set is the same claim without it.
		const ids = ALL_IDS;

		const distinct = new Set<string>();
		for (const id of ids) {
			const [schemeAt] = id.find("rbxassetid");
			expect(schemeAt).toBe(undefined);
			expect(id.size() > 0).toBe(true);
			distinct.add(id);
		}

		expect(distinct.size()).toBe(ids.size());
	});

	it("allows a sound that has never played", () => {
		expect(canPlay(undefined, 0)).toBe(true);
		expect(canPlay(undefined, 1234.5)).toBe(true);
	});

	it("refuses a repeat inside the interval and allows one at exactly the interval", () => {
		expect(canPlay(10, 10)).toBe(false);
		expect(canPlay(10, 10.2)).toBe(false);
		expect(canPlay(10, 10.499)).toBe(false);
		expect(canPlay(10, 10.5)).toBe(true);
		expect(canPlay(10, 11)).toBe(true);
	});

	it("uses the interval it is given, and the shared one by default", () => {
		// The third parameter exists for the pickup sound (item 91). The same numbers answer differently at 0.3 s — that is
		// the whole point — and the default keeps the shared half second for every caller that does not pass one.
		expect(canPlay(10, 10.25, 0.3)).toBe(false);
		expect(canPlay(10, 10.3, 0.3)).toBe(true);

		// A quarter of a second is inside the shared interval and outside the pickup's, which is what tells the two rules
		// apart in one assertion pair.
		expect(canPlay(10, 10.25)).toBe(false);
		expect(canPlay(10, 10.25, PICKUP_SOUND_MIN_INTERVAL_SECONDS)).toBe(false);
		expect(canPlay(10, 10.3, PICKUP_SOUND_MIN_INTERVAL_SECONDS)).toBe(true);
	});

	it("uses a half-second interval unless the constant says otherwise", () => {
		// Pinned so the boundary tests above cannot pass against a constant that moved underneath them.
		expect(SOUND_MIN_INTERVAL_SECONDS).toBe(0.5);
		expect(canPlay(0, SOUND_MIN_INTERVAL_SECONDS - 0.001)).toBe(false);
		expect(canPlay(0, SOUND_MIN_INTERVAL_SECONDS)).toBe(true);
	});

	it("plays the hit sound quieter than everything else", () => {
		// Criterion 2. The numbers themselves are a starting point rather than a mix — what this pins is that the hit id
		// has an entry at all and that it is the quiet one, so a later "tidy" that drops the row or copies the default
		// fails here instead of on a player's ears.
		const hit = soundTuningFor(HIT_SOUND_ASSET_ID);

		expect(hit).toEqual({ volume: 0.6, playbackSpeed: 1 });
		expect(hit.volume < DEFAULT_SOUND_TUNING.volume).toBe(true);
	});

	it("leaves the click, purchase and elimination at the engine's defaults", () => {
		// Criterion 5, plus item 89's promise: nothing that already existed changes behaviour. These three rows exist to be
		// *seen* as considered, and they must stay equal to the default — the failure this guards is a round that quietens
		// one sound by editing the wrong row.
		for (const id of DEFAULT_TUNED_IDS) {
			expect(soundTuningFor(id)).toEqual(DEFAULT_SOUND_TUNING);
		}
	});

	it("gives the pickup sound an entry of its own", () => {
		// The fifth row, which is the one a `Record<string, …>` would silently do without: an absent row plays at 1/1 and
		// looks perfectly correct, so the **Placeholder.** numbers would never be reached and nothing would say why.
		expect(soundTuningFor(PICKUP_SOUND_ASSET_ID)).toEqual({ volume: 0.8, playbackSpeed: 1 });

		// And it is a distinct row from the hit sound's, not a shared one: a kind-keyed record would put both in one slot,
		// and the two volumes differing is what shows they did not. (`jest-roblox` has no `.not`, so the difference is
		// asserted by the values rather than by negating an equality.)
		expect(soundTuningFor(PICKUP_SOUND_ASSET_ID).volume).toBe(0.8);
		expect(soundTuningFor(HIT_SOUND_ASSET_ID).volume).toBe(0.6);
	});

	it("gives the coin sound an entry of its own", () => {
		// The sixth row, and the one this round added. The failure this guards is the one item 89 named: an absent row plays
		// at 1/1 and looks perfectly correct, so a **Placeholder.** volume would never be reached and nothing would say why.
		expect(soundTuningFor(COIN_SOUND_ASSET_ID)).toEqual({ volume: 0.8, playbackSpeed: 1 });

		// Distinct from the pickup row it currently shares a volume with: a kind-keyed record would put "reward" in one slot,
		// so the assertion is that editing one leaves the other alone.
		expect(soundTuningFor(COIN_SOUND_ASSET_ID)).toEqual(soundTuningFor(PICKUP_SOUND_ASSET_ID));
		expect(soundTuningFor(COIN_SOUND_ASSET_ID).volume).toBe(0.8);
	});

	it("gives both lobby songs an entry below the round song's", () => {
		// The eighth and ninth rows, added with the lobby song (item 157). Two things are pinned here and neither is the
		// number itself: that both ids have a row at all (an absent row plays at 1/1, which is *louder* than the round song
		// and the opposite of the intent), and that both sit strictly below the round song's volume, which is the claim the
		// brief makes about a lobby being quieter than a race.
		const song = soundTuningFor(SONG_ASSET_ID);
		const a = soundTuningFor(LOBBY_SONG_A_ASSET_ID);
		const b = soundTuningFor(LOBBY_SONG_B_ASSET_ID);

		expect(a.volume < song.volume).toBe(true);
		expect(b.volume < song.volume).toBe(true);

		// No pitch shift, which for these two is load-bearing rather than tidy: a `playbackSpeed` other than 1 rescales
		// wall-clock time, and the random start and the loop ceiling are both derived from `Sound.TimeLength`, which does
		// not rescale with it. A pitched clip would loop five *pitched* seconds from its end.
		expect(a.playbackSpeed).toBe(1);
		expect(b.playbackSpeed).toBe(1);

		// Distinct keys rather than one shared row: a kind-keyed record would put both lobby songs in one slot and the first
		// person to balance one clip against the other would find they could not.
		const rows = new Set<string>();
		for (const id of LOBBY_SONG_ASSET_IDS) {
			rows.add(id);
			expect(soundTuningFor(id).playbackSpeed).toBe(1);
		}
		expect(rows.size()).toBe(2);
	});

	it("answers an id it has never heard of with the default", () => {
		// The forward-compatibility property: a fifth sound added later without a tuning row still plays, at 1/1, rather
		// than arriving silent because the lookup threw or answered `nil`. The near-miss id is deliberate — a lookup that
		// matched on a prefix would pass a completely unrelated string and fail this one.
		expect(soundTuningFor("140025518477458")).toBe(DEFAULT_SOUND_TUNING);
		expect(soundTuningFor("")).toBe(DEFAULT_SOUND_TUNING);
	});

	it("keys every tuning row by one of the nine real ids", () => {
		// A key that is not an id is a row nothing reads, and the sound it meant to configure stays at the default — the
		// quietest possible failure. Counting as well as checking membership catches both directions: a stray key and a
		// missing row.
		const known = new Set<string>();
		for (const id of ALL_IDS) {
			known.add(id);
		}

		let rows = 0;
		for (const [key] of pairs(SOUND_TUNING)) {
			rows++;
			expect(known.has(key)).toBe(true);
		}

		expect(rows).toBe(ALL_IDS.size());
	});
});
