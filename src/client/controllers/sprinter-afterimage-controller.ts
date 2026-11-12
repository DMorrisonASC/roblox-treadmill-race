import { CollectionService, ReplicatedStorage, RunService } from "@rbxts/services";
import { beltForward } from "client/belt-frame";
import { Controller, OnStart } from "@flamework/core";
import { SPRINTER_AFTERIMAGE_ATTRIBUTE } from "shared/attributes";
import { TAGS } from "shared/tags";
import {
	SPRINTER_AFTERIMAGE_ASSET_NAME,
	SPRINTER_AFTERIMAGE_ENABLED,
	SPRINTER_AFTERIMAGE_HEADING_OFFSET_DEGREES,
	SPRINTER_AFTERIMAGE_SCALE_MULTIPLIER,
} from "shared/config/sprinterAfterimage.config";
import { effectScaleFor, scaleEffect, vfxFrameFor, vfxHeadingOffset } from "shared/vfx-scale";

/**
 * The `sprinter` afterimage: a trailing copy of the ball that exists exactly while a sprinter body is `Boosted`.
 *
 * ## What it is for
 *
 * `sprinter` is the only power that spends a whole round above `BELT_SPEED` - its pickup sets `SPRINTER_BOOST_SPEED` and
 * decay is slow enough that `Boosted` stays true until the ball is nearly stationary. That is a long, quiet advantage, and
 * a viewer has no way to tell a sprinter from a lucky ball without reading the badge. The afterimage is the readable form
 * of "this one is still running".
 *
 * ## Why it copies `TailWindController` and not `WindBoostController`
 *
 * Both are the same skeleton - resolve one asset at boot, watch one boolean attribute, clone on `true`, destroy on
 * `false` - and the newer of the two (`tailWind`) is the one whose docblock carries the three mistakes the pair already
 * made: a weld that preserved the asset's authored offset (item 96), a rotation inherited from the physics tumble
 * (item 97), and a scale implemented twice and drifted tenfold (item 101). Copying the newer file copies the corrections.
 *
 * ## Why the clone is anchored and repositioned rather than welded
 *
 * `Clone()` copies the template's `CFrame`, which is wherever the asset was authored inside `ReplicatedStorage`, and a
 * `WeldConstraint` **preserves the offset the two parts already have** instead of snapping them together - the first
 * `windBoost` was drawn in the sky and dragged around at the asset's distance from the ball. So the clone is anchored, its
 * `CFrame` is recomposed every frame from **the ball's position and the asset's authored rotation**, and one
 * `RenderStepped` loop applies it to every afterimage.
 *
 * ## Why the rotation is the asset's and not the ball's
 *
 * The body's `CFrame.Rotation` is the physics tumble that `ball-render-controller` exists to hide; an effect that inherited
 * it would spin with the body. Item 97 settled this: rotation from the asset, position from the body.
 *
 * ## Why there is no `MaxDistance`
 *
 * A `BillboardGui` has one; this is a **part**, and a `BasePart` has no such property - the effect is ordinary 3D geometry
 * and is culled by the engine's own frustum and occlusion like everything else. The two trails this is modelled on set no
 * distance either. If the afterimage ever needs a distance cut it will need to be a `BillboardGui`, which is a different
 * effect rather than a property.
 *
 * ## Why no timer and no client-side condition
 *
 * The afterimage is present exactly while the attribute is true, and the server owns that condition - `sprinter` **and**
 * `Boosted`, settled on the tick that also writes `Boosted`. A timer here would decouple the picture from the state it
 * reports, and a client-side re-derivation would be a second copy of a rule that must not have two owners.
 */
@Controller()
export class SprinterAfterimageController implements OnStart {
	/** Resolved once at boot and held - the asset is read **once**, never per attachment. */
	private asset?: BasePart;

	/** The asset's authored rotation, applied to every clone. See the class docblock's rotation paragraph. */
	private assetRotation = CFrame.identity;

	/** One live clone per boosted sprinter, so a repeat `true` cannot stack a second copy. */
	private readonly afterimages = new Map<BasePart, BasePart>();

	/** Per-ball connections, disconnected on `Destroying` so a dead ball takes no listener with it. */
	private readonly ballConnections = new Map<BasePart, Array<RBXScriptConnection>>();

	/** The service-level connections - the tag listeners and the render loop. */
	private readonly connections = new Array<RBXScriptConnection>();

	public onStart(): void {
		// **The kill switch is checked before the asset is looked for**, so a session with the effect turned off prints one
		// line about the decision rather than a warning about a missing asset it was never going to use.
		if (!SPRINTER_AFTERIMAGE_ENABLED) {
			print(
				`[SprinterAfterimage] disabled by SPRINTER_AFTERIMAGE_ENABLED - boosted sprinters will have no afterimage.`,
			);
			return;
		}

		// Recursive and by name, exactly as `hitEffect`, `windBoost` and `tailWind` resolve theirs: the pack sits inside
		// `assets/vfx`, which the one-argument `FindFirstChild` cannot see.
		const found = ReplicatedStorage.FindFirstChild(SPRINTER_AFTERIMAGE_ASSET_NAME, true);

		if (found === undefined) {
			// Two refusals, two messages: "not found" sends the reader to the Explorer to author the asset, "found but the
			// wrong class" sends them to its class. Neither branch stores anything, and both leave the game playable.
			warn(
				`[SprinterAfterimage] searched ReplicatedStorage recursively for an instance named "${SPRINTER_AFTERIMAGE_ASSET_NAME}" and found none - boosted sprinters will have no afterimage this session. The effect is a Studio asset: a BasePart, optionally containing an Attachment with ParticleEmitters.`,
			);
			return;
		}

		if (!found.IsA("BasePart")) {
			warn(
				`[SprinterAfterimage] found ${found.GetFullName()} but it is a ${found.ClassName}, not a BasePart - boosted sprinters will have no afterimage this session.`,
			);
			return;
		}

		this.asset = found;
		this.assetRotation = found.CFrame.Rotation;

		print(
			`[SprinterAfterimage] mounted on ${found.GetFullName()} (${found.ClassName}) scale=${SPRINTER_AFTERIMAGE_SCALE_MULTIPLIER} offset=${SPRINTER_AFTERIMAGE_HEADING_OFFSET_DEGREES}deg (own tuners, see shared/config/sprinterAfterimage.config.ts)`,
		);

		// Both discovery paths: the startup scan catches a client joining mid-`Playing` with bodies already boosted, and the
		// signal catches every body after that.
		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			this.track(instance);
		}

		this.connections.push(
			CollectionService.GetInstanceAddedSignal(TAGS.ball).Connect((instance) => this.track(instance)),
		);
		this.connections.push(
			CollectionService.GetInstanceRemovedSignal(TAGS.ball).Connect((instance) => {
				if (instance.IsA("BasePart")) {
					this.afterimages.delete(instance);
				}
			}),
		);
		this.connections.push(RunService.RenderStepped.Connect(() => this.syncAfterimages()));
	}

	/**
	 * Starts watching one ball's attribute and renders its current value immediately.
	 *
	 * The immediate read matters: a client joining a round mid-flight sees bodies that are **already** boosted, and for them
	 * the attribute will not change again until the ball decays out of the band - which for a sprinter is nearly the whole
	 * round. Waiting for a change would mean no afterimage at all.
	 */
	private track(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		const ball = instance;
		if (this.ballConnections.has(ball)) {
			return;
		}

		const connections = new Array<RBXScriptConnection>();
		this.ballConnections.set(ball, connections);

		connections.push(
			ball.GetAttributeChangedSignal(SPRINTER_AFTERIMAGE_ATTRIBUTE).Connect(() => this.render(ball)),
		);
		connections.push(
			ball.Destroying.Connect(() => {
				this.detach(ball);
				this.forget(ball);
			}),
		);

		this.render(ball);
	}

	/** `true` → a clone exists; anything else → it does not. Idempotent in both directions. */
	private render(ball: BasePart): void {
		if (ball.GetAttribute(SPRINTER_AFTERIMAGE_ATTRIBUTE) === true) {
			this.attach(ball);
			return;
		}

		this.detach(ball);
	}

	/** Clones the asset onto a boosted sprinter: inert, positioned from the ball, scaled, parented under the body. */
	private attach(ball: BasePart): void {
		const asset = this.asset;
		if (asset === undefined || this.afterimages.has(ball)) {
			return;
		}

		const clone = asset.Clone();
		clone.Name = `${SPRINTER_AFTERIMAGE_ASSET_NAME}_${ball.Name}`;
		clone.Anchored = true;
		clone.CanCollide = false;
		clone.CanQuery = false;
		clone.CanTouch = false;
		clone.Transparency = 1;

		// Re-based before anything looks at it: the template's CFrame is wherever the asset was authored, and the first frame
		// is the one the player sees appear.
		clone.CFrame = this.frameFor(ball);

		// The shared five-property scale, from the same module the other two effects use (item 101): one implementation, three
		// multipliers.
		scaleEffect(clone, effectScaleFor(ball, SPRINTER_AFTERIMAGE_SCALE_MULTIPLIER));

		clone.Parent = ball;
		this.afterimages.set(ball, clone);
	}

	/** Destroys the clone for one ball, if there is one. */
	private detach(ball: BasePart): void {
		const afterimage = this.afterimages.get(ball);
		if (afterimage === undefined) {
			return;
		}

		afterimage.Destroy();
		this.afterimages.delete(ball);
	}

	/** Drops one ball's connections and bookkeeping - called from `Destroying` and nowhere else. */
	private forget(ball: BasePart): void {
		const connections = this.ballConnections.get(ball);
		if (connections !== undefined) {
			for (const connection of connections) {
				connection.Disconnect();
			}

			this.ballConnections.delete(ball);
		}

		this.afterimages.delete(ball);
	}

	/**
	 * The ball's **position**, the belt's **forward direction**, the asset's **tilt**. The ball's own rotation is never read.
	 *
	 * `vfxFrameFor` keeps the asset's roll and takes the yaw from the belt (item 176: an authored yaw is wherever the author
	 * left it, so two copies faced different ways and neither faced anything meaningful); `vfxHeadingOffset` then turns it by
	 * this effect's own quarter turn.
	 */
	private frameFor(ball: BasePart): CFrame {
		const forward = beltForward();
		if (forward === undefined) {
			return new CFrame(ball.Position).mul(this.assetRotation);
		}

		return vfxHeadingOffset(
			vfxFrameFor(ball.Position, forward, this.assetRotation),
			SPRINTER_AFTERIMAGE_HEADING_OFFSET_DEGREES,
		);
	}

	/**
	 * Copies every ball's transform onto its clone. One `RenderStepped` connection for the whole system.
	 *
	 * Per-ball connections would be one listener per boosted body, and a round's sprinters all enter and leave the state
	 * together; one loop over the map is the same work without a connection created and destroyed at each transition.
	 */
	private syncAfterimages(): void {
		for (const [ball, afterimage] of this.afterimages) {
			afterimage.CFrame = this.frameFor(ball);
		}
	}
}
