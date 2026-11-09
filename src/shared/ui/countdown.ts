/**
 * The `Waiting` phase's 3-2-1-Start! countdown, as **data rather than timers**.
 *
 * ## Why the timeline is a table and not a chain of `task.delay`s
 *
 * A chain of delays is a second clock beside the server's. Each `task.delay` starts from *now* on the client, so the
 * caption changes drift by the client's frame time, by however many frames were dropped before the first delay was armed,
 * and by the length of every tween the chain is waiting on. A player who joins mid-countdown gets nothing at all, because
 * the chain was never armed for them.
 *
 * The countdown is therefore driven the way the picker's is (`tickCountdown`): a per-frame loop reads a deadline the
 * server published and asks *this* table "which step is it now". The table has no clock in it, so a client that arrives
 * late joins at the step the clock says it is in, and a client that hitches skips a step rather than pushing every later
 * caption later by the length of the hitch.
 *
 * ## Why the steps are contiguous rather than overlapping on purpose
 *
 * The brief's animation is sequential: a caption is swept off (scale up, fade out) and **only then** the next one rushes
 * in. That means the whole sequence is a partition of the timeline - every instant belongs to exactly one step - which is
 * what makes "which caption is showing" a lookup rather than a piece of state the controller has to remember. The
 * controller starts a tween when the step index changes and cancels nothing else; there is nothing else to cancel.
 *
 * ## What this module deliberately does not own
 *
 * The **look** - how far the sweep goes, what easing, what colour. Those live in the controller, because they are one
 * controller's presentation. What lives here is *when*, which is a fact about the sequence and the only part that can be
 * reasoned about without a screen.
 *
 * ## Why the five durations live here rather than in the controller (item 156)
 *
 * Because the sequence's **length** stopped being one controller's private business. `RoundSongController` starts the
 * round song's fade-in the moment the countdown begins, so that the music is up when the race is rather than arriving two
 * seconds after it — and "the moment the countdown begins" is `PlayingDeadline - COUNTDOWN_SECONDS`. Two files now need
 * that number, and a second copy of it in the song controller is how the music would come to start a hundred milliseconds
 * before or after the `3` appeared, on whichever round somebody last retuned one of the four and not the other.
 *
 * So the durations are exported beside the sequence they describe, and both callers import the sum.
 */

/**
 * The captions, in order. **The last one is the start cue**: it is held and then faded rather than swept off, because
 * there is nothing after it to sweep it off *for*.
 */
const COUNTDOWN_CAPTIONS: Array<string> = ["3", "2", "1", "Start!"];

/** How long each kind of step lasts. Every value is a tuned number; see `COUNTDOWN_TIMING` for what each one does. */
export interface CountdownTiming {
	/** A caption being swept off screen: the outgoing half of a change. */
	readonly outSeconds: number;
	/** A caption rushing in from the front: the incoming half of a change. */
	readonly inSeconds: number;
	/** How long the start cue is held before it fades. */
	readonly holdSeconds: number;
	/** How long the start cue takes to fade. */
	readonly fadeSeconds: number;
}

/** What one step does. `in` and `out` belong to the sweep; `hold` and `fade` belong to the start cue only. */
export type CountdownStepKind = "in" | "out" | "hold" | "fade";

/**
 * One slice of the timeline.
 *
 * `startsAt` is absolute **seconds since the countdown began**, not a remaining time: the controller converts once, at the
 * top, and every comparison below is in the same units. Mixing the two is how a countdown that looks right in one round
 * runs backwards in the next.
 */
export interface CountdownStep {
	readonly caption: string;
	readonly kind: CountdownStepKind;
	readonly startsAt: number;
	readonly duration: number;
}

/**
 * The full sequence: every caption swept in, everything but the last swept out, then the start cue held and faded.
 *
 * Built by walking the captions rather than written out as a literal, because the literal is the thing that drifts: adding
 * a fourth number would mean editing three places that all have to agree about `startsAt`. Here the cursor is the only
 * authority on when anything begins.
 */
export function countdownSteps(timing: CountdownTiming): Array<CountdownStep> {
	const steps = new Array<CountdownStep>();
	let cursor = 0;

	for (const caption of COUNTDOWN_CAPTIONS) {
		steps.push({ caption, kind: "in", startsAt: cursor, duration: timing.inSeconds });
		cursor += timing.inSeconds;

		if (caption === COUNTDOWN_CAPTIONS[COUNTDOWN_CAPTIONS.size() - 1]) {
			// The start cue: held, then faded. No `out` step - nothing follows it to make room for.
			steps.push({ caption, kind: "hold", startsAt: cursor, duration: timing.holdSeconds });
			cursor += timing.holdSeconds;
			steps.push({ caption, kind: "fade", startsAt: cursor, duration: timing.fadeSeconds });
			cursor += timing.fadeSeconds;
		} else {
			steps.push({ caption, kind: "out", startsAt: cursor, duration: timing.outSeconds });
			cursor += timing.outSeconds;
		}
	}

	return steps;
}

/**
 * How long the whole sequence takes, derived from the steps rather than summed from the timings.
 *
 * **Derived, because the countdown's start time is `deadline - this`.** A literal that drifted from the table would put the
 * countdown either into the picker's window or past the phase change, and both of those look like a bug in the animation
 * rather than in the arithmetic.
 */
export function countdownDuration(steps: Array<CountdownStep>): number {
	let latest = 0;

	for (const step of steps) {
		const stepEnd = step.startsAt + step.duration;
		if (stepEnd > latest) {
			latest = stepEnd;
		}
	}

	return latest;
}

/**
 * The index of the step `elapsedSeconds` falls in, or `-1` before the first step.
 *
 * The steps are contiguous and sorted, so this is a walk rather than a binary search: there are at most nine of them and a
 * walk is the version a reader can check against `countdownSteps` by eye.
 *
 * `elapsedSeconds` is assumed non-negative - the caller clamps, because "the deadline has passed" is a different question
 * with a different answer (skip the countdown entirely) and this function has no way to say it.
 */
export function countdownStepIndex(steps: Array<CountdownStep>, elapsedSeconds: number): number {
	let found = -1;
	let index = 0;

	for (const step of steps) {
		if (elapsedSeconds < step.startsAt) {
			return found;
		}

		found = index;
		index++;
	}

	return found;
}

// #region the shipped timing (item 156)

/**
 * **Placeholder.** Seconds for a caption to be swept off: scale 1 → 1.85, transparency 0 → 1.
 *
 * The outgoing half is the shorter of the two on purpose. It is the *leave*, and a leave that takes as long as the arrive
 * makes the sequence read as a slideshow rather than as something being shoved out of the way.
 *
 * **Raised from `0.15` to `0.2` in item 152**, with the inbound half, when the caller reported the countdown as too fast.
 * The pair are still the 2:1 ratio the original brief specified — the leave stays the shorter of the two — so the
 * proportions of the motion are unchanged and only its tempo is.
 */
export const CAPTION_OUT_SECONDS = 0.2;

/**
 * **Placeholder.** Seconds for the next caption to rush in.
 *
 * **Raised from `0.2` to `0.4` in item 152.** At `0.2` a caption had no readable moment at all: the inbound tween finished
 * exactly where the outbound one began, so each digit was only fully legible for the single frame it landed on. `0.4` is
 * roughly the time it takes to read one glyph comfortably, and it is the number to move if the countdown still reads as a
 * flicker rather than a count.
 *
 * A caption's visible moment is this plus the `out` step that follows it, which is why the pair moved together.
 */
export const CAPTION_IN_SECONDS = 0.4;

/** **Placeholder.** Seconds `Start!` is held at rest before it fades. */
export const START_HOLD_SECONDS = 0.6;

/**
 * **Placeholder.** Seconds `Start!` takes to fade. **No zoom on this one** — the race is about to begin and a scaling glyph
 * would still be moving as the belt starts.
 */
export const START_FADE_SECONDS = 0.25;

/** The four durations as one value, because `countdownSteps` builds the timeline from exactly these. */
export const COUNTDOWN_TIMING: CountdownTiming = {
	outSeconds: CAPTION_OUT_SECONDS,
	inSeconds: CAPTION_IN_SECONDS,
	holdSeconds: START_HOLD_SECONDS,
	fadeSeconds: START_FADE_SECONDS,
};

/**
 * **How long the whole sequence takes, in seconds** — about `3.05` at the shipped durations.
 *
 * Derived from the table rather than summed here, for the reason the countdown's own start time depends on it: a literal
 * that drifted from `countdownSteps` would put the sequence either inside the picker's window or past the phase change.
 *
 * **Two readers, which is why it is exported:** `CountdownController` uses it to place the sequence before
 * `PlayingDeadline`, and `RoundSongController` uses it to start the song's fade-in at the same instant (item 156).
 */
export const COUNTDOWN_SECONDS = countdownDuration(countdownSteps(COUNTDOWN_TIMING));

// #endregion
