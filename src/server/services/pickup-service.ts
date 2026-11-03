import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BALL_SPEED_ATTRIBUTE } from "shared/attributes";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import {
	BELT_SURFACE_THICKNESS,
	BOOST_TARGET_BALL_SPEED,
	MAX_CONCURRENT_PICKUPS,
	PICKUP_CLUSTER_LOCAL_X,
	PICKUP_COLOR,
	PICKUP_COUNT,
	PICKUP_SIZE,
	PICKUP_SPAWN_INTERVAL_SECONDS,
	PICKUP_Z_EDGE_INSET,
	PICKUPS_FOLDER_NAME,
} from "shared/tuning";

/**
 * Three-decimal rounding, matching the formatter the other services use so two log lines are comparable.
 */
function formatNumber(value: number): string {
	return tostring(math.round(value * 1000) / 1000);
}

/** How long to wait for the server-created `RoundState` before giving up loudly. */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * Puts consumable boost triangles on the belt and raises a ball's speed when one is touched.
 *
 * ## Why the boost is applied on the server
 *
 * The impulse is a velocity change, and velocity changes that matter to the race have to be identical for
 * every player. Balls are pinned server-owned (`BallSpawnerService.spawnBall`), so a client-side write would
 * either be discarded by replication or produce a ball only its owner sees moving faster. The whole point of
 * a pickup is that it is in the world for everyone, so it is applied where the physics runs.
 *
 * ## Why the boost is a velocity *set*, not an impulse
 *
 * An impulse would need a mass to be comparable between shapes, and it would overshoot for a light body and
 * undershoot for a heavy one. Setting the along-belt component to a target makes the outcome the same for
 * every ball — which is what "the pickup gives you 8" has to mean — while leaving the other two components
 * alone, so a ball crossing the triangle at an angle keeps its sideways drift.
 *
 * ## Why there is no decay code
 *
 * `BOOST_TARGET_BALL_SPEED` is deliberately **below** belt speed, so the belt's own friction points *with* the
 * ball and pulls it back up toward belt speed; the boost therefore decays through the same solver that
 * produced the natural ~4.5 studs/s in the first place. Writing a decay curve here would be a second,
 * disagreeing model of a force the engine already computes.
 *
 * ## Why the cluster is capped rather than rate-limited
 *
 * `PLAYING_CAP_SECONDS` was deleted, so a round can run forever and a timed spawner would accumulate
 * triangles without bound — hundreds of parts on a 56-stud belt, and a ball hitting five at once. The cap is
 * `MAX_CONCURRENT_PICKUPS`; the 15 s tick only ever *replaces* what was taken.
 */
@Service()
export class PickupService implements OnStart {
	/** Live triangles, so the cap is counted rather than inferred from the folder. */
	private readonly live = new Array<BasePart>();

	/**
	 * Incremented to stop the top-up loop.
	 *
	 * A `task.spawn` loop cannot be cancelled, so it is written to exit on its own: the loop captures the
	 * generation it started in and returns the moment the current generation is different. Every phase change
	 * that should stop spawning bumps this, which is what guarantees no orphaned loop survives `PostGame`
	 * (item 26's rule, applied here).
	 */
	private generation = 0;

	public onStart(): void {
		// **The phase is read from `RoundState`, not injected from `RoundService`.**
		//
		// `RoundState` is the server's own broadcast of the phase (item 34), written on every transition and
		// readable on the server as well as the client. Subscribing to it here keeps the dependency pointing
		// one way: `RoundService` does not import this service, so there is no require cycle to reason about,
		// and a future change to the phase machine cannot forget to call a pickup hook because there is no
		// call to forget.
		//
		// The alternative — `RoundService` calling `pickups.clearPickups()` from `clearAllBodies` — was
		// rejected for that reason: it is one more line in the service that owns the phase machine, and it
		// would have to be added to every one of that service's four exit paths.
		const roundState = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (roundState === undefined || !roundState.IsA("StringValue")) {
			warn(
				`[Pickup] GAVE UP waiting for ${ROUND_STATE_VALUE_NAME} after ${ROUND_STATE_WAIT_SECONDS}s — the server did not create it. Pickups disabled.`,
			);
			return;
		}

		roundState.GetPropertyChangedSignal("Value").Connect(() => this.onPhaseChanged(roundState.Value));
		this.onPhaseChanged(roundState.Value);
	}

	/**
	 * Enters or leaves the spawning state.
	 *
	 * `Playing` is the only phase that spawns. Every other phase clears, and clearing on all of them rather than
	 * only on the two named in the brief is deliberate: the brief names `PostGame → Intermission` and
	 * `Playing → Waiting`, but `Playing → PostGame` and the debug restarts pass through the same door, and a
	 * triangle left behind in any of them is a triangle that outlives the round it belongs to.
	 */
	private onPhaseChanged(phase: string): void {
		if (phase === "Playing") {
			this.spawnCluster("Playing entry", PICKUP_COUNT);
			this.startTopUpLoop();
			return;
		}

		this.stopTopUpLoop();
		this.clearPickups();
	}

	/** Starts the 15 s top-up. Bumping the generation is what stops any previous loop. */
	private startTopUpLoop(): void {
		const generation = ++this.generation;

		task.spawn(() => {
			while (this.generation === generation) {
				task.wait(PICKUP_SPAWN_INTERVAL_SECONDS);
				// Re-checked after the wait: a round that ended during the interval must not get one more
				// cluster from a loop that was already sleeping.
				if (this.generation !== generation) {
					return;
				}

				this.spawnCluster("top-up", MAX_CONCURRENT_PICKUPS);
			}
		});
	}

	private stopTopUpLoop(): void {
		this.generation++;
	}

	/**
	 * Fills the empty slots of the cluster, up to `limit`.
	 *
	 * ## Slots, not a count
	 *
	 * The five `Z` positions are computed for `MAX_CONCURRENT_PICKUPS` slots regardless of how many are alive,
	 * and each spawn fills the lowest empty slot. A top-up therefore puts a replacement exactly where the
	 * taken triangle was, which is what makes the cluster look stable across a long round instead of drifting
	 * to one side as triangles are consumed in a random order.
	 */
	private spawnCluster(reason: string, limit: number): void {
		const belt = this.findBelt();
		if (belt === undefined) {
			return;
		}

		const folder = this.pickupsFolder();
		const slots = this.slotPositions(belt);

		let spawned = 0;
		for (let slot = 0; slot < slots.size(); slot++) {
			if (this.live.size() >= limit) {
				break;
			}

			if (this.slotOccupied(slots[slot])) {
				continue;
			}

			const pickup = this.createPickup(belt, folder, slots[slot], slot);
			if (pickup !== undefined) {
				spawned++;
			}
		}

		if (spawned === 0) {
			return;
		}

		const first = this.live[0];
		const firstPos = first === undefined ? "none" : tostring(first.Position);
		print(
			`[Pickup] cluster reason=${reason} spawned=${spawned} live=${this.live.size()} localX=${formatNumber(PICKUP_CLUSTER_LOCAL_X)} worldX=${formatNumber(belt.CFrame.mul(new CFrame(PICKUP_CLUSTER_LOCAL_X, 0, 0)).X)} firstPos=${firstPos} beltY=${formatNumber(belt.Position.Y)} beltSize=${tostring(belt.Size)}`,
		);
	}

	/**
	 * The world positions of every slot, left-to-right across the belt.
	 *
	 * Derived from the belt's `CFrame` and `Size`, never from world constants: the belt is user-placed, and a
	 * hardcoded `Z` would leave the cluster beside the belt the moment it is moved. `Y` is the **slab's** top
	 * face — `belt.Size.Y / 2 + BELT_SURFACE_THICKNESS` above the belt's centre — because the slab is the
	 * surface a ball actually rests on; placing on the belt's own top face would bury the triangle inside the
	 * slab and, worse, put it below the ball's contact point so `Touched` might never fire.
	 */
	private slotPositions(belt: BasePart): Array<Vector3> {
		const halfZ = belt.Size.Z / 2 - PICKUP_Z_EDGE_INSET;
		const surfaceY = belt.Size.Y / 2 + BELT_SURFACE_THICKNESS;
		const lift = surfaceY + PICKUP_SIZE.Y / 2;

		const positions = new Array<Vector3>();
		const slots = MAX_CONCURRENT_PICKUPS;
		for (let i = 0; i < slots; i++) {
			// `slots - 1` would be zero in a one-slot configuration, and dividing by it would produce NaN,
			// which places the triangle at the world origin. `math.max` floors the divisor instead of
			// special-casing the count.
			const t = i / math.max(slots - 1, 1);
			const localZ = -halfZ + t * (2 * halfZ);
			positions.push(belt.CFrame.mul(new CFrame(PICKUP_CLUSTER_LOCAL_X, lift, localZ)).Position);
		}

		return positions;
	}

	/** Whether a slot already holds a live triangle, so a top-up fills gaps rather than stacking. */
	private slotOccupied(position: Vector3): boolean {
		for (const pickup of this.live) {
			if (pickup.Parent === undefined) {
				continue;
			}

			if (pickup.Position.sub(position).Magnitude < PICKUP_SIZE.X / 2) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Builds one triangle.
	 *
	 * ## The shape, and why it is a `SpecialMesh`
	 *
	 * **`Enum.PartType.Triangle` does not exist.** The installed typings' `Enum.PartType` has `Ball`, `Block`,
	 * `Cylinder` and `Wedge` and no triangle member, so a `Part` cannot be told to be a triangle directly.
	 * `SpecialMesh` with `MeshType = Enum.MeshType.Prism` is the asset-free way to get one: it is a built-in
	 * mesh type (no `MeshId`, no upload), and a prism's triangular faces are its top and bottom, so a thin flat
	 * prism reads as a triangle from above — which is the view the player has of the belt.
	 *
	 * `Wedge` was the other candidate and is rejected on that last point: a wedge is triangular from the
	 * *side*, and from above it is a rectangle, so five of them would look like five red tiles rather than
	 * five arrows.
	 *
	 * `Anchored = true` because a pickup must not be pushed by the balls it boosts; `CanCollide = false`
	 * because it is a marker, not a barrier; `CanTouch = true` explicitly because that is the entire mechanism
	 * and a future default change should not silently disable pickups; `CanQuery = false` so it stays out of
	 * raycasts, matching the slab's reasoning.
	 */
	private createPickup(belt: BasePart, folder: Folder, position: Vector3, slot: number): BasePart | undefined {
		const pickup = new Instance("Part");
		pickup.Name = `Pickup${slot + 1}`;
		// **`Wedge`, not a `SpecialMesh` prism.** The first version used
		// `SpecialMesh(MeshType = Prism)` on a `Block`, sized `(1.5, 0.1, 1.5)` - and Studio reported five
		// pickups spawning and being collected with nothing visible on the belt. A 0.1-stud-thick mesh is a
		// sliver from the chase camera. `Wedge` is a real `PartType` (verified in the typings, unlike
		// `Triangle`) that always renders, and a wedge is triangular from the side, which is the silhouette a
		// "boost pad" wants anyway.
		pickup.Shape = Enum.PartType.Wedge;
		pickup.Size = PICKUP_SIZE;
		pickup.Anchored = true;
		pickup.CanCollide = false;
		pickup.CanTouch = true;
		pickup.CanQuery = false;
		pickup.Color = PICKUP_COLOR;
		pickup.Material = Enum.Material.Neon;
		pickup.TopSurface = Enum.SurfaceType.Smooth;
		pickup.BottomSurface = Enum.SurfaceType.Smooth;
		pickup.CFrame = new CFrame(position, position.add(belt.CFrame.RightVector));

		pickup.Parent = folder;
		CollectionService.AddTag(pickup, TAGS.pickup);

		// One connection per pickup, disconnected on collection. `Once` is not used because the handler must
		// also decide whether the body was a ball at all — a `Once` would burn the connection on the first
		// ball-shaped touch and leave the triangle uncollected if that touch was a marker or the slab.
		const connection = pickup.Touched.Connect((other) => this.onPickupTouched(pickup, other, connection));
		this.live.push(pickup);

		return pickup;
	}

	/**
	 * Boost the ball, consume the triangle.
	 *
	 * ## Why the connection is disconnected before the boost
	 *
	 * `Touched` fires on every contact *and* on the triangle's own partners, and a fast ball can generate two
	 * contacts in the same physics step (leading edge, then trailing edge as it passes through). Destroying the
	 * part stops further events, but the destroy is not instantaneous within the step, so a second invocation
	 * in the same step would boost the ball twice and print two lines for one pickup. Disconnecting first makes
	 * the handler idempotent regardless of how many contacts the step produced — which is why there is no
	 * cooldown constant: there is nothing left to cooldown.
	 *
	 * ## Why the along-belt component only
	 *
	 * The other two components are the ball's real motion across the belt and its fall. Projecting, raising one
	 * component, and re-adding is what makes the boost *directional*: adding a flat velocity would straighten
	 * a ball that was drifting sideways, and zeroing the others would stop a ball mid-air dead.
	 */
	private onPickupTouched(pickup: BasePart, other: BasePart, connection: RBXScriptConnection): void {
		connection.Disconnect();

		if (pickup.Parent === undefined) {
			return;
		}

		if (!CollectionService.HasTag(other, TAGS.ball)) {
			// Not a ball: re-arm, because a marker, the slab or a wall brushing the triangle must not consume
			// it. Reconnecting the same handler is cheaper than testing the tag before a `Once` connection can
			// be made, and it keeps the connection count at one per pickup.
			this.reconnect(pickup);
			return;
		}

		// **The boost writes the ball's model number, not its velocity.**
		//
		// Under the reference-speed model a ball's velocity is derived from `BALL_SPEED` every tick by
		// `BallSpawnerService.stepBallSpeeds`, so a velocity written here would be overwritten on the very next
		// frame and the pickup would look like it did nothing. Raising the attribute is the actual boost: above
		// `BELT_SPEED` it makes `RELATIVE_SPEED` positive, which is the direction that carries the ball back
		// toward the spawn end instead of toward elimination.
		const before = this.readBallSpeed(other);
		if (before < BOOST_TARGET_BALL_SPEED) {
			other.SetAttribute(BALL_SPEED_ATTRIBUTE, BOOST_TARGET_BALL_SPEED);
		}

		const after = this.readBallSpeed(other);

		// Removed before the destroy so the cap sees the slot free immediately, and so a destroy failing for
		// any reason does not leave a triangle counted as live forever.
		this.remove(pickup);
		pickup.Destroy();

		print(
			`[Pickup] collected by ${other.GetFullName()} BALL_SPEED ${formatNumber(before)} -> ${formatNumber(after)} live=${this.live.size()}`,
		);
	}

	/** Re-attaches the touch handler after a non-ball contact. */
	private reconnect(pickup: BasePart): void {
		if (pickup.Parent === undefined) {
			return;
		}

		const connection = pickup.Touched.Connect((other) => this.onPickupTouched(pickup, other, connection));
	}

	/** A ball's current model speed, or 0 for a ball that somehow has no attribute. */
	private readBallSpeed(ball: BasePart): number {
		const raw = ball.GetAttribute(BALL_SPEED_ATTRIBUTE);
		return typeIs(raw, "number") ? raw : 0;
	}

	private remove(pickup: BasePart): void {
		const index = this.live.indexOf(pickup);
		if (index >= 0) {
			this.live.remove(index);
		}
	}

	/** Destroys every live triangle, and anything tagged `pickup` that outlived the bookkeeping. */
	private clearPickups(): void {
		const tagged = CollectionService.GetTagged(TAGS.pickup);

		for (const pickup of this.live) {
			pickup.Destroy();
		}
		this.live.clear();

		for (const instance of tagged) {
			if (instance.Parent !== undefined) {
				instance.Destroy();
			}
		}

		// The folder is emptied rather than destroyed: a later round reuses it, and recreating it every round
		// would leave a stream of create/destroy pairs in the Explorer for a container that never changes.
		const folder = Workspace.FindFirstChild(PICKUPS_FOLDER_NAME);
		if (folder !== undefined) {
			for (const child of folder.GetChildren()) {
				child.Destroy();
			}
		}
	}

	private pickupsFolder(): Folder {
		const existing = Workspace.FindFirstChild(PICKUPS_FOLDER_NAME);
		if (existing !== undefined && existing.IsA("Folder")) {
			return existing;
		}

		const folder = new Instance("Folder");
		folder.Name = PICKUPS_FOLDER_NAME;
		folder.Parent = Workspace;
		return folder;
	}

	/**
	 * The belt the cluster is laid out on: the first tagged belt that is still in the world.
	 *
	 * First rather than nearest, because a cluster belongs to a belt and this service has no point to be near —
	 * unlike the spawner's `nearestBeltTo`, there is no ball to measure from. With more than one belt the scene
	 * would need a statement about which one the pickups belong to, and that statement does not exist yet;
	 * picking the first is honest about that rather than pretending to choose.
	 */
	private findBelt(): BasePart | undefined {
		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance;
			}
		}

		return undefined;
	}
}

// #endregion
