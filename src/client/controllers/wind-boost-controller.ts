import { CollectionService, ReplicatedStorage, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { BOOSTED_ATTRIBUTE } from "shared/attributes";
import { TAGS } from "shared/tags";

/**
 * The wind-boost effect's name in `ReplicatedStorage`, and the whole of the contract with it: a `BasePart` carrying an
 * `Attachment` carrying one or more `ParticleEmitter`s, exactly like `hitEffect` beside it. This file never creates the
 * asset, never substitutes it, and never names an asset id — if the instance is missing, the round is misconfigured and
 * says so once.
 */
const ASSET_NAME = "windBoost";

/**
 * **Placeholder.** The ball radius the asset was drawn against, in studs.
 *
 * The VFX pack is authored for a 1x1x1 ball (radius 0.5). Every distance in a clone is multiplied by
 * `(ball.Size.X / 2) / BASE_BALL_RADIUS`, so changing the ball's `Size` in `ball-spawner-service` resizes the effect with
 * no edit here or in the asset. This constant is the *assumption that can go stale*: if the pack is redrawn for a
 * different ball, this is the number to change, and it is the only one.
 */
const BASE_BALL_RADIUS = 0.5;

/**
 * **Placeholder.** A flat multiplier on the whole effect, on top of the ball ratio.
 *
 * `1` means "exactly the ball's scale". The knob exists because "the effect is right in shape but wrong in size" is a
 * judgement no ratio can encode — a trail that reads well at 1:1 on a 1-stud ball may want to be wider. Anything other
 * than `1` here is a design change, not a fix.
 */
const WIND_BOOST_SCALE_MULTIPLIER = 0.1;

/**
 * The wind trail: a persistent effect that follows every ball at or above belt speed.
 *
 * ## Why this is not `HitEffectController`
 *
 * The two share a lookup, an asset shape and a client-side clone, and nothing else. A hit is a **one-shot**: clone, emit,
 * `Debris`. A boost is a **state**: present while `Boosted` is `true`, gone the moment it is `false` or the ball dies.
 * Copying the hit controller's shape would produce a trail that flickers out half a second after it appears; what is
 * copied is its resolution pattern (recursive find by name, two refusals, one boot line naming what was found) and its
 * willingness to build the effect on the client rather than replicate instances from the server.
 *
 * ## How the clone follows the ball, and why not the obvious way
 *
 * `HitEffectController` builds a stationary carrier at the contact midpoint because a burst happens at a *place*; a trail
 * happens at a *body*. The first version of this file welded the clone to the ball (`WeldConstraint`) and the effect
 * appeared **in the sky**, following the ball from there — the item-86 bug in a new place. `Clone()` copies the template's
 * `CFrame`, the asset is authored inside `ReplicatedStorage` rather than at the arena, and a weld **preserves the offset
 * the two parts already have** instead of snapping them together. So the weld faithfully locked in "the distance from the
 * ball to where the effect was built".
 *
 * What this does instead: the clone is `Anchored = true`, its `CFrame` is composed each frame from **the ball's position and
 * the asset's authored rotation** (`frameFor`), and one `RenderStepped` loop applies that to every trail (`syncTrails`).
 * Nothing simulates the clone, there is no constraint to get the offset wrong, and it does not matter that the ball is
 * server-owned and replicated rather than locally simulated. The cost is one loop over the live trails per frame, which is
 * the same order as `marker-spin-controller` already pays for the markers.
 *
 * **Position follows the ball; orientation does not.** The effect is parallel to the ground because it was built that way in
 * Studio, and a ball's rotation is a per-body accident (a random spawn tumble, then rolling). Copying `ball.CFrame`
 * wholesale — the first attempt at this — made the trail spin with the body; item 97 records that, and `frameFor` is where
 * the rule now lives.
 *
 * ## Why the clone is parented to the ball
 *
 * So `Destroy()` on the ball takes the trail with it. There is therefore no path where a dead ball can leave an effect
 * behind, and no map here has to be swept on a schedule — `destroying` clears the bookkeeping, and the clone is already
 * gone.
 *
 * ## What this controller does not decide
 *
 * **Not whether a ball is boosted** — the server writes that, from the one function that knows what every contributor did
 * to `BALL_SPEED` this tick. This file reads the attribute and renders it, which is the same division
 * `marker-spin-controller` uses for the markers' rate.
 */
@Controller()
export class WindBoostController implements OnStart {
	/** Resolved once at boot and held — the asset is read **once**, never per attachment. */
	private asset?: BasePart;

	/**
	 * The asset's **authored rotation**, captured at boot and used for every trail.
	 *
	 * This is what "parallel to the ground" means in code: whatever orientation the effect was built with in Studio, applied
	 * unchanged to every ball. The ball's own rotation is deliberately **not** used — see `frameFor`.
	 */
	private assetRotation = CFrame.identity;

	/** One live clone per boosted ball, so a repeat `true` cannot stack a second trail on the same body. */
	private readonly trails = new Map<BasePart, BasePart>();

	/** Per-ball connections, so a dead ball takes them with it. Keyed by the ball, disconnected on `Destroying`. */
	private readonly ballConnections = new Map<BasePart, Array<RBXScriptConnection>>();

	/** The service-level connections — the tag listener and the render loop — kept so their types are not discarded. */
	private readonly connections = new Array<RBXScriptConnection>();

	public onStart(): void {
		// **Recursive, and by name.** `FindFirstChild(name, true)` walks every descendant of `ReplicatedStorage`, folders
		// included — the same fix item 85 needed for `hitEffect`, which sat inside `assets/vfx` and was invisible to the
		// one-argument form. No wait: the asset is authored in the place, so it is present when the client's scripts start.
		const found = ReplicatedStorage.FindFirstChild(ASSET_NAME, true);

		if (found === undefined) {
			// Two refusals, two messages: "not found" sends the reader to the Explorer to build the asset, "found but the
			// wrong class" sends them to its class. Neither branch stores anything, so a reference that failed a check can
			// never become `this.asset`.
			warn(
				`[WindBoost] searched ReplicatedStorage recursively for an instance named "${ASSET_NAME}" and found none — boosted balls will have no trail this session. The effect is a Studio asset: a BasePart containing an Attachment containing one or more ParticleEmitters.`,
			);
			return;
		}

		if (!found.IsA("BasePart")) {
			warn(
				`[WindBoost] found ${found.GetFullName()} but it is a ${found.ClassName}, not a BasePart — boosted balls will have no trail this session.`,
			);
			return;
		}

		this.asset = found;

		// **The authored rotation, kept.** `found.CFrame` is the whole transform of the template in `ReplicatedStorage` — its
		// position is meaningless here (that is item 96) but its *rotation* is the effect's designed orientation, and it is the
		// only part of the template's CFrame that is carried onto every clone. Captured once so a per-frame read of the asset
		// is not on the hot path.
		this.assetRotation = found.CFrame.Rotation;

		// **The full path and the class, so a Studio run proves *which* instance was picked.** A recursive search can match
		// something that is not the asset the reader meant only if a second instance of that name exists, and the path is
		// how that is noticed rather than inferred. It is also how a `windBoost` that ended up somewhere other than beside
		// `hitEffect` becomes visible in one line instead of as a missing effect.
		print(`[WindBoost] mounted on ${found.GetFullName()} (${found.ClassName})`);

		// Both discovery paths, for the reason `marker-spin-controller` keeps both: the tag signal is the one that works,
		// and the startup scan catches the reconnect case where the server's bodies already exist when this client's
		// scripts start.
		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			this.track(instance);
		}

		this.connections.push(
			CollectionService.GetInstanceAddedSignal(TAGS.ball).Connect((instance) => this.track(instance)),
		);

		// **One frame loop for every trail**, not one per ball: see `syncTrails` for why, and `attach` for why this is a
		// `CFrame` copy rather than a weld.
		this.connections.push(RunService.RenderStepped.Connect(() => this.syncTrails()));
	}

	/**
	 * Starts watching one ball's `Boosted` attribute, and renders its current value immediately.
	 *
	 * The immediate read matters: a body tagged mid-round arrives already `true`, and waiting for the next attribute write
	 * would leave it trail-less until it decayed and re-crossed. `Destroying` is the only teardown hook — a ball is
	 * destroyed when it leaves the round, and a clone parented to it goes with it.
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

		connections.push(ball.GetAttributeChangedSignal(BOOSTED_ATTRIBUTE).Connect(() => this.render(ball)));
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
		if (ball.GetAttribute(BOOSTED_ATTRIBUTE) === true) {
			this.attach(ball);
			return;
		}

		this.detach(ball);
	}

	/**
	 * Clones the asset onto a boosted ball: inert, positioned on the body, scaled, parented under it.
	 *
	 * ## Why the clone is anchored and positioned instead of welded (item 96)
	 *
	 * The first version welded it — `WeldConstraint`, `Part0 = ball`, `Part1 = clone` — and the effect appeared **in the sky**
	 * and followed the ball from there. The cause is the same one item 86 found for the hit burst: **`Clone()` copies the
	 * template's `CFrame`**, and the asset is authored inside `ReplicatedStorage`, hundreds of studs from the arena. Parenting
	 * does not re-base a part, and a `WeldConstraint` does not snap two parts together — it *preserves the offset they already
	 * have*. So the weld locked in "however far the asset's CFrame was from the ball" and faithfully dragged the effect around
	 * the sky at that offset.
	 *
	 * There is also a second reason not to weld here: the ball is pinned server-owned, so on a client it is a replicated body
	 * rather than a locally simulated one, and a client-made unanchored part welded to it depends on physics behaviour this
	 * code cannot see. `Anchored = true` plus a per-frame `CFrame` copy (`syncTrails`, one connection for every trail) has no
	 * such dependency: nothing simulates the clone, gravity cannot touch it, and its transform is a value this controller
	 * assigns rather than a constraint result.
	 *
	 * `CanCollide`, `CanQuery` and `CanTouch` are off for the obvious reason: this is a picture, and a part in the ball's
	 * collision set would move the ball. `Transparency = 1` because the root is a carrier for the attachment tree — the
	 * particles are the effect.
	 */
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

		// **Position from the ball, rotation from the asset (item 97).** The first version copied `ball.CFrame` wholesale and
		// the effect spun: a ball spawns with a random tumble (`randomSpawnRotation` in the spawner) and then rolls, so its
		// rotation is a per-body accident. The trail's orientation is a *design* — the one the asset was built with — and it
		// has to be applied unchanged or the effect tumbles with the body it is attached to.
		clone.CFrame = this.frameFor(ball);

		// **The scale is derived from the ball, not from the asset.** `ball.Size.X / 2` is the ball's radius today (the tree is
		// spheres-only), and the ratio against the radius the pack was drawn at is what lets a designer change `Size` in
		// `ball-spawner-service` without touching this file or the asset.
		const radius = ball.Size.X / 2;
		scaleEffect(clone, (radius / BASE_BALL_RADIUS) * WIND_BOOST_SCALE_MULTIPLIER);

		clone.Parent = ball;
		this.trails.set(ball, clone);
	}

	/**
	 * The transform a trail should have: the ball's **position**, the asset's **authored rotation**.
	 *
	 * ## Why the ball's rotation is not used
	 *
	 * Because it is not a property of the effect. `spawnBall` gives every body a random orientation (`randomSpawnRotation`)
	 * and the engine then rolls it as it travels, so `ball.CFrame.Rotation` is a different accident on every body and on every
	 * frame. Copying it made the trail tumble with the ball — reported as "spinning everywhere". The effect is **parallel to
	 * the ground because it was built that way in Studio**, and the only way to keep that is to apply the authored rotation
	 * unchanged.
	 *
	 * Position has to come from the ball, or the effect stays where the asset was authored (item 96, the sky).
	 *
	 * `CFrame.new(ball.Position) * rotation` rather than `CFrame.new(ball.CFrame.Position, ball.CFrame.Position + …)`: the
	 * multiply composes the authored basis onto a translation-only frame, so no look-vector arithmetic is needed and the
	 * asset's exact rotation matrix (including any roll the designer gave it) survives untouched.
	 */
	private frameFor(ball: BasePart): CFrame {
		return new CFrame(ball.Position).mul(this.assetRotation);
	}

	/**
	 * Copies every ball's transform onto its trail. One `RenderStepped` connection for the whole system.
	 *
	 * Per-ball connections would be one listener per boosted ball, and at `Playing` entry every ball is boosted — fifty of
	 * them. One loop over the `trails` map is the same work without fifty connections to make and break as balls cross the
	 * threshold, and it cannot leak a connection for a ball that died.
	 *
	 * `RenderStepped` rather than `Heartbeat`: nothing here is physics, the clone is anchored, and this is the frame the
	 * picture is drawn in. The ball's own `CFrame` is replicated, so the *position* a trail can reach is no smoother than the
	 * ball it follows — this only guarantees it is never behind by more than a frame. Its rotation does not come from the ball
	 * at all (see `frameFor`), so a rolling body cannot spin the effect.
	 */
	private syncTrails(): void {
		for (const [ball, trail] of this.trails) {
			trail.CFrame = this.frameFor(ball);
		}
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

	/** Drops one ball's connections and its bookkeeping — called from `Destroying` and nowhere else. */
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
}

/**
 * Scales one cloned effect by `ratio`, on **the five properties that are distances**.
 *
 * ## Why `Size` is not `emitter.Size = emitter.Size * ratio`
 *
 * `ParticleEmitter.Size` is a `NumberSequence`, not a number — `new NumberSequence(0.5, 1.5)` is a ramp, and a later reader
 * who writes `emitter.Size = 2` gets a type error that reads as a mystery because the property *looks* like a scalar.
 * Scaling it means rebuilding the sequence: every `NumberSequenceKeypoint`'s `Value` **and** `Envelope` multiplied, with
 * `Time` left alone (time is not a distance). `NumberSequence` is immutable in the typings, so there is no in-place path.
 *
 * ## What is scaled, and why only these
 *
 * `Size` (a `NumberSequence`), `Speed` (a `NumberRange`), `Acceleration` (a `Vector3`), `Attachment.Position` (a `Vector3`)
 * and the clone's own root `Size` — every one of them is measured in studs. **`Rate`, `Lifetime`, `Color`, `Transparency`,
 * `LightEmission`, `Rotation`, `RotSpeed`, `SpreadAngle`, `EmissionDirection` and `Drag` are deliberately not scaled**:
 * they are design and time, not distance. A bigger ball does not want a faster or longer-lived particle, it wants the same
 * effect stretched — scaling `Rate` would make the trail denser purely because the ball grew, which is a different effect,
 * not a larger one.
 *
 * The invisible root `BasePart` is scaled too even though nothing renders it: a part with a stale size shows up in hitbox
 * visualisations and tells a later reader the wrong thing about the effect.
 */
function scaleEffect(root: BasePart, ratio: number): void {
	if (ratio === 1) {
		return;
	}

	root.Size = root.Size.mul(ratio);

	for (const descendant of root.GetDescendants()) {
		if (descendant.IsA("Attachment")) {
			descendant.Position = descendant.Position.mul(ratio);
		} else if (descendant.IsA("ParticleEmitter")) {
			const keypoints = new Array<NumberSequenceKeypoint>();

			for (const keypoint of descendant.Size.Keypoints) {
				keypoints.push(
					new NumberSequenceKeypoint(keypoint.Time, keypoint.Value * ratio, keypoint.Envelope * ratio),
				);
			}

			descendant.Size = new NumberSequence(keypoints);
			descendant.Speed = new NumberRange(descendant.Speed.Min * ratio, descendant.Speed.Max * ratio);
			descendant.Acceleration = descendant.Acceleration.mul(ratio);
		}
	}
}
