/**
 * The two random decisions the lobby song makes, as pure functions: **which clip**, and **where in that clip the first pass
 * starts** (item 157).
 *
 * ## Why the rules are here and not in the controller
 *
 * Both are arithmetic on numbers a controller has and a spec does not: `Sound.TimeLength` needs a loaded asset and an audio
 * device, and `math.random` needs a running engine. Extracted, both can be asserted against literals — the same argument
 * `songWrapTarget` and `countdownSteps` are built on, and the reason this file imports nothing at all.
 *
 * **`lengthSeconds` is a parameter, not a read.** That is the whole point: the failure this module is written around —
 * "the clip was not loaded yet, so its length was `0`, so the offset clamped to `0` and every round started at the top" —
 * is representable, and therefore testable, only if the length is handed in as a number. A function that took the `Sound`
 * could not be wrong in a spec, because the spec could not build one.
 */

/** Where the first pass starts, and where the loop has to wrap back. Both seconds from the top of the clip. */
export interface LobbySongStart {
	/**
	 * The playhead the **first** pass begins at — uniform over `[0, ceiling - minSpan]`.
	 *
	 * Never the loop start: the first pass is `start -> ceiling` and every pass after it is `0 -> ceiling -> 0`. See
	 * `drawLobbyStart` for why the opening is heard on the loop and not on the first pass.
	 */
	readonly start: number;
	/** `lengthSeconds - tailCutoffSeconds`: the instant the loop wraps. The last `tailCutoffSeconds` are never played. */
	readonly ceiling: number;
}

/**
 * Draws the lobby song's random opening: `{ start, ceiling }`, or `undefined` when the clip cannot honour both rules.
 *
 * ## The three rules, and which one is not negotiable
 *
 * 1. **The loop's end is `lengthSeconds - tailCutoffSeconds`.** The tail is cut because an upload's last five seconds are
 *    usually the author's own fade, and splicing onto the end of a fade reads as damage rather than as a loop. The ceiling
 *    is returned rather than recomputed by the caller, so the number the loop uses and the number the draw was bounded by
 *    are the same number — two computations of "the end minus five" is exactly how a loop starts wrapping a second late.
 * 2. **The first pass is at least `minSpanSeconds` long**, i.e. `ceiling - start >= minSpanSeconds`, so `start` is uniform
 *    over `[0, ceiling - minSpanSeconds]`. Without the floor a clip could open two seconds before its ceiling and the
 *    "random start" would be a stutter rather than a variation.
 * 3. **The loop start is `0`, not `start`.** This function deliberately does not return it: `start` is where the *first*
 *    pass begins, and every pass after it begins at `0`. Returning a `loopStart` here would invite a caller to pass `start`
 *    to the wrap, which would hide the clip's opening for ever — the exact opposite of what "loop the song" means. The
 *    opening *is* heard; only the first pass is randomised.
 *
 * ## Why a short clip is refused rather than clamped
 *
 * `maxStart = ceiling - minSpanSeconds`. When that is `<= 0` the clip cannot satisfy both rules at any start, and there is
 * no honest clamp: `start = 0` would give a first pass shorter than the floor, and `start < 0` is not a position. So the
 * answer is `undefined` and the caller skips the song and says so, which is a *refusal* — one line in the log and silence —
 * rather than a `Play()` at `0` that quietly breaks the rule the round exists to state.
 *
 * **`<= 0` and not `< 0`**, deliberately. At exactly `maxStart = 0` a start of `0` does satisfy the span rule, so `<= 0`
 * throws away a legal case — and it is the right trade: a zero-width range means "draw a number between 0 and 0", i.e. a
 * random start that is always the same one, which is a fictional randomisation. A clip of exactly `tailCutoff + minSpan`
 * seconds is silent here rather than predictable.
 *
 * **The unloaded clip is the same case, and that is the point.** `Sound.TimeLength` is `0` until the asset loads, so a draw
 * taken too early is a draw of `-tailCutoff`, which refuses. The wrong-number failure and the too-short-clip failure are
 * one branch, and both are logged — which is why a caller cannot silently play from `0` on a cold client.
 *
 * ## The `random` parameter
 *
 * Injected so a spec can say "the largest possible draw" without controlling a seed. **It is clamped at both ends**, and
 * that is not defensiveness for its own sake: Luau's `math.random()` is `[0, 1)`, but the parameter is typed as any
 * `() => number`, and a caller that passed a `math.random(0, n)`-shaped closure would hand back `1` about `1/(n+1)` of the
 * time — one round in a hundred starting past the ceiling, on a boundary only the loop would notice.
 */
export function drawLobbyStart(
	lengthSeconds: number,
	tailCutoffSeconds: number,
	minSpanSeconds: number,
	random: () => number,
): LobbySongStart | undefined {
	const ceiling = lengthSeconds - tailCutoffSeconds;
	const maxStart = ceiling - minSpanSeconds;

	if (maxStart <= 0) {
		return undefined;
	}

	const drawn = random() * maxStart;
	const start = math.clamp(drawn, 0, maxStart);

	return { start, ceiling };
}

/**
 * Picks one of the lobby's clips, or `undefined` when there is nothing to pick from.
 *
 * ## Why the pick is a function and the draw is another
 *
 * They are two different kinds of "random" with two different failure modes. The pick can only fail by being empty (both
 * assets missing), which is a config-and-network fact; the draw can fail by being too short, which is a fact about a clip.
 * Keeping them apart means the controller's two `undefined` branches each log a different reason, and a report that says
 * "no music" can say which one it was.
 *
 * **The index is clamped to the last element.** `math.floor(random() * size)` with an injected `random` that returns
 * exactly `1` gives `size`, which is an out-of-range index — the one way this arithmetic can be wrong, and it is wrong by
 * one element rather than by all of them, so it would look like a rare flake rather than a bug.
 */
export function pickLobbySong(assetIds: ReadonlyArray<string>, random: () => number): string | undefined {
	const size = assetIds.size();
	if (size === 0) {
		return undefined;
	}

	const index = math.clamp(math.floor(random() * size), 0, size - 1);

	return assetIds[index];
}
