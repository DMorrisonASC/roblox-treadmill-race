import { CollectionService, Debris, RunService, TweenService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { BOOSTED_ATTRIBUTE, POWER_ATTRIBUTE } from "shared/attributes";
import { TAGS } from "shared/tags";
import { BALL_PHANTOM_NAME, BALL_TRAIL_FOLDER_NAME } from "shared/tuning";
import {
	BALL_TRAIL_DEBUG_LOGGING,
	TRAIL_FADE_TRANSPARENCY_END,
	TRAIL_LIFETIME_SECONDS,
	TRAIL_SPAWN_INTERVAL_SECONDS,
} from "shared/config/ballTrail.config";

/**
 * A short trail of fading copies behind a **boosted `sprinter`** ball.
 *
 * ## The gate is two conditions (item 206)
 *
 * `Boosted` **and** `Power === "sprinter"`. Both are necessary and neither is sufficient:
 *
 * - `Boosted` says the ball is at or above the belt's reference speed. Every power reaches that state - a pickup gives it to
 *   all of them - so `Boosted` alone describes "fast", not "this ball".
 * - `Power` says *which* power the body is. `"sprinter"` is the one whose whole mechanic is a speed the field never catches.
 *
 * **The `Boosted`-only version of this file was a duplicate.** `windBoost` already draws a trail on every boosted body, so a
 * copy trail on the same state was a second effect saying the same thing on every fast ball, and nothing at all about the one
 * power it was meant to mark. Adding `Power` is what turns a general "fast ball" effect into a sprinter's.
 *
 * A body with **no** `Power` never trails, whatever its speed: a spawn that has not drawn a ball yet is not competing, and an
 * effect on it would mark a body that has no identity to mark.
 *
 * ## What this is not
 *
 * - **Not a second `windBoost`.** That effect is a pair of authored `ParticleEmitter`s cloned onto the body, drawn on every
 *   boosted ball of every power; this one is made of *copies of the ball itself* and is drawn on boosted sprinters only.
 * - **Not a second `tailWind`.** That trail marks a ball **losing** ground (`TailWind` is true only when `Boosted` is false),
 *   so the two can never draw on the same body.
 * - **Not a rig afterimage.** The reference implementation this is modelled on clones a character's parts from a recent
 *   position, hides the server's copies with `LocalTransparencyModifier = 1`, and lets the *server* tween per-layer
 *   transparency so every client sees the same thing. The ball has no character, no `Humanoid`, no dodge window, no
 *   `PlayerScripts` module and no per-player body, so none of that mechanism applies: there is one ball, every client draws
 *   it from the same replicated position, and a client-side trail is therefore identical on every screen without any
 *   server involvement at all.
 *
 * ## What this is
 *
 * One client-side controller. It watches `Ball`-tagged bodies, and while a body is both `Boosted` and a `sprinter` it clones
 * that body's **phantom** every `TRAIL_SPAWN_INTERVAL_SECONDS`, parents the copy into a local folder, tweens the copy's
 * transparency to `TRAIL_FADE_TRANSPARENCY_END` over `TRAIL_LIFETIME_SECONDS`, and destroys it when the tween completes.
 *
 * ## Why the clone source is the phantom and not the ball
 *
 * **The ball is invisible on purpose.** `BallRenderController` sets `LocalTransparencyModifier = 1` on the server's ball and
 * draws a second, rolled `Part` - the phantom - in its place; the ball's own six `Texture`s are hidden the same way, one
 * level down (item 99, which records that a `Texture` draws on a fully transparent part and therefore needs its own hide).
 * Cloning the ball would copy **both** of those client-side hides - `LocalTransparencyModifier` is a property and `Clone()`
 * copies properties - and the result would be an invisible copy that fades invisibly and then destroys itself, reading in
 * the Explorer as a working trail and on screen as nothing at all.
 *
 * The phantom is the visible thing: a `Part` with `Shape = Ball`, the body's `Size`, `Color`, `Material` and six cloned
 * `Texture`s. So `phantomFor(...)` finds it by `BALL_PHANTOM_NAME` and the clone *is* the ball's appearance, including the
 * textures and including the roll the phantom has accumulated. **No `vfx-scale` call is made**: the phantom is already the
 * body's size, so any multiplier other than `1` would draw a trail that is a different size than the ball it trails.
 *
 * ## Why the copies outlive their ball
 *
 * They are parented to a `Workspace` folder, not to the body. `windBoost` parents to the ball so `Destroy()` sweeps the
 * effect with it - correct for an effect that *is* the body's decoration, wrong for a trail: a ball eliminated mid-boost
 * would take its own trail with it in one frame, which reads as the effect switching off rather than as a ball leaving. A
 * copy is a snapshot of a moment; it has no further relationship with the body, so it fades on its own schedule.
 *
 * ## What a boosted sprinter carries, and why that is intended
 *
 * Three effects, two of which are sprinter-only:
 *
 * | effect | drawn on | gate |
 * | --- | --- | --- |
 * | `windBoost` | every boosted ball of any power | `Boosted` |
 * | this copy trail | a boosted sprinter | `Boosted` + `Power` |
 * | `SprinterAfterimageController` | a boosted sprinter | `SprinterAfterimage`, written only for `sprinter` + `Boosted` |
 *
 * That is the designer's answer for this round: the sprinter is the fast ball, so it wears the fast-ball effect *and* two
 * sprinter-specific ones, while a boosted `bully` wears only `windBoost`.
 *
 * **The two sprinter effects are deliberately separate, and the third row is worth stating precisely** because the round that
 * gated this one assumed otherwise: the single-copy afterimage is **already** sprinter-only, and on the *server* side - the
 * spawner writes `SprinterAfterimage` from `power === "sprinter" && boosted === true`, so that controller never sees a
 * boolean it has to re-derive. What is left for the designer is whether two sprinter trails at once is the look they want;
 * removing either is a one-line gate on the other's controller, not a rebuild.
 */
@Controller()
export class BallTrailController implements OnStart {
	/** One record per tagged body. Not a list of clones: those live in the folder and destroy themselves. */
	private readonly trails = new Map<BasePart, TrailState>();

	/** Per-ball connections, disconnected on `Destroying` so a dead body takes no listener with it. */
	private readonly ballConnections = new Map<BasePart, Array<RBXScriptConnection>>();

	/** The service-level connections - the tag listeners and the render loop. */
	private readonly connections = new Array<RBXScriptConnection>();

	/** The folder every copy is parented into, created on first use. */
	private trailFolder?: Folder;

	/** Copies spawned this session, for the boot line's sanity check. */
	private spawnedCopies = 0;

	public onStart(): void {
		// Both discovery paths, the pattern every tag-driven controller here uses: the startup scan is the only thing that
		// draws a client joining mid-`Playing` with bodies already boosted, and the signal catches everything after that.
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
		this.connections.push(RunService.RenderStepped.Connect(() => this.step()));

		// One line, from the constants, so a reader can tell "not mounted" from "mounted and never fired". `cloneSource` is on
		// it because the whole effect is only correct when the copy is the phantom, and **`gate=` because the effect's scope is
		// not visible from any other field**: a reader who assumes "boosted ball" from `interval` and `lifetime` will expect a
		// trail on every fast body, which is exactly the behaviour item 206 removed.
		print(
			`[BallTrail] mounted interval=${TRAIL_SPAWN_INTERVAL_SECONDS}s lifetime=${TRAIL_LIFETIME_SECONDS}s fade=0->${TRAIL_FADE_TRANSPARENCY_END} cloneSource=phantom(${BALL_PHANTOM_NAME}) scale=1 (phantom size) attribute="${BOOSTED_ATTRIBUTE}" gate=Boosted+Power(${SPRINTER_POWER}) bodies=${this.trails.size()} emitting=${this.emittingCount()}`,
		);
	}

	/**
	 * Starts watching one body's `Boosted` flag and its `Power`.
	 *
	 * **Read once and then subscribed, not read per frame.** `Boosted` only changes on a boost or on the decay crossing
	 * `BELT_SPEED - BOOST_HYSTERESIS`, and `Power` only on a spawn or a `Waiting` re-pick; polling either every frame would be
	 * sixty reads a second per body to learn that nothing happened.
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

		const boostSignal = ball.GetAttributeChangedSignal(BOOSTED_ATTRIBUTE);
		connections.push(
			boostSignal.Connect(() => {
				const state = this.trails.get(ball);
				// **Every read is printed, and the value is the raw attribute (item 207).** `nil` is a fourth answer and a
				// different bug from `false`: it means nothing ever set this key on this body, so a reader that reported
				// `false` would be claiming "the server said no" when the truth is "the server never spoke". Unthrottled on
				// purpose - a controller that never prints this line has proved it never saw a write, which is the one thing
				// the mount line cannot show.
				print(
					`[BallTrail] read body=${ball.GetFullName()} value=${describeAttribute(ball.GetAttribute(BOOSTED_ATTRIBUTE))} power=${describeAttribute(ball.GetAttribute(POWER_ATTRIBUTE))}`,
				);
				if (state !== undefined) {
					state.boosted = ball.GetAttribute(BOOSTED_ATTRIBUTE) === true;
				}
			}),
		);

		// **The half of the gate that names a power (item 206).** `Boosted` is a fact about speed and every power reaches it,
		// so on its own it made this a second `windBoost`. `Power` is the fact that names *which* power, and it is subscribed
		// rather than polled for the same reason as `Boosted`: `presentPower` writes it once at spawn and again only if the
		// player re-picks during `Waiting`, so a per-frame read would be sixty reads a second to learn nothing.
		connections.push(
			ball.GetAttributeChangedSignal(POWER_ATTRIBUTE).Connect(() => {
				const state = this.trails.get(ball);
				if (state !== undefined) {
					state.power = powerOf(ball);
				}
			}),
		);

		// **The body dying stops emission and nothing else.** The copies already in the world are in the folder and fade on
		// their own schedule; this only disconnects the listeners and drops the record.
		connections.push(
			ball.Destroying.Connect(() => {
				this.forget(ball);
			}),
		);

		// **The initial read, printed for the same reason the change-signal read is (item 207).** A client that joins while a
		// body is already boosted never sees a change, so without this line the only evidence would be the absence of a line.
		this.trails.set(ball, {
			boosted: ball.GetAttribute(BOOSTED_ATTRIBUTE) === true,
			power: powerOf(ball),
			// **Spawn immediately on the first boosted frame.** Without this a ball that is already boosted when this client
			// first sees it would wait up to one interval before its first copy, which on a client joining mid-round is the
			// difference between a trail and an unexplained delay.
			nextSpawnAt: 0,
		});
	}

	/** Drops one body's listeners and record. Called from `Destroying` only. */
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

	/**
	 * The whole system's per-frame work: for each **boosting sprinter**, leave a copy if its interval has elapsed.
	 *
	 * One loop and one connection for every body, the same shape `windBoost` and `tailWind` use - a per-body loop would be
	 * one listener per body for work that is a subtraction and a comparison.
	 */
	private step(): void {
		const now = os.clock();

		for (const [ball, state] of this.trails) {
			if (ball.Parent === undefined) {
				this.forget(ball);
				continue;
			}

			// **Two conditions, and the second is what names the effect (item 206).** `Boosted` alone is true for every power
			// that has taken a pickup, so gating on it made this a duplicate of `windBoost` on a body that already has one.
			// `power === SPRINTER_POWER` is the whole difference between "the ball is fast" and "this is the sprinter".
			if (!state.boosted || state.power !== SPRINTER_POWER) {
				// **Armed but not firing.** Resetting the deadline to `0` rather than to `now` means the first frame the gate
				// opens spawns at once; leaving a stale future deadline here would delay the trail's first copy by up to one
				// interval every time a body becomes eligible.
				state.nextSpawnAt = 0;
				continue;
			}

			if (now < state.nextSpawnAt) {
				continue;
			}

			state.nextSpawnAt = now + TRAIL_SPAWN_INTERVAL_SECONDS;
			this.spawn(ball);
		}
	}

	/**
	 * Leaves one fading copy of `ball`'s phantom behind.
	 *
	 * The copy takes the phantom's `CFrame` **as it is at this instant** - position from the body, roll accumulated by
	 * `BallRenderController` - which is the reference effect's own rule (a copy preserves the source's orientation at the
	 * moment it is made). Re-orienting the copy with an asset rotation would draw a row of identically-facing spheres behind a
	 * rolling ball, which reads as a duplicate rather than as a trail as soon as the camera is close enough to see the skin.
	 */
	private spawn(ball: BasePart): void {
		const phantom = this.phantomFor(ball);
		if (phantom === undefined) {
			// No phantom yet: this client has not built one for this body (it builds them on its own tag scan, and a body can
			// arrive before that has run). Skipping is the honest answer - the next interval tries again - and it is why the
			// trail cannot manufacture its own copy from the ball.
			return;
		}

		const copy = phantom.Clone();
		copy.Name = `${BALL_TRAIL_FOLDER_NAME}_${ball.Name}`;
		// Positionally a snapshot: the phantom's own frame already carries the body's position and its accumulated roll.
		copy.CFrame = phantom.CFrame;
		makeInert(copy);

		const folder = this.folder();
		copy.Parent = folder;

		// **Two tween targets, and the second is the one that matters (item 99).** A `Texture` draws on a fully transparent
		// part, so tweening the copy's own `Transparency` alone would fade the sphere and leave six faces of skin floating in
		// the world after the part was gone. The copy's six `Texture` children are clones of the phantom's, so they carry the
		// phantom's current transparency - which is *not* always `0`: a ghost's skin is at half, and its trail must start from
		// there rather than jumping to opaque.
		const startTransparency = copy.Transparency;
		// Captured here rather than in the closure, so the despawn line's `age=` is the copy's real age and not the age of
		// whatever `os.clock()` returns when the tween ends.
		const spawnedAt = os.clock();
		const info = new TweenInfo(TRAIL_LIFETIME_SECONDS, Enum.EasingStyle.Linear);
		const tween = TweenService.Create(copy, info, { Transparency: TRAIL_FADE_TRANSPARENCY_END });
		const textureTweens = new Array<Tween>();

		for (const child of copy.GetChildren()) {
			if (child.IsA("Texture")) {
				textureTweens.push(TweenService.Create(child, info, { Transparency: TRAIL_FADE_TRANSPARENCY_END }));
			}
		}

		// **Destroy on completion, with `Debris` as the backstop.** A tween that never completes - the client losing focus, a
		// teleport, the effect being cancelled - would otherwise leave a part in the folder for the session.
		tween.Completed.Connect(() => {
			// **The despawn, with the copy's age (item 207).** `age` is how long the copy existed; anything around
			// `TRAIL_LIFETIME_SECONDS` is a copy that drew its whole fade, and `0s` is a copy culled before it ever drew - which is
			// the signature of a tween that was cancelled rather than completed.
			print(
				`[BallTrail] despawn clone=${copy.GetFullName()} age=${tostring(math.round((os.clock() - spawnedAt) * 100) / 100)}s`,
			);
			copy.Destroy();
		});
		tween.Play();
		for (const textureTween of textureTweens) {
			textureTween.Play();
		}

		Debris.AddItem(copy, TRAIL_LIFETIME_SECONDS + 0.1);
		this.spawnedCopies++;

		// **The clone, and the destroy, unconditionally (item 207).** The previous round put these behind
		// `BALL_TRAIL_DEBUG_LOGGING`, which is off - so a trail that mounted and then did nothing was indistinguishable from one
		// that was never eligible. `size` distinguishes a copy of the phantom (the body's size, `20,20,20` today) from a copy
		// of the wrong thing; `age` on the destroy line is `0s` for a copy that was culled before it drew a frame.
		print(
			`[BallTrail] spawn body=${ball.GetFullName()} clone=${copy.GetFullName()} size=${formatVector(copy.Size)}`,
		);

		if (BALL_TRAIL_DEBUG_LOGGING) {
			print(
				`[BallTrail] spawn body=${ball.GetFullName()} clone=${copy.GetFullName()} from=${tostring(math.round(startTransparency * 100) / 100)} textures=${textureTweens.size()} at=${tostring(now())}`,
			);
		}
	}

	/**
	 * The body's phantom, or `undefined` if this client has not built one yet.
	 *
	 * Found by name as a child of the body rather than through a Flamework dependency on `BallRenderController`: one
	 * `FindFirstChild` is cheaper than a controller-to-controller edge, and `marker-spin-controller` already reads the phantom
	 * this way for the same reason.
	 */
	private phantomFor(ball: BasePart): BasePart | undefined {
		const found = ball.FindFirstChild(BALL_PHANTOM_NAME);
		if (found === undefined || !found.IsA("BasePart")) {
			return undefined;
		}

		return found;
	}

	/** The folder copies are parented into, created on demand and recreated if something removed it. */
	private folder(): Folder {
		const cached = this.trailFolder;
		if (cached !== undefined && cached.Parent !== undefined) {
			return cached;
		}

		const existing = Workspace.FindFirstChild(BALL_TRAIL_FOLDER_NAME);
		if (existing !== undefined && existing.IsA("Folder")) {
			this.trailFolder = existing;
			return existing;
		}

		const created = new Instance("Folder");
		created.Name = BALL_TRAIL_FOLDER_NAME;
		created.Parent = Workspace;
		this.trailFolder = created;

		return created;
	}

	/**
	 * How many watched bodies pass the full gate right now, for the boot line.
	 *
	 * **Both conditions, not just `Boosted`.** A count of boosted bodies would read as "the trail is about to fire" on a round
	 * where every body is boosted and none of them is a sprinter, which is precisely the state this round removed.
	 */
	private emittingCount(): number {
		let count = 0;
		for (const [, state] of this.trails) {
			if (state.boosted && state.power === SPRINTER_POWER) {
				count++;
			}
		}

		return count;
	}
}

/** One body's trail bookkeeping. The clones themselves are in the folder and destroy themselves. */
interface TrailState {
	/** The body's `Boosted` flag, cached from its change signal. */
	boosted: boolean;
	/**
	 * The body's `Power` attribute, cached from its change signal - `undefined` for a body that has none.
	 *
	 * **A third state, not a boolean.** `undefined` is a body with no power at all (a `3`-press spawn before its draw), and it
	 * must not be folded into "some other power": both mean no trail, but only one of them means the body is not competing yet,
	 * and a future reader looking for "why is this ball not trailing" needs to see which it is.
	 */
	power: string | undefined;
	/** `os.clock()` of the next copy. `0` means "on the next frame". */
	nextSpawnAt: number;
}

/**
 * The only `Power` value this effect exists for.
 *
 * A literal rather than an import of `PowerId`: the power identifiers are strings in `powers.config.ts` with no exported
 * member for this one, and a client controller depending on the server's power *table* for a single word would be the wrong
 * direction. Named once here so the gate and the boot line cannot disagree about what it is.
 */
const SPRINTER_POWER = "sprinter";

/**
 * A body's `Power` attribute as a string, or `undefined` when it has none.
 *
 * The narrowing is explicit because `GetAttribute` returns `AttributeValue`: a body with no power has no entry at all, and
 * reading it as `""` would make "no power" and some future empty-named power indistinguishable.
 */
function powerOf(ball: BasePart): string | undefined {
	const raw = ball.GetAttribute(POWER_ATTRIBUTE);

	return typeIs(raw, "string") ? raw : undefined;
}

/**
 * The seven properties that make a copy a picture rather than a body.
 *
 * The same list `hit-effect-controller`'s `makeInert` applies, **minus `Transparency = 1`**: that function is for an authored
 * effect part whose appearance comes from emitters, while this copy's appearance *is* its transparency, so forcing it to `1`
 * here would make every trail invisible.
 */
function makeInert(part: BasePart): void {
	part.Anchored = true;
	part.CanCollide = false;
	part.CanTouch = false;
	part.CanQuery = false;
	part.CastShadow = false;
}

/** `os.clock()` rounded for a log field. Named rather than inlined so the debug line stays readable. */
function now(): number {
	return math.round(os.clock() * 100) / 100;
}

/**
 * An attribute value as a log field: `true`, `false`, or **`nil` when the key has never been set** (item 207).
 *
 * The distinction is the whole reason this is not `tostring(value === true)`: a body whose key was never written and a body
 * whose key was written `false` look identical after a boolean coercion, and only one of them means the server is not talking
 * to this effect.
 */
function describeAttribute(value: AttributeValue | undefined): string {
	if (value === undefined) {
		return "nil";
	}

	if (typeIs(value, "boolean")) {
		return tostring(value);
	}

	return `${tostring(value)} (not a boolean)`;
}

/** A `Vector3` as `x,y,z`, for a copy's size field. */
function formatVector(value: Vector3): string {
	return `${tostring(math.round(value.X * 100) / 100)},${tostring(math.round(value.Y * 100) / 100)},${tostring(math.round(value.Z * 100) / 100)}`;
}
