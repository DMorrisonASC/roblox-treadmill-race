import { ContentProvider, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYING_DEADLINE_VALUE_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import {
	LOBBY_SONG_ASSET_IDS,
	LOBBY_SONG_FADE_SECONDS,
	LOBBY_SONG_MIN_SPAN_SECONDS,
	LOBBY_SONG_TAIL_CUTOFF_SECONDS,
	soundTuningFor,
	soundUri,
} from "shared/sounds.config";
import { drawLobbyStart, pickLobbySong } from "shared/ui/lobby-song";
import { createSongHandle, SongHandle } from "shared/ui/song";

/** The phase the song is picked in. A client cannot import the server's `RoundPhase`, so these are strings like everywhere else. */
const PHASE_INTERMISSION = "Intermission";
/** The phase the song plays *through*: no action here is the whole rule. */
const PHASE_WAITING = "Waiting";
/** The phase the song must be silent by. */
const PHASE_PLAYING = "Playing";
/** The phase that kills it outright. */
const PHASE_POST_GAME = "PostGame";

/** **Placeholder.** How long to wait for the phase value before giving up, matching the other HUD controllers. */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * **Placeholder.** The total time one lobby may spend discovering that its songs will not load, in seconds.
 *
 * This is a **budget for the whole lobby, not for one attempt**, and that distinction is item 158. An attempt is
 * `budget / candidates` (see `attemptSeconds`), so with two songs each gets five seconds and the fallback — "if the first
 * clip is unavailable, play the other" — completes inside ten seconds rather than twenty. `INTERMISSION_SECONDS` is 30 and
 * `WAITING_SECONDS` is 15, so two failed attempts plus a successful third-second start fit inside either phase with room to
 * spare.
 *
 * **This is the only gate on whether a song plays**, and it is a measurement rather than an opinion: `IsLoaded` or a
 * non-zero `TimeLength` on the actual instance. See `reportAssets` for why the preload's failure is not one.
 */
const LOBBY_LOAD_BUDGET_SECONDS = 10;

/**
 * **Placeholder.** The floor on a single attempt, in seconds, so the budget cannot be divided into slices too short to be
 * a fair try at a cold fetch.
 *
 * With two songs the division gives five and this floor never applies; with a third it would give three and a third. It
 * exists for the hypothetical fourth song, where `10 / 4` is two and a half seconds — long enough to look like a bug in the
 * loader rather than like an unavailable asset. The floor can make the total exceed the budget, which is deliberate: with
 * four songs the honest answer is that the budget was set for two.
 */
const LOBBY_MIN_ATTEMPT_SECONDS = 3;

/**
 * **Placeholder.** How long a lobby whose every id has failed waits before trying them all again, in seconds.
 *
 * Two minutes is short enough that a fresh upload finishing processing is picked up within a couple of rounds, and long
 * enough that a genuinely dead pair is not re-tested every lobby. It only ever runs when the alternative is silence —
 * `reviveIfStale` says why.
 */
const LOBBY_RETRY_AFTER_SECONDS = 120;

/**
 * **Placeholder.** How often to re-ask a loading `Sound` whether it has a length, in seconds.
 *
 * A poll *as well as* the `Loaded` event, because the two fail differently: the event costs nothing when it works and
 * never arrives when it does not, and ten `Task`s a second for at most ten seconds is not a cost worth optimising. The
 * draw cannot be taken until one of them answers, so a mechanism that never fires means no music at all.
 */
const LOBBY_LOAD_POLL_SECONDS = 0.1;

/**
 * Plays one of the two lobby songs across `Intermission` and `Waiting`, picked and started at random, and hands the lobby
 * back to silence exactly as the race begins (item 157).
 *
 * ## The shape of it, in one paragraph
 *
 * On entering `Intermission` it destroys any song, picks a clip, waits for that clip's `TimeLength` to exist, draws a
 * random opening, and plays from there with a `LOBBY_SONG_FADE_SECONDS` fade-in. `Waiting` does **nothing** — the same
 * `Sound` keeps playing, the playhead is not moved, the pick is not re-rolled. `Playing` fades it out, and anything else
 * destroys it. The loop is `0 -> TimeLength - LOBBY_SONG_TAIL_CUTOFF_SECONDS`, so the clip's last five seconds are never
 * heard and its opening is heard on every pass after the first.
 *
 * ## If one song is unavailable, the other plays (item 158)
 *
 * The pick is random only while both clips are usable. The moment one proves it is not — its `Sound` never reports a length,
 * or reports one too short for the two rules — it is retired for the session and `start` is called again, which can only
 * choose from what is left. With two songs that is one retry and then a single `no asset loaded` line; with more it is a
 * sequence, each attempt inside the same lobby phase and each attempt bounded by a share of one budget rather than a fixed
 * timeout apiece.
 *
 * **"Unavailable" is only ever a measurement of the `Sound`.** The boot preload's opinion is logged and ignored — the first
 * Studio run of this round used it as a gate and silenced the lobby on two perfectly good audio ids, because
 * `PreloadAsync` reports the same `Asset type does not match requested type` failure for a valid *image*. Making the same
 * opinion decide the *fallback order* would be the same mistake with a smaller blast radius, so it does not decide that
 * either.
 *
 * ## Why `Waiting` is a no-op, and why that is not laziness
 *
 * The two phases are one continuous lobby: `Intermission` is the results screen and `Waiting` is the pick-and-countdown
 * screen, and the user asked for **one** song across both. Every re-entry point is a place a restart could hide — a
 * re-roll, a re-draw, a fresh fade from silence — and the only way to be sure none of them happens is for the phase to have
 * no branch at all. `apply` therefore returns before it does anything when the phase is `Waiting`, and the only two things
 * that can touch the song during `Waiting` are named and deliberate: the fade-out timer in `tickFade` (which is timed off
 * `PlayingDeadline`, not off the phase entry) and the `Playing` safety net.
 *
 * ## Why the fade-out is aimed at `PlayingDeadline` and not counted down locally
 *
 * Item 149 publishes the instant `Playing` begins, **including the transition wipe's hold**, which `WAITING_SECONDS` alone
 * does not. A local timer started at `Waiting` entry would drift by every dropped frame and would give a late joiner
 * nothing; measuring `deadline - GetServerTimeNow()` every frame means the fade lands three seconds before the gun on a
 * settled client, on a client that just joined, and on a client whose frames were being spent loading the store.
 *
 * **The phase change is the safety net.** If the timer slips past entirely — a long hitch, or a deadline that replicated
 * after the window had already opened — `Playing` entry starts the fade immediately. The same call, three seconds late, is
 * still better than a music bed playing over the race.
 *
 * ## The `generation` counter, and the debug sequence it exists for
 *
 * Two things here can outlive the reason they were started: a `Loaded` wait on a cold clip, and a fade-out's completion
 * callback. Both are async and both act on `this.song`. A `PostGame -> Intermission -> Waiting` sequence pressed three times
 * in a second is three `Intermission` entries, three picks and three handles, and without a guard the second entry's
 * `Loaded` callback would start a song into the third entry's handle — or worse, the first fade's completion would clear
 * `this.song` while a *live* handle sat in it.
 *
 * `generation` is bumped on **every** `Intermission` entry and captured by every continuation; a continuation whose number
 * is stale returns without touching anything. The belt beside it is `this.song === handle`, which catches the one case a
 * number cannot: a handle that was replaced without a bump (there is no such path today, and the belt costs one comparison).
 *
 * ## What this controller does not own
 *
 * It does not touch the picker, the countdown, the transition wipe or the phase machine, and it makes no new remote — the
 * pick and the opening are per-client and per-entry, and two testers hearing different songs is correct rather than a
 * replication bug. It also does not touch `RoundSongController`: the round song still owns `Playing` and the two songs meet
 * once, in the fade at the deadline, and never overlap.
 */
@Controller()
export class LobbySongController implements OnStart {
	/** The song for the current lobby, or `undefined` when there is none. Exactly one at a time. */
	private song?: SongHandle;

	/**
	 * Bumped on every `Intermission` entry. Every asynchronous continuation captures it and refuses to act if it has moved.
	 */
	private generation = 0;

	/** The phase last observed. */
	private phase = "unknown";

	/** The published `Playing` deadline, in server time. `0` means "not known yet". */
	private deadline = 0;

	/**
	 * The ids that have **proved** unplayable this session — a `Sound` that never reported a length, or one that reported a
	 * length too short for the rules. Filled by a measurement, never by the boot preload; see `reportAssets`.
	 *
	 * A list rather than a set for two elements, and a session-scoped list rather than a per-`Intermission` one so a dead
	 * id is skipped rather than re-waited on every lobby.
	 */
	private unusable: Array<string> = [];

	/**
	 * The ids this **lobby** has already failed on, in the order they failed. Reset on every `Intermission` entry.
	 *
	 * Two jobs, and the second is the reason it is separate from `unusable`: it lets the play line say
	 * `after=103226688466405`, which is the difference between "the song that played is the song that was picked" and "the
	 * fallback ran", and those two look identical in a log that only prints the winner.
	 */
	private failedThisLobby: Array<string> = [];

	/**
	 * How long each attempt in the current lobby may wait, decided once in `beginSong`.
	 *
	 * Initialised to the whole budget rather than zero so a `start` that somehow ran before a `beginSong` has a finite
	 * window — the impossible case is given the generous value, not the infinite one.
	 */
	private attempt = LOBBY_LOAD_BUDGET_SECONDS;

	/** Set when every id has proved unusable: the controller logs once and then does nothing for the session. */
	private disabled = false;

	/**
	 * `os.clock()` at the moment the last id was retired and the controller went silent, or `0` when it has not.
	 *
	 * `os.clock()` and not `tick()`: this measures a wall-clock gap between two lobbies, and `tick()` stops while the
	 * engine is suspended, which would make a two-minute retry take however long an alt-tab lasted.
	 */
	private deadAt = 0;

	/** Set when the "no asset" line has been printed, so a re-entry cannot repeat it every `Intermission`. */
	private reportedSilent = false;

	public onStart(): void {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[LobbySong] no ${ROUND_STATE_VALUE_NAME} — the lobby will have no music.`);
			return;
		}

		// The deadline is optional in the same sense it is for the countdown: a server that predates item 149 leaves the
		// song audible all the way into `Playing`, where the phase change cuts it. That is a worse fade and not a broken
		// lobby, and it is strictly better than refusing to play at all.
		const deadline = ReplicatedStorage.WaitForChild(PLAYING_DEADLINE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (deadline !== undefined && deadline.IsA("NumberValue")) {
			this.deadline = deadline.Value;
			deadline.GetPropertyChangedSignal("Value").Connect(() => {
				this.deadline = deadline.Value;
			});
		} else {
			warn(`[LobbySong] no ${PLAYING_DEADLINE_VALUE_NAME} — the fade-out will run at Playing instead.`);
		}

		// **Before the pick, and no longer load-bearing.** The preload is a diagnostic and a cache warmer; nothing waits for
		// it. That ordering matters only for the log — the `preload` line lands after `mounted` and before the first `play`,
		// which is the order a reader wants to see them in.
		this.reportAssets();

		print(
			`[LobbySong] mounted fade=${LOBBY_SONG_FADE_SECONDS}s tailCutoff=${LOBBY_SONG_TAIL_CUTOFF_SECONDS}s minSpan=${LOBBY_SONG_MIN_SPAN_SECONDS}s assets=${LOBBY_SONG_ASSET_IDS.join("|")} volume=${soundTuningFor(LOBBY_SONG_ASSET_IDS[0]).volume}/${soundTuningFor(LOBBY_SONG_ASSET_IDS[1]).volume}`,
		);

		this.phase = value.Value;

		// **Seeded from the current value, not only subscribed.** A client that joins during `Intermission` or `Waiting` has
		// missed the entry and would otherwise sit in silence until the next round — the same "join at the point the clock
		// says" property the countdown and the round song have. `Playing` and `PostGame` are deliberately absent: the lobby
		// song is not the round's, and joining mid-race should not start music the racing client does not have.
		this.seed(value.Value);

		value.GetPropertyChangedSignal("Value").Connect(() => {
			this.phase = value.Value;
			this.apply(value.Value);
		});

		// The fade-out needs a clock that agrees with the countdown's, and the deadline is the only one that does. One
		// connection for the controller's lifetime; the body is four comparisons while nothing is due.
		RunService.Heartbeat.Connect(() => this.tickFade());
	}

	/**
	 * Asks the engine once whether it *likes* both songs, and changes nothing whatever the answer.
	 *
	 * ## The bug this rewrite is: the preload's verdict is not a fact about the asset
	 *
	 * The first version of this method used the fetch status as a gate — a `Failure` removed the id from the picker, and two
	 * `Failure`s made the controller log `no asset loaded, silent` and disable itself for the session. The Studio log that
	 * produced this rewrite is why that was wrong:
	 *
	 * ```
	 * ContentId: rbxassetid://103226688466405 failed due to: Asset type does not match requested type
	 * ContentId: rbxassetid://139466974097755 failed due to: Asset type does not match requested type
	 * ContentId: rbxassetid://135266450823195 failed due to: Asset type does not match requested type
	 * [PickupSprite] image did not load: rbxassetid://135266450823195 status=Enum.AssetFetchStatus.Failure
	 * ```
	 *
	 * The third id is the **pickup sprite**, and its own `AssetTypeId` is `1` — it is an image, it is used as an image, and it
	 * reports exactly the same failure as two audio assets whose `AssetTypeId` is `3`. A check that fails identically for
	 * correct and incorrect content is not measuring the content. What it is measuring is not knowable from here (fresh
	 * uploads; an unpublished place; the content-type resolution `PreloadAsync` does for a bare `rbxassetid://` string), and it
	 * does not matter: **a preload opinion may not decide whether music plays.**
	 *
	 * The precedent was already in the tree. Items 144 and 154 both say the same thing about images: *report it and draw it
	 * anyway*, because the log is the whole of the response to a cosmetic failure. This file made the same signal
	 * behaviour-changing, and the cost was a silent lobby on two assets that are almost certainly fine.
	 *
	 * ## What decides instead
	 *
	 * `awaitLoaded`: `Sound.IsLoaded` or a non-zero `TimeLength` on the **real instance**, polled and evented, for at most
	 * its share of `LOBBY_LOAD_BUDGET_SECONDS` (item 158). That is a measurement of the thing itself, and a clip that
	 * genuinely cannot resolve still ends up skipped — one line, the id retired for the session, and the other clip tried
	 * inside the same lobby. The difference is that the verdict costs a few seconds of silence **once** instead of a whole
	 * session of it.
	 *
	 * ## Why the call is fire-and-forget
	 *
	 * It warms the content cache before the first `Intermission` needs it, and `PreloadAsync` yields. Awaiting it in
	 * `onStart` would delay every connection below it — including the phase subscription — by two web requests, which on a
	 * cold client is long enough to miss the phase it joined on. Nothing waits on it now, so the yield costs nothing at all.
	 */
	private reportAssets(): void {
		const uris = LOBBY_SONG_ASSET_IDS.map((id) => soundUri(id));

		task.spawn(() => {
			let liked = 0;
			let disliked = 0;

			const [ok, failure] = pcall(() => {
				ContentProvider.PreloadAsync(uris, (contentId, status) => {
					// The callback hands back the resolved `ContentId`, not the id we passed, so the id is recovered by
					// stripping the scheme `soundUri` added.
					const [bare] = contentId.gsub("rbxassetid://", "");

					if (status === Enum.AssetFetchStatus.Success) {
						liked++;
						return;
					}

					disliked++;
					warn(
						`[LobbySong] asset did not load ${bare} status=${tostring(status)} — a preload opinion, not a verdict: the song is tried anyway and its own IsLoaded/TimeLength decides. If it also fails there, that is the line that means it.`,
					);
				});
			});

			if (!ok) {
				warn(`[LobbySong] asset preload threw: ${tostring(failure)} — the songs are tried anyway.`);
			}

			// One summary line rather than one per outcome, because the only question it answers is "did the preload agree with
			// the config" — and the answer does not gate anything, so it is printed as a fact about the check rather than about
			// the music.
			print(`[LobbySong] preload done liked=${liked} disliked=${disliked} of ${LOBBY_SONG_ASSET_IDS.size()}`);
		});
	}

	/** The phase a song belongs to, asked fresh. */
	private wantsMusic(): boolean {
		return this.phase === PHASE_INTERMISSION || this.phase === PHASE_WAITING;
	}

	/**
	 * Starts the song for a phase this client observed on arrival, rather than on transition.
	 *
	 * `Intermission` and `Waiting` both begin one: the first because it is the phase the song is picked in, the second
	 * because a client that joins mid-`Waiting` has missed every entry and would otherwise hear nothing until the round after
	 * next. `Waiting` **on transition** is still a no-op — the difference is "this client just arrived" versus "the phase
	 * moved under a song that is already playing", and only the second is what the no-op protects.
	 */
	private seed(phase: string): void {
		if (phase !== PHASE_INTERMISSION && phase !== PHASE_WAITING) {
			return;
		}

		this.beginSong(phase);
	}

	/**
	 * One dispatch for every phase change, so the four branches are visible in one place.
	 *
	 * **The `Waiting` branch is absent on purpose** and its absence is the requirement: the song must survive the phase
	 * change untouched, so there is nothing to do and nowhere for a restart to hide.
	 */
	private apply(phase: string): void {
		if (phase === PHASE_INTERMISSION) {
			this.beginSong(phase);
			return;
		}

		if (phase === PHASE_WAITING) {
			return;
		}

		if (phase === PHASE_PLAYING) {
			// The safety net. In the ordinary case `tickFade` has already started this three seconds ago and the handle is
			// gone or going; `fadeOut` refuses a second time so this costs one comparison.
			this.fadeOut(`phase=${PHASE_PLAYING}`);
			return;
		}

		if (phase === PHASE_POST_GAME) {
			// **Immediate, not "let the fade finish".** There is no fade to let finish — `Playing` took the song out — and a
			// `PostGame` reached straight from `Waiting` (a debug reset) is a lobby that was abandoned rather than a race that
			// finished, so a musical tail would be sound for a round that never happened.
			this.destroySong(`phase=${PHASE_POST_GAME}`);
			return;
		}

		// Anything else — including an unrecognised phase from a future server — is not the lobby.
		this.destroySong(`phase=${phase}`);
	}

	/**
	 * Rolls the pick and starts the song, replacing whatever was there.
	 *
	 * The generation is bumped **first**, before the old handle is destroyed, because the bump is what invalidates any
	 * in-flight `Loaded` wait or fade completion belonging to the outgoing song. Destroying first would leave one frame in
	 * which a stale continuation could still act.
	 */
	private beginSong(phase: string): void {
		this.reviveIfStale();

		if (this.disabled) {
			return;
		}

		const generation = ++this.generation;

		// The failure list is per lobby: the play line reports what *this* lobby's fallback took over from, and a previous
		// lobby's failures are already in `unusable`, which is what excludes them from the pick.
		this.failedThisLobby = [];

		// **Once per lobby, not once per attempt.** Every attempt in this lobby gets the same share, so the shares add up to
		// the budget; recomputing it as ids fail is what made a fully dead pair cost fifteen seconds. See `attemptSeconds`.
		this.attempt = attemptSeconds(this.pickable().size());

		this.destroySong(phase);
		this.start(generation);
	}

	/**
	 * Gives a fully-dead lobby set another chance after `LOBBY_RETRY_AFTER_SECONDS`.
	 *
	 * ## Why a session-long retirement needed an expiry the same day it was written
	 *
	 * The two ids are uploads — the catalog reports `Created: 2026-11-09T01:40Z` and `01:45Z` for a session running at
	 * `2026-11-08 21:25`, i.e. minutes earlier. A freshly uploaded **audio** asset is not necessarily servable yet, and a
	 * retirement that lasts until the client disconnects means a player who leaves Studio open hears nothing all evening
	 * because of a moderation queue that drained at 21:30.
	 *
	 * ## Why retrying a dead set costs nothing
	 *
	 * This only runs when `pickable()` is empty, which means **every** id has already failed — so the lobby would be silent
	 * either way. The retry therefore cannot take music away; the worst case is the same silence with one more round of log
	 * lines. It costs something only when an id comes back, which is the case it exists for.
	 *
	 * `reportedSilent` is **not** cleared: "no asset loaded, silent" stays a once-per-session line, because a player seeing it
	 * twice in one session learns nothing and a reader of the log learns to skip past it.
	 */
	private reviveIfStale(): void {
		if (!this.disabled || this.deadAt <= 0) {
			return;
		}

		if (os.clock() - this.deadAt < LOBBY_RETRY_AFTER_SECONDS) {
			return;
		}

		print(`[LobbySong] retrying every id after ${LOBBY_RETRY_AFTER_SECONDS}s — a dead set is not a dead session`);

		this.unusable = [];
		this.deadAt = 0;
		this.disabled = false;
	}

	/**
	 * Picks a clip, waits for its length, draws an opening, and plays.
	 *
	 * ## The fallback, which is item 158
	 *
	 * **If the picked clip is unavailable, the other one plays.** "Unavailable" has exactly two meanings here, and both are
	 * measurements of the `Sound` that was asked to play rather than opinions about the id: it never reported a length
	 * inside its attempt (see `awaitLoaded`), or it reported one too short for `drawLobbyStart`'s two rules. Either way the id
	 * goes into `unusable`, the handle is destroyed, and this method is called again for the same generation, which picks from
	 * what is left. With two songs that is one retry and then `no asset loaded, silent`.
	 *
	 * The two failure kinds share a path deliberately. They differ only in what is logged, and a lobby that fell back because
	 * its first clip was silent and a lobby that fell back because its first clip was nine seconds long are the same lobby:
	 * one that should be playing the other song.
	 *
	 * ## Why the pick is still random, and the fallback is not
	 *
	 * The random pick is what the round asked for — repeated lobbies should not open the same way — and a fallback is not a
	 * pick: when only one id survives `pickable()` there is no randomness left to apply, and `pickLobbySong` on a
	 * one-element array is that element. The two rules therefore compose without a special case: random while both work,
	 * forced once one has proved dead.
	 *
	 * ## Why the draw waits for `Loaded` and the pick does not
	 *
	 * They are two different unknowns. "Can this id be played" is answered by the instance itself, in `attemptSeconds` at
	 * worst, and can only be answered *by trying* — the boot preload's opinion is not evidence (`reportAssets` has the log
	 * that proves it). "How long is this clip" is `0` until the asset arrives, and it is what the random start is drawn
	 * from, so the first pass of this method is deliberately optimistic and the second is deliberately patient.
	 *
	 * ## Why `IsLoaded` is checked before the event is connected
	 *
	 * `Sound.Loaded` fires when the sound has loaded, once. For an asset the preload already fetched it may well have fired
	 * long before this code runs, so connecting alone would wait for an event that is never coming again — the classic
	 * "subscribe to a latch that is already set" bug, and it would hang on the most common path rather than the rare one.
	 * `awaitLoaded` therefore asks first, subscribes second, and polls third.
	 */
	private start(generation: number): void {
		if (generation !== this.generation || !this.wantsMusic() || this.song !== undefined) {
			return;
		}

		const candidates = this.pickable();
		const pick = pickLobbySong(candidates, math.random);
		if (pick === undefined) {
			this.disabled = true;
			this.deadAt = os.clock();
			this.saySilent();
			return;
		}

		// `this.attempt`, set once per lobby — **not** `attemptSeconds(candidates.size())`, which would give the *first*
		// attempt a smaller window than the budget and the last one the whole of it. See `attemptSeconds`.
		const attempt = this.attempt;

		const handle = createSongHandle({
			assetId: pick,
			fadeSeconds: LOBBY_SONG_FADE_SECONDS,
			loopStart: 0,
			// Not known yet: `TimeLength` is `0` until the clip loads. `setLoopPoints` supplies it below, before `play()`, and
			// the wrap cannot act in between because `play()` is what arms it.
			loopEnd: undefined,
		});
		this.song = handle;

		this.awaitLoaded(
			handle,
			generation,
			attempt,
			() => {
				const length = handle.sound.TimeLength;
				const drawn = drawLobbyStart(
					length,
					LOBBY_SONG_TAIL_CUTOFF_SECONDS,
					LOBBY_SONG_MIN_SPAN_SECONDS,
					math.random,
				);

				if (drawn === undefined) {
					// **The refusal.** A clip that cannot hold a `minSpan` first pass is skipped and said so, because the
					// alternative — a `Play()` from wherever it clamped — is a song that breaks the rule the round exists to
					// state, and looks like a working song while it does. Marked unusable for the same reason a timeout is: a
					// clip that is too short now will be too short next round.
					warn(
						`[LobbySong] skipped song=${pick} reason=too-short length=${formatSeconds(length)}s (needs more than ${formatSeconds(LOBBY_SONG_TAIL_CUTOFF_SECONDS + LOBBY_SONG_MIN_SPAN_SECONDS)}s)`,
					);
					this.retire(handle, pick, generation);
					return;
				}

				// **`0`, not `drawn.start`.** The first pass runs `start -> ceiling`; every pass after it runs
				// `0 -> ceiling -> 0`, so the opening is heard on every loop and only the first pass is randomised.
				handle.setLoopPoints(0, drawn.ceiling);
				handle.play(drawn.start);

				print(
					`[LobbySong] play song=${pick} start=${formatSeconds(drawn.start)}s ceiling=${formatSeconds(drawn.ceiling)}s length=${formatSeconds(length)}s loopStart=0 generation=${generation} endsAt=${formatSeconds(this.deadline)}${this.afterNote()}`,
				);
			},
			() => {
				warn(
					`[LobbySong] skipped song=${pick} reason=not-loaded after ${formatSeconds(attempt)}s — the Sound never reported a length (IsLoaded=${tostring(handle.sound.IsLoaded)}, TimeLength=${formatSeconds(handle.sound.TimeLength)}).`,
				);
				this.retire(handle, pick, generation);
			},
		);
	}

	/**
	 * The ids still worth trying: the configured pair minus whatever has actually failed to load this session.
	 *
	 * Ordered by `LOBBY_SONG_ASSET_IDS` because it is a picker index, and an index whose order depended on which id failed
	 * first would make the same seed pick different songs on two clients.
	 */
	private pickable(): Array<string> {
		const candidates: Array<string> = [];
		for (const id of LOBBY_SONG_ASSET_IDS) {
			if (this.unusable.find((bad) => bad === id) === undefined) {
				candidates.push(id);
			}
		}

		return candidates;
	}

	/**
	 * Calls `onReady` once the handle's clip reports a length, or hands the attempt back to be retired and replaced.
	 *
	 * ## Three mechanisms, because the gate is where the music lives
	 *
	 * 1. **`IsLoaded || TimeLength > 0`, asked first.** Both, not either-by-choice: `IsLoaded` is the engine's own answer and
	 *    `TimeLength` is the number the draw actually needs, and a `Sound` that reports one without the other is not
	 *    something either of us can predict. Asking before subscribing matters — the event below may have fired long ago.
	 * 2. **`Sound.Loaded`,** subscribed second, which is the precise signal when it exists.
	 * 3. **A poll every `LOBBY_LOAD_POLL_SECONDS` up to `timeoutSeconds`,** because an event that never fires and a length
	 *    that never arrives fail identically, and only one of those two mechanisms covers a signal that does not arrive. A
	 *    hundred `Task`s' worth of polling per attempt against a music bed that never plays is not a trade.
	 *
	 * ## Why the timeout is a parameter and no longer a constant
	 *
	 * Item 158 made it `budget / candidates`: the fallback has to fit inside the same lobby phase as the first attempt, and a
	 * fixed ten seconds per attempt meant a lobby with two dead ids spent twenty seconds discovering it — most of an
	 * `Intermission`, for nothing.
	 *
	 * ## Why the failure hands the song back rather than ending the attempt
	 *
	 * `onTimeout` marks the id unusable and starts whatever is left **inside this `Intermission`** instead of the lobby
	 * staying silent until the next one. With two songs that recursion is at most two deep, and the second call finds
	 * `pickable()` empty and prints the single `no asset loaded` line. A dead id therefore costs one attempt once per
	 * session, not one per lobby.
	 */
	private awaitLoaded(
		handle: SongHandle,
		generation: number,
		timeoutSeconds: number,
		onReady: () => void,
		onTimeout: () => void,
	): void {
		const sound = handle.sound;
		const ready = () => sound.IsLoaded || sound.TimeLength > 0;

		if (ready()) {
			onReady();
			return;
		}

		let settled = false;

		// Declared before `loaded` and only ever called after it: the two invokers are the connection below and the poll
		// loop, both created after the assignment. A `let` here would be one flag and one disconnect site pretending to be
		// two.
		const finish = (arrived: boolean) => {
			if (settled) {
				return;
			}

			settled = true;
			loaded.Disconnect();

			// A superseded generation or handle stops here; the continuation belongs to a song that no longer exists.
			if (generation !== this.generation || this.song !== handle) {
				return;
			}

			if (arrived) {
				onReady();
			} else {
				onTimeout();
			}
		};

		const loaded = sound.Loaded.Connect(() => finish(true));

		task.spawn(() => {
			const givesUpAt = os.clock() + timeoutSeconds;

			while (!settled && os.clock() < givesUpAt) {
				task.wait(LOBBY_LOAD_POLL_SECONDS);

				if (settled || generation !== this.generation || this.song !== handle) {
					return;
				}

				if (ready()) {
					finish(true);
					return;
				}
			}

			// The last ask, in case the clip landed on the final frame of the window.
			finish(ready());
		});
	}

	/**
	 * One attempt has failed: mark the clip dead, tear the handle down, and **hand the lobby to whatever is left**.
	 *
	 * Both failure kinds arrive here (a clip that never loaded, a clip that loaded too short) because the consequence is the
	 * same and the fallback is the same; only the `warn` above differs, and it is the line that means it — the preload's
	 * `did not load` is an opinion, these are measurements of the `Sound` that was actually asked to play.
	 *
	 * The retry is guarded on the generation rather than on the handle, because a new `Intermission` may have replaced the
	 * song while the attempt was in flight and that lobby has already picked its own.
	 */
	private retire(handle: SongHandle, pick: string, generation: number): void {
		this.unusable.push(pick);
		this.failedThisLobby.push(pick);
		this.song = undefined;
		handle.destroy();

		if (generation !== this.generation) {
			return;
		}

		const left = this.pickable();
		if (left.size() > 0) {
			print(`[LobbySong] fallback after=${pick} trying=${left.join("|")}`);
		}

		this.start(generation);
	}

	/**
	 * Says which ids this lobby already failed on, for the play line, or nothing when the first pick worked.
	 *
	 * The empty string and not `after=none`, because the common case is a song that was picked and played, and a log line
	 * that always carries a field saying "nothing special happened" is a field a reader learns to skip — which is how the
	 * interesting value gets missed when it finally appears.
	 */
	private afterNote(): string {
		if (this.failedThisLobby.size() === 0) {
			return "";
		}

		return ` after=${this.failedThisLobby.join("|")}`;
	}

	/**
	 * Starts the fade-out once the published deadline is within one fade, and once only.
	 *
	 * Measured from `GetServerTimeNow` every frame rather than counted down, for the reason the class docblock gives. **A
	 * deadline of `0` is not "past", it is "not known yet"**: `enterWaiting` publishes the phase *before* the deadline, so a
	 * client can legitimately see `Waiting` with the previous round's `0` still in the value. Treating that as "already
	 * past" would fade the lobby into silence for the whole of `Waiting`, which is the opposite of what this controller is
	 * for; the `Playing` safety net covers the case where the deadline never arrives at all.
	 */
	private tickFade(): void {
		if (this.phase !== PHASE_WAITING) {
			return;
		}

		const handle = this.song;
		if (handle === undefined || handle.isFadingOut() || handle.isDestroyed()) {
			return;
		}

		if (this.deadline <= 0) {
			return;
		}

		const early = this.deadline - Workspace.GetServerTimeNow();
		if (early > LOBBY_SONG_FADE_SECONDS) {
			return;
		}

		this.fadeOut("deadline window");
	}

	/**
	 * The one fade-out, called by the timer and by the `Playing` safety net.
	 *
	 * Both callers mean the same thing and both can arrive; the guards make the second a no-op. The completion callback is
	 * where a stale generation would do its damage — it clears `this.song` — so it checks its number *and* its handle before
	 * touching anything.
	 */
	private fadeOut(reason: string): void {
		const handle = this.song;
		if (handle === undefined || handle.isFadingOut() || handle.isDestroyed()) {
			return;
		}

		const generation = this.generation;

		print(`[LobbySong] fade-out generation=${generation} (${reason}, ${this.deadlineNote()})`);

		handle.startFadeOut(() => {
			if (generation !== this.generation || this.song !== handle) {
				return;
			}

			this.song = undefined;
			print(`[LobbySong] destroyed generation=${generation}`);
		});
	}

	/**
	 * How the fade-out stood against the deadline it was aimed at, in words rather than as a signed number.
	 *
	 * `started -1.2s early` is a sentence nobody parses correctly on first read, and the three cases this has to distinguish
	 * are genuinely different: `deadline=unknown` (no item-149 value, so this is the safety net firing), `started 1.2s late`
	 * (the window was missed, which is a dropped-frame report), and `started 3s early` (the intended path).
	 */
	private deadlineNote(): string {
		if (this.deadline <= 0) {
			return "deadline=unknown";
		}

		const early = this.deadline - Workspace.GetServerTimeNow();
		if (early < 0) {
			return `deadline=${formatSeconds(this.deadline)}, started ${formatSeconds(-early)}s late`;
		}

		return `deadline=${formatSeconds(this.deadline)}, started ${formatSeconds(early)}s early`;
	}

	/** Cuts the song now, for every phase that is not the lobby's. */
	private destroySong(reason: string): void {
		const handle = this.song;
		if (handle === undefined) {
			return;
		}

		// Cleared **before** `destroy()`, so a fade completion that is still pending finds `this.song !== handle` and stays
		// quiet rather than logging a second destroy for a handle that is already gone.
		this.song = undefined;
		handle.destroy();
		print(`[LobbySong] destroyed generation=${this.generation} (${reason}, no fade)`);
	}

	/**
	 * The one "there is no music" line, printed once per session however many phases ask.
	 *
	 * It names the ids that were tried, because by the time it prints, every one of them has already produced its own
	 * `skipped` line — and a reader scanning the log for "why is there no music" will find this one first. Without the ids
	 * they would have to scroll up past the fallback lines to learn which songs were involved.
	 */
	private saySilent(): void {
		if (this.reportedSilent) {
			return;
		}

		this.reportedSilent = true;
		warn(`[LobbySong] no asset loaded, silent (tried=${LOBBY_SONG_ASSET_IDS.join("|")})`);
	}
}

/**
 * How long one attempt gets: the lobby's whole budget split between the clips it started with, floored at
 * `LOBBY_MIN_ATTEMPT_SECONDS`.
 *
 * ## Why the count is the lobby's, not the attempt's
 *
 * Item 158's first draft divided by the candidates *still* pickable, recomputed at each attempt — and a simulation of two
 * dead ids gave `5 + 10 = 15` seconds because the second attempt was divided by one instead of two. A budget that
 * re-derives itself as things fail is not a budget. The controller therefore computes this **once per lobby**, in
 * `beginSong`, and every attempt in that lobby uses the same share: two songs get five seconds each, three get three and a
 * third, and the worst case for a fully dead pair is the ten seconds the constant promises rather than fifteen.
 *
 * ## The floor, and the zero
 *
 * The floor can make the total exceed the budget — four ids at `10 / 4` is two and a half seconds, which is too short to be
 * a fair try at a cold fetch, so `4 x 3 = 12` is accepted. And `candidates === 0` is answered with the whole budget rather
 * than `math.huge`: it is reachable from `beginSong` (an empty pickable set is not an error there, just a silent lobby) and
 * an infinite timeout is the one value that would turn a silent lobby into a permanent one.
 */
function attemptSeconds(candidates: number): number {
	if (candidates <= 0) {
		return LOBBY_LOAD_BUDGET_SECONDS;
	}

	return math.max(LOBBY_MIN_ATTEMPT_SECONDS, LOBBY_LOAD_BUDGET_SECONDS / candidates);
}

/** Seconds to two places, so the play line is readable without `string.format`. */
function formatSeconds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}
