import { ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import {
	SONG_ASSET_ID,
	SONG_END_SECONDS,
	SONG_FADE_SECONDS,
	SONG_INTRO_END_SECONDS,
	soundTuningFor,
} from "shared/sounds.config";
import { createSongHandle, SongHandle } from "shared/ui/song";

/** The one phase the song belongs to. A client cannot import the server's `RoundPhase`. */
const PHASE_PLAYING = "Playing";
/** The phase that ends it. */
const PHASE_POST_GAME = "PostGame";

/** **Placeholder.** How long to wait for the phase value before giving up, matching the other HUD controllers. */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * Plays the round song: one `Sound`, started when `Playing` is observed, faded out when the phase leaves, destroyed.
 *
 * ## Why the song is `Playing`-only
 *
 * It is the round's own music. `Intermission` and `Waiting` are the lobby — a song bed there would have to stop and start
 * again on every phase change, and the user asked for the playing phase. Between rounds there is **silence**, not a
 * crossfade: `Playing -> PostGame -> Intermission -> Waiting -> Playing` is two-and-a-half phases of nothing and then a
 * fresh fade-in from zero.
 *
 * ## The load-bearing decision: the fade-out starts when the client *observes* the end
 *
 * **The brief asked for a fade that begins two seconds before `Playing` ends and reaches silence exactly as
 * `Playing -> PostGame` fires. That is not implementable, at any layer, and the reason is item 37.**
 *
 * `Playing` has no time cap: it ends at the instant "one competitor remains" becomes true, evaluated by
 * `checkEndCondition` on a 1 Hz tick. There is no countdown, no scheduled transition, and nothing to predict — the *server*
 * does not know the round is about to end either, it discovers it in the same instant it announces it. So "two seconds
 * before the end" describes a moment nobody can name, and a fade cannot be aimed at it. The two requirements in the brief —
 * *fade over two seconds* and *silent by the time `PostGame` renders* — cannot both hold, and there is no architecture that
 * makes them.
 *
 * What is built is therefore: **the fade-out begins when this client sees the phase value change, and reaches zero
 * `SONG_FADE_SECONDS` later**, which is roughly 2.1 s into `PostGame` (~0.1 s of replication latency plus the two-second
 * ramp). The song's tail therefore overlaps the start of `PostGame` — including the payout panel and its coin sound.
 *
 * **That overlap is chosen rather than suffered.** A two-second musical tail under a results panel reads as a deliberate
 * outro; a hard cut on the frame the phase changes reads as the audio being broken, which is the exact impression a music
 * bed exists to avoid. The alternative the brief gestured at — a server remote fired at the moment `endPlaying` runs — would
 * buy about a hundred milliseconds of accuracy (the difference between "the server decided" and "the client heard"), and
 * cost a remote, a payload and a second source of truth for a phase that is already replicated. It would **not** move the
 * fade into the round, because there is no earlier moment to move it to.
 *
 * The one thing the phase change *is* allowed to do is act as a safety net: if a handle somehow arrives here already fading
 * or already destroyed, nothing is started twice. That guard is cheap and it is what makes this controller correct under a
 * future server cue as well.
 *
 * ## Why the phase is read once and then watched
 *
 * Item 39's pattern, same as `round-state-controller` and `leaderboard-controller`: a client can join at any point, including
 * mid-round, and a controller that only subscribed would stay silent until the next transition. Reading `Value` in `onStart`
 * means **a player who joins during `Playing` hears the song from the top of the clip**, which is the only honest choice —
 * starting mid-playhead would need a server timestamp the wire does not carry, and silence for a whole round would be worse.
 *
 * The read is **not** deferred a frame. The UI in this tree defers when it needs a layout pass (`AbsoluteSize` is `(0, 0)`
 * before one), and a `Sound` has no such dependency: `Play()` and a `Volume` tween are both valid on an instance the moment
 * it is parented. Deferring would only delay the fade-in by a frame for no benefit.
 *
 * ## What this controller does not own
 *
 * It does not touch `playCoinSound`, `playPurchaseSound` or any other player, and it holds no reference to
 * `shared/ui/sounds` except through `buildSound` — which is one construction site for a `Sound`, not a second sound system.
 * A phase change is not an event in the six-sound sense; it is a lifetime.
 */
@Controller()
export class RoundSongController implements OnStart {
	/**
	 * The song for the round currently playing, or `undefined` between rounds.
	 *
	 * Exactly one at a time: `Playing` destroys the old handle before building a new one, so a restart cannot leave two songs
	 * overlapping by a fade.
	 */
	private song?: SongHandle;

	/** `os.clock()` when `PostGame` was observed, so the destroy line can say how far into the phase it landed. */
	private postGameAt = 0;

	public onStart(): void {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[RoundSong] no ${ROUND_STATE_VALUE_NAME} — the round will have no music.`);
			return;
		}

		// Seeded from the current value so a client that joined mid-round starts the song immediately.
		this.apply(value.Value);

		// `GetPropertyChangedSignal` rather than `Changed`: the latter also fires for `Parent`, `Name` and anything else a
		// replicated value can have, and this controller's action is expensive enough (a `Sound`, a tween, a connection) that
		// firing it on some unrelated property would be a real bug rather than noise.
		value.GetPropertyChangedSignal("Value").Connect(() => {
			this.apply(value.Value);
		});

		print(
			`[RoundSong] mounted fade=${SONG_FADE_SECONDS}s loop=${SONG_INTRO_END_SECONDS}..${SONG_END_SECONDS}s volume=${soundTuningFor(SONG_ASSET_ID).volume}`,
		);
	}

	/**
	 * One dispatch for every phase, so the four branches are visible in one place.
	 *
	 * `Playing` restarts (including `Playing -> Playing`, item 38's debug key 3); `PostGame` fades; anything else stops
	 * immediately. The order matters: `Playing` is checked first so a restart destroys and rebuilds rather than being caught
	 * by a "not PostGame" fall-through.
	 */
	private apply(phase: string): void {
		if (phase === PHASE_PLAYING) {
			this.restart();
			return;
		}

		if (phase === PHASE_POST_GAME) {
			this.beginFadeOut();
			return;
		}

		// `Intermission` or `Waiting`: the song is over and nothing is being faded. A debug reset (`1`) reaches here directly
		// from `Playing` without passing through `PostGame`, and the honest reading of that is a cut — the round was abandoned,
		// not finished, and a two-second tail over a lobby would be sound for a round that no longer exists.
		this.stopImmediately(phase);
	}

	/** Starts a fresh song. **Destroys any existing handle first**, so a restart cannot overlap two instances. */
	private restart(): void {
		const previous = this.song;
		if (previous !== undefined) {
			// No fade: `Playing -> Playing` is one round replacing another in the same phase, and fading the old one out while
			// the new one fades in is a crossfade the user explicitly did not ask for.
			previous.destroy();
			this.song = undefined;
		}

		const handle = createSongHandle();
		this.song = handle;
		handle.play();

		print(
			`[RoundSong] play phase=${PHASE_PLAYING} duration=${SONG_END_SECONDS}s loop=${SONG_INTRO_END_SECONDS}..${SONG_END_SECONDS} fade=${SONG_FADE_SECONDS}s volume=${soundTuningFor(SONG_ASSET_ID).volume}`,
		);
	}

	/**
	 * Starts the two-second fade and schedules the teardown, unless one is already running.
	 *
	 * The "unless" is the safety net described in the class docblock: in the client-observed design this is the *only* caller,
	 * so it never fires today — but it is what keeps the controller correct if a server cue is ever added ahead of the phase
	 * change, and it is cheaper than a bug that only appears on that day.
	 */
	private beginFadeOut(): void {
		const handle = this.song;
		if (handle === undefined) {
			return;
		}

		if (handle.isFadingOut() || handle.isDestroyed()) {
			return;
		}

		this.postGameAt = os.clock();
		print(`[RoundSong] fade-out scheduled in 0.0s (observed phase change)`);

		handle.startFadeOut(() => {
			// The line that separates "the fade landed where it was aimed" from "the sound was still playing when the next
			// round began" — the two failures a screenshot cannot tell apart.
			print(`[RoundSong] destroyed at ${formatSeconds(os.clock() - this.postGameAt)}s into PostGame`);

			if (this.song === handle) {
				this.song = undefined;
			}
		});
	}

	/** Cuts the song now, for a phase that is not `Playing` and not the end of one. */
	private stopImmediately(phase: string): void {
		const handle = this.song;
		if (handle === undefined) {
			return;
		}

		handle.destroy();
		this.song = undefined;
		print(`[RoundSong] destroyed (phase=${phase}, no fade)`);
	}
}

/** Seconds to two places, so the destroy line is readable without `string.format`. */
function formatSeconds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}
