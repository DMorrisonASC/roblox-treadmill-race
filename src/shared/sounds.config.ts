/**
 * The five UI sounds: their asset ids, their playback values, and the throttle rule that decides whether one may play
 * again.
 *
 * ## Why the ids are bare numbers and the prefix lives in a function
 *
 * `Sound.SoundId` is a `ContentId`, which the typings declare as `type ContentId = string;` — the engine reads the
 * `rbxassetid://` scheme, not the number, and a bare `"118488367803012"` loads nothing and fails silently. The bare
 * number is what an asset page shows a designer, though, so that is what is written down here; `soundUri` is the one
 * place the scheme is added, which is one place for it to be right.
 *
 * ## Why the throttle is per sound id
 *
 * The rule is "this sound may not restart itself more often than every `SOUND_MIN_INTERVAL_SECONDS`", not "the audio
 * system may produce a sound only that often". Two different sounds firing in the same frame — a button press and the
 * purchase it starts, most obviously — are two events and must both be heard. Only a repeat of the *same* sound is a
 * repeat.
 *
 * The bug this exists for is a round that eliminates four bodies in one tick. `settleEliminations` loops over the live
 * set, so four eliminations are four signals in one frame, and four restarts of one clip in one frame is not four
 * eliminations to the ear — it is a stutter, or one clipped transient. Collapsing them is the whole job.
 *
 * **Three of the five sounds use this: the elimination and the hit at the shared half second, and the pickup at its own
 * 0.3 s.** A click is one press and a granted purchase is already gated twice, so throttling either would swallow a
 * deliberate event rather than prevent a repeat; `shared/ui/sounds` carries that argument in full. The hit sound joined
 * the list in item 88, for the same reason the elimination sound is on it: two bodies in contact re-fire `Touched` on
 * essentially every physics step, and a crowded belt is many pairs at once, so a hit arrives in bursts by nature rather
 * than one deliberate press at a time. The predicate stays general because the *rule* is general: any future sound that
 * can fire in a burst should reach for this rather than invent a second timestamp.
 *
 * **The pickup sound was moved onto the list by a measurement, and that is worth recording because the argument against
 * it looked airtight.** Item 90 left it unthrottled on the grounds that the server fires only when the ball's speed
 * actually rose, so the one repeated case — a `recycle` ball resting on its surviving pad — would compute the same value
 * and fire nothing. The premise is false: the tick loop decays the speed between touches, so each re-touch raises
 * `11.987` to `12`, the condition passes, and a Studio log (item 91) shows nineteen collections in one rest at 14–24 ms
 * apart. **A condition that removes "nothing happened" does not remove "the same thing happened again"** — that is what
 * an interval is for. The pickup therefore has its own, shorter interval rather than the shared one: 0.3 s is enough to
 * collapse the buzz and still short enough that two real collections are two sounds.
 *
 * **Per id is what makes the two independent.** The hit and the elimination sound share
 * `SOUND_MIN_INTERVAL_SECONDS` and the map, but not an entry: a hit inside half a second of an elimination is a
 * different key in `lastPlayedAt`, so it still plays. That is the whole reason the map is keyed by asset id and not by
 * "the last sound".
 *
 * ## Where a value lives: the shape of the value, not the kind of asset
 *
 * **A value that is one string, or a small closed set of numbers, lives in this repository.** The four asset ids are the
 * obvious case and `SOUND_TUNING` below is the second: volume and playback speed are two numbers with a meaning a reader
 * can see, and an edit here is the whole of a change. The id being a repo value is also what makes replacing the clip one
 * edit, and it means nothing in Studio can drift from what the code believes it is pointing at — `tuning.ts` holds the
 * belt and ball numbers for exactly the same reason.
 *
 * **A value that is a tree, with no way to preview it from code, stays in Studio.** `ReplicatedStorage.assets.vfx.hitEffect`
 * (items 84–86) is the counter-example: a `Part` carrying an `Attachment` and one or more `ParticleEmitter`s is dozens of
 * properties — texture, colour, size and transparency sequences, lifetime, speed, spread, rotation, drag, acceleration,
 * light emission — and writing those out in TypeScript is guessing at a design nobody can see until it runs. The code
 * sets the part the round actually decided (item 84 sets the size ramp) and leaves the rest to the asset.
 *
 * **The rule is not "VFX is a pack and audio is not".** A pack of a hundred sounds would still want its ids here, because
 * each one is a single value; a *tree* of anything stays in Studio, even when the tree is audio — a `SoundGroup` with
 * effects under it, for instance, is a tree. The dividing line is the shape of the value, not the kind of asset.
 *
 * **The failures are the argument.** A name lookup into Studio is a runtime dependency on an edit somebody else can make:
 * item 84 spent two rounds on a `FindFirstChild` that silently found nothing, and a missing asset that returns nil is a
 * session with no effect and no error. A tree rebuilt in code has no designer preview, so every literal in it is a guess
 * that only shows up on screen.
 *
 * The timestamps themselves are not here: this module is pure so a spec can call `canPlay` with any two numbers. The
 * clock and the map live in `shared/ui/sounds`, which is the only thing that plays anything.
 */

/** **Placeholder.** The elimination clip. Bare asset id; `soundUri` adds the scheme. */
export const ELIMINATION_SOUND_ASSET_ID = "118488367803012";

/** **Placeholder.** The clip for a completed purchase, played by the buyer only. */
export const PURCHASE_SOUND_ASSET_ID = "98790672104771";

/** **Placeholder.** The clip for any button press. */
export const CLICK_SOUND_ASSET_ID = "132150186435903";

/**
 * The clip for one ball-ball hit, fired where the particle burst is fired.
 *
 * **Not a placeholder.** The other three ids were invented to give the paths something to play; this one is the user's
 * own upload, so it is written down as given and not marked for replacement.
 *
 * It is throttled like the elimination sound and unlike the click — see the module docblock. The throttle is per id, so
 * this sharing the interval with the elimination sound does not make the two share an entry.
 */
export const HIT_SOUND_ASSET_ID = "140025518477459";

/**
 * The clip for a pickup that raised a ball's speed.
 *
 * **Not a placeholder** — the user's upload, like the hit sound.
 *
 * **Throttled at `PICKUP_SOUND_MIN_INTERVAL_SECONDS` (0.3 s), and item 90's "not throttled" is superseded.** The argument
 * there was that the server fires only when `speedAfterPickup` raised the ball's speed, so a `recycle` ball resting on
 * its own surviving pad would compute the same value and fire nothing. The arithmetic is right and the conclusion was
 * wrong: the tick loop decays `BALL_SPEED` between touches, so "the same value" is `11.987 -> 12` and the condition is
 * true on every re-touch. A Studio log (item 91) shows nineteen collections in one rest, every 14–24 ms. The throttle is
 * the client's, in `playPickupSound`; the server still fires per raise, which is honest — the ball really is being
 * re-boosted.
 */
export const PICKUP_SOUND_ASSET_ID = "111254855668531";

/**
 * How one sound plays: the two `Sound` properties this repository decides.
 *
 * **`volume` is 0-1-ish and `playbackSpeed` is a pitch multiplier** — 1 is the clip as uploaded, 2 is an octave up and
 * half as long. Both are written on the `Sound` once, when it is built; see `soundFor` in `shared/ui/sounds`.
 */
export interface SoundTuning {
	readonly volume: number;
	readonly playbackSpeed: number;
}

/**
 * What a sound plays at when its id has no entry in `SOUND_TUNING`.
 *
 * **A missing row must not make a sound silent.** The alternative — throw, or return `undefined` and let `soundFor` assign
 * `nil` — fails as a sound with no volume rather than as a config error, which is the worst kind of failure to debug: the
 * asset looks broken. A fifth sound added without a tuning row plays, at exactly the engine's defaults, which is what it
 * would have done before this record existed.
 */
export const DEFAULT_SOUND_TUNING: SoundTuning = { volume: 1, playbackSpeed: 1 };

/**
 * **The playback values this repository decides, keyed by asset id.**
 *
 * Every id keyed here is one of the four above, and the spec asserts that: a key that does not match an id is a row
 * nothing reads, and it would leave the sound it *meant* to configure at the default — a quiet failure that looks like an
 * asset problem. The keys are the id constants rather than literals so the two cannot drift.
 *
 * **Keyed by asset id and not by sound kind**, for the reason `lastPlayedAt` is (item 88): a kind key would put the hit
 * and the elimination sound in one slot, and the round that quietened one would silently quieten the other.
 *
 * **The other three are written out at `1`/`1` rather than omitted.** Both readings are the same numbers, but the written
 * row says the values were considered and are deliberately the engine's defaults; an absent row is indistinguishable from
 * one nobody remembered, which is how a *fifth* sound gets forgotten too.
 */
export const SOUND_TUNING: Record<string, SoundTuning> = {
	[ELIMINATION_SOUND_ASSET_ID]: { volume: 1, playbackSpeed: 1 },
	[PURCHASE_SOUND_ASSET_ID]: { volume: 1, playbackSpeed: 1 },
	[CLICK_SOUND_ASSET_ID]: { volume: 1, playbackSpeed: 1 },
	// **Placeholder.** Quieter than the elimination sound, which is the loudest thing in the mix and the one a player most
	// wants to hear over a scrum of hits. The numbers are a starting point to judge in Studio, not a mix.
	[HIT_SOUND_ASSET_ID]: { volume: 0.6, playbackSpeed: 1 },
	// **Placeholder.** A reward, so louder than the hit and below the elimination sound. No pitch shift: a pickup is a
	// boost, and a clip already pitched upward by its author does not want a second multiplier on top.
	[PICKUP_SOUND_ASSET_ID]: { volume: 0.8, playbackSpeed: 1 },
};

/**
 * How one asset id should play — the only way the play path reads `SOUND_TUNING`.
 *
 * A function rather than a bare index at the call site so the unknown-id default is stated once. `soundFor` is the only
 * caller today, which is deliberately also the only place a `Sound` is constructed: one reader, one place the values are
 * applied.
 */
export function soundTuningFor(assetId: string): SoundTuning {
	return SOUND_TUNING[assetId] ?? DEFAULT_SOUND_TUNING;
}

/**
 * **Placeholder.** The shortest gap, in seconds, between two starts of the *same* sound.
 *
 * Chosen at half a second because that is roughly the point where two identical transients stop reading as one event
 * with a fault and start reading as two events. Shorter than the clip length would cut a clip into the next one; much
 * longer would swallow a genuine second elimination in a small field.
 */
export const SOUND_MIN_INTERVAL_SECONDS = 0.5;

/**
 * **Placeholder.** The shortest gap, in seconds, between two starts of the **pickup** sound.
 *
 * Shorter than the shared half second, and the number is measured rather than chosen. Item 90 assumed the server's
 * "the speed actually rose" condition already removed every repeat, and a Studio log showed it does not: a `recycle` ball
 * resting on its surviving pad re-touches it every **14–24 ms**, and between touches the tick loop decays `BALL_SPEED`
 * from `12` to about `11.98` — so every one of those touches is a real raise and a real fire. Nineteen collections in one
 * rest, roughly fifty starts a second: that is the buzz, not a pickup.
 *
 * `0.3` collapses that rest into at most three starts a second, which is fast enough that two genuinely different
 * collections still read as two events, and slow enough that a resting ball reads as a held tone rather than a machine
 * gun. It is shorter than the shared half second because a pickup is a reward a player is looking for, and being told
 * "you got one" twice in half a second is better than being told once.
 */
export const PICKUP_SOUND_MIN_INTERVAL_SECONDS = 0.3;

/**
 * The `SoundId` for an asset id: `rbxassetid://` plus the number.
 *
 * Deliberately dumb — it prefixes, it does not normalise. A caller that passes an already-prefixed id gets a doubled
 * scheme and a sound that does not load, which is the right kind of failure: the constants above are the only inputs,
 * and a second spelling of the scheme is exactly what this function exists to prevent.
 */
export function soundUri(assetId: string): string {
	return `rbxassetid://${assetId}`;
}

/**
 * Whether a sound that last started at `lastPlayedAt` may start again at `now`.
 *
 * `undefined` means "never played", which is always allowed. The comparison is `>=`, so a gap of exactly the interval is
 * allowed — the throttle is a minimum interval, not a maximum rate.
 *
 * **`minIntervalSeconds` is a parameter because one sound needs a shorter interval than the rest** (item 91, the pickup
 * sound, `PICKUP_SOUND_MIN_INTERVAL_SECONDS`). It defaults to `SOUND_MIN_INTERVAL_SECONDS`, so every caller that does not
 * care is unchanged and the shared half second stays the shared half second. The alternatives were both worse: a
 * per-sound interval map read *inside* this function would put an asset id into a predicate that today takes numbers and
 * no state, and a second predicate would be a second boundary to keep in step — this way there is one comparison and one
 * place to test it.
 *
 * Both numbers are `os.clock()` readings from the caller's own clock; nothing here reads a clock, which is what makes
 * the boundary testable with literals.
 */
export function canPlay(
	lastPlayedAt: number | undefined,
	now: number,
	minIntervalSeconds: number = SOUND_MIN_INTERVAL_SECONDS,
): boolean {
	if (lastPlayedAt === undefined) {
		return true;
	}

	return now - lastPlayedAt >= minIntervalSeconds;
}
