/**
 * **The per-ball colour table: one colour per ball id, keyed by the same ids `BALL_POOL` and `powers.config.ts` use.**
 *
 * ## What this is
 *
 * A ball has had a *name* (`ballName`) and a *rarity* (`theme.colors.rarity`) since item 57, and no colour of its own. At the
 * camera's 260-390 studs those two are not what a viewer sees: the name is unreadable and four rarity colours cannot separate
 * ten balls, so the field reads as ten identical spheres. This table gives each ball id a colour, and it is the sibling of
 * `models.config.ts` - the same key space, the same cross-check, the same reasoning.
 *
 * **It is the stopgap, not the destination.** The artist's meshes are the real answer and are out of scope; a colour per ball
 * is what can ship before them, and it costs one table.
 *
 * ## What this is not
 *
 * **Not a replacement for `theme.colors.rarity`.** The four rarity colours stay exactly as they are and keep doing the job
 * they already do: the **border** of every card and the card's art wash. This table does the **fill** - the ball itself, in the
 * picker, the store, the inventory, the reveal, and on the belt. So a card still says "this is epic" at a glance (its ring)
 * and "this is the rocket ball" by its colour, which is two facts rather than one replacing the other.
 *
 * ## How it reaches the player
 *
 * - **The body's `Color`**, which item 98's phantom copies verbatim - so the skin a client actually renders carries it.
 * - **The three Neon markers**, which draw `Color` unlit and are the legible thing at distance.
 * - **Every UI ball circle**, via `colorForBall`.
 *
 * ## The one thing that would break it
 *
 * `attachBallTexture` still puts six `Texture` instances on each body. They have never rendered on a curved primitive (see the
 * docblock on `attachBallMarkers`), which is why the colour is visible at all. **If that asset ever starts drawing, it covers
 * `Color`** and every ball goes back to looking alike - the fix then is to delete the textures, not to add the colours
 * somewhere else.
 *
 * All ten values are **Placeholder.** - hand-picked here so the table is total, and the designer's to retune.
 */
export const BALL_COLORS: Readonly<Record<string, Color3>> = {
	// The four common balls: the most-seen tier, so these are the four most distinct hues in the set.
	bully_ball: Color3.fromRGB(214, 64, 64), // red - the aggressive one
	bouncy_ball: Color3.fromRGB(86, 200, 96), // green - lively
	ghost_ball: Color3.fromRGB(200, 228, 255), // pale blue - a ghost is nearly white
	sprinter_ball: Color3.fromRGB(104, 224, 104), // lime - a burst

	// Rare.
	heavy_ball: Color3.fromRGB(124, 110, 140), // muted violet-grey - weight, deliberately the least saturated
	decoy_ball: Color3.fromRGB(240, 140, 48), // warm orange - the false signal that wants your attention

	// Epic.
	magnet_ball: Color3.fromRGB(228, 100, 186), // pink - attraction
	rocket_ball: Color3.fromRGB(250, 214, 56), // yellow - the brightest thing on the belt

	// Legendary.
	recycle_ball: Color3.fromRGB(56, 208, 216), // cyan
	eclipse_ball: Color3.fromRGB(88, 72, 200), // indigo - the darkest of the ten
};

/**
 * The colour of one ball, or `undefined` for an id this table does not know.
 *
 * `undefined` rather than the fallback, so the caller decides what an unknown ball looks like: the spawner paints it
 * `BALL_COLOR_FALLBACK`, and a UI site falls back to the rarity tint it already had. A function that answered the fallback
 * would make "no entry" indistinguishable from "a ball that is genuinely near-white", which is the `models.config.ts`
 * distinction between `undefined` and a value spelled with a sentinel.
 */
export function colorForBall(ballId: string): Color3 | undefined {
	return BALL_COLORS[ballId];
}
