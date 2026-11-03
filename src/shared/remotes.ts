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

/**
 * Fired by the client on key `2`, handled on the server. Forces the current phase to its next one.
 *
 * No arguments, for the same reason `SpawnBall` carries none: the server decides what the current phase
 * is and therefore what the next one is, and a client must not be able to name a phase. A player who
 * could pass one would be able to skip straight to `Playing` or drive the machine backwards.
 *
 * This is a **Studio affordance, not gameplay** — it exists so the four phases can be stepped through
 * without waiting out 30 + 15 + 5 seconds. The automatic loop advances on its own timers; this only
 * shortens the wait.
 *
 * Created by `RoundService` rather than declared in the Rojo project, matching the spawn remote: the
 * event and its handler stay owned by the same service, at the cost of a `WaitForChild` on the client.
 */
export const ADVANCE_PHASE_REMOTE_NAME = "AdvancePhase";

/**
 * A `StringValue` in `ReplicatedStorage` carrying the current phase name, written by `RoundService` on
 * every transition.
 *
 * ## Why a replicated value and not a remote
 *
 * Future GUI controllers — a pick screen, a winner screen — need the current phase *after* they start,
 * and a client can start at any moment relative to a transition. A remote that only sends transitions
 * has an ordering hazard: a client that joins between `Waiting` and `Playing` receives the next event
 * but never learns which phase it is in now, and would have to wait a whole cycle to find out. A
 * replicated value has no such gap — it is a *state*, so reading it once after `onStart` is always
 * correct, and a `Changed` subscription covers everything after.
 *
 * A `StringValue` rather than an attribute because the phase is a single global fact about the server,
 * not a property of any particular part, and putting it on some convenient instance would imply an
 * ownership relationship that does not exist. `ReplicatedStorage` is where it belongs: it replicates to
 * every client and to no server-side scene tree.
 */
export const ROUND_STATE_VALUE_NAME = "RoundState";

/**
 * A `StringValue` in `ReplicatedStorage` carrying the winner's display name for the round that just
 * ended, written by `RoundService` on entering `PostGame` and cleared on leaving it.
 *
 * **Matching `RoundState`'s mechanism rather than introducing a second one.** Both are *states* — a
 * client that starts mid-`PostGame` must still read the winner — and a remote would recreate the
 * ordering hazard `ROUND_STATE_VALUE_NAME` exists to avoid. A GUI added later reads this once in
 * `onStart` and subscribes to `Changed`; nothing reads it today, which is why it is being added now:
 * the server side is testable from the log whether or not a GUI exists.
 *
 * Empty string means "no winner", which covers both "the round has not ended" and "everyone was
 * eliminated". Never `nil`: a client reading `nil` cannot tell a clear from an absent value.
 */
export const WINNER_NAME_VALUE_NAME = "WinnerName";

/**
 * Debug key remotes. Three keys, three remotes, following the per-action pattern the spawn and phase
 * remotes already use — no arguments on the wire, so no client can name a phase or a count.
 *
 * These are **Studio affordances, not gameplay**, and they are ungated by design for now: the round can
 * be driven end to end solo without waiting out the 30 + 15 + 5 second timers. Admin gating is deferred.
 */
export const DEBUG_WAITING_REMOTE_NAME = "DebugWaiting";
export const DEBUG_PLAYING_REMOTE_NAME = "DebugPlaying";
export const DEBUG_SPAWN_REMOTE_NAME = "DebugSpawn";
