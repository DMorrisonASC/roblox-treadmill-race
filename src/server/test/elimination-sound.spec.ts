import { describe, expect, it } from "@rbxts/jest-globals";
import { shouldPlayEliminationSound, shouldRecordTouch } from "../elimination-sound";

/**
 * Who hears the elimination sound.
 *
 * ## Why this is worth a spec
 *
 * The rule decides between "the attacker hears it", "nobody hears it" and "everybody hears it", and the two failures are
 * silent in opposite directions: a rule that is too loose turns the sound back into the broadcast it replaced, and a rule
 * that is too tight means the attacker never hears anything and the sound looks broken. Neither shows up in a Studio run
 * as an error — only as a sound that did or did not happen — so the rule is pinned here.
 *
 * ## What this cannot prove
 *
 * That the toucher is read *before* the eliminated body and the toucher are destroyed. A destroyed instance returns its
 * default attribute values, which would look like a body with no owner and correctly-but-wrongly produce `undefined`.
 * That ordering is a source read of `settleEliminations`, `handleExternalDestruction` and `destroyBall`.
 */

describe("shouldRecordTouch", () => {
	it("records a touch between two owned bodies", () => {
		// The ordinary case: two competing players' balls in contact.
		expect(shouldRecordTouch(41354175, 2778123)).toBe(true);
	});

	it("records a touch a player makes on their own body", () => {
		// Self contact is still a record. Whether the elimination is *caused* by a body is a different question, and the
		// play rule compares ids, so a self-touch resolving to "the same player hears it" is correct rather than special.
		expect(shouldRecordTouch(41354175, 41354175)).toBe(true);
	});

	it("ignores a touch involving a decoy", () => {
		// A decoy carries no `OwnerUserId` at all, in either direction. Without this the map fills with every contact a
		// decoy ever makes and every entry of it is unanswerable.
		expect(shouldRecordTouch(undefined, 41354175)).toBe(false);
		expect(shouldRecordTouch(41354175, undefined)).toBe(false);
		expect(shouldRecordTouch(undefined, undefined)).toBe(false);
	});

	it("ignores a touch involving a synthetic competitor", () => {
		// `Debug#N` bodies carry negative ids: there is no player to credit and no client to play to.
		expect(shouldRecordTouch(-1, 41354175)).toBe(false);
		expect(shouldRecordTouch(41354175, -4)).toBe(false);
	});

	it("ignores a zero id", () => {
		// The boundary: a destroyed body's attribute reads as `0`, not as `nil`. A late read must fail closed.
		expect(shouldRecordTouch(0, 41354175)).toBe(false);
		expect(shouldRecordTouch(41354175, 0)).toBe(false);
	});
});

describe("shouldPlayEliminationSound", () => {
	it("plays for the player whose ball landed the last touch", () => {
		// Criterion 3: the attacker hears it, and only them.
		expect(shouldPlayEliminationSound(41354175, 41354175)).toBe(true);
	});

	it("stays silent when a different player's ball did the touching", () => {
		// The victim's own client is told by the splash. If this returned true here, the attacker's cue and the "you are
		// out" cue would arrive as the same sound on the victim's client.
		expect(shouldPlayEliminationSound(41354175, 2778123)).toBe(false);
	});

	it("stays silent when nothing touched the body", () => {
		// A body that left the belt untouched is nobody's doing. Crediting the last contact from minutes ago would be a
		// kill sound for a kill that did not happen.
		expect(shouldPlayEliminationSound(41354175, undefined)).toBe(false);
	});

	it("stays silent for a synthetic competitor's body", () => {
		// Even with a real toucher: there is no client behind `Debug#N`, so there is nobody to play to.
		expect(shouldPlayEliminationSound(-1, 41354175)).toBe(false);
	});

	it("stays silent when the toucher is synthetic", () => {
		// A `Debug#N` body cannot be an attacker, and `shouldRecordTouch` would not have stored it anyway; this is the
		// read-side half of the same rule, so the two cannot drift.
		expect(shouldPlayEliminationSound(41354175, -1)).toBe(false);
	});

	it("stays silent for a zero id on either side", () => {
		// The destroyed-read boundary, on both arguments.
		expect(shouldPlayEliminationSound(0, 41354175)).toBe(false);
		expect(shouldPlayEliminationSound(41354175, 0)).toBe(false);
	});
});
