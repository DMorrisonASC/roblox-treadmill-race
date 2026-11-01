import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import {
	DEFAULT_MAX_LIVE_BALLS,
	DEFAULT_SPAWNER_ENABLED,
	DEFAULT_SPAWNER_RADIUS,
	DEFAULT_SPAWNER_RATE,
	SPAWNER_ENABLED_ATTRIBUTE,
	SPAWNER_KILL_Y_ATTRIBUTE,
	SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE,
	SPAWNER_RADIUS_ATTRIBUTE,
	SPAWNER_RATE_ATTRIBUTE,
} from "shared/attributes";
import { REMOTES_FOLDER_NAME, SPAWN_BALL_REMOTE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";

/** **Placeholder** minimum time between accepted manual spawns, per player, in milliseconds. */
const MANUAL_SPAWN_COOLDOWN_MS = 100;

/**
 * How often the stream loop wakes up. 0.1 s is fine-grained enough that a `Rate` of 2 and a `Rate`
 * of 60 both look like a stream rather than a burst, and coarse enough that a burst never becomes
 * a per-frame task storm. Spawning is *not* done by a `task.spawn` per ball: one loop owns every
 * spawner and converts elapsed time into whole balls using a per-spawner remainder, so a fractional
 * rate like 2.5/s does not quietly round down to 2/s.
 */
const STREAM_TICK_SECONDS = 0.1;

/**
 * Cleanup cadence. Every 0.5 s a single loop walks the live-ball list once: kill-plane cull, then
 * cap enforcement. Per-frame per-ball work (a Heartbeat loop touching every ball) would cost
 * nothing at 50 balls and everything at 5000, and the visible difference between a ball being
 * culled after 0 s and after 0.5 s is nil — it is already below the kill plane at that point.
 * The cap is additionally enforced synchronously on every spawn so the live count cannot overshoot
 * between cleanup passes.
 */
const CLEANUP_INTERVAL_SECONDS = 0.5;

/**
 * Gap between the bottom of a spawned ball and the spawner's own origin Y, in studs. The ball's
 * *centre* is placed at `Radius + clearance` above the spawner, so its lowest point starts
 * `clearance` studs above the spawner origin: enough to avoid spawning inside the belt it is
 * dropped onto (spawn-inside-geometry is the classic cause of a ball being flung, not dropped).
 */
const BALL_SPAWN_CLEARANCE_STUDS = 0.5;

/**
 * Log every Nth stream tick. The loop wakes 10 times a second; a line per tick per spawner would
 * emit 20 lines/second with two spawners and bury the one line that matters (the error). Sampling
 * at every tenth tick gives one line per second that reports *all* spawners in that tick, which is
 * the cadence that answers "did the loop run, did it see them, did the cap eat the balls" without
 * turning Output into a scroll storm. The alternative — logging only on state change — would print
 * nothing at all while balls are streaming normally, which is indistinguishable from a dead loop.
 */
const TICK_LOG_EVERY = 10;

/** Consecutive failed ticks before an already-reported spawner error repeats. 50 ticks = 5 s. */
const FAILURE_REMINDER_EVERY = 50;

/**
 * A spawner's spawn failure, kept so repeated failures degrade into a periodic reminder instead of
 * one warning per tick. `message` is the latest error, not the first — an error that changes shape
 * is more interesting than one that repeats.
 */
interface SpawnerFailure {
	count: number;
	message: string;
}

/**
 * Server-authoritative ball factory driven by parts tagged `BallSpawner`.
 *
 * The spawner part is a pure locator: the service reads its position and its attributes and
 * creates balls as children of a `SpawnedBalls` folder in `Workspace`. It never moves, resizes or
 * reskins the locator, and it knows nothing about belts or rounds.
 *
 * ## Why balls are created on the server only
 *
 * The client's only power here is asking: it fires a RemoteEvent and the server decides whether a
 * ball exists. That costs a round-trip of latency on the manual trigger, which is irrelevant for a
 * test fixture and is the whole point of "server-authoritative" — a client that could create its
 * own balls could also create a thousand of them, and every later slice that counts balls would
 * have to defend against that.
 *
 * ## Cap semantics
 *
 * `MaxLiveBalls` lives on the spawner, but the count it describes is global — a ball is a ball no
 * matter which locator made it. With several spawners the effective cap is the *smallest*
 * `MaxLiveBalls` among them, which is the only rule that keeps every spawner's stated limit
 * truthful. With the single spawner this slice ships, the distinction never shows up.
 *
 * ## `KillY` semantics
 *
 * Each ball records the kill plane of the spawner that made it. Changing `KillY` therefore applies
 * to balls spawned afterwards and leaves already-falling balls on their old plane; the alternative
 * (one global plane recomputed every pass) would make a mid-flight edit retroactively delete balls
 * the designer was still watching.
 *
 * The value itself is derived, not chosen — `deriveKillY` explains the arithmetic.
 *
 * ## Where the attributes come from
 *
 * Nothing here requires a hand-set attribute. `ensureDerivedAttributes` fills in whatever is absent
 * at bind, so tagging a part is sufficient on its own; anything already set in Studio wins and is
 * never overwritten. The reasoning for that, and the decision it reversed, is at the top of
 * `shared/attributes.ts`.
 */
@Service()
export class BallSpawnerService implements OnStart {
	private readonly spawners = new Set<BasePart>();
	private readonly spawnerConnections = new Map<BasePart, RBXScriptConnection>();
	/** Fractional balls owed to each spawner, so `Rate` is honoured exactly over time. */
	private readonly pendingSpawns = new Map<BasePart, number>();
	private readonly lastManualSpawnAt = new Map<Player, number>();

	/** Spawn order, oldest first — the order the cap evicts in. */
	private liveBalls = new Array<BasePart>();
	private readonly ballKillY = new Map<BasePart, number>();

	private streamActive = false;
	/**
	 * Bumped on every start and stop. A loop only keeps running while its own generation is still
	 * current, so a loop that was mid-`task.wait` when the stream was disabled exits on its next
	 * wake-up instead of being orphaned and spawning balls for a disabled fixture.
	 */
	private streamGeneration = 0;

	/**
	 * The coroutine currently owning the stream, or `undefined` when none is running.
	 *
	 * This — not `streamActive` — is what decides whether a new loop may be scheduled. The flag alone
	 * was the wedge: a loop that died from an unprotected error left `streamActive === true` forever,
	 * so `startStream` returned early on every later bind and every `Enabled` toggle, and streaming
	 * stayed dead while the manual path (which never reads this state) kept working. Liveness makes
	 * a dead thread restartable instead of terminal.
	 */
	private streamThread?: thread;
	private tickCount = 0;
	/** Stable ids so two Ctrl+D clones, which share a name and a `GetFullName()`, stay distinguishable. */
	private readonly spawnerIds = new Map<BasePart, number>();
	private nextSpawnerId = 0;
	private readonly spawnerFailures = new Map<BasePart, SpawnerFailure>();

	public onStart(): void {
		for (const instance of CollectionService.GetTagged(TAGS.ballSpawner)) {
			this.bindSpawner(instance);
		}

		CollectionService.GetInstanceAddedSignal(TAGS.ballSpawner).Connect((instance) => this.bindSpawner(instance));
		CollectionService.GetInstanceRemovedSignal(TAGS.ballSpawner).Connect((instance) =>
			this.unbindSpawner(instance),
		);

		this.createManualSpawnRemote();

		Players.PlayerRemoving.Connect((player) => this.lastManualSpawnAt.delete(player));

		task.spawn(() => {
			while (true) {
				this.cleanup();
				task.wait(CLEANUP_INTERVAL_SECONDS);
			}
		});

		this.syncStream();
	}

	// #region binding

	private bindSpawner(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			warn(
				`[BallSpawner] ${instance.GetFullName()} is tagged ${TAGS.ballSpawner} but is not a BasePart; ignoring.`,
			);
			return;
		}

		if (this.spawnerConnections.has(instance)) {
			return;
		}

		// Derived before anything observes the part. `SetAttribute` fires attribute-changed signals, and
		// the `Enabled` connection below calls straight back into `syncStream`, so writing attributes
		// after connecting it would start a stream tick while `Radius` (and therefore `KillY`) was still
		// unwritten. Nothing would break — the tick's elapsed time is ~0, so it spawns nothing — but a
		// tick running against a half-configured part is exactly the kind of thing that later becomes
		// a real bug.
		const derived = this.ensureDerivedAttributes(instance);

		const connection = instance
			.GetAttributeChangedSignal(SPAWNER_ENABLED_ATTRIBUTE)
			.Connect(() => this.syncStream());
		this.spawnerConnections.set(instance, connection);
		this.spawners.add(instance);

		const id = ++this.nextSpawnerId;
		this.spawnerIds.set(instance, id);

		// Logged with the values `GetAttribute` actually returned, plus whether this service had to
		// supply them. `nil` can no longer appear for these five (they were just filled in), but a
		// wrong-typed value can, and that is the case worth seeing: `Radius = "0.5"` reads as a string
		// and would otherwise be silently replaced by the default with no trace of the mistake.
		const attributes = this.describeAttributes(instance);
		print(
			`[BallSpawner] bound #${id} ${instance.GetFullName()} (${instance.ClassName}) tag=${TAGS.ballSpawner} derived=${derived.size() === 0 ? "none" : derived.join(",")} ${attributes.summary}`,
		);

		// Separate line, and a warning rather than a print, so a malformed spawner is findable in Output
		// without reading every bind line. It is not fatal: the default applies and this spawner still
		// streams, which is what keeps one bad part from taking the fixture down.
		if (attributes.problems !== "") {
			warn(`[BallSpawner] #${id} ${instance.GetFullName()} attribute check: ${attributes.problems}`);
		}

		// A spawner that arrives already enabled must start streaming; `syncStream` is a no-op if
		// nothing is enabled, so it is safe to call unconditionally.
		this.syncStream();
	}

	private unbindSpawner(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		const connection = this.spawnerConnections.get(instance);
		if (connection !== undefined) {
			connection.Disconnect();
			this.spawnerConnections.delete(instance);
		}

		// Logged before the id is dropped, so the line names the same spawner the bind line named.
		print(`[BallSpawner] unbound ${this.labelFor(instance)}: tag removed or instance destroyed.`);

		this.spawners.delete(instance);
		this.pendingSpawns.delete(instance);
		this.spawnerIds.delete(instance);
		this.spawnerFailures.delete(instance);
		this.syncStream();
	}

	// #endregion

	// #region manual trigger

	private createManualSpawnRemote(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const event = new Instance("RemoteEvent");
		event.Name = SPAWN_BALL_REMOTE_NAME;
		event.Parent = folder;

		// The client sends no arguments, and this handler ignores everything past the player anyway:
		// anything a client sends is attacker-controlled, so nothing it says may influence the result.
		event.OnServerEvent.Connect((player) => this.handleManualSpawn(player));
	}

	private handleManualSpawn(player: Player): void {
		const now = os.clock() * 1000;
		const last = this.lastManualSpawnAt.get(player);
		if (last !== undefined && now - last < MANUAL_SPAWN_COOLDOWN_MS) {
			return;
		}
		this.lastManualSpawnAt.set(player, now);

		// `Enabled` is deliberately not consulted: it gates the timed *stream*, and the manual trigger
		// is the thing you use to poke a spawner that is otherwise off. A spawner disabled by an
		// attribute but still tagged is exactly the fixture state "press 1 and watch one ball appear".
		const spawner = this.firstSpawner();
		if (spawner === undefined) {
			warn(`[BallSpawner] manual spawn requested but no part is tagged ${TAGS.ballSpawner}.`);
			return;
		}

		this.spawnBall(spawner);
	}

	/**
	 * Manual spawns use the first registered spawner rather than a random one or all of them, so
	 * that pressing `1` with multiple spawners present stays predictable in a test. "First" is
	 * insertion order of the tag signal, which for a Rojo-built scene is scene order.
	 */
	private firstSpawner(): BasePart | undefined {
		for (const spawner of this.spawners) {
			return spawner;
		}
		return undefined;
	}

	// #endregion

	// #region timed stream

	private syncStream(): void {
		let anyEnabled = false;
		for (const spawner of this.spawners) {
			if (this.isEnabled(spawner)) {
				anyEnabled = true;
				break;
			}
		}

		if (anyEnabled) {
			this.ensureStreamRunning();
		} else {
			this.stopStream();
		}
	}

	/**
	 * Starts the loop if and only if no loop is currently running.
	 *
	 * The guard is thread liveness, not the `streamActive` flag. Liveness is what makes a crashed
	 * loop recoverable: a dead thread is detected and replaced on the next bind or `Enabled` change,
	 * where the flag alone would have said "already running" forever. The cost is one
	 * `coroutine.status` call per bind, which is nothing; the benefit is that no single failure can
	 * leave streaming permanently off while the service still believes it is on.
	 */
	private ensureStreamRunning(): void {
		if (this.isStreamThreadAlive()) {
			// Picking up a spawner that arrived while the loop was asleep needs no action here: the
			// loop reads `this.spawners` at the top of every tick, so a newly bound spawner is streamed
			// from the next tick. A snapshot taken at start would have missed it entirely.
			return;
		}

		this.streamActive = true;
		const generation = ++this.streamGeneration;

		// Exactly one loop for all spawners. One `task.spawn` per ball would hand the scheduler an
		// unbounded number of threads at a high `Rate`; one loop that sleeps a fixed tick does not.
		// `task.spawn` runs the callback immediately until its first yield, and `runStream` never calls
		// back into this function, so assigning the thread afterwards cannot double-schedule.
		this.streamThread = task.spawn(() => this.runStream(generation));
	}

	private isStreamThreadAlive(): boolean {
		const thread = this.streamThread;
		return thread !== undefined && coroutine.status(thread) !== "dead";
	}

	private stopStream(): void {
		const wasActive = this.streamActive;

		// Bumping the generation invalidates every in-flight loop immediately, so a loop that was
		// mid-`task.wait` cannot spawn again after this returns. Dropping the thread reference lets a
		// restart create a new loop at once; the stale loop wakes, sees a generation mismatch and exits
		// without spawning, so two threads can briefly coexist but only one can ever spawn.
		this.streamActive = false;
		this.streamGeneration++;
		this.pendingSpawns.clear();
		this.streamThread = undefined;

		if (wasActive) {
			print(`[BallSpawner] stream stopped: no bound spawner has ${SPAWNER_ENABLED_ATTRIBUTE} = true.`);
		}
	}

	private runStream(generation: number): void {
		let previous = os.clock();

		while (this.streamActive && generation === this.streamGeneration) {
			const now = os.clock();
			const elapsed = math.max(now - previous, 0);
			previous = now;

			// The whole tick is protected on top of the per-spawner protection inside it. Anything that
			// escapes the per-spawner `pcall` — a broken iterator, a malformed set entry — would otherwise
			// kill the only stream thread and silently take every spawner with it, which is precisely
			// the failure this fix exists to prevent. A failed tick is logged and the loop keeps running.
			const failure = this.runProtected(() => this.tickSpawners(elapsed));
			if (failure !== undefined) {
				warn(`[BallSpawner] stream tick failed outside any spawner: ${failure}. The stream continues.`);
			}

			task.wait(STREAM_TICK_SECONDS);
		}

		// Only retire state this loop still owns: a stale loop waking after a restart must not clear the
		// new loop's thread reference or its `streamActive` flag.
		if (this.streamThread === coroutine.running()) {
			this.streamThread = undefined;
		}
		if (generation === this.streamGeneration) {
			this.streamActive = false;
		}
	}

	private tickSpawners(elapsed: number): void {
		this.tickCount++;
		const sampled = this.tickCount % TICK_LOG_EVERY === 0;
		const summary = new Array<string>();

		for (const spawner of this.spawners) {
			const label = this.labelFor(spawner);

			if (!this.isEnabled(spawner)) {
				if (sampled) {
					summary.push(`${label}: disabled`);
				}
				continue;
			}

			const rate = this.readNumber(spawner, SPAWNER_RATE_ATTRIBUTE, DEFAULT_SPAWNER_RATE);
			if (rate <= 0) {
				if (sampled) {
					summary.push(`${label}: Rate=${rate}, idle`);
				}
				continue;
			}

			const owed = (this.pendingSpawns.get(spawner) ?? 0) + rate * elapsed;
			const due = math.floor(owed);
			this.pendingSpawns.set(spawner, owed - due);

			if (due <= 0) {
				if (sampled) {
					summary.push(`${label}: due=0`);
				}
				continue;
			}

			// Per-spawner containment. One spawner throwing must cost that spawner its tick, not the
			// other spawners' stream: `spawnBall` failing for spawner A cannot be allowed to abort the
			// iteration before spawner B is reached. The remainder above is consumed either way, so a
			// permanently broken spawner cannot accumulate an unbounded backlog to dump on recovery.
			let spawned = 0;
			const failure = this.runProtected(() => {
				for (let remaining = due; remaining > 0; remaining--) {
					this.spawnBall(spawner);
					spawned++;
				}
			});

			if (failure !== undefined) {
				this.reportFailure(spawner, failure);
				if (sampled) {
					summary.push(`${label}: ERROR after ${spawned} ball(s)`);
				}
			} else {
				this.reportRecovery(spawner);
				if (sampled) {
					summary.push(`${label}: spawned ${spawned}`);
				}
			}
		}

		if (sampled) {
			print(
				`[BallSpawner] tick #${this.tickCount} bound=${this.spawners.size()} live=${this.liveBalls.size()} cap=${this.effectiveMaxLiveBalls()} | ${summary.join(", ")}`,
			);
		}
	}

	// #endregion

	// #region diagnostics

	/** `#3 Workspace/Spawner` — the id is what tells a Ctrl+D clone apart from its original. */
	private labelFor(spawner: BasePart): string {
		const id = this.spawnerIds.get(spawner);
		return id === undefined ? spawner.GetFullName() : `#${id} ${spawner.GetFullName()}`;
	}

	/**
	 * Runs `action`, returning `undefined` on success or a string describing the failure.
	 *
	 * `xpcall` rather than `pcall` so an error *table* is rendered through `describeError` instead of
	 * being printed as `table: 0x...`. The result is a plain `string | undefined`, which avoids the
	 * `[true, void] | [false, unknown]` narrowing dance at every call site.
	 */
	private runProtected(action: () => void): string | undefined {
		const [success, message] = xpcall(action, (err) => this.describeError(err));
		if (success) {
			return undefined;
		}
		return typeIs(message, "string") ? message : "unknown error";
	}

	private describeError(thrown: unknown): string {
		if (typeIs(thrown, "string")) {
			return thrown;
		}

		// Roblox raises strings for engine errors, but user code can raise tables. Reading `message` is
		// the difference between "Invalid argument #2" and "table: 0x55d3…" in the log.
		if (typeIs(thrown, "table")) {
			const message = (thrown as { message?: unknown }).message;
			if (typeIs(message, "string")) {
				return message;
			}
		}

		return tostring(thrown);
	}

	/**
	 * Logs the first failure immediately, then only every `FAILURE_REMINDER_EVERY` consecutive one.
	 *
	 * A spawner that fails on every tick would otherwise warn 10 times a second, which is how a real
	 * error becomes noise the next person filters out. Suppressing repeats entirely would be worse:
	 * a failure that is still happening would look like a failure that stopped.
	 */
	private reportFailure(spawner: BasePart, message: string): void {
		const previous = this.spawnerFailures.get(spawner);
		const count = (previous?.count ?? 0) + 1;
		this.spawnerFailures.set(spawner, { count, message });

		if (previous === undefined) {
			warn(
				`[BallSpawner] ${this.labelFor(spawner)} failed to spawn: ${message}. Streaming continues for every other spawner.`,
			);
		} else if (count % FAILURE_REMINDER_EVERY === 0) {
			warn(
				`[BallSpawner] ${this.labelFor(spawner)} still failing (${count} consecutive ticks): ${message}. Streaming continues.`,
			);
		}
	}

	private reportRecovery(spawner: BasePart): void {
		const previous = this.spawnerFailures.get(spawner);
		if (previous === undefined) {
			return;
		}

		this.spawnerFailures.delete(spawner);
		print(
			`[BallSpawner] ${this.labelFor(spawner)} recovered after ${previous.count} failed tick(s): ${previous.message}`,
		);
	}

	/**
	 * **Derived, not chosen.** The engine already removes parts that fall below
	 * `Workspace.FallenPartsDestroyHeight` (when `Workspace.FallHeightEnabled` is on), so this service's
	 * own cull exists to reclaim the bookkeeping — the `liveBalls` slot and the ball's recorded plane —
	 * *before* the engine takes the instance away, instead of leaving a destroyed instance in the list
	 * until the next prune pass.
	 *
	 * That makes the correct plane "just above the engine's floor" rather than an invented number. The
	 * first draft used -50, which against the default floor of -500 culled balls 450 studs early, i.e.
	 * while they were still visibly falling. One ball diameter (`2 * radius`, itself already config) is
	 * the smallest gap that is guaranteed to be strictly above the floor for any radius the spawner
	 * accepts, so the derived plane always wins the race without shortening a ball's fall.
	 */
	private deriveKillY(radius: number): number {
		return Workspace.FallenPartsDestroyHeight + radius * 2;
	}

	/**
	 * Fills in every attribute this service reads, but only where the part has none.
	 *
	 * Absent-only is the important half: a value set in Studio is never overwritten, so this cannot
	 * fight a deliberate override and re-tagging a part does not reset it. The alternative — writing
	 * unconditionally — would silently undo a designer's tuning on every rebind, which is the same
	 * class of bug as the Rojo fixture that kept resetting part CFrames.
	 *
	 * Returns the names it wrote, so the bind log can say whether the part was already configured or
	 * whether the values came from here.
	 */
	private ensureDerivedAttributes(part: BasePart): string[] {
		const derived = new Array<string>();

		const ensureNumber = (attribute: string, value: number) => {
			if (part.GetAttribute(attribute) === undefined) {
				part.SetAttribute(attribute, value);
				derived.push(attribute);
			}
		};

		if (part.GetAttribute(SPAWNER_ENABLED_ATTRIBUTE) === undefined) {
			part.SetAttribute(SPAWNER_ENABLED_ATTRIBUTE, DEFAULT_SPAWNER_ENABLED);
			derived.push(SPAWNER_ENABLED_ATTRIBUTE);
		}

		// `Radius` first, because `KillY` is derived from it. Reversing these two lines would compute the
		// kill plane from the fallback radius on a part that had set its own.
		ensureNumber(SPAWNER_RADIUS_ATTRIBUTE, DEFAULT_SPAWNER_RADIUS);
		ensureNumber(SPAWNER_RATE_ATTRIBUTE, DEFAULT_SPAWNER_RATE);
		ensureNumber(SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE, DEFAULT_MAX_LIVE_BALLS);
		ensureNumber(
			SPAWNER_KILL_Y_ATTRIBUTE,
			this.deriveKillY(this.readNumber(part, SPAWNER_RADIUS_ATTRIBUTE, DEFAULT_SPAWNER_RADIUS)),
		);

		return derived;
	}

	/**
	 * Raw attribute readings next to the effective values, for the bind log.
	 *
	 * Runs after `ensureDerivedAttributes`, so absence is no longer expected here; what remains worth
	 * reporting is a *present but wrong-typed* value. `Radius = "0.5"` is always a mistake and the
	 * reader will quietly fall back, so the fallback is named in the log rather than left to be
	 * discovered by watching the balls come out the wrong size.
	 */
	private describeAttributes(part: BasePart): { summary: string; problems: string } {
		const fields = new Array<string>();
		const problems = new Array<string>();

		const describeNumber = (attribute: string, fallback: number) => {
			const raw = part.GetAttribute(attribute);
			const effective = typeIs(raw, "number") ? raw : fallback;
			fields.push(`${attribute}=${raw === undefined ? "nil" : tostring(raw)}`);

			if (raw !== undefined && !typeIs(raw, "number")) {
				problems.push(`${attribute} is not a number (using ${effective})`);
			}
		};

		const describeBoolean = (attribute: string, fallback: boolean) => {
			const raw = part.GetAttribute(attribute);
			const effective = typeIs(raw, "boolean") ? raw : fallback;
			fields.push(`${attribute}=${raw === undefined ? "nil" : tostring(raw)}`);

			if (raw !== undefined && !typeIs(raw, "boolean")) {
				problems.push(`${attribute} is not a boolean (using ${tostring(effective)})`);
			}
		};

		describeBoolean(SPAWNER_ENABLED_ATTRIBUTE, DEFAULT_SPAWNER_ENABLED);
		describeNumber(SPAWNER_RATE_ATTRIBUTE, DEFAULT_SPAWNER_RATE);
		describeNumber(SPAWNER_RADIUS_ATTRIBUTE, DEFAULT_SPAWNER_RADIUS);
		describeNumber(SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE, DEFAULT_MAX_LIVE_BALLS);
		describeNumber(SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY(DEFAULT_SPAWNER_RADIUS));

		return { summary: fields.join(", "), problems: problems.join("; ") };
	}

	// #endregion

	// #region spawning

	private spawnBall(spawner: BasePart): BasePart | undefined {
		if (spawner.Parent === undefined) {
			return undefined;
		}

		const radius = this.readNumber(spawner, SPAWNER_RADIUS_ATTRIBUTE, DEFAULT_SPAWNER_RADIUS);
		if (radius <= 0) {
			warn(
				`[BallSpawner] ${spawner.GetFullName()} has a non-positive ${SPAWNER_RADIUS_ATTRIBUTE}; not spawning.`,
			);
			return undefined;
		}

		const ball = new Instance("Part");
		ball.Name = "Ball";
		// A Part of Shape Ball is a sphere whose Size is the bounding cube, so a uniform Size is the
		// only thing that expresses "a ball of diameter 2r" unambiguously. (The reference pages
		// describe Ball as "A spherical shape" and Size as "visual dimensions" without spelling out
		// the diameter relationship; sizing all three axes equally makes the question moot, which is
		// why this does not read either X or Y as the radius.)
		ball.Shape = Enum.PartType.Ball;
		ball.Size = Vector3.one.mul(radius * 2);
		ball.Anchored = false;
		ball.CanCollide = true;
		// Default material rather than CustomPhysicalProperties: every ball is the same size and the
		// same material, so every ball has the same density and therefore the same mass by
		// construction. Writing explicit physical properties would add a tuning knob that nothing in
		// this slice turns, and would have to be kept in sync with the belt's friction to mean
		// anything. If belt drag ever proves too weak, friction is the knob to reach for — on the
		// belt, not on the ball.
		ball.Material = Enum.Material.Plastic;
		ball.TopSurface = Enum.SurfaceType.Smooth;
		ball.BottomSurface = Enum.SurfaceType.Smooth;
		ball.CFrame = new CFrame(spawner.Position.add(new Vector3(0, radius + BALL_SPAWN_CLEARANCE_STUDS, 0)));
		ball.Parent = this.ballsFolder();

		// Tagged at birth: cleanup counts tagged balls, and a later slice enumerates them. Tagging is
		// the cheap half of that contract — without it, "how many balls are live" degrades into
		// "how many entries are in an array this service happens to remember".
		CollectionService.AddTag(ball, TAGS.ball);

		this.liveBalls.push(ball);
		this.ballKillY.set(ball, this.readNumber(spawner, SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY(radius)));
		this.enforceCap();

		return ball;
	}

	private ballsFolder(): Folder {
		const existing = Workspace.FindFirstChild("SpawnedBalls");
		if (existing !== undefined && existing.IsA("Folder")) {
			return existing;
		}

		const folder = new Instance("Folder");
		folder.Name = "SpawnedBalls";
		folder.Parent = Workspace;
		return folder;
	}

	// #endregion

	// #region cleanup

	private cleanup(): void {
		this.pruneDestroyedBalls();

		for (let index = this.liveBalls.size() - 1; index >= 0; index--) {
			const ball = this.liveBalls[index];
			// Every ball in this list got a plane when it was spawned, so the fallback is unreachable in
			// practice; it exists so a future caller that pushes without recording cannot crash the pass.
			const killY = this.ballKillY.get(ball) ?? this.deriveKillY(DEFAULT_SPAWNER_RADIUS);
			if (ball.Position.Y < killY) {
				this.destroyBall(ball);
			}
		}

		this.enforceCap();
	}

	/**
	 * Balls can leave `liveBalls` without going through `destroyBall` (a designer, another system, or
	 * `Workspace:ClearAllChildren`), and a destroyed instance still occupies the list. Dropping the
	 * dead entries keeps the oldest-first ordering honest instead of "destroying" things that are
	 * already gone.
	 */
	private pruneDestroyedBalls(): void {
		const surviving = new Array<BasePart>();
		for (const ball of this.liveBalls) {
			if (ball.Parent === undefined) {
				this.ballKillY.delete(ball);
			} else {
				surviving.push(ball);
			}
		}
		this.liveBalls = surviving;
	}

	private enforceCap(): void {
		const cap = this.effectiveMaxLiveBalls();
		while (this.liveBalls.size() > cap) {
			const oldest = this.liveBalls[0];
			// Guard rather than trusting the loop invariant: a cap of 0 (or a list that lost an entry
			// between passes) would otherwise index past the end and destroy `undefined`.
			if (oldest === undefined) {
				break;
			}
			this.destroyBall(oldest);
		}
	}

	/**
	 * A negative `MaxLiveBalls` is clamped to 0 rather than treated as "unlimited": an attribute that
	 * says "keep at most -3 balls" is a mistake, and the safe reading of a mistake in a cap is "spawn
	 * nothing", not "spawn without limit".
	 */
	private effectiveMaxLiveBalls(): number {
		let cap: number | undefined;
		for (const spawner of this.spawners) {
			const value = this.readNumber(spawner, SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE, DEFAULT_MAX_LIVE_BALLS);
			cap = cap === undefined ? value : math.min(cap, value);
		}
		return math.max(cap ?? DEFAULT_MAX_LIVE_BALLS, 0);
	}

	private destroyBall(ball: BasePart): void {
		this.ballKillY.delete(ball);
		const index = this.liveBalls.indexOf(ball);
		if (index !== -1) {
			this.liveBalls.remove(index);
		}
		ball.Destroy();
	}

	// #endregion

	// #region attribute reads

	private isEnabled(spawner: BasePart): boolean {
		const raw = spawner.GetAttribute(SPAWNER_ENABLED_ATTRIBUTE);
		return typeIs(raw, "boolean") ? raw : DEFAULT_SPAWNER_ENABLED;
	}

	private readNumber(part: Instance, attribute: string, fallback: number): number {
		const raw = part.GetAttribute(attribute);
		return typeIs(raw, "number") ? raw : fallback;
	}

	// #endregion
}
