/**
 * Who, if anyone, hears the elimination sound.
 *
 * ## Why the sound is targeted and the splash is not
 *
 * The splash (`elimination-signal.ts`) tells a player *their own* body is out, so it must reach exactly one client and it
 * must never reach a synthetic competitor. The sound is a different claim: it says "*you* knocked that body off". That is
 * information only the toucher has, and it is only worth playing to them — a broadcast tells four players "somebody was
 * eliminated" at the same instant, which is news the arena already shows and the HUD already scores.
 *
 * ## Why these are functions rather than `if`s at the call sites
 *
 * The same reason the splash rules are: a rule written at two call sites is a rule that will disagree with itself the
 * third time. There are two removal paths today (`settleEliminations` for the belt, `handleExternalDestruction` for the
 * spawner's culls) and both consult this file.
 *
 * ## What is deliberately not here
 *
 * No `Player` lookup, no remote, no `print`. This module is numbers in, booleans out, so it can be asserted in the Jest
 * runtime where a `Player` cannot be constructed — the same split `round-outcome.ts` and `elimination-signal.ts` use.
 */
import { isRealOwner } from "./elimination-signal";

/**
 * Whether a touch is worth remembering at all.
 *
 * **Both ends must have a player behind them**, and the filter lives at the write rather than at the read. A decoy is
 * touched by everything and owned by nobody; a `Debug#N` body's owner is negative; a body whose owner attribute has not
 * been written yet reads `nil`. A record between any of those and anything else can only ever answer "no sound", so the
 * map stops accumulating them and its size is bounded by the number of *competitors*, not by the number of contacts.
 *
 * Rejecting at the write is also what makes the read one line: `shouldPlayEliminationSound` then only has to compare the
 * two ids it is given.
 */
export function shouldRecordTouch(touchedOwner: number | undefined, toucherOwner: number | undefined): boolean {
	if (touchedOwner === undefined || toucherOwner === undefined) {
		return false;
	}

	return isRealOwner(touchedOwner) && isRealOwner(toucherOwner);
}

/**
 * Whether the player behind `owner` hears the sound for a body their ball last touched.
 *
 * - **`owner` is not a real player** → nobody. A `Debug#N` body's elimination is the debug presser's own business and no
 *   client should hear a sound it cannot attribute.
 * - **no recorded toucher** → nobody. A body that left the belt untouched is nobody's doing; playing the sound for the
 *   last player who happened to touch it a round ago would credit a kill that did not happen. This is also the state of
 *   every body in the first moments of a round, before any contact.
 * - **the toucher owns a different body** → nobody. The sound is the attacker's cue, and the attacker of a body is a
 *   *player*; the victim hearing the same sound as the sound they hear when they themselves are killed would make the two
 *   indistinguishable.
 * - **otherwise** → `owner`. Their ball is the last thing that touched the eliminated body.
 *
 * The comparison is on ids rather than on bodies because the toucher's body may already be destroyed by the time this is
 * asked — the ball that knocked a body off the belt can be culled first — and a destroyed part's attributes read as their
 * defaults, so the id is read *before* anything is destroyed and passed in here.
 */
export function shouldPlayEliminationSound(owner: number, toucherOwner: number | undefined): boolean {
	if (!isRealOwner(owner) || toucherOwner === undefined) {
		return false;
	}

	return toucherOwner === owner;
}
