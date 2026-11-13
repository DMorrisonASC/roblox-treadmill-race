/**
 * **The per-ball icon table: one asset id per ball id, keyed by the same ids `BALL_POOL`, `powers.config.ts` and
 * `ball-color.ts` use.**
 *
 * ## What this is
 *
 * Every place a ball appears in the UI drew a **tinted circle** until this round: a `Frame` filled with the ball's own colour
 * (item 226) and rounded by a `UICorner`. That was the stopgap while the art was late, and the ten icons here are what
 * replaces it - one drawing per ball, so the picker, the reveal, the store and the inventory show *this ball* rather than
 * *a ball-shaped colour*.
 *
 * **The ids are the user's own assets, not placeholders.** They were supplied complete and are the drawings the game uses;
 * unlike every other table in `src/shared`, nothing here is marked `**Placeholder.**` because there is nothing to retune.
 *
 * ## What this is not
 *
 * **Not a replacement for `BALL_COLORS`.** The colour table stays, and keeps every job it had: the ball body's `Color` on
 * the belt, item 98's phantom that copies it, the three Neon markers, `spawnDecoy`'s `decoy.Color = parent.Color`, and - in
 * the UI - the **fill behind the icon**. The icon is drawn *inside* the tinted circle rather than instead of it, so a ball
 * whose icon fails to load still shows its colour rather than a hole; `ball-color.ts` calls the colour the stopgap, and a
 * stopgap that still works when the real thing does not is worth keeping.
 *
 * **Not a mesh, and nothing on the belt reads it.** These are `Decal`-class image assets drawn by `ImageLabel`s in the UI.
 * The body a player races is still the `Part` item 226 painted.
 *
 * ## The prefix
 *
 * The table holds **bare decimal ids** and `BALL_ICON_PREFIX` is added here, so a designer pastes the number the Creator
 * Dashboard shows. That is item 14's belt texture and item 144's pickup sprite pattern, and it is why `ball-icon.spec.ts`
 * can refuse an id that already carries the prefix - a doubled `rbxassetid://rbxassetid://...` renders nothing and reads as a
 * typo nobody can see.
 */
export const BALL_ICONS: Readonly<Record<string, string>> = {
	// The four common balls, then rare, epic and legendary - the tier order `BALL_COLORS` and `BALL_POOL` use, so the tables
	// can be read side by side.
	bully_ball: "120201769285764",
	bouncy_ball: "98886177592913",
	ghost_ball: "118553916103019",
	sprinter_ball: "109082564419786",

	heavy_ball: "121099842838280",
	decoy_ball: "101725102221675",

	magnet_ball: "110094790223387",
	rocket_ball: "136447174534668",

	recycle_ball: "88578934090385",
	eclipse_ball: "120781204837491",
};

/** The scheme every image id in this tree is written with. Bare ids live in the table; the prefix lives here. */
export const BALL_ICON_PREFIX = "rbxassetid://";

/**
 * The full `ContentId` for one ball's icon, or `undefined` for an id this table does not know.
 *
 * `undefined` rather than `""`, matching `colorForBall`: the caller decides what an unknown ball looks like, and an
 * `ImageLabel.Image` of `""` draws nothing - which is exactly the "inside" fallback this table was designed around, because
 * the tinted `Frame` behind it still paints the ball's colour.
 */
export function iconForBall(ballId: string): string | undefined {
	const id = BALL_ICONS[ballId];
	return id === undefined ? undefined : `${BALL_ICON_PREFIX}${id}`;
}
