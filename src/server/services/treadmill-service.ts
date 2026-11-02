import { CollectionService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED } from "shared/attributes";
import { TAGS } from "shared/tags";
import {
	BELT_BOUNCE_CHANCE,
	BELT_BOUNCE_COOLDOWN,
	BELT_BOUNCE_IMPULSE,
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
 * ## Mechanism: `BasePart.AssemblyLinearVelocity` on the anchored part
 *
 * A conveyor is a part that reports a velocity but does not move. The engine gets this from the
 * part's *assembly* velocity: for an anchored part the assembly cannot translate, but its velocity
 * is still used as the surface velocity when the solver resolves friction against touching parts,
 * so they are dragged along and eventually run off the edge.
 *
 * Evidence, since the prompt's claim needed checking rather than trusting:
 *  - The `BasePart.Anchored` reference page states an anchored part "still may have a nonzero
 *    AssemblyLinearVelocity and AssemblyAngularVelocity" — so setting one is a supported state and
 *    not silently zeroed.
 *  - The conveyor sentence lives on the deprecated `BasePart.Velocity` page: "Setting the Velocity
 *    of a part that is Anchored will cause it to act like a conveyor belt. Any object that touches
 *    the part will begin to move in accordance with the Velocity." That page names
 *    `AssemblyLinearVelocity` as the replacement, and deprecates `Velocity` only for naming
 *    reasons, not because the behaviour was removed.
 *  - `AssemblyLinearVelocity`'s own reference page does *not* mention conveyors. It documents the
 *    property as the assembly's velocity and recommends constraints for driving parts. So the
 *    conveyor behaviour is inherited from `Velocity`, not newly documented for the new name.
 *
 * The alternatives and what they cost:
 *  - A `LinearVelocity` constraint only acts on parts joined to it by an `Attachment`. It cannot
 *    reach an arbitrary loose ball resting on the belt, so it would need a moving collider part or
 *    per-ball attachments — a different, larger mechanism than "an anchored surface that drags".
 *  - `CustomPhysicalProperties` with very high friction is not an alternative to the velocity; it
 *    is a multiplier on how much of the surface velocity reaches the ball. It is layered *on top*
 *    of this mechanism, and is deliberately left at the part's own material settings here.
 *  - `BasePart.Velocity` is deprecated and its reference page is tagged hidden; using it would
 *    mean writing new code against an API the engine already tells you to stop using.
 *
 * ## Replication caveat (the one thing to confirm in Studio)
 *
 * `AssemblyLinearVelocity` is tagged NotReplicated: the property value does not cross the network
 * boundary. That matters because a ball's physics is simulated by whichever machine owns it, and
 * ownership of an unanchored part follows nearby players. If clients never learned the belt's
 * surface velocity, a client-owned ball would just sit there while the server dragged it. The
 * practical evidence that clients do know it is that anchored conveyors carry player characters,
 * and characters are client-owned — so the physics state reaches clients even though the property
 * does not. That reasoning is not a substitute for watching a ball on a belt in Studio; it is the
 * reason this is the shipped mechanism rather than a guess, and it is listed in the hand-off notes
 * as a thing to verify.
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
 * or re-anchors a part, and it ignores anything that is not tagged. It does write one thing —
 * `BeltSpeed`, once, and only when the part has no value for it — because requiring a hand-set
 * attribute before a tagged belt does anything would be a setup step, not a feature. The reasoning
 * for that reversal lives at the top of `shared/attributes.ts`.
 *
 * If the part is rotated at runtime the vector is not recomputed — the brief defines this service as
 * reacting to a tag and one attribute. Recomputing on `CFrame` change would be one extra connection
 * per belt if a later slice starts moving belts around.
 */
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
	 * Order matters: the tag check comes first (most touches are not bodies and must cost almost
	 * nothing), then the cooldown, and only then the random roll. Rolling before the cooldown check
	 * would consume randomness on every physics step — harmless for correctness, but it would make the
	 * effective rate depend on touch frequency in a way the constants do not describe.
	 */
	private rollBounce(_belt: BasePart, other: BasePart): void {
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

		// Clearing the velocity matters: the tag is the only thing that says "this part is a belt", so
		// an untagged part must stop dragging immediately instead of coasting on its last speed.
		if (instance.Anchored) {
			instance.AssemblyLinearVelocity = Vector3.zero;
		}
	}

	private applySpeed(part: BasePart, reason: string): void {
		if (!part.Anchored) {
			// Applying an assembly velocity to an unanchored part does not make it a belt, it makes it a
			// projectile. Refusing is safer than warning and applying anyway, and the warn is what tells
			// a designer why their belt does nothing.
			warn(`[Treadmill] ${part.GetFullName()} is tagged ${TAGS.treadmillBelt} but not anchored; skipping.`);
			return;
		}

		if (!part.CanCollide) {
			// Not fatal — a belt with collision off has nothing resting on it, so the velocity is inert.
			warn(`[Treadmill] ${part.GetFullName()} has CanCollide = false; nothing can rest on it to be dragged.`);
		}

		const speed = this.readSpeed(part);
		part.AssemblyLinearVelocity = part.CFrame.RightVector.mul(speed);

		// The `appliedVelocity` component is read back off the property rather than reused from the
		// expression above: the whole point of this line is to report what the engine is actually
		// holding, and reusing the local would report what this code intended instead. If those ever
		// differ, that difference is the finding.
		print(
			`[Treadmill] ${reason} "${part.GetFullName()}" size=${formatVector(part.Size)} origin=${formatVector(part.Position)} rightVector=${formatVector(part.CFrame.RightVector)} BeltSpeed=${formatNumber(speed)} appliedVelocity=${formatVector(part.AssemblyLinearVelocity)}`,
		);
	}

	private readSpeed(part: BasePart): number {
		const raw = part.GetAttribute(BELT_SPEED_ATTRIBUTE);
		return typeIs(raw, "number") ? raw : DEFAULT_BELT_SPEED;
	}
}
