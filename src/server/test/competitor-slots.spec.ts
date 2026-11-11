import { describe, expect, it } from "@rbxts/jest-globals";
import { SPAWN_LANE_ATTRIBUTE } from "shared/attributes";
import { freeLaneIndices, laneIsOccupied, remainingCompetitorSlots } from "../competitor-slots";

/**
 * A body-shaped value carrying one recorded lane, and nothing else the predicate reads.
 *
 * The same shape `powers.spec.ts` uses for a counting body and `lateral-shove.spec.ts` uses for a shove owner: the function
 * under test reads `GetAttribute` and nothing else, so a table is enough and a real `Part` (which this runtime can make but
 * does not need) would only add setup. A `undefined` lane models a decoy twin, which never came from a lane choice.
 */
function bodyInLane(lane: number | undefined): BasePart {
	const fake = {
		// **Two parameters, because the compiled call is a colon call.** roblox-ts emits `body:GetAttribute(name)`, which
		// passes the receiver as the first argument — so a one-parameter fake receives the *table* where it expects the
		// attribute name and silently answers `undefined`. Reading the last argument is what makes the fake behave the same
		// way a real `Instance` method does.
		GetAttribute: (first: unknown, second?: unknown) => {
			const name = second === undefined ? first : second;
			if (name !== SPAWN_LANE_ATTRIBUTE) {
				return undefined;
			}

			return lane;
		},
	};

	return fake as unknown as BasePart;
}

/**
 * The round's capacity, as arithmetic.
 *
 * ## What this proves and what it does not
 *
 * The bound is a subtraction over two integers, so every boundary is provable here — which is the point, because the defect
 * it replaces was two callers computing the same count differently and the difference being invisible until a round had
 * double the bodies it should. What it cannot prove is the *call order* that puts players first: that is
 * `spawnRoundCompetitors` running before `spawnBots`, and it is a source fact, not a table.
 */

describe("remainingCompetitorSlots", () => {
	it("is the whole field when nothing has spawned", () => {
		// Eight spawners, an empty belt: the round may hold eight — one per lane.
		expect(remainingCompetitorSlots(0, 8)).toBe(8);
	});

	it("is the remainder when some competitors already exist", () => {
		// One player body on an eight-lane belt: seven more may be added, which is what key `4` and the `3` key's bots must
		// spawn. Four players: four.
		expect(remainingCompetitorSlots(1, 8)).toBe(7);
		expect(remainingCompetitorSlots(4, 8)).toBe(4);
		expect(remainingCompetitorSlots(7, 8)).toBe(1);
	});

	it("is zero at exactly full", () => {
		// Eight bodies in eight lanes. The boundary that makes a second spawn a refusal rather than a ninth body.
		expect(remainingCompetitorSlots(8, 8)).toBe(0);
	});

	it("clamps at zero when over-full", () => {
		// Reachable: a `decoy` twin, a body the round has not yet noticed is gone, or a scene edited down mid-round. It must
		// not return a negative number, because every caller spawns "at most" this many and a negative bound is a value no
		// call site should have to reason about.
		expect(remainingCompetitorSlots(9, 8)).toBe(0);
		expect(remainingCompetitorSlots(50, 8)).toBe(0);
	});

	it("is zero when there are no lanes, whatever is live", () => {
		// A scene with nothing tagged `BallSpawner`. Both callers treat this as a refusal, and it has to survive `live > 0`
		// — a round with bodies but no bound spawners is a scene edit, not a full round.
		expect(remainingCompetitorSlots(0, 0)).toBe(0);
		expect(remainingCompetitorSlots(3, 0)).toBe(0);
	});

	it("never returns a negative number, for any pair", () => {
		// The property rather than three samples: the result is always a usable "how many more".
		for (let live = 0; live <= 12; live++) {
			for (let lanes = 0; lanes <= 12; lanes++) {
				const slots = remainingCompetitorSlots(live, lanes);
				expect(slots >= 0).toBe(true);
				expect(slots <= lanes).toBe(true);
			}
		}
	});
});

describe("laneIsOccupied", () => {
	it("is false on an empty belt", () => {
		// Nothing spawned: every lane is free, which is the state a round's first spawn runs in.
		expect(laneIsOccupied(0, [])).toBe(false);
		expect(laneIsOccupied(7, [])).toBe(false);
	});

	it("is true for the lane a body records, and false for its neighbours", () => {
		// The reported defect, as the predicate: one player on lane 0 means lane 0 is taken and lane 1 is not. The old debug
		// spawn ignored this and started numbering from 0 again, which put a second body at the player's spawn point.
		const bodies = [bodyInLane(0)];

		expect(laneIsOccupied(0, bodies)).toBe(true);
		expect(laneIsOccupied(1, bodies)).toBe(false);
	});

	it("reads the recorded lane, not a body's position", () => {
		// The distinction the fix turns on. A body that has ridden 20 studs down the belt still *holds* its lane until it
		// dies � its `Position` is no longer anywhere near the spawner, and a position comparison would report the lane free
		// and drop a new body on the spot the old one came from.
		const ridden = bodyInLane(3);

		expect(laneIsOccupied(3, [ridden])).toBe(true);
	});

	it("ignores a body with no recorded lane", () => {
		// A `decoy` twin is spawned beside its parent rather than from a lane choice, so it holds no lane; counting it would
		// block a lane no body was actually placed in.
		expect(laneIsOccupied(0, [bodyInLane(undefined)])).toBe(false);
	});

	it("is true for every lane on a full belt", () => {
		const bodies = new Array<BasePart>();
		for (let lane = 0; lane < 8; lane++) {
			bodies.push(bodyInLane(lane));
		}

		for (let lane = 0; lane < 8; lane++) {
			expect(laneIsOccupied(lane, bodies)).toBe(true);
		}
	});
});

describe("freeLaneIndices", () => {
	it("is every lane, ascending, on an empty belt", () => {
		const free = freeLaneIndices([], 4);

		expect(free.size()).toBe(4);
		for (let lane = 0; lane < 4; lane++) {
			expect(free[lane]).toBe(lane);
		}
	});

	it("skips the occupied lane wherever it is", () => {
		// The player's lane is skipped because it is occupied, not because it is lane 0 � so a scene that placed the player
		// in lane 3, or a restart that re-placed them, needs no second rule.
		expect(freeLaneIndices([bodyInLane(0)], 4).join(",")).toBe("1,2,3");
		expect(freeLaneIndices([bodyInLane(3)], 4).join(",")).toBe("0,1,2");
		expect(freeLaneIndices([bodyInLane(1), bodyInLane(2)], 4).join(",")).toBe("0,3");
	});

	it("is empty on a full belt", () => {
		const bodies = new Array<BasePart>();
		for (let lane = 0; lane < 4; lane++) {
			bodies.push(bodyInLane(lane));
		}

		expect(freeLaneIndices(bodies, 4).size()).toBe(0);
	});

	it("never returns a lane outside the spawner count", () => {
		// A body recording a lane from a scene that has since lost that spawner must not make this return it.
		expect(freeLaneIndices([bodyInLane(9)], 3).join(",")).toBe("0,1,2");
	});
});
