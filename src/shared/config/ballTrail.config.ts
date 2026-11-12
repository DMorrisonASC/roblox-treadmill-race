/**
 * The ball trail's own settings: how often a copy is left behind, how long it takes to fade, and how far it fades.
 *
 * ## What the effect is
 *
 * A boosted ball leaves a short row of fading copies of itself behind. The *look* is the reference effect's (brief ghost
 * images of the body, matching its shape and colour, no outline, no smoke, no blur); the *mechanism* is not, because the
 * reference is a character rig with a `PlayerScripts` emit loop, a dodge window and a server-tweened per-layer transparency
 * that every client sees. **The ball has none of those preconditions** - it is one `Part` with a client-side phantom skin -
 * so the trail here is a purely client-side clone-and-fade, and every client draws its own copy of the same thing.
 *
 * ## Why the numbers live in their own file
 *
 * Item 177's rule: every effect owns its multiplier and its magnitudes. The three trails in this tree (`windBoost`,
 * `tailWind`, this) are drawn at different moments for different reasons and a designer must be able to retune one without
 * moving the others.
 */

/**
 * **Placeholder.** Seconds between copies, i.e. the trail's resolution.
 *
 * The reference effect uses roughly `0.05 s`, which is one copy every third frame at 60 Hz. That is the band this sits in:
 *
 * - **Shorter** (one copy per frame) produces sixty parts a second per boosted ball. At eight boosted bodies that is ~500
 *   live parts behind a 0.25 s fade, for a difference no one can see - the copies would be 0.3 studs apart at `BALL_SPEED`
 *   extremes, i.e. inside each other.
 * - **Longer** than about `0.1 s` stops being a trail and becomes a dotted line: at `100` studs/second a copy every tenth
 *   of a second leaves 10-stud gaps between 20-stud balls, so the reader sees three separate balls rather than one moving.
 */
export const TRAIL_SPAWN_INTERVAL_SECONDS = 0.05;

/**
 * **Placeholder.** Seconds a copy takes to fade from the ball's own opacity to `TRAIL_FADE_TRANSPARENCY_END`.
 *
 * `0.25` is five copies alive at once at the interval above - long enough for the eye to read a *trail*, short enough that
 * the oldest copy is still near the ball. Tied to the interval rather than independent: a lifetime much longer than the
 * interval gives a very long smear (and a part count to match), and a lifetime near the interval gives a single duplicate
 * that pops out, which reads as a stutter rather than as speed.
 */
export const TRAIL_LIFETIME_SECONDS = 0.25;

/**
 * **Placeholder.** The transparency a copy ends at, from `0` (opaque) to `1` (gone).
 *
 * `1` matches the reference and is the only value that leaves nothing behind. A slightly lower end value would leave the
 * last few copies at a faint tint instead of removing them, which is a *different* effect (a smear of semi-permanent
 * ghosts) and would also mean the copies never become invisible, so they would have to be destroyed on a timer anyway.
 */
export const TRAIL_FADE_TRANSPARENCY_END = 1;

/**
 * Whether the per-copy diagnostic lines print.
 *
 * **This tree has no shared `DEBUG_LOGGING` flag** - the prompt that asked for this effect assumed one existed. Rather than
 * invent a global switch that every other controller would then have to honour, the trail gets its own, defaulting to off:
 * the boot line says the system is mounted, and these two lines say *when* - which is only interesting while the effect is
 * being tuned.
 */
export const BALL_TRAIL_DEBUG_LOGGING = false;
