import { SPAWN_LANE_ATTRIBUTE } from "shared/attributes";

/**
 * How many more competitors a round may hold, given what is already on the belt and how many lanes exist.
 *
 * ## Why this is a module and not an expression written twice
 *
 * The count was computed in three places and they did not agree: `spawnRoundCompetitors` capped at
 * `min(players, lanes)` while `spawnBots` spawned a flat `lanes` regardless of what was already there. A `3` key with one
 * player therefore produced one player body **plus** eight bots into eight lanes, and the double-parked lanes were the
 * visible symptom. Two callers written a round apart is exactly how a rule becomes two rules, so the rule lives here once
 * and both read it.
 *
 * `debug-balls.ts` and `round-outcome.ts` are the precedent for the placement: `RoundService` cannot be constructed in the
 * Jest runtime (its dependencies reach `DataStoreService`, which throws in an unpublished place), so a bound written
 * inside it could only ever be a source read. As a pure function over two integers every boundary is provable.
 *
 * ## What counts as a competitor
 *
 * The caller passes `RoundService.getLiveBalls().size()` — the bodies the round **tracks**. That deliberately excludes a
 * `decoy` twin: a decoy is a live `MaxLiveBalls` body but carries no owner and is not a competitor (it cannot win, and
 * `getCompetitors()` filters it out), so it must not consume one of the round's competitor slots. A `decoy` ball therefore
 * still makes a round spawn its full complement of real bodies; it costs a `MaxLiveBalls` slot and nothing else.
 *
 * ## The cap is a bound, not an allocation
 *
 * It answers "may another body be added", it does not decide who. The caller has already chosen its owners — players in
 * enrollment order, then synthetic `Debug#N` owners — so "players first, debug fills the remainder" is a property of call
 * order rather than of this function. That is deliberate: an allocation policy here would have to know about players,
 * enrollment and spawner geometry, none of which belong in a two-line subtraction.
 */

/**
 * `max(0, spawnerCount - liveCompetitors)` — the number of competitors that may still be added.
 *
 * - **`0` live, 8 lanes** → `8`.
 * - **`4` live, 8 lanes** → `4`.
 * - **exactly full (`8` live, 8 lanes)** → `0`.
 * - **over-full (`9` live, 8 lanes)** → `0`, not `-1`. A caller that spawns "at most" this number must never read a
 *   negative bound and conclude something about it; clamping here means no call site needs a `math.max`.
 *
 * The signature is deliberately plain integers rather than bodies: the caller owns the question of what a live competitor
 * is, and a function that took an array would have to filter it again in every caller's own way.
 */
export function remainingCompetitorSlots(liveCompetitors: number, spawnerCount: number): number {
	return math.max(0, spawnerCount - liveCompetitors);
}

/**
 * Whether the lane at `laneIndex` already holds a live body.
 *
 * ## How a body's lane is known
 *
 * From the **`SpawnLane` attribute written at spawn** by `BallSpawnerService.spawnInLane` (item 184), not from a position
 * comparison. A lane's spawn point is only where a body *started*: one frame later it has moved, and a `Position` test
 * against `spawnerLanes[i]` would report every occupied lane as free — which is exactly the state that put a debug body
 * inside the player's body.
 *
 * A body with no `SpawnLane` occupies nothing: a `decoy` twin is spawned beside its parent rather than from a lane choice
 * of its own, and an older-build body has no attribute at all. Both are bodies the caller may see and this function
 * deliberately ignores, because neither was placed by the lane logic that this predicate is guarding.
 *
 * ## Why it takes the bodies rather than the count
 *
 * The question is per-body. `remainingCompetitorSlots` answers "how many may I add" from a count; this answers "may I add
 * *here*", and only the bodies can answer that. Both are pure so a spec can drive them from literals — the callers pass
 * `spawner.getLiveBodies()`.
 */
export function laneIsOccupied(laneIndex: number, live: ReadonlyArray<BasePart>): boolean {
	for (const body of live) {
		const lane = body.GetAttribute(SPAWN_LANE_ATTRIBUTE);
		if (typeIs(lane, "number") && lane === laneIndex) {
			return true;
		}
	}

	return false;
}

/**
 * The free lane indices in ascending order — the lowest-numbered free lanes first, which is the order a debug spawn wants.
 *
 * `loadLaneIndices(live, spawnerCount, budget)` is the one the caller actually uses; this is its building block and is
 * exported because the ascending-order property is what a spec should pin rather than the shape of the caller's loop.
 */
export function freeLaneIndices(live: ReadonlyArray<BasePart>, spawnerCount: number): number[] {
	const free = new Array<number>();
	for (let lane = 0; lane < spawnerCount; lane++) {
		if (!laneIsOccupied(lane, live)) {
			free.push(lane);
		}
	}
	return free;
}
