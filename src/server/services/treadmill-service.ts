import { CollectionService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BELT_VISUAL_SPEED_ATTRIBUTE, BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED } from "shared/attributes";
import { TAGS } from "shared/tags";
import { powerOf } from "server/powers";
import {
	BELT_BOUNCE_CHANCE,
	BELT_BOUNCE_COOLDOWN,
	BELT_BOUNCE_ENABLED,
	BELT_BOUNCE_IMPULSE,
	BELT_SURFACE_LIP,
	BELT_SURFACE_THICKNESS,
	BELT_TEXTURE_ASSET,
	BELT_TEXTURE_STUDS_PER_TILE_U,
	BELT_TEXTURE_STUDS_PER_TILE_V,
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
 * ## Mechanism: the belt is a **reference number**, not a moving surface
 *
 * **This section was rewritten twice.** The first version argued for `AssemblyLinearVelocity` on the
 * anchored belt; Studio refuted it (`~0.1 studs/s?`, no rotation). The second version replaced it with an
 * unanchored slab driven by a motorised sliding constraint, and that mechanism is now gone too: it fought
 * the ball's own impulse model every round, produced balls leaving the belt backwards, and needed a
 * per-belt heartbeat, a teleport-reset loop and a pinned network owner to keep behaving.
 *
 * What exists now:
 *
 * - The **belt part** where the user put it, carrying the surface texture. Nothing drives it.
 * - One **static, anchored, frictionless floor** slightly above the belt's top face, so a ball has
 *   something to rest on and gravity has something to settle it against. It does not move, has no
 *   constraint, no attachment, no heartbeat, and cannot lose network ownership.
 * - **`BELT_SPEED`** (the `BeltSpeed` value, 10) as a *reference number only*. `RoundService` still ramps it
 *   from 0 at `Playing` entry, but nothing in the world reacts to it physically.
 * - **`BALL_SPEED`**, an attribute on each ball, decayed every tick by `BallSpawnerService`. The ball's
 *   velocity along the belt is set to `BALL_SPEED - BELT_SPEED` each frame.
 *
 * The consequence worth naming: the belt no longer *causes* motion, it only *defines the frame* in which a
 * ball's speed is compared. A ball at the reference speed is stationary; slower is losing ground; faster (a
 * pickup) is gaining it. That is the whole model, and it is deterministic ? no friction, no solver, no
 * ownership races.
 *
 * The cost is honest: the game is no longer a physics game in this one respect. A ball's along-belt motion is
 * chosen by a number rather than emerging from contact, so shape and mass no longer affect who wins the belt.
 * Nothing in this slice depended on that, and everything in the previous slice was broken *by* it.
 *
 * ## Axis convention
 *
 * **Along-belt is the part's `RightVector`, which is world X.** For a belt whose long axis is X — the only belt this scene
 * has — `RightVector` is the **long** axis, not the lateral one; that naming trap is the single easiest way to write a ball
 * that moves sideways, and it is spelled out in full at `BallSpawnerService.stepBallSpeeds`. Lateral is world Z, and the
 * only thing in the tree that touches it is the decorative weave.
 *
 * **The reference speed is applied nowhere** — there is no surface velocity, no constraint and no drag. `BeltSpeed` defines
 * the comparison in `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`, and `BallSpawnerService` turns the difference into motion:
 * equal holds station, below drifts toward the **back** (`+X`, toward elimination), above drifts toward the **front**
 * (`-X`, toward spawn). A **negative** `BeltSpeed` flips the comparison's sign, so every ball at rest drifts toward the
 * front instead — the belt "reversed" without re-rotating the part.
 *
 * Deriving the axis from `CFrame` rather than a world axis is what makes a rotated belt work: the comparison and the
 * motion both follow the part's own frame.
 *
 * The belt is deliberately passive about everything else: it never reskins, resizes, repositions or re-anchors a part, and
 * it ignores anything that is not tagged. It does write three things — `BeltSpeed`, once and only when absent;
 * `CanCollide = false`; and one child, the static floor slab the ball actually rests on. The `BeltSpeed`-only-when-absent
 * rule is explained at the top of `shared/attributes.ts`.
 *
 * If the part is rotated at runtime the slab is not rebuilt and its own frame is not recomputed — the brief defines this
 * service as reacting to a tag and one attribute. Recomputing on `CFrame` change would be one extra connection per belt if a
 * later slice starts moving belts around.
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
	/**
	 * The static floor a ball rests on.
	 *
	 * **Nothing about this part moves.** It used to be an unanchored slab driven by a motorised sliding constraint
	 * motor at the belt's speed; that whole mechanism is gone (see the class docblock) and what remains is an
	 * anchored plate whose only job is to be a surface the ball can sit on and gravity can settle it against.
	 */
	surface: BasePart;
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

	/** One static floor per belt, keyed by the belt so bind/unbind stay symmetric. */
	private readonly surfaces = new Map<BasePart, BeltSurface>();

	/**
	 * Speed every belt runs at, while set, in place of the `BeltSpeed` attribute. `undefined` means
	 * "no override — read the attribute", which is the state the service starts in and never leaves
	 * except while `RoundService` is driving.
	 */
	private beltSpeedOverride?: number;

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
		if (existing !== undefined && existing.surface.Parent !== undefined) {
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

		const surface = new Instance("Part");
		surface.Name = "TreadmillSurface";
		surface.Shape = Enum.PartType.Block;
		surface.Size = new Vector3(length, BELT_SURFACE_THICKNESS, belt.Size.Z);
		// **Anchored, and that is the whole mechanism change.** This part used to be unanchored and driven
		// along one axis by a motorised constraint. A ball's motion is now set directly from its `BALL_SPEED`
		// (see `BallSpawnerService.stepBallSpeeds`), so the floor no longer has to move ? and an anchored part
		// cannot be dragged, cannot lose network ownership mid-round, and costs no physics assembly.
		surface.Anchored = true;
		surface.CanCollide = true;
		surface.CanTouch = true;
		// `CanQuery = false` keeps the floor out of raycasts and `GetPartBoundsInBox`. Nothing should be able
		// to target a surface that is supposed to be indistinguishable from the belt underneath it.
		surface.CanQuery = false;
		surface.Transparency = 1;
		// **Friction 0, explicitly.** A frictionless floor means the ball's only along-belt motion is the
		// velocity this codebase writes, so the model is exactly as deterministic as its constants. Slab
		// friction would be a second, invisible force fighting the first -- which is precisely the failure that
		// produced balls leaving the belt backwards during the physical-mechanism rounds.
		//
		// Across the belt, friction would also grip a ball that is drifting sideways, which is the one motion
		// the model does not own; zero everywhere keeps that honest and makes the surface a pure support.
		surface.CustomPhysicalProperties = new PhysicalProperties(0.7, 0, 0.5, 1, 1);
		surface.CFrame = belt.CFrame.mul(new CFrame(startOffset, lift, 0));
		surface.Parent = belt;

		const state: BeltSurface = { surface };

		this.surfaces.set(belt, state);

		// The bounce assist was subscribed to the *belt's* `Touched`, and the belt no longer collides, so
		// without this the assist would silently stop firing. It is the same roll, moved to the surface
		// that balls actually touch ? preserving the behaviour rather than changing it.
		this.attachBounce(surface);

		print(
			`[Treadmill] floor created on "${belt.GetFullName()}" beltSize=${formatVector(belt.Size)} floorSize=${formatVector(surface.Size)} lip=${formatNumber(BELT_SURFACE_LIP)} anchored=true friction=0`,
		);

		return state;
	}

	/** Dismantles exactly what `ensureSurface` built. Safe to call when nothing was built. */
	private destroySurface(belt: BasePart): void {
		const state = this.surfaces.get(belt);
		if (state === undefined) {
			return;
		}

		// Only the floor is this service's now: it has no constraint and no attachments of its own, so there
		// is nothing else to dismantle and nothing that could be left behind on the belt.
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

		// **Per axis, not one square value.** `U` runs along the belt's length, `V` across its width, and the
		// asset is a wide figure: a single square tile squeezed it and repeated it three times across the
		// belt. See the constants for the arithmetic on both axes.
		texture.StudsPerTileU = BELT_TEXTURE_STUDS_PER_TILE_U;
		texture.StudsPerTileV = BELT_TEXTURE_STUDS_PER_TILE_V;

		// Every image slot is read back, plus the part's own render state. The part-side values matter
		// because a `Texture` on a `Transparency = 1` part is invisible for a reason that has nothing to
		// do with the texture, and nothing so far has logged them.
		print(
			`[Treadmill] texture: properties applied Face=${texture.Face.Name} colorMapContentUri=${tostring(texture.ColorMapContent.Uri)} legacyTexture=${texture.Texture} colorMap=${texture.ColorMap} studsPerTileU=${texture.StudsPerTileU} studsPerTileV=${texture.StudsPerTileV} transparency=${texture.Transparency} | partTransparency=${part.Transparency} partMaterial=${tostring(part.Material)} topSurface=${tostring(part.TopSurface)}`,
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
		// The gate. First statements in the handler so a disabled assist costs one tag test and, for a ball, one attribute
		// read — see `BELT_BOUNCE_ENABLED` for why it is off this round and how to turn it back on. Everything below is left
		// exactly as it was, so flipping the constant restores the previous behaviour with no other diff.
		//
		// **`bouncy` overrides the gate**, and this is the one place the assist can still fire while the constant is `false`.
		// The constant exists to keep a *this-round experiment* quiet — the belt material changed in the same round and two
		// variables at once would be unreadable — whereas `bouncy` is a designed property of one ball that ships. A gate
		// that suppressed it would make the ball's entire power invisible. The ordering matters: the tag test comes first so
		// the attribute read is only paid for a ball, and only when the global gate is off.
		if (!BELT_BOUNCE_ENABLED && (!other.HasTag(TAGS.ball) || !isBouncyBall(other))) {
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

		this.ensureSurface(part);
		this.publishVisualSpeed(speed);

		// **`origin` and `rightVector` are the two numbers a reader needs to orient everything else.** `origin` is the
		// belt's **geometric centre**, not its front edge, so every `local=` field in the tree (which is
		// `PointToObjectSpace` against this part) is measured from the middle: code-frame X runs `-28 .. +28` and Z runs
		// `-6 .. +6` for this scene's belt, and user-frame is `+28` on X and `+6` on Z. `rightVector` is the **along-belt**
		// axis — world `+X` here — not the lateral one; the naming trap is spelled out at `BallSpawnerService.stepBallSpeeds`.
		print(
			`[Treadmill] ${reason} "${part.GetFullName()}" size=${formatVector(part.Size)} origin=${formatVector(part.Position)} rightVector=${formatVector(part.CFrame.RightVector)} BELT_SPEED=${formatNumber(this.getReferenceBeltSpeed())} BELT_VISUAL_SPEED=${formatNumber(speed)} CanCollide=${tostring(part.CanCollide)}`,
		);
	}

	private readSpeed(part: BasePart): number {
		// The override wins over the attribute for as long as it is set. `RoundService` drives the belt
		// through `setBeltSpeed` and the attribute stops being the source of truth during a round — which
		// is the point of the override: the attribute is a designer knob, and a round is not a designer.
		// `stepSurface` reads through this every frame, so the ramp's per-frame writes land on the
		// constraint without `setBeltSpeed` having to reach into the constraint itself.
		if (this.beltSpeedOverride !== undefined) {
			return this.beltSpeedOverride;
		}

		const raw = part.GetAttribute(BELT_SPEED_ATTRIBUTE);
		return typeIs(raw, "number") ? raw : DEFAULT_BELT_SPEED;
	}

	/**
	 * Sets the speed every bound belt runs at, overriding the `BeltSpeed` attribute.
	 *
	 * Called by `RoundService` for the ramp and to stop the belt outside `Playing`. Nothing else calls
	 * it, and that is deliberate — the belt has one driver during a round, so "which system is moving
	 * the belt" has a single answer.
	 *
	 * The write is a single number on this service rather than a loop over the surfaces' constraints.
	 * `stepSurface` already reconciles `constraint.Velocity` against `readSpeed` every frame, so pushing
	 * the value there would duplicate the write and give two places that can disagree about the current
	 * speed. The cost is that the change lands on the next `Heartbeat` rather than in the same call —
	 * one frame, which no player can see and which the ramp's own frame-by-frame writing makes moot.
	 */
	public setBeltSpeed(speed: number): void {
		this.beltSpeedOverride = speed;
		this.publishVisualSpeed(speed);
	}

	/**
	 * Publishes the **visual** speed to every bound belt, for `BeltScrollController`.
	 *
	 * This is the only consumer of the ramp. `getReferenceBeltSpeed()` ? the number `stepBallSpeeds` subtracts
	 * ? is the designer's constant and is never written by anything.
	 *
	 * Rounded to two decimals before the comparison: the ramp writes a different float every frame, and an
	 * unrounded write would be a replicated property update per belt per frame for a number the eye cannot see
	 * change.
	 */
	private publishVisualSpeed(speed: number): void {
		const published = math.round(speed * 100) / 100;

		for (const [belt] of this.surfaces) {
			if (belt.Parent === undefined) {
				continue;
			}

			if (belt.GetAttribute(BELT_VISUAL_SPEED_ATTRIBUTE) !== published) {
				belt.SetAttribute(BELT_VISUAL_SPEED_ATTRIBUTE, published);
			}
		}
	}

	/**
	 * The belt's travel direction in world space, or `+X` when no belt is bound yet.
	 *
	 * `BallSpawnerService` sets each ball's velocity along this vector every tick, and the service has no belt
	 * of its own to read it from ? the belt is found by tag, and a caller that asks "which way does the belt
	 * run" should not also have to find one. The `+X` fallback only applies before the first bind, which is a
	 * frame where nothing is moving anyway.
	 */
	/**
	 * The **reference** belt speed for the `BALL_SPEED` model: the designer's number, never the ramp.
	 *
	 * This is deliberately *not* the ramped speed. That one is whatever the round's ramp has driven the belt to this frame
	 * — a value that exists only to animate the texture scroll — and it used to be readable as a public method
	 * (`getEffectiveBeltSpeed`), which item 92 deleted when its only caller went with its handler.
	 * Feeding the ramp into `RELATIVE_SPEED` would mean `BALL_SPEED - BELT_SPEED` starts at `10 - 0 = +10` on the first
	 * frame of `Playing` and the ball would lurch *forward* for the whole three-second ramp, which is the opposite of a
	 * neutral start and has nothing to do with how fast the ball is going.
	 *
	 * The requirement is explicit: `BELT_SPEED = 10` from the first tick of `Playing`, `BALL_SPEED_START = 10`,
	 * so `RELATIVE_SPEED = 0` until decay or a pickup changes it. A constant read from the belt's own attribute
	 * is the only way to get that, because a constant cannot be mid-ramp.
	 */
	public getReferenceBeltSpeed(): number {
		return this.getBeltSpeed();
	}

	/**
	 * The belt's own frame, or `undefined` before any belt is bound.
	 *
	 * Used by `BallSpawnerService.stepBallSpeeds` for one thing: converting a ball's world position into the
	 * belt's local `Z`, which is the only frame in which "sideways across the belt" means anything. A world
	 * `Z` would be wrong for a rotated belt, and the lateral drift is defined in the belt's frame.
	 */
	public getBeltFrame(): CFrame | undefined {
		for (const [belt] of this.surfaces) {
			if (belt.Parent !== undefined) {
				return belt.CFrame;
			}
		}

		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance.CFrame;
			}
		}

		return undefined;
	}

	/**
	 * The belt's `RightVector`, which for this scene's belt is **world `+X` — the along-belt axis, not the lateral one.**
	 *
	 * The name is a trap and this is the second place it is warned about: `RightVector` is the part's local `+X`, and a
	 * belt's long axis *is* `+X`, so "right" here means "down the belt toward the back edge", not "across the belt".
	 * Writing `-relative` along it (see `stepBallSpeeds`, which carries the full statement) is what turns a boost into
	 * motion toward the front and decay into motion toward the back.
	 *
	 * Callers: `BallSpawnerService.stepBallSpeeds` (the along-belt write) and every `BALL_SPEED` log field, which measures
	 * a ball's along-belt velocity as a dot product with this vector. It is the only read of this getter in the tree, which
	 * is why it survived item 94's deletion of the one handler that used it for something else.
	 */
	public getBeltRightVector(): Vector3 {
		for (const [belt] of this.surfaces) {
			if (belt.Parent !== undefined) {
				return belt.CFrame.RightVector;
			}
		}

		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance.CFrame.RightVector;
			}
		}

		return Vector3.xAxis;
	}

	/**
	 * The belt's configured speed, ignoring any override.
	 *
	 * `RoundService` needs the target to ramp *towards*, and reading `readSpeed` for that would return
	 * the ramp value itself and converge on whatever it was set to last. This reads the attribute the
	 * designer set, which is the number a round should end up at.
	 *
	 * Resolved from the first bound belt; with no belt bound (before `onStart` completes, or in a scene
	 * with no tagged belt) it falls back to the global default, because a ramp towards zero is worse
	 * than a ramp towards the documented placeholder.
	 */
	public getBeltSpeed(): number {
		for (const [belt] of this.surfaces) {
			if (belt.Parent === undefined) {
				continue;
			}

			const raw = belt.GetAttribute(BELT_SPEED_ATTRIBUTE);
			return typeIs(raw, "number") ? raw : DEFAULT_BELT_SPEED;
		}

		return DEFAULT_BELT_SPEED;
	}
}

/**
 * Whether a body is the one ball the belt-bounce assist is allowed to fire for while the global gate is off.
 *
 * A free function rather than a method because it needs no service state and because `rollBounce` calls it on the hot
 * path — one attribute read, no method dispatch through `self`.
 */
function isBouncyBall(part: BasePart): boolean {
	return powerOf(part) === "bouncy";
}
