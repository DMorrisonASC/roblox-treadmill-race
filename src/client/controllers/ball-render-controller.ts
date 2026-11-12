import { CollectionService, ReplicatedStorage, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { BALL_SPEED_ATTRIBUTE, GHOST_ACTIVE_ATTRIBUTE } from "shared/attributes";
import { GHOST_TRANSPARENCY_WHILE_ACTIVE } from "shared/config/ghost.config";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import { BALL_PHANTOM_NAME } from "shared/tuning";
import { apparentSpinAxis, apparentSpinRate } from "shared/apparent-spin";

/**
 * Frames between re-orthonormalisations of the accumulated roll.
 *
 * A product of ~18,000 rotation matrices a minute drifts off unit scale, and a drifted basis makes the phantom's texture
 * breathe. The same number the marker controller uses, because it is the same accumulation.
 */
const NORMALIZE_EVERY_FRAMES = 300;

/** How long to wait for `RoundState` before giving up and saying so; the tree's bounded-wait convention (item 13). */
const ROUND_STATE_WAIT_SECONDS = 10;

/** TEMPORARY INSTRUMENTATION (item 197). Seconds between `probe` samples. */
const PROBE_INTERVAL_SECONDS = 1;

/** TEMPORARY INSTRUMENTATION (item 197). Total `probe` lines this session, so the diagnostic cannot flood. */
const PROBE_LINE_LIMIT = 16;

/**
 * The one phase the ball rolls in.
 *
 * **A phase gate, not a speed gate (item 196).** The rate is `SPIN_BASE_RAD_PER_SEC + gain x BALL_SPEED`, so `0` speed is a
 * real rate — and that is correct during `Playing`, where a ball at `BALL_SPEED = 0` is sliding across the tread and must
 * roll. It is wrong in `Waiting` and `PostGame`, where the belt is stopped and the ball is genuinely at rest. The old model
 * answered both with one deadband on the speed, which is why a sliding ball had a frozen skin.
 */
const ROLLING_PHASE = "Playing";

/** One body's visible stand-in, and the roll it has accumulated. */
interface PhantomState {
	readonly phantom: BasePart;
	/** Accumulated world-space roll about the belt's spin axis. Rotation only — the position comes from the ball. */
	spin: CFrame;
	framesSinceNormalize: number;
	/**
	 * Whether the ghost fade is currently applied to this phantom and its cloned textures.
	 *
	 * Kept so the attribute can be read every frame while the *writes* happen only on a transition - a ghost cycles twice a
	 * minute, and writing seven properties per frame for a state that has not changed is the kind of cost this tree removes.
	 */
	dimmed: boolean;
}

/**
 * Gives every ball a **client-side skin that rolls about the belt's spin axis**, and hides the physical ball.
 *
 * ## Why the physical ball is not the thing that rolls
 *
 * The engine integrates whatever torque contact resolution produces into the ball's `CFrame.Rotation`, and that direction is
 * not the model's: a ball riding a belt reads as being knocked around rather than as rolling along it. Nothing in the tree
 * reads a ball's own rotation — `windBoost` takes a position and an authored rotation, `hitEffect` a midpoint,
 * `PowerBadge` a position — so once the ball is hidden its physical orientation is unobservable, which is what makes a
 * purely visual replacement safe.
 *
 * **The server is not touched.** Item 92 deleted the last write to `AssemblyAngularVelocity` and this round does not bring
 * one back, because it would not achieve a frozen body: zeroing the angular velocity between steps does not reset the
 * orientation already accumulated, and torque applied during the next physics step is integrated before the next
 * `Heartbeat` runs. The rotation would be reduced, not removed, at the price of a physics write per body per tick. Hiding
 * the ball is complete and costs nothing.
 *
 * ## What a phantom is, and where it lives
 *
 * A `Part` with `Shape = Ball`, the ball's size, colour and material, and **copies of the ball's six face textures**, parented
 * to the ball it stands in for. A child rather than an entry in a `Workspace` folder because that is the pattern the markers
 * already use: ancestry is what gets it destroyed with the body on every one of the four death paths, with no map to sweep
 * on a schedule and no lookup to keep in step. `LocalTransparencyModifier = 1` on the real ball hides **the sphere** on this
 * client only — the property is `NotReplicated`, so the server's Explorer still shows the ball and no other client is affected.
 * **Its textures need hiding separately**, because a `Decal`/`Texture` renders on an invisible part; see `copyTextures`.
 *
 * ## Position from the ball, rotation from the roll
 *
 * `phantom.CFrame = new CFrame(ball.Position) * spin`, where `spin` is this controller's own accumulated rotation about the
 * belt's spin axis. **`ball.CFrame.Rotation` is never read** — that would hand the skin back the physics tumble this exists
 * to remove. The ball's position is replicated, so the skin can be no smoother than the ball; it is never *behind* by more
 * than a frame, because this runs on `RenderStepped`.
 *
 * ## Who poses the markers
 *
 * The markers and the skin must turn **together**, so there is one rotation rather than two: this controller writes the
 * phantom's `CFrame`, and `marker-spin-controller` poses its markers inside that frame instead of accumulating an angle of
 * its own. One angle, one place it is computed, and the two cannot drift apart. The rate and the axis are pure functions in
 * `shared/apparent-spin.ts`, so the two files cannot disagree about the formula even in the marker controller's fallback.
 */
@Controller()
export class BallRenderController implements OnStart {
	private readonly phantoms = new Map<BasePart, PhantomState>();
	private readonly connections = new Array<RBXScriptConnection>();

	/** The belt the roll is taken about; resolved by tag and cached. See `beltRight`. */
	private cachedBelt?: BasePart;

	/**
	 * The phase the server last published, kept rather than re-read per frame.
	 *
	 * Read once in `onStart` and then subscribed — the same shape `marker-spin-controller` and `decoy-outline-controller` use,
	 * and the same `StringValue`, so there is one source and no second reader of the phase. Defaults to `""`, which is not
	 * `Playing`, so a client whose `RoundState` has not replicated yet draws no rotation rather than a gate that opens by
	 * accident.
	 */
	private phase = "";

	/** TEMPORARY INSTRUMENTATION (item 197). Last `probe` time and line count. */
	private probeAt = 0;
	private probeLines = 0;
	/** TEMPORARY INSTRUMENTATION (item 197). Each body's position at the previous `probe`. */
	private readonly probePrevious = new Map<BasePart, Vector3>();

	public onStart(): void {
		// Both discovery paths, for the reason `marker-spin-controller` keeps both: the tag signal is the one that works, and
		// the startup scan is what catches a client joining mid-`Playing` with bodies already in the world. Without the scan a
		// late joiner sees unrendered balls — the failure item 30 fixed in the marker controller.
		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			this.track(instance);
		}

		this.connections.push(
			CollectionService.GetInstanceAddedSignal(TAGS.ball).Connect((instance) => this.track(instance)),
		);
		this.connections.push(
			CollectionService.GetInstanceRemovedSignal(TAGS.ball).Connect((instance) => {
				if (instance.IsA("BasePart")) {
					this.phantoms.delete(instance);
				}
			}),
		);
		this.connections.push(RunService.RenderStepped.Connect((dt) => this.step(dt)));

		// **The phase, read once and then subscribed.** Bounded wait for the tree's usual reason: an unbounded `WaitForChild`
		// turns "the server never created it" into a silent infinite yield. A failure is non-fatal — the phantoms are still
		// built, they simply never roll, which is the honest degraded state.
		const state = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (state === undefined || !state.IsA("StringValue")) {
			warn(
				`[BallRender] no ${ROUND_STATE_VALUE_NAME} after ${ROUND_STATE_WAIT_SECONDS}s — the roll stays off (no phase to allow it).`,
			);
		} else {
			this.phase = state.Value;
			this.connections.push(
				state.GetPropertyChangedSignal("Value").Connect(() => {
					this.phase = state.Value;
				}),
			);
		}

		print(`[BallRender] watching ${TAGS.ball}; phantoms=${this.phantoms.size()} phase=${this.phase}`);
	}

	/**
	 * Builds one ball's phantom and hides the ball behind it.
	 *
	 * Idempotent: a repeated added-signal for a body that already has a live phantom returns immediately, and a body whose
	 * phantom has gone is rebuilt rather than left skinless.
	 */
	private track(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		const ball = instance;
		const existing = this.phantoms.get(ball);
		if (existing !== undefined && existing.phantom.Parent !== undefined) {
			return;
		}

		const phantom = new Instance("Part");
		phantom.Name = BALL_PHANTOM_NAME;
		// **`Ball` explicitly, not copied from the ball.** `Shape` is declared on `Part`, not `BasePart`, and this tree's pool is
		// spheres-only (item 12) — a future non-sphere entry would need this line visited, the same note the marker controller
		// carries about reading `Size.Y` as the diameter.
		phantom.Shape = Enum.PartType.Ball;
		phantom.Size = ball.Size;
		phantom.Color = ball.Color;
		phantom.Material = ball.Material;

		// **The surfaces are copied, not left at their defaults.** A fresh `Part` is `Studs`/`Inlet`, while the spawner sets both to
		// `Smooth` on every body — so the phantom would carry a surface treatment the ball it replaces does not, which on a shape
		// whose surface is drawn (a future `Block` entry) would be a visible patch of studs. One conditional, and the phantom is a
		// faithful copy of the part it stands in for rather than of a default `Part`.
		if (ball.IsA("Part")) {
			phantom.TopSurface = ball.TopSurface;
			phantom.BottomSurface = ball.BottomSurface;
		}
		phantom.Anchored = true;
		phantom.CanCollide = false;
		phantom.CanQuery = false;
		phantom.CanTouch = false;
		phantom.CastShadow = false;
		// The pose the first frame uses; the ball is hidden in the same breath, so this state is never rendered.
		phantom.CFrame = new CFrame(ball.Position);

		this.copyTextures(ball, phantom);

		phantom.Parent = ball;
		this.phantoms.set(ball, { phantom, spin: new CFrame(), framesSinceNormalize: 0, dimmed: false });

		// Hidden only once the skin exists, so there is no frame in which the ball has vanished and nothing has replaced it.
		ball.LocalTransparencyModifier = 1;
	}

	/**
	 * Copies the ball's face textures onto the phantom by **cloning the `Texture` instances**, and then hides the originals.
	 *
	 * The server writes one `Texture` per face with a random per-body tile offset, and sets `ColorMapContent` *and* the legacy
	 * `Texture` string (the doubled write exists because a Studio run showed the modern slot reading back correctly while
	 * rendering nothing). Re-creating those here would be a second implementation of a write with a documented failure mode; a
	 * clone carries every property already put and every property added later.
	 *
	 * ## Why the source textures have to be hidden explicitly (item 99)
	 *
	 * **A `Decal` or `Texture` renders on a fully transparent part.** That is long-standing engine behaviour — it is what
	 * makes "invisible part, visible image" work — and it means `LocalTransparencyModifier = 1` on the *part* hides the
	 * sphere but leaves its six texture children drawing at the ball's own pose, unrolled, underneath the phantom. The
	 * reported symptom was exactly that: a stray square on the ball, which is one face of the physics-oriented texture
	 * showing through the rolled skin.
	 *
	 * The fix is the same property one level down: `Texture extends Decal`, and `Decal.LocalTransparencyModifier` is the
	 * documented local-only multiplier, so each source gets `1` on this client and the clones keep theirs at `0`. A
	 * client-only write is stable here because the server sets these instances once at spawn and never touches them again.
	 */
	private copyTextures(ball: BasePart, phantom: BasePart): void {
		for (const child of ball.GetChildren()) {
			if (!child.IsA("Texture")) {
				continue;
			}

			const copy = child.Clone();
			// The copy has to be parented before it can be seen, and the original has to stop being seen; both writes are local
			// to this client, so the server's ball is untouched and every other client still gets its own phantom pair.
			child.LocalTransparencyModifier = 1;
			copy.Parent = phantom;
		}
	}

	/**
	 * Fades or restores a phantom's **visible skin** while the body it stands for is an intangible ghost.
	 *
	 * ## Two writes, and the second is the one that matters
	 *
	 * **A `Texture` renders on a fully transparent part** - the same engine fact `copyTextures` exists for (item 99). So
	 * `phantom.Transparency` alone fades only the sphere underneath the six face images and leaves the skin itself solid, which
	 * would read as a half-done ghost. Each cloned `Texture` needs its own `Transparency`.
	 *
	 * ## Why the clone's `Transparency` and not its `LocalTransparencyModifier`
	 *
	 * `LocalTransparencyModifier` is the property `copyTextures` uses to hide the **source** textures on this client (item 98):
	 * a local-only multiplier, with the clones deliberately left at `0` so the phantom's images draw normally. Fading the clone
	 * is a statement about what should be seen, not about what this client may see, so it belongs on `Transparency` - the
	 * property the drawn result is a function of - and it must leave the source's `1` alone, or the un-rolled originals would
	 * reappear underneath.
	 *
	 * Restoring writes `0` rather than unsetting anything: `Transparency` has no unset state, and `0` is what the clone was
	 * born with.
	 */
	private applyGhostSkin(phantom: BasePart, dimmed: boolean): void {
		const transparency = dimmed ? GHOST_TRANSPARENCY_WHILE_ACTIVE : 0;

		phantom.Transparency = transparency;

		for (const child of phantom.GetChildren()) {
			if (child.IsA("Texture")) {
				child.Transparency = transparency;
			}
		}
	}

	/** The belt's `RightVector`, or `+X` before a belt has replicated. See `apparentSpinAxis` for what it feeds. */ private beltRight(): Vector3 {
		if (this.cachedBelt === undefined || this.cachedBelt.Parent === undefined) {
			this.cachedBelt = undefined;

			for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
				if (instance.IsA("BasePart") && instance.Parent !== undefined) {
					this.cachedBelt = instance;
					break;
				}
			}
		}

		return this.cachedBelt === undefined ? Vector3.xAxis : this.cachedBelt.CFrame.RightVector;
	}

	/** Advances every phantom's roll and copies it onto the part. One loop, one connection, `RenderStepped`. */
	private step(frameDt: number): void {
		const axis = apparentSpinAxis(this.beltRight());
		const dead = new Array<BasePart>();
		// **The phase gate, and it holds the accumulated frame rather than resetting it.** Outside `Playing` the position is still
		// copied onto the phantom — a frozen ball must stay where its body is, and a body spawned into `Waiting` must be drawn at
		// all — but `spin` is not advanced. Holding is the right answer: a ball frozen on a stopped belt has no canonical facing,
		// so snapping it to the identity would spin the texture by up to a quarter turn at `PostGame` entry and again at the next
		// `Playing`, which is two visible jumps for no information. The accumulator survives because it is this controller's own
		// state and nothing about a phase change invalidates a rotation.
		const rolling = this.phase === ROLLING_PHASE;

		for (const [ball, state] of this.phantoms) {
			if (ball.Parent === undefined || state.phantom.Parent === undefined) {
				dead.push(ball);
				continue;
			}

			if (rolling) {
				const raw = ball.GetAttribute(BALL_SPEED_ATTRIBUTE);
				const speed = typeIs(raw, "number") && raw === raw ? raw : 0;
				// **`BALL_SPEED` is the belt-relative speed, not the world speed** - see `APPARENT_SPIN_GAIN`. The server
				// writes the world velocity as `BELT_SPEED - BALL_SPEED`, and `BALL_SPEED_START` equals the belt speed so a
				// fresh ball holds station: that identity only exists because `BALL_SPEED` measures travel *through the
				// belt's reference* rather than across the ground. Subtracting the belt here as well would draw a ball that
				// holds station as motionless *and unrotating* while the tread runs underneath it, which is sliding.
				const omega = apparentSpinRate(speed);

				state.spin = CFrame.fromAxisAngle(axis, omega * frameDt).mul(state.spin);
				state.framesSinceNormalize++;

				if (state.framesSinceNormalize >= NORMALIZE_EVERY_FRAMES) {
					state.framesSinceNormalize = 0;
					state.spin = CFrame.fromMatrix(Vector3.zero, state.spin.RightVector.Unit, state.spin.UpVector.Unit);
				}
			}

			state.phantom.CFrame = new CFrame(ball.Position).mul(state.spin);

			// **The ghost fade, applied from the state the server publishes (item 204).** Read every frame - one attribute read
			// beside the `BALL_SPEED` read above - but \`applyGhostSkin\` writes only when the value changed, because a ghost
			// cycles twice a minute and seven property writes per frame for an unchanged state is pure cost.
			const dimmed = ball.GetAttribute(GHOST_ACTIVE_ATTRIBUTE) === true;
			if (dimmed !== state.dimmed) {
				state.dimmed = dimmed;
				this.applyGhostSkin(state.phantom, dimmed);
			}
		}

		// Removal is deferred: mutating a `Map` while iterating it is unspecified in Luau, and the symptom — a skipped ball —
		// would look exactly like the bug this map exists to avoid.
		for (const ball of dead) {
			this.phantoms.delete(ball);
		}

		this.probe(frameDt, rolling);
	}

	/**
	 * TEMPORARY INSTRUMENTATION (item 197). **What this client actually draws, versus what the server actually has.**
	 *
	 * The report is "the balls travel along the belt during `Waiting`", and the server disagrees flatly: the sample line from
	 * the same run shows one body's `along=0`, `velocity=(0, 0, 0)` and a position that does not change by a thousandth of a
	 * stud for twenty-seven seconds with `roundActive=false`. So either a *client-side* object is moving, or the movement is
	 * something other than a body — and the only client-side object that can be mistaken for a ball is this phantom.
	 *
	 * One line per second while the roll is gated, carrying three facts that separate the possibilities:
	 *
	 * - `ballΔ` — how far the replicated ball moved this second. Zero means the server is frozen, as the sample says.
	 * - `phantomΔ` — how far the phantom moved. **A non-zero value beside a zero `ballΔ` is the bug**: the client is drawing
	 *   motion that does not exist, and nothing but this loop writes that part.
	 * - `drift` — the distance between the phantom and its ball, which should be exactly `0`: the phantom's `CFrame` is
	 *   rebuilt from `ball.Position` every frame, so anything else means the pose is not the one this loop just wrote.
	 *
	 * Capped and phased like every other diagnostic here: a handful of lines, then silence.
	 */
	private probe(frameDt: number, rolling: boolean): void {
		if (rolling || this.probeLines >= PROBE_LINE_LIMIT) {
			return;
		}

		const now = os.clock();
		if (now - this.probeAt < PROBE_INTERVAL_SECONDS) {
			return;
		}

		const elapsed = this.probeAt === 0 ? 0 : now - this.probeAt;
		this.probeAt = now;

		for (const [ball, state] of this.phantoms) {
			const previous = this.probePrevious.get(ball);
			this.probePrevious.set(ball, ball.Position);

			const ballDelta = previous === undefined ? 0 : ball.Position.sub(previous).Magnitude;
			const phantomDelta = previous === undefined ? 0 : state.phantom.Position.sub(previous).Magnitude;
			const drift = state.phantom.Position.sub(ball.Position).Magnitude;

			this.probeLines++;
			print(
				`[BallRender] probe phase=${this.phase} body="${ball.GetFullName()}" dt=${tostring(math.round(elapsed * 100) / 100)}s ballDelta=${tostring(math.round(ballDelta * 1000) / 1000)} phantomDelta=${tostring(math.round(phantomDelta * 1000) / 1000)} drift=${tostring(math.round(drift * 1000) / 1000)} ballLocal=${tostring(ball.Position)} phantom=${tostring(state.phantom.Position)}`,
			);

			if (this.probeLines >= PROBE_LINE_LIMIT) {
				return;
			}
		}
	}

	/**
	 * The phantom standing in for one ball, if this client has built one. **Not called by anything**: `marker-spin-controller`
	 * finds the phantom as a child of the ball, because a Flamework dependency between two controllers for one `FindFirstChild`
	 * would be more coupling than the lookup costs. It is kept as the named accessor so a future reader has one place to ask,
	 * rather than a second copy of the map.
	 */
	public phantomFor(ball: BasePart): BasePart | undefined {
		const state = this.phantoms.get(ball);
		if (state === undefined || state.phantom.Parent === undefined) {
			return undefined;
		}

		return state.phantom;
	}
}
