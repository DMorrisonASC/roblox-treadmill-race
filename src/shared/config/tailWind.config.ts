/**
 * The `tailWind` trail's own settings: what it is called in the place, and how big it draws.
 *
 * ## Why this is a second file and not the wind-boost one
 *
 * **It shares a formula and shares nothing else.** `windBoost` and `tailWind` are two assets, driven by two different
 * attributes (`Boosted` and `TailWind`), drawn at two different moments in a ball's ride, and a designer can reasonably want
 * one longer than the other. They reach the same arithmetic — `effectScaleFor(ball, multiplier)` — because item 101 found
 * that two hand-copied implementations had already drifted tenfold apart, and sharing the *function* is what prevents that.
 * Sharing the *number* is what item 177 removed, because a number shared between effects means one cannot be retuned
 * without moving the other.
 *
 * **A future round that reads the two files, sees the same multiplier and merges them should read this paragraph first.**
 * The values being equal today is a consequence of "preserve the size nothing asked to change", not of the two being one
 * effect. Merging them would re-create the exact coupling item 177 exists to break, and it would make the next
 * "windBoost is too small" request quietly resize the decaying-ball trail too.
 *
 * ## The contract with this number, in one sentence
 *
 * **`SCALE_MULTIPLIER` multiplies every stud-valued property of the cloned `tailWind` asset after the ball's own ratio
 * `ballRadius / BASE_BALL_RADIUS`, so the reference length is `BASE_BALL_RADIUS` (0.5 studs) and `1.0` means "the authored
 * asset mapped exactly onto a 0.5-stud-radius ball", not "authored size on screen".**
 *
 * Worked at a 20-stud ball: radius `10`, so `10 / 0.5 = 20` design radii, and at `0.1` the clone draws at **2.0x** the
 * authored geometry.
 */

/** The asset's name in `ReplicatedStorage`, searched recursively. **An identity, not a `Placeholder.`** */
export const TAIL_WIND_ASSET_NAME = "tailWind";

/**
 * **Placeholder.** The effect's own scale multiplier. `0.1` reproduces the size this effect drew before the split.
 *
 * Deliberately a separate `export` from `WIND_BOOST_SCALE_MULTIPLIER`, not an import of it — see the header. The two read
 * the same today and are allowed to diverge.
 */
export const TAIL_WIND_SCALE_MULTIPLIER = 0.1;

/**
 * **Placeholder.** The trail's heading, in **degrees about the effect's own up axis**, measured from belt-ward. `0` ships.
 *
 * Separate from `WIND_BOOST_HEADING_OFFSET_DEGREES` for the same reason the scale is separate — see this file's header. The
 * two trails share the composition and may legitimately want different headings: a boost trail is drawn when a ball is
 * fighting forward and a tail wind when it is losing ground, so "one points along the motion and the other across it" is a
 * design a single number could not express. `0` / `90` / `180` / `-90` are the four worth trying; see the wind-boost config
 * for why those four and which way a positive number turns.
 */
export const TAIL_WIND_HEADING_OFFSET_DEGREES = -90;
