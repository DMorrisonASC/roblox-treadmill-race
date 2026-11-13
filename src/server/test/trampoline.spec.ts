import { describe, expect, it } from "@rbxts/jest-globals";
import { canBounce } from "../trampoline";
import { TRAMPOLINE_BOUNCE_VELOCITY, TRAMPOLINE_COOLDOWN_SECONDS } from "shared/tuning";

/**
 * The trampoline's one rule, tested away from the engine.
 *
 * ## Why the gate is a module and not a line in the service
 *
 * Same argument as `round-outcome`, `competitor-slots` and `elimination-signal`: a service cannot be constructed in Jest - it
 * needs `CollectionService`, `Touched` and a `Player` - so a rule written inside one can only be checked by a playtest. The
 * guard is arithmetic, and arithmetic belongs where it can be asserted against literals.
 *
 * ## The last two cases are item 231's regression
 *
 * The guard used to be longer than the airtime the launch produces, which refused the *landing* contact - the one that should
 * always bounce - and left the character standing on the pad until something happened to re-touch it. Those two cases pin the
 * relationship rather than the numbers: **short enough to accept a landing, long enough to collapse one landing's burst of
 * contacts.**
 */

/** `Workspace.Gravity`'s default, which every trampoline docblock's arithmetic assumes. Jest has no `Workspace`. */
const GRAVITY = 196.2;

describe("canBounce", () => {
	const COOLDOWN = 0.3;

	// The base is `0` rather than a realistic `os.clock()` reading on purpose: `100 + 0.3 - 100` is `0.29999999999999716`
	// in doubles, so a boundary case written at a large base would be asserting the float error rather than the comparison.
	const LAST = 0;

	it("allows the first bounce, when nothing is recorded yet", () => {
		expect(canBounce(undefined, 100, COOLDOWN)).toBe(true);
	});

	it("refuses a bounce just inside the guard", () => {
		expect(canBounce(LAST, LAST + COOLDOWN - 0.001, COOLDOWN)).toBe(false);
	});

	it("allows a bounce exactly at the guard boundary", () => {
		// `>=` rather than `>`: the boundary is a moment the player has waited the whole guard, and refusing it would make
		// the usable interval depend on a float comparison nobody can observe.
		expect(canBounce(LAST, LAST + COOLDOWN, COOLDOWN)).toBe(true);
	});

	it("allows a bounce past the guard", () => {
		expect(canBounce(LAST, LAST + COOLDOWN + 0.001, COOLDOWN)).toBe(true);
	});

	it("accepts the landing contact a full airtime after the launch", () => {
		// The bug: a guard longer than this refuses the character's own landing, and a character standing still on a part
		// produces no further contact to retry with.
		const airtime = (2 * TRAMPOLINE_BOUNCE_VELOCITY) / GRAVITY;

		expect(airtime).toBeGreaterThan(TRAMPOLINE_COOLDOWN_SECONDS);
		expect(canBounce(0, airtime, TRAMPOLINE_COOLDOWN_SECONDS)).toBe(true);
	});

	it("collapses the burst of contacts one landing produces", () => {
		// `Touched` fires repeatedly while a character rests on a part; three physics steps of the same landing is one bounce.
		const step = 1 / 60;

		expect(canBounce(0, step, TRAMPOLINE_COOLDOWN_SECONDS)).toBe(false);
		expect(canBounce(0, 3 * step, TRAMPOLINE_COOLDOWN_SECONDS)).toBe(false);
	});
});
