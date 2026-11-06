import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_POOL, RARITIES, rarityOfBall } from "shared/economy.config";
import { hasOwnerIdentity } from "shared/attributes";
import {
	definitionForPower,
	ECLIPSE_START_DELAY,
	ECLIPSE_WINDOW_SECONDS,
	POWERS,
	POWER_BADGE_GLYPH_WIDTH,
	POWER_BADGE_WIDTH,
	POWER_IDS,
	powerForBallId,
	powerLabel,
	powerLabelFits,
	ROCKET_MAX_DELAY,
	ROCKET_MIN_DELAY,
	ROCKET_TARGET_SPEED,
	SPRINTER_BOOST_SPEED,
} from "shared/powers.config";
import { BALL_SPEED_MAX, BALL_SPEED_DECAY_RATE, BALL_SPEED_MIN, BOOST_TARGET_BALL_SPEED } from "shared/tuning";
import {
	BALL_GROUP,
	collisionGroupFor,
	drawTimers,
	GHOST_GROUP,
	NO_TIMERS,
	onBallCollision,
	PowerAura,
	PowerTickInput,
	pickupDecision,
	powerTickDelta,
	setRoundActive,
	spawnsDecoy,
	speedAfterPickup,
	transferAmounts,
	windowOpen,
} from "../powers";

/**
 * The ten powers' rules, over plain tables.
 *
 * ## Why every one of these is a function of numbers rather than of instances
 *
 * `BallSpawnerService` rewrites a ball's velocity from `BALL_SPEED` every tick, so a power is a number, a multiplier or a
 * collision group — and a number is testable without a `BasePart`. `powers` is a module rather than a `@Service()` for
 * exactly this reason: a service is constructed by `Flamework.ignite()` against a DataModel, so ten powers living inside
 * one would be ten rules nobody could assert.
 *
 * **What this cannot prove:** the badge's appearance and apparent size, whether `PhysicsService` actually honours the two
 * groups on a real place, the felt effect of any magnitude, and that a body destroyed mid-round really loses its state
 * entry (that one needs an instance; it is a source read in the round report). Those are Studio observations.
 */

/** Everything a test may override; every field optional so each test states only what it is about. */
interface TickOverrides {
	power?: string;
	roundActive?: boolean;
	speed?: number;
	dt?: number;
	elapsed?: number;
	timers?: PowerTickInput["timers"];
	auras?: ReadonlyArray<PowerAura>;
}

/** A context with nothing interesting in it; each test overrides only the field it is about. */
function tick(overrides: TickOverrides): PowerTickInput {
	return {
		power: overrides.power ?? "",
		roundActive: overrides.roundActive ?? true,
		speed: overrides.speed ?? 10,
		dt: overrides.dt ?? 1 / 60,
		elapsed: overrides.elapsed ?? 0,
		timers: overrides.timers ?? NO_TIMERS,
		auras: overrides.auras ?? [],
	};
}

function aura(power: string, distance: number, eclipsing = false): PowerAura {
	return { power, distance, eclipsing };
}

describe("powerTickDelta", () => {
	it("returns zero for a body with no power", () => {
		expect(powerTickDelta(tick({ power: "" })).delta).toBe(0);
	});

	it("returns zero for every ball outside Playing", () => {
		const outside = powerTickDelta(
			tick({
				power: "rocket",
				roundActive: false,
				elapsed: 100,
				timers: { ...NO_TIMERS, rocketAt: 3 },
			}),
		);
		expect(outside.delta).toBe(0);
		expect(outside.rocketFired).toBe(false);

		expect(
			powerTickDelta(tick({ power: "magnet", roundActive: false, auras: [aura("eclipse", 0, true)] })).delta,
		).toBe(0);
	});

	it("does nothing for a rocket before its drawn moment", () => {
		const result = powerTickDelta(tick({ power: "rocket", elapsed: 2.9, timers: { ...NO_TIMERS, rocketAt: 3 } }));
		expect(result.delta).toBe(0);
		expect(result.rocketFired).toBe(false);
	});

	it("snaps a rocket to ROCKET_TARGET_SPEED at its drawn moment", () => {
		const result = powerTickDelta(
			tick({ power: "rocket", speed: 7.5, elapsed: 3, timers: { ...NO_TIMERS, rocketAt: 3 } }),
		);
		expect(result.delta).toBe(ROCKET_TARGET_SPEED - 7.5);
		expect(result.rocketFired).toBe(true);
	});

	it("fires a rocket exactly once", () => {
		const fired = powerTickDelta(
			tick({ power: "rocket", elapsed: 9, timers: { ...NO_TIMERS, rocketAt: 3, rocketFired: true } }),
		);
		expect(fired.delta).toBe(0);
		expect(fired.rocketFired).toBe(false);
	});

	it("decays an opponent inside a magnet aura faster than one outside it", () => {
		const inside = powerTickDelta(tick({ power: "bully", auras: [aura("magnet", 2)] }));
		const outside = powerTickDelta(tick({ power: "bully", auras: [aura("magnet", 40)] }));

		expect(inside.delta < 0).toBe(true);
		expect(outside.delta).toBe(0);
	});

	it("decays every opponent while an eclipse window is open, and nothing outside it", () => {
		const open = powerTickDelta(tick({ power: "bully", auras: [aura("eclipse", 40, true)] }));
		const closed = powerTickDelta(tick({ power: "bully", auras: [aura("eclipse", 40, false)] }));

		expect(open.delta < 0).toBe(true);
		expect(closed.delta).toBe(0);
	});

	it("leaves an eclipse ball's own window out of its own decay, and applies another eclipse's", () => {
		// The wrapper never puts a ball in its own aura list, so the only eclipse an eclipse ball can feel is another's —
		// which is what "every opponent's decay is multiplied" means, and why the rule exempts by identity rather than by name.
		expect(powerTickDelta(tick({ power: "eclipse", auras: [] })).delta).toBe(0);
		expect(powerTickDelta(tick({ power: "eclipse", auras: [aura("eclipse", 5, true)] })).delta < 0).toBe(true);
	});

	it("costs an eclipse victim more than a magnet victim", () => {
		const magnet = powerTickDelta(tick({ power: "bully", auras: [aura("magnet", 1)] })).delta;
		const eclipse = powerTickDelta(tick({ power: "bully", auras: [aura("eclipse", 1, true)] })).delta;

		expect(eclipse < magnet).toBe(true);
	});

	it("does not stack two magnets", () => {
		const one = powerTickDelta(tick({ power: "bully", auras: [aura("magnet", 1)] })).delta;
		const two = powerTickDelta(tick({ power: "bully", auras: [aura("magnet", 1), aura("magnet", 2)] })).delta;

		expect(two).toBe(one);
	});

	it("returns zero for a passive or collision power with no aura in range", () => {
		expect(powerTickDelta(tick({ power: "bouncy" })).delta).toBe(0);
		expect(powerTickDelta(tick({ power: "heavy" })).delta).toBe(0);
		expect(powerTickDelta(tick({ power: "ghost" })).delta).toBe(0);
	});
});

describe("drawTimers", () => {
	it("draws a rocket's moment inside the configured band", () => {
		const low = drawTimers("rocket", () => 0);
		const high = drawTimers("rocket", (min, max) => max);

		expect(low.rocketAt).toBe(ROCKET_MIN_DELAY);
		expect(high.rocketAt).toBe(ROCKET_MAX_DELAY);
		expect(low.rocketFired).toBe(false);
	});

	it("gives a non-rocket no rocket at all", () => {
		expect(drawTimers("bully", () => 0).rocketAt).toBe(-1);
	});

	it("closes an eclipse window after ECLIPSE_WINDOW_SECONDS", () => {
		const timers = drawTimers("eclipse", () => 0);

		expect(windowOpen(timers, ECLIPSE_START_DELAY - 0.1)).toBe(false);
		expect(windowOpen(timers, ECLIPSE_START_DELAY)).toBe(true);
		expect(windowOpen(timers, ECLIPSE_START_DELAY + ECLIPSE_WINDOW_SECONDS)).toBe(false);
	});

	it("never opens a window for a non-eclipse ball", () => {
		expect(
			windowOpen(
				drawTimers("rocket", () => 0),
				1e6,
			),
		).toBe(false);
	});
});

describe("transferAmounts", () => {
	it("makes bully a pure transfer: the victim loses exactly what the attacker gains", () => {
		const amounts = transferAmounts("bully", "bully", 10, 10);

		expect(amounts.drain > 0).toBe(true);
		expect(amounts.gain).toBe(amounts.drain);
	});

	it("makes heavy keep less than it drains", () => {
		const amounts = transferAmounts("heavy", "bully", 10, 10);

		expect(amounts.drain > 0).toBe(true);
		expect(amounts.gain < amounts.drain).toBe(true);
	});

	it("makes heavy lose less than a bully loses to the same contact", () => {
		const againstBully = transferAmounts("bully", "bully", 10, 10);
		const againstHeavy = transferAmounts("bully", "heavy", 10, 10);

		expect(againstHeavy.drain < againstBully.drain).toBe(true);
	});

	it("converges: a third contact moves strictly less than the first", () => {
		let victim = 10;
		let attacker = 10;

		const first = transferAmounts("bully", "bully", attacker, victim);
		victim -= first.drain;
		attacker += first.gain;

		const second = transferAmounts("bully", "bully", attacker, victim);
		victim -= second.drain;
		attacker += second.gain;

		const third = transferAmounts("bully", "bully", attacker, victim);

		expect(second.drain < first.drain).toBe(true);
		expect(third.drain < first.drain).toBe(true);
	});

	it("never drains a victim below the floor", () => {
		const amounts = transferAmounts("heavy", "bully", 10, BALL_SPEED_MIN);

		expect(amounts.drain).toBe(0);
		expect(amounts.gain).toBe(0);
	});

	it("never pushes an attacker above the ceiling", () => {
		let attacker = BALL_SPEED_MAX - 0.01;
		let victim = 10;

		for (let contact = 0; contact < 50; contact++) {
			const amounts = transferAmounts("bully", "bully", attacker, victim);
			attacker = math.min(BALL_SPEED_MAX, attacker + amounts.gain);
			victim = math.max(BALL_SPEED_MIN, victim - amounts.drain);
		}

		expect(attacker <= BALL_SPEED_MAX).toBe(true);
		expect(attacker).toBe(BALL_SPEED_MAX);
	});
});

describe("pickupDecision", () => {
	it("leaves the pickup in play for a recycle ball, and destroys it for every other ball", () => {
		// **`recycle` is the single deliberate exception.** Its pad is the resource: the power is "keep the pad in play for
		// the next taker", so destroying it on contact would delete the whole mechanic. Every other power — and a body with
		// no power at all — must destroy the pad, because a pad that survives a collection re-fires `Touched` on the ball
		// resting on it and the boost is re-applied every frame, which is the 71-second parked ball of item 76.
		expect(pickupDecision("recycle").consume).toBe(false);

		for (const definition of POWERS) {
			if (definition.powerId !== "recycle") {
				expect(pickupDecision(definition.powerId).consume).toBe(true);
			}
		}

		expect(pickupDecision("").consume).toBe(true);
		expect(pickupDecision("not-a-power").consume).toBe(true);
	});

	it("gives a recycle ball the standard boost, so a surviving pad is worth what a spent one was", () => {
		expect(pickupDecision("recycle").boost).toBe(BOOST_TARGET_BALL_SPEED);
	});

	it("gives a sprinter a bigger boost than every other ball, and everything else the standard value", () => {
		expect(pickupDecision("sprinter").boost).toBe(SPRINTER_BOOST_SPEED);
		expect(SPRINTER_BOOST_SPEED > BOOST_TARGET_BALL_SPEED).toBe(true);

		for (const definition of POWERS) {
			if (definition.powerId !== "sprinter") {
				expect(pickupDecision(definition.powerId).boost).toBe(BOOST_TARGET_BALL_SPEED);
			}
		}

		expect(pickupDecision("").boost).toBe(BOOST_TARGET_BALL_SPEED);
	});

	it("treats a body with no power exactly like a plain one", () => {
		expect(pickupDecision("")).toEqual(pickupDecision("bully"));
	});
});

describe("the collision phase gate", () => {
	/**
	 * A body-shaped value whose only method counts its calls.
	 *
	 * `onBallCollision` with the gate closed must return **before** it touches the instance in any way, so a fake that
	 * records the tag test is enough to prove it — and it is the only way to assert this without a real `BasePart`, which
	 * the spec runtime cannot make.
	 *
	 * **The `false` below carries more weight since item 87.** The tag gate is now followed by the last-touch record,
	 * which reads `OwnerUserId` off both bodies, so a fake that returned `true` here would need `GetAttribute` as well.
	 * These two tests are about *where the handler stops*, not about how far it can go, and a fake that answered `true`
	 * would be asserting the second thing by accident.
	 */
	function countingBody(counter: { calls: number }): BasePart {
		const fake = {
			HasTag: () => {
				counter.calls++;
				return false;
			},
		};

		return fake as unknown as BasePart;
	}

	it("refuses a collision outside Playing, before it reads anything about the body", () => {
		// **The gate exists because `setRoundActive(false)` leaves the per-ball state — and `lastCollisionAt` — alive.**
		// Before this, a bully whose body was still touching another during `PostGame` ran the transfer machinery, and the
		// only thing that made it harmless was that every speed had just been zeroed and the drain is proportional. The
		// round is over; nothing here should be deciding anything, and no cooldown should be stamped for the next one.
		const closed = { calls: 0 };
		const body = countingBody(closed);

		setRoundActive(false);
		onBallCollision(body, body);

		expect(closed.calls).toBe(0);
	});

	it("lets the handler through once the round is live again", () => {
		// The same fake, the flag flipped: the handler now reaches its tag test, which is the first line past the gate. This
		// is what distinguishes "the gate works" from "the handler never does anything".
		const open = { calls: 0 };
		const body = countingBody(open);

		setRoundActive(true);
		onBallCollision(body, body);

		expect(open.calls).toBe(1);
	});
});

describe("speedAfterPickup", () => {
	it("raises a slower ball to the boost and leaves a faster one alone", () => {
		expect(speedAfterPickup(4, BOOST_TARGET_BALL_SPEED)).toBe(BOOST_TARGET_BALL_SPEED);
		expect(speedAfterPickup(BOOST_TARGET_BALL_SPEED, BOOST_TARGET_BALL_SPEED)).toBe(BOOST_TARGET_BALL_SPEED);

		// A sprinter that has just left a standard pad is faster than it; a pickup must never slow a ball down.
		expect(speedAfterPickup(SPRINTER_BOOST_SPEED, BOOST_TARGET_BALL_SPEED)).toBe(SPRINTER_BOOST_SPEED);
	});

	it("is idempotent on the value: one touch and two touches leave the same BALL_SPEED", () => {
		/*
		 * **This is not the consume rule restated**, and since item 80 it is load-bearing rather than defensive: a
		 * `recycle` ball leaves its pad in the world, so a second touch genuinely happens and this is the arithmetic that
		 * keeps it harmless. A ball parked on a surviving pad is raised to the boost once; every later touch computes the
		 * same value and the service writes nothing, so the ball still decays off the belt on schedule.
		 *
		 * The property is asserted over every power, not only `recycle`, because the identity is what the value rule
		 * guarantees — the consume rule and this one protect against different failures, and only this one is arithmetic.
		 */
		for (const definition of POWERS) {
			const boost = pickupDecision(definition.powerId).boost;

			const once = speedAfterPickup(4, boost);
			const twice = speedAfterPickup(once, boost);

			expect(twice).toBe(once);

			// The reusability case stated directly: a recycle ball takes its own surviving pad twice and is not topped up
			// a second time above what the first collection gave it.
			const recycleBoost = pickupDecision("recycle").boost;
			expect(speedAfterPickup(speedAfterPickup(4, recycleBoost), recycleBoost)).toBe(
				speedAfterPickup(4, recycleBoost),
			);

			// And once more from a ball that started above the pad, so the identity does not depend on the first application
			// having changed anything.
			const already = SPRINTER_BOOST_SPEED;
			expect(speedAfterPickup(speedAfterPickup(already, boost), boost)).toBe(speedAfterPickup(already, boost));
		}
	});
});

describe("collision groups", () => {
	it("puts a ghost in its own group and everything else in the shared ball group", () => {
		expect(collisionGroupFor("ghost")).toBe(GHOST_GROUP);
		expect(collisionGroupFor("bully")).toBe(BALL_GROUP);
		expect(collisionGroupFor("")).toBe(BALL_GROUP);
	});

	it("uses two distinct names, neither of them the engine's default", () => {
		expect(BALL_GROUP !== GHOST_GROUP).toBe(true);
		expect(BALL_GROUP === "Default").toBe(false);
		expect(GHOST_GROUP === "Default").toBe(false);
	});
});

describe("the decoy twin", () => {
	it("spawns a twin only for a decoy ball", () => {
		expect(spawnsDecoy("decoy")).toBe(true);

		for (const definition of POWERS) {
			if (definition.powerId !== "decoy") {
				expect(spawnsDecoy(definition.powerId)).toBe(false);
			}
		}
	});

	it("is an orphan: no owner attributes means no competitor", () => {
		// What a decoy writes: nothing. What a competitor writes: both.
		expect(hasOwnerIdentity(undefined, undefined)).toBe(false);
		expect(hasOwnerIdentity(-1, "Debug#1")).toBe(true);

		// A half-written pair is not an owner either, which is what keeps a decoy from ever reading as a competitor whose
		// identity is unknowable.
		expect(hasOwnerIdentity(1, undefined)).toBe(false);
		expect(hasOwnerIdentity(undefined, "One")).toBe(false);
	});
});

describe("the power table", () => {
	it("maps every ball id to exactly one power", () => {
		expect(POWERS.size()).toBe(10);

		const ballIds = new Set<string>();
		const powerIds = new Set<string>();

		for (const definition of POWERS) {
			expect(ballIds.has(definition.ballId)).toBe(false);
			expect(powerIds.has(definition.powerId)).toBe(false);
			ballIds.add(definition.ballId);
			powerIds.add(definition.powerId);

			expect(powerForBallId(definition.ballId)).toBe(definition.powerId);
			expect(definitionForPower(definition.powerId)?.ballId).toBe(definition.ballId);
		}
	});

	it("answers undefined for a ball this build does not know", () => {
		expect(powerForBallId("not_a_ball")).toBe(undefined);
		expect(definitionForPower("not-a-power")).toBe(undefined);
	});

	it("covers every id in POWER_IDS, every ball in BALL_POOL, and nothing outside it", () => {
		const byPower = new Set<string>();
		for (const definition of POWERS) {
			byPower.add(definition.powerId);
		}

		// `POWER_IDS` is the declared set of powers; the table has to describe all of them, or an id exists that no ball
		// can ever carry.
		for (const powerId of POWER_IDS) {
			expect(byPower.has(powerId)).toBe(true);
		}

		// And the other direction, which is the one a player would notice: a ball in the chest pool that no power answers
		// for would be a ball that behaves like every other ball, which is the defect this round exists to remove.
		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				expect(powerForBallId(ballId) !== undefined).toBe(true);
			}
		}

		// The third direction: a row naming a ball the pool does not have. A renamed id would otherwise leave an orphan
		// entry here that resolves to nothing and reads as configuration — the same class of failure `ball-tables.spec.ts`
		// catches for models.
		for (const definition of POWERS) {
			expect(rarityOfBall(definition.ballId) !== undefined).toBe(true);
		}
	});

	it("shows the label in one casing, uppercase", () => {
		expect(powerLabel("bully")).toBe("BULLY");
		expect(powerLabel("sprinter")).toBe("SPRINTER");
	});

	it("fits every label inside the badge width", () => {
		let longest = 0;

		for (const definition of POWERS) {
			expect(powerLabelFits(definition.powerId)).toBe(true);
			longest = math.max(longest, powerLabel(definition.powerId).size());
		}

		// The other direction, so the loop above is not vacuous: the width is sized for the longest label *with slack*, not
		// for any name at all. Four glyphs beyond the longest already overflow it, which is what makes `powerLabelFits` a
		// real assertion rather than a comparison against a number nobody could exceed.
		expect((longest + 4) * POWER_BADGE_GLYPH_WIDTH > POWER_BADGE_WIDTH).toBe(true);
	});
});

describe("the model's bounds", () => {
	it("has a ceiling above every designed value", () => {
		expect(BALL_SPEED_MAX > ROCKET_TARGET_SPEED).toBe(true);
		expect(BALL_SPEED_MAX > SPRINTER_BOOST_SPEED).toBe(true);
		expect(BALL_SPEED_MAX > BOOST_TARGET_BALL_SPEED).toBe(true);
		expect(BALL_SPEED_MAX > BALL_SPEED_MIN).toBe(true);
	});

	it("decays at the rate the exchange arithmetic is reported against", () => {
		// One point of BALL_SPEED is 1 / 0.3 = 3.3 seconds of ride; the report quotes magnitudes in those terms, so the
		// rate itself is asserted here rather than quoted in prose only.
		expect(BALL_SPEED_DECAY_RATE).toBe(0.3);
	});
});
