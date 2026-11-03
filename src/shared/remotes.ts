/**
 * Remote plumbing shared by server and client.
 *
 * The folder and the RemoteEvent are created by the server during startup rather than declared in
 * the Rojo project. Declaring them in `default.project.json` would also work and would let the
 * client skip its WaitForChild, but it would split one feature across two files: the event would
 * exist in the place whether or not `BallSpawnerService` ever ran, leaving a remote with nothing
 * listening behind it. Creating them at runtime keeps the remote and its handler owned by the same
 * service, at the cost of a WaitForChild on the client.
 */
export const REMOTES_FOLDER_NAME = "Remotes";

/** Fired by the client on key `1`, handled on the server. Spawns exactly one ball per accepted call. */
export const SPAWN_BALL_REMOTE_NAME = "SpawnBall";

/**
 * Fired by the client on key `2`, handled on the server. Starts a round.
 *
 * No arguments, for the same reason `SpawnBall` carries none: the server decides whether a round may
 * start (`Idle` only) and a client must not be able to influence that. A player who could pass a
 * phase would be able to skip a countdown or restart a running round.
 *
 * Created by `RoundService` rather than declared in the Rojo project, matching the spawn remote: the
 * event and its handler stay owned by the same file, at the cost of a `WaitForChild` on the client.
 */
export const START_ROUND_REMOTE_NAME = "StartRound";
