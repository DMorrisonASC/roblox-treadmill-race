import { describe, expect, it } from "@rbxts/jest-globals";
import { PICKER_PHASE, pickerVisible } from "./picker";

/**
 * When the picker panel may be on screen (item 212).
 *
 * The panel used to be gated on the phase alone, which is a fact about the round rather than about the player looking at it. These
 * cases pin the two-fact rule: a client that joined during `Waiting` without being enrolled holds no offer, and must see nothing.
 */
describe("pickerVisible", () => {
	it("shows only in the offering phase, with an offer", () => {
		expect(pickerVisible(PICKER_PHASE, true)).toBe(true);
	});

	it("hides an empty panel in the offering phase", () => {
		// **The reported bug.** A client that joins during `Waiting` is not enrolled, so `openOffers` never sends it an offer. The
		// phase-only condition drew it a panel with a countdown and no cards, which reads as "pick a ball" and offers nothing.
		expect(pickerVisible(PICKER_PHASE, false)).toBe(false);
	});

	it("hides a stale offer outside the offering phase", () => {
		// The other direction: an offer that outlived its window must not keep the panel up through `Playing`. Both callers drop the
		// offer on a phase change, and this is the rule that makes that belt-and-braces rather than load-bearing.
		for (const phase of ["Intermission", "Playing", "PostGame", ""]) {
			expect(pickerVisible(phase, true)).toBe(false);
		}
	});

	it("hides for an unknown phase even though the offer may exist", () => {
		// A phase this build has never heard of is not `Waiting`, and the complement rule is the safe direction: no panel.
		expect(pickerVisible("waiting", true)).toBe(false);
		expect(pickerVisible("unknown", true)).toBe(false);
	});
});
