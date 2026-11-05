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
export const DEBUG_INTERMISSION_REMOTE_NAME = "DebugIntermission";
export const DEBUG_WAITING_REMOTE_NAME = "DebugWaiting";
export const DEBUG_PLAYING_REMOTE_NAME = "DebugPlaying";
export const DEBUG_SPAWN_REMOTE_NAME = "DebugSpawn";

/**
 * The elimination splash, fired **to one player** when their own competitor leaves the round.
 *
 * A remote rather than a `Player` attribute, and the difference is the whole decision: an attribute is *state*, so it
 * persists, so it needs clearing at the next round and it would have to be read with a "have I already seen this value"
 * baseline to avoid firing on rejoin. A remote is an *event* ? the server fires it once, to one client, at the moment it
 * happens ? and a player who joins mid-`PostGame` simply never receives one, which is the required behaviour rather than
 * something the client has to rule out.
 */
export const ELIMINATION_REMOTE_NAME = "Elimination";

/**
 * The economy remotes. Both are **requests for a state change**, not commands: the client asks, the server
 * decides, and the answer comes back on the same remote so the caller can render a result.
 *
 * `OpenCoinChest` carries no arguments — a client that could name a price or a ball could name a free
 * legendary. `FuseBalls` carries the **ball id** and nothing else: which ball to consume is the player's
 * choice, and the id is validated against the profile the server holds before anything is spent.
 *
 * `ReplicatedStorage.Remotes` is created by whichever service starts first, so neither owns the folder.
 */
export const OPEN_COIN_CHEST_REMOTE_NAME = "OpenCoinChest";
export const FUSE_BALLS_REMOTE_NAME = "FuseBalls";

/**
 * The picker's three channels, all server-authoritative.
 *
 * `PickerOffer` is **server to client only** ? the client never fires it, and it carries an offer the server has already
 * stored, so a client cannot ask for a different one. `PickerPick` and `PickerReroll` are client to server, and both
 * answer on `PickerOffer`'s sibling below rather than by mutating anything the client owns.
 */
export const PICKER_OFFER_REMOTE_NAME = "PickerOffer";

/** A pick, from the client. Carries one ball id, which is checked against the stored offer rather than against `OwnedBalls`. */
export const PICKER_PICK_REMOTE_NAME = "PickerPick";

/** A re-roll request, from the client. Carries nothing: the server owns the price and the old offer. */
export const PICKER_REROLL_REMOTE_NAME = "PickerReroll";

/**
 * The decoy outline: a `RemoteFunction` the client invokes to ask **"is my ball's twin on the belt, and which body is it?"**
 *
 * ## The only `RemoteFunction` in this tree, and why the answer is not an attribute
 *
 * Every other channel here is a `RemoteEvent` or a replicated value, because every other fact is the same for all viewers.
 * This one is not: the whole point of the `decoy` power is that a twin is indistinguishable from a real body, and an
 * outline visible to everyone would give the power away. **Per-viewer information cannot live in an attribute** — an
 * attribute on the body replicates to every client — so the client has to ask, and the server has to answer one caller at a
 * time.
 *
 * A **request/response** rather than an event, because the answer is a fact about the world at the moment of asking rather
 * than a notification about a change: a client that joins mid-`Playing` needs the answer immediately and has missed every
 * event that could have carried it. `RemoteFunction` also makes the refusal explicit — the server returns `nil` and logs
 * why, where an event would leave the client waiting for something that is never coming.
 *
 * The client never sends anything: `InvokeServer()` takes no arguments, so no client can name a body or a player.
 */
export const DECOY_OUTLINE_REMOTE_NAME = "DecoyOutline";
