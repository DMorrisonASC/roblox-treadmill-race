/**
 * The zone-wide `motionBlur` effect's two rules, as data: **what a phase change should do, and whose fade-out it is.**
 *
 * ## Why these are not four `if`s inside the controller
 *
 * The controller cannot be constructed in this runtime — it reaches `CollectionService`, `Workspace` and a `ScreenGui`-free
 * but still engine-bound `TweenService` — so a rule written inside it can only be checked by playing three rounds in a row
 * and watching. That is precisely the round this effect is hardest to get right in: `Playing → PostGame → Playing` in quick
 * succession is the sequence where a stale fade-out destroys the *next* round's clone, and it is invisible in any single
 * round. Two functions over plain values make both halves assertions instead of observations — the same argument
 * `round-outcome` and `apparent-spin` carry.
 *
 * The pattern is `shared/apparent-spin.ts`'s: a rule a **client** controller obeys, living in `shared/` because it is pure
 * and because the spec for it lives beside it.
 */

/** The one phase the effect belongs to. A client cannot import the server's `RoundPhase`. */
export const MOTION_BLUR_PHASE = "Playing";

/** What a phase change should do to the effect. */
export type MotionBlurAction = "show" | "hide" | "nothing";

/**
 * **Placeholder.** How long the `Rate` ramp takes, in seconds — up on `Playing` entry and down when the phase leaves.
 *
 * `0.5` is short enough that the effect is present for the first meaningful second of a round and long enough that it reads
 * as a fade rather than as a switch. It is one number for both directions on purpose: a fade-in and a fade-out of different
 * lengths is a thing designers ask for later, not something to guess at now, and splitting it early would invite the two to
 * drift the way item 101's two scale constants did.
 */
export const MOTION_BLUR_FADE_SECONDS = 0.5;

/**
 * **Placeholder.** The designer's trim **on top of the zone-fitted scale**: `1` means the effect exactly covers the
 * `EliminationZone`, and anything else is a deliberate enlargement or shrink of that.
 *
 * ## What changed (item 192), and what the old number meant
 *
 * This used to be the clone's **own size**: `1` meant "the authored geometry, unchanged", on the argument that the asset was
 * authored *in place* around the zone. It was not — or at least not on this scene. The `show` line reported `scale=1` and the
 * reported result was a haze the size of the authored part inside an `EliminationZone` **262 studs long** (`depth=52.4` at the
 * old `MOTION_BLUR_DEPTH_FRACTION = 0.2`). A number whose meaning is "whatever the asset happens to be" cannot fill a fixture,
 * so the size is now derived from the zone (`motionBlurFillRatio`) and this constant is the trim on top of it.
 *
 * ## Why this is not `effectScaleFor(ball)`, and why it is not `VFX_SCALE_MULTIPLIER`
 *
 * `effectScaleFor(ball, multiplier)` is `ball.Size.X / 2 / BASE_BALL_RADIUS * multiplier` — a **ball-relative** ratio whose
 * output at a 1-stud ball is a tenth of that effect's multiplier. It exists because the VFX pack was drawn against a
 * 0.5-stud radius and every trail has to be shrunk to fit a body. This effect is not drawn on a body: it is drawn around the
 * `EliminationZone`, which is tens of studs across and was authored *in place*. Feeding it a ball ratio would render it at a
 * tenth of its designed size, and there is no ball anywhere in this controller to read a radius from.
 *
 * The other tempting number, the ball effects' multiplier, is the worse one — and since item 177 there is no single one to
 * reach for: each ball effect has its own in `shared/config/`. Reusing any of them here would silently couple a zone overlay
 * to a ball effect: retuning a trail would resize the arena effect, and nobody looking at either number would know.
 *
 * **It takes no heading offset either** (item 178). `motionBlurCloneFrame` composes a position from the `EliminationZone` and
 * a rotation **from the asset**, so a "belt-ward + N degrees" offset would have nothing to be relative to — the effect is not
 * aimed at the belt's start and never was. The lever a designer already has works here and does not work on the trails:
 * rotating this asset in Studio **is** honoured, because this clone keeps the authored rotation. So the answer for this
 * effect is "rotate the asset", and adding an offset would create a second, conflicting knob over the same property.
 *
 * **Its reference length is the zone, which is why it is not in a ball-relative config.** Every ball effect scales
 * `ballRadius / BASE_BALL_RADIUS * multiplier`, so its number means "design radii above a 0.5-stud ball". This one has no ball:
 * its base is `motionBlurFillRatio(zone.Size, …)` — the scale at which the authored box covers the zone — so `1` means "the
 * zone, exactly" and `2` means "twice the zone". That is a meaningful reference and it is not a length, which is why it stays
 * here beside the ramp constants rather than in a fourth config file holding a number already documented below it.
 *
 * So the multiplier is local, **ships at `0.5`** (half the zone - the designer trimmed it down from the `1` this sentence
 * used to claim, item 204), and is applied through `scaleEffect` — the shared five-property
 * implementation — rather than by writing a second scale routine. A designer who wants the effect bigger changes this one
 * number and nothing else moves.
 */
export const MOTION_BLUR_SCALE = 0.5;

/**
 * How far a box of `size`, turned by `basis`, reaches along the **world** direction `direction`.
 *
 * ## Why the projection is needed at all
 *
 * The clone keeps the asset's **authored rotation** (item 142), so the asset's local axes and the zone's local axes are two
 * different bases. "Fill the zone" is a statement about the *zone's* axes, and reading `asset.Size.X` as if it were the zone's
 * width is how a rotated asset gets scaled against the wrong dimension — the same class of mistake `PICKUP_X_MIN` made by
 * being a world-axis number on a belt that can be turned (item 191).
 *
 * For a box, the extent along a direction is the sum of its three half-axis projections:
 * `|Sx·(basis.XVector·d)| + |Sy·(basis.YVector·d)| + |Sz·(basis.ZVector·d)|`. That is exact for any rotation, needs no case
 * analysis, and is one expression.
 */
export function extentAlong(size: Vector3, basis: CFrame, direction: Vector3): number {
	return (
		math.abs(size.X * basis.XVector.Dot(direction)) +
		math.abs(size.Y * basis.YVector.Dot(direction)) +
		math.abs(size.Z * basis.ZVector.Dot(direction))
	);
}

/**
 * The uniform scale at which an authored box **covers the zone in every axis**: the largest of the three per-axis ratios.
 *
 * ## Why the largest, and not one named axis
 *
 * The complaint this answers is "does not fill the entire zone", so the target is *coverage*, and coverage has three tests.
 * Taking the largest ratio means no axis is ever left short; the cost is overshoot on the others, which for a soft haze means
 * particles spilling past the boundary rather than a visible gap inside it. Taking the **smallest** ratio would fit the box
 * inside the zone on every axis and leave all three short once the asset's aspect differs from the zone's — the failure that
 * was reported, on purpose.
 *
 * **Why one uniform ratio rather than three.** `scaleEffect` multiplies a scalar: a `ParticleEmitter`'s `Size` is a diameter
 * and its `Speed` a magnitude, so there is no anisotropic form of "a bigger puff along `X`". A per-axis scale would have to
 * leave the emitters disagreeing with the part they hang on.
 *
 * ## The guard, and why a flat axis is skipped rather than clamped
 *
 * A zero-thickness part — a sheet, which a haze asset may well be — has no extent on its thin axis, and there is nothing to
 * fill there. Dividing by it (even by a `1e-3` floor) would scale the effect by thousands of times and fill the arena's
 * interior with noise. So an axis with no geometry is **not a constraint and is skipped**; if every axis is degenerate the
 * answer is `1` (authored), which renders small — a visible bug someone reports, rather than an effect nobody can see past.
 */
export function motionBlurFillRatio(zoneSize: Vector3, extents: Vector3): number {
	const zone = [zoneSize.X, zoneSize.Y, zoneSize.Z];
	const extent = [extents.X, extents.Y, extents.Z];

	let largest = 0;
	for (let index = 0; index < zone.size(); index++) {
		if (extent[index] <= 1e-3) {
			continue;
		}

		largest = math.max(largest, zone[index] / extent[index]);
	}

	if (!(largest > 0) || largest === math.huge) {
		return 1;
	}

	return largest;
}

/**
 * **The clone's `CFrame`: position from the zone, rotation from the asset** — and, since item 192, **the zone's centre.**
 *
 * ## Why the depth machinery is gone rather than set to `0.5` (item 192)
 *
 * Items 141-143 argued at length about *where in the box* a small haze should sit: on the front face (item 141, which put it
 * outside), then a fraction of the length in from it (item 143). Both were answers to "a small cloud must not look like it is
 * floating outside the arena", and both presupposed that the cloud was **smaller than the box**.
 *
 * Item 192 made the effect the size of the zone (`motionBlurFillRatio`). A zone-sized volume has exactly one position that
 * fills the zone: its centre. A fraction whose only correct value is `0.5` is a knob that can only be set wrong, and the anchor
 * that resolved it — `motionBlurAnchor`, `MOTION_BLUR_DEPTH_FRACTION`, `motionBlurDepthStuds`, and the four spec cases pinning
 * them — had become arithmetic that multiplies out to zero. This tree deletes inert values rather than leaving them at a value
 * that happens to work (item 190's rule), so they are gone.
 *
 * **The history is kept here rather than in the code it used to explain**, because the trap it documents is still live: a
 * *smaller* effect (`MOTION_BLUR_SCALE < 1`) at the zone's centre is the effect item 140 shipped and item 141 was asked to
 * move. If the designer ever wants the haze pushed toward one end, that wants a new, stated rule — not the resurrection of a
 * fraction that was only right because the effect was once smaller than the box.
 *
 * ## Why this is a function rather than a line in the controller
 *
 * The rule — *which rotation wins* — is a property of the effect, not of the order a controller happens to construct things in,
 * and the controller cannot be built in this runtime (`CollectionService`, `Workspace`, `TweenService`). Keeping the
 * composition here means the regression that matters can be asserted: an edit that "simplifies" this back to
 * `zoneFrame.mul(assetRotation)`, or to a clone that inherits the zone's basis, compiles, lints, and renders the effect at the
 * wrong angle while every other test in the tree still passes. `motionBlurActionFor` and `generationOwnsFadeOut` live here for
 * the same reason (item 140).
 *
 * ## Why `new CFrame(position).mul(rotation)` and not the two shorter spellings
 *
 * - `zoneFrame.mul(assetRotation)` — the bug item 142 fixed. It composes the **zone's** basis into the asset's, so a zone
 *   rotated 90 degrees turns the effect 90 degrees further than the designer intended. This is exactly what shipped in item 141
 *   and what the user saw.
 * - `zoneFrame.Rotation.mul(assetRotation)` — the same bug written more explicitly.
 * - `new CFrame(zoneFrame.Position).mul(assetRotation)` — a translation frame, then the asset's basis on top of it. The result's
 *   rotation is the asset's *exactly* (multiplying by an identity basis is exact in floating point), and its position is the
 *   zone's. Both halves come from the source that knows them.
 *
 * **The zone's rotation is therefore visible only through its position**, never through the clone's orientation — which is what
 * makes "rotate the zone in Studio" mean "the effect travels with the fixture" rather than "also spin the particles".
 */
export function motionBlurCloneFrame(zoneFrame: CFrame, assetRotation: CFrame): CFrame {
	return new CFrame(zoneFrame.Position).mul(assetRotation);
}

/**
 * What a phase change should do, given the phase now and whether a clone is currently alive.
 *
 * ## The rule is one line, and it is "Playing or nothing"
 *
 * `Playing` always shows — **including** `Playing → Playing`, which is debug key 3 (item 38). That restart is a new round as
 * far as this effect is concerned: the competitors are rebuilt, so the overlay is destroyed and rebuilt rather than resumed,
 * and its `Rate` starts again at 0. It is item 139's precedent for the round song, applied to a world effect.
 *
 * Everything else hides **if something is showing**, and does nothing otherwise. Written that way rather than as three
 * named phases because the requirement is an invariant — *visible only during `Playing`* — and enumerating `PostGame`,
 * `Intermission` and `Waiting` would be an invariant with three holes in it. A `Playing → Waiting` jump (debug key 2) leaves
 * through a phase the brief's prose forgot and its acceptance criteria did not; the one-line rule covers it, and a future
 * fifth phase is covered the day it is added.
 *
 * `nothing` when nothing is showing is what keeps `Intermission → Waiting → Playing` from logging two hide lines with no
 * effect behind them: a fade-out is only ever started by leaving `Playing`.
 */
export function motionBlurActionFor(phase: string, showing: boolean): MotionBlurAction {
	if (phase === MOTION_BLUR_PHASE) {
		return "show";
	}

	return showing ? "hide" : "nothing";
}

/**
 * Whether a fade-out that was scheduled in round `scheduled` still owns the clone it means to destroy.
 *
 * ## Why the guard exists, and what it protects
 *
 * A fade-out is not instant: it tweens `Rate` to 0 over `MOTION_BLUR_FADE_SECONDS` and only then destroys the tree. Between
 * the two, the phase can come all the way back round — `Playing → PostGame → (five seconds) → … → Playing` is under six
 * seconds, and a debug key does it in one. If the pending callback fired blind it would destroy the **new** round's clone a
 * fraction of a second after it faded in, and the effect would appear to switch itself off at random.
 *
 * The generation is bumped **only on `Playing` entry**, never on the fade-out, because the fade-out does not begin a new
 * round: it ends the old one. That is what makes `!==` the right test rather than `>`, and it is why the same number is
 * used for the log lines on both sides — `hide generation=3` and `destroyed generation=3` are one clone's story, and a
 * `destroy early (restart) generation=3` beside `show generation=4` is a different one.
 *
 * The controller also keeps an identity check (`this.current !== record`) beside this one. They are not redundant in the way
 * duplicated conditions usually are: this compares a number that survives the record being replaced, and the identity check
 * catches a record replaced *without* a bump — which the current code cannot do, and which a later edit could. Two cheap
 * tests, one invariant.
 */
export function generationOwnsFadeOut(current: number, scheduled: number): boolean {
	return current === scheduled;
}
