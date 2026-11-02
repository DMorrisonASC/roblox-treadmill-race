import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import {
	BELT_SPEED_ATTRIBUTE,
	DEFAULT_BELT_SPEED,
	DEFAULT_MAX_LIVE_BALLS,
	SPAWNER_KILL_Y_ATTRIBUTE,
	SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE,
} from "shared/attributes";
import { REMOTES_FOLDER_NAME, SPAWN_BALL_REMOTE_NAME } from "shared/remotes";
import {
	pickPoolEntry,
	poolMaxExtent,
	randomSpawnRotation,
	rotatedHalfHeight,
	ShapePoolEntry,
} from "shared/shape-pool";
import { TAGS } from "shared/tags";
import {
	BALL_BACKSPIN_COOLDOWN,
	BALL_BACKSPIN_ENABLED,
	BALL_BACKSPIN_IMPULSE,
	BALL_TEXTURE_ASSET,
	BALL_TEXTURE_OFFSET_RANGE,
	BALL_TEXTURE_OFFSET_RANGE_V,
} from "shared/tuning";

/**
 * Three-decimal rounding instead of `string.format`: these numbers span `0.001`-scale local offsets
 * to `500`-scale kill planes, and a fixed decimal count either hides the small ones or pads the
 * large ones. Three decimals keeps `0.05` readable and rounds float noise like `0.5000000001` to
 * `0.5`, which is what makes two log lines comparable by eye.
 */
function formatNumber(value: number): string {
	return tostring(math.round(value * 1000) / 1000);
}

/** A `Vector3` as `(x, y, z)` on one line, so a vector stays greppable instead of wrapping. */
function formatVector(value: Vector3): string {
	return `(${formatNumber(value.X)}, ${formatNumber(value.Y)}, ${formatNumber(value.Z)})`;
}

/** Every `NormalId`, in enum order. Used to paint all six faces of a spawned body. */
const TEXTURE_FACES: ReadonlyArray<Enum.NormalId> = [
	Enum.NormalId.Right,
	Enum.NormalId.Top,
	Enum.NormalId.Back,
	Enum.NormalId.Left,
	Enum.NormalId.Bottom,
	Enum.NormalId.Front,
];

/**
 * TEMPORARY INSTRUMENTATION. How many spawned bodies log their texture creation.
 *
 * Bodies spawn continuously at `Rate` per second, six textures each; logging all of them would bury
 * the belt lines that are the actual subject of this round. Three is the smallest count that can show
 * a repeat (so "deterministic failure" and "first-one-only failure" are distinguishable) and it
 * covers the first run of the stream. Failures past this cap still warn — see `attachBallTexture`.
 */
const BALL_TEXTURE_LOG_LIMIT = 3;

/**
 * **Placeholder.** Pole marker diameter as a fraction of the ball's radius.
 *
 * Arithmetic: a ball of radius 0.5 gets a marker `0.5 × 0.3 = 0.15` studs across, centred on the
 * surface so half of it protrudes — a 0.075-stud bump. Small enough not to read as a different object,
 * large enough to see at a normal camera distance. Larger (0.5) would make the ball look like a
 * sputnik; much smaller and it disappears against the ball's own silhouette at the far end of the belt.
 */
const MARKER_POLE_SIZE_FRACTION = 0.3;

/**
 * **Placeholder.** Thickness of the equatorial ring along its own axis, in studs.
 *
 * This is the `Size.X` of the `Cylinder` part, i.e. the axis length — see `attachBallMarkers` for why
 * a cylinder's size axes are not the intuitive ones. 0.1 studs is a flat band: thick enough to have
 * a visible edge as it turns, thin enough that it never reads as a second ball.
 */
const MARKER_RING_THICKNESS = 0.1;

/**
 * **Placeholder.** Ring diameter as a multiple of the ball's diameter.
 *
 * 2.1 × radius is 1.05× the ball's diameter for the placeholder 0.5 radius, so the band clears the
 * surface by 0.025 studs all round. Slightly over 1 so the ring is never swallowed by z-fighting with
 * the ball's own surface; much higher and it looks like a hula hoop rather than a band painted on.
 */
const MARKER_RING_OVERSIZE = 2.1;

/** **Placeholder.** Pole marker colour. High-contrast red against a grey-ish plastic ball. */
const MARKER_POLE_COLOR = Color3.fromRGB(255, 80, 80);

/** **Placeholder.** Equatorial ring colour, deliberately a different hue from the poles. */
const MARKER_RING_COLOR = Color3.fromRGB(80, 80, 255);

/**
 * Half of a body's largest dimension, used only as the "how close is another body" radius.
 *
 * This is not the object's true radius and does not claim to be: the only consumer is the diagnostic
 * occupancy count, which asks a deliberately crude "is something in this lane" question. Using the
 * largest extent means a long body reports a lane wider than its real cross-section, which errs
 * toward counting a neighbour — the direction that makes a stacking problem visible rather than
 * hiding it.
 */
function laneRadius(size: Vector3): number {
	return math.max(size.X, size.Y, size.Z) / 2;
}

/** **Placeholder** minimum time between accepted manual spawns, per player, in milliseconds. */
const MANUAL_SPAWN_COOLDOWN_MS = 100;

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
 * Consecutive failures before an already-reported spawner error repeats.
 *
 * Was "50 ticks = 5 s" when failures were counted per stream tick. With the stream gone there is one
 * attempt per spawner per Play session, so this counter now only ever reaches 1 and the repeat branch
 * is unreachable in practice — kept because `reportFailure` is shared and a later round that
 * reintroduces timing would otherwise have to reinvent the throttle.
 */
const FAILURE_REMINDER_EVERY = 50;

/**
 * TEMPORARY INSTRUMENTATION — see the docblock on `BallSpawnerService`.
 *
 * How many balls get a full three-line lifecycle in the log. 20 is an analysis budget, not a
 * service limit: three balls is enough to see one ride, one leave, and one possible anomaly at each
 * stage, and twenty is enough to cover a stream's start, its steady state, and the first couple of
 * cap-evictions — with room for a few balls that never report (spawned above the belt, culled
 * early). At `Rate = 2` that is 10 s of stream, which is one Studio run. Above the cap, balls still
 * spawn exactly as before; they are only silent.
 */
const BALL_LOG_LIMIT = 20;

/**
 * TEMPORARY INSTRUMENTATION. How often tracked balls are inspected, in seconds.
 *
 * This is deliberately faster than the 0.5 s cleanup pass, because "first motion" is a one-shot
 * event that must not be missed: at `BeltSpeed = 10` a ball on a 24-stud belt crosses it in 2.4 s,
 * and a 0.5 s sample would quantise the observed pickup time so coarsely that "riding" and
 * "accelerating very slowly" would look identical. 0.1 s matches `STREAM_TICK_SECONDS`, so the
 * observation cost is the same order as spawning, and it is read-only.
 */
const BALL_OBSERVE_SECONDS = 0.1;

/**
 * TEMPORARY INSTRUMENTATION. Cadence of the rolling sample for ball #1, in seconds.
 *
 * 0.5 s is the same cadence as cleanup and belt-length/velocity gives ~5 samples across a 2.4 s
 * traverse, which is enough to distinguish monotonic acceleration (riding) from a velocity that
 * stays near zero while the ball is stationary in world space (sliding), and to spot oscillation.
 * Faster would multiply lines without adding shapes; slower would let a slide look like a ride for
 * the length of the belt.
 */
const BALL_SAMPLE_SECONDS = 0.5;

/**
 * TEMPORARY INSTRUMENTATION. A ball is "in motion" when its velocity magnitude exceeds this
 * fraction of the belt's speed.
 *
 * The derivation the brief asks for: if a ball is riding, friction should bring it to belt speed
 * within roughly one radius of travel, i.e. `Radius / |BeltSpeed|` seconds — 0.05 s at the
 * placeholders (0.5 studs, 10 studs/s). Any threshold below full belt speed and above
 * solver/settling noise therefore counts as "it moved", so 10% of belt speed is generous enough to
 * fire on the first observation after contact without firing on sub-stud/s jitter.
 */
const FIRST_MOTION_BELT_SPEED_FRACTION = 0.1;

/**
 * TEMPORARY INSTRUMENTATION. Absolute floor for the first-motion threshold, in studs/second.
 *
 * Without it, `BeltSpeed = 0` would set the threshold to 0 and every ball would report "motion" the
 * instant gravity gave it any velocity at all, which is a different event from being dragged. 0.5
 * studs/s is well below the placeholders' 1 stud/s threshold and well above physics jitter.
 */
const FIRST_MOTION_FLOOR_STUDS_PER_SECOND = 0.5;

/**
 * TEMPORARY INSTRUMENTATION. Extra radius, in studs, added to one ball diameter when deciding
 * whether another ball is "in the spawn lane".
 *
 * `2 * Radius` is the touching distance between two ball centres, so a count taken at exactly that
 * distance would miss a pair that is one solver step apart. 0.25 studs is half the placeholder
 * radius: large enough that a ball still falling through the spawn point registers, small enough
 * that a ball already resting on the belt below the spawner (`2.05` studs away vertically in the
 * observed scene) does not. The value is a `Placeholder`, and the log prints the actual threshold so
 * a run cannot be misread against a different radius.
 */
const OCCUPANCY_MARGIN_STUDS = 0.25;

/**
 * TEMPORARY INSTRUMENTATION. Per-ball state for the three-line lifecycle.
 *
 * `belt` is resolved once, at spawn, and named in the spawn line: a ball is measured against exactly
 * one belt, so a scene with two belts can never silently attribute a departure to the wrong one. If
 * the resolved belt is destroyed mid-flight the observation is abandoned rather than re-resolved,
 * because re-resolving would move the reference frame halfway through a measurement.
 */
interface BallObservation {
	id: number;
	spawnedAt: number;
	spawnPosition: Vector3;
	belt: BasePart | undefined;
	firstMotionLogged: boolean;
	leaveLogged: boolean;
	anomalyReported: boolean;
	/** TEMPORARY INSTRUMENTATION. `Touched` events seen since spawn; reported once, at first motion. */
	touchedCount: number;
	touchedConnection: RBXScriptConnection | undefined;
}

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
 * ## TEMPORARY INSTRUMENTATION — read before touching
 *
 * Added by the "why do balls stack, and why do some never recover belt speed?" diagnostic prompt.
 * This is the second such round; the first ("why do balls leave the belt, and from which end?")
 * established that some balls ride at `BeltSpeed` and some slide backward off the `-RightVector`
 * edge, and left five questions the first log could not answer:
 *
 *  1. **Ownership.** Is each ball `server`-owned or client-owned at spawn, at first motion, and at
 *     leave? A client-owned ball that never receives the belt's `NotReplicated` surface velocity
 *     would be simulated resting on a stationary surface, which would explain a ball that never
 *     recovers belt speed after a backward kick.
 *  2. **Lane occupancy.** At the moment of each spawn, is another `Ball` already within
 *     `2 * Radius + OCCUPANCY_MARGIN_STUDS` of the spawn point? If every wave spawns into a lane
 *     whose previous ball has not cleared, the waves collide by construction.
 *  3. **Spawner phase.** Do the bound spawners share one accumulator or hold one each? A shared
 *     accumulator would be a bug; independent accumulators fed identical `dt` stay in perfect
 *     lockstep by arithmetic alone.
 *  4. **Cap destruction.** When `MaxLiveBalls` destroys a ball, was that ball still over the belt
 *     footprint? A ball destroyed while riding means the game's "elimination" is the cap, not
 *     physics.
 *  5. **The collision.** How many `Touched` events does each ball see in its first second? One
 *     integer per ball, reported once, to confirm or refute a stacking-driven momentum split.
 *
 * Round 2 also turned up a measurement worth stating up front, because it reframes the hypothesis:
 * from the round-1 log, a ball falling from spawn covers 2.045 studs in 1.459 s, where free fall takes
 * 0.144 s, and its velocity at first motion is 10–14% of what free fall predicts. The balls are not
 * "asleep for half a second and then falling normally" — they are being stepped at roughly a tenth of
 * real time throughout. Whatever the fix is, spawn clearance alone would leave a ball still hanging in
 * the air, so the `touches` count and the sample series matter as much as the occupancy count.
 *
 * Nothing here changes behaviour. Balls are created with the same size, material, position, and
 * zero initial velocity as before; no `SetNetworkOwner`, no `WakeUp`, no velocity write, no change to
 * `Rate`, spawn height, friction, or cap. The instrumentation only reads, plus one `Touched`
 * connection per logged ball that it disconnects as soon as the count is reported.
 *
 * ## The one boundary this crosses, and why it is acceptable here
 *
 * This service is documented as knowing nothing about the treadmill. The leave detection breaks that
 * on purpose: "which side of the belt did it leave" cannot be answered without a belt's `CFrame` and
 * `Size`, so `resolveBeltFor` looks up tagged `TreadmillBelt` parts read-only. The alternative —
 * putting the measurement in `TreadmillService` — would make the belt know about balls instead, and
 * would split one ball's three-line lifecycle across two files with two id schemes. The belt is named
 * in every spawn line, so the coupling is visible in the log rather than hidden, and it disappears
 * with the instrumentation.
 *
 * ## Log shapes
 *
 * `[Spawner]` for service-level lines, `[Ball:<id>]` for a ball's lifecycle. Three lifecycle lines
 * per ball at most — spawn, first motion, leave — plus at most one anomaly `warn` (a ball that goes
 * below the belt without ever crossing an edge). The rolling sample is a fourth line but only for
 * ball #1, and only every `BALL_SAMPLE_SECONDS`. `warn` is reserved for genuine anomalies; a clean
 * run with one belt and one spawner should print none.
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
	private readonly lastManualSpawnAt = new Map<Player, number>();

	/** Spawn order, oldest first — the order the cap evicts in. */
	private liveBalls = new Array<BasePart>();
	private readonly ballKillY = new Map<BasePart, number>();

	/**
	 * Backspin bookkeeping, one entry per live ball.
	 *
	 * `backspinConnections` exists because `Touched` connections on a destroyed part do not need to be
	 * explicitly disconnected for the *handler* to stop firing — a destroyed instance fires nothing — but
	 * holding the connection object in a map would leak one entry per ball forever if nothing removed it,
	 * and a destroyed `RBXScriptConnection` is cheap to disconnect but not free to keep. Both maps are
	 * cleared in the two places a ball can die, so their size tracks the live set.
	 *
	 * `lastBackspinAt` is the cooldown clock, per ball rather than global: a global clock would let one
	 * ball's collision suppress another ball's, which would make the variety depend on which lane
	 * happened to be touched first.
	 */
	private readonly backspinConnections = new Map<BasePart, RBXScriptConnection>();
	private readonly lastBackspinAt = new Map<BasePart, number>();

	/** TEMPORARY INSTRUMENTATION. Bodies whose texture creation has logged; see `BALL_TEXTURE_LOG_LIMIT`. */
	private ballTextureLogs = 0;
	/** Stable ids so two Ctrl+D clones, which share a name and a `GetFullName()`, stay distinguishable. */
	private readonly spawnerIds = new Map<BasePart, number>();
	private nextSpawnerId = 0;
	private readonly spawnerFailures = new Map<BasePart, SpawnerFailure>();

	/** TEMPORARY INSTRUMENTATION. Tracked balls, keyed by instance, capped by `BALL_LOG_LIMIT`. */
	private readonly observedBalls = new Map<BasePart, BallObservation>();
	private nextBallLogId = 0;
	/** TEMPORARY INSTRUMENTATION. The ball the rolling sample follows: always the first one logged. */
	private sampleBall?: BasePart;
	private lastSampleAt = 0;

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

		// TEMPORARY INSTRUMENTATION. Separate from the cleanup loop because observation must run at
		// `BALL_OBSERVE_SECONDS`, not at cleanup's 0.5 s — see the constant's comment. Read-only, so
		// the two loops cannot interfere.
		task.spawn(() => {
			this.lastSampleAt = os.clock();
			while (true) {
				this.observeBalls();
				task.wait(BALL_OBSERVE_SECONDS);
			}
		});

		// Last, so every tagged spawner is already bound. This is the only automatic spawn in the
		// service; see `spawnOnePerSpawner` for why the timed stream was removed.
		this.spawnOnePerSpawner("one-shot");
	}

	// #region binding

	private bindSpawner(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			warn(`[Spawner] ${instance.GetFullName()} is tagged ${TAGS.ballSpawner} but is not a BasePart; ignoring.`);
			return;
		}

		if (this.spawners.has(instance)) {
			return;
		}

		// Derived before anything observes the part, so every later reader — the bind log, the one-shot
		// spawn, the kill plane — sees a part with a complete set of values.
		const derived = this.ensureDerivedAttributes(instance);

		// No attribute listener and no `Enabled`: both retired with the stream. The only automatic spawn
		// is the one-shot at start; every later body comes from the manual path.
		this.spawners.add(instance);

		const id = ++this.nextSpawnerId;
		this.spawnerIds.set(instance, id);

		// Logged with the values `GetAttribute` actually returned, plus whether this service had to
		// supply them. `nil` can no longer appear for these five (they were just filled in), but a
		// wrong-typed value can, and that is the case worth seeing: `Radius = "0.5"` reads as a string
		// and would otherwise be silently replaced by the default with no trace of the mistake.
		const attributes = this.describeAttributes(instance);
		print(
			`[Spawner] bound #${id} ${instance.GetFullName()} (${instance.ClassName}) tag=${TAGS.ballSpawner} derived=${derived.size() === 0 ? "none" : derived.join(",")} ${attributes.summary}`,
		);

		// Separate line, and a warning rather than a print, so a malformed spawner is findable in Output
		// without reading every bind line. It is not fatal: the default applies and this spawner still
		// produces its one body.
		if (attributes.problems !== "") {
			warn(`[Spawner] #${id} ${instance.GetFullName()} attribute check: ${attributes.problems}`);
		}
	}

	private unbindSpawner(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		// Logged before the id is dropped, so the line names the same spawner the bind line named.
		print(`[Spawner] unbound ${this.labelFor(instance)}: tag removed or instance destroyed.`);

		this.spawners.delete(instance);
		this.spawnerIds.delete(instance);
		this.spawnerFailures.delete(instance);
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
		//
		// **Every bound spawner fires, one ball each.** This is a reversal: the previous rule spawned
		// from the first registered spawner only, on the grounds that one ball from a known place kept
		// a multi-spawner test predictable. That reasoning did not survive the fixture it was written
		// for — with four spawners across four lanes, "one ball from the first one" meant three lanes
		// never received a manual ball at all, so the key could not be used to test the belt's full
		// width or what happens when two bodies meet. The predictability it bought was the
		// predictability of only ever seeing a quarter of the scene.
		//
		// The loop itself lives in `spawnOnePerSpawner` and is shared with the one-shot start spawn, so
		// "how many bodies does a trigger produce" is decided in exactly one place.
		if (this.spawners.size() === 0) {
			warn(`[Spawner] manual spawn requested but no part is tagged ${TAGS.ballSpawner}.`);
			return;
		}

		this.spawnOnePerSpawner("manual");
	}

	// #endregion

	// #region one-shot spawn

	/**
	 * Spawns exactly one body per bound spawner.
	 *
	 * **Two callers, one implementation, on purpose.** `onStart` calls it once with `"one-shot"`, and
	 * the manual `1` trigger calls it with `"manual"`. The manual path previously had its own copy of
	 * this loop spawning from the first registered spawner only; keeping two loops meant the rule "how
	 * many bodies does a trigger produce" was written down twice and could drift. The `reason` argument
	 * exists so the single summary line stays truthful about which trigger fired — passing nothing would
	 * have produced a log that said "one-shot" on every keypress.
	 *
	 * ## Why the automatic spawn is one shot and not a stream
	 *
	 * The previous revision started a timed stream at `Rate` per second because tagging a part should
	 * visibly do something. That produced eight bodies a second across four spawners against a cap of
	 * 50: a permanent mosh pit in four lanes, where body-to-body collisions and the 1 s bounce cooldown
	 * interrupted any rolling every ~150 ms. Any observation about whether a body rolls or slides was
	 * being taken inside that pit, so the fixture was preventing the measurement it existed for.
	 *
	 * The user's actual game is one body per round. One body per spawner, spawned once, is the smallest
	 * scene that can answer the question: a single body on the belt, nothing to collide with, nothing
	 * to interrupt rolling. Additional bodies are still one keypress away via the manual path, which is
	 * deliberate — collision testing needs a second body, and it should not require a code change.
	 *
	 * ## Why the automatic one runs here and not on a tag signal
	 *
	 * `onStart` has already bound every spawner from `GetTagged`, so `this.spawners` is complete. A tag
	 * added *after* start does not get an automatic body: this is one spawn per Play session per
	 * spawner, and a spawner that arrives late is a scene edit, not a new session. That keeps the rule
	 * "one body per spawner" true and makes the manual path the explicit way to add more.
	 *
	 * ## Failure containment
	 *
	 * Each spawn is individually protected, for the same reason the old stream tick was: one malformed
	 * spawner must not prevent the others from producing their body. The failure is logged against the
	 * spawner that caused it. This matters more for the manual path than for the one-shot, because a
	 * keypress that silently produced three of four bodies would look like flaky physics.
	 */
	private spawnOnePerSpawner(reason: "one-shot" | "manual"): void {
		let spawned = 0;

		for (const spawner of this.spawners) {
			const failure = this.runProtected(() => {
				if (this.spawnBall(spawner) !== undefined) {
					spawned++;
				}
			});

			if (failure !== undefined) {
				this.reportFailure(spawner, failure);
			} else {
				this.reportRecovery(spawner);
			}
		}

		// One line, always, so "did the trigger fire and how many bodies did it produce" is answerable
		// without counting spawn lines. `bound` is printed alongside `spawned` because the interesting
		// failure is the two disagreeing.
		print(
			`[Spawner] ${reason} spawn: bound=${this.spawners.size()} spawned=${spawned} cap=${this.effectiveMaxLiveBalls()}`,
		);
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
				`[Spawner] ${this.labelFor(spawner)} failed to spawn: ${message}. Streaming continues for every other spawner.`,
			);
		} else if (count % FAILURE_REMINDER_EVERY === 0) {
			warn(
				`[Spawner] ${this.labelFor(spawner)} still failing (${count} consecutive ticks): ${message}. Streaming continues.`,
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
			`[Spawner] ${this.labelFor(spawner)} recovered after ${previous.count} failed tick(s): ${previous.message}`,
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
	 * while they were still visibly falling.
	 *
	 * The gap used to be one ball diameter, computed from the retired `Radius` attribute. Now that the
	 * spawner chooses shapes, the honest question is "one body-size above the floor for *which* body",
	 * and the answer has to cover the largest one the pool can produce — hence `poolMaxExtent()`. Using
	 * the smallest (a 1×1×1 corner wedge) would put the plane closer to the floor than a 1×1×2 cylinder
	 * needs, and the cylinder could be culled by the engine a moment before this service reclaimed its
	 * slot, which is exactly the race this derivation exists to avoid.
	 */
	private deriveKillY(): number {
		return Workspace.FallenPartsDestroyHeight + poolMaxExtent();
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

		// `Enabled`, `Rate` and `Radius` are no longer derived — see the note in `shared/attributes.ts`.
		// Shape and size come from the pool in `shared/shape-pool.ts`, and there is no timer left for a
		// rate to describe, so the two remaining spawner attributes are the cap and the kill plane.
		ensureNumber(SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE, DEFAULT_MAX_LIVE_BALLS);
		ensureNumber(SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY());

		return derived;
	}

	/**
	 * Raw attribute readings next to the effective values, for the bind log.
	 *
	 * Runs after `ensureDerivedAttributes`, so absence is no longer expected here; what remains worth
	 * reporting is a *present but wrong-typed* value. `Rate = "2"` is always a mistake and the reader
	 * will quietly fall back, so the fallback is named in the log rather than left to be discovered by
	 * watching the spawn rate come out wrong.
	 *
	 * `Radius` is absent from this list on purpose: it is retired, not merely unread. Listing a
	 * retired attribute would suggest it still does something.
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

		describeNumber(SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE, DEFAULT_MAX_LIVE_BALLS);
		describeNumber(SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY());

		return { summary: fields.join(", "), problems: problems.join("; ") };
	}

	// #endregion

	// #region spawning

	private spawnBall(spawner: BasePart): BasePart | undefined {
		if (spawner.Parent === undefined) {
			return undefined;
		}

		// Shape, size and orientation are all decided here and nowhere else. The pool entry decides what
		// the object *can* do; the rotation decides which of those it does this spawn, which is the
		// whole point of the pool — a sphere is invariant under rotation, a cylinder is not. Anything
		// below this block is identical for every shape.
		const entry = pickPoolEntry();
		const rotation = randomSpawnRotation();
		const halfY = rotatedHalfHeight(rotation, entry.size);

		const ball = new Instance("Part");
		ball.Name = "Ball";
		ball.Shape = entry.shape;
		ball.Size = entry.size;
		ball.Anchored = false;
		ball.CanCollide = true;
		// Default material rather than CustomPhysicalProperties: every body is the same material, so
		// density is uniform and mass follows only from shape and volume. Writing explicit physical
		// properties would add a tuning knob that nothing in this slice turns, and would have to be kept
		// in sync with the belt's friction to mean anything. If belt drag ever proves too weak, friction
		// is the knob to reach for — on the belt, not on the object.
		ball.Material = Enum.Material.Plastic;
		ball.TopSurface = Enum.SurfaceType.Smooth;
		ball.BottomSurface = Enum.SurfaceType.Smooth;

		// `fromMatrix` rather than `CFrame.Angles` composition: `randomSpawnRotation` already returned the
		// images of the world X and Y axes, so passing them as the basis vectors is exact — no matrix
		// multiply, and no assumption about the order in which `CFrame` composes rotations. The position
		// is raised by the *rotated* half-height (not `Size.Y / 2`) so the lowest corner of a tumbled
		// shape clears the belt; see `rotatedHalfHeight`.
		ball.CFrame = CFrame.fromMatrix(
			spawner.Position.add(new Vector3(0, halfY + BALL_SPAWN_CLEARANCE_STUDS, 0)),
			rotation.right,
			rotation.up,
		);

		// Visual only, and attached *before* `Parent`: children added to an already-parented part are
		// replicated as a stream of separate child-creation events, whereas a part parented with its
		// textures already in place arrives at clients as one tree. Six textures per body makes that
		// difference worth caring about at stream rates.
		this.attachBallTexture(ball, entry);

		ball.Parent = this.ballsFolder();

		// Tagged at birth: cleanup counts tagged balls, and a later slice enumerates them. Tagging is
		// the cheap half of that contract — without it, "how many balls are live" degrades into
		// "how many entries are in an array this service happens to remember".
		CollectionService.AddTag(ball, TAGS.ball);

		// Visual only, and attached *after* `Parent` — unlike the textures above. The reason is the weld:
		// a `WeldConstraint` couples two parts, and both must already be in the DataModel when it is
		// created, or the constraint has nothing to act on. Parenting the ball first guarantees that.
		// The cost is that the three markers replicate as separate child-creation events rather than
		// arriving with the ball; at three parts per spawn that is acceptable, and correctness wins.
		this.attachBallMarkers(ball, entry);

		// Backspin-on-collision. After the markers so the marker welds exist first (they are visual only
		// and non-colliding, so order does not affect them), and after `Parent` so the ball is in the
		// DataModel when its `Touched` connection is made.
		this.attachBackspin(ball);

		// TEMPORARY INSTRUMENTATION. Before `liveBalls.push`, so the spawn line always precedes any
		// observation of this ball; the observation loop only ever sees balls that already logged.
		this.beginBallObservation(ball, spawner, entry);

		this.liveBalls.push(ball);
		this.ballKillY.set(ball, this.readNumber(spawner, SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY()));
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

	// #region backspin on collision

	/**
	 * Adds angular velocity to a ball when another ball strikes it, producing occasional backspin.
	 *
	 * ## Why this is triggered by a collision and not by spawn
	 *
	 * A spawn-time spin would be the code choosing an outcome: every ball would get the same treatment,
	 * every round would look the same, and the player could not learn anything from it. A collision is
	 * the honest source — one fruit physically knocking another off-centre genuinely converts linear
	 * momentum into angular momentum, and **which** balls get struck is decided by where the bodies
	 * happen to meet. A ball alone in its lane is never struck and simply rides at equilibrium; a ball in
	 * a busy lane may be struck repeatedly. That spread is the variety, and it is a consequence of the
	 * scene, not of a random number in this file.
	 *
	 * ## Why the impulse lands only on the ball running this handler
	 *
	 * `Touched` fires on *both* parts of a contact, so a collision between A and B runs A's handler with
	 * B as the argument and B's handler with A. Applying the impulse to `self` in each means both balls
	 * receive exactly one impulse per collision — symmetric, as physics wants — without the double-count
	 * that applying to both here would create.
	 *
	 * ## Cleanup
	 *
	 * The connection is stored in `backspinConnections` and disconnected in `destroyBall` and
	 * `pruneDestroyedBalls`, so nothing outlives the ball. Strictly, a destroyed instance stops raising
	 * `Touched` whether or not the connection is disconnected, but leaving the connection object in the
	 * map would leak one entry per ball for the whole session — see the field's comment.
	 */
	private attachBackspin(ball: BasePart): void {
		// Gated at attach rather than inside the handler: with the feature off there is no reason to hold
		// a connection per ball at all, and the check is paid once per spawn instead of once per contact.
		// The emitted Luau keeps this as a real `if` — roblox-ts does not fold the constant away — but a
		// per-spawn branch against a boolean is not worth avoiding, and putting the gate here rather than
		// in the handler means a disabled feature costs zero connections and zero handler invocations.
		if (!BALL_BACKSPIN_ENABLED) {
			return;
		}

		const connection = ball.Touched.Connect((other) => this.applyBackspin(ball, other));
		this.backspinConnections.set(ball, connection);
	}

	private applyBackspin(ball: BasePart, other: BasePart): void {
		// Another ball, or nothing. The slab, the belt, the welded markers, players and the wedge all
		// reach this handler and must not spin the ball.
		if (!other.HasTag(TAGS.ball)) {
			return;
		}

		// A ball wedged against another re-fires `Touched` on essentially every physics step; without the
		// cooldown the impulse would accumulate at ~60/s instead of once per collision.
		const now = os.clock();
		const last = this.lastBackspinAt.get(ball);
		if (last !== undefined && now - last < BALL_BACKSPIN_COOLDOWN) {
			return;
		}

		const belt = this.nearestBeltTo(ball.Position);
		if (belt === undefined) {
			// No belt means no meaningful rolling axis, and no surface whose speed the slip can be measured
			// against. Skipping is better than guessing an axis from world X, which would be wrong for any
			// rotated belt.
			return;
		}

		// **The rolling axis, derived rather than assumed.** `RightVector` is the belt's travel direction
		// and `yAxis` is up; their cross product is horizontal and perpendicular to travel, which is
		// exactly the axis a body rolling along the belt turns about. For the observed belt
		// (`RightVector = (1, 0, 0)`) that is `(0, 0, 1)` — **`+Z`**, not `-Z`.
		//
		// The sign question is not "does the ball spin forward or backward", it is "which sign makes the
		// contact point move faster than the belt". The contact point's velocity is `v + w*r` along
		// `RightVector`, so **adding** angular velocity along `+Z` increases it. At rolling equilibrium the
		// contact point already moves at belt speed, so any increase puts it *ahead* of the belt and
		// reverses friction. `+Z` is therefore the backspin direction, and it is what `Cross` returns.
		//
		// `.Unit` because a tilted belt's `RightVector` is not perpendicular to world up, so the raw cross
		// product would not be unit length; the magnitude guard catches the degenerate case of a belt stood
		// on its end, where the axis is undefined.
		const axisRaw = belt.CFrame.RightVector.Cross(Vector3.yAxis);
		if (axisRaw.Magnitude < 1e-3) {
			return;
		}
		const axis = axisRaw.Unit;

		const radius = ball.Size.Y / 2;
		ball.AssemblyAngularVelocity = ball.AssemblyAngularVelocity.add(axis.mul(BALL_BACKSPIN_IMPULSE));

		this.lastBackspinAt.set(ball, now);

		// One line per impulse, and the only diagnostic in this feature. It exists to settle the one thing
		// source cannot: whether `+Z` really is the direction that produces backspin in this engine. The
		// sign of `slip` answers it — positive means the contact point is moving faster than the belt, so
		// friction is pushing the ball backward, which is the mechanic working. Negative means the impulse
		// sped the ball up instead and the sign needs inverting.
		const beltSpeed = this.readNumber(belt, BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED);
		const alongRight = ball.AssemblyLinearVelocity.Dot(belt.CFrame.RightVector);
		const omega = ball.AssemblyAngularVelocity.Dot(axis);
		const slip = alongRight + omega * radius - beltSpeed;

		print(
			`[Ball] backspin impulse: dOmega=${formatNumber(BALL_BACKSPIN_IMPULSE)} r=${formatNumber(radius)} v=${formatNumber(alongRight)} omegaR=${formatNumber(omega * radius)} u=${formatNumber(beltSpeed)} slip=${formatNumber(slip)} ${slip > 0 ? "contact faster than belt -> friction pushes BACKWARD" : "contact slower than belt -> friction pushes FORWARD (sign inverted)"}`,
		);
	}

	// #endregion

	// #region cleanup

	private cleanup(): void {
		this.pruneDestroyedBalls();

		for (let index = this.liveBalls.size() - 1; index >= 0; index--) {
			const ball = this.liveBalls[index];
			// Every ball in this list got a plane when it was spawned, so the fallback is unreachable in
			// practice; it exists so a future caller that pushes without recording cannot crash the pass.
			const killY = this.ballKillY.get(ball) ?? this.deriveKillY();
			if (ball.Position.Y < killY) {
				this.destroyBall(ball, "killY");
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
				this.releaseBackspin(ball);
			} else {
				surviving.push(ball);
			}
		}
		this.liveBalls = surviving;
	}

	/**
	 * Drops the backspin connection and its cooldown clock for one ball.
	 *
	 * Called from both death paths. `Touched` on a destroyed instance stops firing on its own, so this is
	 * not what keeps the handler from running — it is what keeps the two maps from growing by one entry
	 * per ball for the lifetime of the server session.
	 */
	private releaseBackspin(ball: BasePart): void {
		this.backspinConnections.get(ball)?.Disconnect();
		this.backspinConnections.delete(ball);
		this.lastBackspinAt.delete(ball);
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
			this.destroyBall(oldest, "cap");
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

	private destroyBall(ball: BasePart, reason: "cap" | "killY"): void {
		// TEMPORARY INSTRUMENTATION. Only cap destructions are logged: a kill-plane cull is the
		// documented, intended end of a ball's life and says nothing about the mechanic, while a cap
		// eviction is exactly the "elimination is not physics" suspicion this round exists to test.
		// The height/footprint question is answered before `Destroy()`, after which position reads 0,0,0
		// and the answer is gone.
		if (reason === "cap") {
			this.reportCapDestruction(ball);
		}

		// TEMPORARY INSTRUMENTATION. A destroyed ball can never report again, so its connection must not
		// outlive it — especially for the unlogged balls that never reach first motion.
		const observation = this.observedBalls.get(ball);
		observation?.touchedConnection?.Disconnect();
		this.observedBalls.delete(ball);
		if (this.sampleBall === ball) {
			this.sampleBall = undefined;
		}

		this.ballKillY.delete(ball);
		this.releaseBackspin(ball);
		const index = this.liveBalls.indexOf(ball);
		if (index !== -1) {
			this.liveBalls.remove(index);
		}
		ball.Destroy();
	}

	/**
	 * TEMPORARY INSTRUMENTATION. Reports where a cap-evicted ball was when it died.
	 *
	 * The footprint test is the same belt-local one used for leaving: `PointToObjectSpace` against the
	 * belt's `CFrame`, because the belt can be rotated and a world-axis comparison would name the wrong
	 * axes. Y is deliberately *excluded* from "inside the footprint" — a ball above the belt but within
	 * its X/Z extent is still a ball the belt should eventually have carried, and including Y would
	 * report "outside" for a ball in the air over the belt, which is the case most worth catching. The
	 * height is reported separately as `aboveSurface` so the vertical position is not lost to that
	 * choice.
	 */
	private reportCapDestruction(ball: BasePart): void {
		const observation = this.observedBalls.get(ball);
		const id = observation === undefined ? "unlogged" : `#${observation.id}`;
		const belt = observation === undefined ? this.nearestBeltTo(ball.Position) : observation.belt;

		if (belt === undefined || belt.Parent === undefined) {
			print(`[Ball:${id}] cap destroy pos=${formatVector(ball.Position)} no belt resolvable, footprint unknown`);
			return;
		}

		const relative = belt.CFrame.PointToObjectSpace(ball.Position);
		const halfX = belt.Size.X / 2;
		const halfZ = belt.Size.Z / 2;
		const halfY = belt.Size.Y / 2;
		const inside = math.abs(relative.X) <= halfX && math.abs(relative.Z) <= halfZ;

		print(
			`[Ball:${id}] cap destroy at pos=${formatVector(ball.Position)} local=${formatVector(relative)} aboveSurface=${formatNumber(relative.Y - halfY)} insideFootprint=${inside ? "yes" : "no"} velocity=${formatVector(ball.AssemblyLinearVelocity)} alongRight=${formatNumber(ball.AssemblyLinearVelocity.Dot(belt.CFrame.RightVector))} BeltSpeed=${formatNumber(this.readNumber(belt, BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED))} ${this.describeOwner(ball)}`,
		);
	}

	// #endregion

	// #region ball diagnostics (TEMPORARY INSTRUMENTATION)

	/**
	 * Records the spawn line and starts tracking the ball, unless the log budget is spent.
	 *
	 * The cap is checked on the *counter*, not on the live set: a ball that has already been culled
	 * must not free a slot, or a long run would slowly log the whole stream and the cap would be
	 * meaningless. Balls past the cap are not tracked at all, which also keeps the per-tick
	 * observation cost proportional to `BALL_LOG_LIMIT` rather than to `MaxLiveBalls`.
	 */
	private beginBallObservation(ball: BasePart, spawner: BasePart, entry: ShapePoolEntry): void {
		if (this.nextBallLogId >= BALL_LOG_LIMIT) {
			return;
		}

		const id = ++this.nextBallLogId;
		const belt = this.resolveBeltFor(spawner);
		const occupancy = this.countLaneOccupants(ball, ball.Position, laneRadius(entry.size));

		const observation: BallObservation = {
			id,
			spawnedAt: os.clock(),
			spawnPosition: ball.Position,
			belt,
			firstMotionLogged: false,
			leaveLogged: false,
			anomalyReported: false,
			touchedCount: 0,
			touchedConnection: undefined,
		};

		// Counted from spawn rather than "during the first second" verbatim: first motion arrives
		// between 0.1 s and 0.5 s in the observed scene, so "touches before first motion" is a strict
		// subset of the first second and is the window that actually matters for the momentum-split
		// story. The connection is dropped at first motion so a ball that later piles up against others
		// cannot accumulate a meaningless count, and so nothing outlives the measurement.
		observation.touchedConnection = ball.Touched.Connect(() => {
			observation.touchedCount++;
		});

		this.observedBalls.set(ball, observation);

		if (id === 1) {
			this.sampleBall = ball;
		}

		// `mass` is `AssemblyMass`, which is the readable mass of the body's own assembly (a lone
		// unanchored part, so it is the part's mass). It is logged because mass follows from shape and
		// volume at a uniform density, so the number confirms the pool entry produced the body it says
		// it did — and "did the belt fail to move a heavy body" is otherwise unanswerable after the fact.
		//
		// `shape`/`size` are logged because the pool is uniform-random: without them, `Ball:7` is an
		// anonymous id and the reader cannot tell a cylinder from a corner wedge. `quat` is the four
		// components of the sampled rotation, so "is the orientation actually being applied and actually
		// varying" is answerable by comparing two lines instead of by trusting the sampler.
		//
		// `occupants` is read *after* this ball was parented and tagged, minus itself, so a
		// same-tick pair reports 1 on the second ball. `laneRadius` is printed so the occupancy threshold
		// (`2 * laneRadius + OCCUPANCY_MARGIN_STUDS`) can be reconstructed from the line itself.
		print(
			`[Ball:${id}] spawn shape=${entry.shape.Name} size=${formatVector(entry.size)} pos=${formatVector(ball.Position)} mass=${formatNumber(ball.AssemblyMass)} ${this.describeOwner(ball)} occupants=${occupancy.count} nearest=${occupancy.nearest} laneRadius=${formatNumber(laneRadius(entry.size))} belt=${belt === undefined ? "none" : `"${belt.GetFullName()}"`} spawner="${spawner.GetFullName()}"`,
		);
	}

	/**
	 * Six `Texture` instances, one per `NormalId`, so the whole surface is painted.
	 *
	 * A `Texture` covers exactly one `Face`, so "all sides" on a primitive part is six instances and
	 * cannot be done with one. The alternative — a single texture and accept partial coverage — would
	 * leave four fifths of every body bare, which reads as a rendering bug. Six instances per body
	 * against a live cap of 50 is 300 extra instances, all created once and never touched again; that
	 * is cheap relative to what a custom mesh (the only single-object alternative) would cost.
	 *
	 * Applied to every shape in the pool, not just spheres. The faces of a cylinder, block or corner
	 * wedge are the same six `NormalId` faces, so the same loop covers them; a texture on the "wrong"
	 * face of a corner wedge is simply a texture on a sliver, which is what painting a sliver looks
	 * like.
	 *
	 * ## TEMPORARY INSTRUMENTATION — "why is there no Texture child?" round
	 *
	 * Same question as the belt, so the same treatment, but capped: bodies spawn continuously and
	 * logging six textures each would bury the belt lines this round is really about. The **first
	 * `BALL_TEXTURE_LOG_LIMIT` bodies after server start** log their creation; every later body runs
	 * the identical code silently. Three is enough to show one success or one throw and to reveal
	 * whether the failure is deterministic or intermittent, which is the only thing the count needs to
	 * establish.
	 *
	 * Failures are counted separately from successes: if the first three bodies succeed but body 40
	 * threw, nothing would say so. The counter therefore advances on every *attempt* and the error path
	 * warns unconditionally — a texture failure is never silent, only its success is rare.
	 */
	private attachBallTexture(ball: BasePart, entry: ShapePoolEntry): void {
		const log = this.ballTextureLogs < BALL_TEXTURE_LOG_LIMIT;
		if (log) {
			this.ballTextureLogs++;
			print(
				`[Spawner] texture: start ball="${ball.GetFullName()}" shape=${entry.shape.Name} faces=${TEXTURE_FACES.size()} asset=${BALL_TEXTURE_ASSET} parentBefore=${ball.Parent === undefined ? "none" : "unexpected"}`,
			);
		}

		const [ok, err] = xpcall(
			() => this.createBallTextures(ball, entry, log),
			(e) => `${typeIs(e, "string") ? e : tostring(e)}\n${debug.traceback("ball texture traceback", 2)}`,
		);

		// Not re-raised. A ball is one of fifty and is created inside a `pcall` in the stream loop, so
		// raising here would cost that spawn its whole tick — the spawn would abort after the body was
		// constructed but before it was registered, leaking an untracked part in Workspace. Logging and
		// continuing leaves the body alive and untextured, which is the honest degradation and keeps the
		// texture defect from masking the spawn path. This differs from the belt deliberately: the belt
		// is one instance whose failure must be loud, a ball is one of many whose failure must not be.
		if (!ok) {
			warn(`[Spawner] texture: FAILED on ball="${ball.GetFullName()}": ${tostring(err)}`);
		}
	}

	private createBallTextures(ball: BasePart, entry: ShapePoolEntry, log: boolean): void {
		const content = Content.fromUri(BALL_TEXTURE_ASSET);

		// One random phase per body, shared by all six faces: the point is that two bodies look
		// different from each other, and deriving a separate phase per face would make a single body
		// look inconsistent with itself as it rolls.
		const offsetU = math.random() * BALL_TEXTURE_OFFSET_RANGE;
		const offsetV = math.random() * BALL_TEXTURE_OFFSET_RANGE_V;

		// Tile size follows the body's own face extent so one texture repeat covers one face; a fixed
		// tile size would stretch on a 1×1×2 cylinder and shrink on a 1×1×1 block.
		const tileU = math.max(entry.size.X, entry.size.Z);
		const tileV = math.max(entry.size.Y, entry.size.Z);

		let created = 0;

		for (const face of TEXTURE_FACES) {
			const texture = new Instance("Texture");
			texture.Name = "Surface";
			texture.Face = face;
			// Both image slots, for the reason spelled out in the treadmill service: a Studio run showed
			// `ColorMapContent` reading back correctly while rendering nothing, so the legacy string is
			// written as well.
			texture.ColorMapContent = content;
			texture.Texture = BALL_TEXTURE_ASSET;
			texture.StudsPerTileU = tileU;
			texture.StudsPerTileV = tileV;
			texture.OffsetStudsU = offsetU;
			texture.OffsetStudsV = offsetV;
			texture.Parent = ball;
			created++;
		}

		if (log) {
			// Read back off the instance rather than trusting the loop counter: `Parent` assignment can
			// silently fail, and "six were created" is a weaker claim than "six are children now".
			// The first child's image slots are read back too — if the belt and the ball are both blank,
			// the common factor is the write path, not the asset or the face.
			const first = ball.GetChildren()[0];
			const firstTexture = first !== undefined && first.IsA("Texture") ? first : undefined;
			print(
				`[Spawner] texture: created ${created} textures on "${ball.GetFullName()}" childrenNow=${ball.GetChildren().size()} isChildOfBall=${tostring(first?.Parent === ball)} firstFace=${firstTexture === undefined ? "n/a" : firstTexture.Face.Name} firstColorMapContentUri=${firstTexture === undefined ? "n/a" : tostring(firstTexture.ColorMapContent.Uri)} firstLegacyTexture=${firstTexture === undefined ? "n/a" : firstTexture.Texture}`,
			);
		}
	}

	/**
	 * Welds three visual markers — two pole dots and one equatorial band — to a spawned body.
	 *
	 * ## Why this exists at all
	 *
	 * A sphere has no features, so a sphere rolling at belt speed is pixel-identical to a sphere
	 * sitting still. The texture route has already cost two rounds and still does not render on a
	 * curved primitive. Welded geometry cannot fail to render — it is ordinary parts.
	 *
	 * ## Why the decorations cannot disturb the experiment
	 *
	 * `CanCollide = false` — a colliding pole marker would make the body bounce on its own marker, so
	 * the surface under test would no longer be the belt. This is the single most important property
	 * here, and it is also why the markers are welded rather than moved by hand each frame: a weld needs
	 * no per-frame write and no proximity test.
	 *
	 * `Massless = true` — a massless part welded to a part with mass contributes nothing to the
	 * assembly's mass or inertia. Without it, three markers would roughly double the inertia of the
	 * assembly and quietly change how it rolls, which would turn a visual change into a physics change.
	 *
	 * `Anchored = false` — an anchored decoration would pin the weld, and therefore the body, in space.
	 *
	 * ## Why `WeldConstraint` and not `Weld`
	 *
	 * `WeldConstraint` exposes exactly `Enabled`, `Part0`, `Part1` — no `C0`/`C1`. That is not a
	 * limitation: the constraint preserves the rigid relationship that exists between the two parts *at
	 * the moment it is created*, so the offset is expressed by positioning the decoration first. A
	 * legacy `Weld` would need the same position expressed as a `C0` relative to the other part's
	 * coordinate system — one more convention to get wrong for no benefit.
	 *
	 * ## Ordering
	 *
	 * The body is already parented when this runs, and each marker is parented before its constraint is
	 * created, so `WeldConstraint` always sees two parts that are both in the DataModel.
	 *
	 * ## Cylinder geometry
	 *
	 * `Enum.PartType.Cylinder` is documented in the typings as "oriented along the **X** axis": `Size.X`
	 * is the axis length, `Size.Y`/`Size.Z` the diameter. That is not the intuitive mapping, so the ring
	 * is built as `(thickness, diameter, diameter)` and rotated 90° about Z to stand the axis up.
	 */
	private attachBallMarkers(ball: BasePart, entry: ShapePoolEntry): void {
		// Half the largest dimension. For the singleton ball this is exactly its radius; for a future
		// non-cube entry it is the conservative reading rather than the smallest half-extent.
		const radius = math.max(entry.size.X, entry.size.Y, entry.size.Z) / 2;
		const poleSize = radius * MARKER_POLE_SIZE_FRACTION;

		// `ball.CFrame * CFrame.new(0, r, 0)` means "r studs along the *body's own* up axis". Computing
		// this in world space instead would place the "pole" wherever world-up happened to point relative
		// to the body, which — with random spawn rotation — is nowhere in particular.
		this.createMarker(ball, ball.CFrame.mul(new CFrame(0, radius, 0)), "NorthPole", Enum.PartType.Ball, {
			size: Vector3.one.mul(poleSize),
			color: MARKER_POLE_COLOR,
		});
		this.createMarker(ball, ball.CFrame.mul(new CFrame(0, -radius, 0)), "SouthPole", Enum.PartType.Ball, {
			size: Vector3.one.mul(poleSize),
			color: MARKER_POLE_COLOR,
		});

		// Axis length first (`X` is the cylinder's axis), then the two diameters.
		this.createMarker(ball, ball.CFrame.mul(CFrame.Angles(0, 0, math.pi / 2)), "Equator", Enum.PartType.Cylinder, {
			size: new Vector3(MARKER_RING_THICKNESS, radius * MARKER_RING_OVERSIZE, radius * MARKER_RING_OVERSIZE),
			color: MARKER_RING_COLOR,
		});
	}

	/**
	 * Builds one welded, non-colliding, massless marker under the body.
	 *
	 * `Neon` material rather than `SmoothPlastic`: these exist to be tracked by eye at a glance and at a
	 * distance, and Neon is unaffected by the scene's lighting, so the markers stay legible regardless
	 * of time of day or shadow. The cost is that Neon blooms slightly at close range, which is
	 * irrelevant for a test marker and preferable to a marker that disappears in shadow.
	 */
	private createMarker(
		ball: BasePart,
		cframe: CFrame,
		name: string,
		shape: Enum.PartType,
		style: { size: Vector3; color: Color3 },
	): void {
		const marker = new Instance("Part");
		marker.Name = name;
		marker.Shape = shape;
		marker.Size = style.size;
		marker.CFrame = cframe;
		marker.Color = style.color;
		marker.Material = Enum.Material.Neon;
		marker.Anchored = false;
		marker.CanCollide = false;
		marker.Massless = true;
		marker.CastShadow = false;
		marker.TopSurface = Enum.SurfaceType.Smooth;
		marker.BottomSurface = Enum.SurfaceType.Smooth;

		// Parented to the body, not to the body's folder. This is what makes cleanup free: `Destroy()` on
		// the body takes its descendants with it, so the cap and the kill plane cannot leave markers
		// behind. A welded *sibling* would survive its body being destroyed and would accumulate at
		// spawn rate until the server ran out of room.
		marker.Parent = ball;

		CollectionService.AddTag(marker, TAGS.ballDecoration);

		// Created last, after both parts are parented — see the ordering note above.
		const weld = new Instance("WeldConstraint");
		weld.Name = "MarkerWeld";
		weld.Part0 = ball;
		weld.Part1 = marker;
		weld.Parent = marker;
	}

	/**
	 * Picks the belt a ball is measured against: the tagged belt nearest the spawner in Y.
	 *
	 * Nearest-in-Y rather than "contains the spawn point" because the spawner floats above the belt,
	 * so containment is false for exactly the parts this is meant to find. Ties are broken by tag
	 * order, and the chosen belt is printed in the spawn line, so a wrong pick is visible rather than
	 * silently attributed to the ball's departure.
	 */
	private resolveBeltFor(spawner: BasePart): BasePart | undefined {
		return this.nearestBeltTo(spawner.Position);
	}

	/**
	 * TEMPORARY INSTRUMENTATION. Nearest tagged belt by vertical distance from an arbitrary point.
	 *
	 * Split out of `resolveBeltFor` so cap destruction can ask the same question for a ball that was
	 * never tracked — an unlogged ball has no `BallObservation`, and therefore no remembered belt, but
	 * "was it over the belt when the cap ate it" still has to be answerable.
	 */
	private nearestBeltTo(position: Vector3): BasePart | undefined {
		let nearest: BasePart | undefined;
		let nearestGap = math.huge;

		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (!instance.IsA("BasePart") || instance.Parent === undefined) {
				continue;
			}

			const gap = math.abs(position.Y - instance.Position.Y);
			if (gap < nearestGap) {
				nearestGap = gap;
				nearest = instance;
			}
		}

		return nearest;
	}

	/**
	 * TEMPORARY INSTRUMENTATION. `GetNetworkOwner()` rendered as `server` or the player's name, with
	 * the auto flag. One token so an ownership line can be compared by grep rather than by eye.
	 *
	 * `nil` means server-owned; the typings return `Player | undefined`, and `undefined` is the
	 * documented "server" answer, not a failure to read. The auto flag is logged alongside because the
	 * two answers have different implications: `owner=server auto=false` means something explicitly
	 * pinned it (nothing in this repo does), while `owner=server auto=true` means the engine is
	 * currently choosing the server and may hand it to a client at any moment.
	 */
	private describeOwner(part: BasePart): string {
		const owner = part.GetNetworkOwner();
		return `owner=${owner === undefined ? "server" : owner.Name} auto=${tostring(part.GetNetworkOwnershipAuto())}`;
	}

	/**
	 * TEMPORARY INSTRUMENTATION. Counts `Ball`-tagged parts within the occupancy radius of a point.
	 *
	 * The ball being spawned is passed in and excluded: it is already parented and tagged by the time
	 * this runs (see `spawnBall`), so without the exclusion every spawn would report a count of at
	 * least 1 and the reading would be meaningless. Excluding it is also what makes the second ball of
	 * a same-tick pair report the first — the first was fully parented and tagged before the second
	 * was constructed, so it is found here.
	 *
	 * Distance is centre-to-centre in world space, not a local-space box test: "another ball near the
	 * spawn point" is radial in every direction and has nothing to do with the belt's axes.
	 */
	private countLaneOccupants(
		exclude: BasePart,
		position: Vector3,
		radius: number,
	): {
		count: number;
		nearest: string;
	} {
		const threshold = radius * 2 + OCCUPANCY_MARGIN_STUDS;
		let count = 0;
		let nearestId: number | undefined;
		let nearestDistance = math.huge;

		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			if (instance === exclude || !instance.IsA("BasePart") || instance.Parent === undefined) {
				continue;
			}

			const distance = instance.Position.sub(position).Magnitude;
			if (distance > threshold) {
				continue;
			}

			count++;

			// Identified by the observation id when the other ball is tracked, so the log can be
			// correlated with that ball's own lifecycle lines; untracked balls are reported by name,
			// because a bare count with no referent cannot be checked against anything.
			const otherId = this.observedBalls.get(instance)?.id;
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearestId = otherId;
			}
		}

		return {
			count,
			nearest: count === 0 ? "none" : nearestId === undefined ? "untracked" : `#${nearestId}`,
		};
	}

	/**
	 * One observation pass over every tracked ball, plus the rolling sample.
	 *
	 * Runs at `BALL_OBSERVE_SECONDS`. Two events are latched per ball — first motion and leave — and
	 * both are one-shot, so a ball that stays in the list for 60 s costs one string comparison per
	 * pass, not a log line.
	 */
	private observeBalls(): void {
		const now = os.clock();
		const dead = new Array<BasePart>();

		for (const [ball, observation] of this.observedBalls) {
			// A destroyed ball left the world without passing through a phase this instrumentation
			// reports (the cap evicted it, or `KillY` culled it before it crossed an edge). Dropping the
			// entry is the whole handling: adding a fourth "destroyed" line per ball would break the
			// three-line contract and add nothing the leave line does not already say.
			if (ball.Parent === undefined) {
				// Paths that reach here did not go through `destroyBall`, so the `Touched` connection would
				// otherwise be dropped silently with the entry. Engine-side destruction does clean the
				// signal up, but disconnecting explicitly keeps "one connection per logged ball" true at
				// every exit rather than true-by-accident.
				this.observedBalls.get(ball)?.touchedConnection?.Disconnect();
				dead.push(ball);
				continue;
			}

			const belt = observation.belt;
			if (belt === undefined || belt.Parent === undefined) {
				continue;
			}

			this.observeBall(ball, observation, belt, now);
		}

		// Removal is deferred: mutating a `Map` while iterating it is unspecified in Luau, and the
		// symptom (a skipped ball) would look exactly like the bug this instrumentation is chasing.
		for (const ball of dead) {
			this.observedBalls.delete(ball);
			if (this.sampleBall === ball) {
				this.sampleBall = undefined;
			}
		}

		if (now - this.lastSampleAt >= BALL_SAMPLE_SECONDS) {
			this.lastSampleAt = now;
			this.printBallSample();
		}
	}

	private observeBall(ball: BasePart, observation: BallObservation, belt: BasePart, now: number): void {
		const velocity = ball.AssemblyLinearVelocity;
		const beltSpeed = this.readNumber(belt, BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED);

		// Local space of the belt. `PointToObjectSpace` is the only correct frame here because the belt
		// may be rotated arbitrarily in Studio: comparing world X to the belt's Size.X would report a
		// rotated belt's edges on the wrong axis entirely, and would silently swap "left" and "front".
		const relative = belt.CFrame.PointToObjectSpace(ball.Position);
		const halfX = belt.Size.X / 2;
		const halfY = belt.Size.Y / 2;
		const halfZ = belt.Size.Z / 2;

		// Computed once and reused by both the motion test and the leave test. Positive means the ball's
		// centre is already past that edge of the belt's footprint.
		const overX = math.abs(relative.X) - halfX;
		const overZ = math.abs(relative.Z) - halfZ;
		const overFootprint = overX <= 0 && overZ <= 0;

		// Above or below the painted surface. `relative.Y > halfY` is the top face; anything with
		// `relative.Y < -halfY` is genuinely under the part, which is a different failure from leaving
		// across an edge while riding on top.
		const vertical =
			relative.Y > halfY ? "above-surface" : relative.Y < -halfY ? "below-surface" : "level-with-body";

		if (!observation.firstMotionLogged) {
			const threshold = math.max(
				math.abs(beltSpeed) * FIRST_MOTION_BELT_SPEED_FRACTION,
				FIRST_MOTION_FLOOR_STUDS_PER_SECOND,
			);

			if (velocity.Magnitude > threshold) {
				observation.firstMotionLogged = true;

				// The touch count is final at this point, so the connection is dropped here rather than at
				// destruction: leaving it connected would count every later pile-up for a number that has
				// already been reported and can never change.
				observation.touchedConnection?.Disconnect();
				observation.touchedConnection = undefined;

				// The along-right component is the discriminator the brief's "velocity magnitude" test
				// cannot supply on its own: a ball sliding off the side, or simply falling, also has a
				// magnitude. `alongRight ~= BeltSpeed` means it is being carried; `alongRight ~= 0` means
				// the surface is moving underneath a ball that is not moving with it.
				//
				// `overFootprint` exists because the magnitude test alone is easy to misread: a ball spawned
				// above the belt reaches any threshold from gravity alone, before it has touched anything.
				// `overFootprint=yes vertical=above-surface` means it was still in the air over the belt, so
				// this line says nothing about the belt yet; `overFootprint=yes level-with-body` with
				// `alongRight` near zero is a ball actually sitting on the belt and not being carried. The
				// sample series and the leave line are what settle it either way.
				//
				// Ownership is re-read here, not carried over from the spawn line, because engine ownership
				// can be reassigned between the two moments and the spawn reading may predate the
				// assignment — see `describeOwner`. A change between the two lines is itself a finding.
				print(
					`[Ball:${observation.id}] first motion after ${formatNumber(now - observation.spawnedAt)}s velocity=${formatVector(velocity)} speed=${formatNumber(velocity.Magnitude)} alongRight=${formatNumber(velocity.Dot(belt.CFrame.RightVector))} BeltSpeed=${formatNumber(beltSpeed)} threshold=${formatNumber(threshold)} overFootprint=${overFootprint ? "yes" : "no"} vertical=${vertical} local=${formatVector(relative)} touches=${observation.touchedCount} ${this.describeOwner(ball)}`,
				);
			}
		}

		if (observation.leaveLogged) {
			return;
		}

		if (overX > 0 || overZ > 0) {
			observation.leaveLogged = true;

			// Which axis it went out on, and which side of it. `+X` is `RightVector` exactly, so those two
			// labels are the same statement; `Z` is named numerically rather than as "front"/"back"
			// because `LookVector` is `-Z`, and a log that says "back" when the number is positive invites
			// exactly the sign confusion this line exists to end.
			const side =
				overX >= overZ ? (relative.X > 0 ? "+RightVector" : "-RightVector") : relative.Z > 0 ? "+Z" : "-Z";

			const overshoot = math.max(overX, overZ);

			print(
				`[Ball:${observation.id}] left belt side=${side} after ${formatNumber(now - observation.spawnedAt)}s at pos=${formatVector(ball.Position)} local=${formatVector(relative)} half=(x=${formatNumber(halfX)}, z=${formatNumber(halfZ)}) overshoot=${formatNumber(overshoot)} vertical=${vertical} (localY=${formatNumber(relative.Y)}, halfY=${formatNumber(halfY)}) velocity=${formatVector(velocity)} alongRight=${formatNumber(velocity.Dot(belt.CFrame.RightVector))} BeltSpeed=${formatNumber(beltSpeed)} touches=${observation.touchedCount} ${this.describeOwner(ball)}`,
			);
			return;
		}

		// Still inside the footprint but already under the belt's own body: the ball went through or
		// under the surface instead of across it. Warned once, because it is an anomaly rather than a
		// normal event, and because it looks identical to "no balls arrived" from the outside.
		if (relative.Y < -halfY && !observation.anomalyReported) {
			observation.anomalyReported = true;
			warn(
				`[Ball:${observation.id}] is below the belt surface at local=${formatVector(relative)} without having crossed an edge — it fell through or slid under rather than riding off the end.`,
			);
		}
	}

	/**
	 * Rolling sample: velocity, position, and the belt's current velocity for the tracked ball.
	 *
	 * One line every `BALL_SAMPLE_SECONDS`. This is the series that answers "riding or sliding"
	 * independently of the one-shot events: a riding ball holds `alongRight` near `BeltSpeed` while
	 * `local.X` marches toward the edge, a sliding ball holds `alongRight` away from `BeltSpeed` while
	 * `local.X` barely moves. It is also the only place the effective acceleration is visible, because
	 * consecutive samples give a Δv over a known Δt.
	 *
	 * **It retargets**, contradicting the previous round's note that it never would. The reason is
	 * measured, not stylistic: at 8 balls/s against a cap of 50 a ball lives ~6.25 s, and ball #1 is
	 * the *first* cap victim — so a non-retargeting series would stop at ~5.8 s, exactly when the
	 * steady state (cap-limited, `live = cap = 50`) begins, and would never sample the regime the
	 * questions are about. Retargeting is not ambiguous because the line already names the ball
	 * (`[Ball:<id>] sample`): a reader sees the series change hands rather than being told it did not.
	 */
	private printBallSample(): void {
		const ball = this.pickSampleBall();
		if (ball === undefined) {
			return;
		}

		const observation = this.observedBalls.get(ball);
		if (observation === undefined) {
			return;
		}

		const belt = observation.belt;
		if (belt === undefined || belt.Parent === undefined) {
			return;
		}

		const velocity = ball.AssemblyLinearVelocity;
		print(
			`[Ball:${observation.id}] sample t=${formatNumber(os.clock() - observation.spawnedAt)}s pos=${formatVector(ball.Position)} local=${formatVector(belt.CFrame.PointToObjectSpace(ball.Position))} velocity=${formatVector(velocity)} alongRight=${formatNumber(velocity.Dot(belt.CFrame.RightVector))} beltVelocity=${formatVector(belt.AssemblyLinearVelocity)} ${this.describeOwner(ball)}`,
		);
	}

	/**
	 * TEMPORARY INSTRUMENTATION. The ball this pass samples: whichever ball is currently designated,
	 * or — once that one is destroyed — the lowest-id ball still alive.
	 *
	 * Lowest id rather than newest is deliberate: the oldest survivor is the one closest to leaving,
	 * so the series keeps following a ball all the way to its edge-crossing instead of restarting on
	 * a ball that has just spawned and has nothing to say yet.
	 */
	private pickSampleBall(): BasePart | undefined {
		const designated = this.sampleBall;
		if (designated !== undefined && designated.Parent !== undefined && this.observedBalls.has(designated)) {
			return designated;
		}

		let oldest: BasePart | undefined;
		let oldestId = math.huge;

		for (const [ball, observation] of this.observedBalls) {
			if (ball.Parent === undefined || observation.id >= oldestId) {
				continue;
			}
			oldestId = observation.id;
			oldest = ball;
		}

		this.sampleBall = oldest;
		if (oldest !== undefined) {
			this.lastSampleAt = os.clock();
		}
		return oldest;
	}

	// #endregion

	// #region attribute reads

	private readNumber(part: Instance, attribute: string, fallback: number): number {
		const raw = part.GetAttribute(attribute);
		return typeIs(raw, "number") ? raw : fallback;
	}

	// #endregion
}
