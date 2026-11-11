import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { BALL_SPEED_ATTRIBUTE } from "shared/attributes";
import { PICKUP_SOUND_REMOTE_NAME, REMOTES_FOLDER_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import {
	BELT_SURFACE_THICKNESS,
	PICKUP_MAX_COUNT,
	PICKUP_PLACEMENT_ATTEMPTS,
	PICKUP_SIZE,
	PICKUP_SPAWN_INTERVAL_SECONDS,
	PICKUPS_FOLDER_NAME,
} from "shared/tuning";
import { beltLocalToWorld, padFootprint, pickupBounds, PickupFootprint, rectsOverlap } from "shared/pickup-placement";
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
 * Puts consumable boost pads on the belt and raises a ball's speed when one is touched.
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
 * alone, so a ball crossing the pad at an angle keeps its sideways drift.
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
 * pads without bound — hundreds of parts on a 336-stud belt, and a ball hitting five at once. The cap is
 * `PICKUP_MAX_COUNT`, and the 15 s tick only ever *replaces* what was taken. The cap is **not** the spawner count
 * any more (item 191): a pad is not a body, so how many pads the belt holds has nothing to do with how many balls
 * may be on it.
 */
@Service()
export class PickupService implements OnStart {
	/** Live pads, so the cap is counted rather than inferred from the folder. */
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
	 * pad left behind in any of them is a pad that outlives the round it belongs to.
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
	 * Tops the belt up to `PICKUP_MAX_COUNT` pads, each wholly on the belt and overlapping no other.
	 *
	 * ## Placement is a *rule*, not a check (item 191)
	 *
	 * This used to place one pad per lane: the count was the bound-spawner count and the `Z` was the spawner's own, so two
	 * pads could never overlap because there was at most one per lane. Now the position is free in both axes, which means
	 * "no overlap" has to be produced rather than observed. The shape is **bounded rejection sampling**: draw a candidate
	 * footprint inside `pickupBounds`, reject it if it overlaps anything already placed, and give each pad at most
	 * `PICKUP_PLACEMENT_ATTEMPTS` draws.
	 *
	 * Rejection rather than a grid or a sweep, because the band is sparse: a 20-stud pad on a 336 x 173 belt has 128
	 * packable grid cells and a round wants 12, so almost every draw lands free. A grid would be a second, invisible layout
	 * rule that a designer would have to discover from the positions.
	 *
	 * ## A pad that cannot be placed is *reported*, never dropped
	 *
	 * Hitting the attempt bound means the scene is wrong — a pad wider than the belt, a belt shrunk in Studio, a count past
	 * what the surface holds — so the shortfall is warned about with both numbers. There is no unbounded retry: the draws per
	 * pad are bounded, and the next attempt is the 15 s top-up tick, which is where a genuinely crowded belt gets its (also
	 * bounded) second chance rather than a loop spinning on the same full surface.
	 *
	 * ## Only the missing ones, and the existing pads are obstacles
	 *
	 * A top-up spawns `PICKUP_MAX_COUNT - live` pads, not a fresh set: the untouched ones keep the position they were created
	 * at, which is what "a collected pickup is replaced" has to mean for the round to stay readable. Every live pad is seeded
	 * into the taken list first, so a replacement lands clear of the pads that stayed rather than on top of one of them.
	 */
	private spawnPickups(reason: string): void {
		const belt = this.findBelt();
		if (belt === undefined) {
			return;
		}

		// Pads destroyed outside this service (a manual `Destroy`, a Studio edit mid-round) are dropped before the cap is
		// counted, so a phantom entry cannot shrink the field the same way the old lane bookkeeping could.
		this.pruneDestroyed();

		const deficit = PICKUP_MAX_COUNT - this.live.size();
		if (deficit <= 0) {
			return;
		}

		const folder = this.pickupsFolder();
		const bounds = pickupBounds(belt.Size, PICKUP_SIZE);

		// The live pads, as obstacles, in the **belt's own frame** — the same frame their positions were built in, so a
		// rotated belt needs no special case here.
		const taken = new Array<PickupFootprint>();
		for (const pickup of this.live) {
			const localPoint = belt.CFrame.PointToObjectSpace(pickup.Position);
			taken.push(padFootprint(localPoint.X, localPoint.Z, pickup.Size));
		}

		const placed = new Array<BasePart>();
		for (let index = 0; index < deficit; index++) {
			let chosen: PickupFootprint | undefined;

			for (let attempt = 0; attempt < PICKUP_PLACEMENT_ATTEMPTS; attempt++) {
				const candidate = padFootprint(
					bounds.minX + math.random() * (bounds.maxX - bounds.minX),
					bounds.minZ + math.random() * (bounds.maxZ - bounds.minZ),
					PICKUP_SIZE,
				);

				let blocked = false;
				for (const other of taken) {
					if (rectsOverlap(candidate, other)) {
						blocked = true;
						break;
					}
				}

				if (!blocked) {
					chosen = candidate;
					break;
				}
			}

			if (chosen === undefined) {
				continue;
			}

			taken.push(chosen);
			const pickup = this.createPickup(belt, folder, this.positionFor(belt, chosen.x, chosen.z), placed.size());
			if (pickup !== undefined) {
				placed.push(pickup);
			}
		}

		if (placed.size() > 0) {
			const summary = new Array<string>();
			for (const pickup of placed) {
				const localPoint = belt.CFrame.PointToObjectSpace(pickup.Position);
				summary.push(`${formatNumber(localPoint.X)},${formatNumber(localPoint.Z)}`);
			}

			// The bounds are printed with the count because they are the rule, not the result: a pad that appears in the wrong
			// place and a pad that appears inside a nonsensical bound look identical in the Explorer, and only the second says
			// the scene is the problem.
			print(
				`[Pickup] spawned reason=${reason} placed=${placed.size()} requested=${deficit} live=${this.live.size()} count=${PICKUP_MAX_COUNT} bounds=x[${formatNumber(bounds.minX)},${formatNumber(bounds.maxX)}] z[${formatNumber(bounds.minZ)},${formatNumber(bounds.maxZ)}] positions=${summary.join("|")}`,
			);
		}

		if (placed.size() < deficit) {
			// A warning rather than a print: this is the scene refusing to hold what was asked for, and it is the only signal
			// that a pad is missing. Named numbers, because "some pads did not fit" is not actionable and "3 of 12" is.
			warn(
				`[Pickup] placement shortfall reason=${reason} placed=${placed.size()} requested=${deficit} unplaced=${deficit - placed.size()} attemptsPerPad=${PICKUP_PLACEMENT_ATTEMPTS} bounds=x[${formatNumber(bounds.minX)},${formatNumber(bounds.maxX)}] z[${formatNumber(bounds.minZ)},${formatNumber(bounds.maxZ)}] pad=${formatNumber(PICKUP_SIZE.X)}x${formatNumber(PICKUP_SIZE.Z)} — could not place the rest clear of the pads already on the belt; retried at the next ${PICKUP_SPAWN_INTERVAL_SECONDS}s top-up`,
			);
		}
	}

	/**
	 * A world position for a pad whose centre is a given belt-local `(localX, localZ)`.
	 *
	 * ## What replaced the random band and the lane
	 *
	 * The `X` band was two absolute numbers (`PICKUP_X_MIN = -18`, `PICKUP_X_MAX = 23`) picked against one belt by eye, and
	 * the `Z` was a bound spawner's own `Z` — so a pad was confined to a lane, could never exceed the spawner count, and could
	 * not account for its own width at either end of the belt. Both are gone (item 191). `X` and `Z` are now drawn inside
	 * `pickupBounds(belt.Size, PICKUP_SIZE)`, which is the belt's half-extents minus the pad's on both axes — the region in
	 * which the pad's **entire collider** is on the belt rather than merely its centre.
	 *
	 * ## A pickup's lane and a ball's lane are now unrelated, deliberately
	 *
	 * Nothing here reads a spawner. A ball's lane is where bodies appear and is still governed by the spawner parts; a pad's
	 * position is a point on the surface a ball may or may not cross. They were the same number because a pad used to be
	 * placed by copying a lane, and that coupling produced two artefacts nobody asked for: pads capped at the spawner count,
	 * and every pad on a lane line.
	 *
	 * ## Why `Y` is unchanged, and why it is the floor's face
	 *
	 * `Y` is the **floor's** top face, not the belt's: the floor is what a ball rests on, so a pickup placed on the belt's
	 * face would sit inside the floor and below the ball's contact point, where `Touched` may never fire. The lift is the belt's
	 * own half-height plus the floor's thickness plus the pad's half-height, and it is unrelated to the horizontal bounds —
	 * which is why `pickupBounds` has no `Y` and should not gain one.
	 */
	private positionFor(belt: BasePart, localX: number, localZ: number): Vector3 {
		const lift = belt.Size.Y / 2 + BELT_SURFACE_THICKNESS + PICKUP_SIZE.Y / 2;
		return beltLocalToWorld(belt.CFrame, localX, lift, localZ);
	}

	/**
	 * Builds one pickup: **an invisible collider, not a shape.**
	 *
	 * ## What changed, and why the wedge's reasoning no longer holds (item 144)
	 *
	 * This used to be a red `Wedge` — and the comment here argued for it at length, against a `SpecialMesh` prism that had
	 * proved invisible in Studio. Both halves of that essay were right *for a pickup that had to be its own visual*. It does
	 * not any more: the visible half is a billboard the client builds (`PickupSpriteController`), so the body's only job is to
	 * be a `Touched` volume, and a shape that is a shape for the sake of being seen is now a shape that is *only* seen when
	 * something goes wrong.
	 *
	 * The three conclusions that survive: `Anchored` because a pickup must not be pushed by the balls it boosts; `CanTouch`
	 * explicitly `true` because it is the entire mechanism; `CanQuery = false` so it stays out of raycasts. `CanCollide` was
	 * already `false` and stays `false` — the brief for this round says the wedge was collidable, and that is wrong: a
	 * collidable pad would be a wall across a lane.
	 *
	 * ## Why the size is unchanged, and the one asymmetry it introduces
	 *
	 * `PICKUP_SIZE` is the wedge's bounding box, and a `Block` of the same `Size` occupies that box completely — so the
	 * collection volume *grows* by the half of the box the wedge's slope left empty. That is the safe direction: a pad that
	 * fires slightly early is forgiving of a ball clipping its corner, while one that fires late drops a boost the player
	 * drove at. `positionFor` still lifts the pad by `PICKUP_SIZE.Y / 2`, so its centre is where it always was.
	 *
	 * `Transparency = 1` rather than a hidden mesh: the part is real, `Touched` works, and nothing draws. No `Color` or
	 * `Material` is set at all — a colour on an invisible part is a value with no reader, and this tree removes those.
	 */
	private createPickup(belt: BasePart, folder: Folder, position: Vector3, slot: number): BasePart | undefined {
		const pickup = new Instance("Part");
		pickup.Name = `Pickup${slot + 1}`;
		// A `Block` is the default shape; it is left implicit rather than set, because the only reason to write the
		// property is to *change* it and this part is deliberately the plainest collider there is.
		pickup.Size = PICKUP_SIZE;
		pickup.Transparency = 1;
		pickup.Anchored = true;
		pickup.CanCollide = false;
		pickup.CanTouch = true;
		pickup.CanQuery = false;
		pickup.TopSurface = Enum.SurfaceType.Smooth;
		pickup.BottomSurface = Enum.SurfaceType.Smooth;
		// The orientation is kept from the wedge: it no longer changes what is drawn, but it keeps the pad's own axes aligned
		// with the belt's, which is what a future directional marker or a debug arrow would want to read.
		pickup.CFrame = new CFrame(position, position.add(belt.CFrame.RightVector));

		pickup.Parent = folder;
		CollectionService.AddTag(pickup, TAGS.pickup);

		// One connection per pickup, disconnected on collection. `Once` is not used because the handler must
		// also decide whether the body was a ball at all — a `Once` would burn the connection on the first
		// ball-shaped touch and leave the pad uncollected if that touch was a marker or the slab.
		const connection = pickup.Touched.Connect((other) => this.onPickupTouched(pickup, other, connection));
		this.live.push(pickup);

		return pickup;
	}

	/**
	 * Boost the ball, consume the pad.
	 *
	 * ## Why the connection is disconnected before the boost
	 *
	 * `Touched` fires on every contact *and* on the pad's own partners, and a fast ball can generate two
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
			// Not a ball: re-arm, because a marker, the slab or a wall brushing the pad must not consume
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
			// any reason does not leave a pad counted as live forever.
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

	/**
	 * Drops pads that no longer exist from the live list.
	 *
	 * Walked backwards so each `remove` cannot shift an entry the loop has yet to look at. The list is the cap's own
	 * bookkeeping, so an entry left behind by a `Destroy` this service did not perform would permanently cost one of the
	 * `PICKUP_MAX_COUNT` slots — a pad that is never replaced and never explained.
	 */
	private pruneDestroyed(): void {
		for (let index = this.live.size() - 1; index >= 0; index--) {
			if (this.live[index].Parent === undefined) {
				this.live.remove(index);
			}
		}
	}

	/** Destroys every live pad, and anything tagged `pickup` that outlived the bookkeeping. */
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
	 * The belt the pads are laid out on: the first tagged belt that is still in the world.
	 *
	 * First rather than nearest, because the pads belong to a belt and this service has no point to be near —
	 * unlike the spawner's `nearestBeltTo`, there is no ball to measure from. With more than one belt the scene
	 * would need a statement about which one the pads belong to, and that statement does not exist yet;
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
