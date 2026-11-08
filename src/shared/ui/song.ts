import { RunService, TweenService } from "@rbxts/services";
import {
	SONG_ASSET_ID,
	SONG_END_SECONDS,
	SONG_FADE_SECONDS,
	SONG_INTRO_END_SECONDS,
	soundTuningFor,
} from "shared/sounds.config";
import { buildSound } from "./sounds";

/**
 * The round song: **one `Sound` with a lifetime**, which is a different kind of thing from every other sound in this tree.
 *
 * ## Why this is not in `shared/ui/sounds.ts`
 *
 * Everything in that file is a *player*: an event arrives, an asset id is handed to `play`, and the call is over before it
 * returns. `PlayLocalSound` even copies the instance, so the caller never owns anything. Six sounds work that way and none of
 * them needs to know when it stops.
 *
 * This one is the opposite on every axis. It is **started** rather than fired, its `Volume` is animated rather than read from
 * a table at construction, its `TimePosition` is *moved* (that is what a non-default loop is), and it is **destroyed** rather
 * than left to finish. Bolting that onto `shared/ui/sounds` would give the event module a lifecycle it was never designed
 * for, and the next reader of `playClickSound` would have to skip past a player that runs for a minute and a half.
 *
 * What is *shared* is the part that must not be duplicated: the id, the tuning row, and the single construction site. So
 * `buildSound` is imported rather than copied, and this file owns nothing but the lifecycle.
 *
 * ## Why the loop is arithmetic and not `Sound.Looped`
 *
 * `Looped = true` loops **the whole clip**: `0 → TimeLength`. That replays the intro on every pass, and the intro is not part
 * of the loop — the loop body is `SONG_INTRO_END_SECONDS → SONG_END_SECONDS`. It is therefore `Looped = false` and a playhead
 * wrap, which is the one line a naive implementation gets wrong and the one thing no build error, no log and no test of the
 * *engine* would ever report: the song would simply sound subtly wrong for ever.
 *
 * **The engine has a feature for this and it is deliberately not used.** `@rbxts/types` declares `Sound.LoopRegion`
 * (*"a range denoting a desired loop start and loop end within the `PlaybackRegion`"*), `Sound.PlaybackRegion` and
 * `Sound.PlaybackRegionsEnabled`. If `LoopRegion` behaves as its name suggests, it replaces this whole file's wrap with one
 * property assignment. The typings give the signature and **not the semantics** — whether the *first* pass starts at
 * `LoopRegion.Min` (which would skip the intro entirely) or plays from `0` and only afterwards loops inside the region — and
 * that cannot be checked without a Studio session. Guessing wrong is silent in both directions, so the arithmetic stays and
 * the successor is named here instead.
 *
 * ## Why the fade-out owns the playhead while it runs
 *
 * Two things want to write `TimePosition`: the wrap and nothing else, until the fade-out begins. Once it begins, a wrap would
 * yank the playhead to the top of the loop body **while the volume is on its way to zero**, which turns a smooth tail into an
 * audible jump-cut in the last two seconds of the round. The tick therefore returns immediately while fading, and the fade
 * wins because it is the last thing a round does: the sound is destroyed at zero volume a fixed two seconds later, so nothing
 * downstream of the wrap can be heard anyway.
 */

/** What the round song's owner may do to it. Deliberately tiny: start it, end it, or throw it away. */
export interface SongHandle {
	/** The instance, exposed for the one thing a caller might log and nothing else. */
	readonly sound: Sound;
	/** From silence: playhead at `0`, volume at `0`, a `SONG_FADE_SECONDS` ramp to the tuned volume. */
	play(): void;
	/** From wherever the volume is now, a `SONG_FADE_SECONDS` ramp to `0`, then destruction. */
	startFadeOut(onDestroyed?: () => void): void;
	/** Immediately: stop, disconnect, destroy. Safe to call twice, and safe to call after a fade. */
	destroy(): void;
	isFadingOut(): boolean;
	isDestroyed(): boolean;
}

/**
 * Where the playhead should jump to this frame, or `undefined` to leave it alone.
 *
 * ## Why this is a separate, pure function
 *
 * It is the whole of the loop rule, and the loop rule is the part that is invisible when it is wrong. Extracted, it can be
 * asserted with one number and no `Sound` at all — which matters because `song.spec.ts` has no audio device, and because a
 * spec that needed a `Sound` to check a comparison would end up asserting nothing.
 *
 * ## Why it takes only the position, and not "is it still playing"
 *
 * An earlier version took a `playing` flag so that a stopped sound could be re-seated from here, on the theory that a dropped
 * frame could land past the end. **That would have been a bug, and it is the kind that skips the intro rather than losing a
 * note.** A freshly built `Sound` reports `IsPlaying = false` and `TimePosition = 0` until its asset has loaded — so a tick
 * that treated "not playing" as "finished" would re-seat to `SONG_INTRO_END_SECONDS` on every frame of the load, and the song
 * would begin at `0:05` with the intro never heard. Nothing in the typings bounds how long that window is.
 *
 * The sentinel case is therefore handled where the engine reports it precisely: `Sound.Ended`, which fires when playback
 * genuinely completes and nowhere else. This function only answers the question the frame loop can ask safely — "has the
 * playhead reached the end of the loop body" — and a caller must not call it while the fade-out is running (see the module
 * docblock).
 */
export function songWrapTarget(timePosition: number): number | undefined {
	if (timePosition >= SONG_END_SECONDS) {
		return SONG_INTRO_END_SECONDS;
	}

	return undefined;
}

/**
 * Builds the song's `Sound` and returns the handle that owns it.
 *
 * One per client, one per round: the caller (a controller) creates exactly one when `Playing` is observed and destroys it
 * when the phase leaves, so two songs existing at once is a caller bug rather than something this factory guards against.
 *
 * ## The fade is `TweenService` on `Volume`, and the loop is `RenderStepped`
 *
 * Two animation mechanisms, chosen for two different reasons:
 *
 * - **The fades are tweens** because a tween is owned by the instance it drives: it is cancelled explicitly and it dies with
 *   the `Sound`, so there is no connection left to leak. A per-frame `Volume` write would need a second `RunService`
 *   connection that has to be disconnected on *every* path — and the paths are a phase change, a debug restart, a fade that
 *   completes, and a fade interrupted by a reset. Four chances to leak one connection per round, for a ramp the engine
 *   already interpolates on its own clock.
 * - **The wrap is a per-frame check** because it cannot be a tween: it is a *threshold on a value the engine owns*, and the
 *   frame it crosses is not knowable in advance. `RenderStepped` rather than `Heartbeat` because the wrap's whole job is to
 *   stop the tail being heard — `Heartbeat` runs after the physics step and `RenderStepped` immediately before the frame is
 *   presented, so of the two per-frame signals this is the one that gets to fix the playhead later. The difference is a
 *   fraction of a frame, but the failure it is guarding is literally one audible frame of the wrong audio.
 *
 * One connection, disconnected in `destroy()` and nowhere else — `destroy()` is the only way out, including the fade's own
 * completion, so there is one disconnect site and no path that forgets it.
 *
 * ## Why `Play()` comes before the seek in the wrap
 *
 * The typings document `Play()` as *"Plays the `Sound`"* and say nothing about what it does to `TimePosition`; the engine
 * resets the playhead when playback restarts from a stopped state. Rather than depend on which, the restart path calls
 * `Play()` first and writes `TimePosition` second, so the write is the last word either way. The alternative — trusting the
 * order — is the kind of engine detail this repository has been wrong about before, and its failure mode here is replaying
 * the intro, which is exactly the mistake the loop points exist to prevent.
 *
 * ## The load window, which is why the tick never asks "is it still playing"
 *
 * A `Sound` whose asset has not arrived reports `IsPlaying = false` and `TimePosition = 0`. A frame loop that read that as
 * "finished, restart it" would seek to `SONG_INTRO_END_SECONDS` on every frame until the asset loaded, and the round would
 * open at `0:05` with the intro silently skipped — the one failure this whole file exists to prevent, caused by the guard
 * against a different one. So `started` gates the tick (nothing may act before `play()`), and the stopped case is left to
 * `Sound.Ended`, which the engine fires on real completion and never on a pending load.
 */
export function createSongHandle(): SongHandle {
	// `buildSound` applies the tuning row, so this instance's `Volume` is the tuned target the moment it exists. It is read
	// **before** being zeroed below, and it is the fade's destination — which is what keeps `SOUND_TUNING` the only knob.
	const sound = buildSound(SONG_ASSET_ID);
	const targetVolume = soundTuningFor(SONG_ASSET_ID).volume;

	// The engine's loop is the wrong loop: it is `0 -> end`, which replays the intro. See the module docblock.
	sound.Looped = false;
	// `PlaybackRegion`/`LoopRegion` are opt-in and stay off: the *default* region is the whole clip, which is what the
	// arithmetic here assumes, and enabling the feature would put a second, silent controller over the playhead.
	sound.PlaybackRegionsEnabled = false;
	sound.Volume = 0;
	sound.TimePosition = 0;

	let fadingOut = false;
	let destroyed = false;
	/**
	 * Whether `play()` has been called.
	 *
	 * **The tick must not act before playback has been asked for.** The connection is made in the factory and `play()` is the
	 * caller's first act, which is normally the same synchronous block — but "normally" is not a guarantee, and a tick that
	 * ran first would seek a never-started sound to the loop start and skip the intro. One boolean against a class of bug
	 * that is silent.
	 */
	let started = false;
	let fadeIn: Tween | undefined;
	let fadeOut: Tween | undefined;

	const seekToLoopStart = () => {
		// `Play()` first, then the write — see the docblock. A stopped sound restarted this way never begins at `0`.
		if (!sound.IsPlaying) {
			sound.Play();
		}
		sound.TimePosition = SONG_INTRO_END_SECONDS;
	};

	const destroyNow = () => {
		if (destroyed) {
			return;
		}

		destroyed = true;

		tick.Disconnect();
		ended.Disconnect();

		if (fadeIn !== undefined) {
			fadeIn.Cancel();
			fadeIn = undefined;
		}
		if (fadeOut !== undefined) {
			fadeOut.Cancel();
			fadeOut = undefined;
		}

		// Destroyed, not paused: a paused `Sound` is an instance that outlives its round and a `TimePosition` that the next
		// round would inherit. The tree's rule for one-shot UI is the same (see `elimination-splash-controller`).
		sound.Stop();
		sound.Destroy();
	};

	const tick = RunService.RenderStepped.Connect(() => {
		// The fade-out owns the playhead from the moment it starts; see the module docblock for why it wins.
		if (destroyed || fadingOut || !started) {
			return;
		}

		const wrap = songWrapTarget(sound.TimePosition);
		if (wrap === undefined) {
			return;
		}

		seekToLoopStart();
	});

	// **The deterministic half of the wrap, and the only handler for a stopped sound.** `SONG_END_SECONDS` is the clip's own
	// end, so the per-frame check is racing the sound stopping: `Ended` fires whether or not a frame landed on the boundary, so
	// a dropped frame cannot leave the round in silence. It is also *precise* in a way the tick cannot be — the tick must not
	// read `IsPlaying` as "finished", because an unloaded sound reports exactly that (see `songWrapTarget`).
	const ended = sound.Ended.Connect(() => {
		if (destroyed || fadingOut || !started) {
			return;
		}

		seekToLoopStart();
	});

	const handle: SongHandle = {
		sound,

		play(): void {
			if (destroyed) {
				return;
			}

			// **A fresh start, every time.** `Playing -> Playing` (debug key 3, item 38) is a new round as far as the song is
			// concerned: the intro replays, which is the honest reading of "the round restarted" and the one the user asked
			// for. `TimePosition = 0` is what makes that true even if this instance somehow survived a previous play.
			sound.TimePosition = 0;
			sound.Volume = 0;
			sound.Play();
			started = true;

			fadeIn = TweenService.Create(
				sound,
				new TweenInfo(SONG_FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{ Volume: targetVolume },
			);
			fadeIn.Play();
		},

		startFadeOut(onDestroyed?: () => void): void {
			if (destroyed || fadingOut) {
				return;
			}

			fadingOut = true;

			// A fade-out that began mid fade-in must not be fought by the ramp that is still running: two tweens on one
			// `Volume` is whichever wrote last, which reads as a stutter rather than as a fade.
			if (fadeIn !== undefined) {
				fadeIn.Cancel();
			}

			fadeOut = TweenService.Create(
				sound,
				new TweenInfo(SONG_FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{ Volume: 0 },
			);
			fadeOut.Play();

			// The teardown is scheduled here rather than driven from `Completed`, so the handle's lifetime is one number the
			// caller can reason about and a cancelled tween cannot leave a sound alive. Two seconds after this call the
			// instance is gone whether the tween finished, was cancelled, or never started properly.
			task.delay(SONG_FADE_SECONDS, () => {
				destroyNow();
				if (onDestroyed !== undefined) {
					onDestroyed();
				}
			});
		},

		destroy(): void {
			destroyNow();
		},

		isFadingOut(): boolean {
			return fadingOut;
		},

		isDestroyed(): boolean {
			return destroyed;
		},
	};

	return handle;
}
