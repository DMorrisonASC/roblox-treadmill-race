import { describe, expect, it } from "@rbxts/jest-globals";
import {
	ghostActiveAt,
	GHOST_ACTIVE_SECONDS,
	GHOST_BREAK_SECONDS,
	GHOST_CYCLE_ENABLED,
	GHOST_CYCLE_SECONDS,
	GHOST_TRANSPARENCY_WHILE_ACTIVE,
} from "./ghost.config";

/**
 * The ghost's cycle, as arithmetic.
 *
 * What this can prove: the phase boundaries, that the cycle repeats, and that the derived cycle length is the sum of its two
 * halves. What it cannot prove is whether a 10/15 split is *legible* at the game camera, or whether a half-transparent skin
 * reads as "intangible" rather than as "spawning in" - those are Studio observations.
 */
describe("the ghost cycle", () => {
	it("derives the cycle from its two halves rather than authoring a third number", () => {
		expect(GHOST_CYCLE_SECONDS).toBe(GHOST_ACTIVE_SECONDS + GHOST_BREAK_SECONDS);
		expect(GHOST_ACTIVE_SECONDS > 0).toBe(true);
		expect(GHOST_BREAK_SECONDS > 0).toBe(true);
	});

	it("is intangible for the first window and solid for the break after it", () => {
		expect(ghostActiveAt(0)).toBe(true);
		expect(ghostActiveAt(GHOST_ACTIVE_SECONDS - 0.001)).toBe(true);
		// The boundary itself belongs to the break: at exactly `ACTIVE` the ball is solid, which is the half-open interval a
		// viewer can predict from the numbers printed in the docblock.
		expect(ghostActiveAt(GHOST_ACTIVE_SECONDS)).toBe(false);
		expect(ghostActiveAt(GHOST_CYCLE_SECONDS - 0.001)).toBe(false);
	});

	it("repeats, with the wrap landing back in the active window", () => {
		expect(ghostActiveAt(GHOST_CYCLE_SECONDS)).toBe(true);
		expect(ghostActiveAt(GHOST_CYCLE_SECONDS + 1)).toBe(true);
		expect(ghostActiveAt(GHOST_CYCLE_SECONDS + GHOST_ACTIVE_SECONDS)).toBe(false);
		// Two full cycles plus a second: the phase is a function of time modulo the cycle, not of how many cycles have passed.
		expect(ghostActiveAt(GHOST_CYCLE_SECONDS * 2 + 1)).toBe(ghostActiveAt(1));
	});

	it("treats a pre-clock body as being in the first active window", () => {
		// A body ticked before `Playing` stamps the clock reads a negative elapsed; it must not be wrapped into the break.
		expect(ghostActiveAt(-1)).toBe(true);
		expect(ghostActiveAt(-1e6)).toBe(true);
	});

	it("ships an enabled cycle and a half-transparent skin", () => {
		// Both are **Placeholder.** designers' values, asserted so a silent flip of either is visible: the switch because a
		// disabled cycle reverts the power to the permanent immunity it used to have, the transparency because `1` would make
		// the intangible state invisible rather than uncanny.
		expect(GHOST_CYCLE_ENABLED).toBe(true);
		expect(GHOST_TRANSPARENCY_WHILE_ACTIVE > 0).toBe(true);
		expect(GHOST_TRANSPARENCY_WHILE_ACTIVE < 1).toBe(true);
	});
});
