import { ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYING_DEADLINE_VALUE_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import {
	SONG_ASSET_ID,
	SONG_END_SECONDS,
	SONG_FADE_SECONDS,
	SONG_INTRO_END_SECONDS,
	soundTuningFor,
} from "shared/sounds.config";
import { COUNTDOWN_SECONDS } from "shared/ui/countdown";
import { createSongHandle, SongHandle } from "shared/ui/song";

/** The one phase the song belongs to. A client cannot import the server's `RoundPhase`. */
const PHASE_PLAYING = "Playing";
/** The phase that ends it. */
const PHASE_POST_GAME = "PostGame";
/** The phase whose last seconds the song fades in under. */
const PHASE_WAITING = "Waiting";

/** **Placeholder.** How long to wait for the phase value before giving up, matching the other HUD controllers. */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * **How early the fade-in begins, in seconds.**
 *
 * `max` rather than `COUNTDOWN_SECONDS` alone, and the max is the interesting part: the song should start *with the
 * countdown*, and it should also be *audible by the time the race is* — so the lead has to cover both the countdown and the
 * fade. At the shipped numbers the two are `3.05` and `2`, so the countdown wins and the fade completes about a second
 * before the belt moves; if somebody later raises the fade past the countdown, this follows it rather than leaving the ramp
 * still climbing at the gun.
 */
const SONG_LEAD_SECONDS = math.max(COUNTDOWN_SECONDS, SONG_FADE_SECONDS);

/**
 * Plays the round song: one `Sound`, faded in **from the start of the countdown**, faded out when the phase leaves, and
 * destroyed.
 *
 * ## Why the song starts before `Playing` (item 156)
 *
 * It used to start when `Playing` was observed, which meant the round began **in silence**: the countdown ran its 3-2-1 over
 * a still belt with no music, and the song's two-second fade-in then occupied the first two seconds of the race. The start
 * of the round — the one moment the music is for — was the quietest.
 *
 * The fade-in now begins at `PlayingDeadline - SONG_LEAD_SECONDS`, which is the same instant `CountdownController` puts its
 * `3` on screen, so the last second of `Waiting` is already scored and `Start!` lands on music at full volume instead of on
 * silence. Both controllers subtract from the same published deadline; **neither owns a copy of the countdown's length** —
 * that number lives in `shared/ui/countdown.ts` and this file imports it.
 *
 * ## Why the song is still `Playing`-only in every other sense
 *
 * The fade-in is borrowed time, not a phase change: the sound exists only because `Waiting` is about to become `Playing`,
 * and any other destination destroys it. `Intermission` and `PostGame` reach `stopImmediately` or the fade-out as they
 * always did, so a round abandoned from `Waiting` (debug key `1`) cuts rather than leaving music over a lobby.
 *
 * ## Why the phase is read once and then watched
 *
 * Item 39's pattern, same as `round-state-controller` and `leaderboard-controller`: a client can join at any point, including
 * mid-round, and a controller that only subscribed would stay silent until the next transition. Reading `Value` in `onStart`
 * means **a player who joins during `Playing` hears the song from the top of the clip**, which is the only honest choice —
 * starting mid-playhead would need a server timestamp the wire does not carry, and silence for a whole round would be worse.
 *
 * A player who joins *during* the countdown gets the lead-in from that frame, because the tick starts the sound whenever it
 * finds `Waiting` inside the lead window — the same "join at the point the clock says" property the countdown has.
 *
 * The read is **not** deferred a frame. The UI in this tree defers when it needs a layout pass (`AbsoluteSize` is `(0, 0)`
 * before one), and a `Sound` has no such dependency: `Play()` and a `Volume` tween are both valid on an instance the moment
 * it is parented. Deferring would only delay the fade-in by a frame for no benefit.
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

	/**
	 * Whether the current handle was started by the **lead-in** rather than by `Playing`.
	 *
	 * This is the whole of the difference between "the phase arrived at a song that is already playing" and "the phase
	 * arrived and wants a fresh one". Without it, `Playing` would destroy the ramp it just started and begin again from
	 * silence — the bug this round exists to remove, reintroduced one branch later.
	 */
	private leadArmed = false;

	/** The server's current phase, as last read. */
	private phase = "unknown";

	/** The published `Waiting` deadline, in server time. `0` means no countdown is due. */
	private deadline = 0;

	/** `os.clock()` when `PostGame` was observed, so the destroy line can say how far into the phase it landed. */
	private postGameAt = 0;

	public onStart(): void {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[RoundSong] no ${ROUND_STATE_VALUE_NAME} — the round will have no music.`);
			return;
		}

		// **The deadline, from the same value the countdown reads (item 156).** Optional: a server that predates it, or a
		// replication race, leaves the song with its old behaviour rather than with no music at all.
		const deadline = ReplicatedStorage.WaitForChild(PLAYING_DEADLINE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (deadline !== undefined && deadline.IsA("NumberValue")) {
			this.deadline = deadline.Value;
			deadline.GetPropertyChangedSignal("Value").Connect(() => {
				this.deadline = deadline.Value;
			});
		} else {
			warn(
				`[RoundSong] no ${PLAYING_DEADLINE_VALUE_NAME} — the song will start at Playing, not with the countdown.`,
			);
		}

		this.phase = value.Value;

		// Seeded from the current value so a client that joined mid-round starts the song immediately.
		this.apply(value.Value);

		// `GetPropertyChangedSignal` rather than `Changed`: the latter also fires for `Parent`, `Name` and anything else a
		// replicated value can have, and this controller's action is expensive enough (a `Sound`, a tween, a connection) that
		// firing it on some unrelated property would be a real bug rather than noise.
		value.GetPropertyChangedSignal("Value").Connect(() => {
			this.phase = value.Value;
			this.apply(value.Value);
		});

		// The lead-in needs a clock, and the deadline is the only one that agrees with the countdown's. One connection for the
		// controller's lifetime; the body is three comparisons while nothing is pending.
		RunService.Heartbeat.Connect(() => this.tickLead());

		print(
			`[RoundSong] mounted fade=${SONG_FADE_SECONDS}s lead=${SONG_LEAD_SECONDS}s loop=${SONG_INTRO_END_SECONDS}..${SONG_END_SECONDS}s volume=${soundTuningFor(SONG_ASSET_ID).volume}`,
		);
	}

	/**
	 * Starts the fade-in when the countdown's window opens.
	 *
	 * **Measured back from the deadline every frame, never counted down locally** — the same argument `CountdownController`
	 * makes: a local timer starts when this client noticed `Waiting`, drifts by every dropped frame, and gives a late joiner
	 * nothing. Here the local reading is only ever used to decide *whether we are inside the window*, and the window is the
	 * server's.
	 */
	private tickLead(): void {
		if (this.phase !== PHASE_WAITING || this.deadline <= 0) {
			return;
		}

		if (this.song !== undefined || this.leadArmed) {
			return;
		}

		const remaining = this.deadline - Workspace.GetServerTimeNow();

		// Past the deadline: `Waiting` is about to become `Playing` and that entry point will start the song in the ordinary
		// way. Starting one here would be a fresh fade aimed at a round that has already begun.
		if (remaining <= 0) {
			return;
		}

		if (remaining > SONG_LEAD_SECONDS) {
			return;
		}

		this.startLead(remaining);
	}

	/**
	 * The fade-in that runs under the countdown.
	 *
	 * Logged with `remaining` rather than with the deadline alone, because the two together are what separates "this client
	 * watched the whole lead-in" from "this client joined two seconds before the gun" — and only one of those two is a bug
	 * report if somebody says the music came in late.
	 */
	private startLead(remaining: number): void {
		const handle = createSongHandle();
		this.song = handle;
		this.leadArmed = true;
		handle.play();

		print(
			`[RoundSong] lead-in phase=${PHASE_WAITING} remaining=${formatSeconds(remaining)}s lead=${SONG_LEAD_SECONDS}s fade=${SONG_FADE_SECONDS}s volume=${soundTuningFor(SONG_ASSET_ID).volume}`,
		);
	}

	/**
	 * One dispatch for every phase, so the four branches are visible in one place.
	 *
	 * `Playing` **adopts a lead-in** and otherwise restarts (including `Playing -> Playing`, item 38's debug key 3);
	 * `PostGame` fades; anything else stops immediately. The order matters: `Playing` is checked first so a restart destroys
	 * and rebuilds rather than being caught by a "not PostGame" fall-through.
	 */
	private apply(phase: string): void {
		if (phase === PHASE_PLAYING) {
			// **The lead-in is not restarted, it is kept.** Destroying it here would cut the ramp it was started for and begin
			// again from silence — and `leadArmed` is what tells the two arrivals apart: it is only ever set by `startLead`,
			// and it is cleared on the first `Playing` it survives.
			if (this.leadArmed) {
				this.leadArmed = false;
				print(`[RoundSong] adopt phase=${PHASE_PLAYING} (lead-in already playing)`);
				return;
			}

			this.restart();
			return;
		}

		if (phase === PHASE_POST_GAME) {
			// A lead-in that somehow outlived `Playing` (a phase jump straight out of `Waiting`) must not leave the flag armed
			// for the next round: an armed flag with no sound would make the next `Playing` adopt a song that does not exist.
			this.leadArmed = false;
			this.beginFadeOut();
			return;
		}

		// `Intermission` or `Waiting`: the song is over and nothing is being faded. A debug reset (`1`) reaches here directly
		// from `Playing` without passing through `PostGame`, and the honest reading of that is a cut — the round was abandoned,
		// not finished, and a two-second tail over a lobby would be sound for a round that no longer exists.
		//
		// **`Waiting` also disarms the lead-in**, so re-entering the phase (debug key `2`) cannot inherit an armed flag and skip
		// a restart that should have happened.
		this.leadArmed = false;
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
