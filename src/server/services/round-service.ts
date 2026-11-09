import { CollectionService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import {
	CHOSEN_BALL_ID_ATTRIBUTE,
	hasOwnerIdentity,
	OWNER_DISPLAY_NAME_ATTRIBUTE,
	OWNER_USER_ID_ATTRIBUTE,
	PLAYER_COINS_ATTRIBUTE,
	PLAYER_OWNED_BALLS_ATTRIBUTE,
} from "shared/attributes";
import {
	DEBUG_INTERMISSION_REMOTE_NAME,
	DEBUG_PLAYING_REMOTE_NAME,
	DEBUG_SPAWN_REMOTE_NAME,
	DEBUG_WAITING_REMOTE_NAME,
	DECOY_OUTLINE_REMOTE_NAME,
	ELIMINATION_REMOTE_NAME,
	ELIMINATION_SOUND_REMOTE_NAME,
	HIT_EFFECT_REMOTE_NAME,
	PICKER_OFFER_REMOTE_NAME,
	PICKER_PICK_REMOTE_NAME,
	PICKER_REROLL_REMOTE_NAME,
	PLAYING_DEADLINE_VALUE_NAME,
	REMOTES_FOLDER_NAME,
	ROUND_PAYOUT_REMOTE_NAME,
	ROUND_STATE_VALUE_NAME,
	WINNER_NAME_VALUE_NAME,
} from "shared/remotes";
import { PickerOfferMessage, PickerResult, REROLL_COST_COINS } from "shared/picker";
import { ECONOMY_ACTION_COOLDOWN_MS } from "shared/economy.config";
import { payoutAwards, RoundPayoutMessage } from "shared/round-payout";
import { powerForBallId } from "shared/powers.config";
import { lastToucherOf, setHitEffectRemote, setPower } from "server/powers";
import { TAGS } from "shared/tags";
import { ROUND_TRANSITION_ATTRIBUTE, TRANSITION_NETWORK_STEP } from "shared/constants";
import { TRANSITION_CONFIG, coverSeconds, holdSeconds, openSeconds } from "shared/config/transition.config";
import {
	BELT_RAMP_SECONDS,
	ENROLLMENT_CUTOFF_SECONDS,
	INTERMISSION_SECONDS,
	PICKER_WINDOW_SECONDS,
	POST_GAME_SECONDS,
	ROUND_IDLE_WARN_SECONDS,
	TICK_INTERVAL_SECONDS,
	WAITING_SECONDS,
} from "shared/tuning";
import { BallOwner, BallSpawnerService } from "./ball-spawner-service";
import { EconomyService } from "./economy-service";
import { isStudioSession } from "./player-data-store";
import { decideRoundOutcome } from "../round-outcome";
import { decideDecoyOutline } from "../decoy-outline";
import { EliminationCause, splashTargetUserId } from "../elimination-signal";
import { shouldPlayEliminationSound } from "../elimination-sound";
import { applyReroll, buildOffer, isPickAllowed, ownedIdsFrom, rollPremium, StoredOffer } from "../picker";
import { pickDistinctBallIds } from "../debug-balls";
import { TreadmillService } from "./treadmill-service";

/**
 * The four phases of the game loop, in order. `Intermission` is both the start and the end state, which
 * is what makes the machine a loop rather than a single round.
 */
export type RoundPhase = "Intermission" | "Waiting" | "Playing" | "PostGame";

/**
 * **The environment, read once for this entire file (item 150).**
 *
 * Three call sites want it — the auto-bots at `Waiting` entry, the gate on key `2`'s bots, and the boot-time decision
 * about whether a solo Studio session needs populating at all — and three `RunService.IsStudio()` calls are three chances
 * to disagree about which environment this server is in. One read, one constant. `admin.ts` does the same for its arming
 * seed, so a boot has two environment reads in total, one per file, and the round report says so.
 *
 * Module-level rather than a field on the class: it is a property of the process, not of the service, and a field would
 * be one more thing a future `new RoundService()` in a spec would have to be told.
 */
const IS_STUDIO = isStudioSession();

/**
 * Runs the game loop: four phases, the belt ramp, elimination, the end condition, and reset.
 *
 * ## What the loop is
 *
 * `Intermission` → `Waiting` → `Playing` → `PostGame` → `Intermission`, driven by timers rather than by
 * a keypress. The belt is stopped everywhere except `Playing`, where it ramps linearly to full speed.
 * Bodies exist only between `Waiting` entry and the end of `PostGame`. Nothing here knows about players,
 * bets, powers, or UI.
 *
 * **The four names replaced `Idle` / `Countdown` / `Running` / `Ended` and no alias survives.** A state
 * under two names is a bug that only shows up rounds later, when one of the two is read by something
 * that was written before the rename: the code compiles, the log says the old word, and the reader has
 * to hold both vocabularies at once to know whether the machine is doing the right thing.
 *
 * ## The two API surfaces future powers depend on
 *
 * **`onTick(callback)` and `getElapsedSeconds()` are load-bearing, not speculative.** A power that
 * "lasts five seconds" or "fires once a second" needs a clock and an event that are not tied to
 * frames: frames are variable, replicated unevenly, and would make a power's duration depend on the
 * player's frame rate. These two exist so a power is written against round time — a number that is the
 * same on the server and in the log — and so its lifetime is declared in the same unit the round's own
 * phases use.
 *
 * `onTick` fires on `TICK_INTERVAL_SECONDS` during `Playing` and nowhere else, and returns a
 * disconnect. Subscribers must not assume they are called at exactly the interval: the loop is driven
 * by `task.wait`, so it is "about once a second", and a power that needs exact timing should compare
 * `elapsed` values rather than counting its own invocations.
 *
 * ## Elimination is positional, never event-driven
 *
 * A body is out when its centre leaves the `EliminationZone` part's box. Nothing about the test
 * involves `Touched`, and **no wall is consulted** — a wall is a guard rail inside the
 * play area and a body touching one is still racing. See `isInsideZone` and `settleEliminations`.
 *
 * ## Why the belt ramp is not on the tick
 *
 * The tick is 1 Hz because powers want a legible cadence. The belt ramp needs to look continuous, so it
 * runs on its own `Heartbeat` connection: at 1 Hz the ramp would be three visible jumps. Two clocks,
 * two purposes, and the comment on each says which.
 *
 * ## How clients learn the phase
 *
 * `ReplicatedStorage.RoundState` is a `StringValue` written on every transition. A client that starts
 * mid-phase reads it and is correct immediately; a client that wants to react subscribes to `Changed`.
 * A transition-only remote was rejected because a client joining between two transitions would never
 * learn the current phase until the next one fired — see the note on `ROUND_STATE_VALUE_NAME`.
 */
@Service()
export class RoundService implements OnStart {
	private phase: RoundPhase = "Intermission";

	/** Bodies the round is responsible for. Removed by elimination, external destruction, or reset. */
	private readonly liveBalls = new Set<BasePart>();

	/**
	 * `Instance.Destroying` per tracked body.
	 *
	 * **Without this the end condition can never fire.** Bodies die from places the round does not
	 * control — the spawner's `KillY` cull, its `MaxLiveBalls` cap, and anything a later slice adds — and
	 * a round that only counted its own eliminations would believe a body was alive after it had been
	 * destroyed, so "one remains" would never be true. The signal is the only way to notice a death that
	 * did not come through `settleEliminations`.
	 */
	private readonly destroyingConnections = new Map<BasePart, RBXScriptConnection>();

	private readonly tickCallbacks = new Set<(elapsed: number) => void>();

	private runningStartedAt = 0;
	private frozenElapsed = 0;

	/** Bumped on every phase entry; a scheduled transition with a stale generation does nothing. */
	private generation = 0;

	/**
	 * `os.clock()` of the last time the round lost a body, for the idle warning.
	 *
	 * Reset on every elimination and on every external destruction. Named "progress" rather than
	 * "elimination" because a body lost to the kill plane is just as much a change in the round's state as
	 * one that left the zone, and the warning's question is "has anything happened recently", not "has the
	 * zone done anything recently".
	 */
	private lastProgressAt = 0;

	/** Whether the once-per-round idle warning has printed. Reset at `Playing` entry. */
	private idleWarned = false;

	/**
	 * Every owned competitor that took part in the round, recorded **when its body was tracked**.
	 *
	 * ## Why the round has to keep this, when it keeps nothing else about the past
	 *
	 * A payout is owed to "everyone who raced", and by the time a round ends `getCompetitors()` holds one body. The
	 * participants are therefore a fact that only exists while the round runs — this is that record. It is written in
	 * `trackBall`, which is the single place every spawn path passes through, so a future spawn route cannot forget it.
	 *
	 * Reassigned rather than cleared in `clearAllBodies`, which is the one place a round's body set ends — see the note
	 * there for why the reset cannot live at `Playing` entry.
	 */
	private roundParticipants = new Array<BallOwner>();

	/**
	 * Competitors in the order their bodies left the round, **worst first** — the first entry finished last.
	 *
	 * ## Why elimination order is the only ranking this game has
	 *
	 * The round's own rule (`round-outcome`) says the last survivor wins and nothing else: there is no finish line, no
	 * elapsed-time cap, and `initialLiveCount` was deleted with the guard that read it. So the *result* of a round is exactly
	 * the sequence in which bodies died, read backwards — which is a by-product of elimination rather than a second opinion
	 * about it, and cannot disagree with the winner the round published.
	 *
	 * The leaderboard is deliberately **not** consulted: it ranks live bodies by distance from the spawn edge, it publishes
	 * at 1 Hz with a swap threshold, and at the moment this is read the field is one body. A snapshot of a decayed distance
	 * would be a plausible-looking ranking that is not the race's result.
	 */
	private eliminatedOwners = new Array<BallOwner>();

	/** The linear ramp's frame connection. `undefined` whenever the belt is not ramping. */
	private rampConnection?: RBXScriptConnection;

	// #region enrollment (item 159)

	/**
	 * **Who is in the next round**, as `UserId`s. One set, one owner, memory only.
	 *
	 * ## Why this exists at all
	 *
	 * The competitor list is decided at `Waiting` entry, from `Players.GetPlayers()` at that instant — thirty seconds after the
	 * lobby began. Everything between those two moments is a hole a joiner falls into: they arrive, see a lobby, and get a body
	 * in a round whose countdown they never saw. This set is the other half of that rule: a player is a competitor if they were
	 * connected before the last `ENROLLMENT_CUTOFF_SECONDS` of `Intermission`, and otherwise spectates this one.
	 *
	 * ## Why it is a running set and not a snapshot
	 *
	 * The alternative — freeze the list at the cutoff — records "was here at end − 5 s" instead of "is here now", and a
	 * snapshot cannot answer the question it exists to answer: somebody who arrived at end − 10 s and left at end − 3 s is in
	 * a snapshot and would be spawned as a body whose player is gone. Membership is therefore live: `PlayerAdded` adds while
	 * the window is open, `PlayerRemoving` always removes.
	 *
	 * ## Why the *window* is a separate flag and not "is the set non-empty"
	 *
	 * The set keeps its members after the window closes — that is what makes a `UserId` in it meaningful at spawn time — so
	 * "open" cannot be inferred from its contents. `enrollmentOpen` is the gate; the set is the record.
	 */
	private readonly enrolledUserIds = new Set<number>();

	/**
	 * Bumped every time a window opens, so a close callback armed by a previous window cannot close this one.
	 *
	 * Same guard shape as `generation`, and needed for the same reason the timer loop needs it: the zero-player re-arm opens a
	 * **new** window inside the same `Intermission`, so the previous window's `task.delay` is still pending and will fire after
	 * the new one has already closed — which would reopen nothing and silently end the new window five seconds early.
	 */
	private enrollmentGeneration = 0;

	/** Whether `PlayerAdded` currently enrolls. Opened by `openEnrollmentWindow`, closed by that window's own timer. */
	private enrollmentOpen = false;

	// #endregion

	/** True once the "no zone" warning has been said for the current round. */
	private warnedNoZone = false;

	/**
	 * Seconds a phase's timer is delayed by, because a wipe is covering the screen when the phase begins.
	 *
	 * Set by `transitionAround` *before* the phase entry runs, consumed by that entry's timer arming, and reset to
	 * zero as soon as it is read. It exists because those two things happen in this order and nothing else links
	 * them: `transitionAround` cannot arm the timer itself (the entry function owns that), and the entry function
	 * cannot know a wipe is running (it is called from four places, only two of which wipe).
	 *
	 * **It delays the clock's start; it does not shorten or lengthen any phase.** `WAITING_SECONDS` of `Waiting`
	 * is still `WAITING_SECONDS` - it just begins when the screen is clear.
	 */
	private pendingTimerHold = 0;

	/**
	 * Live count when the round entered `Playing`.
	 *
	 * Used only by the win condition: "one remains" is a win when several started, but with a single
	 * spawner the round would otherwise declare a winner in the same frame `Playing` begins, which is
	 * technically true and practically useless. A round that starts with one entrant simply runs its
	 * clock.
	 */

	/** The replicated `StringValue` clients read. Created in `onStart`. */
	private roundState?: StringValue;

	/** The replicated `StringValue` carrying the last round's winner. Created in `onStart`. */
	private winnerName?: StringValue;

	/**
	 * The replicated `NumberValue` carrying the server time `Waiting` ends, or `0` when no countdown is due. Created in
	 * `onStart`.
	 *
	 * A third value beside the phase and the winner, written by the one function that arms the `Waiting → Playing` timer
	 * because that is the only place the phase's real end is known (a round behind a transition wipe ends later than
	 * `WAITING_SECONDS`). See `PLAYING_DEADLINE_VALUE_NAME` for why the countdown reads a published deadline rather than
	 * recomputing one from the constants.
	 */
	private playingDeadlineValue?: NumberValue;

	/**
	 * The last synthetic owner number handed out, so the next debug competitor is `Debug#(n+1)`.
	 *
	 * Shared by `Waiting`-entry defaults and `3` presses rather than being two counters, because
	 * `OwnerUserId` is an **identity**: two bodies sharing `-1` would make "which competitor won"
	 * ambiguous in the log while looking fine in the world. It is reset whenever the world is cleared
	 * (a debug jump to `Waiting`, `PostGame → Intermission`) so the numbering restarts with the round.
	 */
	private nextDebugOwnerNumber = 0;

	// #region picker state

	/**
	 * Every player's current offer. **The single writer of "which ball am I racing as".**
	 *
	 * It lives here rather than in its own service because the offer is born and dies inside one phase, and this class is
	 * the only thing that owns both ends of it: the moment `Waiting` begins (where the offer is rolled) and the moment the
	 * body is spawned (where the pick becomes an attribute). A separate service would have to be told "the phase changed"
	 * by this one and would have to reach back into `liveBalls` to update a body — a dependency pair that is either
	 * circular or duplicated.
	 */
	private readonly offers = new Map<Player, StoredOffer>();

	/** Rewritten on every `Waiting` entry, and sent with each offer, so the countdown cannot be extended by a re-roll. */
	private pickerDeadline = 0;

	/** Last accepted re-roll per player. Same shape as `EconomyService`'s cooldowns, same 500 ms constant. */
	private readonly pickerCooldowns = new Map<Player, number>();

	private offerRemote?: RemoteEvent;
	private pickRemote?: RemoteEvent;
	private rerollRemote?: RemoteEvent;
	private eliminationRemote?: RemoteEvent;
	/** Broadcast — every client hears an elimination, and each one throttles its own playback. See `ELIMINATION_SOUND_REMOTE_NAME`. */
	private eliminationSoundRemote?: RemoteEvent;

	/**
	 * The payout channel: **one recipient per round**, fired after that player's coins were actually granted.
	 *
	 * Optional rather than required, like every other remote here: a server that failed to create it must still pay its
	 * players, so the grant is unconditional and only the panel is lost.
	 */
	private roundPayoutRemote?: RemoteEvent;

	// #endregion

	public constructor(
		private readonly treadmill: TreadmillService,
		private readonly spawner: BallSpawnerService,
		private readonly economy: EconomyService,
	) {}

	public onStart(): void {
		// The belt starts stopped. This runs before any belt is necessarily bound, which is fine:
		// `setBeltSpeed` stores the value and `readSpeed` applies it to each surface as it is created.
		this.treadmill.setBeltSpeed(0);

		this.createDebugRemotes();
		this.createPickerRemotes();
		this.createDecoyOutlineRemote();
		this.createHitEffectRemote();
		this.createRoundPayoutRemote();
		this.createRoundStateValue();

		// **Connected before the first window opens.** `startIntermissionTimer` seeds the enrollment set from the players
		// already here, so these two handlers are only ever needed for arrivals and departures *after* this line. Binding them
		// first nonetheless means there is no window in which a connection could happen with no listener: a handler that
		// arrives a millisecond later is a joiner who is a competitor by the seed and would never be removed.
		Players.PlayerAdded.Connect((player) => this.enrollOnJoin(player));
		Players.PlayerRemoving.Connect((player) => this.enrolledUserIds.delete(player.UserId));

		// The first `[Round]` line a fresh server prints must name the phase it is in, not the one it is
		// leaving, so it is a state line rather than an arrow. `Intermission` is the initial value of
		// `this.phase`, so there is no transition to log — only the announcement.
		this.publishPhase();
		print(`[Round] state=${this.phase} — keys: 1=Intermission 2=Waiting 3=Playing 4=spawn`);
		this.startIntermissionTimer();
	}

	// #region public API

	/**
	 * Forces the machine into `Intermission`, from any phase.
	 *
	 * ## Why this needed building
	 *
	 * `enterIntermission` had exactly one caller: the `PostGame` hold's timed transition. Nothing could *reach* the lobby
	 * except by playing a round out, which meant testing anything that lives there (`Waiting`'s picker, most of all) cost
	 * a thirty-second wait. A debug key cannot call the timed path either — that path goes through `endPlaying` first, which
	 * awards a winner and holds `PostGame` for five seconds.
	 *
	 * ## Why it duplicates three lines of `endPlaying` instead of calling it
	 *
	 * `endPlaying`'s job is to *decide a result*: freeze the clock, publish a winner, log `winner=`. A debug jump decides
	 * nothing — there is no result to publish and no winner to name — so routing through it would either invent a result or
	 * need a "don't log this" flag. The three things that genuinely must happen are here instead: stop the belt ramp, stop
	 * the simulation, and reset the synthetic counter, in that order, before the teardown that `enterIntermission` does.
	 *
	 * **The timer is re-armed by `enterIntermission` itself**, not inherited: it calls `startIntermissionTimer` after
	 * `++this.generation`, and that timer loops only while `phase === "Intermission"` *and* the generation matches. A jump
	 * that skipped `enterIntermission` would leave the previous phase's loop counting from its own start.
	 *
	 * **Not wrapped in `transitionAround`.** The wipe exists to cover a phase change the player did not ask for; a debug key
	 * is asked for, and covering the screen would hide the teardown the key exists to demonstrate.
	 */
	public forceIntermission(reason: string): void {
		this.stopBeltRamp();
		this.spawner.setRoundActive(false);
		this.resetSyntheticCounter();

		this.enterIntermission(reason);
	}

	/**
	 * Forces the machine into `Waiting`, from any phase, skipping whatever timer or end condition would
	 * have got there.
	 *
	 * **Bound to `2` since item 73.** The keys are in phase order now — `1` Intermission, `2` Waiting, `3` Playing,
	 * `4` spawn — so this used to be `1` and the docblocks and logs that said so were corrected with it. A reader holding a
	 * log from before that change will otherwise think `1` still reaches `Waiting`.
	 *
	 * **Every press is a reset, not a nudge.** Leaving `Playing` (or `PostGame`) means the bodies it was
	 * running are abandoned: the round is about to spawn a fresh competitor into a lane that still has
	 * debug balls rolling down it, and those are no longer anyone's. They must therefore be destroyed
	 * *before* the new round's names are handed out — otherwise the next round's `Debug#1` is a second body
	 * with the same identity as one still on the belt, and the winner log becomes unreadable.
	 *
	 * **The clear runs unconditionally, including a second press while already in `Waiting`.** An early
	 * version skipped it for that case on the reasoning that nothing was being abandoned — but `Waiting`
	 * *already has last press's competitor in it*, so re-entering spawned a second body and reset the
	 * counter under it, giving two live bodies the same `Debug#1`. `clearAllBodies` is a no-op walk when
	 * there is nothing tagged, so the unconditional version is both shorter and the only one that keeps
	 * identity unique.
	 *
	 * The synthetic counter resets with the world it describes, so the numbering restarts each round.
	 */
	public forceWaiting(reason: string): void {
		this.clearAllBodies("debug key 2");
		this.resetSyntheticCounter();

		const spawned = this.startWaitingRound(reason, false);

		// **Bots, but only where `startWaitingRound` did not already add them (item 150).**
		//
		// A Studio session usually has one player, so `Waiting` used to count down to a `Playing` phase with a single competitor
		// - which the first tick ended as `last standing`. The workaround was to press `4` inside the countdown, which is a race
		// against a timer rather than a test harness. Item 131 fixed that here, unconditionally.
		//
		// **The unconditional call was the wrong home for it.** `startWaitingRound` is the one place `Waiting` begins, so the
		// population belongs there: it covers this key *and* the `Intermission` timer, in every round rather than only the one
		// this key starts. What is left here is the case that call cannot cover — a **live** server, where the automatic
		// population is deliberately off. Key `2` is a debug verb somebody pressed on purpose, so on Live it keeps item 131's
		// behaviour: bots now, because a human asked.
		//
		// The call still sits **after `startWaitingRound`** (a spawn before it would take a spawner slot first, and the
		// players' own bodies would arrive second) and **before `enterWaiting`** (which prints the transition — bots spawned
		// after it would be missing from `competitors=` and would appear, in the log, to arrive after the phase they belong
		// to).
		const bots = IS_STUDIO ? 0 : this.spawnBots("auto-bots for debug key 2");

		this.enterWaiting(reason, spawned + bots);
	}

	/**
	 * Forces the machine into `Playing`: clear, spawn one competitor per connected player, then enter.
	 *
	 * **Spawn-then-enter, and the order is the fix.** The previous version entered `Playing` and let the
	 * 1 Hz tick discover there was nothing to race, which produced
	 * `Playing → PostGame (elapsed=1.02, no competitors)` — a round that never happened. A caller that
	 * spawns first makes the guard inside `enterPlaying` an assertion about the guard itself rather than
	 * a branch that turns a half-built round into a result.
	 *
	 * ## Pressed while already `Playing`: restart, do not refuse
	 *
	 * This branch used to print `debug-advance refused — already Playing` and return, which made `2` the
	 * only force key that did not produce its phase's starting state — the user saw a key that "does not
	 * clear", when in fact it cleared only when the machine happened to be elsewhere. A phase-force key
	 * now always produces that phase's start: from `Playing` it tears the competitors down and builds a
	 * fresh set without moving the phase.
	 *
	 * **`enterPlaying` is deliberately not called on this path.** It would (a) re-run `Playing`-entry side
	 * effects that are already in force — the belt ramp restart, `warnIfNoZone`, the tick loop — and (b)
	 * reset `runningStartedAt`, which is the round's elapsed clock. The user asked for the *competitors*
	 * to start over, not the round: `elapsed=` must keep counting through a restart, so the clock is left
	 * alone and only competitor state is reset.
	 *
	 * The generation counter is also left alone. `clearAllBodies` does not touch it, and bumping it here
	 * would retire the running 1 Hz tick — the round would go on existing with nothing eliminating or
	 * ending it.
	 */
	public forcePlaying(reason: string): void {
		if (this.phase === "Playing") {
			this.clearAllBodies("debug key 3 restart");
			this.resetSyntheticCounter();

			const restarted = this.spawnRoundCompetitors("debug key 3 restart", false, true);
			if (restarted === 0) {
				// `spawnRoundCompetitors` already printed the reason (no players, or no spawners). Staying in
				// `Playing` with an empty belt is the honest outcome: the round is running and has nothing to
				// race, and the idle warning will say so after `ROUND_IDLE_WARN_SECONDS`.
				return;
			}

			// **Bots on a restart too (item 150).** The user's ask is "press 2 or 3 and there is a round", and a restart that
			// produced only the player's body would be the same premature winner item 72 declares — one competitor, alone. It
			// sits after the empty-belt guard so that a key press with no player body still leaves the belt empty rather than
			// leaving bots on it, which is the same rule the fresh path below follows. Unconditional rather than Studio-gated:
			// key `3` is a debug verb somebody pressed on purpose, exactly like key `2` on Live.
			this.spawnBots("debug key 3 restart");

			// A fresh competitor set means a fresh "nothing has happened" window. Without this reset a restart
			// pressed 50 s into a quiet round would inherit the old clock and print the idle warning 10 s later,
			// blaming the new competitors for the old round's inactivity.
			this.lastProgressAt = os.clock();
			this.idleWarned = false;

			print(`[Round] Playing → Playing (${reason}, restart, competitors=${restarted})`);
			return;
		}

		if (this.phase === "PostGame") {
			// **New guard, added with the restart change.** `forcePlaying` previously had no `PostGame` branch
			// at all, so pressing `2` there cleared a round whose winner was still on display and entered a
			// fresh `Playing` — the one case where the clear destroys a result rather than a race in progress.
			// `1` remains the way out of `PostGame`, because it goes to `Intermission` and its own teardown path.
			print(`[Round] debug-advance refused — ${this.phase} is clearing`);
			return;
		}

		this.clearAllBodies("debug key 3");
		this.resetSyntheticCounter();

		const spawned = this.spawnRoundCompetitors(reason, false, true);
		if (spawned === 0) {
			// `spawnRoundCompetitors` already logged why. Staying put is the only honest outcome: entering
			// `Playing` with nothing to race is the 21:42 failure, and clearing again here would destroy
			// nothing while implying it had.
			print(`[Round] debug key 3: no competitors spawned, staying in ${this.phase}`);
			return;
		}

		// **Bots, for the same reason as the restart branch above (item 150).** After the empty-belt guard and before
		// `enterPlaying`, so the bodies exist when `Playing` entry prints `competitors=` and when the first tick counts them.
		this.spawnBots("debug key 3");

		if (!this.enterPlaying(reason)) {
			// ASSERTION FAILURE. See the note in `enterPlaying`: the caller spawned, and the guard still
			// refused, which means the guard and the competitor filter disagree — not that the round is in a
			// recoverable state. The bodies are deliberately left on the belt so the defect is visible in
			// Studio; the next `1`, `2`, `3` or `PostGame → Intermission` clears them.
			print(`[Round] ASSERTION FAILED: spawned ${spawned}, enterPlaying refused`);
		}
	}

	/**
	 * Spawns one competitor per connected player, capped at the number of bound spawners, and returns how
	 * many bodies were actually created.
	 *
	 * ## Zero players refuses rather than inventing one
	 *
	 * The earlier build fell back to a synthetic `Debug#1` so an unattended server still produced a
	 * winner. That fallback is gone: a competitor that is nobody's makes the winner rule report a name
	 * no player can act on, and it hides the actual condition — that nobody is here. A refusal is one
	 * line and leaves the machine where it was.
	 *
	 * ## The count is taken *after* the caller's clear
	 *
	 * `Players.GetPlayers()` is read here, not by the caller, so a player who disconnects between clearing
	 * the world and spawning cannot be counted as a competitor whose body will never arrive. The window is
	 * one call wide and the reading is the one that matters: the players who exist at the moment bodies are
	 * made.
	 *
	 * **That read is no longer the only thing the list is made of (item 159).** `Players.GetPlayers()` is still
	 * the source, but on the automatic path it is filtered by `enrolledUserIds` first, so a player who connected
	 * inside the last `ENROLLMENT_CUTOFF_SECONDS` of `Intermission` — or during `Waiting` — is connected and
	 * still not a competitor. The filter is the caller's decision rather than this function's, which is why it
	 * arrives as `useEnrollment` and not as a branch on `reason`: a reason string is a log line, and the
	 * automatic timer and the `2` key pass different policies through the same words.
	 *
	 * ## Capped, not wrapped
	 *
	 * Two players cannot share a lane — they would spawn inside each other and the round would read as one
	 * competitor that happened to explode. Players beyond the spawner count are therefore dropped, with a
	 * single line naming how many were wanted and how many exist, because a per-player "you were dropped"
	 * line would multiply with the player count and say the same thing each time.
	 *
	 * ## `drawBallIds`, and why it is a parameter rather than the default
	 *
	 * A real round has a pick: `Waiting` rolls an offer per player, so `chosenBallIdFor` answers and the body races the
	 * ball the player chose. **The `3` key is the only path into `Playing` that skips `Waiting`**, so its competitors have
	 * no pick at all and reach `spawnBall` as powerless bodies — no `Power` attribute, no badge, no collision group. Passing
	 * `true` gives every competitor a drawn id instead, which is a *debug* affordance and must not become the fallback:
	 * defaulting it on would let a real round with a missing offer race a random ball rather than the one on the player's
	 * screen.
	 *
	 * ## Why `useEnrollment` has no default
	 *
	 * A default is a policy nobody wrote down. `false` would make every future caller silently exempt from the cutoff — the
	 * bug this item exists to fix — and `true` would make a caller that forgot it spawn nobody in an empty lobby. So every
	 * call site states its answer, and the compiler is what remembers for the next one.
	 */
	public spawnRoundCompetitors(reason: string, useEnrollment: boolean, drawBallIds = false): number {
		const connected = Players.GetPlayers();
		const players = useEnrollment
			? connected.filter((player) => this.enrolledUserIds.has(player.UserId))
			: connected;

		// **Said before the refusal below, because it changes what a refusal means.** "no players connected" and "players
		// connected but none enrolled" are the same zero and completely different situations, and the second is the one that
		// needs the log.
		const skipped = connected.size() - players.size();
		if (skipped > 0) {
			print(`[Round] spawn skipped not-enrolled=${skipped} of ${connected.size()} connected (${reason})`);
		}

		const wanted = players.size();

		if (wanted === 0) {
			// **Two different zeros, two different lines.** "nobody is here" and "somebody is here and is not in this round" produce
			// the same refusal and want opposite responses from whoever reads it — the first is a server waiting for a player, the
			// second is a player watching a round they will not be in.
			print(
				connected.size() > 0
					? `[Round] spawn refused — ${connected.size()} connected, none enrolled (${reason})`
					: `[Round] spawn refused — no players connected (${reason})`,
			);
			return 0;
		}

		const lanes = this.spawner.getBoundSpawnerCount();
		if (lanes === 0) {
			print(`[Round] spawn refused — no spawners bound (${reason})`);
			return 0;
		}

		const count = math.min(wanted, lanes);
		if (wanted > lanes) {
			print(`[Round] spawn capped: wanted ${wanted}, spawners=${lanes}, spawned ${lanes}`);
		}

		// **The debug draw, and only the debug draw.** A real round enters `Waiting` first, where the picker writes a pick
		// for every player, so `chosenBallIdFor` answers and this block never runs. The `3` key is the one path into
		// `Playing` that skips `Waiting`, so its competitors have no pick — and took `spawnBall`'s "no ball id, no power"
		// route, arriving with no `Power` attribute, no badge and no collision group.
		//
		// **One draw of `count`, indexed by lane, rather than one draw per owner.** The count is exact here (`min(players,
		// lanes)`) and is known before the loop, so a single draw ties nothing together that is not already tied; and it is
		// what makes the bodies distinct ids, which a per-owner `pickDistinctBallIds(1)` cannot promise — four independent
		// single draws may collide. The `4` key draws the same way, so the two debug paths agree.
		const drawnBallIds = drawBallIds ? pickDistinctBallIds(count) : undefined;

		let spawned = 0;
		for (let lane = 0; lane < count; lane++) {
			const player = players[lane];
			if (player === undefined) {
				continue;
			}

			const owner: BallOwner = {
				userId: player.UserId,
				displayName: player.DisplayName,
				chosenBallId: drawnBallIds !== undefined ? drawnBallIds[lane] : this.chosenBallIdFor(player),
			};
			const ball = this.spawner.spawnInLane(lane, owner);
			if (ball === undefined) {
				continue;
			}

			this.trackBall(ball);
			spawned++;

			// The pick reaching the body, logged where it lands rather than where it was chosen: the two can disagree if
			// an offer was never generated, and this line is what makes that visible.
			const chosen = owner.chosenBallId;
			if (chosen !== undefined) {
				print(`[Picker] spawn player=${player.Name} ball=${chosen}`);
			}

			// **`enrolled=` is the fact, not the decision.** The filter above dropped a non-enrolled player before this line, so
			// on the automatic path every body here reads `enrolled=true`. It is the debug paths, which bypass the filter, that
			// make the field worth printing: a `false` on a body means a debug key put it there, and the alternative — a field
			// that is always `true` where it appears — is a field a reader would stop trusting.
			const enrolled = this.enrolledUserIds.has(owner.userId);
			print(
				`[Round] spawn lane=${lane} owner=${owner.displayName}(${owner.userId}) enrolled=${tostring(enrolled)} body=${ball.GetFullName()}`,
			);
		}

		return spawned;
	}

	/** Zeroes the `Debug#N` counter so the next synthetic owner starts at `#1` again. */
	private resetSyntheticCounter(): void {
		this.nextDebugOwnerNumber = 0;
	}

	/**
	 * Spawns one competitor per bound spawner, each with its own synthetic owner, from any `Playing`
	 * round.
	 *
	 * ## Why this needs no bookkeeping any more
	 *
	 * `initialLiveCount` used to be rewritten here so the win check could tell "one competitor left" from "one competitor
	 * ever started". The field is gone (item 72) because the check no longer asks that question, so a debug spawn needs no
	 * record of its own: the bodies are tracked below, and the next check simply counts them.
	 *
	 * ## Why `Waiting` is allowed as well as `Playing`
	 *
	 * The bodies are only orphans if nothing will ever move them, and `Waiting` is not that: it is the phase in which
	 * `forceWaiting` already spawns the players' own bodies, and `scheduleWaitingTimeout` is guaranteed to promote it to
	 * `Playing`, where the tick takes over. A body added here sits on a stopped belt for the length of the countdown - which
	 * is exactly what the player's body does - and is then raced, eliminated and cleaned up by the same code.
	 *
	 * **`Intermission` and `PostGame` stay refused**, for the original reason: neither has a scheduled entry into `Playing`,
	 * and `Intermission` clears every body on the way in, so a spawn there would be destroyed before anybody saw it.
	 *
	 * ## Why it returns a count
	 *
	 * `forceWaiting` calls it to populate a solo session automatically, and its transition line prints `competitors=<n>`. If
	 * the bots were spawned without being counted that line would say `competitors=1` in a round with five bodies, and a log
	 * that disagrees with the world is worse than no log.
	 */
	public debugSpawnCompetitors(reason = "debug key 4"): number {
		if (this.phase !== "Playing" && this.phase !== "Waiting") {
			print(`[Round] debug spawn refused - not Playing or Waiting (phase=${this.phase})`);
			return 0;
		}

		return this.spawnBots(reason);
	}

	/**
	 * Spawns one bot per bound spawner, each with its own synthetic owner. **No phase gate** — the caller owns that
	 * question (item 150).
	 *
	 * ## Why this is a separate function from `debugSpawnCompetitors`
	 *
	 * The gate used to sit inside the one function that could spawn bots, which meant every new caller had to be a debug
	 * key. There are four now — key `4`, key `2` outside Studio, key `3`, and the automatic solo-Studio population of
	 * `Waiting` — and only the first wants the "is this a phase bodies can exist in" check. The split is item 87's
	 * `playEliminationSound` shape: the rule lives where it can be read once, and each caller states its own precondition
	 * by having passed one.
	 *
	 * **The body is unchanged from item 131:** the count is `getBoundSpawnerCount()`, the owners are synthetic
	 * `Debug#N`, every body is tracked, and the log line is the one key `4` has always printed.
	 *
	 * ## The log line
	 *
	 * `[Round] debug spawn (<reason>): <n> competitors (<first>..<last>) balls=<ids>, live=<n>`. The reason text is the
	 * caller's, so the log says which path made the bodies rather than leaving a reader to infer it: `debug key 4`,
	 * `debug key 2`, `debug key 3`, `debug key 3 restart`, `auto-bots for debug key 2`, `studio-auto`.
	 *
	 * ## Why the ids are named
	 *
	 * Ten is more than a reader can infer from a count. A press that produced four bodies tells a Studio session nothing
	 * about *which* four powers it is watching; one line naming them makes the observation repeatable ("run it again
	 * until `rocket` appears") instead of guesswork. They are read back off the **bodies** rather than out of `owners`, so
	 * the line describes what exists: a spawn that failed leaves a body out of the returned array, and a log naming an id
	 * with no body behind it would be worse than no log.
	 */
	private spawnBots(reason: string): number {
		const owners = this.nextDebugOwners(this.spawner.getBoundSpawnerCount());
		const spawned = this.spawner.spawnForRound(owners);
		for (const ball of spawned) {
			this.trackBall(ball);
		}

		const first = owners[0];
		const last = owners[owners.size() - 1];

		const ballIds = new Array<string>();
		for (const ball of spawned) {
			const ballId = ball.GetAttribute(CHOSEN_BALL_ID_ATTRIBUTE);
			if (typeIs(ballId, "string")) {
				ballIds.push(ballId);
			}
		}

		print(
			`[Round] debug spawn (${reason}): ${spawned.size()} competitors (${first === undefined ? "none" : first.displayName}..${last === undefined ? "none" : last.displayName}) balls=${ballIds.join(",")}, live=${this.liveBalls.size()}`,
		);

		return spawned.size();
	}

	/** Hands out the next `Debug#N` owner, continuing the shared counter. */
	private nextDebugOwner(chosenBallId: string | undefined): BallOwner {
		this.nextDebugOwnerNumber++;
		return {
			userId: -this.nextDebugOwnerNumber,
			displayName: `Debug#${this.nextDebugOwnerNumber}`,
			chosenBallId,
		};
	}

	/**
	 * `count` fresh synthetic owners, in order, each racing a **different** ball.
	 *
	 * The ids come from `pickDistinctBallIds`, so one press never produces two bodies of the same ball — which is the
	 * whole point of the debug spawn, since a Studio session watching four identical powers has learned nothing. The draw
	 * is per press and does not consult the live field; see that function for why.
	 *
	 * **Nothing here writes a `Power` attribute.** `spawnBall` derives it from `chosenBallId` through `setPower`, so the
	 * badge, the collision group and the `Touched` connection all follow from the id. A second write here would be a second
	 * place for a body's power to be decided.
	 *
	 * `count` may exceed the number of ids only if the pool is smaller than the lane count; the pick then repeats, which is
	 * the documented fallback rather than a case to guard.
	 */
	private nextDebugOwners(count: number): BallOwner[] {
		const ballIds = pickDistinctBallIds(count);

		const owners = new Array<BallOwner>();
		for (let index = 0; index < count; index++) {
			owners.push(this.nextDebugOwner(ballIds[index]));
		}
		return owners;
	}

	public getPhase(): RoundPhase {
		return this.phase;
	}

	/**
	 * Seconds since `Playing` began.
	 *
	 * Zero during `Intermission` and `Waiting`; counting during `Playing`; **frozen at the round's final
	 * value during `PostGame`**. The freeze is what lets anything reading the result — a log line, a later
	 * bet settlement, a power's handler still running — see the number the round ended with rather than
	 * one that keeps growing while the bodies are on display.
	 */
	public getElapsedSeconds(): number {
		if (this.phase === "Playing") {
			return os.clock() - this.runningStartedAt;
		}

		return this.frozenElapsed;
	}

	/**
	 * The bodies still in the round.
	 *
	 * **Returns survivors during `PostGame`, not an empty list.** The round is over but the result is being
	 * displayed, and a caller asking "who is left" during the hold wants the answer the round ended
	 * with — the same reason `getElapsedSeconds` is frozen. Empty in `Intermission` (no round) and in
	 * `Waiting` before the spawn returns.
	 */
	public getLiveBalls(): BasePart[] {
		const balls = new Array<BasePart>();
		for (const ball of this.liveBalls) {
			if (ball.Parent !== undefined) {
				balls.push(ball);
			}
		}
		return balls;
	}

	/**
	 * Subscribes to the round's 1 Hz tick during `Playing`.
	 *
	 * Returns a disconnect. Fires once per `TICK_INTERVAL_SECONDS` while `Playing`, never in any other
	 * phase — a power is scoped to a round's playing time by construction, so it cannot leak into the
	 * lobby or outlive the result.
	 */
	public onTick(callback: (elapsed: number) => void): () => void {
		this.tickCallbacks.add(callback);
		return () => {
			this.tickCallbacks.delete(callback);
		};
	}

	// #endregion

	// #region phase transitions

	/**
	 * Publishes the current phase to `ReplicatedStorage.RoundState`.
	 *
	 * **Called from every transition, immediately after that transition's log line, and it prints
	 * nothing.** One function for both the log and the value is not possible without double-logging, so
	 * the log line stays with the transition that knows its own reason and this only publishes. What it
	 * guarantees is that there is exactly one place the client-visible value is written, which is what
	 * keeps "the log says `Playing`" and "clients see `Playing`" the same statement — the failure it
	 * prevents is a phase the server entered and never announced, which presents as a GUI bug.
	 */
	/**
	 * Publishes the current phase to `ReplicatedStorage.RoundState`.
	 *
	 * **Called from every transition, immediately after that transition's log line, and it prints
	 * nothing.** One function for both the log and the value is not possible without double-logging, so
	 * the log line stays with the transition that knows its own reason and this only publishes. What it
	 * guarantees is that there is exactly one place the client-visible value is written, which is what
	 * keeps "the log says `Playing`" and "clients see `Playing`" the same statement — the failure it
	 * prevents is a phase the server entered and never announced, which presents as a GUI bug.
	 */
	private publishPhase(): void {
		if (this.roundState !== undefined) {
			this.roundState.Value = this.phase;
		}
	}

	/**
	 * Publishes the winner's display name, or clears it.
	 *
	 * Matches `publishPhase` deliberately — one writer per replicated value, called from the transition
	 * that decides it — so the log line and the client value cannot disagree about who won. `""` rather
	 * than `nil` for "nobody": a client reading an empty string can tell "cleared" from "not yet set".
	 */
	private publishWinner(winner: BallOwner | undefined): void {
		if (this.winnerName !== undefined) {
			this.winnerName.Value = winner === undefined ? "" : winner.displayName;
		}
	}

	/**
	 * Publishes the time `Waiting` ends, or `0` for "no countdown is due" (item 149).
	 *
	 * A third writer in the same family as `publishPhase` and `publishWinner`: one function per replicated value, called
	 * only by the functions that know the fact. `0` rather than `nil` for "none", for the reason the winner uses `""` — a
	 * client reading zero can tell "cleared" from "not yet written", and a client that joins during `Playing` must not
	 * inherit a deadline from a `Waiting` that is over.
	 */
	private publishPlayingDeadline(deadline: number): void {
		if (this.playingDeadlineValue !== undefined) {
			this.playingDeadlineValue.Value = deadline;
		}
	}

	/**
	 * Enters the lobby. **Spawns nothing** — the caller has already established the competitor set.
	 *
	 * The spawn used to live here, which made "how many competitors a round starts with" a property of a
	 * phase transition rather than of the caller that decided it. That is what put one ball on the belt for
	 * `1` and zero for `2`: the two callers wanted different things and shared one spawn site. Callers now
	 * spawn (`spawnRoundCompetitors`) and this only moves the machine.
	 *
	 * `Waiting` is allowed to be empty: `1` with nobody connected refuses the spawn and lands here anyway,
	 * so the phase can be inspected with no bodies in it. The transition out is guarded instead — see
	 * `enterPlaying`.
	 */
	/**
	 * Runs a phase change behind a screen-covering wipe.
	 *
	 * **The phase's timer must not advance while the screen is covered.** The state change happens *inside* the
	 * cover, and the hold before the timer starts is the difference between "the round begins" and "the round
	 * began two seconds ago while you were staring at a black screen".
	 *
	 * The sequence is the reference project's, and each wait has one job:
	 *
	 * 1. Bump `ROUND_TRANSITION_ATTRIBUTE` on every player. That is the *only* cue the client gets; it watches its
	 *    own attribute and plays the wipe.
	 * 2. Wait the cover plus a network step. The cover finishes on the client's clock, which the server cannot
	 *    read, so the step is the tolerance that puts this wait after the last cell has closed rather than one
	 *    frame before it.
	 * 3. Apply the state change. The screen is dark; this is the frame the wipe exists to hide.
	 * 4. Wait the hold plus the open, then clear `pendingTimerHold`. The phase entry armed its timer *with* that
	 *    hold already set, so the clock starts as this wait ends.
	 *
	 * **Scheduled, not awaited.** `task.spawn` so the caller returns immediately and the round's other tick
	 * handlers keep running; the phase machine is the caller's, not this function's.
	 *
	 * **`ENABLED` is read on both sides.** When it is false the change happens synchronously with no bump and no
	 * hold, which is the pre-transition behaviour exactly - a wipe that plays on one side and not the other is the
	 * failure mode this flag exists to prevent.
	 */
	private transitionAround(from: RoundPhase, label: string, cb: () => void): void {
		if (!TRANSITION_CONFIG.ENABLED) {
			cb();
			return;
		}

		this.pendingTimerHold = holdSeconds() + openSeconds();

		task.spawn(() => {
			print(`[Transition] covering (${from} ? ${label})`);

			for (const player of Players.GetPlayers()) {
				const current = player.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);
				player.SetAttribute(ROUND_TRANSITION_ATTRIBUTE, typeIs(current, "number") ? current + 1 : 1);
			}

			task.wait(coverSeconds() + TRANSITION_NETWORK_STEP);
			cb();
			task.wait(holdSeconds() + openSeconds());

			print(`[Transition] uncovered (${label})`);
		});
	}

	/**
	 * Reads and clears the hold a wipe asked for, in seconds.
	 *
	 * One reader per phase entry, immediately before arming that phase's timer. Consuming rather than peeking is
	 * what keeps the hold from leaking into the *next* phase - a `Waiting` that was wiped must not delay the
	 * `Playing` that follows it.
	 */
	private consumeTimerHold(): number {
		const hold = this.pendingTimerHold;
		this.pendingTimerHold = 0;
		return hold;
	}

	private enterWaiting(reason: string, competitors: number): void {
		const from = this.phase;
		this.phase = "Waiting";
		const generation = ++this.generation;

		// **The wipe's hold, read once, at the entry to the phase (item 149).** It used to be read inside
		// `scheduleWaitingTimeout`, which was correct while the timer was its only reader. There are three now - the phase
		// timer, the countdown's published deadline and the pick window - and three readers of one number is how "waiting is
		// fifteen seconds" and "waiting is fifteen seconds plus the wipe" become two different beliefs. One read, one
		// arithmetic, everyone downstream reads the result.
		const hold = this.consumeTimerHold();

		// **Not `true` any more.** `Waiting` used to switch the spawner's simulation on, which meant the
		// `BALL_SPEED` decay ran while a body sat on a stopped belt and the ball drifted before the round even
		// began. The flag is now set in `enterPlaying` and nowhere else, so the model runs for exactly the phase
		// it describes.
		this.spawner.setRoundActive(false);

		this.treadmill.setBeltSpeed(0);

		// **The enrollment window ends with the lobby (item 159).** Usually the cutoff already closed it five seconds ago; this
		// is for the debug press that leaves `Intermission` early and would otherwise leave the flag saying "open" through the
		// whole of `Waiting`. Idempotent, so the ordinary path prints nothing here.
		this.closeEnrollmentWindow();

		print(`[Round] ${from} → Waiting (${reason}, competitors=${competitors})`);
		this.publishPhase();

		// **The one place the phase's end is computed.** `Waiting` lasts `WAITING_SECONDS` plus the wipe's hold, and the hold
		// exists nowhere else. Publishing it is what lets the countdown be anchored to the phase rather than to whenever this
		// client happened to notice it (item 149), and the pick window is derived from it rather than from its own reading of
		// the clock - so the gap between the panel closing and the countdown starting is a constant
		// `WAITING_SECONDS - PICKER_WINDOW_SECONDS`, on a wiped round exactly as on a debug-key one.
		const endsAt = Workspace.GetServerTimeNow() + WAITING_SECONDS + hold;
		this.publishPlayingDeadline(endsAt);

		// **The offers are announced here, not where they were rolled.** `startWaitingRound` rolls them before the spawn,
		// because the body must carry its pick from birth; the *message* carries the window's deadline, which is only known
		// now. Sending it earlier is what made the panel count down from the moment the offers were rolled - i.e. behind the
		// transition wipe - so a wiped round showed ~11 s of picker and then left a four-second hole before the countdown.
		this.pickerDeadline = endsAt - (WAITING_SECONDS - PICKER_WINDOW_SECONDS);
		this.announceOffers();
		this.armPickWindowClose(this.pickerDeadline);

		this.scheduleWaitingTimeout(generation, WAITING_SECONDS + hold);
	}

	/**
	 * Arms the `Waiting → Playing` timer, re-arming itself once if the guard refuses.
	 *
	 * **The delay is the caller's.** `enterWaiting` is the one function that knows a wipe is holding the clock; this only
	 * waits for the number it is handed. The re-arm below passes `WAITING_SECONDS` bare, because the hold must not be added
	 * twice - the screen is clear by the time a re-armed lobby counts down.
	 *
	 * **A refusal is expected here and is not an error.** Nothing spawned at this transition — the bodies
	 * were made when `Waiting` was entered — so by the time the timer fires they may all have been
	 * destroyed by the spawner's `MaxLiveBalls` eviction or a manual cleanup. The re-arm exists so that state is visible as
	 * `[Round] Waiting timer re-armed — no competitors (0)` rather than as a phase that silently never
	 * advances, which is indistinguishable from a dead server.
	 */
	private scheduleWaitingTimeout(generation: number, delaySeconds: number): void {
		task.delay(delaySeconds, () => {
			if (generation !== this.generation || this.phase !== "Waiting") {
				return;
			}

			if (this.enterPlaying("waiting elapsed")) {
				return;
			}

			print(`[Round] Waiting timer re-armed — no competitors (0)`);

			// **No countdown on a re-armed lobby.** Nothing is going to race, so a fresh deadline would put a 3-2-1 in front of
			// a state that will fail this same guard again fifteen seconds later, forever. Clearing it says "there is nothing
			// to count down to", which is exactly true.
			this.publishPlayingDeadline(0);
			this.scheduleWaitingTimeout(this.generation, WAITING_SECONDS);
		});
	}

	/**
	 * Transitions into `Playing` **if there is something to race**, and reports whether it did.
	 *
	 * ## Why this returns a boolean instead of spawning
	 *
	 * The guard and the spawn were in one function, so a caller with no competitors could not tell "the
	 * round started" from "the round started and immediately had nothing in it" — and the 21:42 run showed
	 * the machine choosing the second: `Playing → PostGame (elapsed=1.02, no competitors)`. Splitting them
	 * makes the caller responsible for the competitor set and leaves this as a precondition check.
	 *
	 * ## The two callers read `false` differently
	 *
	 * - `forcePlaying` spawned immediately before calling, so `false` means the guard and the competitor
	 *   filter disagree — an **assertion failure**, logged as one and left visible.
	 * - `scheduleWaitingTimeout` spawned nothing, so `false` is a **legitimate refusal**: the bodies are
	 *   gone and the lobby re-arms.
	 *
	 * The interpretation lives in the caller because only the caller knows whether it just spawned. A
	 * parameter here would be a flag duplicating that knowledge, and the two call sites would drift.
	 */
	private enterPlaying(reason: string): boolean {
		const competitors = this.getCompetitors();
		if (competitors.size() === 0) {
			print(`[Round] refused Playing — no competitors (${reason})`);
			return false;
		}

		const from = this.phase;
		this.phase = "Playing";
		const generation = ++this.generation;
		this.runningStartedAt = os.clock();
		this.frozenElapsed = 0;

		// The pick window closes with the phase, and only when the phase actually moved: every refusal above returns before
		// this line, so a lobby that re-arms keeps its offers and its countdown rather than silently losing them.
		this.closeOffers();

		// **The countdown's deadline dies with the phase it belongs to (item 149).** Same rule as the offers: a client that
		// joins during `Playing` reads one value to learn "no countdown is due", rather than a past deadline it has to
		// reason about. `closeOffers` is the picker's half of "Waiting is over"; this is the countdown's.
		this.publishPlayingDeadline(0);

		// The idle clock starts with the round, and the warning flag with it: a round that begins and then
		// sits still for `ROUND_IDLE_WARN_SECONDS` is exactly the case the warning is for, and a flag left
		// set from a previous round would suppress it.
		this.lastProgressAt = this.runningStartedAt;
		this.idleWarned = false;

		print(`[Round] ${from} → Playing (elapsed=0, ${reason}, competitors=${competitors.size()})`);
		this.publishPhase();

		// **The simulation switch, at the one place `Playing` begins.** Without this, `BallSpawnerService`'s
		// `stepBallSpeeds` returns on its first line and `BALL_SPEED` never decays: a Studio run that reached
		// `Playing` through `forcePlaying` (key `2` from `Intermission`) sat with `BALL_SPEED=10`,
		// `RELATIVE_SPEED=0` and a motionless ball for 34 s, because `forcePlaying` never passes through
		// `enterWaiting`, which was the only caller. `forceWaiting`, `forcePlaying` and the timers all reach
		// `Playing` through this function, so this is the choke point rather than three call sites.
		this.spawner.setRoundActive(true);

		this.warnIfNoZone();
		this.startBeltRamp();
		this.startTickLoop(generation);

		return true;
	}

	/**
	 * Ends the round and holds the result for `POST_GAME_SECONDS`.
	 *
	 * `reason` is the only record of *why* the round ended — last standing, no survivors, no competitors —
	 * and `winner` is the owner to publish: `undefined` means nobody won, which is a real outcome (every
	 * competitor eliminated) and is reported as such rather than as a missing value.
	 *
	 * `elapsed` is still logged here even though nothing ends on time any more: it is the one number that
	 * says how long the round took, and it is read from `frozenElapsed` — the same clock that used to feed
	 * the cap, which is why removing the cap did not remove the timer.
	 */
	private endPlaying(reason: string, winner: BallOwner | undefined): void {
		if (this.phase !== "Playing") {
			return;
		}

		this.frozenElapsed = os.clock() - this.runningStartedAt;
		this.phase = "PostGame";
		const generation = ++this.generation;

		this.stopBeltRamp();
		this.treadmill.setBeltSpeed(0);
		this.spawner.setRoundActive(false);

		this.publishWinner(winner);

		print(
			`[Round] Playing → PostGame (elapsed=${formatSeconds(this.frozenElapsed)}, ${reason}, winner=${winner === undefined ? "none" : winner.displayName}, owner=${winner === undefined ? "none" : tostring(winner.userId)})`,
		);
		this.publishPhase();

		task.delay(POST_GAME_SECONDS, () => {
			if (generation !== this.generation || this.phase !== "PostGame") {
				return;
			}

			// **Wrapped.** `PostGame ? Intermission` is the other covered transition.
			this.transitionAround("PostGame", "Intermission", () => this.enterIntermission("post-game hold elapsed"));
		});

		// **Paying out after the hold is armed, not before it.** `grantCoins` saves the profile per player, and a save is the
		// one thing here that can yield; a payout placed above this line would make the length of `PostGame` depend on how
		// fast DataStore answered. Arming the timer first makes the phase's duration a constant and the payout a thing that
		// finishes inside it. The bodies are already frozen and the winner already published, so nothing below can change the
		// result — it only prices it.
		this.payOut(winner);
	}

	/**
	 * Grants every player's round payout and tells each one what it was.
	 *
	 * ## Why the award is computed from the record and not from the world
	 *
	 * See `roundParticipants` and `eliminatedOwners`: at this point the field is one body, and the ranking is history. The
	 * rule itself lives in `shared/round-payout` so it can be asserted without an engine — this method only does the part
	 * that touches instances: resolve an owner id to a `Player`, read the balance, grant, publish, log.
	 *
	 * ## Why the balance is read as an attribute rather than from the profile
	 *
	 * `EconomyService` owns the profile and exposes no getter, and the attribute is the balance it publishes — the same value
	 * the shop's coin pill reads. Using it means the server and every client agree about the number being animated, and it
	 * costs no new API on the economy (whose save and DataStore paths are explicitly out of scope for this change).
	 *
	 * ## Why a failed grant is silent on the remote side
	 *
	 * `grantCoins` returns false when there is no profile or the save failed, and it has already warned with the reason. A
	 * panel counting up coins that were never added would be a second, worse report of the same failure.
	 */
	private payOut(winner: BallOwner | undefined): void {
		const awards = payoutAwards({
			participants: this.roundParticipants,
			eliminated: this.eliminatedOwners,
			winner,
		});

		if (awards.size() === 0) {
			return;
		}

		for (const award of awards) {
			// `undefined` for a player who left between being paid for and being told. Their grant is skipped rather than
			// retried: the profile is gone with the session, and the next round pays them afresh.
			const player = Players.GetPlayerByUserId(award.userId);
			if (player === undefined) {
				continue;
			}

			const balanceBefore = readCoins(player);
			if (!this.economy.grantCoins(player, award.total)) {
				continue;
			}
			const balanceAfter = readCoins(player);

			const message: RoundPayoutMessage = {
				base: award.base,
				bonus: award.bonus,
				total: award.total,
				placement: award.placement,
				balanceBefore,
				balanceAfter,
			};

			print(
				`[Round] payout player=${award.displayName} placement=${award.placement === 0 ? "none" : tostring(award.placement)} base=${award.base} bonus=${award.bonus} total=${award.total} coins=${balanceAfter}`,
			);

			this.roundPayoutRemote?.FireClient(player, message);
		}
	}

	private enterIntermission(reason: string): void {
		const from = this.phase;
		this.phase = "Intermission";
		this.generation++;

		this.clearAllBodies("intermission");

		this.treadmill.setBeltSpeed(0);
		this.frozenElapsed = 0;
		this.warnedNoZone = false;

		// The winner belongs to the round that just ended, so it is cleared here rather than at the start of
		// the next one: a client watching `Intermission` must not still be showing a result from a round
		// that is over, and clearing at `Waiting` instead would leave the stale name visible for the whole
		// gap.
		this.publishWinner(undefined);

		// The countdown's deadline belongs to the `Waiting` that was abandoned, not to the lobby that follows it (item 149).
		// `Playing` clears it on the way out of a round that ran; a debug jump from `Waiting` to `Intermission` never reaches
		// that line, so this is the second exit and not a duplicate.
		this.publishPlayingDeadline(0);

		print(`[Round] ${from} → Intermission (${reason})`);
		this.publishPhase();

		this.startIntermissionTimer();
	}

	/**
	 * Destroys every body carrying `TAGS.ball`, tracked or not, and forgets the tracked ones first.
	 *
	 * **Enumerated by tag, not from the live set.** The live set only contains bodies `RoundService`
	 * tracked, and the 21:20 log proved what happens when something else creates one: the round tore down
	 * its own bodies at `Intermission` and left an untracked ball rolling 274 studs past the belt's end for
	 * the rest of the session. Enumerating the tag makes teardown independent of how the body got there —
	 * and with the manual spawn path now deleted the two sets should be identical, so this costs one
	 * `GetTagged` walk per teardown and removes the class of bug rather than the instance.
	 *
	 * `forgetBall` runs first for each body, which is what stops the `Destroying` handler treating the
	 * round's own teardown as an outside death and re-running the end condition on a phase that is ending.
	 */
	private clearAllBodies(reason: string): void {
		let destroyed = 0;

		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			if (!instance.IsA("BasePart")) {
				continue;
			}

			this.forgetBall(instance);
			instance.Destroy();
			destroyed++;
		}

		this.liveBalls.clear();

		// **The payout records describe the bodies the round owns, so they are cleared with them.** This is the one place
		// every round's body set ends — `forceWaiting`, the `Playing` restart, and `Intermission` — so resetting here means
		// a record can never describe a body that no longer exists, and a record from the previous round can never price the
		// next one.
		//
		// **It cannot live in `enterPlaying`.** Competitors are spawned during `Waiting` (and by the auto-bots that
		// `forceWaiting` adds there), so a reset at `Playing` entry would throw away every participant recorded while the
		// countdown ran — a round of five would pay nobody.
		this.roundParticipants = new Array<BallOwner>();
		this.eliminatedOwners = new Array<BallOwner>();

		if (destroyed > 0) {
			print(`[Round] cleared ${destroyed} ball(s) (${reason})`);
		}
	}

	/**
	 * Opens the enrollment window for one `Intermission`, and schedules its close.
	 *
	 * ## Called from the timer, not from `enterIntermission`
	 *
	 * That is the one place every `Intermission` passes through: `onStart` arms the timer directly without entering the phase
	 * (the boot state *is* `Intermission`), `enterIntermission` arms it, and — the case that decides it — **the zero-player
	 * re-arm loops inside the same timer task and never re-enters the phase at all**. Opening the window in
	 * `enterIntermission` would therefore leave a re-armed lobby with a closed window for ever: `PlayerAdded` would stop
	 * enrolling, the first joiner would never be a competitor, `startWaitingRound` would return zero, and the timer would
	 * re-arm again. A deadlock whose log reads as "waiting for a player" while a player is standing in the lobby.
	 *
	 * ## The seed
	 *
	 * Every connected player is enrolled at open, because somebody already here when the lobby starts is not a late joiner.
	 * Without the seed the rule would be "did you connect during this thirty seconds", which is not the rule — it would
	 * exclude the very players the lobby is for.
	 *
	 * ## The guard the close needs
	 *
	 * A re-arm opens a second window while the first window's close is still pending, so the callback compares its captured
	 * generation before acting. A `task.delay` that cannot be cancelled is fine as long as it is harmless when it fires.
	 */
	private openEnrollmentWindow(spanSeconds: number): void {
		this.enrollmentGeneration++;
		const generation = this.enrollmentGeneration;

		this.enrolledUserIds.clear();
		this.enrollmentOpen = true;

		let seeded = 0;
		for (const player of Players.GetPlayers()) {
			this.enrolledUserIds.add(player.UserId);
			seeded++;
		}

		print(`[Enrollment] window open generation=${generation} seeded=${seeded}`);

		// `max` and not a bare subtraction: a future tuning pass that made the cutoff longer than the phase would otherwise
		// schedule a negative delay, which the engine clamps to "now" — a window that closes in the same frame it opens, with
		// no line saying why.
		const delay = math.max(0, spanSeconds - ENROLLMENT_CUTOFF_SECONDS);

		task.delay(delay, () => {
			if (generation !== this.enrollmentGeneration) {
				return;
			}

			this.closeEnrollmentWindow();
		});
	}

	/**
	 * Closes the window: no further joins enroll. **Idempotent, and that is what lets two callers exist.**
	 *
	 * The scheduled close is the real one — it is the cutoff — but `enterWaiting` closes it too, because a debug press can leave
	 * `Intermission` long before the cutoff arrives and a flag that says "open" while the phase is `Waiting` is a lie waiting
	 * to be read as a bug. The second caller finds `enrollmentOpen` already false and says nothing, so one window produces one
	 * line whichever path got there first.
	 *
	 * **The set is deliberately not cleared.** It is what `enrolled=` on the spawn line is read from, and the spawn happens
	 * before this — but more importantly a cleared set would make every later spawn report `enrolled=false`, including the
	 * bodies spawned by a debug key, which is the case that field exists to distinguish. The gate is `enrollmentOpen`, not the
	 * set's contents; the next `Intermission` clears it when it seeds.
	 */
	private closeEnrollmentWindow(): void {
		if (!this.enrollmentOpen) {
			return;
		}

		this.enrollmentOpen = false;

		print(
			`[Enrollment] window closed generation=${this.enrollmentGeneration} enrolled=${this.enrolledUserIds.size()} cutoff=${ENROLLMENT_CUTOFF_SECONDS}s`,
		);
	}

	/**
	 * `PlayerAdded`: enroll while the window is open, and say why not when it is closed.
	 *
	 * **The log line is the point of this method.** A late joiner's client looks identical to an enrolled player's for the
	 * whole of `Waiting` — same lobby, same picker (or not), no lane — so "why am I not racing" otherwise has no answer in the
	 * log at all. It fires once per join, which for a `PlayerAdded` handler is once per connection.
	 */
	private enrollOnJoin(player: Player): void {
		if (!this.enrollmentOpen) {
			print(
				`[Enrollment] late join "${player.Name}" (generation=${this.enrollmentGeneration}) — spectating until next Intermission`,
			);
			return;
		}

		this.enrolledUserIds.add(player.UserId);
	}

	/**
	 * Arms the `Intermission → Waiting` timer, re-arming itself while the server is empty.
	 *
	 * **Zero players means the timer restarts rather than advancing.** A server that has been empty for an
	 * hour must still be in `Intermission` on the first join: advancing to `Waiting` would spawn a round's
	 * worth of bodies, run `Playing` and eliminate them all with nobody watching, and leave the first
	 * joiner arriving into someone else's `PostGame`. The check is `Players.GetPlayers().size() === 0`
	 * — every connected `Player`, not just those with a character — taken at the moment the timer expires
	 * rather than at the moment it was armed, because a player who leaves during the 30 s is exactly the
	 * case this must catch.
	 *
	 * The loop is a `while` on the phase and generation rather than a chain of `task.delay`s: a re-armed
	 * timer needs to run the same check again, and a self-rescheduling closure is how that becomes one
	 * readable condition instead of a count of re-arms. A debug advance bumps the generation, which
	 * retires this loop on its next wake-up.
	 */
	private startIntermissionTimer(): void {
		const generation = this.generation;

		// The wipe's hold, read once: `Intermission` entered behind a wipe starts its clock when the screen clears.
		const hold = this.consumeTimerHold();

		task.spawn(() => {
			// The first wait is skipped only if a caller wants the transition immediately; here the timer
			// always runs its full duration before the first check.
			let first = true;
			while (this.phase === "Intermission" && generation === this.generation) {
				// **The enrollment window is opened per iteration, not once outside the loop (item 159).** The re-arm path below
				// is a `continue` inside this loop and never re-enters `enterIntermission`, so a window opened at phase entry
				// would be closed for the second lobby onwards — and the first joiner after an empty spell would never be a
				// competitor, which reads in the log as "waiting for a player" while one is standing in the lobby.
				const span = INTERMISSION_SECONDS + (first ? hold : 0);
				first = false;

				this.openEnrollmentWindow(span);

				task.wait(span);

				if (this.phase !== "Intermission" || generation !== this.generation) {
					return;
				}

				const players = Players.GetPlayers();
				if (players.size() === 0) {
					// Re-armed by looping. Logged because "the machine is stuck in Intermission" and "the
					// machine is correctly waiting for a player" look identical from outside, and the
					// difference is one line.
					print(
						`[Round] Intermission timer restarted — no players connected (players=0), another ${INTERMISSION_SECONDS}s`,
					);
					continue;
				}

				// **Spawn before entering, here too.** The automatic loop has the same ordering obligation as
				// the debug keys: entering `Waiting` with no competitors leaves the lobby empty, so the
				// `Waiting` timer would refuse forever. A refusal from the spawn (a player who left between
				// the check above and this call) re-arms `Intermission` instead, which is where a server with
				// nobody watching belongs.
				//
				// **`true`: this is the automatic path, so the enrollment cutoff applies (item 159).** The debug keys pass
				// `false` and spawn everybody, because a Studio test wants every connected player on a lane.
				const spawned = this.startWaitingRound("intermission elapsed", true);
				if (spawned === 0) {
					print(
						`[Round] Intermission timer restarted — no competitors spawned, another ${INTERMISSION_SECONDS}s`,
					);
					continue;
				}

				// **Wrapped.** `Intermission ? Waiting` is one of the two transitions the wipe covers. The call is
				// scheduled inside `transitionAround`, so this loop returns and the round keeps ticking.
				this.transitionAround("Intermission", "Waiting", () =>
					this.enterWaiting("intermission elapsed", spawned),
				);
				return;
			}
		});
	}

	// #endregion

	// #region belt ramp

	/**
	 * Ramps the belt from zero to its configured speed over `BELT_RAMP_SECONDS`, on `Heartbeat`.
	 *
	 * **`Heartbeat`, not the round tick.** The tick is 1 Hz so powers get a legible cadence; a belt
	 * ramped on it would move in three visible steps and every body would lurch. The two clocks are
	 * separate for exactly that reason, and this connection exists only while the ramp is in flight.
	 *
	 * Linear, and computed from the clock rather than accumulated per frame: `fraction` is
	 * `(now - start) / duration`, so a frame hitch does not shorten the ramp and the belt lands exactly
	 * on the target regardless of how many frames elapsed.
	 */
	private startBeltRamp(): void {
		this.stopBeltRamp();

		const target = this.treadmill.getBeltSpeed();
		const startedAt = os.clock();
		const generation = this.generation;

		this.treadmill.setBeltSpeed(0);

		this.rampConnection = RunService.Heartbeat.Connect(() => {
			// Left `Playing` mid-ramp: stop writing immediately. `endPlaying` also calls `stopBeltRamp`, but
			// checking here means a stale callback can never move the belt after the phase changed.
			if (generation !== this.generation || this.phase !== "Playing") {
				this.stopBeltRamp();
				return;
			}

			const fraction = math.min((os.clock() - startedAt) / BELT_RAMP_SECONDS, 1);
			this.treadmill.setBeltSpeed(target * fraction);

			if (fraction >= 1) {
				this.stopBeltRamp();
			}
		});
	}

	private stopBeltRamp(): void {
		this.rampConnection?.Disconnect();
		this.rampConnection = undefined;
	}

	// #endregion

	// #region tick loop

	/**
	 * The round's 1 Hz loop: fires `onTick` subscribers, then settles eliminations and the end condition.
	 *
	 * Order matters. Subscribers run first so a power sees the state *before* this tick's eliminations,
	 * which is the order a power would expect if it were reading who is still racing. Elimination and
	 * the end check follow in the same tick, so a body that leaves the zone is reported and the round
	 * ends in the same second rather than a second later.
	 */
	private startTickLoop(generation: number): void {
		task.spawn(() => {
			while (this.phase === "Playing" && generation === this.generation) {
				task.wait(TICK_INTERVAL_SECONDS);

				if (this.phase !== "Playing" || generation !== this.generation) {
					return;
				}

				const elapsed = os.clock() - this.runningStartedAt;

				for (const callback of this.tickCallbacks) {
					// One misbehaving power must not stop the round's own bookkeeping, so each callback is
					// isolated. The failure is reported against the tick rather than swallowed.
					const [ok, err] = pcall(() => callback(elapsed));
					if (!ok) {
						warn(`[Round] onTick subscriber failed: ${tostring(err)}`);
					}
				}

				this.settleEliminations();
				if (this.checkEndCondition()) {
					return;
				}

				// After the end check, not before: a round that just ended has no live set to report on, and
				// the idle warning describes a round that is still running.
				this.warnIfIdle();
			}
		});
	}

	// #endregion

	// #region elimination

	private findZone(): BasePart | undefined {
		for (const instance of CollectionService.GetTagged(TAGS.eliminationZone)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance;
			}
		}
		return undefined;
	}

	/**
	 * Says, once per round, that eliminations are off.
	 *
	 * Warned rather than errored: a zone is user-placed and the phase machine has to be testable without
	 * one. Treated as "every body is alive", so a round with no zone simply runs its clock and ends with
	 * co-winners — a legible result rather than a stuck round.
	 */
	private warnIfNoZone(): void {
		if (this.warnedNoZone || this.findZone() !== undefined) {
			return;
		}

		this.warnedNoZone = true;
		warn(
			`[Round] no part is tagged ${TAGS.eliminationZone} — eliminations disabled for this round. Tag a part ${TAGS.eliminationZone} to enable them.`,
		);
	}

	/**
	 * Destroys every body whose centre has left the zone's box.
	 *
	 * Positional and periodic: no `Touched`, no proximity event, no wall. A body that leaves the zone and
	 * comes back within one tick is not eliminated, which is the intended tolerance — the check is the
	 * round's clock, not the physics engine's.
	 */
	private settleEliminations(): void {
		const zone = this.findZone();
		if (zone === undefined) {
			return;
		}

		for (const ball of this.getLiveBalls()) {
			if (this.isInsideZone(zone, ball)) {
				continue;
			}

			const name = ball.GetFullName();
			// Read before the destroy, after which every property reads as its default. The owner is what
			// makes this line a result rather than a position: `live=` says how many are left, `owner=` says
			// which competitor just lost.
			const owner = readOwner(ball);
			// The toucher is read here, before the destroy, for the same reason as the owner: the last-touch record is
			// cleared when a body dies (`powers.forgetBall`), and a destroyed body would report no owner at all.
			const toucher = lastToucherOf(ball);

			// **The placement record, one line beside the log line that says the same thing.** This loop is the elimination
			// order — `getLiveBalls` is walked once per tick and bodies leave it permanently — so the order these pushes
			// happen in *is* the result the payout is derived from. Recorded before the destroy, while the owner value is
			// still meaningful.
			this.recordElimination(owner);

			this.forgetBall(ball);
			ball.Destroy();

			// Leaving the belt is *losing*, so the owner is told. Read before the destroy, and dispatched through the pure
			// rule so "synthetic owners are not told" has one definition rather than one `if` per removal site.
			this.notifyEliminated(owner, "left-belt");

			// **The sound is a second event at the same place, not a second call site.** A body leaving the belt is what
			// an elimination *is*, so the sound sits beside the splash rather than in `destroyBall` or in the end
			// condition — those are about a body dying and a round ending, which are different facts. It is targeted at
			// the player whose ball landed the last touch, not broadcast: see `playEliminationSound`.
			this.playEliminationSound(owner, toucher);

			// **Every elimination restarts the idle clock.** The warning it guards exists to say "nothing has
			// happened for 60 s", and a round that is shedding a competitor every few seconds is the exact
			// opposite of that — without this reset the line would fire on a schedule that has nothing to do
			// with the round's progress, and a busy round would get the same warning as a stuck one.
			this.lastProgressAt = os.clock();

			print(
				`[Round] eliminated ${name}, owner=${owner === undefined ? "none" : tostring(owner.userId)}(${owner === undefined ? "none" : owner.displayName}), live=${this.liveBalls.size()}`,
			);
		}
	}

	/**
	 * Is the body fully inside the zone?
	 *
	 * Full containment, not overlap: a body straddling the boundary is still in, because "half of it is
	 * still on the belt" is not a result a player would accept. Each axis is shrunk by the body's radius,
	 * so the test is on the body's *extent* rather than its centre alone.
	 *
	 * **The zone's own orientation is respected** (`PointToObjectSpace`), so a zone rotated in Studio
	 * still has axis-aligned edges in its own frame. Comparing world axes against `Size` would pick the
	 * wrong axes for a rotated zone and eliminate bodies that never left it.
	 *
	 * `ball.Size.Y / 2` is the radius: a `Shape = Ball` part is a sphere inscribed in its `Size` box, and
	 * the pool sizes all three axes equally, so any axis gives the same number. `Y` is the one the spec
	 * names and the one every other measurement in this codebase uses for a body's half-height.
	 */
	private isInsideZone(zone: BasePart, ball: BasePart): boolean {
		const ballRadius = ball.Size.Y / 2;
		const relative = zone.CFrame.PointToObjectSpace(ball.Position);

		const halfX = zone.Size.X / 2 - ballRadius;
		const halfY = zone.Size.Y / 2 - ballRadius;
		const halfZ = zone.Size.Z / 2 - ballRadius;

		const insideX = math.abs(relative.X) <= halfX;
		const insideY = math.abs(relative.Y) <= halfY;
		const insideZ = math.abs(relative.Z) <= halfZ;

		return insideX && insideY && insideZ;
	}

	// #endregion

	// #region end condition

	/**
	 * Ends the round if it is over. Returns true when it did.
	 *
	 * ## The competitor set, not the live set
	 *
	 * Every condition below reads `getCompetitors()` — tracked bodies that carry an `OwnerUserId`. A body
	 * without an owner is an **orphan**: not counted, not a candidate, not a reason to keep the round
	 * open. That rule is what makes "last owner standing" well defined, and it is why the count is
	 * recomputed rather than cached: an orphan can appear from a future code path, and a cached count
	 * would let it hold a round open forever.
	 *
	 * ## The conditions, in this order
	 *
	 *  - **No competitors left** → `winner=none`, `no survivors`. Reported rather than treated as a draw, because "every
	 *    competitor was eliminated" is a definite result a bet can settle against. Reachable only when two or more left in
	 *    the same instant — the spawner's cleanup pass destroys a whole batch in one loop, and `evaluateAfterLoss` defers
	 *    so the batch lands before this runs — or when a body is destroyed without going through elimination.
	 *  - **Exactly one competitor** → that owner wins, `last standing`. **No guard on how many the round started with.**
	 *
	 * ## The `initialLiveCount > 1` guard is deleted, and this records why
	 *
	 * Item 37 added it to stop a round that began with a single competitor from naming that competitor the winner of a race
	 * it ran alone. That is now the **wrong** answer: a round with one entrant is a round that entrant wins, and refusing to
	 * name them produced `PostGame — no winner` for a solo session — a result the player could not act on and could not tell
	 * apart from a broken round. The field is deleted with the guard (item 72): with no reader, leaving it written would be
	 * an inert field, and this project removes those.
	 *
	 * What that costs, stated plainly: **a round that starts with one competitor ends at the first check** — at most
	 * `TICK_INTERVAL_SECONDS` after `Playing` begins, with that competitor named. A solo session therefore races for about a
	 * second. That is the requested rule; the alternative that keeps a solo race alive is a finish-line signal this tree
	 * does not have, not a guard on this check.
	 *
	 * ## Why the count and not the branch decides the log
	 *
	 * Both lines carry `live=`, so a log reader can tell a genuine wipe-out from a last-standing result without knowing
	 * which branch this function took — and a future third branch cannot accidentally reuse a reason string that no longer
	 * describes it.
	 *
	 * ## There is no time limit, and that is deliberate
	 *
	 * A third branch used to end the round when a `PLAYING_CAP_SECONDS` cap expired, awarding the win to
	 * whoever was furthest along. **It is deleted.** Its only observed effect in the logs was to fire
	 * before an elimination that was about to happen and name a winner while the actual leader was still
	 * travelling — a result nobody could act on. `Playing` can now run forever.
	 *
	 * **The accepted consequence, named because it will happen:** a competitor that never crosses the
	 * `EliminationZone` — wedged at the belt's edge, moving backwards, or parked against a wall — keeps
	 * the round alive indefinitely. That is a manual-intervention case in Studio, not a bug to be papered
	 * over here. `ROUND_IDLE_WARN_SECONDS` exists to make it visible in the log rather than as a round
	 * that silently does nothing; it does not end anything.
	 *
	 * `elapsed` is no longer a parameter: it existed only for the cap comparison. The round's duration is
	 * still recorded — `endPlaying` reads the frozen clock — so removing it from this signature loses
	 * nothing.
	 */
	private checkEndCondition(): boolean {
		const live = this.getCompetitors();

		// The decision is a pure function so the rule can be asserted without an engine; this method is the dispatch. Owners
		// are collected rather than defaulted: `getCompetitors` already filtered to owned bodies, and inventing a
		// `userId 0` fallback would let a broken invariant publish a winner that does not exist.
		const owners = new Array<BallOwner>();
		for (const body of live) {
			const owner = readOwner(body);
			if (owner !== undefined) {
				owners.push(owner);
			}
		}

		const outcome = decideRoundOutcome(owners);

		if (outcome.kind === "continue") {
			return false;
		}

		if (outcome.kind === "no-survivors") {
			this.endPlaying("no survivors, live=0", undefined);
			return true;
		}

		// The winner's *body* is still needed for the log line, and the body is the thing that exists — the owner is a pair
		// of attributes on it. Reading it back here keeps `decideRoundOutcome` free of instances.
		const survivor = live.size() === 1 ? live[0] : undefined;

		this.endPlaying(`last standing, live=1${survivor === undefined ? "" : `: ${survivor.GetFullName()}`}`, {
			userId: outcome.winner.userId,
			displayName: outcome.winner.displayName,
		});
		return true;
	}

	/**
	 * Says, once per round, that nothing has been eliminated for `ROUND_IDLE_WARN_SECONDS`.
	 *
	 * ## Why a warning and not an end
	 *
	 * The deleted cap answered "this round is going nowhere" by inventing a winner, which was worse than
	 * saying nothing: it produced a result that contradicted the race in progress. This answers the same
	 * observation with a line that names the state — how many are left and who is furthest — and lets a
	 * human decide. Nothing transitions, nothing wins, the belt keeps running.
	 *
	 * ## Two flags' worth of state, and both are load-bearing
	 *
	 * `lastProgressAt` is reset by **every** elimination (and by any external loss of a body): without
	 * that reset the line would fire on a fixed schedule from `Playing` entry, so a round shedding a
	 * competitor every few seconds would be reported as stuck at exactly 60 s. `idleWarned` is what makes
	 * the line appear once: without it, a genuinely stuck round would print the same sentence every second
	 * forever and bury everything else. Both reset at `Playing` entry, so a later round gets its own
	 * warning.
	 *
	 * The "furthest" competitor reuses `furthestAlong`, which is the helper the cap branch used. It is kept
	 * for this line alone now — same tiebreak (lower `OwnerUserId` at equal distance) so the name reported
	 * is the one the cap would have named, which matters when comparing logs across the change.
	 */
	private warnIfIdle(): void {
		if (this.idleWarned) {
			return;
		}

		const idleFor = os.clock() - this.lastProgressAt;
		if (idleFor < ROUND_IDLE_WARN_SECONDS) {
			return;
		}

		this.idleWarned = true;

		const live = this.getCompetitors();
		const furthest = this.furthestAlong(live);
		const owner = furthest === undefined ? undefined : readOwner(furthest);

		print(
			`[Round] no elimination in ${ROUND_IDLE_WARN_SECONDS}s (live=${live.size()}, furthest=${furthest === undefined ? "none" : furthest.GetFullName()}(${owner === undefined ? "none" : tostring(owner.userId)}))`,
		);
	}

	/**
	 * The competitor furthest along the belt's travel direction.
	 *
	 * **Measured against the belt's `+RightVector`, not world `+X`.** They are the same in the current
	 * scene, and the difference only appears if the belt is rotated in Studio — at which point a world-axis
	 * comparison names the wrong competitor as the leader, silently and only for rotated scenes. The belt's
	 * own axis is the definition of "further along" that matches the thing the competitors are racing on,
	 * and it costs one dot product.
	 *
	 * Ties go to the **lower `OwnerUserId`**, so `Debug#1` beats `Debug#2` at the same position. A
	 * deterministic tiebreak matters more than a fair one here: two competitors can sit at identical
	 * distance for many ticks, and a nondeterministic winner would make the round unreproducible from its
	 * own log.
	 */
	private furthestAlong(live: ReadonlyArray<BasePart>): BasePart | undefined {
		const right = this.beltRightVector();
		let best: BasePart | undefined;
		let bestDistance = -math.huge;
		let bestOwner = math.huge;

		for (const ball of live) {
			const distance = ball.Position.Dot(right);
			const owner = readOwner(ball);
			const ownerId = owner === undefined ? math.huge : owner.userId;

			if (distance > bestDistance || (distance === bestDistance && ownerId < bestOwner)) {
				best = ball;
				bestDistance = distance;
				bestOwner = ownerId;
			}
		}

		return best;
	}

	/**
	 * The travel direction of the belt the competitors are on, falling back to world `+X`.
	 *
	 * The fallback is not arbitrary: the only belt in the scene has `RightVector = (1, 0, 0)`, so a server
	 * that has not replicated its belt yet still ranks competitors on the axis they are actually travelling
	 * along. Returning `Vector3.zero` instead would make every distance zero and hand the win to whichever
	 * competitor the set happened to iterate first.
	 */
	private beltRightVector(): Vector3 {
		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance.CFrame.RightVector;
			}
		}

		return Vector3.xAxis;
	}

	/** Tracked bodies that carry an owner. The only set the winner rule reads. */
	private getCompetitors(): BasePart[] {
		const competitors = new Array<BasePart>();
		for (const ball of this.getLiveBalls()) {
			if (readOwner(ball) !== undefined) {
				competitors.push(ball);
			}
		}
		return competitors;
	}

	// #endregion

	// #region body bookkeeping

	/**
	 * Starts tracking a body, including the death signal the round cannot observe any other way.
	 *
	 * `Destroying` rather than a parent check on each tick: the signal fires for every destruction path
	 * including this service's own `Destroy()`, so it is the one hook that cannot be missed. The handler
	 * checks membership first, because the round's own eliminations remove the entry *before* destroying,
	 * and a handler that acted twice per body would double-count.
	 */
	private trackBall(ball: BasePart): void {
		this.liveBalls.add(ball);

		// **The participant record, taken here because every spawn path passes through this method.** A payout is owed to
		// everyone who had a body on the belt, and by the time the round ends this set holds one entry — so the only moment
		// the full field can be observed is while it is being built. Reading it off the body rather than out of the caller's
		// owner list keeps the record true to what actually got spawned, which is the same rule the debug-spawn log follows.
		const owner = readOwner(ball);
		if (owner !== undefined) {
			this.roundParticipants.push(owner);
		}

		const connection = ball.Destroying.Connect(() => {
			this.handleExternalDestruction(ball);
		});
		this.destroyingConnections.set(ball, connection);
	}

	private handleExternalDestruction(ball: BasePart): void {
		// Already forgotten — this is the round's own `Destroy()` call, not an outside death.
		if (!this.liveBalls.has(ball)) {
			return;
		}

		// **Read before the body is forgotten and long before it is gone**, because the owner lives in attributes on the
		// instance: a destroyed part returns its defaults, so a post-destroy read would report `userId 0` and the rule would
		// quietly treat a real player as synthetic and tell nobody.
		const owner = readOwner(ball);
		// **The powers map still holds this body's toucher at this point, and that is why `destroyBall` calls
		// `forgetBallPower` *after* `Destroy()`.** This method runs from inside that `Destroy()`, so clearing the record
		// first — the natural reading of "clean up, then destroy" — would make every cull silent.
		const toucher = lastToucherOf(ball);

		// A culled body is an eliminated competitor, so it takes its place in the payout order here too: `KillY` and the
		// `MaxLiveBalls` cap are removal paths the round does not control, and a player whose body fell out of the world
		// still finished where it finished. Teardown never reaches this line — `clearAllBodies` forgets first.
		this.recordElimination(owner);

		this.forgetBall(ball);

		// Culled, not torn down: `KillY` and the `MaxLiveBalls` cap remove a competitor the same way the zone does, and the
		// player whose ball fell out of the world is exactly as eliminated. Teardown never reaches here — `clearAllBodies`
		// forgets each body before destroying it, so the membership check above returns early — which is what keeps a
		// phase change from splashing every player at once.
		this.notifyEliminated(owner, "culled");

		// The same sound, for the same reason: a body culled by `KillY` or the cap left the round, whether or not
		// anybody owned it — and the player who last touched it is the one who hears it.
		this.playEliminationSound(owner, toucher);

		// A body lost to the kill plane or a future path is still a change in the round's state, so it
		// restarts the idle clock for the same reason a zone elimination does — see `warnIfIdle`.
		this.lastProgressAt = os.clock();

		this.evaluateAfterLoss();
	}

	/**
	 * Appends one competitor to the payout order.
	 *
	 * `undefined` for an orphan: an ownerless body (a decoy twin) can leave the belt, and it is nobody's placement. The
	 * record is only ever appended to — the order is the result, so nothing may reorder or remove an entry.
	 */
	private recordElimination(owner: BallOwner | undefined): void {
		if (owner !== undefined) {
			this.eliminatedOwners.push(owner);
		}
	}

	/**
	 * Tells one player their competitor is out, if there is one to tell.
	 *
	 * The recipient is decided by `splashTargetUserId`, not here: "synthetic owners are not players" and "a teardown is
	 * not an elimination" are rules, and a rule written at two call sites is a rule that will disagree with itself the
	 * third time. The remote is server-to-client only, so this is the sole way the signal can be produced.
	 */
	private notifyEliminated(owner: BallOwner | undefined, cause: EliminationCause): void {
		const userId = splashTargetUserId(owner, cause);
		if (userId === undefined) {
			return;
		}

		const remote = this.eliminationRemote;
		const player = Players.GetPlayerByUserId(userId);
		if (remote === undefined || player === undefined) {
			return;
		}

		// No arguments: the splash is one fixed word and the client needs nothing to render it. A payload would be a
		// second source of truth for text the controller already owns.
		remote.FireClient(player);
	}

	/**
	 * Plays the elimination sound for **the one player whose ball landed the last touch on the eliminated body**.
	 *
	 * ## Why this is not a broadcast any more
	 *
	 * It was one: every client played the sound whenever any body left the round, which told four players "somebody was
	 * eliminated" as news the arena already shows. The sound now means "*you* put that body out", and that is a claim only
	 * one client can check — so the remote is fired at the toucher's owner and nobody else. The rule lives in
	 * `shouldPlayEliminationSound`, not here, because there are two removal paths and a rule written at both is a rule
	 * that will disagree with itself the third time.
	 *
	 * ## The two reads that must happen before the destroy
	 *
	 * `owner` and `toucher` both arrive as values. `owner` because a destroyed body reports its default attributes;
	 * `toucher` because `powers.forgetBall` drops the last-touch record on death, and because that *body* may itself
	 * already be gone — the ball that knocked a competitor off the belt can be culled first. This method therefore never
	 * reads the world; it is handed the facts the call site read at the last moment they were true.
	 *
	 * ## The phase gate reads this service's own field, not the powers flag
	 *
	 * `setRoundActive` carries the same boolean one indirection away (`BallSpawnerService` → `server/powers`), and
	 * reading it back here would be asking another service for a fact this service just told it. `this.phase` is the
	 * value the gate is actually about, and it is the same value `enterPlaying` and `enterIntermission` write.
	 *
	 * ## Why the gate is not redundant
	 *
	 * Both call sites only run for a genuine elimination today: `settleEliminations` is reached from the `Playing` tick,
	 * and `handleExternalDestruction` returns early for a teardown because `clearAllBodies` forgets each body before
	 * destroying it. That is *how the bookkeeping happens to work*, not a rule — a future removal path that ran during
	 * `PostGame` would otherwise make the belt whistle while the winner is still on screen. The gate states the rule.
	 *
	 * ## One signal per elimination, not one per burst
	 *
	 * `settleEliminations` can eliminate four bodies in one pass, and this fires up to four times — at up to four
	 * different players. Coalescing here would put a second throttle on the wrong side of the wire: `canPlay` is per sound
	 * id and per playback, and the client is the only side that knows when the previous start really was. Four signals in
	 * one frame arrive together and cost one `RemoteEvent` message each; each recipient plays one sound. A client whose
	 * own ball put four bodies out in one tick hears one sound, which is the client's throttle doing its job.
	 */
	private playEliminationSound(owner: BallOwner | undefined, toucher: BasePart | undefined): void {
		if (this.phase !== "Playing") {
			return;
		}

		const remote = this.eliminationSoundRemote;
		if (remote === undefined || owner === undefined) {
			return;
		}

		const toucherOwner = toucher !== undefined ? readOwner(toucher) : undefined;
		if (!shouldPlayEliminationSound(owner.userId, toucherOwner?.userId)) {
			return;
		}

		const player = Players.GetPlayerByUserId(owner.userId);
		if (player === undefined) {
			return;
		}

		// No arguments: the sound is one fixed asset and the client needs nothing to play it — the same reason the splash
		// carries no payload. The line is here rather than at the call sites because it wants the *decision's* answer
		// (`userId`), which only this method has after the rule has spoken.
		remote.FireClient(player);
		print(`[Round] elimination sound → ${player.Name} (toucherUserId=${owner.userId})`);
	}

	/**
	 * Re-checks the end condition after a body is lost outside the tick.
	 *
	 * Without this the "one remains" win would wait up to `TICK_INTERVAL_SECONDS`, and a round whose last
	 * two bodies were culled by `KillY` in the same frame would sit in `Playing` with nothing alive until
	 * the next tick.
	 *
	 * **Deferred by one resumption cycle, not evaluated inline.** The spawner's cleanup pass can destroy
	 * several bodies in a single loop, and each destruction fires `Destroying` synchronously. Evaluating
	 * inline would decide the round on the first of a batch: with two bodies left and both culled in the
	 * same pass, the first callback sees `live == 1` and announces `winner=<the other one>` — a winner
	 * that is destroyed microseconds later. Deferring lets the whole batch land first, so the same
	 * sequence correctly reports `no survivors`. The cost is that the end is decided at the end of the
	 * frame rather than mid-loop, which no observer can distinguish.
	 */
	private evaluateAfterLoss(): void {
		if (this.phase !== "Playing") {
			return;
		}

		task.defer(() => {
			if (this.phase !== "Playing") {
				return;
			}
			this.checkEndCondition();
		});
	}

	/** Drops a body from the live set and disconnects its death signal. Safe to call twice. */
	private forgetBall(ball: BasePart): void {
		this.liveBalls.delete(ball);

		const connection = this.destroyingConnections.get(ball);
		if (connection !== undefined) {
			connection.Disconnect();
			this.destroyingConnections.delete(ball);
		}
	}

	// #endregion

	// #region remote and broadcast

	/**
	 * Creates the three debug remotes, reusing the folder the spawner made if it exists.
	 *
	 * The find-or-create is duplicated from `BallSpawnerService` rather than factored out, because the
	 * alternative is a third service whose only job is owning a folder — and whichever service runs first
	 * still has to handle the other's absence. Helpers that cannot disagree about anything except which
	 * one creates the folder, where both outcomes are identical, is the smaller thing.
	 *
	 * **Three remotes, one per key, matching the per-action pattern the spawn and phase remotes used.**
	 * One remote with a string argument would have been smaller, but every remote in this project sends no
	 * argument for a stated reason: a client that can name an action can name an action the server did not
	 * intend, and the review that matters is "what can a client ask for" — which is easier to answer when
	 * each request is its own event. The cost is three find-or-creates in one function, paid once.
	 */
	// #region picker

	/**
	 * Generates every player's offer, then spawns the competitors — **the one place `Waiting` begins**, and therefore the
	 * one place an offer is created.
	 *
	 * ## Why the offer is made before the spawn rather than inside `enterWaiting`
	 *
	 * The body carries the chosen ball id as an attribute written before `Parent`, so a pick has to exist *before* the
	 * body does. `enterWaiting` runs after the spawn in both entry paths (and inside a transition wipe on the automatic
	 * one), so generating offers there would mean the first body of every round had no pick.
	 *
	 * ## Why this is a function and not two call sites
	 *
	 * There are two ways into `Waiting` — the `1` key and the intermission timer — and "roll the offers" appearing twice is
	 * how one path ends up without them. Both call this.
	 *
	 * ## `useEnrollment`, and why the offers follow it (item 159)
	 *
	 * The automatic timer passes `true` and the `2` key passes `false`, and the flag travels to **both** halves: the spawn
	 * filters on the enrollment set, and the offers skip anyone who is not in it. A player the round has decided not to
	 * enroll must not be handed a "choose your ball" panel either — a panel for a body that will never exist is the same lie
	 * as a lane they are not on, and it is the more visible of the two.
	 */
	private startWaitingRound(reason: string, useEnrollment: boolean): number {
		this.openOffers(useEnrollment);

		const spawned = this.spawnRoundCompetitors(reason, useEnrollment);

		// **A solo Studio session gets company, automatically (item 150).** Without this, a Studio playtest is one player's
		// body and item 72 declares it the winner on the first tick — which is not a round, and which made key `4` inside the
		// countdown the only way to see one. `startWaitingRound` is the one place `Waiting` begins, so both keys and the
		// `Intermission` timer are covered by one call, in every round rather than only the first.
		//
		// **`spawned > 0` first, and that guard is load-bearing.** `spawnRoundCompetitors` returning zero means no player
		// body was made (nobody connected, or no spawner free), and the intermission timer reads that as "re-arm instead of
		// entering `Waiting`". Spawning bots regardless would leave synthetic bodies on the belt in a lobby that is staying in
		// `Intermission`, and — because bots carry an `OwnerUserId` of their own — they would satisfy `enterPlaying`'s
		// competitor guard and start a race with nobody in it.
		//
		// The returned count includes the bots, because every caller passes it straight into `enterWaiting`'s `competitors=`
		// field. A log that says four in a round with eight bodies is worse than no log.
		if (spawned === 0) {
			return 0;
		}

		return spawned + this.spawnStudioBots();
	}

	/**
	 * Populates a solo Studio session with bots, and does nothing anywhere else.
	 *
	 * ## Why the solo gate
	 *
	 * A two-tester Studio session is two people looking at each other's balls, and adding four bots to it would bury the
	 * thing being tested. One player is the case that has no round at all without help. `Players.GetPlayers()` is the whole
	 * test: any second connected player — including one who has not spawned yet — turns the bots off, which is the safe
	 * direction, because a session that is already populated does not need them.
	 *
	 * ## Why the environment gate is a module constant
	 *
	 * See `IS_STUDIO`. A live server never gets free competitors: a real round's field is the players who joined.
	 */
	private spawnStudioBots(): number {
		if (!IS_STUDIO || Players.GetPlayers().size() !== 1) {
			return 0;
		}

		return this.spawnBots("studio-auto");
	}

	/**
	 * Rolls one offer per connected player. **Sends nothing** — `announceOffers` does that, once the window's deadline exists.
	 *
	 * ## The premium roll is evaluated here and nowhere else
	 *
	 * Once per player per `Waiting` entry. Rolling it anywhere a client can cause — a re-roll, a pick, a tick — would make
	 * a 10% offer something a player could farm by pressing a button, which is a different feature with a different price.
	 *
	 * ## A player who owns nothing does not roll
	 *
	 * There is nothing to expand the offer *to*, so the roll is skipped rather than scaled, and the log says
	 * `premium=false` rather than implying it fired and lost. `buildOffer` enforces the same rule; the check here is what
	 * keeps the log honest.
	 *
	 * ## Why the roll and the send are two functions (item 149)
	 *
	 * Every offer message carries the window's deadline, and that deadline is only knowable from the phase's end, which
	 * `enterWaiting` computes - after this method has already run, because the spawn between them needs the picks. Sending
	 * from here meant sending whatever `pickerDeadline` happened to hold, which is how the panel's countdown came to be
	 * measured from the roll (i.e. from behind the transition wipe) and left a hole before the countdown. The roll stays here
	 * because the *body* needs it; the deadline travels with the announcement.
	 */
	private openOffers(useEnrollment: boolean): void {
		this.offers.clear();

		for (const player of Players.GetPlayers()) {
			// **A spectator is not offered a ball (item 159).** See `startWaitingRound` for why the flag reaches this half of
			// the entry as well as the spawn.
			if (useEnrollment && !this.enrolledUserIds.has(player.UserId)) {
				print(`[Picker] offer skipped player=${player.Name} (not enrolled this round)`);
				continue;
			}

			const offer = this.generateOfferFor(player);
			if (offer === undefined) {
				continue;
			}

			print(
				`[Picker] offer player=${player.Name} options=${offer.options.join(",")} premium=${offer.premium} fallback=${offer.fallback}`,
			);
		}
	}

	/**
	 * Sends every stored offer to its player. Called from `enterWaiting`, once `pickerDeadline` is the phase's real arithmetic.
	 *
	 * The loop is over `offers` rather than over `Players.GetPlayers()`: a player who was refused an offer has no entry to
	 * send, and re-deriving the recipient list here is a second opinion about who is owed one.
	 */
	private announceOffers(): void {
		for (const [player, offer] of this.offers) {
			this.sendOffer(player, offer);
		}
	}

	/**
	 * Arms the pick window's own close, `deadline` being the server time it ends at.
	 *
	 * **The window has to actually close, and the phase change is too late for that.** `closeOffers` used to run only from
	 * `enterPlaying`, which is when the phase ends - so a window shorter than the phase would leave the panel up and the
	 * server still accepting picks for the remaining seconds.
	 *
	 * The deadline doubles as the guard: a later `Waiting` rewrites `pickerDeadline`, so a timer from a previous round finds
	 * a different token and stops. That is why the comparison is against the value rather than against a counter this method
	 * would otherwise have to keep. `forcePlaying` and `forceIntermission` are covered by the phase test, and `enterPlaying`
	 * keeps its own `closeOffers` call so a path that never opened offers still closes cleanly.
	 */
	private armPickWindowClose(deadline: number): void {
		task.delay(math.max(0, deadline - Workspace.GetServerTimeNow()), () => {
			if (this.phase !== "Waiting" || this.pickerDeadline !== deadline) {
				return;
			}

			print(`[Picker] window closed after ${PICKER_WINDOW_SECONDS}s`);
			this.closeOffers();
		});
	}

	/**
	 * Builds and stores one player's offer, and nothing else — no log, no message.
	 *
	 * The split matters for the re-roll: a replacement goes out on the *reply* to the re-roll, so a function that also
	 * logged and fired here would produce two offer lines and two renders for one purchase.
	 *
	 * `premium` is a parameter rather than always rolled, because a re-roll must reuse the phase's premium decision:
	 * rolling again would give a second chance at a 10% upgrade for three coins.
	 */
	private generateOfferFor(player: Player, premium?: boolean): StoredOffer | undefined {
		const owned = ownedIdsFrom(this.ownedAttribute(player));
		const wantsPremium = premium !== undefined ? premium : owned.size() > 0 && rollPremium(math.random);

		const offer = buildOffer(owned, wantsPremium, math.random);
		if (offer === undefined) {
			// The common pool is empty. That is a build bug, not a player state: refuse this player rather than inventing an
			// id, because an invented id is a body nothing in the game can name.
			warn(`[Round] no common ball to fall back to — ${player.Name} has no offer`);
			this.offers.delete(player);
			return undefined;
		}

		this.offers.set(player, offer);
		return offer;
	}

	/**
	 * The id a body for this player races as.
	 *
	 * `undefined` when no offer exists — a synthetic debug owner, or a player who joined after the offers were rolled. The
	 * attribute is then simply absent, which says "nobody picked for this body" rather than naming a ball.
	 */
	private chosenBallIdFor(player: Player): string | undefined {
		const offer = this.offers.get(player);
		return offer !== undefined ? offer.pick : undefined;
	}

	private ownedAttribute(player: Player): string {
		const encoded = player.GetAttribute(PLAYER_OWNED_BALLS_ATTRIBUTE);
		return typeIs(encoded, "string") ? encoded : "";
	}

	private offerMessage(offer: StoredOffer): PickerOfferMessage {
		return {
			options: offer.options,
			premium: offer.premium,
			fallback: offer.fallback,
			deadline: this.pickerDeadline,
		};
	}

	private sendOffer(player: Player, offer: StoredOffer): void {
		const remote = this.offerRemote;
		if (remote === undefined) {
			return;
		}

		remote.FireClient(player, this.offerMessage(offer));
	}

	/**
	 * Writes the pick onto the player's live body, if it has one.
	 *
	 * A scan of the round's own live set rather than a lookup table: the set is at most a handful of bodies and is already
	 * the authority on what exists, whereas a player→body map would be a second record to keep in step with every
	 * destruction path (`kill plane`, cap eviction, elimination, teardown) — the exact leak this class avoids elsewhere by
	 * keeping ownership on the body.
	 */
	private applyChosenBall(player: Player, ballId: string): void {
		for (const ball of this.liveBalls) {
			const owner = readOwner(ball);
			if (owner !== undefined && owner.userId === player.UserId) {
				ball.SetAttribute(CHOSEN_BALL_ID_ATTRIBUTE, ballId);

				// **The power has to follow the id, or the body races a ball the player did not choose.** `ChosenBallId` is
				// written twice in this service's life: once at spawn from the offer's timeout pick, and once here when the
				// player actually chooses. A `Power` derived only at spawn would leave a body whose badge says one thing and
				// whose behaviour is the other — the failure mode is silent, because both attributes are individually valid.
				//
				// `setPower` rewrites the attribute, the badge, the collision group and (for a colliding power) the `Touched`
				// connection, and drops any timers so the round's clock restarts with the new power at `Playing` entry.
				const power = powerForBallId(ballId);
				if (power !== undefined) {
					setPower(ball, power, ball.Size.Y / 2);
				}
			}
		}
	}

	/**
	 * Closes the pick window when `Waiting` ends, logging the timeout picks once.
	 *
	 * ## Why the timeout pick is not drawn here
	 *
	 * It was drawn when the offer was created, because the body is spawned at entry and must carry an id from birth. The
	 * distribution is identical — uniform over the player's own options — and the difference is only *when* the dice are
	 * rolled. Drawing again here would produce a second id that disagrees with the attribute already on the body.
	 *
	 * ## Why the map is cleared rather than kept
	 *
	 * A pick arriving after the phase has moved must be refused, and "no offer" is the refusal. Clearing is also what
	 * makes the next `Waiting` start from nothing instead of inheriting a stale premium flag.
	 */
	private closeOffers(): void {
		for (const [player, offer] of this.offers) {
			if (!offer.pickedByClient) {
				print(`[Picker] pick player=${player.Name} ball=${offer.pick} source=timeout`);
			}
		}

		this.offers.clear();
	}

	/** A client's pick. Validated against the stored offer, never against `OwnedBalls`. */
	private onPick(player: Player, ballId: unknown): void {
		const reply = (result: PickerResult) => {
			const remote = this.pickRemote;
			if (remote !== undefined) {
				remote.FireClient(player, result);
			}
		};

		const offer = this.offers.get(player);
		if (offer === undefined) {
			reply({ ok: false, reason: "no-offer" });
			return;
		}

		if (!typeIs(ballId, "string") || !isPickAllowed(offer, ballId)) {
			// Both cases are one refusal on purpose: a non-string is malformed and an un-offered id is a client asking for
			// something it was not shown, and neither is worth teaching the difference over a remote.
			reply({ ok: false, reason: "not-offered" });
			return;
		}

		offer.pick = ballId;
		offer.pickedByClient = true;
		this.applyChosenBall(player, ballId);

		print(`[Picker] pick player=${player.Name} ball=${ballId} source=client`);
		reply({ ok: true });
	}

	/**
	 * A paid re-roll: charge, then replace the offer.
	 *
	 * ## Why the charge comes first
	 *
	 * Generating the replacement offer before the save would leave a player with a new set of cards and an unchanged
	 * balance if the save failed — free value created by a failure. Charging first means the only two outcomes are "paid and
	 * replaced" and "nothing happened", which is the same ordering every other verb in this tree uses.
	 *
	 * ## Why a premium offer cannot be re-rolled
	 *
	 * A premium offer already contains every ball the player owns, so a freshly generated one is the *same set*. Charging
	 * 3 coins for it would be charging for nothing, which is the one thing this economy has consistently refused to do.
	 * The refusal is explicit rather than silent so the client can hide the button.
	 */
	private onReroll(player: Player): void {
		const reply = (result: PickerResult) => {
			const remote = this.rerollRemote;
			if (remote !== undefined) {
				remote.FireClient(player, result);
			}
		};

		if (!this.isPickerAllowed(player, "reroll")) {
			return;
		}

		const offer = this.offers.get(player);
		if (offer === undefined) {
			reply({ ok: false, reason: "no-offer" });
			return;
		}

		if (offer.premium) {
			reply({ ok: false, reason: "premium-offer" });
			return;
		}

		let payment = "ok";
		const result = applyReroll(
			() => {
				payment = this.economy.spendCoins(player, REROLL_COST_COINS);
				return payment === "ok";
			},
			() => this.generateOfferFor(player, false),
		);

		if (result.outcome !== "ok") {
			print(`[Round] reroll refused for ${player.Name}: ${result.outcome} (${payment})`);
			reply({ ok: false, reason: result.outcome === "payment-failed" ? payment : "no-offer" });
			return;
		}

		const replacement = result.offer;

		// The body is already in the world with the previous id, so the new default has to follow it. Without this the
		// attribute would name a ball from the old offer and the log would disagree with the body.
		this.applyChosenBall(player, replacement.pick);

		print(
			`[Picker] reroll player=${player.Name} cost=${REROLL_COST_COINS} options=${replacement.options.join(",")}`,
		);

		reply({ ok: true, offer: this.offerMessage(replacement) });
	}

	/** Whether this player may re-roll now. Local because `EconomyService`'s cooldown map is private and this is not its verb. */
	private isPickerAllowed(player: Player, action: string): boolean {
		const now = os.clock();
		const last = this.pickerCooldowns.get(player);

		if (last !== undefined && (now - last) * 1000 < ECONOMY_ACTION_COOLDOWN_MS) {
			print(`[Round] ${player.Name} ${action} ignored — within ${ECONOMY_ACTION_COOLDOWN_MS}ms cooldown`);
			return false;
		}

		this.pickerCooldowns.set(player, now);
		return true;
	}

	/**
	 * Creates the three picker remotes.
	 *
	 * `PickerOffer` is only ever fired by the server. It is a `RemoteEvent` in the shared folder because that is how this
	 * tree ships state to a client, not because the client may use it: an `OnServerEvent` connection is deliberately absent,
	 * so a client that fires it changes nothing.
	 */
	private createPickerRemotes(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const offer = new Instance("RemoteEvent");
		offer.Name = PICKER_OFFER_REMOTE_NAME;
		offer.Parent = folder;
		this.offerRemote = offer;

		const pick = new Instance("RemoteEvent");
		pick.Name = PICKER_PICK_REMOTE_NAME;
		pick.Parent = folder;
		pick.OnServerEvent.Connect((player, ballId: unknown) => this.onPick(player, ballId));
		this.pickRemote = pick;

		const reroll = new Instance("RemoteEvent");
		reroll.Name = PICKER_REROLL_REMOTE_NAME;
		reroll.Parent = folder;
		reroll.OnServerEvent.Connect((player) => this.onReroll(player));
		this.rerollRemote = reroll;
	}

	// #endregion

	/**
	 * Creates the `DecoyOutline` `RemoteFunction`.
	 *
	 * **The only `RemoteFunction` in this tree**, so the conventions are set here rather than inherited: created at runtime
	 * with the other remotes (never in the project file, so a rename leaves nothing behind), tabless of arguments in both
	 * directions, and the handler assigned to `OnServerInvoke` rather than connected as a signal. A reader adding the second
	 * one should copy this shape rather than reach for a `RemoteEvent` pair.
	 *
	 * `OnServerInvoke` is typed `(player, ...args) => void`, so a return value is not part of the type. Returning the body
	 * anyway is deliberate and safe: TypeScript allows a value-returning function where `void` is expected, roblox-ts
	 * erases the annotation, and the compiled handler returns the instance to the caller. The alternative — a
	 * `RemoteEvent` carrying the answer — would need a per-player correlation id and would let an answer arrive after the
	 * round it described had ended.
	 */
	private createDecoyOutlineRemote(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const remote = new Instance("RemoteFunction");
		remote.Name = DECOY_OUTLINE_REMOTE_NAME;
		remote.Parent = folder;
		remote.OnServerInvoke = (player) => this.onDecoyOutlineRequest(player);
	}

	/**
	 * Creates the hit-effect broadcast and hands it to the powers module.
	 *
	 * ## Why the wire lives here and the fire lives there
	 *
	 * This service owns the `Remotes` folder (it is the first one to make it) and the powers module owns the collision
	 * handler, so the two halves meet at one setter call rather than at an import in either direction — the cycle
	 * `RoundService → BallSpawnerService → powers → RoundService` is the one item 22 and item 80 both refused to close.
	 * `setHitEffectRemote` is the same shape as `setRoundActive`: a module-level fact the owning service feeds.
	 *
	 * The remote carries a **`Vector3` and nothing else**; the bodies are not named because the client attaches nothing to
	 * them — it builds one temporary carrier at the point and destroys it there.
	 */
	private createHitEffectRemote(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const remote = new Instance("RemoteEvent");
		remote.Name = HIT_EFFECT_REMOTE_NAME;
		remote.Parent = folder;
		setHitEffectRemote(remote);
	}

	/**
	 * Answers "which body is my twin" for one caller, or refuses with a reason.
	 *
	 * The order is `decideDecoyOutline`'s, and every refusal is logged with its reason because a client's `nil` cannot say
	 * which of four things happened. The comment that matters is on the ownership check in `decoy-outline.ts`: the twin must
	 * never carry an `OwnerUserId`, and a request from a client that has modified itself to claim otherwise gets `nil`
	 * rather than an outline on somebody else's ball.
	 */
	private onDecoyOutlineRequest(player: Player): BasePart | undefined {
		const body = this.bodyOwnedBy(player.UserId);
		const decoy = body !== undefined ? this.spawner.decoyFor(body) : undefined;
		const decoyOwner = decoy !== undefined ? readOwner(decoy) : undefined;

		const decision = decideDecoyOutline({
			phase: this.phase,
			callerUserId: player.UserId,
			bodyOwnerUserId: body !== undefined ? readOwner(body)?.userId : undefined,
			hasDecoy: decoy !== undefined,
			decoyOwnerUserId: decoyOwner?.userId,
		});

		if (decision.kind === "refused") {
			print(
				`[Decoy] outline refused player=${player.Name}(${player.UserId}) reason=${decision.reason} phase=${this.phase}`,
			);
			return undefined;
		}

		if (decoy === undefined) {
			// Unreachable — `granted` implies `hasDecoy` — and handled explicitly so the function returns a body or nothing
			// rather than relying on a narrowing the reader has to reconstruct.
			return undefined;
		}

		print(
			`[Decoy] outline granted player=${player.Name}(${player.UserId}) decoy=${decoy.GetFullName()} phase=${this.phase}`,
		);
		return decoy;
	}

	/**
	 * The caller's own live body, or `undefined`.
	 *
	 * A scan of the round's tracked set rather than a map: the set is already the authority on what exists, and a
	 * player→body index would be a second record to keep in step with every destruction path — the reason `applyChosenBall`
	 * scans too. The set is one entry per competitor, so this is at most five comparisons on a keypress.
	 */
	private bodyOwnedBy(userId: number): BasePart | undefined {
		for (const ball of this.liveBalls) {
			const owner = readOwner(ball);
			if (owner !== undefined && owner.userId === userId) {
				return ball;
			}
		}

		return undefined;
	}

	private createDebugRemotes(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		// The client sends nothing and these handlers ignore everything they could send: which phase to
		// enter is a constant per key, and a client that could pass a phase could skip a round.
		// `1` forces `Intermission`, so the phase keys are in phase order and every phase is reachable without waiting out
		// a timer. Named for its action like its siblings; the folder is find-or-create, but these children are created
		// fresh on every server start and are not part of the place, so renaming one leaves nothing behind.
		const intermission = new Instance("RemoteEvent");
		intermission.Name = DEBUG_INTERMISSION_REMOTE_NAME;
		intermission.Parent = folder;
		intermission.OnServerEvent.Connect(() => this.forceIntermission("debug key 1"));

		const waiting = new Instance("RemoteEvent");
		waiting.Name = DEBUG_WAITING_REMOTE_NAME;
		waiting.Parent = folder;
		waiting.OnServerEvent.Connect(() => this.forceWaiting("debug key 2"));

		const playing = new Instance("RemoteEvent");
		playing.Name = DEBUG_PLAYING_REMOTE_NAME;
		playing.Parent = folder;
		playing.OnServerEvent.Connect(() => this.forcePlaying("debug key 3"));

		// Server to client only: no `OnServerEvent` connection, so a client firing it changes nothing. One player is told,
		// because a splash is one player's result.
		const elimination = new Instance("RemoteEvent");
		elimination.Name = ELIMINATION_REMOTE_NAME;
		elimination.Parent = folder;
		this.eliminationRemote = elimination;

		// The sound is the same event with a different audience: every player sees a body leave the belt, so every player
		// hears it. Server to client only, and no arguments — the clip is fixed and the client owns the throttle.
		const eliminationSound = new Instance("RemoteEvent");
		eliminationSound.Name = ELIMINATION_SOUND_REMOTE_NAME;
		eliminationSound.Parent = folder;
		this.eliminationSoundRemote = eliminationSound;

		const spawn = new Instance("RemoteEvent");
		spawn.Name = DEBUG_SPAWN_REMOTE_NAME;
		spawn.Parent = folder;
		spawn.OnServerEvent.Connect(() => this.debugSpawnCompetitors());
	}

	/**
	 * Creates the payout remote: **server to client only, one player per firing.**
	 *
	 * No `OnServerEvent` connection, deliberately — like the elimination remote and for the same reason. A payout is the
	 * server's statement about a round the client just watched; a client that could fire it could name its own coins, and a
	 * `Value` per player would need one instance per joiner. The absence of a connection is the whole authorisation model.
	 */
	private createRoundPayoutRemote(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const payout = new Instance("RemoteEvent");
		payout.Name = ROUND_PAYOUT_REMOTE_NAME;
		payout.Parent = folder;
		this.roundPayoutRemote = payout;
	}

	/**
	 * Creates `ReplicatedStorage.RoundState` and seeds it with the initial phase.
	 *
	 * Created before the first `publishPhase` call in `onStart` so the very first write has somewhere to
	 * land — a client that reads the value before any transition must see `Intermission`, not `nil`.
	 * Reused rather than recreated if one already exists, so a service restart in the same session does
	 * not leave a stale value behind a freshly created one.
	 *
	 * The value is **not** parented under the `Remotes` folder: it is not a remote, and a future reader
	 * looking for the phase should not have to know it lives in a folder named after something else.
	 */
	private createRoundStateValue(): void {
		const existing = ReplicatedStorage.FindFirstChild(ROUND_STATE_VALUE_NAME);
		if (existing !== undefined && existing.IsA("StringValue")) {
			this.roundState = existing;
		} else {
			const value = new Instance("StringValue");
			value.Name = ROUND_STATE_VALUE_NAME;
			value.Value = this.phase;
			value.Parent = ReplicatedStorage;
			this.roundState = value;
		}

		// The winner value shares the phase value's mechanism and its lifetime: created once at startup,
		// seeded empty so a client that reads it before any round has ended gets a definite "no winner"
		// rather than a missing instance.
		const existingWinner = ReplicatedStorage.FindFirstChild(WINNER_NAME_VALUE_NAME);
		if (existingWinner !== undefined && existingWinner.IsA("StringValue")) {
			this.winnerName = existingWinner;
		} else {
			const winner = new Instance("StringValue");
			winner.Name = WINNER_NAME_VALUE_NAME;
			winner.Value = "";
			winner.Parent = ReplicatedStorage;
			this.winnerName = winner;
		}

		// The countdown's deadline (item 149), the third of the family and the first `NumberValue`: seeded `0` so a client
		// that reads it before any `Waiting` has an unambiguous "no countdown is due" rather than a missing instance, and
		// created here rather than at `Waiting` entry so the read never races the creation.
		const existingDeadline = ReplicatedStorage.FindFirstChild(PLAYING_DEADLINE_VALUE_NAME);
		if (existingDeadline !== undefined && existingDeadline.IsA("NumberValue")) {
			this.playingDeadlineValue = existingDeadline;
		} else {
			const deadline = new Instance("NumberValue");
			deadline.Name = PLAYING_DEADLINE_VALUE_NAME;
			deadline.Value = 0;
			deadline.Parent = ReplicatedStorage;
			this.playingDeadlineValue = deadline;
		}
	}

	// #endregion
}

/**
 * Reads a body's owner, or `undefined` if it is an orphan.
 *
 * Both attributes are required. A body with an id but no display name would log as `winner=`, and a body
 * with a name but no id cannot be identified — so treating a half-written pair as "no owner" is the only
 * reading that cannot produce a competitor whose identity is unknowable. `math.floor` on the id rather
 * than trusting the attribute's type alone: an attribute written as a float would otherwise make two
 * different owners compare equal after Lua's number formatting.
 */
function readOwner(ball: BasePart): BallOwner | undefined {
	const userId = ball.GetAttribute(OWNER_USER_ID_ATTRIBUTE);
	const displayName = ball.GetAttribute(OWNER_DISPLAY_NAME_ATTRIBUTE);

	if (!hasOwnerIdentity(userId, displayName)) {
		return undefined;
	}

	// The type guard belongs in `hasOwnerIdentity`, which a spec can call; this cast is the price of narrowing across a
	// function boundary and is exactly what the guard above proved.
	return { userId: math.floor(userId as number), displayName: displayName as string };
}

/**
 * A player's balance, as the economy last published it.
 *
 * `0` when the attribute is absent, which happens only for a player whose profile never loaded — and `grantCoins` refuses
 * those anyway, so the value is read for the log and for the client's animation and never used to decide anything.
 */
function readCoins(player: Player): number {
	const coins = player.GetAttribute(PLAYER_COINS_ATTRIBUTE);
	return typeIs(coins, "number") ? math.floor(coins) : 0;
}

/** Seconds to two places, so an `elapsed=` field is readable without `string.format`. */
function formatSeconds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}
