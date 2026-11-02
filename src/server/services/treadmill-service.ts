import { CollectionService, RunService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED } from "shared/attributes";
import { TAGS } from "shared/tags";
import {
	BELT_BOUNCE_CHANCE,
	BELT_BOUNCE_COOLDOWN,
	BELT_BOUNCE_ENABLED,
	BELT_BOUNCE_IMPULSE,
	BELT_SURFACE_LIP,
	BELT_SURFACE_MATERIAL,
	BELT_SURFACE_MOTOR_MAX_ACCELERATION,
	BELT_SURFACE_MOTOR_MAX_FORCE,
	BELT_SURFACE_RESET_THRESHOLD,
	BELT_SURFACE_THICKNESS,
	BELT_TEXTURE_ASSET,
	BELT_TEXTURE_STUDS_PER_TILE,
} from "shared/tuning";

/**
 * Three-decimal rounding instead of `string.format`, because the numbers being logged span from
 * `0.001`-scale local offsets to `500`-scale kill planes and a fixed decimal count either loses the
 * small ones or pads the large ones. Three decimals keeps `0.05` readable and rounds float noise such
 * as `0.5000000001` to `0.5`, which is what makes two log lines comparable by eye.
 */
function formatNumber(value: number): string {
	return tostring(math.round(value * 1000) / 1000);
}

/** A `Vector3` as `(x, y, z)` on one line, so a vector never wraps and stays greppable. */
function formatVector(value: Vector3): string {
	return `(${formatNumber(value.X)}, ${formatNumber(value.Y)}, ${formatNumber(value.Z)})`;
}

/**
 * Drags anything resting on a `TreadmillBelt` part across its surface.
 *
 * ## TEMPORARY INSTRUMENTATION — read before touching
 *
 * Added by the "why do balls leave the belt, and from which end?" diagnostic prompt. It exists to
 * answer exactly two unknowns from a single Studio run, and it must then be deleted:
 *
 *  1. Does a ball **ride** the belt (its velocity picks up `BeltSpeed` along `RightVector`) or
 *     **slide** (position stationary while the surface moves under it)?
 *  2. Which end does a ball leave from — the `+RightVector` side or the `-RightVector` side — and
 *     does it leave above the belt surface or below it?
 *
 * Everything here is `print` on the success path. A `warn` from this file still means what it meant
 * before: the belt is unanchored, or collision is off. Nothing in the instrumentation changes
 * behaviour — it reads `CFrame`, `Size`, `BeltSpeed` and the velocity it already set, and writes
 * nothing new.
 *
 * The bind line is emitted once per bind and once per `BeltSpeed` change. The change case is not a
 * heartbeat (only a deliberate edit fires it) and it is the one log a person flipping the sign to
 * test direction actually needs.
 *
 * ## Mechanism: a real moving collider, not an anchored belt with a velocity
 *
 * **This section was rewritten. The previous version argued for
 * `AssemblyLinearVelocity` on the anchored belt, and that mechanism has been retired.** The old
 * argument is kept below because it is still the history of why this file looks the way it does, and
 * because the reasoning that killed it is not obvious from the code.
 *
 * ### What the anchored-belt mechanism was supposed to do
 *
 * A conveyor is a part that reports a velocity but does not move. The claim was that the engine uses
 * an anchored part's assembly velocity as the *surface* velocity when resolving friction against
 * touching parts, so bodies on it get dragged along. Supporting that: the `BasePart.Anchored` page
 * says an anchored part "still may have a nonzero AssemblyLinearVelocity", and the deprecated
 * `BasePart.Velocity` page carries the sentence "Setting the Velocity of a part that is Anchored will
 * cause it to act like a conveyor belt."
 *
 * ### Why it was retired
 *
 * Studio says it does not do that here. With one ball on a `BeltSpeed = 10` belt the ball crept
 * forward at roughly 0.1 studs/s² — about 1/400th of what friction at the measured `μ_eff ≈ 0.22`
 * would deliver — never reached belt speed, and never rotated. That is not a weak version of
 * "carried by the surface"; it is a weak centre-of-mass push with no contact-point velocity at all,
 * and no engine-documented guarantee to lean on. In hindsight the page that promised it is
 * *deprecated and hidden*, and the replacement's own page never mentions conveyors.
 *
 * ### What replaced it
 *
 * An unanchored, invisible slab of real collision geometry slides along the belt's top
 * face at `BeltSpeed`, held to one axis by a motorised `PrismaticConstraint`. Balls rest on *that*.
 * The slab has genuine velocity, so friction applies at the contact point, which is the only thing
 * that produces both linear acceleration and torque. The visual belt part stays exactly where the
 * user put it — same `Anchored`, `Size`, `CFrame`, texture — but its `CanCollide` is set to `false`
 * so it cannot compete with the slab, and its `AssemblyLinearVelocity` is no longer written.
 *
 * ### What that costs
 *
 * Three things, all accepted deliberately:
 *  - **A small physics assembly per belt.** The slab is an unanchored body; it participates in the
 *    solver every step even when nothing is on it.
 *  - **A reset loop.** The slab cannot be infinitely long, so it must be teleported back to the start
 *    of its travel periodically. That is a `RunService.Heartbeat` connection per belt and a visible
 *    discontinuity in the *slab's* position, which is invisible only because the slab is.
 *  - **A server-owned unanchored part.** Anything unanchored near a player can lose ownership to that
 *    client, and the surface must not, or the server and the client would disagree about what the ball
 *    is resting on. `SetNetworkOwner(nil)` is attempted for that reason (see `claimServerOwnership`).
 *
 * The alternative — per-ball `LinearVelocity`, or an `AngularVelocity` assist — was rejected for a
 * reason that is a design constraint rather than a technical one: it would choose outcomes instead of
 * letting shape and orientation choose them. A moving surface chooses nothing; it is the same surface
 * for every body, and what a body does on it is physics.
 *
 * ## Replication caveat (unchanged in shape, different in detail)
 *
 * `AssemblyLinearVelocity` is tagged NotReplicated, and so is `Attachment.Axis` and
 * `SlidingBallConstraint.CurrentPosition`. None of that matters now: the slab is server-owned, its
 * velocity is real motion rather than a property, and real motion replicates. The earlier worry — that
 * a client-owned ball would be simulated resting on a stationary surface — is answered by the slab
 * genuinely moving.
 *
 * ## Axis convention
 *
 * `BeltSpeed` is applied along the part's `RightVector` (its local +X, the "right" face in
 * Studio's move tool). A positive speed drags toward the part's right; a negative speed drags
 * toward its left, so the belt can be reversed without re-rotating anything. Deriving the vector
 * from `CFrame` rather than a world axis is what makes a rotated belt drag in the rotated
 * direction. The prompt suggested `-RightVector`; its own parenthetical ("drags toward the part's
 * right") describes `+RightVector`, so `+RightVector` is what the parenthetical means and what is
 * implemented.
 *
 * The belt is deliberately passive about everything else: it never reskins, resizes, repositions
 * or re-anchors a part, and it ignores anything that is not tagged. It does write three things —
 * `BeltSpeed`, once and only when absent; `CanCollide = false`, because the moving slab is the
 * collision surface; and one child, the slab itself. The `BeltSpeed`-only-when-absent rule is
 * explained at the top of `shared/attributes.ts`.
 *
 * If the part is rotated at runtime the slab is not rebuilt and the constraint axis is not
 * recomputed — the brief defines this service as reacting to a tag and one attribute. Recomputing on
 * `CFrame` change would be one extra connection per belt if a later slice starts moving belts around.
 */
/**
 * One moving collider's worth of state, so `unbind` can dismantle exactly what `bind` created and the
 * heartbeat can find its slab without scanning children by name.
 *
 * `startCFrame` is stored rather than recomputed on reset: recomputing from the belt's *current*
 * `CFrame` would silently re-anchor the slab's origin if the belt were ever moved or rotated at
 * runtime, which would make the reset jump somewhere the constraint's limits do not describe.
 */
interface BeltSurface {
	surface: BasePart;
	attachment0: Attachment;
	attachment1: Attachment;
	constraint: PrismaticConstraint;
	/** Optional because the connection is created after the state object it needs to capture. */
	heartbeat?: RBXScriptConnection;
	startCFrame: CFrame;
	upperLimit: number;
	/** Set once the surface's measured velocity has been compared against `RightVector`. */
	verified: boolean;
}

@Service()
export class TreadmillService implements OnStart {
	/**
	 * One connection per bound part, so untagging a part can actually stop it. Without this book-
	 * keeping an attribute connection would outlive the tag and keep dragging a part the designer
	 * had already disowned.
	 */
	private readonly bound = new Map<BasePart, RBXScriptConnection>();

	/**
	 * Per-belt connections created for the surface texture and the bounce. Kept separate from `bound`
	 * because `bound` is keyed by the belt and holds exactly one thing (the `BeltSpeed` listener);
	 * folding two more connections into it would make the map's meaning "the connections, plural" and
	 * every `unbind` would have to know how many there are.
	 */
	private readonly beltExtras = new Map<BasePart, RBXScriptConnection[]>();

	/** The `Texture` each belt got, so `unbind` can remove exactly what this service added. */
	private readonly beltTextures = new Map<BasePart, Texture>();

	/**
	 * Last accepted bounce time per body, in `os.clock()` seconds.
	 *
	 * ## Why this map needs no destroy hook
	 *
	 * The obvious design is to delete an entry when its body is destroyed, which means either
	 * `Instance.Destroying` on every body or a hook in the spawner's cleanup — and the spawner destroys
	 * bodies from two places (cap and kill plane) plus whatever else a later slice adds, so the hook
	 * would have to be installed everywhere or leak. Instead entries are **pruned by age**: `rollBounce`
	 * drops everything older than `BELT_BOUNCE_COOLDOWN` before it looks at the current body, so the map
	 * can only ever hold bodies touched within the last second. A destroyed body's entry is therefore
	 * garbage collected on the next bounce check of any body, and the map's size is bounded by the live
	 * set rather than by history. The cost is a full scan per touch; with ≤ 50 bodies that is nothing,
	 * and it cannot leak no matter who destroys what.
	 */
	private readonly lastBounceAt = new Map<BasePart, number>();

	/** One moving collider per belt, keyed by the belt so bind/unbind stay symmetric. */
	private readonly surfaces = new Map<BasePart, BeltSurface>();

	/**
	 * The belt's `CanCollide` as the user set it, recorded before `applySpeed` forces it to `false`.
	 *
	 * Without this, untagging a belt would leave it permanently non-colliding — the tag is the only
	 * thing that says "this part is a belt", so once the tag is gone nothing would ever set it back,
	 * and the symptom ("I untagged my belt and now everything falls through it") looks like corruption
	 * rather than a missing restore. Restoring only what this service changed is the narrow version of
	 * the rule the texture and bounce already follow: remove exactly what `bind` added.
	 */
	private readonly beltCollideBefore = new Map<BasePart, boolean>();

	public onStart(): void {
		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			this.bind(instance);
		}

		CollectionService.GetInstanceAddedSignal(TAGS.treadmillBelt).Connect((instance) => this.bind(instance));
		CollectionService.GetInstanceRemovedSignal(TAGS.treadmillBelt).Connect((instance) => this.unbind(instance));
	}

	private bind(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			warn(
				`[Treadmill] ${instance.GetFullName()} is tagged ${TAGS.treadmillBelt} but is not a BasePart; ignoring.`,
			);
			return;
		}

		// `GetTagged` and the added signal can both report the same part, so binding twice would leak
		// a connection and leave the map pointing at only one of them.
		if (this.bound.has(instance)) {
			return;
		}

		// Tag is the handle; the attribute is this service's bookkeeping. Written only when absent, so a
		// speed chosen in Studio survives rebinding — the same absent-only rule the spawner uses.
		if (instance.GetAttribute(BELT_SPEED_ATTRIBUTE) === undefined) {
			instance.SetAttribute(BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED);
		}

		const connection = instance
			.GetAttributeChangedSignal(BELT_SPEED_ATTRIBUTE)
			.Connect(() => this.applySpeed(instance, `${BELT_SPEED_ATTRIBUTE} changed`));
		this.bound.set(instance, connection);

		this.attachBeltTexture(instance);
		this.attachBounce(instance);

		this.applySpeed(instance, "bind");
	}

	// #region moving surface (the actual conveyor)

	/**
	 * Creates the invisible slab that balls actually rest on, plus the constraint that drives it.
	 *
	 * **Parenting: directly under the belt, as one part.** Not a `TreadmillSurface` folder. A folder
	 * would exist only to group a single part with its own constraint, and the constraint is parented
	 * under the belt anyway (it is a joint between belt and slab, and putting it under either end is
	 * arbitrary). One fewer instance per belt, and `unbind` has one thing to destroy.
	 *
	 * The name is `TreadmillSurface`, deliberately *not* `BeltSurface`. The client controller waits for
	 * a child named `BeltSurface` and asserts it `IsA("Texture")`; reusing that name here would make
	 * that lookup find a `Part` and log a misleading "is a Part, not a Texture" warning.
	 */
	private ensureSurface(belt: BasePart): BeltSurface {
		const existing = this.surfaces.get(belt);
		if (
			existing !== undefined &&
			existing.surface.Parent !== undefined &&
			existing.constraint.Parent !== undefined
		) {
			return existing;
		}

		// Bounded overhang rather than a 2x slab. See `BELT_SURFACE_LIP`: the slab is one belt length
		// plus one `LIP`, so a `LIP`-stud pass covers the footprint at both extremes and never extends
		// more than `LIP` past either end of the belt. The earlier 2x version produced 28 studs of
		// invisible collidable ground past each end of a 56-stud belt.
		const length = belt.Size.X + BELT_SURFACE_LIP;
		const lift = belt.Size.Y / 2 + BELT_SURFACE_THICKNESS / 2;

		// The slab's centre starts `LIP/2` behind the belt's centre, which puts its trailing edge exactly
		// `LIP` behind the belt's trailing edge while its leading edge is flush with the belt's own.
		const startOffset = -BELT_SURFACE_LIP / 2;
		const startCFrame = belt.CFrame.mul(new CFrame(startOffset, lift, 0));

		const surface = new Instance("Part");
		surface.Name = "TreadmillSurface";
		surface.Shape = Enum.PartType.Block;
		surface.Size = new Vector3(length, BELT_SURFACE_THICKNESS, belt.Size.Z);
		surface.Anchored = false;
		// **`Massless` is a no-op here, and that is fine.** The engine ignores `Massless` on a part that is
		// its own assembly root, and a `PrismaticConstraint` does not merge bodies into one assembly the
		// way a weld does — so the slab is its own root and keeps its real mass anyway. Its volume is
		// `(beltLength + LIP) x 0.2 x beltWidth`, which at the observed 56 x 1 x 33 belt is
		// `57 x 0.2 x 33 = 376` studs³, and at the measured Plastic density of 0.7 that is **~263 mass**
		// against a ball's 0.367 — about 700 times heavier. That ratio is what actually makes the surface
		// behave as immovable, so the property is kept as intent rather than as a mechanism, and the
		// comment is here so nobody later "fixes" the mass by trusting the flag.
		surface.Massless = true;
		surface.CanCollide = true;
		surface.CanTouch = true;
		// `CanQuery = false` keeps the slab out of raycasts and `GetPartBoundsInBox`. Nothing should be
		// able to target a surface that is supposed to be indistinguishable from the belt underneath it,
		// and every query that used to hit "the belt" would now have two candidates 0.2 studs apart.
		surface.CanQuery = false;
		surface.Transparency = 1;
		// The slab is meant to be a ground plane, not a surface with visible grain, and its material is
		// what sets the friction half of the ball/surface pair. Named in `tuning.ts` so retuning friction
		// is one edit in a file that already holds the other physics knobs, rather than a hunt through the
		// service. See `BELT_SURFACE_MATERIAL` for the arithmetic and for why nothing else about friction
		// is configured here.
		surface.Material = BELT_SURFACE_MATERIAL;
		surface.CFrame = startCFrame;
		surface.Parent = belt;

		// Attachment0 sits at the belt's top centre; Attachment1 at the slab's centre. Their **X axes**
		// are what the constraint actually uses.
		const attachment0 = new Instance("Attachment");
		attachment0.Name = "TreadmillRail";
		attachment0.CFrame = new CFrame(0, belt.Size.Y / 2, 0);
		attachment0.Parent = belt;

		const attachment1 = new Instance("Attachment");
		attachment1.Name = "TreadmillRunner";
		// Rotated 180 degrees about Y so its X axis points **opposite** Attachment0's, which is the
		// documented requirement: a PrismaticConstraint "constrains the attachments so that their X axes
		// are collinear but pointing in opposite directions". Leaving both at identity would make the
		// solver satisfy that condition by rotating the slab, not by sliding it.
		attachment1.CFrame = CFrame.Angles(0, math.pi, 0);
		attachment1.Parent = surface;

		// `Axis` is set to match for readability, but it is **not** what a PrismaticConstraint reads —
		// that is Attachment0's X axis, and `Attachment.Axis` is a local-space vector used by other
		// constraints. Setting it costs nothing and stops the next reader assuming it was forgotten.
		attachment0.Axis = Vector3.xAxis;
		attachment1.Axis = Vector3.xAxis;

		const constraint = new Instance("PrismaticConstraint");
		constraint.Name = "TreadmillMotor";
		constraint.Attachment0 = attachment0;
		constraint.Attachment1 = attachment1;
		constraint.ActuatorType = Enum.ActuatorType.Motor;
		constraint.MotorMaxForce = BELT_SURFACE_MOTOR_MAX_FORCE;
		constraint.MotorMaxAcceleration = BELT_SURFACE_MOTOR_MAX_ACCELERATION;
		// Limits span exactly one `LIP` of travel, centred on the attachment: from "trailing edge `LIP`
		// behind the belt" to "leading edge `LIP` in front of it". Symmetric about zero because the slab
		// starts at `-LIP/2` and ends at `+LIP/2`.
		constraint.LimitsEnabled = true;
		constraint.LowerLimit = -BELT_SURFACE_LIP / 2;
		constraint.UpperLimit = BELT_SURFACE_LIP / 2;
		constraint.Velocity = this.readSpeed(belt);
		constraint.Parent = belt;

		const state: BeltSurface = {
			surface,
			attachment0,
			attachment1,
			constraint,
			startCFrame,
			upperLimit: BELT_SURFACE_LIP / 2,
			verified: false,
		};

		state.heartbeat = RunService.Heartbeat.Connect(() => this.stepSurface(belt, state));

		this.surfaces.set(belt, state);

		// The bounce assist was subscribed to the *belt's* `Touched`, and the belt no longer collides, so
		// without this the assist would silently stop firing. It is the same roll, moved to the surface
		// that balls actually touch — preserving the behaviour rather than changing it.
		this.attachBounce(surface);

		this.claimServerOwnership(surface);

		print(
			`[Treadmill] surface created on "${belt.GetFullName()}" beltSize=${formatVector(belt.Size)} surfaceSize=${formatVector(surface.Size)} lip=${formatNumber(BELT_SURFACE_LIP)} travel=${formatNumber(BELT_SURFACE_LIP)} axis=Attachment0.X`,
		);

		return state;
	}

	/**
	 * Forces the slab to stay server-owned, tolerating failure.
	 *
	 * The slab is jointed to an anchored belt, which makes the belt the assembly's root; `SetNetworkOwner`
	 * raises on a part that is not a root, so this is wrapped rather than trusted. **That failure is
	 * harmless and is why it is not treated as an error:** ownership of an anchored assembly is server
	 * by definition, so if the call is refused the slab is already where it needs to be. The `pcall` is
	 * here so a future engine change cannot break belt binding, and the outcome is logged once so the
	 * next person does not have to rediscover which branch ran.
	 */
	private claimServerOwnership(surface: BasePart): void {
		const [ok, err] = pcall(() => surface.SetNetworkOwner(undefined));
		print(
			`[Treadmill] surface ownership: setNetworkOwner(nil) ${ok ? "accepted" : `refused (${tostring(err)}) — assembly root is the anchored belt, which is already server-owned`}`,
		);
	}

	/**
	 * Drives the slab: keeps the motor at `BeltSpeed`, resets it to the start at the end of travel, and
	 * — once — compares the measured velocity against the belt's `RightVector`.
	 *
	 * ### Why the reset is a teleport and not a loop
	 *
	 * A conveyor with finite length has to reuse its surface. Two ways: teleport the slab back, or
	 * rebuild it. Rebuilding would destroy and recreate a constrained body every few seconds, which
	 * drops its contact with anything resting on it for at least a frame and re-runs the motor's
	 * spin-up; teleporting keeps the same instance, the same constraint, and the same contacts.
	 *
	 * ### The order, and why the velocity is written before re-enabling
	 *
	 * Constraint off, `CFrame` write, velocity write, constraint on. The constraint must be off first or
	 * the solver overwrites the teleport within the same step. The velocity write is what makes the
	 * teleport survivable: a body resting on the slab has real velocity from the *slab's* motion, and if
	 * the slab came back at rest, the next friction solve would see a sudden `-BeltSpeed` slip and yank
	 * the ball backwards for a frame — a visible stutter. Writing the velocity *before* re-enabling
	 * rather than after means the motor never sees the slab at rest at all.
	 */
	private stepSurface(belt: BasePart, state: BeltSurface): void {
		const { surface, constraint } = state;
		if (surface.Parent === undefined || constraint.Parent === undefined) {
			return;
		}

		const speed = this.readSpeed(belt);
		if (constraint.Velocity !== speed) {
			constraint.Velocity = speed;
		}

		const axis = belt.CFrame.RightVector;

		// One-shot sign check. Everything else about this mechanism is verifiable from source; whether
		// positive `Velocity` travels along `+RightVector` or against it is **not** documented, and
		// getting it wrong makes every ball roll backwards. This prints the measured dot product once,
		// about half a second in, so the answer costs one Studio run instead of a sign-flip cycle.
		if (!state.verified) {
			const moving = surface.AssemblyLinearVelocity;
			if (moving.Magnitude > math.abs(speed) * 0.5) {
				state.verified = true;
				const along = moving.Dot(axis);
				print(
					`[Treadmill] surface velocity check: measured=${formatVector(moving)} rightVector=${formatVector(axis)} alongRight=${formatNumber(along)} ${along < 0 ? "WRONG SIGN — negate constraint.Velocity" : "matches +RightVector"}`,
				);
			}
		}

		if (constraint.CurrentPosition < state.upperLimit - BELT_SURFACE_RESET_THRESHOLD) {
			return;
		}

		constraint.Enabled = false;
		surface.CFrame = state.startCFrame;
		surface.AssemblyLinearVelocity = axis.mul(speed);
		constraint.Enabled = true;
	}

	/** Dismantles exactly what `ensureSurface` built. Safe to call when nothing was built. */
	private destroySurface(belt: BasePart): void {
		const state = this.surfaces.get(belt);
		if (state === undefined) {
			return;
		}

		state.heartbeat?.Disconnect();

		// Explicit: the constraint and the belt-side attachment are children of the *belt*, so destroying
		// the slab would leave both behind, attached to nothing.
		state.constraint.Destroy();
		state.attachment0.Destroy();

		// Implicit: `attachment1` is a child of the slab and dies with it. It is named here anyway so the
		// list of what this function is responsible for is complete and does not depend on someone
		// later reparenting the slab.
		state.attachment1.Destroy();
		state.surface.Destroy();

		this.surfaces.delete(belt);
	}

	// #endregion

	// #region belt texture (TEMPORARY INSTRUMENTATION)

	/**
	 * Adds one `Texture` on the belt's top face, or reuses one that is already there.
	 *
	 * `Top` is the `NormalId` whose outward normal is the part's `UpVector`, i.e. the face a body rests
	 * on — which is the only face worth texturing on a belt, and the only one whose `U` axis runs along
	 * the drag direction.
	 *
	 * Reusing an existing child matters because this runs on every bind, and unbind/re-tag is a normal
	 * thing to do while tuning. Blindly creating one per bind would stack textures on the same face, and
	 * stacked coplanar textures z-fight — which looks like a shimmering, flickering surface and is
	 * exactly the artefact the texture exists to avoid.
	 *
	 * **This creates an instance but not scene content.** The `Texture` is a child of a part the user
	 * already placed, exists only while the part is tagged, and is removed on unbind. Nothing here adds
	 * a part, a model, or a `$path` entry.
	 *
	 * ## TEMPORARY INSTRUMENTATION — "why is there no Texture child?" round
	 *
	 * The user reported, from Studio Play mode, that no `Texture` child appears on the belt part while
	 * both asset URLs load as valid images. Three candidates were proposed: the creation code never
	 * runs, it throws, or it lands on a different part. Every step of the creation is now logged, and
	 * the whole thing is wrapped in `xpcall` so a throw is named instead of vanishing.
	 *
	 * **The failure is re-raised, not swallowed.** `bind` calls this before `applySpeed`, so a throw
	 * here suppresses the `[Treadmill] bind` line and stops the belt dragging. That is the current
	 * behaviour and it is preserved deliberately: swallowing the error would make the belt work while
	 * hiding the defect, which is how three earlier rounds of instrumentation failed to catch this.
	 * The consequence is a clean discriminator — `texture: start` followed by `texture: FAILED` and no
	 * `bind` line means the throw is here.
	 */
	private attachBeltTexture(part: BasePart): void {
		// Logged before anything can throw, so "did we even reach this function" is answerable.
		print(
			`[Treadmill] texture: start belt="${part.GetFullName()}" face=${Enum.NormalId.Top.Name} asset=${BELT_TEXTURE_ASSET} existingChild=${tostring(part.FindFirstChild("BeltSurface") !== undefined)}`,
		);

		const [ok, err] = xpcall(
			() => this.createBeltTexture(part),
			(e) => `${typeIs(e, "string") ? e : tostring(e)}\n${debug.traceback("treadmill texture traceback", 2)}`,
		);

		if (!ok) {
			warn(`[Treadmill] texture: FAILED on "${part.GetFullName()}": ${tostring(err)}`);

			// Re-raise so the bind path fails exactly as it does today. See the docblock.
			error(`treadmill texture creation failed: ${tostring(err)}`);
		}
	}

	private createBeltTexture(part: BasePart): void {
		const existing = part.FindFirstChild("BeltSurface");
		if (existing !== undefined && existing.IsA("Texture")) {
			this.beltTextures.set(part, existing);
			print(`[Treadmill] texture: reusing existing "${existing.GetFullName()}" on belt="${part.GetFullName()}"`);
			return;
		}

		const texture = new Instance("Texture");
		texture.Name = "BeltSurface";

		// Logged before the property assignments, because those are the most likely throw site: a
		// property that does not exist on this engine's `Texture` class raises, and the message names
		// the property rather than this line.
		print(
			`[Treadmill] texture: created ClassName=${texture.ClassName} name=${texture.Name} parentBefore=${texture.Parent === undefined ? "none" : texture.Parent.GetFullName()}`,
		);

		texture.Face = Enum.NormalId.Top;

		// **Both the modern and the legacy image property are set, deliberately.**
		//
		// `Decal` exposes four image slots: `ColorMapContent: Content` and `ColorMap: ContentId` are the
		// new pair, `TextureContent: Content` and `Texture: ContentId` the old one. They read as aliases,
		// and the documented example uses only `ColorMapContent` — but a Studio run proved that setting
		// *only* `ColorMapContent` produces a `Texture` whose content reads back correctly on both server
		// and client (`uri=rbxassetid://6691394`) while rendering nothing at all. So `ColorMapContent`
		// alone is not sufficient in this engine build.
		//
		// Writing the legacy string as well is the cheap way to cover the case where the renderer is
		// still reading the old slot: it is one assignment, it cannot conflict (both carry the same URI),
		// and if the renderer honours either one the texture appears. The alternative — waiting for a
		// documented statement about which property the renderer uses — is not available, and the
		// alternate approach of swapping to a `SurfaceGui` would be a much larger change for the same
		// uncertainty.
		texture.ColorMapContent = Content.fromUri(BELT_TEXTURE_ASSET);
		texture.Texture = BELT_TEXTURE_ASSET;

		texture.StudsPerTileU = BELT_TEXTURE_STUDS_PER_TILE;
		texture.StudsPerTileV = BELT_TEXTURE_STUDS_PER_TILE;

		// Every image slot is read back, plus the part's own render state. The part-side values matter
		// because a `Texture` on a `Transparency = 1` part is invisible for a reason that has nothing to
		// do with the texture, and nothing so far has logged them.
		print(
			`[Treadmill] texture: properties applied Face=${texture.Face.Name} colorMapContentUri=${tostring(texture.ColorMapContent.Uri)} legacyTexture=${texture.Texture} colorMap=${texture.ColorMap} transparency=${texture.Transparency} | partTransparency=${part.Transparency} partMaterial=${tostring(part.Material)} topSurface=${tostring(part.TopSurface)}`,
		);

		texture.Parent = part;

		// The final check reads the parent back off the instance rather than trusting the assignment:
		// a failed `Parent` write is silent in Luau, so "we set it" and "it is set" are different claims.
		print(
			`[Treadmill] texture: parented to "${texture.Parent !== undefined ? (texture.Parent as Instance).GetFullName() : "NONE"}" isChildOfBelt=${tostring(texture.Parent === part)} childrenOfBelt=${part.GetChildren().size()}`,
		);

		this.beltTextures.set(part, texture);
	}

	// #endregion

	/**
	 * Connects the belt's `Touched` signal to the bounce roll.
	 *
	 * `Touched` rather than a per-frame distance check because contact is precisely the condition the
	 * assist models ("the belt is not a perfect plane, so a body resting on it occasionally skips"), and
	 * the engine already knows when contact happens. A proximity check would need its own spatial query
	 * every frame for every body.
	 *
	 * The handler is entirely on the server. A client-side bounce would have to write
	 * `AssemblyLinearVelocity` on a body the server believes it is simulating, and the two views would
	 * fight; the server is the only party that can apply this consistently to client-owned and
	 * server-owned bodies alike.
	 */
	private attachBounce(part: BasePart): void {
		const connection = part.Touched.Connect((other) => this.rollBounce(part, other));
		const extras = this.beltExtras.get(part);
		if (extras === undefined) {
			this.beltExtras.set(part, [connection]);
		} else {
			extras.push(connection);
		}
	}

	/**
	 * Rolls the belt's imperfect-surface bounce for one contacting body.
	 *
	 * Order matters: the `BELT_BOUNCE_ENABLED` gate comes first (a disabled assist should cost one
	 * boolean), then the tag check (most touches are not bodies and must cost almost nothing), then the
	 * cooldown, and only then the random roll. Rolling before the cooldown check would consume
	 * randomness on every physics step — harmless for correctness, but it would make the effective rate
	 * depend on touch frequency in a way the constants do not describe.
	 */
	private rollBounce(_belt: BasePart, other: BasePart): void {
		// The gate. First statement in the handler so a disabled assist costs one boolean read per contact
		// and nothing more — see `BELT_BOUNCE_ENABLED` for why it is off this round and how to turn it back
		// on. Everything below is left exactly as it was, so flipping the constant restores the previous
		// behaviour with no other diff.
		if (!BELT_BOUNCE_ENABLED) {
			return;
		}

		if (!other.HasTag(TAGS.ball)) {
			return;
		}
		if (other.Parent === undefined) {
			return;
		}

		const now = os.clock();

		// Age-based prune; see `lastBounceAt`.
		for (const [body, at] of this.lastBounceAt) {
			if (now - at >= BELT_BOUNCE_COOLDOWN) {
				this.lastBounceAt.delete(body);
			}
		}

		if (this.lastBounceAt.has(other)) {
			return;
		}

		if (math.random() >= BELT_BOUNCE_CHANCE) {
			return;
		}

		// Vertical only. The existing horizontal velocity is read and written back unchanged, so the
		// belt's drag — the thing that actually produces the gameplay — is untouched by the assist. This
		// is the line the "no horizontal component" constraint is about: `ADD` on Y, never on X or Z.
		const velocity = other.AssemblyLinearVelocity;
		other.AssemblyLinearVelocity = new Vector3(velocity.X, velocity.Y + BELT_BOUNCE_IMPULSE, velocity.Z);

		this.lastBounceAt.set(other, now);
	}

	private unbind(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		const connection = this.bound.get(instance);
		if (connection === undefined) {
			return;
		}

		connection.Disconnect();
		this.bound.delete(instance);

		// Remove exactly what `bind` added: the bounce connection and the texture this service created.
		// A texture the *user* put there was reused by `attachBeltTexture` only if it was already named
		// `BeltSurface`; that name is this service's, so removing it is still correct — but the guard
		// below checks the stored reference rather than the name, so only the instance we actually
		// parented is destroyed.
		for (const extra of this.beltExtras.get(instance) ?? []) {
			extra.Disconnect();
		}
		this.beltExtras.delete(instance);

		const texture = this.beltTextures.get(instance);
		if (texture !== undefined && texture.Parent === instance) {
			texture.Destroy();
		}
		this.beltTextures.delete(instance);

		// Tear down the moving surface before the belt stops being a belt: the slab is the thing that
		// actually drags, so leaving it alive for even one frame after untagging would let an untagged
		// part keep moving bodies.
		this.destroySurface(instance);

		// The belt is anchored and no longer carries a velocity of its own, so there is nothing left to
		// clear. The old `AssemblyLinearVelocity = Vector3.zero` write was removed along with the
		// mechanism that needed it. `CanCollide` *is* handed back, because forcing it to `false` is
		// something this service did and nobody else would undo.
		const collision = this.beltCollideBefore.get(instance);
		if (collision !== undefined) {
			instance.CanCollide = collision;
			this.beltCollideBefore.delete(instance);
		}
	}

	// #endregion

	private applySpeed(part: BasePart, reason: string): void {
		if (!part.Anchored) {
			// An unanchored "belt" cannot hold a constraint origin steady, so the slab would drift with
			// whatever it is resting on. Refusing is safer than warning and building a surface anyway,
			// and the warn is what tells a designer why their belt does nothing.
			warn(`[Treadmill] ${part.GetFullName()} is tagged ${TAGS.treadmillBelt} but not anchored; skipping.`);
			return;
		}

		const speed = this.readSpeed(part);

		// The belt stops *colliding* and starts *hosting*. From here on the only collision surface is the
		// slab, which is the whole point: two overlapping surfaces 0.2 studs apart would make the solver
		// pick one arbitrarily per contact and produce exactly the unpredictable drag this round exists to
		// remove. `Anchored`, `Size`, `CFrame` and the texture child are all left exactly as the user set
		// them — the belt is now a visual base and a fixed rail, nothing more.
		if (part.CanCollide) {
			// Recorded once, on the first `applySpeed` for this belt, so a later `BeltSpeed` change cannot
			// overwrite the remembered value with the `false` this function itself wrote.
			if (!this.beltCollideBefore.has(part)) {
				this.beltCollideBefore.set(part, part.CanCollide);
			}
			part.CanCollide = false;
		}

		const state = this.ensureSurface(part);
		if (state.constraint.Velocity !== speed) {
			state.constraint.Velocity = speed;
		}

		print(
			`[Treadmill] ${reason} "${part.GetFullName()}" size=${formatVector(part.Size)} origin=${formatVector(part.Position)} rightVector=${formatVector(part.CFrame.RightVector)} BeltSpeed=${formatNumber(speed)} CanCollide=${tostring(part.CanCollide)} surfaceVelocity=${formatNumber(state.constraint.Velocity)}`,
		);
	}

	private readSpeed(part: BasePart): number {
		const raw = part.GetAttribute(BELT_SPEED_ATTRIBUTE);
		return typeIs(raw, "number") ? raw : DEFAULT_BELT_SPEED;
	}
}
