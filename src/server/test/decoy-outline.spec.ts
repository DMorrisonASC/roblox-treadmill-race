import { describe, expect, it } from "@rbxts/jest-globals";
import { DecoyOutlineFacts, decideDecoyOutline } from "../decoy-outline";

/**
 * Who may be told which body is their twin.
 *
 * ## What is actually at stake
 *
 * A `decoy_ball`'s twin is indistinguishable from a real body on purpose (item 77). The outline is the one piece of
 * information that breaks that, and it may only ever reach the owner — a spectator who could see it would have the whole
 * power given away. The answer therefore cannot be an attribute (attributes replicate to everyone), which is why the
 * client asks and the server answers one caller at a time, and why this decision has to be a named rule rather than four
 * `if`s inside a service that cannot be constructed in this runtime.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the *rule*: the four refusal reasons are distinct and each is reachable, and permission needs all of them to
 * pass. They cannot prove that the body handed back is the right one, or that the `Highlight` renders — those are a source
 * read and a Studio observation.
 */

/** The caller in every test below. */
const CALLER = 41354175;

/** Everything a test may vary; every field optional so each case states only what it is about. */
interface FactOverrides {
	phase?: string;
	/** `false` models a caller with no live body at all. Otherwise the body is the caller's unless `bodyOwnerUserId` says otherwise. */
	hasBody?: boolean;
	bodyOwnerUserId?: number;
	hasDecoy?: boolean;
	decoyOwnerUserId?: number;
}

/** Facts for a caller who owns a body with a twin, i.e. the one case that should be granted. */
function facts(overrides: FactOverrides): DecoyOutlineFacts {
	return {
		phase: overrides.phase ?? "Playing",
		callerUserId: CALLER,
		bodyOwnerUserId: overrides.hasBody === false ? undefined : (overrides.bodyOwnerUserId ?? CALLER),
		hasDecoy: overrides.hasDecoy ?? true,
		decoyOwnerUserId: overrides.decoyOwnerUserId,
	};
}

describe("decideDecoyOutline", () => {
	it("grants the owner of a body with a twin, during Playing", () => {
		expect(decideDecoyOutline(facts({}))).toEqual({ kind: "granted" });
	});

	it("refuses every phase other than Playing, with that reason", () => {
		for (const phase of ["Waiting", "PostGame", "Intermission"]) {
			const decision = decideDecoyOutline(facts({ phase }));
			expect(decision.kind).toBe("refused");
			if (decision.kind === "refused") {
				expect(decision.reason).toBe("wrong-phase");
			}
		}
	});

	it("refuses a caller with no live body", () => {
		const decision = decideDecoyOutline(facts({ hasBody: false }));

		expect(decision.kind).toBe("refused");
		if (decision.kind === "refused") {
			expect(decision.reason).toBe("no-body");
		}
	});

	it("refuses a body that is not the caller's, as no-body rather than as somebody else's", () => {
		// The search is by user id, so a mismatch means the body found is not theirs. From the caller's side that is
		// exactly "I have no body", and reporting a different id back would tell them a body exists that they do not own.
		const decision = decideDecoyOutline(facts({ bodyOwnerUserId: 999 }));

		expect(decision.kind).toBe("refused");
		if (decision.kind === "refused") {
			expect(decision.reason).toBe("no-body");
		}
	});

	it("refuses the owner of a body that is not a decoy ball", () => {
		const decision = decideDecoyOutline(facts({ hasDecoy: false }));

		expect(decision.kind).toBe("refused");
		if (decision.kind === "refused") {
			expect(decision.reason).toBe("no-decoy");
		}
	});

	it("refuses a twin that carries somebody else's OwnerUserId", () => {
		// Unreachable by design — a decoy must never carry `OwnerUserId`, because that is the field `getCompetitors()`
		// filters on — and guarded anyway: outlining another player's body would hand one player information about
		// another's ball, and a client cannot ask for it because the caller id comes from the connection, not the wire.
		const decision = decideDecoyOutline(facts({ decoyOwnerUserId: 1234 }));

		expect(decision.kind).toBe("refused");
		if (decision.kind === "refused") {
			expect(decision.reason).toBe("not-owner");
		}
	});

	it("grants only when all four conditions hold", () => {
		// Each single failure refuses, and the same facts with all of them fixed grant: the rule is a conjunction rather
		// than a first-match table that could be satisfied out of order.
		const broken: DecoyOutlineFacts[] = [
			facts({ phase: "Intermission" }),
			facts({ hasBody: false }),
			facts({ hasDecoy: false }),
			facts({ decoyOwnerUserId: 1 }),
		];

		for (const candidate of broken) {
			expect(decideDecoyOutline(candidate).kind).toBe("refused");
		}

		expect(decideDecoyOutline(facts({})).kind).toBe("granted");
	});

	it("reports the phase as the first reason, before anything about the body", () => {
		// A request outside `Playing` is a client that has not understood the round; saying "no decoy" there would send a
		// reader looking at the spawn path for a defect that is in the phase gate.
		const decision = decideDecoyOutline(facts({ phase: "PostGame", hasBody: false, hasDecoy: false }));

		expect(decision.kind).toBe("refused");
		if (decision.kind === "refused") {
			expect(decision.reason).toBe("wrong-phase");
		}
	});
});
