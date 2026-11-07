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
 * The elimination **sound**, fired to **one player**: the one whose ball landed the last touch on the body that left.
 *
 * A second remote rather than a second argument on `Elimination`, because the two events have different audiences. The
 * splash is *"your body is out"* and goes to the body's owner; the sound is *"you put that body out"* and goes to the
 * attacker, who in the ordinary case is somebody else. Firing `Elimination` to the attacker would splash them for a kill
 * they did not suffer, and firing this one to everybody would make the two cues indistinguishable.
 *
 * **The audience used to be everybody** (items 82-86) and is now one client: a broadcast told four players "somebody was
 * eliminated", which is news the arena and the HUD already deliver. Who counts as the attacker is decided by
 * `shouldPlayEliminationSound` in `server/elimination-sound.ts` — the server owns that rule because only the server sees
 * touches.
 *
 * The throttle is **not** here. The server sends one signal per elimination — four bodies leaving in one tick is four
 * signals — and the receiving client's `shared/ui/sounds` collapses them into one start, because the rule is "this sound
 * may not restart within half a second" and only the client knows when it actually started.
 */
export const ELIMINATION_SOUND_REMOTE_NAME = "EliminationSound";

/**
 * A ball-ball **hit**, fired to **every player** with the contact midpoint: one argument, a `Vector3`.
 *
 * The midpoint and nothing else. `BindToCollisionSummaries` would give a real contact point and cannot be used here — it
 * is not callable from `Touched`, it does not replicate, and network ownership in this tree flaps between the server and
 * players — so the midpoint of the two bodies' positions is the number that is always available. For two 1-stud spheres
 * it is within half a stud of the contact, which is smaller than the burst.
 *
 * Why a remote rather than a server-side clone: cloning on the server would replicate every instance of every burst to
 * every player. The same argument moved the elimination sound to the client in item 82, and it is stronger here because a
 * burst is a whole hierarchy (a part, an attachment and one or more emitters) rather than one `Sound`.
 */
export const HIT_EFFECT_REMOTE_NAME = "HitEffect";

/**
 * A ball **actually got faster** from a pickup, fired to every player with no arguments.
 *
 * ## Why no arguments
 *
 * The sound is non-positional and identical for every collection — the client's `playPickupSound` takes no input at all.
 * A `Vector3` would be the burst's shape, not this one's: the hit effect needs a place because it *draws* there, and this
 * needs nothing because it only plays. Sending a position the client ignores is a second source of truth for a fact
 * nobody reads.
 *
 * ## Why the fire condition is the server's, and why the sound is still throttled
 *
 * `PickupService` fires this **inside** the same `after !== before` guard that writes `BALL_SPEED`, so the sound and the
 * speed change are one decision rather than two that agree. That condition is necessary and it is **not sufficient**: a
 * `recycle` ball resting on its surviving pad is re-raised from about `11.98` back to `12` on every re-touch — the tick
 * loop decays the speed between them — so the guard passes every 14–24 ms and fired nineteen times in one rest (item 91's
 * log). The *interval* is therefore the client's, as it is for the other two burst-shaped sounds: `playPickupSound` uses
 * `PICKUP_SOUND_MIN_INTERVAL_SECONDS` (0.3 s). The server keeps firing per raise, which is honest — the ball really is
 * being re-boosted — and each client collapses the rest into at most three starts a second.
 */
export const PICKUP_SOUND_REMOTE_NAME = "PickupSound";

/**
 * A purchase that the server actually granted, fired to the buyer alone.
 *
 * The coin chest and the fusion verb already answer on their own remotes with a result the client reads, but the Robux
 * chest does not: its grant runs inside `ProcessReceipt`, which is server-to-server, and the client deliberately ignores
 * `PromptProductPurchaseFinished` because a client cannot be trusted about whether a purchase happened. Without this
 * signal the one purchase that spends real money would be the only one with no confirmation the client can read.
 *
 * Fired **only** on `granted` — never for `duplicate`, `save-failed` or `no-profile` — and with no arguments: the sound
 * is one fixed clip, and a payload would be a second source of truth for a fact the server has already decided.
 */
export const PURCHASE_GRANTED_REMOTE_NAME = "PurchaseGranted";

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

/**
 * The leaderboard: **server to client only**, one array of standings, fired on a timer while a round is `Playing`.
 *
 * ## Why it is a broadcast of the whole list rather than a per-player message
 *
 * Every client sees the same race, so the payload is the same for all of them. The one field that is *not* the same is
 * "which row am I", and that is deliberately **not in the payload**: an owner id travels with each entry, and a client
 * compares it with its own `LocalPlayer.UserId`. The alternative - `isMe` computed on the server - would need a separate
 * `FireClient` per player for a boolean the client already knows, and would make the payload a function of its recipient
 * rather than of the race.
 *
 * Nothing is sent while the phase is not `Playing`: there is no race to rank, and a client that kept the last array would
 * be showing a leaderboard for a round that ended.
 */
export const LEADERBOARD_UPDATE_REMOTE_NAME = "LeaderboardUpdate";

/**
 * A player's round payout: **server to client only, one recipient, fired once per round that had a result to pay.**
 *
 * ## Why it is not an attribute or a broadcast
 *
 * An attribute would be a **persistent** slot for a **one-shot event**: the panel it drives is an animation, and an
 * attribute that stayed set would either replay the panel for a player who rejoins inside `PostGame` or need a second
 * attribute saying "and you have already seen it". A broadcast would carry one player's numbers to everybody else, which
 * is a payout breakdown for a race they did not run in the same order.
 *
 * ## Why the balances are in the payload
 *
 * `EconomyService.grantCoins` publishes the new balance before this fires, so a client that read `Coins` on arrival would
 * see the *end* of the animation it is meant to start. The two numbers are only both known on the server, in the method
 * that changed them — see `RoundPayoutMessage` in `shared/round-payout`.
 *
 * Fired **only when the grant succeeded.** A player with no profile is paid nothing (the economy logs why), and a panel
 * counting up coins that were never added is worse than no panel.
 */
export const ROUND_PAYOUT_REMOTE_NAME = "RoundPayout";

/**
 * A time-based reward: **server to client only, one recipient, fired when coins were actually added.**
 *
 * The two grants this carries - the daily login and the playtime stipend - differ only in their label and their amount, and
 * they reach the client the same way. A second remote would be a second name for one message.
 *
 * **Fired after the grant succeeded, never before.** The toast says "you were paid"; a toast for a save that failed would be
 * the only report of a reward the player did not get. The amount in the payload is what was added, which is why it travels
 * from the server rather than being re-derived here from the schedule.
 */
export const REWARD_TOAST_REMOTE_NAME = "RewardToast";
