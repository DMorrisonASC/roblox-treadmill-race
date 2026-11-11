/**
 * The ten powers, as a module — **not a `@Service()`**.
 *
 * ## Why not a service
 *
 * Its only state is per-ball: a timer per ball while `Playing`, a cooldown per colliding ball, a connection per colliding
 * ball. None of that is singleton state a container has to own, and a Flamework service cannot be constructed in the Jest
 * runtime — it is instantiated by `Flamework.ignite()` against a DataModel, and a spec has neither. Ten powers would then
 * be ten rules nobody could assert, which is the situation `round-outcome.ts` was extracted to escape. So: pure decision
 * functions over plain tables (`powerTickDelta`, `transferAmounts`, `pickupDecision`), and a thin imperative wrapper that
 * touches instances.
 *
 * ## The one-writer rule this module obeys
 *
 * `BallSpawnerService.stepBallSpeeds` rewrites a ball's velocity from `BALL_SPEED` every tick, so it has to remain the only
 * writer of `BALL_SPEED` **inside** a tick. This module therefore returns a **delta** from `tickDelta` and lets that loop do
 * the arithmetic, the clamp and the single `SetAttribute`. Collision powers write `BALL_SPEED` directly between ticks.
 * The contact pop is a separate, Y-only velocity write: `stepBallSpeeds` replaces X and sets Z but preserves Y. The contact
 * shove is not a velocity at all — it is an impulse left in `lateral-shove.ts` for that loop to apply and decay.
 *
 * ## What is deliberately absent
 *
 * No VFX **built here**: no aura, no tint, no trail, no tween. The hit effect added in item 84 is fired from this module
 * as a position on a remote and built by each client, so the badge is still the only thing this module puts in the world
 * that is not a body. No player→ball mapping — the badge names the power, not the owner. No periodic `ghost` toggle; the
 * intended nerf is recorded here and not built.
 */
import { PhysicsService } from "@rbxts/services";
import { BALL_SPEED_ATTRIBUTE, OWNER_USER_ID_ATTRIBUTE, POWER_ATTRIBUTE } from "shared/attributes";
import {
	BULLY_KEEP_SHARE,
	BULLY_STEAL_SHARE,
	ECLIPSE_DECAY_MULTIPLIER,
	ECLIPSE_START_DELAY,
	ECLIPSE_WINDOW_SECONDS,
	HEAVY_KEEP_SHARE,
	HEAVY_RESIST,
	HEAVY_STEAL_SHARE,
	MAGNET_DECAY_MULTIPLIER,
	MAGNET_RADIUS,
	MAX_STEAL_PER_CONTACT,
	POWER_BADGE_HEIGHT,
	POWER_BADGE_MAX_DISTANCE,
	POWER_BADGE_NAME,
	POWER_BADGE_OFFSET_STUDS,
	POWER_BADGE_TEXT_SIZE,
	POWER_BADGE_WIDTH,
	COLLISION_POP_CHANCE_BY_POWER,
	DEFAULT_COLLISION_POP_CHANCE,
	HIT_EFFECT_COOLDOWN_SECONDS,
	HIT_EFFECT_MIN_ROUND_AGE_SECONDS,
	POWER_COLLISION_COOLDOWN,
	powerLabel,
	ROCKET_MAX_DELAY,
	ROCKET_MIN_DELAY,
	ROCKET_TARGET_SPEED,
	SPRINTER_BOOST_SPEED,
} from "shared/powers.config";
import { TAGS } from "shared/tags";
import {
	BALL_COLLISION_POP_UPWARD_SPEED,
	BALL_COLLISION_SHOVE_SPEED,
	BALL_SPEED_DECAY_RATE,
	BALL_SPEED_MAX,
	BALL_SPEED_MIN,
	BOOST_TARGET_BALL_SPEED,
} from "shared/tuning";
import { shoveDirection, shoveLateral } from "server/lateral-shove";
import { shouldRecordTouch } from "../elimination-sound";

// #region pure rules

/** One opponent's aura, reduced to the two facts a rule needs. Built by the wrapper, never by a rule. */
export interface PowerAura {
	/** `"magnet"` or `"eclipse"` — the only two powers that reach another ball without touching it. */
	readonly power: string;
	/** Studs between the two bodies' origins. */
	readonly distance: number;
	/** Whether this opponent's `eclipse` window is open. Always `false` for a magnet. */
	readonly eclipsing: boolean;
}

/** A ball's timers for the current `Playing`. Drawn once at entry; never redrawn inside a round. */
export interface PowerTimers {
	/** Seconds after `Playing` entry at which a `rocket` snaps. `-1` for a ball that is not a rocket. */
	readonly rocketAt: number;
	/** Whether the snap has already been handed out this round. */
	readonly rocketFired: boolean;
	/** Seconds after entry at which an `eclipse` window opens. */
	readonly eclipseAt: number;
	/** Seconds after entry at which it closes. */
	readonly eclipseUntil: number;
}

/** Everything a tick needs, as plain data, so the rule below is testable without an instance. */
export interface PowerTickInput {
	/** The body's `Power` attribute, or `""` for a body with no power. */
	readonly power: string;
	/** Whether a round is in `Playing`. A power does nothing outside one. */
	readonly roundActive: boolean;
	/** The ball's `BALL_SPEED` **after** this frame's decay, so a snap delta lands on the right target. */
	readonly speed: number;
	/** The frame's `Heartbeat` delta, in seconds. */
	readonly dt: number;
	/** Seconds since `Playing` entry. */
	readonly elapsed: number;
	readonly timers: PowerTimers;
	/** Auras that could reach this ball. An empty list is the normal case and must cost nothing. */
	readonly auras: ReadonlyArray<PowerAura>;
}

/** What one tick decided. */
export interface PowerTickResult {
	/** Signed delta to `BALL_SPEED`. The loop applies it, clamps, and writes once. */
	readonly delta: number;
	/** Whether a `rocket` snap was handed out on this tick, so the caller can stop offering it. */
	readonly rocketFired: boolean;
}

/** Timers for a ball that has no timed power: they can never open, so every branch below is false. */
export const NO_TIMERS: PowerTimers = {
	rocketAt: -1,
	rocketFired: false,
	eclipseAt: -1,
	eclipseUntil: -1,
};

/**
 * The per-tick delta for one ball: **the whole of the passive, aura and timed kinds, and nothing else.**
 *
 * ## The four answers, in the order they are reached
 *
 * 1. **Not in a round, or no power** → `0`. A power is a property of the race, not of the body: a ball pushed into
 *    `Waiting` must not spend its rocket there, and a ball with no `Power` attribute is a decoy or an un-picked body.
 * 2. **`rocket`, at its drawn moment, once** → a delta that lands exactly on `ROCKET_TARGET_SPEED`. A delta and not an
 *    addition because the *value* is the design: two rocket balls must arrive at the same speed, so the delta is
 *    `target - current`. `rocketFired` is returned so the caller can write it back; without that the snap would re-fire
 *    every frame and the ball would be pinned at the target, which turns a one-shot event into a permanent buff.
 * 3. **Inside an `eclipse` window** → extra negative decay, `DECAY * dt * (multiplier - 1)`. This is the field-wide
 *    counterpart to `magnet` and is applied to the *victim's* tick rather than to the eclipser's, because the tick
 *    function only ever speaks for the ball it was handed.
 * 4. **Inside a `magnet` aura** → the same shape with `MAGNET_DECAY_MULTIPLIER`. Auras do not stack: the test is "in at
 *    least one", so a second magnet is worth exactly as much as the first and the field cannot be made multiplicative.
 *
 * ## Why the delta is negative for a victim and not a write
 *
 * Because `BALL_SPEED_MIN` is the floor, and the floor is applied once, by the loop, after every contributor has spoken.
 * A rule that clamped its own delta would silently disagree with a rule that did not.
 */
export function powerTickDelta(input: PowerTickInput): PowerTickResult {
	if (!input.roundActive || input.power === "") {
		return { delta: 0, rocketFired: false };
	}

	if (input.power === "rocket") {
		const at = input.timers.rocketAt;
		if (!input.timers.rocketFired && at >= 0 && input.elapsed >= at) {
			return { delta: ROCKET_TARGET_SPEED - input.speed, rocketFired: true };
		}
		return { delta: 0, rocketFired: false };
	}

	let delta = 0;

	if (isEclipsed(input)) {
		delta -= BALL_SPEED_DECAY_RATE * input.dt * (ECLIPSE_DECAY_MULTIPLIER - 1);
	}

	if (isMagnetised(input)) {
		delta -= BALL_SPEED_DECAY_RATE * input.dt * (MAGNET_DECAY_MULTIPLIER - 1);
	}

	return { delta, rocketFired: false };
}

/**
 * Whether any opponent's `eclipse` window is open.
 *
 * **The eclipser is exempt from its own window, and that exemption lives in the caller, not here.** `auras` never contains
 * the ball itself — the wrapper skips it — so a body cannot decay faster because of a window it opened. An eclipse ball is
 * still an *opponent* to another eclipse ball, which is why this function has no `power === "eclipse"` branch: exempting by
 * name would also exempt two eclipse balls from each other, and "every opponent's decay is multiplied" says otherwise.
 */
function isEclipsed(input: PowerTickInput): boolean {
	for (const aura of input.auras) {
		if (aura.power === "eclipse" && aura.eclipsing) {
			return true;
		}
	}

	return false;
}

/** Whether any `magnet` ball is close enough. Distance, not direction: the aura is a sphere around the body. */
function isMagnetised(input: PowerTickInput): boolean {
	for (const aura of input.auras) {
		if (aura.power === "magnet" && aura.distance <= MAGNET_RADIUS) {
			return true;
		}
	}

	return false;
}

/** One collision's outcome: what the attacker gains and what the victim loses. */
export interface TransferAmounts {
	readonly gain: number;
	readonly drain: number;
}

/**
 * How much `BALL_SPEED` one collision moves, and from whom.
 *
 * ## Why the steal is a share of what the victim has left
 *
 * A flat steal does not converge: it takes 1.0 from a ball at 10, 9 and 8 alike, so a wedged pair of balls trades the
 * same amount on every contact and the third contact moves exactly as much as the first. A share of the remainder is
 * geometric (1.0, then 0.9, then 0.81), so convergence is a property of the arithmetic rather than of the cooldown, and
 * the exchange cannot drive a ball below the floor — the share goes to zero as the victim reaches it.
 *
 * ## The four numbers, and what each one is for
 *
 * - `stealShare` is the attacker's power: `bully` 0.1, `heavy` 0.15. A heavy ball takes a bigger bite.
 * - `keepShare` is `bully` 1.0, `heavy` 0.6. **`bully` conserves** — the victim loses exactly what the attacker gains, so
 *   the field's total `BALL_SPEED` is unchanged. **`heavy` erodes** — it drains more than it keeps, so the collision
 *   destroys the difference. That is a difference of kind rather than of magnitude, and it is the whole reason the two
 *   are separate powers.
 * - `HEAVY_RESIST` is applied to *incoming* drains. Without it a heavy ball's advantage would exist only when it attacks,
 *   so the first bully to reach it would take a full bite and the name would mean nothing defensively.
 * - `MAX_STEAL_PER_CONTACT` bounds one exchange, because a 18-speed rocket ball would otherwise yield 2.7 in a single
 *   touch and one unlucky contact would decide the round.
 *
 * ## The floor and the ceiling are applied here, not by the caller
 *
 * `BALL_SPEED_MIN` bounds the drain and `BALL_SPEED_MAX` bounds the gain, so no arrangement of two powers can push a body
 * outside the model's range. The caller writes the two results and does no clamping of its own.
 */
export function transferAmounts(
	attackerPower: string,
	victimPower: string,
	attackerSpeed: number,
	victimSpeed: number,
): TransferAmounts {
	const stealShare = attackerPower === "heavy" ? HEAVY_STEAL_SHARE : BULLY_STEAL_SHARE;
	const keepShare = attackerPower === "heavy" ? HEAVY_KEEP_SHARE : BULLY_KEEP_SHARE;
	const resist = victimPower === "heavy" ? HEAVY_RESIST : 1;

	const available = math.max(victimSpeed - BALL_SPEED_MIN, 0);
	const drain = math.min(available * stealShare, MAX_STEAL_PER_CONTACT) * resist;
	const headroom = math.max(BALL_SPEED_MAX - attackerSpeed, 0);

	return { gain: math.min(drain * keepShare, headroom), drain };
}

/** What a `PickupService` contact should do for one ball. */
export interface PickupDecision {
	/** Whether the pickup instance is destroyed. */
	readonly consume: boolean;
	/** The `BALL_SPEED` the pickup sets. */
	readonly boost: number;
}

/**
 * What a pickup does to a ball.
 *
 * ## Every ball destroys the pickup **except `recycle`**
 *
 * `consume` is `true` for every ball because a pad that survives a collection stays under the ball that just took it,
 * `Touched` re-fires while the ball rests on it, and the boost is re-applied every frame — so the ball cannot decay,
 * cannot reach the exit and cannot be eliminated. A Studio run showed one ball held on the belt for 71 seconds by repeated
 * non-consuming collections.
 *
 * **`recycle` is the one deliberate exception, and it is safe by construction rather than by a guard.** Its pad is the
 * resource: the power is "keep the pad in play for the next taker", so destroying it on contact would delete the whole
 * mechanic. The reason the exception does not recreate the 71-second defect is `speedAfterPickup`: a ball parked on a
 * surviving pad is raised to the boost **once**, and the second touch computes the same value and writes nothing. The ball
 * still decays every tick, because the tick loop is the only writer of `BALL_SPEED` per tick and it does not care what the
 * ball is touching. **No "already used" state is needed, and adding one would be the guard this rule makes unnecessary.**
 *
 * ## `sprinter` is the only thing that still differs about the value
 *
 * It takes `SPRINTER_BOOST_SPEED` instead of `BOOST_TARGET_BALL_SPEED`. So this function has exactly two branches: one
 * about whether the pad survives (`recycle`), one about how much a pickup is worth (`sprinter`).
 *
 * ## Why the parameter is still a power id
 *
 * Because both branches read it. If either goes away the parameter stays for the other; if both go, this function collapses
 * to a constant and the parameter goes with them.
 */
export function pickupDecision(power: string): PickupDecision {
	if (power === "recycle") {
		return { consume: false, boost: BOOST_TARGET_BALL_SPEED };
	}

	return { consume: true, boost: power === "sprinter" ? SPRINTER_BOOST_SPEED : BOOST_TARGET_BALL_SPEED };
}

/**
 * The `BALL_SPEED` a ball has after touching a pickup: **the higher of what it has and what the pickup gives.**
 *
 * ## Why this is a function and not an `if` at the call site
 *
 * Because the rule has to be *idempotent* and that is the property worth asserting. A pickup raises a speed; it never
 * lowers one, so a second application of the same `boost` to a ball that already has it is the same as the first — which
 * is what makes a repeated collection harmless on the value even before the consume rule stops the repeat from happening
 * at all. Inlined as `if (before < decision.boost) set(decision.boost)` the rule is true but untestable, and the two
 * properties (it raises, and applying it twice equals applying it once) would live only in a reader's head.
 *
 * `math.max` rather than a branch: one expression, no bounds to get wrong, and correct for a ball that is already faster
 * than the pad — including the `sprinter` case, where a ball that just took a standard pad still gains.
 */
export function speedAfterPickup(current: number, boost: number): number {
	return math.max(current, boost);
}

function popChanceForPower(power: string): number {
	return COLLISION_POP_CHANCE_BY_POWER[power] ?? DEFAULT_COLLISION_POP_CHANCE;
}

function popChanceForContact(attackerPower: string, victimPower: string): number {
	return math.min(popChanceForPower(attackerPower), popChanceForPower(victimPower));
}

/**
 * Makes one pure pop decision for the contact owner, which the handler elects by lower serial.
 *
 * `serial` is the registered contact-state token; zero is not an eligible body. The caller ensures only the lower-serial
 * side invokes this, and the decision is then applied to both bodies.
 */
export function shouldPop(attackerPower: string, victimPower: string, serial: number, random: () => number): boolean {
	if (serial <= 0) {
		return false;
	}

	return random() < popChanceForContact(attackerPower, victimPower);
}

/**
 * Draws a ball's timers for a round, at `Playing` entry.
 *
 * `rocketAt` is drawn here rather than read on each tick so the moment is fixed for the round: a re-draw inside the tick
 * would move the target every frame and the snap would fire on whatever frame happened to satisfy the comparison.
 *
 * `random` is a parameter so a spec can pin it; the default is `math.random`, which is what the server uses.
 */
export function drawTimers(power: string, random: (min: number, max: number) => number = math.random): PowerTimers {
	const rocketAt = power === "rocket" ? ROCKET_MIN_DELAY + random(0, ROCKET_MAX_DELAY - ROCKET_MIN_DELAY) : -1;
	const eclipseAt = power === "eclipse" ? ECLIPSE_START_DELAY : -1;
	const eclipseUntil = power === "eclipse" ? ECLIPSE_START_DELAY + ECLIPSE_WINDOW_SECONDS : -1;

	return { rocketAt, rocketFired: false, eclipseAt, eclipseUntil };
}

/** Whether an `eclipse` window is open at `elapsed` seconds after `Playing` entry. */
export function windowOpen(timers: PowerTimers, elapsed: number): boolean {
	return timers.eclipseAt >= 0 && elapsed >= timers.eclipseAt && elapsed < timers.eclipseUntil;
}

// #endregion

// #region collision groups

/**
 * The two groups every ball lives in.
 *
 * ## Why two and not one
 *
 * `ghost` means "cannot collide with other balls, walls still collide". A collision group is a **pair** of names, so
 * disabling one pair is all-or-nothing for a group: putting a ghost ball in a group and disabling that group against
 * `Default` would also stop it colliding with the belt, the walls and the slab, because those are all in `Default`. Walls
 * have to keep colliding, so the balls need their own group that is *collidable* with `Default`, and ghosts need a second
 * group that is collidable with `Default` but not with the ordinary ball group.
 *
 * | pair                     | collides | why                                     |
 * | ------------------------ | -------- | --------------------------------------- |
 * | `BALL_GROUP` / `Default`  | yes      | belt, walls, slab, players stay solid   |
 * | `GHOST_GROUP` / `Default` | yes      | a ghost still hits walls                |
 * | `BALL_GROUP` / `BALL_GROUP` | yes    | every other ball keeps colliding        |
 * | `GHOST_GROUP` / `BALL_GROUP` | no    | the power                               |
 * | `GHOST_GROUP` / `GHOST_GROUP` | no   | two ghosts pass through each other      |
 *
 * **Every ball** moves into `BALL_GROUP`, including plain ones, because a pair is symmetric: a ghost can only be told
 * apart from a normal ball by the *other* side's group. The cost is that balls are no longer in `Default`, which is a
 * change to the scene's collision graph — stated here because a designer debugging a collision in Studio will look at
 * the group property and find it is no longer `Default`.
 *
 * **The intended nerf is not built:** the design note calls for ghost to be a periodic toggle, so a ghost spends part of
 * the round solid. That would need a per-ball clock and a group flip, and it is deliberately absent — a ghost today is
 * permanently intangible to other balls.
 */
export const BALL_GROUP: string = "CompetitorBall";
export const GHOST_GROUP: string = "GhostBall";

/** The group a body should be in, given its power. */
export function collisionGroupFor(power: string): string {
	return power === "ghost" ? GHOST_GROUP : BALL_GROUP;
}

let groupsRegistered = false;

/**
 * Registers both groups and their collidability, once per server.
 *
 * Run from the first `setPower`, not at module load: a module that registers collision groups on require would run in the
 * Jest runtime, which has no `PhysicsService`. `RegisterCollisionGroup` errors if the name already exists, so the guard is
 * a module-level flag *and* a `pcall` — the flag covers the normal path, the `pcall` covers a group a designer created by
 * hand in Studio, which is exactly the situation where the flag would be wrong and an error would be fatal.
 */
function ensureCollisionGroups(): void {
	if (groupsRegistered) {
		return;
	}
	groupsRegistered = true;

	pcall(() => PhysicsService.RegisterCollisionGroup(BALL_GROUP));
	pcall(() => PhysicsService.RegisterCollisionGroup(GHOST_GROUP));

	// Explicitly true rather than left to the default, so the intent is in the file: these are the pairs that must keep
	// colliding, and a designer reading the groups in Studio sees why `Default` is untouched.
	pcall(() => PhysicsService.CollisionGroupSetCollidable(BALL_GROUP, "Default", true));
	pcall(() => PhysicsService.CollisionGroupSetCollidable(GHOST_GROUP, "Default", true));
	pcall(() => PhysicsService.CollisionGroupSetCollidable(BALL_GROUP, BALL_GROUP, true));
	pcall(() => PhysicsService.CollisionGroupSetCollidable(GHOST_GROUP, GHOST_GROUP, false));
	pcall(() => PhysicsService.CollisionGroupSetCollidable(GHOST_GROUP, BALL_GROUP, false));
}

// #endregion

// #region per-ball state

/** Everything this module remembers about one ball. Cleared by `forgetBall` and re-drawn by `onRoundActive`. */
interface BallPowerState {
	readonly power: string;
	readonly startedAt: number;
	timers: PowerTimers;
	lastCollisionAt: number;
}

/**
 * The per-ball state map, keyed by instance so it dies with the body.
 *
 * **Two entries only ever exist between `onRoundActive` and `forgetBall`**, so its size is the number of bodies in the
 * current round rather than the number ever spawned. That is why the timers can carry `startedAt`: an entry cannot
 * outlive the round it was drawn for.
 */
const states = new Map<BasePart, BallPowerState>();

/**
 * Every body's **hit-effect** bookkeeping: when it last drew a burst, and a monotone id used to order a pair.
 *
 * ## Why this is not part of `BallPowerState`
 *
 * A power state exists only for a body that *has* a power (`onRoundActive` returns early for a plain ball), and the burst
 * is no longer the property of a power: since item 111 every contact between two bodies draws one. A plain body needs a
 * cooldown clock and a serial exactly as much as a bully does, so this map is created lazily in `onBallCollision` for any
 * body that touches another and is cleared in `forgetBall` like every other per-body map here.
 *
 * **`serial` carries no meaning** beyond "this body registered before that one". It exists so exactly one handler of a
 * two-sided `Touched` speaks for the pair, rather than two bursts landing on the same point.
 */
interface ContactEffectState {
	lastBurstAt: number;
	readonly serial: number;
}

const contactEffects = new Map<BasePart, ContactEffectState>();

/**
 * The next `ContactEffectState.serial`.
 *
 * Never reset: it only has to be unique within a session and monotone, and a counter that restarted could hand two live
 * bodies the same number across a round boundary, which would make the pair ordering below depend on iteration order.
 */
let nextBallSerial = 1;

/**
 * When this round's `Playing` phase began, by `os.clock`. Read only by the burst's age gate.
 *
 * A module-level stamp rather than a per-body one because the gate is about the **round**, and a plain body has no
 * per-body state to hang it on. Set by `setRoundActive(true)` and left alone on exit, so a stale value can never be read:
 * the gate is behind `powersActive`.
 */
let roundStartedAt = 0;

/** Every body that touches another needs an entry; created on first contact, removed by `forgetBall`. */
function contactEffectOf(ball: BasePart): ContactEffectState {
	const existing = contactEffects.get(ball);
	if (existing !== undefined) {
		return existing;
	}

	const created: ContactEffectState = { lastBurstAt: -math.huge, serial: nextBallSerial++ };
	contactEffects.set(ball, created);
	return created;
}

/** Bodies whose `power` reaches another without touching it, so a victim can find them without walking every ball. */
const magnetBalls = new Set<BasePart>();
const eclipseBalls = new Set<BasePart>();

/** Returned when no aura-carrying body exists, so the common case allocates nothing. */
const NO_AURAS: ReadonlyArray<PowerAura> = [];

/** One `Touched` connection per colliding ball, disconnected by `forgetBall`. */
const collisionConnections = new Map<BasePart, RBXScriptConnection>();

/** The `Power` attribute of a body, or `""`. **The attribute is the truth**, not the state map: it replicates and it dies
 * with the body, so a body whose state was never created still reads correctly here. */
export function powerOf(ball: BasePart): string {
	const raw = ball.GetAttribute(POWER_ATTRIBUTE);
	return typeIs(raw, "string") ? raw : "";
}

/**
 * Gives a body the **presentation** of a power: the attribute, the collision group and the badge.
 *
 * Split out of `setPower` for the `decoy` twin. A decoy has to be indistinguishable from its parent — no `Power`
 * attribute, no badge, no textures and no markers made it identifiable at a glance, so the power deceived nobody and its
 * only real effect was to hold a `MaxLiveBalls` slot. But it must also stay **mechanically inert**: `setPower` registers a
 * body in the aura registries and gives it a `Touched` connection, so a decoy made with `setPower` would emit a real
 * `magnet` or `eclipse` aura, and an `eclipse` decoy would freeze the field from a body `getCompetitors()` cannot see.
 *
 * So: everything a viewer can perceive goes through here, and everything the simulation acts on stays in `setPower`.
 */
export function presentPower(ball: BasePart, power: string, radius: number): void {
	ensureCollisionGroups();

	if (power === "") {
		ball.SetAttribute(POWER_ATTRIBUTE, undefined);
	} else {
		ball.SetAttribute(POWER_ATTRIBUTE, power);
	}

	ball.CollisionGroup = collisionGroupFor(power);

	updateBadge(ball, power, radius);
}

/**
 * Gives a body its power **and** makes it live: the presentation above, plus the aura registry entry and the collision
 * connection.
 *
 * **Called at spawn, before `Parent`**, so no frame exists in which a body is in the world with a chosen ball but no
 * power — the same ordering the owner attributes use and for the same reason. It is also called when the player's pick
 * changes during `Waiting`, because `ChosenBallId` is written twice: once from the offer's timeout pick at spawn, and
 * again when the player actually chooses. A power derived only at spawn would leave a body racing the timeout pick's
 * power while carrying the player's chosen id, which is the worst kind of bug — a body whose behaviour disagrees with the
 * ball the player is looking at.
 */
export function setPower(ball: BasePart, power: string, radius: number): void {
	presentPower(ball, power, radius);

	// The old state is dropped rather than re-keyed: a new power means new timers, and a half-kept `lastCollisionAt` from
	// one power would damp the first contact of the next.
	forgetBall(ball);

	// The registry is keyed on the power, so it is filled here — the one place a body's power is decided. A ball with a
	// non-aura power is removed from both, so a body that changed power cannot leave a stale aura behind.
	magnetBalls.delete(ball);
	eclipseBalls.delete(ball);
	if (power === "magnet") {
		magnetBalls.add(ball);
	} else if (power === "eclipse") {
		eclipseBalls.add(ball);
	}

	// **Every body connects, not only the two colliding powers.** The brief for item 84 attached this only to `bully` and
	// `heavy` — the powers that can transfer speed — which left a plain-vs-ghost contact invisible to the server. The
	// last-touch record (item 87, the elimination sound's input) needs a touch for *every* pair, because the body that
	// gets knocked off the belt is usually not the colliding one. The transfer stays where it was: the handler's own gates
	// still require `isColliding`, so the extra connections change who is *recorded*, not who is *acted on*.
	collisionConnections.set(
		ball,
		ball.Touched.Connect((other) => onBallCollision(ball, other)),
	);
}

function isColliding(power: string): boolean {
	return power === "bully" || power === "heavy";
}

/**
 * Drops everything this module holds for one body.
 *
 * Called from **both** death paths — `destroyBall` and `pruneDestroyedBalls` — in the same block that clears
 * `ballKillY`, because the maps there and the maps here have the same lifetime and a map cleared in one path and not the
 * other grows by one entry per ball for the length of a server session. Also called by `setPower`, which is what makes a
 * re-pick restart its timers rather than inherit the previous power's clock.
 */
export function forgetBall(ball: BasePart): void {
	states.delete(ball);
	contactEffects.delete(ball);
	magnetBalls.delete(ball);
	eclipseBalls.delete(ball);
	collisionConnections.get(ball)?.Disconnect();
	collisionConnections.delete(ball);

	// The last-touch record, **from both ends**. Dropping only the key would leave every entry that names this body as
	// the toucher pointing at a destroyed part, which `lastToucherOf` then has to reject one entry at a time — and this
	// map, like the three above it, has to be cleared on every death path or it grows by one entry per ball for the
	// length of a session. Removals are collected first because deleting while iterating a `Map` is not a contract worth
	// relying on across Luau versions.
	lastTouchedBy.delete(ball);
	const staleKeys = new Array<BasePart>();

	for (const [touched, toucher] of lastTouchedBy) {
		if (toucher === ball) {
			staleKeys.push(touched);
		}
	}

	for (const touched of staleKeys) {
		lastTouchedBy.delete(touched);
	}
}

/**
 * Starts a body's timers. **The round's clock, not the body's** — a ball that spent fifteen seconds in `Waiting` must not
 * spend its rocket there, so `startedAt` is `Playing` entry and `elapsed` is measured from it.
 *
 * Idempotent in effect: called for every live ball at `setRoundActive(true)` and again for a ball spawned mid-round, and
 * either way the timers are redrawn from the body's current power.
 */
export function onRoundActive(ball: BasePart): void {
	const power = powerOf(ball);

	// Only the timer entry is replaced. **`forgetBall` is deliberately not called here:** it would also disconnect the
	// `Touched` connection that `setPower` made, so a bully or heavy ball would enter `Playing` unable to collide for the
	// rest of the round — the exact bug a "reset everything" helper invites. State and connection have different
	// lifetimes: the state is per-round, the connection is per-body.
	states.delete(ball);

	if (power === "") {
		return;
	}

	states.set(ball, {
		power,
		startedAt: os.clock(),
		timers: drawTimers(power),
		lastCollisionAt: -math.huge,
	});
}

// #endregion

// #region the tick

/** What the tick loop passes in. Deliberately two fields: the rules read the module's own state. */
export interface PowerTickContext {
	readonly dt: number;
	readonly roundActive: boolean;
}

/**
 * One ball's delta for this frame, or `0`.
 *
 * The wrapper's whole job is to turn instances into the plain input `powerTickDelta` wants: read the attribute, read the
 * clock, and collect the auras that could reach this ball. `0` for a body with no state, which is the same answer as "not
 * in a round" and needs no second flag.
 *
 * ## Cost
 *
 * The aura scan is over `magnetBalls` ∪ `eclipseBalls`, not over every ball. At 50 balls with two magnets that is two
 * distance checks per ball per frame — 100 per tick, 6000 per second — against two reads and a subtraction each. A scan
 * over the whole field would be 2500 per tick and 150 000 per second for a feature that is usually absent, which is why
 * the registry exists.
 */
export function tickDelta(ball: BasePart, context: PowerTickContext): number {
	const state = states.get(ball);
	if (state === undefined) {
		return 0;
	}

	if (!context.roundActive) {
		return 0;
	}

	const elapsed = os.clock() - state.startedAt;
	const auras = magnetBalls.size() === 0 && eclipseBalls.size() === 0 ? NO_AURAS : collectAuras(ball);
	const result = powerTickDelta({
		power: state.power,
		roundActive: context.roundActive,
		speed: readSpeed(ball),
		dt: context.dt,
		elapsed,
		timers: state.timers,
		auras,
	});

	if (result.rocketFired) {
		state.timers = { ...state.timers, rocketFired: true };
	}

	return result.delta;
}

/** The auras that could reach `ball` this frame. Both registries are walked; `eclipsing` is resolved here.
 *
 * **The ball itself is always skipped**, and that is the whole of the "an eclipser is exempt from its own window" rule:
 * `powerTickDelta` is not told which aura belongs to whom, so the exclusion has to happen where identity is available.
 */
function collectAuras(ball: BasePart): Array<PowerAura> {
	const auras = new Array<PowerAura>();
	const origin = ball.Position;

	for (const magnet of magnetBalls) {
		if (magnet === ball || magnet.Parent === undefined) {
			continue;
		}
		auras.push({ power: "magnet", distance: origin.sub(magnet.Position).Magnitude, eclipsing: false });
	}

	for (const eclipser of eclipseBalls) {
		if (eclipser === ball || eclipser.Parent === undefined) {
			continue;
		}

		// The eclipser's own window is in *its* state, drawn from its own `Playing` entry. Two bodies always enter the same
		// round together, so the elapsed values agree in practice; reading the eclipser's own clock is still the honest
		// thing to do, because the window belongs to the body that opened it.
		const theirs = states.get(eclipser);
		const open = theirs !== undefined && windowOpen(theirs.timers, os.clock() - theirs.startedAt);
		auras.push({ power: "eclipse", distance: origin.sub(eclipser.Position).Magnitude, eclipsing: open });
	}

	return auras;
}

/** A ball's `BALL_SPEED`, or the model's floor for a body that somehow has no attribute. */
export function readSpeed(ball: BasePart): number {
	const raw = ball.GetAttribute(BALL_SPEED_ATTRIBUTE);
	return typeIs(raw, "number") ? raw : BALL_SPEED_MIN;
}

// #endregion

// #region the collision

/**
 * Whether the simulation is running, i.e. whether the round is in `Playing`.
 *
 * ## Why this module keeps its own flag instead of asking `RoundService`
 *
 * Because asking would close a require cycle: `RoundService` -> `BallSpawnerService` -> this module, so an import of
 * `RoundService` from here is the edge the tree has avoided since item 22 chose a number over a phase
 * read for exactly this reason. The second option — reading the `RoundState` `StringValue` out of `ReplicatedStorage` — was
 * also rejected, because it is a second source of truth for a fact the spawner is already told, and it would put a
 * `FindFirstChild` on a collision handler.
 *
 * **The flag is fed by `setRoundActive`, the same boolean the velocity model already trusts.** `BallSpawnerService` has
 * carried it since item 22 to gate `stepBallSpeeds`, and `RoundService` sets it at `Playing` entry and on every exit path.
 * If this flag is ever wrong, the whole simulation is wrong first — so it is not a second opinion, it is the same one.
 */
let powersActive = false;

/** Called from `BallSpawnerService.setRoundActive`, once per phase change. */
export function setRoundActive(active: boolean): void {
	powersActive = active;

	if (active) {
		roundStartedAt = os.clock();
	}

	if (!active) {
		// **The round is over, so every record in here is a fact about a round that has ended.** Nothing reads the map
		// outside `Playing` — the sound it feeds is gated on the phase — so the only thing keeping the entries would buy
		// is that the next round's bodies inherit a contact from the previous one. A body re-spawned into the same slot
		// is a *different* body with the same coordinates, and crediting its next elimination to last round's attacker is
		// exactly the kind of stale answer this map exists to avoid giving.
		const dropped = lastTouchedBy.size();
		lastTouchedBy.clear();

		// **One line per round, and only when there was something to drop.** The map's growth is otherwise invisible:
		// a missing deletion in a death path would show up as a count that climbs round after round, and this is the one
		// moment the map is emptied, so this is where the number is cheap to print and meaningful to compare.
		if (dropped > 0) {
			print(`[Powers] last-touch records cleared: ${dropped}`);
		}
	}
}

/**
 * Who last touched each body, so an elimination can name the player who caused it.
 *
 * ## Why this lives here rather than in `RoundService`
 *
 * The fact is a **collision** fact. The only code that ever sees two bodies in contact is `onBallCollision` below, and
 * `RoundService` never sees a touch at all — it sees a body leave the belt. A record kept anywhere else would be a second
 * and staler answer to a question this module is already answering, and this tree has refused that shape twice (the
 * phase flag, the hit-effect remote).
 *
 * ## Keyed by the touched body, valued by the toucher's *body*, not its user id
 *
 * The key is the body being hit, so the map answers exactly the question the elimination asks: "who hit *this* body,
 * last?" — one lookup, no scan. The value is a `BasePart` rather than a number because the owner attribute on that part
 * is the only source of truth for who owns a body; copying the id at write time would create a second place for the
 * decoy rule, the synthetic-owner rule and the write path to disagree.
 *
 * **One entry per body, not one per pair.** A contact between two competitors stores two records, one in each direction,
 * because "who touched A last" and "who touched B last" are separate facts that go stale at different times — A may be
 * eliminated and B survive, and B must keep its attacker. A pair-keyed map would have to be deleted from both ends and
 * would still not answer the single-body question for a body that has been touched by three others.
 */
const lastTouchedBy = new Map<BasePart, BasePart>();

/**
 * One body's `OwnerUserId`, or `undefined` when it carries none.
 *
 * `typeIs` rather than a cast, matching `hasOwnerIdentity` in `shared/attributes`: `GetAttribute` returns
 * `AttributeValue`, a missing attribute reads as `undefined`, and a cast would let that `undefined` travel onwards as a
 * number.
 */
function ownerIdOf(ball: BasePart): number | undefined {
	const value = ball.GetAttribute(OWNER_USER_ID_ATTRIBUTE);
	return typeIs(value, "number") ? value : undefined;
}

/**
 * Records that `toucher` touched `touched`, when both ends are owned by a real player.
 *
 * The filter is `shouldRecordTouch`, in `server/elimination-sound.ts`, because the write and the read have to agree about
 * what a decoy and a `Debug#N` body are — a record that can only ever answer "no sound" is not worth the memory, and the
 * map's size stays bounded by the number of *competitors* rather than by the number of contacts.
 *
 * ## Why this runs above the power gates in `onBallCollision`
 *
 * A touch is a touch whether or not it transfers speed. `ghost` sliding past a plain body is the pair that can kill
 * silently, and it is exactly the pair a transfer-gated record would miss. So the record sits immediately after "the
 * other thing is a ball" and above every guard that decides whether the *transfer* happens.
 */
function rememberTouch(touched: BasePart, toucher: BasePart): void {
	if (!shouldRecordTouch(ownerIdOf(touched), ownerIdOf(toucher))) {
		return;
	}

	lastTouchedBy.set(touched, toucher);
}

/**
 * The body that last touched `body`, if that body is still in the world.
 *
 * **Read before the destroy at every call site**, because a destroyed part reports its defaults and the answer would
 * silently become "nobody". The parent check here covers the other order: the ball that knocked a body off the belt can
 * itself be culled first, and a destroyed toucher is a stale answer rather than a missing one — saying so here is
 * cheaper than making each caller remember it.
 */
export function lastToucherOf(body: BasePart): BasePart | undefined {
	const toucher = lastTouchedBy.get(body);

	if (toucher === undefined || toucher.Parent === undefined) {
		return undefined;
	}

	return toucher;
}

/**
 * The broadcast remote the hit effect is fired through, handed in by `RoundService` at start.
 *
 * ## Why it is fed in rather than looked up
 *
 * A `ReplicatedStorage.FindFirstChild` inside the collision handler is the alternative, and this tree has refused that
 * shape before (item 22 chose a boolean over a phase read for the same reason): a lookup in a handler that runs per
 * contact is paid at the worst rate in the game. Creating the remote here at `require` time is not possible either — a
 * module that touches the DataModel during `require` runs in the Jest runtime, which has no instances, the wall item 74
 * hit with `PhysicsService`.
 *
 * `undefined` until `RoundService` has started. A collision cannot arrive before that: the handler's first gate is
 * `powersActive`, which is only true inside `Playing`. The `undefined` branch is a guard, not a state.
 */
let hitEffectRemote: RemoteEvent | undefined;

/** Called from `RoundService` once, after the `Remotes` folder exists. */
export function setHitEffectRemote(remote: RemoteEvent): void {
	hitEffectRemote = remote;
}

/**
 * Three decimals, no `string.format`, matching the formatters in `treadmill-service` and `ball-spawner-service`.
 *
 * Kept local rather than shared: those two already carry their own copy, and a shared helper would be a fourth module for
 * a function this one calls in a single log line. The numbers here are world positions, where three decimals is enough to
 * tell two bodies apart and not so many that float noise obscures the value.
 */
function formatVector(value: Vector3): string {
	const round = (n: number) => tostring(math.round(n * 1000) / 1000);
	return `(${round(value.X)}, ${round(value.Y)}, ${round(value.Z)})`;
}

function writePopY(ball: BasePart, currentVelocity: Vector3, y: number): void {
	// Preserve the model-owned along-belt X and sway-owned Z; only the vertical component is replaced.
	ball.AssemblyLinearVelocity = new Vector3(currentVelocity.X, y, currentVelocity.Z);
}

/**
 * Rolls once for the lower-serial body and applies a successful pop to both bodies.
 *
 * This intentionally shares the burst's round-age and per-body cooldown gates. The pop therefore cannot strobe during
 * the measured spawn pile-up and cannot occur more often than the visual hit gate; a separate clock would let a ball pop
 * while its burst was suppressed. The vertical-speed threshold avoids replacing an already-fast vertical contact response.
 */
function maybePop(ball: BasePart, other: BasePart): void {
	const now = os.clock();

	if (now - roundStartedAt < HIT_EFFECT_MIN_ROUND_AGE_SECONDS) {
		return;
	}

	const mine = contactEffectOf(ball);
	if (now - mine.lastBurstAt < HIT_EFFECT_COOLDOWN_SECONDS) {
		return;
	}

	if (contactEffectOf(other).serial < mine.serial) {
		return;
	}

	const ballVelocity = ball.AssemblyLinearVelocity;
	const otherVelocity = other.AssemblyLinearVelocity;
	if (
		math.abs(ballVelocity.Y) >= BALL_COLLISION_POP_UPWARD_SPEED ||
		math.abs(otherVelocity.Y) >= BALL_COLLISION_POP_UPWARD_SPEED
	) {
		return;
	}

	const attackerPower = powerOf(ball);
	const victimPower = powerOf(other);
	const chance = popChanceForContact(attackerPower, victimPower);
	let roll = 0;
	if (
		!shouldPop(attackerPower, victimPower, mine.serial, () => {
			roll = math.random();
			return roll;
		})
	) {
		return;
	}

	writePopY(ball, ballVelocity, BALL_COLLISION_POP_UPWARD_SPEED);
	writePopY(other, otherVelocity, BALL_COLLISION_POP_UPWARD_SPEED);
	print(
		`[Powers] pop: ball=${ball.GetFullName()} other=${other.GetFullName()} chance=${chance} roll=${roll} y=${BALL_COLLISION_POP_UPWARD_SPEED}`,
	);
}

/**
 * Leaves one sideways impulse on each body of a qualifying contact.
 *
 * ## Why this exists, given the sway owns Z
 *
 * The engine's own lateral separation is real but invisible: `stepBallSpeeds` sets the lateral component every tick, so a
 * collision moves a ball sideways for one physics step — about `1/60` of a stud — before the sway replaces it. A Studio log
 * showed `hit` and `pop` lines with no sideways movement, which is that arithmetic rather than a dormant engine. This
 * records an *impulse* the sway's writer applies and decays, so the axis keeps one writer and the shove cannot race it.
 *
 * ## Why it does not roll
 *
 * The pop is a flourish and is chance-gated; separation is the physical consequence of a contact and happens on every
 * gated contact. Tying the shove to the pop's roll would leave half the hits still reading as a nudge.
 *
 * ## The gates
 *
 * The same three `maybePop` uses, read from the same clock, and it must run before `maybeBurst` stamps that clock: round
 * age (the spawn pile-up is not a hit), the per-body contact cooldown, and the lower `serial` of the pair, so `Touched`
 * firing on both parts still produces one shove rather than two.
 *
 * ## Why the direction is the contact normal
 *
 * Two bodies in adjacent lanes get a normal that is mostly across the belt, which the writer projects onto `across` — the
 * full shove. Two bodies dead in line get a normal that is mostly along-belt, whose along-belt part the writer drops, so a
 * pure rear-end contact shoves little. That is deliberate: it is what a real separation would do, and forcing a sideways
 * kick out of a head-on hit would read as a random flick. The vertical pop covers that contact instead.
 */
function maybeShove(ball: BasePart, other: BasePart): void {
	const now = os.clock();

	if (now - roundStartedAt < HIT_EFFECT_MIN_ROUND_AGE_SECONDS) {
		return;
	}

	const mine = contactEffectOf(ball);
	if (now - mine.lastBurstAt < HIT_EFFECT_COOLDOWN_SECONDS) {
		return;
	}

	if (contactEffectOf(other).serial < mine.serial) {
		return;
	}

	const direction = shoveDirection(ball.Position, other.Position, mine.serial);
	shoveLateral(ball, direction.mul(-BALL_COLLISION_SHOVE_SPEED));
	shoveLateral(other, direction.mul(BALL_COLLISION_SHOVE_SPEED));
	print(
		`[Powers] shove: ball=${ball.GetFullName()} other=${other.GetFullName()} speed=${BALL_COLLISION_SHOVE_SPEED} dir=${formatVector(direction)}`,
	);
}

/**
 * Decides whether this contact draws a burst, and if so fires it.
 *
 * ## Why this is no longer inside the transfer path
 *
 * It used to sit at the transfer's fire site, which quietly made the burst a property of `bully` and `heavy`: every other
 * contact returned at the colliding-power gate and drew nothing, so a belt of plain bodies collided in silence. The burst
 * now answers "two bodies touched", which is what a hit effect is for, and the transfer below is untouched - it still
 * requires a colliding power and still runs on its own cooldown.
 *
 * ## The gates, in order
 *
 * `powersActive` sits above this in `onBallCollision`, as does the `Ball` tag. Here: **round age** (the spawn pile-up at
 * the start of a round is not a hit, see `HIT_EFFECT_MIN_ROUND_AGE_SECONDS`) then **this body's burst clock**
 * (`HIT_EFFECT_COOLDOWN_SECONDS`, not the transfer's) then **lower `serial` of the pair**. That last one exists because
 * `Touched` fires on both parts and `ball.Position.Lerp(other.Position, 0.5)` is symmetric: without it, one contact draws
 * two identical bursts on the same point.
 *
 * Only the body that fires stamps its clock, so a pair's rate is the firing body's rate. Short-circuiting at the serial
 * gate therefore leaves the clock to the side that owns the pair, which is the side that would have fired.
 */
function maybeBurst(ball: BasePart, other: BasePart): void {
	const now = os.clock();

	if (now - roundStartedAt < HIT_EFFECT_MIN_ROUND_AGE_SECONDS) {
		return;
	}

	const mine = contactEffectOf(ball);
	if (now - mine.lastBurstAt < HIT_EFFECT_COOLDOWN_SECONDS) {
		return;
	}

	if (contactEffectOf(other).serial < mine.serial) {
		return;
	}

	mine.lastBurstAt = now;
	broadcastHit(ball, other);
}

/**
 * Tells every client where two balls hit, so each plays one burst there.
 *
 * ## The midpoint is a position, not a contact
 *
 * `BindToCollisionSummaries` would give the real contact point and cannot be used: it is not callable from `Touched`, it
 * does not replicate, and network ownership here flaps between the server and players. Two 1-stud spheres put their
 * midpoint within half a stud of the contact, which is smaller than the burst the client draws, so the difference is not
 * something a player can see.
 *
 * ## Why the log line exists
 *
 * One line per burst drawn, which since item 111 is one line per qualifying **contact**: `maybeBurst` decides and this
 * function only draws. The count is therefore the burst rate rather than the transfer rate - a pair with no colliding power
 * still draws, and a pair with one still draws only once per `HIT_EFFECT_COOLDOWN_SECONDS`. A contact that leaves no line
 * is one the firing body had burst from recently, not one that "was not fast enough".
 */
function broadcastHit(ball: BasePart, other: BasePart): void {
	const remote = hitEffectRemote;
	if (remote === undefined) {
		return;
	}

	const midpoint = ball.Position.Lerp(other.Position, 0.5);

	// **The larger of the two bodies, because a contact has two.** They can differ (a `decoy` twin is a copy, but a body
	// can be reloaded or re-sized between rounds), and an effect smaller than the biggest thing in the contact reads as a
	// bug — the alternative, the average, would be smaller than one of the two by construction. A radius rather than a
	// `Size` so the client applies the same formula a trail does (`effectScaleForRadius`), instead of dividing by two in a
	// second place.
	//
	// **A second argument, not a changed first one.** Lua ignores extra arguments, so a client built before this round
	// draws an unscaled burst rather than nothing, and a client with this round's code reads `radius` and scales. The
	// reverse pairing — an old server, a new client — reads `radius` as `nil`, which `burst` treats as "no size reported".
	const radius = math.max(ball.Size.X, other.Size.X) / 2;
	remote.FireAllClients(midpoint, radius);
	print(`[Powers] hit: ball=${ball.GetFullName()} other=${other.GetFullName()} midpoint=${formatVector(midpoint)}`);
}

/**
 * A ball touched something. Resolves the transfer pair and writes both speeds.
 *
 * ## The phase gate comes first, and it is the one thing this handler was missing
 *
 * `setRoundActive(false)` zeroes every ball's `BALL_SPEED` but leaves this module's per-ball state — and therefore
 * `lastCollisionAt` — alive until the bodies are destroyed. Before this gate, a bully whose body was still touching another
 * body during `PostGame` went on running the transfer machinery. It *happened* to be harmless, because the drain is
 * proportional to the victim's speed and every speed had just been zeroed (`0.1 x 0 = 0`), but that is an accident of the
 * arithmetic rather than a rule, and a flat drain would have written speed back onto frozen bodies. **The round is over;
 * nothing here should be deciding anything.**
 *
 * No cooldown is stamped outside `Playing` either, so the first contact of the next round is never damped by the last
 * contact of the previous one.
 *
 * ## Why the write is safe here and a force would not be
 *
 * `BALL_SPEED` is the model's number, and the tick loop rewrites a ball's *velocity* from it — but nothing writes
 * `BALL_SPEED` itself between two ticks, so a value written here survives to the next tick and is then what the velocity
 * is derived from. A whole-vector write to X/Z would be replaced by the next movement tick. Y is different: that loop
 * preserves the vertical component, which is why the contact pop below changes only Y and does not touch the `BALL_SPEED`
 * model.
 *
 * ## Why both handlers firing is right for the transfer and wrong for the effect
 *
 * `Touched` fires on both parts, so a bully-vs-heavy contact runs each side's handler once. For the **transfer** that is
 * correct rather than doubled: each handler speaks for its own ball, and the exchange is genuinely two transfers in
 * opposite directions. The asymmetry of `heavy` is what makes the pair net out in its favour, not a suppressed handler.
 *
 * For the **effect** there is no such argument, and it used to draw two bursts. `broadcastHit` sends
 * `ball.Position.Lerp(other.Position, 0.5)`, which is symmetric, so the second call fired a second burst at exactly the
 * same point in the same millisecond - visible in the log as two `[Powers] hit` lines with an identical midpoint followed
 * by two identical `[HitEffect] burst` lines. The burst is now fired from one deterministic side of the pair, by
 * `serial`, and both transfers are left alone.
 *
 * ## The gates the transfer passes, in order
 *
 * `powersActive` (1) → `other` carries the `Ball` tag (2) → this body has state and a colliding power (3) → the
 * per-ball `POWER_COLLISION_COOLDOWN` (4) → the transfer has somewhere to go (5).
 *
 * **Neither contact effect is in that chain any more** (item 111). The pop and burst are decided above gate (3), on their
 * shared contact-effect clock; see `maybePop` and `maybeBurst` for their eligibility rules.
 *
 * ## The transfer moves a number, not a direction
 *
 * A transfer writes each body's `BALL_SPEED` attribute — a **scalar** — and touches neither velocity nor position. Which
 * way a ball then travels is decided entirely by `BallSpawnerService.stepBallSpeeds` on the next `Heartbeat`, from
 * `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED` along the belt's `RightVector` (world X — the **along-belt** axis;
 * `RightVector` is not lateral here). Toward `+X` is toward the **back**, where a ball is eliminated; toward `-X` is
 * toward the **front**, where it spawned.
 *
 * So a drain *can* change a ball's direction of travel, but only indirectly: once its `BALL_SPEED` falls below the
 * reference the model turns it around. There is no lateral component in the model. X and Z remain owned by the belt model
 * and the sway respectively: the contact pop writes only Y, and the contact shove is an *impulse* that the sway's writer
 * projects, applies and decays — never a velocity written from here.
 *
 * **Gate (3) is why a pair with no colliding power produces no burst.** That is now a property of this handler alone: since
 * item 87 every body carries a `Touched` connection (see `setPower`), and the colliding-power check moved from the
 * connection to here.
 */
export function onBallCollision(ball: BasePart, other: BasePart): void {
	if (!powersActive) {
		return;
	}

	if (!other.HasTag(TAGS.ball)) {
		return;
	}

	// The last-touch record, above every gate that is about the *transfer* and below the one that says "the other thing
	// is a ball". See `rememberTouch` for why it is here and not beside the fire.
	rememberTouch(ball, other);

	// **The pop, the shove and the burst are decided here, above every transfer gate.** All three read the same contact
	// clock, and the first two must run before `maybeBurst` stamps it. They are contact effects; none changes the transfer
	// below. The burst used to sit at the fire site below, which made it a
	// property of `bully` and `heavy` only - so a belt of plain bodies collided in silence. It is now a property of
	// *contact*: any body touching another draws one, throttled by `HIT_EFFECT_COOLDOWN_SECONDS` rather than by the
	// transfer's cooldown. Nothing about the transfer moved; it is still gated on a colliding power below.
	maybePop(ball, other);
	maybeShove(ball, other);
	maybeBurst(ball, other);

	const state = states.get(ball);
	if (state === undefined || !isColliding(state.power)) {
		return;
	}

	const now = os.clock();
	if (now - state.lastCollisionAt < POWER_COLLISION_COOLDOWN) {
		return;
	}

	const amounts = transferAmounts(state.power, powerOf(other), readSpeed(ball), readSpeed(other));
	if (amounts.drain <= 0 || amounts.gain <= 0) {
		return;
	}

	state.lastCollisionAt = now;

	other.SetAttribute(BALL_SPEED_ATTRIBUTE, math.max(BALL_SPEED_MIN, readSpeed(other) - amounts.drain));
	ball.SetAttribute(BALL_SPEED_ATTRIBUTE, math.min(BALL_SPEED_MAX, readSpeed(ball) + amounts.gain));
}

// #endregion

// #region the badge

/**
 * The floating power name above a ball.
 *
 * ## Why this is created on the server and is not a controller
 *
 * It has no `CFrame` to pose and no per-frame work: a `BillboardGui` parented to the body is a world-space primitive the
 * engine poses itself, and replication delivers it to every client for free. A controller would have to enumerate balls,
 * track joins and leaves, and destroy badges — all of which `Destroy()` on the body already does.
 *
 * **It is outside the `getScreenGui(layer)` convention on purpose.** That convention governs *screen* layers, which are
 * `ScreenGui`s in `PlayerGui` with a display order; a world-space primitive has neither and must not be given one.
 *
 * ## Why the size is fixed
 *
 * `BillboardGui` has no `AutomaticSize` — verified against `@rbxts/types`, where `BillboardGui` extends `LayerCollector`
 * extends `GuiBase2d` and `AutomaticSize` is declared on `GuiObject`. The container therefore cannot widen for a longer
 * name, so it is sized once from `POWER_BADGE_WIDTH` (which `powers.config.ts` asserts against every label) with
 * `fromOffset` in both dimensions. `fromScale` in the fixed dimension would make the badge's apparent size track the
 * camera, which is the one thing a world-space label must not do.
 */
function updateBadge(ball: BasePart, power: string, radius: number): void {
	const existing = ball.FindFirstChild(POWER_BADGE_NAME);
	if (power === "") {
		if (existing !== undefined) {
			existing.Destroy();
		}
		return;
	}

	const label = existing !== undefined ? existing.FindFirstChildWhichIsA("TextLabel") : undefined;
	if (label !== undefined) {
		// A re-pick: same badge, new word. Rebuilding it would re-replicate a tree for one string.
		label.Text = powerLabel(power);
		return;
	}

	if (existing !== undefined) {
		existing.Destroy();
	}

	const badge = new Instance("BillboardGui");
	badge.Name = POWER_BADGE_NAME;
	badge.AlwaysOnTop = true;
	badge.Size = new UDim2(0, POWER_BADGE_WIDTH, 0, POWER_BADGE_HEIGHT);
	badge.MaxDistance = POWER_BADGE_MAX_DISTANCE;
	// Zero light influence and a fully transparent background so the badge is legible against the sky and against the
	// belt; the stroke below is what supplies the contrast, not a filled frame.
	badge.LightInfluence = 0;
	badge.Adornee = ball;
	// `StudsOffset` and not `StudsOffsetWorldSpace`: the former is measured in the camera's frame, so the badge stays
	// *above on screen* as the camera orbits, which is what a label wants. The world-space variant would slide to the side
	// at a low camera angle and read as attached to the wrong ball.
	badge.StudsOffset = new Vector3(0, radius + POWER_BADGE_OFFSET_STUDS, 0);

	const text = new Instance("TextLabel");
	text.Name = "Label";
	text.Size = new UDim2(1, 0, 1, 0);
	text.BackgroundTransparency = 1;
	text.Font = Enum.Font.GothamBold;
	text.TextSize = POWER_BADGE_TEXT_SIZE;
	text.TextScaled = false;
	text.TextColor3 = Color3.fromRGB(255, 255, 255);
	text.TextStrokeTransparency = 0.35;
	text.TextStrokeColor3 = Color3.fromRGB(0, 0, 0);
	text.Text = powerLabel(power);
	text.Parent = badge;

	badge.Parent = ball;
}

// #endregion

// #region the decoy

/**
 * **Placeholder.** How far to the side of its parent a `decoy` twin appears, in studs.
 *
 * Beside rather than on top: two 1-stud spheres created at the same position with `CanCollide` on are a penetration the
 * solver resolves by throwing both apart, which is a launch the power did not ask for. 2.5 studs clears the parent's
 * diameter with room to spare and stays inside a lane.
 */
export const DECOY_OFFSET_STUDS = 2.5;

/**
 * Whether a power spawns a decoy.
 *
 * Exported and pure so the "exactly one twin per `decoy` ball" rule is one predicate rather than a string comparison at
 * a call site. **The name stays `spawnsDecoy` while the power id is `decoy`:** the thing spawned is still a decoy in plain
 * English, and renaming it would make the power and its own spawn read as a tautology — `decoy` spawning a
 * `spawnDecoyedBody` says nothing the original pair did not.
 */
export function spawnsDecoy(power: string): boolean {
	return power === "decoy";
}

// #endregion
