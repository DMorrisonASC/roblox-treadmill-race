/**
 * Where a body is along the belt, as **studs from the spawn edge**: `0` at the edge a body is placed on, growing toward the
 * exit.
 *
 * ## Why this is a module and not two copies of one subtraction
 *
 * Two services need this exact number and **cannot share it through an import of each other**: `LeaderboardService` injects
 * `RoundService`, so `RoundService` reading the leaderboard would be a dependency cycle. The formula is two operations, so
 * the temptation is to re-type it - and two copies of a ranking formula is how the HUD and the payout end up disagreeing
 * about who won, which is the one disagreement a player can see immediately.
 *
 * The cap that ends a `Playing` phase takes its winner from **this** function (see `RoundService.checkEndCondition`), and the
 * leaderboard's rank 1 is the same call, so "the leader at the moment of the cap" is the same body the board shows at the top
 * rather than a second, subtly different ranking.
 *
 * ## Why the belt and not the body's spawn point
 *
 * Measured from the belt so the number survives a spawner being moved in Studio, and so every body shares one origin instead
 * of each being measured from where it happened to be born. The belt's own frame means a rotated or moved belt does not
 * invalidate it.
 *
 * ## Direction
 *
 * **Smaller is further ahead.** The belt's `+X` is the exit edge, where the elimination zone is, so this number measures ground
 * *lost*: a body ten studs further along is ten studs closer to dying, and the leaderboard sorts ascending for exactly that
 * reason.
 */
export function distanceFromSpawnEdge(beltCFrame: CFrame, beltLength: number, position: Vector3): number {
	return beltCFrame.PointToObjectSpace(position).X + beltLength / 2;
}
