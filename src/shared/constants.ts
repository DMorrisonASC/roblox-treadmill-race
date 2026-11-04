/**
 * Values shared by the client and the server that belong to neither one alone.
 *
 * `attributes.ts` holds per-part knobs a designer retunes in Studio; `tuning.ts` holds gameplay constants; this
 * file holds the handful of names and timings that only exist because two machines have to agree.
 */

/**
 * Per-player attribute bumped by the server on each round transition it wants covered.
 *
 * **A counter, not a boolean.** A flag would have to be cleared by someone, and the cleaner is a second writer
 * with a second opinion about when the wipe is over; a counter needs no clearing because the client acts on the
 * *change* and remembers the value it last saw. It is also what makes a client that mounts mid-transition
 * harmless: its first read establishes a baseline and nothing plays until the next bump.
 */
export const ROUND_TRANSITION_ATTRIBUTE = "RoundTransitionCount";

/**
 * **Placeholder.** Extra time the server waits after the cover has finished, before applying the state change.
 *
 * The cover finishes on the client's clock; the server cannot observe that. This is the tolerance that lets the
 * server's `task.wait` land after the client's last cell has closed rather than one frame before it — without it
 * the phase would change for a frame or two while the screen was still closing, which is exactly the flicker the
 * wipe is meant to hide.
 */
export const TRANSITION_NETWORK_STEP = 0.1;
