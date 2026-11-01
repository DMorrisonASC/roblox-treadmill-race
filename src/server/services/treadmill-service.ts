import { CollectionService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BELT_SPEED_ATTRIBUTE, DEFAULT_BELT_SPEED } from "shared/attributes";
import { TAGS } from "shared/tags";

/**
 * Drags anything resting on a `TreadmillBelt` part across its surface.
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
			.Connect(() => this.applySpeed(instance));
		this.bound.set(instance, connection);
		this.applySpeed(instance);
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

		// Clearing the velocity matters: the tag is the only thing that says "this part is a belt", so
		// an untagged part must stop dragging immediately instead of coasting on its last speed.
		if (instance.Anchored) {
			instance.AssemblyLinearVelocity = Vector3.zero;
		}
	}

	private applySpeed(part: BasePart): void {
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
	}

	private readSpeed(part: BasePart): number {
		const raw = part.GetAttribute(BELT_SPEED_ATTRIBUTE);
		return typeIs(raw, "number") ? raw : DEFAULT_BELT_SPEED;
	}
}
