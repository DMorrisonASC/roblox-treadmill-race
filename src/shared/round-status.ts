/**
 * Strings and rules the round machine and the HUD have to agree about.
 *
 * ## Why this is a module and not a constant in `round-service.ts`
 *
 * Both ends need the same literal. The server writes it into `ReplicatedStorage.RoundRefusal`; the **client** needs it as the
 * fallback for the frame before that value has replicated, and a client that spelled it a second way would show a different
 * sentence for the same refusal - the failure every duplicated string in this tree has eventually produced.
 */

/**
 * What the banner says when a round cannot start because too few players are enrolled. **The designer's string, verbatim,
 * including the `atleast` spelling** - it is user-facing text they chose, and correcting it here would change what a player
 * reads to match a style guide nobody asked it to match.
 */
export const REFUSAL_NEED_PLAYERS = "Need atleast two players to start a race";

/**
 * The phase names the banner's clock runs in.
 *
 * `Waiting` has its own 3-2-1 (`CountdownController`, item 149) and `PostGame` lasts five seconds - a countdown in either would
 * be a second clock over the same span, which is how two clocks end up disagreeing by a frame.
 */
export function phaseHasClock(phase: string): boolean {
	return phase === "Intermission" || phase === "Playing";
}

/**
 * A remaining-seconds count as `M:SS`.
 *
 * `0:07`, `1:20`, `2:00`. **Not `MM:SS`**: the leading zero on the minutes is noise for a clock that never exceeds two digits,
 * and `0:07` reads faster than `00:07` at HUD size.
 *
 * Negative input clamps to `0:00` rather than formatting as `-0:01`: a deadline that has passed is a clock that has run out,
 * and the phase change that follows is what removes it.
 */
export function formatClock(remainingSeconds: number): string {
	const clamped = math.max(0, remainingSeconds);
	const total = math.ceil(clamped);
	const minutes = math.floor(total / 60);
	const seconds = total - minutes * 60;

	return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}
