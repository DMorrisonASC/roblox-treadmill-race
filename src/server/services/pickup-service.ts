import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BALL_SPEED_ATTRIBUTE } from "shared/attributes";
import { PICKUP_SOUND_REMOTE_NAME, REMOTES_FOLDER_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import {
	BELT_SURFACE_THICKNESS,
	PICKUP_COLOR,
	PICKUP_SIZE,
	PICKUP_SPAWN_INTERVAL_SECONDS,
	PICKUP_X_MAX,
	PICKUP_X_MIN,
	PICKUPS_FOLDER_NAME,
} from "shared/tuning";
import { BallSpawnerService } from "./ball-spawner-service";
import { pickupDecision, powerOf, speedAfterPickup } from "server/powers";

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
 * the bound-spawner count; the 15 s tick only ever *replaces* what was taken.
 */
@Service()
export class PickupService implements OnStart {
	/**
	 * Injected for one thing: the bound spawner **parts**, so the lane list is the scene's rather than a
	 * constant's. `BallSpawnerService` does not import this file, so there is no cycle.
	 */
	constructor(private readonly spawner: BallSpawnerService) {}

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

	/**
	 * The broadcast a real boost fires, created in `onStart`.
	 *
	 * A field rather than a lookup in the handler, for the reason item 84 recorded for the hit effect: a `FindFirstChild`
	 * inside a `Touched` callback is a lookup paid at the worst rate in the game. `undefined` only in the window before
	 * `onStart` runs or after a failed remote creation, and the fire site treats that as "no sound" rather than an error.
	 */
	private pickupSoundRemote?: RemoteEvent;

	public onStart(): void {
		// **The remote is created here, by this service, rather than handed over by `RoundService`.**
		//
		// `RoundService` owns the `Remotes` folder and creates the hit-effect remote beside this one, so the first
		// instinct is a `setPickupSoundRemote` hand-over. That would have to inject this service into `RoundService`, and
		// this file's own docblock argues the opposite direction: the dependency points one way precisely so that "a future
		// change to the phase machine cannot forget to call a pickup hook because there is no call to forget". The
		// `EconomyService` precedent is the other half of the answer — it creates `OpenCoinChest` and `FuseBalls` in the
		// same shared folder for the same reason, and `ReplicatedStorage.Remotes` is docblocked there as "created by
		// whichever service starts first, so neither owns the folder".
		//
		// Created before the `RoundState` wait, and find-or-create rather than find, so it does not matter which service
		// starts first: this one creates the folder if it is early, and `RoundService` finds it if this one was.
		this.pickupSoundRemote = this.createPickupSoundRemote();

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
	 * Creates the pickup-sound broadcast in `ReplicatedStorage.Remotes` and returns it.
	 *
	 * Find-or-create on the folder, matching `RoundService.createHitEffectRemote` and `EconomyService`'s own creation:
	 * whichever server service starts first makes the folder and the rest find it, so no start order is load-bearing.
	 *
	 * The remote is created eagerly rather than on the first collection because the client connects its handler once at
	 * boot: a remote that appeared mid-round would be one the client had already given up waiting for.
	 */
	private createPickupSoundRemote(): RemoteEvent {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const remote = new Instance("RemoteEvent");
		remote.Name = PICKUP_SOUND_REMOTE_NAME;
		remote.Parent = folder;

		return remote;
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
			this.spawnPickups("Playing entry");
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

				this.spawnPickups("top-up");
			}
		});
	}

	private stopTopUpLoop(): void {
		this.generation++;
	}

	/**
	 * Places one pickup in each lane that does not already hold one, up to the bound-spawner count.
	 *
	 * ## The count is the scene's, not a constant
	 *
	 * **A fixed `3` was wrong because a scene does not scale to a number in code.** Four
	 * spawners were bound and three pickups were placed, so one lane could never hold anything; a fifth spawner
	 * added in Studio would have changed nothing at all. `maxPickups()` is the bound-spawner count, read at the
	 * moment of spawning, so adding a lane in Studio adds a pickup with no code change.
	 *
	 * ## Only the missing ones
	 *
	 * A top-up spawns `maxPickups() - live` pickups, not a fresh set: the untouched ones keep the position they
	 * were created at, which is what "a collected pickup is replaced" has to mean for the round to stay
	 * readable. Lanes that already hold a pickup are excluded, so the deficit always lands in an empty lane and
	 * two pickups can never share one at the same X.
	 */
	private spawnPickups(reason: string): void {
		const belt = this.findBelt();
		if (belt === undefined) {
			return;
		}

		const spawners = this.spawner.getBoundSpawners();
		if (spawners.size() === 0) {
			return;
		}

		const folder = this.pickupsFolder();
		const deficit = spawners.size() - this.live.size();
		if (deficit <= 0) {
			return;
		}

		// Lanes already occupied by a live pickup, by their **code-frame** belt-local `Z` (centred on the belt's centreline;
		// user-Z = this + 6). A pickup's lane is a *position*, so
		// "occupied" is a Z match rather than a slot index - there are no fixed slots any more.
		const lanesTaken = new Set<number>();
		for (const pickup of this.live) {
			if (pickup.Parent !== undefined) {
				lanesTaken.add(math.round(belt.CFrame.PointToObjectSpace(pickup.Position).Z * 100) / 100);
			}
		}

		const placed = new Array<BasePart>();
		for (const spawner of spawners) {
			if (placed.size() >= deficit) {
				break;
			}

			// **The lane's `Z` comes from the part, in the belt's own frame.** A spawner's `Z` is scene data, so
			// this is the only way a fifth spawner added in Studio produces a fifth lane with no code change; a
			// constant here would put every pickup on top of whichever lane the constant described.
			const localZ = belt.CFrame.PointToObjectSpace(spawner.Position).Z;
			if (lanesTaken.has(math.round(localZ * 100) / 100)) {
				continue;
			}

			const pickup = this.createPickup(belt, folder, this.positionFor(belt, localZ), placed.size());
			if (pickup !== undefined) {
				placed.push(pickup);
				lanesTaken.add(math.round(localZ * 100) / 100);
			}
		}

		if (placed.size() === 0) {
			return;
		}

		const summary = new Array<string>();
		for (const pickup of placed) {
			const localPoint = belt.CFrame.PointToObjectSpace(pickup.Position);
			summary.push(`${formatNumber(pickup.Position.X)},${formatNumber(localPoint.Z)}`);
		}

		print(
			`[Pickup] spawned reason=${reason} count=${placed.size()} live=${this.live.size()} positions=${summary.join("|")}`,
		);
	}

	/**
	 * A world position for a pickup: random along the belt, snapped to a lane across it.
	 *
	 * ## Why `X` is random and bounded
	 *
	 * **`PICKUP_X_MIN` bounds the far side at the ball's spawn.** Balls spawn at **code-frame** `X = -23` (user-X `5`) and
	 * drift toward `+X` — toward the back, i.e. toward elimination — so a pickup behind `-18` would be behind every ball for
	 * its whole life and could never be touched. The fixed `-15` cluster had exactly that problem in the other direction,
	 * sitting at one spot every round.
	 *
	 * **`PICKUP_X_MAX` bounds the near side so a pickup is reachable well before the exit.** A ball's drift accelerates as
	 * `BALL_SPEED` decays, and a pickup in the last few studs before **code-frame** `+28` (user-X `56`) would be collected
	 * after the ball had already committed to leaving.
	 *
	 * Both ends are inside the belt's own code-frame `X` range of `-28 .. +28` (user `0 .. 56`), so the triangle is always
	 * on the surface rather than floating past an end.
	 *
	 * `Y` is the **floor's** top face, not the belt's: the floor is what a ball rests on, so a pickup placed on
	 * the belt's face would sit inside the floor and below the ball's contact point, where `Touched` may never
	 * fire.
	 */
	private positionFor(belt: BasePart, localZ: number): Vector3 {
		const localX = PICKUP_X_MIN + math.random() * (PICKUP_X_MAX - PICKUP_X_MIN);
		const lift = belt.Size.Y / 2 + BELT_SURFACE_THICKNESS + PICKUP_SIZE.Y / 2;
		return belt.CFrame.mul(new CFrame(localX, lift, localZ)).Position;
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
		//
		// **The power decides the numbers, and `recycle` is the one power that leaves its pad in the world.** `sprinter`
		// takes a larger boost; every other ball takes the standard one, and every ball except `recycle` destroys the pad it
		// touched. `recycle` keeps it because the pad *is* the mechanic — "leave it for the next taker" — and the reason that
		// exception does not re-create the 71-second held-ball defect is `speedAfterPickup`: a ball parked on a surviving pad
		// is raised to the boost once, and every later touch computes the same value and writes nothing. Consuming is decided
		// *here* because only this handler owns the instance: a power that wanted the pickup destroyed could not do it
		// without reaching into a map it does not own.
		const decision = pickupDecision(powerOf(other));
		const before = this.readBallSpeed(other);

		// `speedAfterPickup` rather than an inline comparison: the rule is "the pickup raises, never lowers", and applying it
		// twice must equal applying it once. Named and pure, it can be asserted; inlined, it could only be read.
		const after = speedAfterPickup(before, decision.boost);
		if (after !== before) {
			other.SetAttribute(BALL_SPEED_ATTRIBUTE, after);

			// **The sound is fired inside the write's own condition, not beside the log line and not above the write.**
			//
			// `after !== before` is the "the ball actually got faster" test — `speedAfterPickup` is `math.max`, so the value
			// can change in one direction only. Firing here makes the sound and the speed change one decision instead of two
			// that are supposed to agree: a fire placed above the write, or beside the `[Pickup] collected` line with its own
			// `if`, would play on every `Touched` — including the no-op re-touch of a `recycle` pad under a resting ball,
			// which is exactly the machine gun this sound has no throttle to survive.
			//
			// One site, one condition. The `else` branch below reconnects rather than firing, so a surviving pad cannot
			// announce the same collection twice.
			this.pickupSoundRemote?.FireAllClients();
		}

		if (decision.consume) {
			// Removed before the destroy so the cap sees the slot free immediately, and so a destroy failing for
			// any reason does not leave a triangle counted as live forever.
			this.remove(pickup);
			pickup.Destroy();
		} else {
			// **This is the `recycle` branch, and it is live.** `pickupDecision` returns `consume: false` for `recycle` and
			// `true` for everything else, so a recycle ball re-arms its own pad instead of consuming it. The branch is the
			// code the decision contract asks for rather than a special case written here: the handler obeys `consume` rather
			// than assuming it, so a future power that wants to leave a pad behind needs no change in this file.
			//
			// No sound is fired here. The fire lives inside the `after !== before` guard above, which is where "the ball got
			// faster" is decided — a re-touch that changes nothing is silent, and a re-arm is not a collection at all.
			this.reconnect(pickup);
		}

		print(
			`[Pickup] collected by ${other.GetFullName()} power=${powerOf(other) === "" ? "none" : powerOf(other)} BALL_SPEED ${formatNumber(before)} -> ${formatNumber(after)} consumed=${decision.consume ? "yes" : "no"} live=${this.live.size()}`,
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
