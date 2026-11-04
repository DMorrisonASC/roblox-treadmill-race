/**
 * The round-transition wipe's own animation settings.
 *
 * ## Why this is a config file rather than constants in `tuning.ts`
 *
 * `tuning.ts` is *gameplay* — values a designer retunes to change how the game plays. These values change how a
 * two-second visual transition looks, and every one of them is read by the **client** that draws it. Keeping
 * them apart means "make the belt faster" and "make the wipe slower" cannot be confused in a diff.
 *
 * ## The contract with the server
 *
 * The server draws nothing, but it has to know how long the wipe takes: it changes the phase while the screen is
 * dark and must not start the phase's timer until the wipe has opened. The derived durations below
 * (`coverSeconds()`, `holdSeconds()`, `openSeconds()`) *are* that contract, and the server reads them from here
 * rather than from copies — **one source, so the two cannot disagree.** If they did, the timer would run
 * underneath the wipe, which is the exact failure this feature exists to avoid.
 *
 * ## Why a tiled grid and not a fade
 *
 * A fade reads as "the game is loading". A grid that closes from the centre and opens outward reads as a
 * deliberate cut between two states, which is what a round boundary is. It also hides the single frame where the
 * belt, the bodies and the HUD all change at once — the frame a player would otherwise read as a glitch.
 */

/** One cell's animation phase. */
export type TransitionStage = "idle" | "grow" | "hold" | "reveal" | "done";

/** **Placeholder.** Everything the wipe's animation needs. Values ported from the reference implementation. */
export const TRANSITION_CONFIG = {
	/**
	 * **The one switch.** Both sides read it: the client skips the animation when it is false, and the server
	 * skips the attribute bump *and* the timer hold. A wipe that plays on one side and not the other is the
	 * failure mode this flag exists to make impossible.
	 */
	ENABLED: true,

	/** **Placeholder.** Grid rows. */
	ROWS: 12,

	/** **Placeholder.** Grid columns. */
	COLS: 20,

	/**
	 * **Placeholder.** Extra delay per unit of distance from the grid's centre, in seconds.
	 *
	 * This is what makes the cover a *wave*: cells near the middle start first and the corners close last, so the
	 * wipe reads as expanding from the centre. It is also why the cover takes longer than `GROW_SECONDS` — see
	 * `coverSeconds()`.
	 */
	DELAY_PER_CELL: 0.015,

	/** **Placeholder.** How long one cell takes to grow from nothing to full size, in seconds. */
	GROW_SECONDS: 0.5,

	/** **Placeholder.** How long the grid stays fully closed, in seconds. The server moves during this window. */
	HOLD_SECONDS: 2,

	/** **Placeholder.** How long one cell takes to shrink away, in seconds. */
	REVEAL_SECONDS: 0.5,

	/**
	 * **Placeholder.** Whether the reveal wave runs inward instead of centre-outward.
	 *
	 * Reversed reads as the screen opening back toward the middle, pairing with the cover's outward motion; the
	 * alternative repeats the same motion twice in one second. Kept as a flag because it is a taste decision one
	 * boolean apart.
	 */
	REVEAL_REVERSES_WAVE: true,

	/** **Placeholder.** Cell colour — near-black navy, so the cut reads as a curtain rather than a colour flash. */
	COLOR: Color3.fromRGB(10, 12, 24),
} as const;

/**
 * Per-cell wave position, `0` at the centre-most cell and `1` at the furthest corner.
 *
 * Normalised rather than raw distance so `DELAY_PER_CELL` means "a full corner-to-centre delay", which stays
 * readable no matter how many rows and columns the grid has.
 */
function waveDelays(): Array<number> {
	const centreRow = (TRANSITION_CONFIG.ROWS - 1) / 2;
	const centreCol = (TRANSITION_CONFIG.COLS - 1) / 2;

	const distances = new Array<number>();
	let furthest = 0;
	for (let row = 0; row < TRANSITION_CONFIG.ROWS; row++) {
		for (let col = 0; col < TRANSITION_CONFIG.COLS; col++) {
			const distance = math.sqrt((row - centreRow) ** 2 + (col - centreCol) ** 2);
			distances.push(distance);
			if (distance > furthest) {
				furthest = distance;
			}
		}
	}

	const delays = new Array<number>();
	for (const distance of distances) {
		delays.push(furthest === 0 ? 0 : distance / furthest);
	}
	return delays;
}

/** The per-cell wave positions, computed once at load. */
export const TRANSITION_CELL_DELAYS = waveDelays();

/** The largest wave position, i.e. the corner. Cached because both derived durations need it. */
export const TRANSITION_MAX_WAVE = 1;

/**
 * Total time from the first cell starting to the last cell being fully closed, in seconds.
 *
 * `GROW_SECONDS + DELAY_PER_CELL` — the corner is one full `DELAY_PER_CELL` behind the centre. The server waits
 * exactly this long before changing the phase; any shorter and cells are still opening when the state moves.
 */
export function coverSeconds(): number {
	return TRANSITION_CONFIG.GROW_SECONDS + TRANSITION_CONFIG.DELAY_PER_CELL * TRANSITION_MAX_WAVE;
}

/** Total time the grid spends fully closed before it begins to open, in seconds. */
export function holdSeconds(): number {
	return TRANSITION_CONFIG.HOLD_SECONDS;
}

/** Total time from the first cell starting to shrink to the last cell being gone, in seconds. */
export function openSeconds(): number {
	return TRANSITION_CONFIG.REVEAL_SECONDS + TRANSITION_CONFIG.DELAY_PER_CELL * TRANSITION_MAX_WAVE;
}
