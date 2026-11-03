import { CollectionService, Players, ReplicatedStorage, RunService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { OWNER_DISPLAY_NAME_ATTRIBUTE, OWNER_USER_ID_ATTRIBUTE } from "shared/attributes";
import {
	DEBUG_PLAYING_REMOTE_NAME,
	DEBUG_SPAWN_REMOTE_NAME,
	DEBUG_WAITING_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
	ROUND_STATE_VALUE_NAME,
	WINNER_NAME_VALUE_NAME,
} from "shared/remotes";
import { TAGS } from "shared/tags";
import {
	BELT_RAMP_SECONDS,
	INTERMISSION_SECONDS,
	POST_GAME_SECONDS,
	ROUND_IDLE_WARN_SECONDS,
	TICK_INTERVAL_SECONDS,
	WAITING_SECONDS,
} from "shared/tuning";
import { BallOwner, BallSpawnerService } from "./ball-spawner-service";
import { TreadmillService } from "./treadmill-service";

/**
 * The four phases of the game loop, in order. `Intermission` is both the start and the end state, which
 * is what makes the machine a loop rather than a single round.
 */
export type RoundPhase = "Intermission" | "Waiting" | "Playing" | "PostGame";

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
 * involves `Touched`, and **`TreadmillWall` is never consulted** — a wall is a guard rail inside the
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

	/** The linear ramp's frame connection. `undefined` whenever the belt is not ramping. */
	private rampConnection?: RBXScriptConnection;

	/** True once the "no zone" warning has been said for the current round. */
	private warnedNoZone = false;

	/**
	 * Live count when the round entered `Playing`.
	 *
	 * Used only by the win condition: "one remains" is a win when several started, but with a single
	 * spawner the round would otherwise declare a winner in the same frame `Playing` begins, which is
	 * technically true and practically useless. A round that starts with one entrant simply runs its
	 * clock.
	 */
	private initialLiveCount = 0;

	/** The replicated `StringValue` clients read. Created in `onStart`. */
	private roundState?: StringValue;

	/** The replicated `StringValue` carrying the last round's winner. Created in `onStart`. */
	private winnerName?: StringValue;

	/**
	 * The last synthetic owner number handed out, so the next debug competitor is `Debug#(n+1)`.
	 *
	 * Shared by `Waiting`-entry defaults and `3` presses rather than being two counters, because
	 * `OwnerUserId` is an **identity**: two bodies sharing `-1` would make "which competitor won"
	 * ambiguous in the log while looking fine in the world. It is reset whenever the world is cleared
	 * (a debug jump to `Waiting`, `PostGame → Intermission`) so the numbering restarts with the round.
	 */
	private nextDebugOwnerNumber = 0;

	public constructor(
		private readonly treadmill: TreadmillService,
		private readonly spawner: BallSpawnerService,
	) {}

	public onStart(): void {
		// The belt starts stopped. This runs before any belt is necessarily bound, which is fine:
		// `setBeltSpeed` stores the value and `readSpeed` applies it to each surface as it is created.
		this.treadmill.setBeltSpeed(0);

		this.createDebugRemotes();
		this.createRoundStateValue();

		// The first `[Round]` line a fresh server prints must name the phase it is in, not the one it is
		// leaving, so it is a state line rather than an arrow. `Intermission` is the initial value of
		// `this.phase`, so there is no transition to log — only the announcement.
		this.publishPhase();
		print(`[Round] state=${this.phase} — press 2 to skip a phase`);
		this.startIntermissionTimer();
	}

	// #region public API

	/**
	 * Forces the machine into `Waiting`, from any phase, skipping whatever timer or end condition would
	 * have got there.
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
		this.clearAllBodies("debug key 1");
		this.resetSyntheticCounter();
		this.initialLiveCount = 0;

		const spawned = this.spawnRoundCompetitors(reason);

		this.enterWaiting(reason, spawned);
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
			this.clearAllBodies("debug key 2 restart");
			this.resetSyntheticCounter();
			this.initialLiveCount = 0;

			const restarted = this.spawnRoundCompetitors("debug key 2 restart");
			if (restarted === 0) {
				// `spawnRoundCompetitors` already printed the reason (no players, or no spawners). Staying in
				// `Playing` with an empty belt is the honest outcome: the round is running and has nothing to
				// race, and the idle warning will say so after `ROUND_IDLE_WARN_SECONDS`.
				return;
			}

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
			// `1` remains the way out of `PostGame`, because it goes to `Waiting` and its own teardown path.
			print(`[Round] debug-advance refused — ${this.phase} is clearing`);
			return;
		}

		this.clearAllBodies("debug key 2");
		this.resetSyntheticCounter();
		this.initialLiveCount = 0;

		const spawned = this.spawnRoundCompetitors(reason);
		if (spawned === 0) {
			// `spawnRoundCompetitors` already logged why. Staying put is the only honest outcome: entering
			// `Playing` with nothing to race is the 21:42 failure, and clearing again here would destroy
			// nothing while implying it had.
			print(`[Round] debug key 2: no competitors spawned, staying in ${this.phase}`);
			return;
		}

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
	 * ## Capped, not wrapped
	 *
	 * Two players cannot share a lane — they would spawn inside each other and the round would read as one
	 * competitor that happened to explode. Players beyond the spawner count are therefore dropped, with a
	 * single line naming how many were wanted and how many exist, because a per-player "you were dropped"
	 * line would multiply with the player count and say the same thing each time.
	 */
	public spawnRoundCompetitors(reason: string): number {
		const players = Players.GetPlayers();
		const wanted = players.size();

		if (wanted === 0) {
			print(`[Round] spawn refused — no players connected (${reason})`);
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

		let spawned = 0;
		for (let lane = 0; lane < count; lane++) {
			const player = players[lane];
			if (player === undefined) {
				continue;
			}

			const owner: BallOwner = { userId: player.UserId, displayName: player.DisplayName };
			const ball = this.spawner.spawnInLane(lane, owner);
			if (ball === undefined) {
				continue;
			}

			this.trackBall(ball);
			spawned++;

			print(`[Round] spawn lane=${lane} owner=${owner.displayName}(${owner.userId}) body=${ball.GetFullName()}`);
		}

		// Set, not incremented: this is the number of competitors the round must beat down to one, and the
		// spawner's `MaxLiveBalls` eviction can shrink the live set between calls.
		this.initialLiveCount = spawned;

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
	 * ## Why `initialLiveCount` is *set*, not incremented
	 *
	 * The end condition asks "did more than one competitor ever start". A debug spawn changes that answer
	 * from the moment it lands, so the field has to move with it — but incrementing by four would
	 * over-count whenever the spawner evicted a body between two presses, and the count exists precisely to
	 * be compared against a live set that the `MaxLiveBalls` eviction can shrink. Setting it to the live
	 * count after the spawn keeps the two consistent by construction: `initialLiveCount` becomes "how many
	 * competitors this round has had to beat", which is the only reading the win check needs.
	 *
	 * ## Why it is refused outside `Playing`
	 *
	 * The bodies would be spawned into a phase whose tick is not running, so nothing would ever eliminate
	 * them, count them or end the round they were added to. Refusing with the phase named is the only
	 * answer that does not leave orphans — the exact class of body this round exists to stop creating.
	 */
	public debugSpawnCompetitors(): void {
		if (this.phase !== "Playing") {
			print(`[Round] debug spawn refused — not Playing (phase=${this.phase})`);
			return;
		}

		const owners = this.nextDebugOwners(this.spawner.getBoundSpawnerCount());
		const spawned = this.spawner.spawnForRound(owners);
		for (const ball of spawned) {
			this.trackBall(ball);
		}

		// Set, not added to: see the note above.
		this.initialLiveCount = this.getLiveBalls().size();

		const first = owners[0];
		const last = owners[owners.size() - 1];
		print(
			`[Round] debug spawn: ${spawned.size()} competitors (${first === undefined ? "none" : first.displayName}..${last === undefined ? "none" : last.displayName}), live=${this.liveBalls.size()}, initial=${this.initialLiveCount}`,
		);
	}

	/** Hands out the next `Debug#N` owner, continuing the shared counter. */
	private nextDebugOwner(): BallOwner {
		this.nextDebugOwnerNumber++;
		return { userId: -this.nextDebugOwnerNumber, displayName: `Debug#${this.nextDebugOwnerNumber}` };
	}

	/** `count` fresh synthetic owners, in order. */
	private nextDebugOwners(count: number): BallOwner[] {
		const owners = new Array<BallOwner>();
		for (let index = 0; index < count; index++) {
			owners.push(this.nextDebugOwner());
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
	private enterWaiting(reason: string, competitors: number): void {
		const from = this.phase;
		this.phase = "Waiting";
		const generation = ++this.generation;

		// Bodies exist from here, so anything that wants to tag them at spawn has them available.
		this.spawner.setRoundActive(true);

		this.treadmill.setBeltSpeed(0);

		print(`[Round] ${from} → Waiting (${reason}, competitors=${competitors})`);
		this.publishPhase();

		this.scheduleWaitingTimeout(generation);
	}

	/**
	 * Arms the `Waiting → Playing` timer, re-arming itself once if the guard refuses.
	 *
	 * **A refusal is expected here and is not an error.** Nothing spawned at this transition — the bodies
	 * were made when `Waiting` was entered — so by the time the timer fires they may all have been
	 * destroyed by the spawner's `MaxLiveBalls` eviction or a manual cleanup. The re-arm exists so that state is visible as
	 * `[Round] Waiting timer re-armed — no competitors (0)` rather than as a phase that silently never
	 * advances, which is indistinguishable from a dead server.
	 */
	private scheduleWaitingTimeout(generation: number): void {
		task.delay(WAITING_SECONDS, () => {
			if (generation !== this.generation || this.phase !== "Waiting") {
				return;
			}

			if (this.enterPlaying("waiting elapsed")) {
				return;
			}

			print(`[Round] Waiting timer re-armed — no competitors (0)`);
			this.scheduleWaitingTimeout(this.generation);
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

		// The idle clock starts with the round, and the warning flag with it: a round that begins and then
		// sits still for `ROUND_IDLE_WARN_SECONDS` is exactly the case the warning is for, and a flag left
		// set from a previous round would suppress it.
		this.lastProgressAt = this.runningStartedAt;
		this.idleWarned = false;

		print(`[Round] ${from} → Playing (elapsed=0, ${reason}, competitors=${competitors.size()})`);
		this.publishPhase();

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
			this.enterIntermission("post-game hold elapsed");
		});
	}

	private enterIntermission(reason: string): void {
		const from = this.phase;
		this.phase = "Intermission";
		this.generation++;

		this.clearAllBodies("intermission");

		this.treadmill.setBeltSpeed(0);
		this.frozenElapsed = 0;
		this.initialLiveCount = 0;
		this.warnedNoZone = false;

		// The winner belongs to the round that just ended, so it is cleared here rather than at the start of
		// the next one: a client watching `Intermission` must not still be showing a result from a round
		// that is over, and clearing at `Waiting` instead would leave the stale name visible for the whole
		// gap.
		this.publishWinner(undefined);

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

		if (destroyed > 0) {
			print(`[Round] cleared ${destroyed} ball(s) (${reason})`);
		}
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

		task.spawn(() => {
			// The first wait is skipped only if a caller wants the transition immediately; here the timer
			// always runs its full duration before the first check.
			while (this.phase === "Intermission" && generation === this.generation) {
				task.wait(INTERMISSION_SECONDS);

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
				const spawned = this.spawnRoundCompetitors("intermission elapsed");
				if (spawned === 0) {
					print(
						`[Round] Intermission timer restarted — no competitors spawned, another ${INTERMISSION_SECONDS}s`,
					);
					continue;
				}

				this.enterWaiting("intermission elapsed", spawned);
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
			this.forgetBall(ball);
			ball.Destroy();

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
	 *  - **No competitors left** → `winner=none`. Reported rather than treated as a draw, because "every
	 *    competitor was eliminated" is a definite result a bet can settle against.
	 *  - **One competitor, and more than one ever started** → that owner wins. `initialLiveCount > 1` is
	 *    what makes this *last standing* rather than "first frame": a round that began with one competitor
	 *    is not won by that competitor surviving the first tick.
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

		if (live.size() === 0) {
			this.endPlaying(this.initialLiveCount === 0 ? "no competitors" : "no survivors", undefined);
			return true;
		}

		if (live.size() === 1 && this.initialLiveCount > 1) {
			const survivor = live[0];
			if (survivor === undefined) {
				this.endPlaying("ended: no survivors", undefined);
				return true;
			}

			const owner = readOwner(survivor);
			this.endPlaying(`last standing: ${survivor.GetFullName()}`, owner === undefined ? undefined : owner);
			return true;
		}

		return false;
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

		this.forgetBall(ball);

		// A body lost to the kill plane or a future path is still a change in the round's state, so it
		// restarts the idle clock for the same reason a zone elimination does — see `warnIfIdle`.
		this.lastProgressAt = os.clock();

		this.evaluateAfterLoss();
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
		const waiting = new Instance("RemoteEvent");
		waiting.Name = DEBUG_WAITING_REMOTE_NAME;
		waiting.Parent = folder;
		waiting.OnServerEvent.Connect(() => this.forceWaiting("debug key 1"));

		const playing = new Instance("RemoteEvent");
		playing.Name = DEBUG_PLAYING_REMOTE_NAME;
		playing.Parent = folder;
		playing.OnServerEvent.Connect(() => this.forcePlaying("debug key 2"));

		const spawn = new Instance("RemoteEvent");
		spawn.Name = DEBUG_SPAWN_REMOTE_NAME;
		spawn.Parent = folder;
		spawn.OnServerEvent.Connect(() => this.debugSpawnCompetitors());
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

	if (!typeIs(userId, "number") || !typeIs(displayName, "string")) {
		return undefined;
	}

	return { userId: math.floor(userId), displayName };
}

/** Seconds to two places, so an `elapsed=` field is readable without `string.format`. */
function formatSeconds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}
