import { CollectionService, ReplicatedStorage, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { TAIL_WIND_ATTRIBUTE } from "shared/attributes";
import { TAGS } from "shared/tags";
import { VFX_SCALE_MULTIPLIER } from "shared/tuning";
import { effectScaleFor, scaleEffect } from "shared/vfx-scale";

/**
 * The tail-wind effect's name in `ReplicatedStorage`, and the whole of the contract with it: a `BasePart` carrying an
 * `Attachment` carrying one or more `ParticleEmitter`s, the same pack `hitEffect` and `windBoost` belong to. This file never
 * creates the asset, never substitutes it and never names an asset id — if the instance is missing, the round is
 * misconfigured and says so once.
 */
const ASSET_NAME = "tailWind";

/**
 * The tail trail: a persistent effect on every ball that is **in regular motion** — losing ground, visibly rolling, not boosted.
 *
 * ## Why this is a separate controller and not a branch in `WindBoostController`
 *
 * They read different attributes, they can be on for disjoint sets of balls, and one of them has already been rewritten three
 * times while the other is new. A single controller with two paths would have to name both assets, both transitions and both
 * attribute names in one file and one docblock. The duplication that remains is the resolution-and-frame-loop skeleton, which
 * is the part the tree has settled and neither file is likely to change.
 *
 * **The scale is *not* duplicated** — it was, and item 101 is the bug that came of it. Both effects call
 * `shared/vfx-scale.ts`, so "the same size as `windBoost`" is a structural fact rather than two constants that happen to
 * match today.
 *
 * ## The precedence rule is not here
 *
 * **`tailWind` plays exactly when `TailWind` is true, and `TailWind` is true only when `Boosted` is false.** That is decided in
 * `BallSpawnerService.writeTailWind`, on the same tick and from the same numbers as `Boosted` itself, so this controller can
 * never play alongside `windBoost`. Reading `Boosted` here would be a second copy of the rule, and the second copy is the one
 * that drifts — so this file contains no reference to it at all.
 *
 * ## Why the clone is anchored and positioned rather than welded
 *
 * The same reason `windBoost` is (item 96): `Clone()` copies the template's `CFrame`, the asset is authored inside
 * `ReplicatedStorage` rather than at the arena, and a `WeldConstraint` **preserves the offset the two parts already have**
 * instead of snapping them together — which put the first version of that effect in the sky and dragged it around at the
 * asset's distance from the ball. This one is anchored, its `CFrame` is composed each frame from **the ball's position and the
 * asset's authored rotation**, and one `RenderStepped` loop applies it to every trail.
 *
 * ## Orientation
 *
 * The asset's authored rotation, captured once at boot and applied unchanged — the same rule as `windBoost` (item 97). The
 * ball's own `CFrame.Rotation` is never read: it is the physics tumble that `ball-render-controller` exists to hide, and an
 * effect that inherited it would spin with the body.
 *
 * ## Why no timer, and why no client-side condition
 *
 * The trail is present exactly while the attribute is true, which is while the server says the ball is in that state. A timer
 * would decouple the picture from the state it reports; a client-side re-derivation would decide the state a second time.
 */
@Controller()
export class TailWindController implements OnStart {
	/** Resolved once at boot and held — the asset is read **once**, never per attachment. */
	private asset?: BasePart;

	/** The asset's authored rotation, applied to every trail. See the class docblock's `Orientation`. */
	private assetRotation = CFrame.identity;

	/** One live clone per ball in regular motion, so a repeat `true` cannot stack a second trail. */
	private readonly trails = new Map<BasePart, BasePart>();

	/** Per-ball connections, disconnected on `Destroying` so a dead ball takes no listener with it. */
	private readonly ballConnections = new Map<BasePart, Array<RBXScriptConnection>>();

	/** The service-level connections — the tag listeners and the render loop. */
	private readonly connections = new Array<RBXScriptConnection>();

	public onStart(): void {
		// **Recursive, and by name**, exactly as `hitEffect` and `windBoost` resolve theirs: the pack sits inside
		// `assets/vfx`, which the one-argument `FindFirstChild` cannot see. No wait — the asset is authored in the place, so it
		// is present when the client's scripts start.
		const found = ReplicatedStorage.FindFirstChild(ASSET_NAME, true);

		if (found === undefined) {
			// Two refusals, two messages: "not found" sends the reader to the Explorer to build the asset, "found but the wrong
			// class" sends them to its class. Neither branch stores anything.
			warn(
				`[TailWind] searched ReplicatedStorage recursively for an instance named "${ASSET_NAME}" and found none — decaying balls will have no trail this session. The effect is a Studio asset: a BasePart containing an Attachment containing one or more ParticleEmitters.`,
			);
			return;
		}

		if (!found.IsA("BasePart")) {
			warn(
				`[TailWind] found ${found.GetFullName()} but it is a ${found.ClassName}, not a BasePart — decaying balls will have no trail this session.`,
			);
			return;
		}

		this.asset = found;
		this.assetRotation = found.CFrame.Rotation;

		// The full path and the class, so a Studio run proves *which* instance was picked rather than leaving it to be inferred.
		print(
			`[TailWind] mounted on ${found.GetFullName()} (${found.ClassName}) scale=${VFX_SCALE_MULTIPLIER} (shared, see shared/vfx-scale.ts)`,
		);

		// Both discovery paths, for the reason the other two effect controllers keep both: the tag signal is the one that works,
		// and the startup scan catches a client joining mid-`Playing` with bodies already in the world.
		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			this.track(instance);
		}

		this.connections.push(
			CollectionService.GetInstanceAddedSignal(TAGS.ball).Connect((instance) => this.track(instance)),
		);
		this.connections.push(
			CollectionService.GetInstanceRemovedSignal(TAGS.ball).Connect((instance) => {
				if (instance.IsA("BasePart")) {
					this.trails.delete(instance);
				}
			}),
		);
		this.connections.push(RunService.RenderStepped.Connect(() => this.syncTrails()));
	}

	/**
	 * Starts watching one ball's `TailWind` attribute and renders its current value immediately.
	 *
	 * The immediate read matters: a ball that is already decaying when this client first sees it must get its trail now rather
	 * than at the next attribute change, which for a monotone decay could be never.
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

		connections.push(ball.GetAttributeChangedSignal(TAIL_WIND_ATTRIBUTE).Connect(() => this.render(ball)));
		connections.push(
			ball.Destroying.Connect(() => {
				this.detach(ball);
				this.forget(ball);
			}),
		);

		this.render(ball);
	}

	/** `true` → a trail exists; anything else → it does not. Idempotent in both directions. */
	private render(ball: BasePart): void {
		if (ball.GetAttribute(TAIL_WIND_ATTRIBUTE) === true) {
			this.attach(ball);
			return;
		}

		this.detach(ball);
	}

	/** Clones the asset onto a ball in regular motion: inert, positioned from the ball, scaled, parented under the body. */
	private attach(ball: BasePart): void {
		const asset = this.asset;
		if (asset === undefined || this.trails.has(ball)) {
			return;
		}

		const clone = asset.Clone();
		clone.Name = `${ASSET_NAME}_${ball.Name}`;
		clone.Anchored = true;
		clone.CanCollide = false;
		clone.CanQuery = false;
		clone.CanTouch = false;
		clone.Transparency = 1;

		// Re-based before anything looks at it: the template's CFrame is wherever the asset was authored, and the first frame is
		// the one the player sees appear.
		clone.CFrame = this.frameFor(ball);

		// **The same call `windBoost` makes, from the same module** (item 101): one multiplier, one implementation of the
		// five-property scale, so the two effects cannot be drawn at different sizes again.
		scaleEffect(clone, effectScaleFor(ball));

		clone.Parent = ball;
		this.trails.set(ball, clone);
	}

	/** Destroys the trail for one ball, if there is one. */
	private detach(ball: BasePart): void {
		const trail = this.trails.get(ball);
		if (trail === undefined) {
			return;
		}

		trail.Destroy();
		this.trails.delete(ball);
	}

	/** Drops one ball's connections and bookkeeping — called from `Destroying` and nowhere else. */
	private forget(ball: BasePart): void {
		const connections = this.ballConnections.get(ball);
		if (connections !== undefined) {
			for (const connection of connections) {
				connection.Disconnect();
			}

			this.ballConnections.delete(ball);
		}

		this.trails.delete(ball);
	}

	/** The ball's **position**, the asset's **authored rotation**. The ball's own rotation is never read. */
	private frameFor(ball: BasePart): CFrame {
		return new CFrame(ball.Position).mul(this.assetRotation);
	}

	/**
	 * Copies every ball's transform onto its trail. One `RenderStepped` connection for the whole system.
	 *
	 * Per-ball connections would be one listener per ball in regular motion, and at `Playing` entry most of the field passes
	 * through that state — one loop over the `trails` map is the same work without a connection created and destroyed as each
	 * ball crosses the threshold.
	 */
	private syncTrails(): void {
		for (const [ball, trail] of this.trails) {
			trail.CFrame = this.frameFor(ball);
		}
	}
}
