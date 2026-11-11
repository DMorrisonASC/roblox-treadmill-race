import { CollectionService, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { BALL_SPEED_ATTRIBUTE } from "shared/attributes";
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

/** One body's visible stand-in, and the roll it has accumulated. */
interface PhantomState {
	readonly phantom: BasePart;
	/** Accumulated world-space roll about the belt's spin axis. Rotation only — the position comes from the ball. */
	spin: CFrame;
	framesSinceNormalize: number;
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

		print(`[BallRender] watching ${TAGS.ball}; phantoms=${this.phantoms.size()}`);
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
		this.phantoms.set(ball, { phantom, spin: new CFrame(), framesSinceNormalize: 0 });

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

	/** The belt's `RightVector`, or `+X` before a belt has replicated. See `apparentSpinAxis` for what it feeds. */
	private beltRight(): Vector3 {
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

		for (const [ball, state] of this.phantoms) {
			if (ball.Parent === undefined || state.phantom.Parent === undefined) {
				dead.push(ball);
				continue;
			}

			const raw = ball.GetAttribute(BALL_SPEED_ATTRIBUTE);
			const speed = typeIs(raw, "number") && raw === raw ? raw : 0;
			// **`BALL_SPEED` is the belt-relative speed, not the world speed** - see `APPARENT_SPIN_GAIN`. The server
			// writes the world velocity as `BELT_SPEED - BALL_SPEED`, and `BALL_SPEED_START` equals the belt speed so a
			// fresh ball holds station: that identity only exists because `BALL_SPEED` measures travel *through the
			// belt's reference* rather than across the ground. Subtracting the belt here as well would draw a ball that
			// holds station as motionless *and unrotating* while the tread runs underneath it, which is sliding.
			const omega = apparentSpinRate(speed);

			if (omega !== 0) {
				state.spin = CFrame.fromAxisAngle(axis, omega * frameDt).mul(state.spin);
				state.framesSinceNormalize++;

				if (state.framesSinceNormalize >= NORMALIZE_EVERY_FRAMES) {
					state.framesSinceNormalize = 0;
					state.spin = CFrame.fromMatrix(Vector3.zero, state.spin.RightVector.Unit, state.spin.UpVector.Unit);
				}
			}

			state.phantom.CFrame = new CFrame(ball.Position).mul(state.spin);
		}

		// Removal is deferred: mutating a `Map` while iterating it is unspecified in Luau, and the symptom — a skipped ball —
		// would look exactly like the bug this map exists to avoid.
		for (const ball of dead) {
			this.phantoms.delete(ball);
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
