/**
 * The `sprinter` afterimage's own settings: what the asset is called in the place, and how big it draws.
 *
 * ## What the effect is
 *
 * A trailing copy of the ball that appears while a `sprinter` body is `Boosted` - i.e. from the moment it takes its pad
 * until its `BALL_SPEED` decays back through `BELT_SPEED - BOOST_HYSTERESIS`. That is a long window: `BALL_SPEED_DECAY_RATE`
 * is a couple of studs per second, so a sprinter at `SPRINTER_BOOST_SPEED` wears the trail for the rest of the round.
 * **That is the mechanic, not a bug** - shortening it here would be inventing a second duration rule that disagrees with
 * `Boosted`.
 *
 * ## Why this is its own file
 *
 * Item 177's rule: every ball effect owns its multiplier. `windBoost` and `tailWind` read the same value today and are
 * allowed to diverge, and a third effect that imported either of them would make the next "the boost trail is too big"
 * request quietly resize two others. The **formula** is shared - `effectScaleFor` in `shared/vfx-scale.ts` - because two
 * hand-copied implementations had already drifted tenfold apart once.
 */

/**
 * **Placeholder.** Whether the client builds the afterimage at all.
 *
 * A kill switch, not a size. The asset is authored in Studio and the agent cannot create it, so the first session after
 * this ships may well have no `sprinterAfterimage` instance in `ReplicatedStorage`; this value is how the effect is turned
 * off without deleting the controller that will be needed again.
 */
export const SPRINTER_AFTERIMAGE_ENABLED = true;

/** The asset's name in `ReplicatedStorage`, searched recursively. **An identity, not a `Placeholder.`** */
export const SPRINTER_AFTERIMAGE_ASSET_NAME = "sprinterAfterimage";

/**
 * **Placeholder.** The effect's own scale multiplier. `0.1` matches the two trails shipping today.
 *
 * The reference length is `BASE_BALL_RADIUS` (0.5 studs), so at a 20-stud ball this draws the clone at `2x` its authored
 * geometry - the same contract `windBoost` and `tailWind` document at length. Kept at `0.1` because a third trail at a
 * different size than the other two would be a design decision nobody asked for.
 */
export const SPRINTER_AFTERIMAGE_SCALE_MULTIPLIER = 0.1;

/**
 * **Placeholder.** The clone's heading, in degrees about its own up axis, measured from belt-ward. `-90` matches the two
 * trails.
 *
 * A trailing copy is read from behind, so it wants the same quarter turn `tailWind` uses; the four worth trying are
 * `0 / 90 / 180 / -90`.
 */
export const SPRINTER_AFTERIMAGE_HEADING_OFFSET_DEGREES = -90;
