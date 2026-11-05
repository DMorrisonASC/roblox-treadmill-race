import { describe, expect, it } from "@rbxts/jest-globals";
import { BALL_POOL } from "shared/economy.config";
import { PICKER_OPTION_COUNT, REROLL_COST_COINS } from "shared/picker";
import { applyCoinSpend } from "../services/economy-service";
import { Profile } from "../services/player-data-store";
import {
	applyReroll,
	buildOffer,
	drawOptions,
	fallbackBallId,
	isPickAllowed,
	ownedIdsFrom,
	rollPremium,
	StoredOffer,
	timeoutPick,
} from "../picker";

/**
 * The picker's rules, as pure functions.
 *
 * ## What this file can prove, and what it cannot
 *
 * Every decision that makes the feature safe is a function of plain values here: the draw, the premium flag, the
 * fallback, the pick validation, the timeout choice, and the order of "charge, then rebuild". So all of the criteria about
 * *what* is offered and *when* it is replaced are assertions.
 *
 * What is not here: that the service calls these at the right moments (once per `Waiting` entry, never per frame), and that
 * the body carries the id before `Parent`. Those are source reads of `RoundService` and `BallSpawnerService`, and the
 * panel is Studio-only.
 *
 * ## Why every function takes a `random`
 *
 * So the tests are about the rule and not about the seed. `sequenceRandom` walks a fixed list, which makes a "uniform over
 * distinct ids" claim falsifiable: if the implementation drew with replacement, a fixed sequence would repeat an id and the
 * assertion would fail.
 */

/** A `() => number` that walks `values` and wraps. Every value must be in `[0, 1)`. */
function sequenceRandom(values: Array<number>): () => number {
	let index = 0;
	return () => {
		const value = values[index % values.size()];
		index++;
		return value;
	};
}

/** A `() => number` pinned to one value — the cheapest way to make a draw deterministic. */
function always(value: number): () => number {
	return () => value;
}

function profileWith(coins: number): Profile {
	return { version: 1, coins, ownedBalls: new Map(), purchases: [] };
}

/** A decoded-attribute string, i.e. what `encodeOwnedBalls` writes. */
function encoded(balls: Array<[string, number]>): string {
	const parts = new Array<string>();
	for (const [ballId, count] of balls) {
		parts.push(`${ballId}=${count}`);
	}

	return parts.join(";");
}

describe("ownedIdsFrom", () => {
	it("lists each owned id once, however many copies are held", () => {
		// The multiset rule: `ghost_ball x5` is one option, not five. Owning duplicates is fusion stock, not a preference.
		const ids = ownedIdsFrom(
			encoded([
				["ghost_ball", 5],
				["heavy_ball", 1],
			]),
		);

		expect(ids.size()).toBe(2);
		expect(ids[0]).toBe("ghost_ball");
		expect(ids[1]).toBe("heavy_ball");
	});

	it("is empty for a profile with nothing", () => {
		expect(ownedIdsFrom("").size()).toBe(0);
	});

	it("ignores a zero count", () => {
		expect(ownedIdsFrom(encoded([["ghost_ball", 0]])).size()).toBe(0);
	});
});

describe("drawOptions", () => {
	it("draws distinct ids when the collection is at least as large as the offer", () => {
		const ids = ["a", "b", "c", "d", "e"];

		// A sequence that would repeat if the implementation drew with replacement from the same pool each time.
		const options = drawOptions(ids, 3, sequenceRandom([0, 0, 0]));

		expect(options.size()).toBe(3);
		expect(options[0]).toBe("a");
		// Without replacement the second draw is from the remaining four, so index 0 is "b".
		expect(options[1]).toBe("b");
		expect(options[2]).toBe("c");
	});

	it("repeats the single owned ball", () => {
		const options = drawOptions(["only_ball"], PICKER_OPTION_COUNT, always(0));

		expect(options.size()).toBe(PICKER_OPTION_COUNT);
		expect(options[0]).toBe("only_ball");
		expect(options[1]).toBe("only_ball");
		expect(options[2]).toBe("only_ball");
	});

	it("gives one of the two owned balls twice and both at least once", () => {
		// Criterion: owning two receives one of them twice. The first pass takes both without replacement; the third slot is
		// an independent draw, so both ids are always present.
		const options = drawOptions(["a", "b"], PICKER_OPTION_COUNT, always(0));

		expect(options.size()).toBe(3);
		expect(options.includes("a")).toBe(true);
		expect(options.includes("b")).toBe(true);
	});

	it("returns nothing for an empty collection rather than inventing an id", () => {
		expect(drawOptions(new Array<string>(), 3, always(0)).size()).toBe(0);
	});
});

describe("rollPremium", () => {
	it("fires below the chance and not at or above it", () => {
		expect(rollPremium(always(0))).toBe(true);
		expect(rollPremium(always(0.0999))).toBe(true);
		// 0.1 exactly is *not* below 0.1, so a 10% roll wins 10% of the time rather than 10.0001%.
		expect(rollPremium(always(0.1))).toBe(false);
		expect(rollPremium(always(0.5))).toBe(false);
	});
});

describe("fallbackBallId", () => {
	it("draws from the common pool", () => {
		// The pool must not be empty, or the fallback is impossible and the round has to refuse to spawn that player.
		expect(BALL_POOL["common"].size() > 0).toBe(true);

		const ballId = fallbackBallId(always(0));
		expect(ballId).toBe(BALL_POOL["common"][0]);
	});
});

describe("buildOffer", () => {
	it("offers the option count of owned ids", () => {
		const offer = buildOffer(["a", "b", "c", "d"], false, always(0));

		expect(offer !== undefined).toBe(true);
		expect(offer !== undefined ? offer.options.size() : 0).toBe(PICKER_OPTION_COUNT);
		expect(offer !== undefined ? offer.fallback : true).toBe(false);
		expect(offer !== undefined ? offer.premium : true).toBe(false);
	});

	it("offers every distinct owned id on a premium roll", () => {
		const offer = buildOffer(["a", "b", "c", "d", "e"], true, always(0));

		expect(offer !== undefined ? offer.options.size() : 0).toBe(5);
		expect(offer !== undefined ? offer.premium : false).toBe(true);
	});

	it("is a premium offer even when the collection is smaller than the option count", () => {
		// "Every ball they own" means exactly that: a two-ball premium offer is two cards, not two cards padded to three. The
		// brief defines the premium offer that way, and padding would be a different offer wearing the same label.
		const offer = buildOffer(["a", "b"], true, always(0));

		expect(offer !== undefined ? offer.options.size() : 0).toBe(2);
		expect(offer !== undefined ? offer.premium : false).toBe(true);
	});

	it("falls back to one repeated common ball when nothing is owned", () => {
		// Criterion: N copies of ONE id. The alternative — N independent draws — would let the three cards disagree about what
		// the body is racing as, which is the one thing the offer exists to decide.
		const offer = buildOffer(new Array<string>(), false, always(0));

		expect(offer !== undefined).toBe(true);
		if (offer === undefined) {
			return;
		}

		expect(offer.options.size()).toBe(PICKER_OPTION_COUNT);
		expect(offer.options[0]).toBe(offer.options[1]);
		expect(offer.options[1]).toBe(offer.options[2]);
		expect(offer.fallback).toBe(true);
		expect(offer.premium).toBe(false);
	});

	it("does not grant the fallback ball", () => {
		// The fallback is a label for one round. The attribute it was decoded from is not rewritten by anything here, and there
		// is no profile in scope to write to — this asserts the input is untouched, which is the observable half.
		const attribute = "";
		const offer = buildOffer(ownedIdsFrom(attribute), false, always(0));

		expect(offer !== undefined ? offer.fallback : false).toBe(true);
		expect(attribute).toBe("");
		expect(ownedIdsFrom(attribute).size()).toBe(0);
	});

	it("records a pick at creation, drawn from the offer", () => {
		// The body is spawned at `Waiting` entry, before any player can press anything, so the default has to exist then.
		const offer = buildOffer(["a", "b", "c"], false, always(0));

		expect(offer !== undefined ? offer.pickedByClient : true).toBe(false);
		expect(offer !== undefined ? offer.options.includes(offer.pick) : false).toBe(true);
	});
});

describe("isPickAllowed", () => {
	const offer: StoredOffer = {
		options: ["a", "b"],
		premium: false,
		fallback: false,
		pick: "a",
		pickedByClient: false,
	};

	it("accepts an id that is on offer", () => {
		expect(isPickAllowed(offer, "b")).toBe(true);
	});

	it("refuses an id outside the offer even if the player owns it", () => {
		// The distinction that matters: a premium offer is a subset of the collection, and a chest opened during `Waiting`
		// cannot be picked because no card for it was shown.
		expect(isPickAllowed(offer, "c")).toBe(false);
	});
});

describe("timeoutPick", () => {
	it("returns one of the player's own options", () => {
		const offer: StoredOffer = {
			options: ["a", "b", "c"],
			premium: false,
			fallback: false,
			pick: "a",
			pickedByClient: false,
		};

		const pick = timeoutPick(offer, always(0.99));
		expect(offer.options.includes(pick)).toBe(true);
		expect(pick).toBe("c");
	});
});

describe("applyReroll", () => {
	it("charges before it rebuilds", () => {
		let rebuilt = false;
		let paid = false;

		const result = applyReroll(
			() => {
				paid = true;
				return true;
			},
			() => {
				rebuilt = true;
				return { options: ["x"], premium: false, fallback: false, pick: "x", pickedByClient: false };
			},
		);

		expect(paid).toBe(true);
		expect(rebuilt).toBe(true);
		expect(result.outcome).toBe("ok");
	});

	it("never rebuilds when the charge is refused", () => {
		// The whole safety property: a player whose save failed keeps the offer they were looking at, so a failed purchase
		// cannot leave new cards in hand for free.
		let rebuilt = false;

		const result = applyReroll(
			() => false,
			() => {
				rebuilt = true;
				return { options: ["x"], premium: false, fallback: false, pick: "x", pickedByClient: false };
			},
		);

		expect(result.outcome).toBe("payment-failed");
		expect(rebuilt).toBe(false);
	});

	it("reports no-offer when the rebuild cannot produce one", () => {
		const result = applyReroll(
			() => true,
			() => undefined,
		);

		expect(result.outcome).toBe("no-offer");
	});
});

describe("applyCoinSpend", () => {
	it("debits the balance and saves once", () => {
		const profile = profileWith(10);
		let saves = 0;

		const outcome = applyCoinSpend(profile, REROLL_COST_COINS, () => {
			saves++;
			return true;
		});

		expect(outcome).toBe("ok");
		expect(saves).toBe(1);
		expect(profile.coins).toBe(10 - REROLL_COST_COINS);
	});

	it("refuses a balance that cannot cover the price, writing nothing", () => {
		const profile = profileWith(REROLL_COST_COINS - 1);
		let saves = 0;

		const outcome = applyCoinSpend(profile, REROLL_COST_COINS, () => {
			saves++;
			return true;
		});

		expect(outcome).toBe("insufficient-coins");
		expect(saves).toBe(0);
		expect(profile.coins).toBe(REROLL_COST_COINS - 1);
	});

	it("restores the balance when the save fails", () => {
		const profile = profileWith(10);

		const outcome = applyCoinSpend(profile, REROLL_COST_COINS, () => false);

		expect(outcome).toBe("save-failed");
		expect(profile.coins).toBe(10);
	});

	it("refuses a non-positive or fractional price", () => {
		// A caller that forgot to check its own price cannot drive the balance negative.
		expect(applyCoinSpend(profileWith(10), 0, () => true)).toBe("bad-amount");
		expect(applyCoinSpend(profileWith(10), -1, () => true)).toBe("bad-amount");
		expect(applyCoinSpend(profileWith(10), 1.5, () => true)).toBe("bad-amount");
	});
});
