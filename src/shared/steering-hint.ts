import {
	STEERING_HINT_FADE_OUT_SECONDS,
	STEERING_HINT_MIN_SCALE,
	STEERING_HINT_REFERENCE_SHORT_AXIS,
	STEERING_HINT_SECONDS,
} from "shared/tuning";

/**
 * **When the steering hint belongs on screen, and how large its arrows are drawn.**
 *
 * ## Why the rule is a module rather than three `if`s in the controller
 *
 * The controller cannot be constructed in this runtime - it reaches `TweenService`, a `ScreenGui` and `Workspace.CurrentCamera`
 * - so a decision written inside it can only be checked by playing the game and watching. The decisions here are the ones that
 * are *invisible* in a single round and wrong in exactly the sequences this feature exists for: a spectator whose first
 * `Playing` is round one and who competes in round two, a mid-round joiner whose first frame is already `Playing`, and a
 * `Playing -> Playing` restart that must not replay the hint. Every one of those is a row in a matrix over three plain values,
 * so the matrix is asserted in `steering-hint.spec.ts` instead of being observed.
 *
 * The pattern is `shared/motion-blur.ts`'s `motionBlurActionFor`: a rule a **client** controller obeys, living in `shared/`
 * because it is pure and because its spec lives beside it.
 *
 * ## Why `shown` is an input rather than a fact the rule owns
 *
 * "Once per client per session" is the one part of this that is genuinely state: it has to survive the arrows being destroyed,
 * the phase leaving `Playing`, and an elimination. The rule therefore takes it as a parameter and answers "what should happen
 * *now*", which is what keeps the session fact in one field on one controller and the policy in one function.
 */

/** The one phase the hint belongs to. A client cannot import the server's `RoundPhase`. */
export const STEERING_HINT_PHASE = "Playing";

/**
 * What the hint should do on this signal.
 *
 * - `show` - nothing is on screen, this player is competing, and they have never seen the hint. Draw it.
 * - `teardown` - the hint has been shown and no longer applies (the phase left `Playing`, or this player stopped competing).
 *   Destroy whatever is on screen, **immediately**: a hint left over a countdown or a post-round is a lie about the controls.
 * - `nothing` - either the hint is already up in the state it should be, or it was never owed.
 */
export type SteeringHintAction = "show" | "teardown" | "nothing";

/**
 * The decision, as one function over the three facts the controller knows.
 *
 * **`shown` is set by the show, not by `Playing` entry.** That distinction is the whole spectator case: a player whose first
 * `Playing` arrives while they are watching somebody else's round is owed nothing *yet*, and marking the session as "seen" on
 * the phase entry would silently deny them the hint in the first round they actually race. It also makes `Playing -> Playing`
 * (the debug restart, item 38) free: the flag is already set, so the second entry answers `nothing` with no extra suppression.
 */
export function steeringHintActionFor(phase: string, competing: boolean, shown: boolean): SteeringHintAction {
	const applies = phase === STEERING_HINT_PHASE && competing;

	if (!shown) {
		return applies ? "show" : "nothing";
	}

	return applies ? "nothing" : "teardown";
}

/**
 * How long after the hint is drawn its fade-out starts, in seconds.
 *
 * ## Why this is not `STEERING_HINT_SECONDS` minus both fades
 *
 * The fade-in is *inside* the three seconds rather than in front of them - it starts on the frame the hint is drawn - so the
 * window runs `[0, 0.25)` fading in, `[0.25, 2.5)` held, `[2.5, 3)` fading out. The subtraction that produces the hold is
 * therefore `SECONDS - FADE_OUT`, and the hint is gone at exactly `STEERING_HINT_SECONDS` as the brief's acceptance criteria ask.
 * Subtracting `STEERING_HINT_FADE_IN_SECONDS` as well would start the fade-out a quarter-second early and destroy the hint at
 * 2.75 s, which is invisible on a screenshot and wrong every time.
 *
 * It lives here rather than in the controller so the three-number sum is asserted in the spec instead of trusted.
 */
export function steeringHintFadeOutAtSeconds(): number {
	return STEERING_HINT_SECONDS - STEERING_HINT_FADE_OUT_SECONDS;
}

/**
 * The `UIScale` the arrows are drawn at, given the viewport.
 *
 * ## Why the glyphs are not a fixed pixel size
 *
 * The hint's size was specified against a desktop, and `STEERING_HINT_TEXT_SIZE` is what a 540-pixel short axis gets. On the
 * logged phone viewport (750 x 381) a literal 96 would be a quarter of the screen's short axis - two enormous triangles over
 * the belt at the exact moment the player is trying to find their ball. So the drawn size is the designed size **times** this
 * scale: `1` from the reference axis upward, and proportionally smaller below it, floored so a portrait phone still shows a
 * legible arrow rather than a speck.
 *
 * The floor and the reference are in `tuning.ts` with the other judged numbers; this function is only the arithmetic, so the
 * "how big on a phone" question is answered by a spec rather than by a screenshot.
 */
export function steeringHintScale(viewport: Vector2): number {
	const shortAxis = math.min(viewport.X, viewport.Y);

	return math.clamp(shortAxis / STEERING_HINT_REFERENCE_SHORT_AXIS, STEERING_HINT_MIN_SCALE, 1);
}
