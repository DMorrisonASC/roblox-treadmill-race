import { CollectionService, RunService, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import {
	BALL_SPEED_ATTRIBUTE,
	BELT_SPEED_ATTRIBUTE,
	DEFAULT_BELT_SPEED,
	DEFAULT_MAX_LIVE_BALLS,
	BOOSTED_ATTRIBUTE,
	TAIL_WIND_ATTRIBUTE,
	MARKER_LOCAL_POSITION_ATTRIBUTE,
	MARKER_LOCAL_RIGHT_ATTRIBUTE,
	MARKER_LOCAL_UP_ATTRIBUTE,
	OWNER_DISPLAY_NAME_ATTRIBUTE,
	OWNER_USER_ID_ATTRIBUTE,
	hasOwnerIdentity,
	CHOSEN_BALL_ID_ATTRIBUTE,
	SPAWNER_KILL_Y_ATTRIBUTE,
	SPAWNER_MAX_LIVE_BALLS_ATTRIBUTE,
} from "shared/attributes";
import { powerForBallId } from "shared/powers.config";
import {
	DECOY_OFFSET_STUDS,
	forgetBall as forgetBallPower,
	onRoundActive,
	presentPower,
	setPower,
	setRoundActive as setPowersRoundActive,
	spawnsDecoy,
	tickDelta,
} from "server/powers";

import {
	pickPoolEntry,
	poolMaxExtent,
	randomSpawnRotation,
	rotatedHalfHeight,
	ShapePoolEntry,
} from "shared/shape-pool";
import { TAGS } from "shared/tags";
import {
	BALL_SPEED_DECAY_RATE,
	BALL_SPEED_MAX,
	BALL_SPEED_MIN,
	BALL_SPEED_START,
	BALL_SPEED_START_JITTER,
	BALL_TEXTURE_ASSET,
	BALL_TEXTURE_OFFSET_RANGE,
	BALL_TEXTURE_OFFSET_RANGE_V,
	BOOST_HYSTERESIS,
	SPIN_DEADBAND_SPEED,
	SWAY_AMPLITUDE,
	SWAY_FREQUENCY_HZ,
	SWAY_PHASE_JITTER,
	SWAY_TRACK_SECONDS,
} from "shared/tuning";
import { TreadmillService } from "./treadmill-service";

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

/**
 * The owner a spawned body competes for.
 *
 * `userId` is the identity and may be negative for a synthetic debug owner; `displayName` is only for the
 * log and a later results screen. Both are written onto the body as attributes at creation, which is the
 * one moment they cannot be forgotten - see `spawnBall`.
 *
 * Declared at module scope rather than inside the class: it is a data shape, and `RoundService` names it in
 * its own signatures. An interface nested in a class is not visible to another file at all.
 */
export interface BallOwner {
	readonly userId: number;
	readonly displayName: string;
	/**
	 * The ball this competitor races as, when a round picked one.
	 *
	 * **Absent for a player who never picked, and for the `decoy` twin.** The attribute is written only when the value
	 * exists, because an empty string is a *value* — it would read as "this body races as nothing", which is a different
	 * statement from "nobody picked for this body".
	 *
	 * **Present for a synthetic debug owner**, which does not pass through the picker: `RoundService.debugSpawnCompetitors`
	 * draws a distinct id per body so a Studio session can exercise several powers in one press. That draw is the debug
	 * path's own; it is *not* a fallback inside `spawnBall`, because a fallback would also hand a power to the decoy.
	 */
	readonly chosenBallId?: string;
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
 * TEMPORARY INSTRUMENTATION. Seconds after spawn at which each body reports its spin state, once.
 *
 * Two seconds is chosen against the belt ramp rather than against nothing: `BELT_RAMP_SECONDS` is 3, so
 * at 2 s the belt is at roughly two thirds of `BeltSpeed` and the body has had time to be picked up
 * and to settle into rolling or sliding. Sampling at 0.5 s would catch bodies still falling; sampling
 * after 3 s would report the steady state but miss the difference between "never spun" and "spun and
 * decayed".
 *
 * Once per body, not on a cadence: the question this answers is binary — is the belt physically
 * spinning the body at all — and a cadence would bury the other lines in the same way the texture
 * instrumentation was capped for.
 */
const SPIN_PROBE_SECONDS = 2;

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
	/** TEMPORARY INSTRUMENTATION. Whether the one-shot spin probe has printed for this body. */
	spinProbeLogged: boolean;
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
 * **Nothing but `RoundService` asks for a body.** There is no client-facing spawn request any more: the
 * old `1` key spawned from here and is now the round's `Waiting` key, which is why the ghost ball in the
 * 21:20 log existed at all — it was created here, unknown to the round, and survived a teardown that
 * only destroys bodies the round knows about. A single creation path is the whole point of
 * "server-authoritative" here, and it is also the only way the owner contract can hold: every body has an
 * owner because the round is the only thing that makes one.
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
	/**
	 * Injected for the belt readings the reference-speed model needs, and for nothing else now.
	 *
	 * `getReferenceBeltSpeed`, `getBeltRightVector` and `getBeltFrame` are the three reads `stepBallSpeeds` makes. The
	 * belt is otherwise reached through the tag (`nearestBeltTo`, `resolveBeltFor`), and that stays — those lookups answer
	 * "where is the surface under this ball", which is per-ball and positional. Speed is different: `setBeltSpeed` writes
	 * one number on `TreadmillService` that covers every bound belt, so a tag lookup could only ever recover the
	 * designer's attribute, never the value the ramp has driven the constraint to. This is the smallest way to read that
	 * number, and `TreadmillService` does not import this file, so there is no cycle.
	 *
	 * **`getEffectiveBeltSpeed` used to be the fourth read, and both were deleted in item 92** along with the handler that
	 * was their only caller. Nothing in this file asks for the ramped speed any more: the model reads the *reference*
	 * number on purpose, so a ball's `RELATIVE_SPEED` is a fact about the round rather than about the ramp.
	 */
	constructor(private readonly treadmill: TreadmillService) {}

	private readonly spawners = new Set<BasePart>();

	/**
	 * The same spawners, in bind order, so "lane `i`" means one thing.
	 *
	 * `Set` iteration order over instance keys is not a language guarantee — it happens to be insertion
	 * order for a Lua table with reference keys until a rehash moves things around. A round assigns
	 * competitors to lanes by position, and a lane that silently swaps spawners between rounds makes the
	 * spawn log a lie about which lane a body came from. Maintaining an array alongside the set costs one
	 * push and one filter per bind/unbind and makes the mapping stated rather than incidental.
	 */
	private readonly spawnerLanes = new Array<BasePart>();

	/** Spawn order, oldest first — the order the cap evicts in. */
	private liveBalls = new Array<BasePart>();
	private readonly ballKillY = new Map<BasePart, number>();

	/**
	 * Which decoy a body spawned: **parent -> twin**, for the `decoy` power.
	 *
	 * ## Why a map rather than an attribute on the body
	 *
	 * An attribute *can* hold an instance reference — `SetAttributeValue` accepts an `Instance` and `AttributeValue` carries
	 * an `InstanceHandle` — so this was a real choice rather than a forced one. Three things decided it:
	 *
	 * - **The read side is not the write side.** `GetAttribute` returns `AttributeValue`, whose instance member is
	 *   `InstanceHandle`, not `BasePart`: every read would need an unchecked assertion to reach `.Parent`, and nothing in the
	 *   type would prove the handle still points at a live body.
	 * - **A handle to a destroyed instance reads back as `nil`**, which silently erases the link at exactly the moment this
	 *   map has to answer a question about it — a parent culled while its twin is still on the belt.
	 * - **It would replicate.** The link is server-only information; a client that could read it would not need the
	 *   `DecoyOutline` request to be refused at all.
	 *
	 * **An `OwnerUserId` on the decoy was rejected for a different reason:** that is the field `getCompetitors()` filters
	 * on, so writing it would make the twin a competitor and change the winner rule. The link has to live somewhere that is
	 * not the body's identity.
	 *
	 * Cleared in both death paths — the parent's and the twin's — so its size tracks the live set like every other map in
	 * this file. It is tiny (one entry per `decoy` competitor, so at most one per lane) and the reverse scan in
	 * `forgetDecoy` costs nothing at that size.
	 */
	private readonly decoysByParent = new Map<BasePart, BasePart>();

	/**
	 * The identity a twin answers with, **copied from its parent at spawn**.
	 *
	 * ## Why the twin remembers this instead of walking `decoysByParent` at read time
	 *
	 * The leaderboard asks "who does this body represent" once per body per second, and the honest answer for a twin is *its
	 * parent's* identity — the twin carries no owner attributes at all, by design. Reading that out of `decoysByParent` needs a
	 * reverse scan, and the scan has one failure that matters more than its cost: **the link is deleted the moment the parent
	 * dies**, so from that instant the twin has no parent to name and would be published as `Decoy B7` — announcing to every
	 * player that the leftover body was the fake. The parent is usually eliminated first (it is the one being raced), so this
	 * is not an edge case; it is the normal end of a decoy's life.
	 *
	 * A copy taken at spawn cannot go stale in that way: the identity is a `{userId, name}` pair that nothing rewrites, and
	 * it survives the parent by exactly as long as the twin does. It is also immune to the "second index disagrees with the
	 * first" hazard `forgetDecoy` warns about, because it is not an index of the link at all — it is a snapshot of an
	 * attribute pair.
	 *
	 * Cleared when the **twin** dies (`forgetDecoy` with the twin as the argument), never when the parent does — keeping the
	 * entry through the parent's death is the whole point.
	 */
	private readonly decoyIdentities = new Map<BasePart, { userId: number; name: string }>();

	/**
	 * Each live ball's decorative sway state: the **phase** its sine wave starts at, and its **own clock**, in seconds
	 * since it spawned.
	 *
	 * Both fields are needed and both are per ball. The phase is what stops a belt of balls swaying in lockstep - see
	 * `SWAY_PHASE_JITTER` - and the clock is what makes the wave start on the ball's own first tick rather than on a
	 * global time, so a ball spawning into a wave that is already running does not snap to an arbitrary point of it.
	 * `elapsed` is advanced by the tick's own `dt` in `stepBallSpeeds`; nothing else writes it, and it is never < 0.
	 *
	 * ## Why a map and not two attributes on the body
	 *
	 * The state is a *tick-local* detail with no consumer outside this loop: no client draws it, no other service
	 * reads it, and it dies with the ball. An attribute would replicate it to every client and cost a write per tick
	 * for nothing. The map is cleared in `forgetBall` and `pruneDestroyedBalls` alongside `ballKillY`, so its size
	 * tracks the live set exactly like every other per-ball map in this file.
	 *
	 * **This is the same map the bounce model used** (item 107): it held `{ direction, bound }` and holds
	 * `{ phase, elapsed }` now. Repurposed rather than replaced so the four call sites - two writes at spawn, two
	 * deletes on the death paths - kept their shape and no stale map can be left behind.
	 */
	private readonly lateral = new Map<BasePart, { phase: number; elapsed: number }>();

	/**
	 * Each ball's own starting speed, in studs/second, drawn once at spawn and reused at every `Playing` entry.
	 *
	 * A map rather than an attribute for the same reason as `lateral`: nothing outside this file reads it. Cleared
	 * with `ballKillY` and `lateral` in the destroy path, so its size tracks the live set.
	 */
	private readonly startSpeeds = new Map<BasePart, number>();

	/**
	 * Whether a round is in progress, and therefore whether the manual `1` path is live.
	 *
	 * Set only by `RoundService`. Defaults to `false` so a server that never sees a round cannot be
	 * poked into making bodies — the safe default is the one that does nothing.
	 */
	private roundActive = false;

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

		// **The manual spawn remote is gone with the `1` key.** `1` now forces the round to `Waiting`, so
		// nothing fires `SpawnBall` any more; leaving the remote and its handler in place would leave a
		// second way to create a body that `RoundService` never heard about. That second way is exactly
		// what produced the ghost in the 21:20 log — a ball created here, untracked by the round, still
		// rolling 274 studs past the belt's end five seconds into `Intermission`, because the round's
		// teardown only ever destroys bodies it knows about. One creation path is worth more than the
		// affordance the key provided.

		task.spawn(() => {
			while (true) {
				this.cleanup();
				task.wait(CLEANUP_INTERVAL_SECONDS);
			}
		});

		// **The whole simulation.** One connection for every ball, every frame, and the only thing that moves a
		// ball along the belt since the physical slab stopped driving anything (see `TreadmillService`).
		//
		// On `Heartbeat` because it must run at physics rate: the velocity it writes is what the engine
		// integrates next step, so a slower cadence would produce visible stutter and a faster one would
		// rewrite the same value twice. It is gated on `roundActive` ? the flag `RoundService` sets at
		// `Playing` entry and clears on the way out ? so `Waiting`, `PostGame` and `Intermission` cost one
		// boolean test per frame and no writes at all.
		RunService.Heartbeat.Connect((dt) => this.stepBallSpeeds(dt));

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

		// **The one-shot spawn is gone.** A fresh server now starts with no balls at all, because a
		// round has not started: balls exist only between `Waiting` and the end of `PostGame`, and their
		// creation is `RoundService`'s to request. Leaving the one-shot here would mean a server that has
		// never entered `Waiting` already has four bodies on a stationary belt, which reads as a round
		// that started on its own.
		//
		// The manual `1` path still exists for ad-hoc bodies, but is gated on the round being active — see
		// `setRoundActive`.
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

		// Derived before anything observes the part, so every later reader — the bind log, the round's
		// spawn request, the kill plane — sees a part with a complete set of values.
		const derived = this.ensureDerivedAttributes(instance);

		// No attribute listener and no `Enabled`: both retired with the stream. Nothing spawns from the tag
		// itself; every body comes from `RoundService` asking for one.
		this.spawners.add(instance);
		this.spawnerLanes.push(instance);

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
		const laneIndex = this.spawnerLanes.indexOf(instance);
		if (laneIndex >= 0) {
			// Shifted rather than swapped-with-last: lane indices are what the round logs, so removing one
			// spawner must not renumber the others behind it.
			this.spawnerLanes.remove(laneIndex);
		}
		this.spawnerIds.delete(instance);
		this.spawnerFailures.delete(instance);
	}

	// #endregion

	// #region round integration

	/**
	 * Tells the spawner whether a round is in progress, which is the only thing that decides whether
	 * the manual `1` path does anything.
	 *
	 * A setter rather than `RoundService` injecting the phase: the spawner owns its own gate, and the
	 * caller owns the phase. Every other design has the spawner asking the round a question on every
	 * keypress, which is a dependency in the wrong direction — a spawner that needs a round is a
	 * spawner that cannot be used outside one.
	 */
	public setRoundActive(active: boolean): void {
		this.roundActive = active;

		// **The powers' own view of the same fact.** `onBallCollision` had no phase gate until item 80 and relied on the
		// proportional drain to make a `PostGame` transfer a no-op; this is the signal that lets it refuse outright, and it
		// is the same boolean `stepBallSpeeds` already trusts — so it cannot disagree with the simulation.
		setPowersRoundActive(active);

		if (active) {
			// **The round start is the moment the ride begins, so it is the moment the speed is seeded.**
			//
			// Every ball that exists when `Playing` opens is put back to `BALL_SPEED_START`, because a ball
			// spawned into `Waiting` (which `1` does) was zeroed by the branch below and would otherwise enter
			// `Playing` at `0` and drift backwards at the full `BELT_SPEED` - `RELATIVE_SPEED = 0 - 10 = -10` -
			// for the whole round. A round whose pickup happened not to be in that lane then looked like a ball
			// that never span and never moved.
			//
			// In `setRoundActive` rather than in `RoundService` because this is the hook `Playing` entry already
			// calls (`enterPlaying` is the single choke point for the phase) and the spawner owns the attribute,
			// so nothing has to be kept in step across two files.
			//
			// It runs before the first `stepBallSpeeds` tick - the flag above has only just been set - so the
			// first `RELATIVE_SPEED` the model computes is `BALL_SPEED_START - BELT_SPEED = 0`, the neutral start
			// the model is specified to have.
			// Each ball is restored to **its own** start, not to the shared constant: `startSpeeds` holds the value
			// it drew at spawn, so a ball zeroed by `Waiting` resumes the curve it was born with rather than being
			// re-rolled into a different one.
			let seeded = 0;
			for (const ball of this.liveBalls) {
				if (ball.Parent !== undefined) {
					ball.SetAttribute(BALL_SPEED_ATTRIBUTE, this.startSpeeds.get(ball) ?? BALL_SPEED_START);
					// **The powers' timers start here and nowhere else.** A ball that spent fifteen seconds in `Waiting`
					// must not spend its rocket there, so `Playing` entry is the clock's origin. A body spawned after this
					// point gets its timers from `spawnBall`, which is the only other entry point.
					onRoundActive(ball);
					seeded++;
				}
			}

			print(
				`[Spawner] round start: ${seeded} ball(s) at BALL_SPEED=${formatNumber(BALL_SPEED_START)}+0..${formatNumber(2 * BALL_SPEED_START_JITTER)}`,
			);
			return;
		}

		// Leaving `Playing` stops the simulation by clearing the flag, but the attribute is the ball's own state
		// and would otherwise keep the last value it held - a ball frozen mid-round with `BALL_SPEED = 4` reads
		// as "still racing, just not moving" in any log line or future consumer. Zeroing it makes the stopped
		// state explicit, which is the same reason `Waiting` sets the belt to zero. `setRoundActive(true)`
		// restores it, so this is a pause rather than a one-way reset.
		//
		// **`Boosted` is re-evaluated by the same function the tick uses, not written a second way.** The loop that
		// normally settles it stops the moment the round does, so a ball frozen at `Boosted = true` would keep its wind
		// trail for the whole of `PostGame` — the effect outliving the state it reports. Calling `writeBoosted` with the
		// speed being written (`BALL_SPEED_MIN`) and the *reference* belt speed is the same question asked once more, and
		// it answers `false`, which keeps the attribute to one writer with two callers.
		const referenceBeltSpeed = this.treadmill.getReferenceBeltSpeed();
		for (const ball of this.liveBalls) {
			if (ball.Parent !== undefined) {
				ball.SetAttribute(BALL_SPEED_ATTRIBUTE, BALL_SPEED_MIN);
				const settledBoosted = this.writeBoosted(ball, BALL_SPEED_MIN, referenceBeltSpeed);
				this.writeTailWind(ball, BALL_SPEED_MIN - referenceBeltSpeed, BALL_SPEED_MIN, settledBoosted);
			}
		}
	}

	/** How many parts are currently bound as spawners. `RoundService` spawns one body per spawner. */
	public getBoundSpawnerCount(): number {
		return this.spawnerLanes.size();
	}

	/**
	 * The bound spawner **parts**, in bind order ? the same order lane indices use.
	 *
	 * Not a count, and not a copy of their positions: `PickupService` needs to place one pickup in each lane,
	 * and a lane's `Z` is scene data that can be edited in Studio between rounds. Returning the parts means the
	 * reader calls `Position` at the moment it spawns, so moving a spawner in Studio moves its lane.
	 *
	 * A fresh array on every call, so a caller cannot mutate the service's own lane list by sorting what it was
	 * given.
	 */
	public getBoundSpawners(): Array<BasePart> {
		const parts = new Array<BasePart>();
		for (const spawner of this.spawnerLanes) {
			if (spawner.Parent !== undefined) {
				parts.push(spawner);
			}
		}
		return parts;
	}

	/**
	 * Spawns one body in a specific lane, returning it or `undefined` if the lane does not exist or the
	 * spawn failed.
	 *
	 * **Lane-indexed rather than "give me the next spawner".** A round assigns one competitor per player
	 * and logs which lane each went to; with a round-robin call the caller would only learn the lanes by
	 * re-deriving the distribution from the result count, which is wrong the moment one spawn fails. Here
	 * the lane is an argument, so a failure is reported against the lane that failed and the caller's
	 * lane bookkeeping stays correct.
	 *
	 * The failure is logged through the same `reportFailure` path as every other spawn, so a broken
	 * spawner is named once per attempt rather than swallowed by a `undefined` return.
	 */
	public spawnInLane(laneIndex: number, owner: BallOwner): BasePart | undefined {
		const spawner = this.spawnerLanes[laneIndex];
		if (spawner === undefined || spawner.Parent === undefined) {
			return undefined;
		}

		let ball: BasePart | undefined;
		const failure = this.runProtected(() => {
			ball = this.spawnBall(spawner, owner);
		});

		if (failure !== undefined) {
			this.reportFailure(spawner, failure);
			return undefined;
		}

		this.reportRecovery(spawner);
		return ball;
	}

	/**
	 * Spawns one body per owner, distributed round-robin across the bound spawners, and returns them.
	 *
	 * **Owners, not a count.** The owner has to be written on the body at creation, and a count would
	 * force the caller to re-derive which body got which owner from the returned order — a mapping that is
	 * only correct if every spawn succeeds. Passing the owners in makes the association exact, and it is
	 * what lets a failed spawn cost one competitor rather than shifting every later owner onto the wrong
	 * body.
	 *
	 * Round-robin rather than "one per spawner until the owners run out" because the two are identical
	 * when the counts match and round-robin degrades gracefully when they do not: a scene with two
	 * spawners asked for three bodies puts two in one lane rather than silently spawning two and
	 * reporting success.
	 *
	 * Each spawn is individually protected: a malformed spawner must cost one body, not the round. A body
	 * that fails is simply absent from the returned list, so `RoundService` tracks exactly what exists
	 * rather than what was requested.
	 */
	public spawnForRound(owners: ReadonlyArray<BallOwner>): BasePart[] {
		const spawned = new Array<BasePart>();

		const spawners = this.spawnerLanes;
		if (spawners.size() === 0) {
			warn(`[Spawner] a round was requested but no part is tagged ${TAGS.ballSpawner}; no bodies spawned.`);
			return spawned;
		}

		for (let index = 0; index < owners.size(); index++) {
			const spawner = spawners[index % spawners.size()];
			const owner = owners[index];

			let ball: BasePart | undefined;
			const failure = this.runProtected(() => {
				ball = this.spawnBall(spawner, owner);
			});

			if (failure !== undefined) {
				this.reportFailure(spawner, failure);
				continue;
			}

			this.reportRecovery(spawner);
			if (ball !== undefined) {
				spawned.push(ball);
			}
		}

		return spawned;
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

	private spawnBall(spawner: BasePart, owner: BallOwner): BasePart | undefined {
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

		// **The owner is written here, at creation, and nowhere else.** Two properties on the body rather
		// than a table inside `RoundService`, because the body is what gets destroyed, replicated and
		// enumerated: an owner held in a service-side map would need cleanup on every death path (cap,
		// kill plane, elimination, teardown) and one missed path would leak an entry that later reads as a
		// live competitor. Attributes replicate with the instance, so a client can answer "who owns this"
		// without asking the server.
		//
		// Written before `Parent` so the body never exists in the world, even for one frame, without an
		// owner: `RoundService` handles a spawn's return value immediately, and a body that were briefly
		// ownerless would be an orphan by its own rule — ignored by the winner check it was just counted
		// into.
		ball.SetAttribute(OWNER_USER_ID_ATTRIBUTE, owner.userId);
		ball.SetAttribute(OWNER_DISPLAY_NAME_ATTRIBUTE, owner.displayName);

		// The pick, written in the same block and for the same reason: before `Parent`, so no frame exists in which a body
		// has an owner but no chosen ball. A label, not a grant — the id is not added to `OwnedBalls`, and the body's
		// appearance is untouched this round.
		const chosenBallId = owner.chosenBallId;
		if (chosenBallId !== undefined) {
			ball.SetAttribute(CHOSEN_BALL_ID_ATTRIBUTE, chosenBallId);
		}

		// **The power, derived from the pick and written before `Parent`** — the same block as the owner, for the same
		// reason: a body must never exist, even for one frame, carrying an owner and a chosen ball but no power, because
		// the tick loop and every collision handler read `Power` and would spend that frame treating it as powerless.
		//
		// `setPower` does more than the attribute: the collision group (which `ghost` needs before the first physics step),
		// the badge, and — for the two colliding powers — the `Touched` connection. `chosenBallId` is *rewritten* later
		// when the player picks, and `RoundService.applyChosenBall` calls `setPower` again for exactly that reason, so this
		// call is not the only one.
		const power = chosenBallId !== undefined ? powerForBallId(chosenBallId) : undefined;
		if (power !== undefined) {
			setPower(ball, power, entry.size.X / 2);
		}

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

		// **Each ball starts at its own speed, drawn upward only.** Without a per-ball start every ball followed one curve
		// from one constant and the whole field crossed the exit edge in a single wave, so the round was decided by spawn
		// order rather than by the ride. See `BALL_SPEED_START_JITTER` for the arithmetic.
		//
		// **The draw is one-sided on purpose** (`10 .. 12`, not `10 +- 1`): a ball that launched below the reference would
		// be losing ground from its first frame, which is not wrong mechanically but leaves the wind-boost effect with
		// nothing to show for that ball at all. Launched at or above the reference, every body sets `Boosted` on its first
		// tick and the effect has a state to represent from the green light.
		//
		// The value is remembered in `startSpeeds` because `setRoundActive(true)` restores it at `Playing` entry,
		// and re-drawing there would hand a ball a different start from the one it was born with.
		const startSpeed = BALL_SPEED_START + math.random() * 2 * BALL_SPEED_START_JITTER;
		this.startSpeeds.set(ball, startSpeed);
		ball.SetAttribute(BALL_SPEED_ATTRIBUTE, startSpeed);

		// The sway starts here too, for the same reason: seeded at birth so the tick loop needs no fallback
		// branch, and so the first tick already has a phase and a clock of zero.
		this.lateral.set(ball, this.newSway());

		// Visual only, and attached *after* `Parent` — unlike the textures above. The markers are anchored
		// and carry their local offset as attributes, so they need the body to be in the DataModel before
		// `ball.CFrame.ToObjectSpace` has a meaningful frame to be relative to. The cost is that the three
		// markers replicate as separate child-creation events rather than arriving with the ball; at three
		// parts per spawn that is acceptable, and correctness wins.
		this.attachBallMarkers(ball, entry);

		// TEMPORARY INSTRUMENTATION. Before `liveBalls.push`, so the spawn line always precedes any
		// observation of this ball; the observation loop only ever sees balls that already logged.
		this.beginBallObservation(ball, spawner, entry);

		this.liveBalls.push(ball);
		this.ballKillY.set(ball, this.readNumber(spawner, SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY()));

		// Timers start at `Playing` for every body, including one spawned into a running round — a ball created mid-round
		// has no `Waiting` to sit out, but it must still get its rocket and its eclipse drawn, and the only place that
		// happens is here or in `setRoundActive(true)`.
		if (this.roundActive) {
			onRoundActive(ball);
		}

		// The decoy last, so the body it copies is fully registered and so a decoy destroyed by the cap on this very spawn
		// cannot take its parent with it.
		if (power !== undefined && spawnsDecoy(power)) {
			this.spawnDecoy(spawner, ball, entry, power, startSpeed);
		}

		this.enforceCap();

		return ball;
	}

	/**
	 * One ownerless body beside a `decoy` ball — its twin.
	 *
	 * ## What "ownerless" buys, and what it costs
	 *
	 * It carries **no owner attributes**, which is what makes it an orphan rather than a competitor:
	 * `RoundService.getCompetitors()` filters on the owner pair, so a decoy cannot win, cannot hold a round open, and
	 * cannot be reported as anybody's elimination. It is still a body on the belt that other balls collide with, which is
	 * the entire point of the power.
	 *
	 * ## It looks exactly like its parent, and that is deliberate
	 *
	 * The first version of this decoy was a bare sphere: no `Power` attribute, no badge, no face textures and no markers.
	 * That made it identifiable across the arena, so `decoy` deceived nobody and its only real effect was to hold a
	 * `MaxLiveBalls` slot. It now gets the same four things the parent got — the attribute and badge through
	 * `presentPower` (not `setPower`), the textures, and the markers.
	 *
	 * **`presentPower`, never `setPower`.** `setPower` also fills the aura registries and connects a `Touched` handler,
	 * so a decoy made with it would project a real `magnet` or `eclipse` aura — an `eclipse` decoy would freeze the field
	 * from a body the winner rule cannot see. Everything a viewer perceives goes through `presentPower`; everything the
	 * simulation acts on stays with the parent. The decoy's `Power` attribute is therefore a *label*, and every mechanic
	 * that reads one either skips it (`tickDelta` has no state for it, the aura registries never gain it) or is
	 * cosmetic (`bouncy` hops, a `sprinter` decoy takes the bigger pickup boost).
	 *
	 * Two costs, stated rather than hidden:
	 *
	 * - **It counts toward `MaxLiveBalls`.** `enforceCap` is a body count, and excluding decoys would mean two notions of
	 *   "a ball that counts" that every reader would have to know about. So a cap-bound round loses a real competitor
	 *   sooner, and the log line for its eviction names `owner=none`.
	 * - **`settleEliminations` sees it leave the belt** and logs an elimination with no owner. Nothing tells a player,
	 *   because `notifyEliminated` refuses an ownerless body — but the count in the log will not match the number of
	 *   players.
	 */
	private spawnDecoy(
		spawner: BasePart,
		parent: Part,
		entry: ShapePoolEntry,
		power: string,
		startSpeed: number,
	): void {
		const decoy = new Instance("Part");
		decoy.Name = "Decoy";
		decoy.Shape = parent.Shape;
		decoy.Size = parent.Size;
		decoy.Anchored = false;
		decoy.CanCollide = true;
		decoy.Material = parent.Material;
		decoy.TopSurface = Enum.SurfaceType.Smooth;
		decoy.BottomSurface = Enum.SurfaceType.Smooth;
		decoy.CFrame = parent.CFrame.add(new Vector3(DECOY_OFFSET_STUDS, 0, 0));

		// The attribute, the collision group and the badge — the three things `setPower` does that a viewer can see, and
		// none of the two it does that the simulation acts on. Applied before `Parent` for the same reason the parent's is:
		// a body must never exist for a frame looking like a ball it is not.
		presentPower(decoy, power, entry.size.X / 2);

		// The six face textures, before `Parent` so they arrive as one tree rather than as separate child creations — the
		// same ordering `spawnBall` uses. This consumes one slot of `BALL_TEXTURE_LOG_LIMIT`, which is instrumentation for
		// the parent's spawn path; a decoy being logged there is acceptable and no longer distinguishable in the log.
		this.attachBallTexture(decoy, entry);

		// **No `ChosenBallId`.** It is a label for "the ball a player picked", and no player picked this body; every reader
		// of it either filters on an owner (`applyChosenBall`) or is a log line that would then lie.
		decoy.Parent = this.ballsFolder();
		CollectionService.AddTag(decoy, TAGS.ball);

		this.startSpeeds.set(decoy, startSpeed);
		decoy.SetAttribute(BALL_SPEED_ATTRIBUTE, startSpeed);
		this.lateral.set(decoy, this.newSway());

		// After `Parent`, for the reason the parent's markers are: the poles and the ring are anchored and carry their local
		// offset as attributes, so they need the body to be in the DataModel before `CFrame.ToObjectSpace` has a meaningful
		// frame. Without them the decoy is a sphere with textures and a badge but no spinning cues, which reads as a
		// different object the moment it moves.
		this.attachBallMarkers(decoy, entry);

		this.liveBalls.push(decoy);
		this.ballKillY.set(decoy, this.readNumber(spawner, SPAWNER_KILL_Y_ATTRIBUTE, this.deriveKillY()));

		// The link the `DecoyOutline` remote answers from — see `decoysByParent` for why it is a map and not an attribute.
		this.decoysByParent.set(parent, decoy);

		// The identity this twin answers with, taken now because the answer has to outlive the parent — see
		// `decoyIdentities`. Read before the twin is parented is irrelevant (it is the *parent's* attributes), but it is read
		// here rather than later so the copy is made at the one moment the two bodies are known to be a pair.
		const parentIdentity = this.identityOf(parent);
		if (parentIdentity !== undefined) {
			this.decoyIdentities.set(decoy, parentIdentity);
		}
	}

	/**
	 * The twin a body spawned, if it spawned one and the twin is still alive.
	 *
	 * `undefined` covers both "this body is not a `decoy` ball" and "its twin has already been destroyed", which are the
	 * same answer to any caller: there is no second body to point at. A caller that needs to tell them apart would be
	 * asking a question nobody has to ask.
	 */
	public decoyFor(parent: BasePart): BasePart | undefined {
		const decoy = this.decoysByParent.get(parent);
		if (decoy === undefined || decoy.Parent === undefined) {
			return undefined;
		}

		return decoy;
	}

	/**
	 * Who a body *represents*, which for a twin is its parent.
	 *
	 * ## Why this exists
	 *
	 * A `decoy` twin is deliberately ownerless - `OwnerUserId` on it would make it a competitor and change the winner rule -
	 * so anything that names a body from its attributes alone sees a fake as `Decoy` and tells the whole server which body is
	 * the lie. The leaderboard is exactly that reader, and the fiction of the power depends on it not being able to tell.
	 *
	 * **The winner rule is untouched by this.** `RoundService` reads `OwnerUserId` off the *body* to decide who competes; this
	 * method answers a *display* question and writes nothing. A twin that reports its parent's identity here is still an
	 * ownerless body everywhere the simulation looks, which is the whole point of keeping the two apart.
	 *
	 * ## Why the twin's identity is a copy, not a reverse lookup
	 *
	 * This used to walk `decoysByParent` to find the parent of a given twin. That answers correctly while both bodies are
	 * alive and **silently stops answering the moment the parent dies** - `forgetDecoy` deletes the link, because the map is
	 * a record of live pairs and a dead parent has none. Since putting twins on the leaderboard, that failure has a visible
	 * cost: the orphaned twin would publish as `Decoy B7` for the rest of its life, which is the one thing the `decoy` power
	 * must never do. The parent is normally the body that dies first, so this is the ordinary case rather than a corner.
	 *
	 * The twin now carries a copy of the pair, taken at spawn (`decoyIdentities`). It costs one small table per decoy, it is
	 * one map read instead of a scan per body per second, and it outlives the parent by design.
	 *
	 * Returns `undefined` for a body with no owner and no remembered twin origin - a debug ball, a stray, or a body spawned
	 * before this build. The caller falls back to naming the body itself.
	 */
	public ownerIdentityFor(ball: BasePart): { userId: number; name: string } | undefined {
		const own = this.identityOf(ball);
		if (own !== undefined) {
			return own;
		}

		// A twin's copy, taken at spawn. It survives its parent's death, which is the case a reverse lookup through
		// `decoysByParent` cannot answer — see `decoyIdentities`.
		return this.decoyIdentities.get(ball);
	}

	/** A body's own owner attributes, or `undefined` when the pair is missing or half-written. */
	private identityOf(ball: BasePart): { userId: number; name: string } | undefined {
		const userId = ball.GetAttribute(OWNER_USER_ID_ATTRIBUTE);
		const displayName = ball.GetAttribute(OWNER_DISPLAY_NAME_ATTRIBUTE);
		if (!hasOwnerIdentity(userId, displayName) || !typeIs(userId, "number") || !typeIs(displayName, "string")) {
			return undefined;
		}

		return { userId, name: displayName };
	}

	/**
	 * Drops any decoy link involving this body, whichever side of it the body is.
	 *
	 * Called from both death paths with whichever body died. A parent's death leaves an orphaned twin on the belt — the twin
	 * is not a child of the parent, deliberately, because `Destroy()` on the parent must not silently remove a body the
	 * round may still be counting — so both directions have to be handled. The map is at most one entry per lane, which is
	 * why the reverse scan is a loop rather than a second index that could disagree with the first.
	 */
	private forgetDecoy(ball: BasePart): void {
		this.decoysByParent.delete(ball);

		const stale = new Array<BasePart>();
		for (const [parent, decoy] of this.decoysByParent) {
			if (decoy === ball) {
				stale.push(parent);
			}
		}

		for (const parent of stale) {
			this.decoysByParent.delete(parent);
		}

		// **Only when the dead body is the twin.** `ball` is whichever body died, so this is a no-op when a *parent* dies - and
		// that is deliberate: the twin keeps the identity it was given at spawn so its leaderboard row still carries the
		// player's name after the parent is gone. Deleting it on the parent's death would publish the orphan as `Decoy B7`.
		this.decoyIdentities.delete(ball);
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

	// #region the reference-speed model

	/**
	 * A fresh sway state: a random starting phase and a clock at zero.
	 *
	 * `elapsed` starts at `0` rather than at an absolute time because the wave is the ball's own - see the `lateral`
	 * map. The phase is drawn from `0 .. SWAY_PHASE_JITTER`, so `math.pi` gives a fully desynchronised field and `0`
	 * would make every ball sway together.
	 */
	private newSway(): { phase: number; elapsed: number } {
		return { phase: math.random() * SWAY_PHASE_JITTER, elapsed: 0 };
	}

	/**
	 * Decays every ball's speed and hands the engine a velocity derived from it.
	 *
	 * ## The model, for a reader who has not seen the brief
	 *
	 * The belt is **not physical any more**. `BELT_SPEED` (`DEFAULT_BELT_SPEED`, 10) is a fixed reference
	 * number. Each ball carries `BALL_SPEED` as an attribute, starts at `BALL_SPEED_START` (the same 10), and
	 * decays toward `BALL_SPEED_MIN` at `BALL_SPEED_DECAY_RATE`.
	 *
	 * Every tick the ball's velocity **along the belt** is set to `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`:
	 * zero at the start (the ball holds station), negative once decay has begun (the ball slides toward the
	 * back edge), and positive only after a pickup (the ball drifts back toward the front edge, away from
	 * elimination). The sign is the whole design: **negative loses ground, positive gains it.**
	 *
	 * ## Which way is which — the axis, stated once
	 *
	 * **Along-belt is world X**, and in this scene the belt's `RightVector` is `+X`. That is the naming trap, and it
	 * is worth the paragraph: `RightVector` *sounds* lateral and is not. For a part whose long axis is X, `RightVector`
	 * is the **long** axis, and this tree uses it for exactly that everywhere — this loop, and every log field that
	 * measures a ball's along-belt velocity as a dot product with it. A reader who assumes "right = lateral" gets the sign of
	 * `relative` backwards and writes a ball that moves across the belt instead of along it. **Lateral is world Z**,
	 * and the only code that touches it is the decorative sway below, on `RightVector:Cross(UpVector)` — which for
	 * `RightVector = +X` is `+Z`.
	 *
	 * In this model **`+X` is toward the back** — the exit end, where a ball is eliminated — and **`-X` is toward the
	 * front**, the spawn end. Decay therefore moves a ball toward the back and a boost moves it toward the front, which
	 * is why the write below multiplies by `-relative`: a positive `RELATIVE_SPEED` must become motion toward `-X`.
	 *
	 * ## The two frames, and why every number here says which
	 *
	 * The belt's `Origin` is its **geometric centre**, so `PointToObjectSpace` — the frame behind every `local=` log
	 * field and every footprint test — measures from the middle of the belt: **code-frame X runs `-28 .. +28` and
	 * code-frame Z runs `-6 .. +6`** for this scene's 56x1x12 belt. The way a player and the design briefs think about
	 * the same belt is the **user frame**, measured from the front edge and the left edge: **`user-X = code-X + 28`**
	 * (so `0` is the very front edge and the belt runs `0 .. 56`) and **`user-Z = code-Z + 6`** (so the belt spans
	 * `0 .. 12`). **The two offsets are 28 on X and 6 on Z.** A ball spawns at code-frame X `-23` (user-X `5`) and is
	 * eliminated at code-frame X `+28` (user-X `56`).
	 *
	 * From the **front looking toward the back** — the fixed viewpoint these comments use — **positive Z is on the
	 * viewer's right (quad 1) and negative Z on the viewer's left (quad 4)**. "The belt lives in quads 1 and 4" is that
	 * statement once the origin is moved to the front-left corner in the user frame; in the code frame the same fact is
	 * "Z is not centred on zero at the edges, it is centred on the belt".
	 *
	 * ## Why the velocity is *set* and the other components are preserved
	 *
	 * `AssemblyLinearVelocity` is replaced only along the along-belt axis — only the component on `RightVector`. The
	 * vertical component is left to gravity (the ball still has to land, bounce and settle), so writing a full
	 * velocity vector every tick would flatten it and a ball that could not fall would never settle onto the floor slab.
	 *
	 * **The lateral component is the one exception, and it is deliberate.** The decorative sway below rewrites it for
	 * every ball that has sway state, because a sine wave expressed as velocity has to be written as velocity. The
	 * consequence is that a ball knocked sideways has its sideways motion overwritten on the next tick rather than
	 * carried: the sway is the only lateral intent this model has, and a collision is not allowed to leave a ball riding
	 * off the wave.
	 *
	 * **This loop is the only writer of the along-belt component, and it runs on `Heartbeat`.** Anything else that writes
	 * `AssemblyLinearVelocity` along `±X` between two ticks is overwritten here before it can accumulate, which is why the
	 * `BALL_SPEED` attribute is the only lever any other module has over a ball's motion.
	 *
	 * ## Why the attribute and not a service-side map
	 *
	 * The attribute is on the body, replicates with it, and dies with it — no cleanup on any of the four death paths, and
	 * a pickup (a different service) can raise it without an API call into this one.
	 *
	 * ## What it skips
	 *
	 * Only balls still parented are touched. The live array already holds exactly those, and the `Parent` test catches a
	 * body destroyed by `RoundService` between two frames, which would otherwise have its velocity written after the
	 * engine had already removed it.
	 */
	private stepBallSpeeds(dt: number): void {
		if (!this.roundActive) {
			return;
		}

		// The **reference** speed, not the ramp: `BALL_SPEED_START` equals it, so `RELATIVE_SPEED` starts at exactly
		// zero on the first `Playing` tick and only moves when decay or a pickup moves `BALL_SPEED`.
		const beltSpeed = this.treadmill.getReferenceBeltSpeed();
		const right = this.treadmill.getBeltRightVector();
		// Read once for the whole loop: it is the frame every ball's `localZ` is measured in.
		const beltFrame = this.treadmill.getBeltFrame();
		// Angular rate of the sway, `2 * pi * SWAY_FREQUENCY_HZ`. Hoisted and named because both the position wave and
		// its derivative use it: one expression for both means the velocity can never be the derivative of a *different*
		// frequency than the position it is meant to track.
		const swayOmega = 2 * math.pi * SWAY_FREQUENCY_HZ;

		for (const ball of this.liveBalls) {
			if (ball.Parent === undefined) {
				continue;
			}

			const speed = this.readNumber(ball, BALL_SPEED_ATTRIBUTE, BALL_SPEED_START);
			// `decayed`, not `next`: `next` is a Lua global and roblox-ts rejects the identifier outright.
			const decayed = math.max(BALL_SPEED_MIN, speed - BALL_SPEED_DECAY_RATE * dt);

			// **The powers speak once per ball per tick, and this loop is still the only writer.** `tickDelta` returns a
			// signed delta — a rocket's snap, an eclipse or magnet victim's extra decay — and the clamp is applied here so
			// that every contributor's arithmetic lands inside the model's range exactly once. A power that clamped its own
			// delta would disagree with one that did not.
			const delta = tickDelta(ball, { dt, roundActive: true });
			// `advanced`, not `next`: `next` is a Lua global and roblox-ts rejects the identifier outright — the same
			// reason the line above calls its intermediate `decayed`.
			const advanced = math.clamp(decayed + delta, BALL_SPEED_MIN, BALL_SPEED_MAX);
			if (advanced !== speed) {
				ball.SetAttribute(BALL_SPEED_ATTRIBUTE, advanced);
			}

			const relative = advanced - beltSpeed;
			// **`Boosted` first, then `TailWind` fed from it.** The ordering is the precedence guarantee: a client reading both
			// attributes in one frame can never see them both true, because the earlier write is the later write's input.
			const boosted = this.writeBoosted(ball, advanced, beltSpeed);
			this.writeTailWind(ball, relative, advanced, boosted);
			const velocity = ball.AssemblyLinearVelocity;
			const along = velocity.Dot(right);

			// ## The decorative sway - lateral, world Z
			//
			// Axis, and why it is not `LookVector`: a `CFrame`'s `LookVector` is its **-Z** axis, so the belt's local
			// **+Z** is `RightVector:Cross(UpVector)` (for `RightVector = +X` that is world `+Z`). Using `LookVector`
			// would sway toward local -Z, which works but disagrees with every `localZ` in the log and with
			// `PointToObjectSpace`, so the two would need negating against each other forever. `Cross` keeps the term and
			// the measurement in one frame. **Positive Z is the viewer's right from the front looking toward the back**,
			// and code-frame Z runs `-6 .. +6` across this belt.
			//
			// ## The law: a sine for position, its derivative for velocity
			//
			// The ball is driven to `z(t) = A * sin(omega * t + phase)` in code-frame Z. Physics integrates velocity, so
			// what this loop can write is the derivative, **`A * omega * cos(omega * t + phase)` - cosine, not sine**.
			// Writing the sine here is the trap worth restating: the sine is the *position*, so using it as a velocity
			// would move the ball fastest where the wave is slowest and slowest at its extremes, which shakes in place
			// instead of swaying.
			//
			// The second term is a correction toward the wave's *position*, `(targetZ - localZ) / SWAY_TRACK_SECONDS`, and
			// it is here for a measured reason rather than for tidiness. Integrating the derivative alone returns the wave
			// plus a constant, `A * sin(...) - A * sin(phase)`, added to wherever the ball already was; this game's spawn
			// lanes sit at code-frame Z `+-1` and `+-3`, so a ball would sway `+-A` around *its lane* instead of around the
			// belt's centre and reach `+-5` of the `+-5.5` the surface allows - a ball apparently about to fall off. With
			// the correction the offset decays as `e' = -e / SWAY_TRACK_SECONDS`, and `SWAY_AMPLITUDE` means what its
			// docblock says. It is a fixed time constant rather than a gain scaled by `omega`, so changing the frequency
			// cannot change how hard the correction pulls.
			const lateralState = this.lateral.get(ball);
			if (lateralState !== undefined && beltFrame !== undefined) {
				// This ball's own clock, in seconds since it spawned. Not a global time and not `os.clock()`: the latter
				// is CPU time on this platform, shared by every ball, and a ball spawned late would then begin part-way
				// into the wave at a velocity unrelated to its phase. Accumulating the same `dt` the engine integrates
				// with keeps position and velocity in one time base.
				lateralState.elapsed += dt;

				const localZ = beltFrame.PointToObjectSpace(ball.Position).Z;
				const angle = swayOmega * lateralState.elapsed + lateralState.phase;
				const targetZ = math.sin(angle) * SWAY_AMPLITUDE;
				const across = beltFrame.RightVector.Cross(beltFrame.UpVector).Unit;
				const lateralRate =
					SWAY_AMPLITUDE * swayOmega * math.cos(angle) + (targetZ - localZ) / SWAY_TRACK_SECONDS;
				const lateral = across.mul(lateralRate);
				ball.AssemblyLinearVelocity = velocity.sub(right.mul(along)).add(right.mul(-relative)).add(lateral);
				continue;
			}

			// Replace only the along-belt component: `velocity - right*along` is everything else (gravity and lateral
			// drift), and adding `right*relative` back in swaps the one component this model owns.
			//
			// **`-relative` because `RightVector` points toward the back.** `RightVector` is `+X`, and in this model `+X`
			// is toward the back (code-frame `+28` at the edge, user-X `56`); `-X` is toward the front, where the ball
			// spawns (code-frame `-23`, user-X `5`). A positive `RELATIVE_SPEED` means the ball is faster than the
			// reference and must gain ground toward the **front**, which is `-RightVector` in world space. So the multiply
			// is negated: the sign is the model's, not the world's. See this method's docblock for the full axis statement.
			//
			// Getting this wrong is visible and was: with `+relative`, a ball decaying below belt speed drifted to
			// code-frame `X = -28` and left the belt toward the front after ~11 s, i.e. it exited at the edge it spawned
			// beside. With the negation it drifts to code-frame `+28` and crosses the whole belt.
			ball.AssemblyLinearVelocity = velocity.sub(right.mul(along)).add(right.mul(-relative));
		}
	}

	/**
	 * Settles a ball's `Boosted` attribute from the two numbers this tick already computed.
	 *
	 * ## Why the answer is an attribute rather than a server-side map
	 *
	 * The effect it drives is built on each **client**, from a cloned asset parented to the ball — and a client cannot read
	 * server-side state. The attribute replicates with the body, dies with it, and needs no cleanup on any of the four death
	 * paths, which is the same argument `BALL_SPEED` itself is stored under.
	 *
	 * ## Why two thresholds and not one
	 *
	 * A single `BALL_SPEED >= BELT_SPEED` test would flip the flag on and off on consecutive frames as a decaying ball
	 * crossed the reference: `10.001` is boosted, `9.999` is not, and at `0.1` studs/s of decay the ball sits inside that
	 * +/- one-frame margin for a fifth of a second — long enough to strobe the effect. The band
	 * (`BOOST_HYSTERESIS`, 0.5 studs/s either side of nothing) means a ball becomes boosted on one confident edge and
	 * stops on another, and in between it keeps what it had.
	 *
	 * ## Why it is written here, on this line, and only on a change
	 *
	 * This is the one place that reads `BALL_SPEED` *after* every contributor has landed — the decay, the powers' delta and
	 * the clamp — so it is the only place that can answer the question correctly. It writes **only when the value actually
	 * changes**: the attribute replicates, and re-writing the same boolean sixty times a second per ball would be traffic
	 * carrying no information. The write happens in the same tick as the velocity write below it, so a client that reads
	 * `Boosted` and the body's velocity in one frame cannot see them disagree.
	 *
	 * **It returns the settled value**, because `TailWind` (item 100) has to know it without reading the attribute back — see
	 * `writeTailWind`. `undefined` means "still inside the band and never written", which is not the same as `false` and must
	 * not be treated as it.
	 */
	private writeBoosted(ball: BasePart, speed: number, beltSpeed: number): boolean | undefined {
		// `undefined` is a body that has not ticked yet; it behaves as `false` until the first write, and inside the band it
		// stays unset rather than being invented — the spawn draw guarantees the first tick is above the band anyway. The
		// narrowing is explicit because `GetAttribute` returns `AttributeValue`, not `boolean | undefined`.
		const raw = ball.GetAttribute(BOOSTED_ATTRIBUTE);
		const current = typeIs(raw, "boolean") ? raw : undefined;

		let settled = current;

		if (speed >= beltSpeed) {
			settled = true;
		} else if (speed < beltSpeed - BOOST_HYSTERESIS) {
			settled = false;
		}

		if (settled !== current && settled !== undefined) {
			ball.SetAttribute(BOOSTED_ATTRIBUTE, settled);
		}

		return settled;
	}

	/**
	 * Settles a ball's `TailWind` attribute: the trail for a ball that is **in regular motion** — losing ground, visibly rolling,
	 * and not boosted.
	 *
	 * ## The condition, and why each term is there
	 *
	 * `relative < 0` — the ball is slower than the belt reference, so it is drifting toward the back edge. That is "regular
	 * motion" and it is the opposite of a boost; a ball holding station (`relative = 0`) or gaining ground is not in the state
	 * this effect describes.
	 *
	 * `speed > SPIN_DEADBAND_SPEED` — the ball is rolling fast enough for the roll to be drawn at all. Below it
	 * `apparentSpinRate` returns `0`, so the skin is visibly still; a trail on a motionless ball would be describing something
	 * that is not happening. **This is the same threshold the roll renders at, imported rather than restated**, so "visibly
	 * rolling" means one thing in the tree.
	 *
	 * `boosted === false` — **the precedence rule, and it lives here because this is the only place that knows both facts in the
	 * same tick.** `windBoost` and `tailWind` must never both play, and a client cannot enforce that without a second copy of
	 * the rule: two controllers each checking the other's attribute is a rule with two owners, and the second one to be edited
	 * drifts. `boosted` is the value `writeBoosted` has just settled, passed in rather than read back off the attribute, so
	 * there is no window in which the two can disagree and no second attribute read per ball per tick.
	 *
	 * `Boosted` is written **before** this on the same tick, so `Boosted = true` and `TailWind = true` can never be observed
	 * together: the ordering is the guarantee, not a convention.
	 *
	 * ## No hysteresis, and why that is safe here
	 *
	 * Every term is monotone between events. `BALL_SPEED` only decays, so it crosses `BELT_SPEED` once on the way down; the
	 * `Boosted` term already carries `BOOST_HYSTERESIS`, which holds it true until `BELT_SPEED - 0.5`, so the handover from
	 * `windBoost` to `tailWind` happens once, at `9.5`, rather than at the `10` boundary where a one-tick dither would have
	 * shown. `SPIN_DEADBAND_SPEED` is crossed once per ride in the same direction. A pickup or a rocket raises the speed and
	 * hands the state back, which is an event and not a boundary flicker.
	 */
	private writeTailWind(ball: BasePart, relative: number, speed: number, boosted: boolean | undefined): void {
		const raw = ball.GetAttribute(TAIL_WIND_ATTRIBUTE);
		const current = typeIs(raw, "boolean") ? raw : undefined;
		const wanted = relative < 0 && speed > SPIN_DEADBAND_SPEED && boosted === false;

		if (wanted !== current) {
			ball.SetAttribute(TAIL_WIND_ATTRIBUTE, wanted);
		}
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
				this.lateral.delete(ball);
				this.startSpeeds.delete(ball);
				forgetBallPower(ball);
				this.forgetDecoy(ball);
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
		// `lateral` and `startSpeeds` were missing from this block until this round: `pruneDestroyedBalls` clears them for a
		// body that left the world by itself, but a body removed *here* is taken out of `liveBalls` before `Destroy()`, so
		// the prune never sees it and both maps grew by one entry per cap and kill-plane destruction for the session. Found
		// while placing `forgetBall` in this block, which is the same bug for a third map.
		this.lateral.delete(ball);
		this.startSpeeds.delete(ball);
		this.forgetDecoy(ball);
		const index = this.liveBalls.indexOf(ball);
		if (index !== -1) {
			this.liveBalls.remove(index);
		}
		ball.Destroy();

		// **After `Destroy()`, not before it.** `Destroying` runs synchronously inside that call, and `RoundService`'s
		// handler for it reads the powers module's last-touch record to decide who hears the elimination sound (item 87).
		// Clearing before the destroy would erase the answer before the question is asked — and every cull by `KillY` or
		// the live-ball cap would be silent, with nothing in the log to say why. Nothing else in this block depends on the
		// order: the maps above are keyed on the body itself and the handler never reads them.
		forgetBallPower(ball);
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

		// **The owner is what makes a cap eviction a gameplay event rather than housekeeping.** Every body
		// now carries an owner, so a cap that removes one is removing *a competitor* — and a cap that eats
		// competitors silently would look like a round where half the field never arrived. Printed on every
		// cap line, tracked or not, because the interesting case is precisely the body this service never
		// logged.
		const ownerName = ball.GetAttribute(OWNER_DISPLAY_NAME_ATTRIBUTE);
		const owner = ball.GetAttribute(OWNER_USER_ID_ATTRIBUTE);
		const ownerField = `owner=${typeIs(owner, "number") ? tostring(owner) : "none"}(${typeIs(ownerName, "string") ? ownerName : "none"})`;

		if (belt === undefined || belt.Parent === undefined) {
			print(
				`[Ball:${id}] cap destroy pos=${formatVector(ball.Position)} no belt resolvable, footprint unknown ${ownerField}`,
			);
			return;
		}

		// **`local=` in this line and every other `local=` field is `PointToObjectSpace`: the code frame, origin at the
		// belt's centre.** `user-frame X = this.X + 28` (0 is the front edge, so the belt runs 0..56) and
		// `user-frame Z = this.Z + 6` (0 is one side edge, so the belt runs 0..12). A log that says `local=(-23, _, 0)` is
		// user `X = 5`, on the centreline. See `stepBallSpeeds` for the full axis statement.
		const relative = belt.CFrame.PointToObjectSpace(ball.Position);
		const halfX = belt.Size.X / 2;
		const halfZ = belt.Size.Z / 2;
		const halfY = belt.Size.Y / 2;
		const inside = math.abs(relative.X) <= halfX && math.abs(relative.Z) <= halfZ;

		print(
			`[Ball:${id}] cap destroy at pos=${formatVector(ball.Position)} local=${formatVector(relative)} aboveSurface=${formatNumber(relative.Y - halfY)} insideFootprint=${inside ? "yes" : "no"} velocity=${formatVector(ball.AssemblyLinearVelocity)} BALL_SPEED=${formatNumber(ball.AssemblyLinearVelocity.Dot(belt.CFrame.RightVector))} BELT_SPEED=${formatNumber(this.readNumber(belt, BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED))} ${ownerField} ${this.describeOwner(ball)}`,
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
			spinProbeLogged: false,
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
	 * Places three visual markers — two pole dots and one equatorial band — on a spawned body.
	 *
	 * ## Why this exists at all
	 *
	 * A sphere has no features, so a sphere rolling at belt speed is pixel-identical to a sphere
	 * sitting still. The texture route has already cost two rounds and still does not render on a
	 * curved primitive. Ordinary parts cannot fail to render.
	 *
	 * ## Why the decorations cannot disturb the experiment
	 *
	 * `CanCollide = false` — a colliding pole marker would make the body bounce on its own marker, so
	 * the surface under test would no longer be the belt. This is the single most important property
	 * here, and it is unchanged by anchoring: an anchored, non-colliding part affects nothing the body
	 * does.
	 *
	 * `Massless = true` — historical, and now inert. It mattered when the markers were welded into the
	 * body's assembly and a non-massless marker would have doubled its inertia; an anchored marker is
	 * in no assembly at all, so the flag changes nothing. It is left in place rather than removed
	 * because it costs one property write and because re-welding them would silently need it back.
	 *
	 * `Anchored = true` — **reversed from the welded version**, and the reversal is the point of this
	 * round. An anchored marker cannot follow the body, which is exactly what lets the client draw it
	 * at a rate of its own choosing; see `createMarker` for why the client-side de-weld alternative is
	 * not defined behaviour.
	 *
	 * ## Why the markers are still children of the body
	 *
	 * Ancestry is what gets a marker destroyed with its body, and that is unchanged by anchoring: the
	 * cap, the kill plane and round teardown all `Destroy()` the body, and children go with it. What
	 * the weld used to provide — the marker staying *on* the ball — is now the client's job.
	 *
	 * ## Ordering
	 *
	 * The body is already parented when this runs, and each marker is parented before its tags and
	 * attributes replicate, so a client always receives a marker that already knows its local offset.
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
	 * Builds one non-colliding, massless visual marker under the body, anchored at its spawn pose.
	 *
	 * `Neon` material rather than `SmoothPlastic`: these exist to be tracked by eye at a glance and at a
	 * distance, and Neon is unaffected by the scene's lighting, so the markers stay legible regardless
	 * of time of day or shadow. The cost is that Neon blooms slightly at close range, which is
	 * irrelevant for a test marker and preferable to a marker that disappears in shadow.
	 *
	 * ## Why there is no weld here any more
	 *
	 * The markers are drawn by `MarkerSpinController` at a rate that is *not* the body's physical
	 * angular velocity, so they must stop inheriting the body's `CFrame` rigidly. Two mechanisms could
	 * have done that, and only one of them is defined behaviour:
	 *
	 * **Rejected: destroy the weld on the client.** A client-side `Destroy()` of a server-created
	 * constraint is local, so it looks like it should work — but the marker is then an unanchored part
	 * whose `CFrame` is simulated for a server-owned assembly, and a client cannot drive the `CFrame`
	 * of a part the server simulates: the next physics step or replication overwrites the write. The
	 * controller would be fighting the solver every frame, and whether it won would depend on assembly
	 * ordering rather than on anything documented.
	 *
	 * **Chosen: never create the weld, and anchor the marker.** `Anchored = true` makes the marker's
	 * `CFrame` an ordinary replicated property that the server sets exactly once, at spawn. A client
	 * writing that property locally is therefore not in contention with anything: no replication of it
	 * ever follows, because the server never touches it again. That is what makes
	 * `MarkerSpinController`'s per-frame writes stable rather than a race.
	 *
	 * **The cost, named because it is real:** a client that is not running the controller — before it
	 * loads, or a Studio session with the script disabled — sees the markers parked at the ball's spawn
	 * position instead of on the ball. The server view has the same problem permanently, which is
	 * survivable because nothing renders the server view. The alternative was a marker that visibly
	 * jitters, which is worse than one that is briefly in the wrong place.
	 *
	 * ## Why the local offset is written as attributes
	 *
	 * With no weld, the client has to rebuild each marker's pose as `body.CFrame * spin * localFrame`.
	 * That `localFrame` cannot be derived on the client: the marker stays at its spawn pose while the
	 * body moves, so `body.CFrame:Inverse() * marker.CFrame` is only the true offset in the frame the
	 * body spawned in, which the controller never observes. Three `Vector3` attributes (`attributes.ts`)
	 * carry position and two basis vectors, which is exact — `CFrame.fromMatrix` fills in the third.
	 * Setting them before `Parent` means they arrive with the marker rather than as separate
	 * replication events.
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
		marker.CanCollide = false;
		marker.Massless = true;
		marker.CastShadow = false;
		marker.TopSurface = Enum.SurfaceType.Smooth;
		marker.BottomSurface = Enum.SurfaceType.Smooth;

		// Anchored, unlike the welded version: see the mechanism note above. The server places it once
		// and then leaves it alone, which is what frees the client to draw it.
		marker.Anchored = true;

		// The marker's pose relative to the body, in the body's own frame, captured *before* anything
		// can move. `ToObjectSpace` is `ball.CFrame:Inverse() * cframe` per the typings, and both
		// CFrames are the spawn values here, so this is exact rather than approximate.
		const localFrame = ball.CFrame.ToObjectSpace(cframe);
		marker.SetAttribute(MARKER_LOCAL_POSITION_ATTRIBUTE, localFrame.Position);
		marker.SetAttribute(MARKER_LOCAL_RIGHT_ATTRIBUTE, localFrame.RightVector);
		marker.SetAttribute(MARKER_LOCAL_UP_ATTRIBUTE, localFrame.UpVector);

		// Parented to the body, not to the body's folder. This is what makes cleanup free: `Destroy()` on
		// the body takes its descendants with it, so the cap and the kill plane cannot leave markers
		// behind. A welded *sibling* would survive its body being destroyed and would accumulate at
		// spawn rate until the server ran out of room. Anchoring does not change this — ancestry, not the
		// constraint, is what gets a child destroyed with its parent.
		marker.Parent = ball;

		CollectionService.AddTag(marker, TAGS.ballDecoration);
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

	/**
	 * TEMPORARY INSTRUMENTATION. One line per body, `SPIN_PROBE_SECONDS` after spawn, describing how
	 * the body is actually turning.
	 *
	 * ## Why this exists in a round about markers
	 *
	 * The markers now spin at a rate derived from the body's *linear* velocity, which means a body
	 * sliding with zero physical spin renders exactly like one rolling. That destroys the diagnostic the
	 * markers were originally built for, and no amount of looking at the screen restores it. This line
	 * restores it in text: `|omega|` is the body's real angular speed, and `contactSlip` separates a
	 * rolling body from a sliding one.
	 *
	 * ## `contactSlip` and its sign
	 *
	 * `contactSlip = u - (ballSpeed + omega*r)`: the contact point's speed relative to the surface it is on, with the
	 * sign chosen so **positive means the contact point is moving slower than the belt**, i.e. friction is pushing the
	 * body forward and it has not reached rolling equilibrium. Zero is rolling-without-slipping and negative means the
	 * contact is outrunning the belt. Reading it as "how far from rolling is this body" is the whole point, and that
	 * reading only works with this sign.
	 *
	 * **Since item 92 nothing in the tree writes `AssemblyAngularVelocity`, so `omega` here is structurally zero** and
	 * `contactSlip` reduces to `u - ballSpeed`. The fields are kept rather than simplified: this is temporary
	 * instrumentation whose job is to report what the engine did, and a probe that computed its own answer from a
	 * constant would stop being able to notice the day something started spinning a body again.
	 *
	 * `omega` is projected onto the rolling axis (`RightVector:Cross(yAxis)`), not
	 * taken as `|AssemblyAngularVelocity|`, because a body spinning about a different axis is not
	 * rolling along the belt and would otherwise be credited with spin it does not have in the
	 * direction that matters. `|omega|` is printed alongside as the raw magnitude so the two can be
	 * compared: if they differ, the body is spinning about the wrong axis, which is itself the answer
	 * to a different question.
	 *
	 * Server-side on purpose. `AssemblyAngularVelocity` and `AssemblyLinearVelocity` are both tagged
	 * **NotReplicated** in the installed typings, so a client cannot read them as replicated state —
	 * the server is the only place they are authoritative.
	 */
	private reportSpinProbe(ball: BasePart, belt: BasePart, beltSpeed: number, velocity: Vector3): void {
		const radius = ball.Size.Y / 2;
		const axisRaw = belt.CFrame.RightVector.Cross(Vector3.yAxis);
		const omega = axisRaw.Magnitude < 1e-3 ? 0 : ball.AssemblyAngularVelocity.Dot(axisRaw.Unit);
		const ballSpeed = velocity.Dot(belt.CFrame.RightVector);
		const contactSlip = beltSpeed - (ballSpeed + omega * radius);

		print(
			`[Spawner] spin-probe ball="${ball.GetFullName()}" |omega|=${formatNumber(ball.AssemblyAngularVelocity.Magnitude)} omegaAlong=${formatNumber(omega)} omegaR=${formatNumber(omega * radius)} |v|=${formatNumber(velocity.Magnitude)} BALL_SPEED=${formatNumber(ballSpeed)} u=${formatNumber(beltSpeed)} r=${formatNumber(radius)} contactSlip=${formatNumber(contactSlip)}`,
		);
	}

	private observeBall(ball: BasePart, observation: BallObservation, belt: BasePart, now: number): void {
		const velocity = ball.AssemblyLinearVelocity;
		const beltSpeed = this.readNumber(belt, BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED);

		// TEMPORARY INSTRUMENTATION. The one-shot spin probe. Runs before anything else in this pass so a
		// body that gets destroyed by the cap on the same tick still reports first, and so the line
		// appears in spawn order relative to the other one-shots.
		if (!observation.spinProbeLogged && now - observation.spawnedAt >= SPIN_PROBE_SECONDS) {
			observation.spinProbeLogged = true;
			this.reportSpinProbe(ball, belt, beltSpeed, velocity);
		}

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
				// magnitude. `ballSpeed ~= BeltSpeed` means it is being carried; `ballSpeed ~= 0` means
				// the surface is moving underneath a ball that is not moving with it.
				//
				// `overFootprint` exists because the magnitude test alone is easy to misread: a ball spawned
				// above the belt reaches any threshold from gravity alone, before it has touched anything.
				// `overFootprint=yes vertical=above-surface` means it was still in the air over the belt, so
				// this line says nothing about the belt yet; `overFootprint=yes level-with-body` with
				// `ballSpeed` near zero is a ball actually sitting on the belt and not being carried. The
				// sample series and the leave line are what settle it either way.
				//
				// Ownership is re-read here, not carried over from the spawn line, because engine ownership
				// can be reassigned between the two moments and the spawn reading may predate the
				// assignment — see `describeOwner`. A change between the two lines is itself a finding.
				print(
					`[Ball:${observation.id}] first motion after ${formatNumber(now - observation.spawnedAt)}s velocity=${formatVector(velocity)} speed=${formatNumber(velocity.Magnitude)} BALL_SPEED=${formatNumber(velocity.Dot(belt.CFrame.RightVector))} BELT_SPEED=${formatNumber(beltSpeed)} threshold=${formatNumber(threshold)} overFootprint=${overFootprint ? "yes" : "no"} vertical=${vertical} local=${formatVector(relative)} touches=${observation.touchedCount} ${this.describeOwner(ball)}`,
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
				`[Ball:${observation.id}] left belt side=${side} after ${formatNumber(now - observation.spawnedAt)}s at pos=${formatVector(ball.Position)} local=${formatVector(relative)} half=(x=${formatNumber(halfX)}, z=${formatNumber(halfZ)}) overshoot=${formatNumber(overshoot)} vertical=${vertical} (localY=${formatNumber(relative.Y)}, halfY=${formatNumber(halfY)}) velocity=${formatVector(velocity)} BALL_SPEED=${formatNumber(velocity.Dot(belt.CFrame.RightVector))} BELT_SPEED=${formatNumber(beltSpeed)} touches=${observation.touchedCount} ${this.describeOwner(ball)}`,
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
	 * independently of the one-shot events: a riding ball holds `ballSpeed` near `BeltSpeed` while
	 * `local.X` marches toward the edge, a sliding ball holds `ballSpeed` away from `BeltSpeed` while
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
		// The three numbers that describe this model, all in one line: the ball's own speed from its
		// attribute, the reference belt speed, and the difference ? which is the velocity the physics engine
		// is being handed every tick. `velocity=` stays because it is the *observed* value from the engine, so
		// a disagreement between it and `RELATIVE_SPEED` is visible rather than hidden.
		const ballSpeed = this.readNumber(ball, BALL_SPEED_ATTRIBUTE, 0);
		// The model's reference, so `RELATIVE_SPEED` in the line is the number the simulation used.
		const beltSpeed = this.treadmill.getReferenceBeltSpeed();
		// The sway, so the lateral motion is readable from the log rather than only from the screen: `localZ` is where
		// the ball is across the belt, `swayPhase` where in its own wave it is. The two together tell a ball that is
		// tracking its wave from one that has not found it yet.
		const localPoint = belt.CFrame.PointToObjectSpace(ball.Position);
		const sway = this.lateral.get(ball);
		const swayPhase = sway === undefined ? "none" : formatNumber(sway.phase);
		print(
			`[Ball:${observation.id}] sample t=${formatNumber(os.clock() - observation.spawnedAt)}s pos=${formatVector(ball.Position)} local=${formatVector(localPoint)} localZ=${formatNumber(localPoint.Z)} swayPhase=${swayPhase} velocity=${formatVector(velocity)} BALL_SPEED=${formatNumber(ballSpeed)} BELT_SPEED=${formatNumber(beltSpeed)} RELATIVE_SPEED=${formatNumber(ballSpeed - beltSpeed)} ${this.describeOwner(ball)}`,
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
