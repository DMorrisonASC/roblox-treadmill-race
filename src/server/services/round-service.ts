import { CollectionService, ReplicatedStorage, RunService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { REMOTES_FOLDER_NAME, START_ROUND_REMOTE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import {
	BELT_RAMP_SECONDS,
	COUNTDOWN_SECONDS,
	END_HOLD_SECONDS,
	ROUND_DURATION_SECONDS,
	TICK_INTERVAL_SECONDS,
} from "shared/tuning";
import { BallSpawnerService } from "./ball-spawner-service";
import { TreadmillService } from "./treadmill-service";

/** The four phases a round moves through, in order. `Idle` is both the start and the end state. */
export type RoundPhase = "Idle" | "Countdown" | "Running" | "Ended";

/**
 * Runs one round at a time: phases, the belt ramp, elimination, the end condition, and reset.
 *
 * ## What "a round" is
 *
 * `Idle` → `Countdown` → `Running` → `Ended` → `Idle`. The belt is stopped everywhere except
 * `Running`, where it ramps linearly to full speed. Bodies exist only between `Countdown` entry and the
 * end of `Ended`. Nothing here knows about players, bets, powers, or UI.
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
 * `onTick` fires on `TICK_INTERVAL_SECONDS` during `Running` and nowhere else, and returns a
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
 */
@Service()
export class RoundService implements OnStart {
	private phase: RoundPhase = "Idle";

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

	/** The linear ramp's frame connection. `undefined` whenever the belt is not ramping. */
	private rampConnection?: RBXScriptConnection;

	/** True once the "no zone" warning has been said for the current round. */
	private warnedNoZone = false;

	/**
	 * Live count when the round entered `Running`.
	 *
	 * Used only by the win condition: "one remains" is a win when several started, but with a single
	 * spawner the round would otherwise declare a winner in the same frame `Running` begins, which is
	 * technically true and practically useless. A round that starts with one entrant simply runs its
	 * clock.
	 */
	private initialLiveCount = 0;

	public constructor(
		private readonly treadmill: TreadmillService,
		private readonly spawner: BallSpawnerService,
	) {}

	public onStart(): void {
		// The belt starts stopped. This runs before any belt is necessarily bound, which is fine:
		// `setBeltSpeed` stores the value and `readSpeed` applies it to each surface as it is created.
		this.treadmill.setBeltSpeed(0);

		this.createStartRoundRemote();

		print("[Round] idle — press 2 to start");
	}

	// #region public API

	/**
	 * Starts a round. Only meaningful from `Idle`.
	 *
	 * A no-op with a warning from any other phase. `Running` most often: a second press mid-round must
	 * not restart the round under the players, and silently ignoring it would look like the key did not
	 * work. `Ended` also no-ops rather than queueing a restart, because a queued restart would start a
	 * round at an unpredictable moment five seconds later — the player can press `2` again once the log
	 * says `Idle`.
	 */
	public start(): void {
		if (this.phase !== "Idle") {
			warn(`[Round] start ignored: already in ${this.phase}.`);
			return;
		}

		this.enterCountdown();
	}

	public getPhase(): RoundPhase {
		return this.phase;
	}

	/**
	 * Seconds since `Running` began.
	 *
	 * Zero during `Idle` and `Countdown`; counting during `Running`; **frozen at the round's final value
	 * during `Ended`**. The freeze is what lets anything reading the result — a log line, a later bet
	 * settlement, a power's handler still running — see the number the round ended with rather than one
	 * that keeps growing while the bodies are on display.
	 */
	public getElapsedSeconds(): number {
		if (this.phase === "Running") {
			return os.clock() - this.runningStartedAt;
		}

		return this.frozenElapsed;
	}

	/**
	 * The bodies still in the round.
	 *
	 * **Returns survivors during `Ended`, not an empty list.** The round is over but the result is being
	 * displayed, and a caller asking "who is left" during the hold wants the answer the round ended
	 * with — the same reason `getElapsedSeconds` is frozen. Empty in `Idle` (no round) and in
	 * `Countdown` before the spawn returns.
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
	 * Subscribes to the round's 1 Hz tick during `Running`.
	 *
	 * Returns a disconnect. Fires once per `TICK_INTERVAL_SECONDS` while `Running`, never in any other
	 * phase — a power is scoped to a round's running time by construction, so it cannot leak into the
	 * countdown or outlive the result.
	 */
	public onTick(callback: (elapsed: number) => void): () => void {
		this.tickCallbacks.add(callback);
		return () => {
			this.tickCallbacks.delete(callback);
		};
	}

	// #endregion

	// #region phase transitions

	private enterCountdown(): void {
		this.phase = "Countdown";
		const generation = ++this.generation;

		// Bodies exist from here, so anything that wants to tag them at spawn has them available.
		this.spawner.setRoundActive(true);
		const balls = this.spawner.spawnForRound(this.spawner.getBoundSpawnerCount());
		for (const ball of balls) {
			this.trackBall(ball);
		}
		this.initialLiveCount = this.liveBalls.size();

		this.treadmill.setBeltSpeed(0);

		print(`[Round] Idle → Countdown (balls=${this.liveBalls.size()}, belt=0)`);

		task.delay(COUNTDOWN_SECONDS, () => {
			if (generation !== this.generation || this.phase !== "Countdown") {
				return;
			}
			this.enterRunning();
		});
	}

	private enterRunning(): void {
		this.phase = "Running";
		const generation = ++this.generation;
		this.runningStartedAt = os.clock();
		this.frozenElapsed = 0;

		print(`[Round] Countdown → Running (elapsed=0, cap=${ROUND_DURATION_SECONDS}s)`);

		this.warnIfNoZone();
		this.startBeltRamp();
		this.startTickLoop(generation);
	}

	private enterEnded(reason: string): void {
		if (this.phase !== "Running") {
			return;
		}

		this.frozenElapsed = os.clock() - this.runningStartedAt;
		this.phase = "Ended";
		const generation = ++this.generation;

		this.stopBeltRamp();
		this.treadmill.setBeltSpeed(0);
		this.spawner.setRoundActive(false);

		print(`[Round] Running → Ended (elapsed=${formatSeconds(this.frozenElapsed)}) ${reason}`);

		task.delay(END_HOLD_SECONDS, () => {
			if (generation !== this.generation || this.phase !== "Ended") {
				return;
			}
			this.enterIdle();
		});
	}

	private enterIdle(): void {
		this.phase = "Idle";
		this.generation++;

		// Clear the bodies before announcing idle, so the log line matches the world. `forgetBall` runs
		// first, which is what stops the `Destroying` handler treating this as an outside death.
		for (const ball of this.getLiveBalls()) {
			this.forgetBall(ball);
			ball.Destroy();
		}
		this.liveBalls.clear();
		this.treadmill.setBeltSpeed(0);
		this.frozenElapsed = 0;
		this.initialLiveCount = 0;
		this.warnedNoZone = false;

		print("[Round] Ended → Idle");
		print("[Round] idle — press 2 to start");
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
			// Left `Running` mid-ramp: stop writing immediately. `enterEnded` also calls `stopBeltRamp`, but
			// checking here means a stale callback can never move the belt after the phase changed.
			if (generation !== this.generation || this.phase !== "Running") {
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
			while (this.phase === "Running" && generation === this.generation) {
				task.wait(TICK_INTERVAL_SECONDS);

				if (this.phase !== "Running" || generation !== this.generation) {
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
				if (this.checkEndCondition(elapsed)) {
					return;
				}
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
			this.forgetBall(ball);
			ball.Destroy();
			print(`[Round] eliminated ${name}, live=${this.liveBalls.size()}`);
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
	 * Three conditions, in this order:
	 *  - **No survivors** — everyone left the zone (or was destroyed elsewhere). Logged as such rather
	 *    than as a draw, because "nobody finished" is a different, reportable outcome.
	 *  - **One survivor**, and more than one started. The second half matters: with a single spawner the
	 *    round begins with one live body, and without the guard it would declare a winner inside the same
	 *    frame `Running` starts.
	 *  - **Timer expired** — every survivor is a co-winner. The round does not pick a single winner it
	 *    cannot justify, and it does not call itself undecided, because a later bet settled on "did my
	 *    body survive" has a definite answer.
	 */
	private checkEndCondition(elapsed: number): boolean {
		const live = this.getLiveBalls();

		if (live.size() === 0) {
			this.enterEnded("ended: no survivors");
			return true;
		}

		if (live.size() === 1 && this.initialLiveCount > 1) {
			const survivor = live[0];
			this.enterEnded(`ended: winner=${survivor === undefined ? "unknown" : survivor.GetFullName()}`);
			return true;
		}

		if (elapsed >= ROUND_DURATION_SECONDS) {
			const names = new Array<string>();
			for (const ball of live) {
				names.push(ball.GetFullName());
			}

			this.enterEnded(`ended: co-winners=${live.size()} ${names.join(", ")}`);
			return true;
		}

		return false;
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
		this.evaluateAfterLoss();
	}

	/**
	 * Re-checks the end condition after a body is lost outside the tick.
	 *
	 * Without this the "one remains" win would wait up to `TICK_INTERVAL_SECONDS`, and a round whose last
	 * two bodies were culled by `KillY` in the same frame would sit in `Running` with nothing alive until
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
		if (this.phase !== "Running") {
			return;
		}

		task.defer(() => {
			if (this.phase !== "Running") {
				return;
			}
			this.checkEndCondition(os.clock() - this.runningStartedAt);
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

	// #region remote

	/**
	 * Creates the `StartRound` remote, reusing the folder the spawner made if it exists.
	 *
	 * The find-or-create is duplicated from `BallSpawnerService` rather than factored out, because the
	 * alternative is a third service whose only job is owning a folder — and whichever service runs first
	 * still has to handle the other's absence. Two short helpers that cannot disagree about anything
	 * except which one creates the folder, where both outcomes are identical, is the smaller thing.
	 */
	private createStartRoundRemote(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const event = new Instance("RemoteEvent");
		event.Name = START_ROUND_REMOTE_NAME;
		event.Parent = folder;

		// The client sends nothing and this handler ignores everything it could send: whether a round may
		// start is decided by the phase, not by who asked or what they passed.
		event.OnServerEvent.Connect(() => {
			this.start();
		});
	}

	// #endregion
}

/** Seconds to two places, so an `elapsed=` field is readable without `string.format`. */
function formatSeconds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}
