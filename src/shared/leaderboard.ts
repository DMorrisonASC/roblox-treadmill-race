/**
 * One row of the leaderboard: who is where, in the belt's own frame.
 *
 * ## Why the payload carries an owner id and not `isMe`
 *
 * Every client receives the same array, because every client is watching the same race. "Which row is mine" is the one
 * field that differs per viewer, and it is the one field the **client** can answer without help: it has
 * `Players.LocalPlayer.UserId`. A server-computed `isMe` would mean either a separate `FireClient` per player or a lie
 * for everyone but one recipient.
 *
 * `userId` is the identity, not the name: display names change and two accounts can share one (`shared/attributes` makes
 * the same argument about why `OwnerUserId` is what the game keys on). It is also **signed on purpose** - synthetic
 * `Debug#N` owners are negative, so `userId > 0` is the whole test for "this is a real player", which is what the client
 * uses to style a bot row differently.
 */
export interface LeaderboardEntry {
	/**
	 * A key that is unique within a round: the body's full name.
	 *
	 * **Not the owner id**, because not every body has one. A `decoy` twin is deliberately ownerless, and a body spawned by
	 * a debug command may be too - and "any body on the belt" is the requirement, so the key has to exist for bodies the
	 * owner attributes do not cover. The full name is stable for the life of a body and unique within the round it was
	 * spawned in, which is exactly the scope the leaderboard needs.
	 */
	readonly key: string;
	/**
	 * `OwnerUserId` of the body's owner, or **`0` when it has none**.
	 *
	 * Signed on purpose in the game's own scheme - synthetic `Debug#N` owners are negative - so `userId > 0` is the whole
	 * test for "this is a real player", and `userId === LocalPlayer.UserId` is the whole test for "this row is mine". An
	 * ownerless body is `0` rather than `undefined` so the field survives a remote hop without a nil hole.
	 */
	readonly userId: number;
	/** `OwnerDisplayName` when the body has an owner, otherwise the body's own instance name. */
	readonly name: string;
	/**
	 * **Studs from the belt's spawn edge - smaller is further ahead.**
	 *
	 * `0` at the edge a body is placed on, growing toward the exit at `+X`. Measured in the belt's own frame
	 * (`PointToObjectSpace` plus the belt's half-length), so a moved or rotated belt does not invalidate it, and measured
	 * from the belt rather than from a body's birth point, so every body shares one origin.
	 *
	 * **Ascending is the ranking order.** The elimination edge is at `+X`, so the body closest to being eliminated is the one
	 * with the *largest* number - a body ten studs further along is ten studs closer to dying, not ten studs ahead. See
	 * `leaderboard-service` for the long form; the short form is that this number measures ground *lost*, not ground gained.
	 */
	readonly distance: number;
	/**
	 * Whether this row's body has left the round, and the row is a **record** rather than a position.
	 *
	 * A thrown, eliminated competitor's row stays on the board with its `distance` frozen at the moment it died. The client
	 * draws it struck through and in the error colour, which is the only thing that distinguishes "still racing, far back"
	 * from "out of the race - and here is where they stopped".
	 *
	 * **The rank is not frozen with it.** Rank comes from the merged sort order, so an eliminated body's place *improves* as
	 * live bodies fall behind it: "you were 5th when you died, you finished 3rd because two others were worse" is what a race
	 * result means, and a frozen ordinal would claim a body placed where it was when it stopped moving while the board
	 * continued to show everybody else passing it.
	 */
	readonly eliminated: boolean;
}

/*
 * There is **no entry cap any more.** One existed to keep the payload small and the HUD readable; both arguments turned out
 * to be wrong for this game. The player is watching every body on the belt, so a board that shows five of seventeen hides
 * the racers in front of them, and the payload is at most `MaxLiveBalls` (fifty) entries of four small fields - one array a
 * second. The client scrolls instead.
 */

/**
 * **Placeholder.** Seconds between broadcasts: **one**, down from two.
 *
 * The first build sent every half second and the board was unwatchable, but the interval was only half the reason - a rank
 * change animated over `0.3`s has not finished when the next array arrives, so every broadcast interrupted the previous
 * animation. At `1` a slide completes with `0.7`s of stillness before anything can move again, which is what makes the
 * motion read as deliberate rather than as a shudder. Halving the rate costs nothing: a body drifts at
 * `BALL_SPEED_DECAY_RATE` studs a second, so a row's number moves by one stud per tick either way.
 */
export const LEADERBOARD_INTERVAL_SECONDS = 1;
