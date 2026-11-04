import { describe, expect, it } from "@rbxts/jest-globals";
import { profileKeyFor, STUDIO_KEY_SUFFIX } from "../services/player-data-store";

/**
 * The profile key, and the one decision inside it: which namespace a server writes to.
 *
 * ## Why this is tested at all
 *
 * The key is a compatibility contract with data already on disk. A key that formats differently does not fail — it
 * *misses*, and a miss is a fresh profile, so the failure is silent and looks like "the wipe bug again". The live branch
 * is asserted character for character for that reason, and the Studio branch is asserted to differ from it, because two
 * namespaces that collide are worse than one.
 *
 * ## What this cannot reach
 *
 * `profileKeyFor` takes `studio` as a parameter, so these assertions are about the mapping, not about the wiring. That
 * `RunService.IsStudio()` returns `true` in a playtest and `false` on a live server is an engine fact, and the live half
 * of it cannot be observed without a published place. `profileKey` — the one caller that reads the flag — is a
 * one-line function and is checked by reading it.
 */

/** The id used throughout, so the expected strings below are literal rather than assembled. */
const USER_ID = 41354175;

describe("profileKeyFor", () => {
	it("builds the shipped key when not in Studio", () => {
		// **Pinned deliberately.** This is the exact string every stored profile lives under; a change here is a silent
		// wipe of live data, so the assertion is meant to fail loudly rather than follow a constant around.
		expect(profileKeyFor(USER_ID, false)).toBe("Player_41354175");
	});

	it("builds a suffixed key in Studio", () => {
		expect(profileKeyFor(USER_ID, true)).toBe("Player_41354175_Dev");
	});

	it("never collides the two namespaces", () => {
		// Two namespaces that resolved to one key would put a playtest's grants into a live profile — the exact bug the
		// suffix exists to prevent — while both branches still "looked" correct in isolation.
		expect(profileKeyFor(USER_ID, true) !== profileKeyFor(USER_ID, false)).toBe(true);
	});

	it("appends the suffix, never prefixes or replaces the id", () => {
		const studio = profileKeyFor(USER_ID, true);

		expect(studio.sub(1, "Player_".size())).toBe("Player_");
		expect(studio.sub(-STUDIO_KEY_SUFFIX.size())).toBe(STUDIO_KEY_SUFFIX);
	});

	it("keeps the id in the middle of both forms", () => {
		// `tostring` on an integer id, not interpolation: the live key must stay byte-identical to what earlier builds
		// wrote, and a decimal or an exponent would produce a different key for the same player.
		expect(profileKeyFor(USER_ID, false).find("41354175")[0] !== undefined).toBe(true);
		expect(profileKeyFor(USER_ID, true).find("41354175")[0] !== undefined).toBe(true);
	});

	it("gives two players two different keys", () => {
		expect(profileKeyFor(1, true) !== profileKeyFor(2, true)).toBe(true);
		expect(profileKeyFor(1, false) !== profileKeyFor(2, false)).toBe(true);
	});
});
