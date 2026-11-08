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
 * **Placeholder.** The multiplier applied to the clone's authored size. `1` means **the asset exactly as authored**.
 *
 * ## Why this is not `effectScaleFor(ball)`, and why it is not `VFX_SCALE_MULTIPLIER`
 *
 * `effectScaleFor` is `ball.Size.X / 2 / BASE_BALL_RADIUS * VFX_SCALE_MULTIPLIER` — a **ball-relative** ratio whose output
 * at a 1-stud ball is `0.1`. It exists because the VFX pack was drawn against a 0.5-stud radius and every trail has to be
 * shrunk to fit a body. This effect is not drawn on a body: it is drawn around the `EliminationZone`, which is tens of studs
 * across and was authored *in place*. Feeding it a ball ratio would render it at a tenth of its designed size, and there is
 * no ball anywhere in this controller to read a radius from.
 *
 * `VFX_SCALE_MULTIPLIER` is the other tempting number and the worse one. Its docblock argues that it is one number for one
 * *kind* of effect — the ball trails — and that the whole point of sharing it is that the two trails cannot drift apart
 * (item 101). Reusing it here would silently couple a zone overlay to two ball effects: retuning the trails would resize the
 * arena effect, and nobody looking at either number would know.
 *
 * So the multiplier is local, defaults to `1` (authored), and is applied through `scaleEffect` — the shared five-property
 * implementation — rather than by writing a second scale routine. A designer who wants the effect bigger changes this one
 * number and nothing else moves.
 */
export const MOTION_BLUR_SCALE = 1;

/**
 * **Placeholder.** How far from the zone's **front face** toward its back the effect sits, as a **fraction of the zone's
 * length**. `0` is the face itself, `0.5` the centre, `1` the back face.
 *
 * ## Why this is a fraction and not the studs inset it used to be
 *
 * Item 141 introduced `MOTION_BLUR_INSET_STUDS = 0` — "exactly on the front face" — and that is what put the effect **outside**
 * the box. The face is a *boundary*, not a place: the clone's origin sat on the wall, its emitters sprayed outward from there,
 * and the visible result was a haze floating in the air in front of the arena with nothing behind it. A point on a boundary
 * divides its own cloud in half, and no amount of "it is at the front, as asked" makes that read as inside.
 *
 * A studs value would fix *this* zone and then need re-deriving the moment the fixture was resized, because what has to stay
 * inside is a proportion of the box. The fraction travels with the fixture: resize the zone and the effect stays the same
 * distance *along* it.
 *
 * ## Why 0.2, and what to change if it is wrong
 *
 * A fifth of the way in is far enough that the effect reads as belonging to the arena rather than as a pane in front of it,
 * and near enough the front that it does not become the all-over haze item 141 was fixing. It is a **guess made without the
 * asset's dimensions**, which is why the `show` line prints `depth=` in studs: if the cloud still pokes out, raise this; if it
 * sits too deep, lower it. The number that is *right* is the one where the cloud's leading edge lands just inside the boundary,
 * and only a playtest can measure that.
 */
export const MOTION_BLUR_DEPTH_FRACTION = 0.2;

/**
 * How far the effect sits from the zone's front face, **in studs** — the one definition of that number.
 *
 * Exported so the `show` log can report the resolved depth without recomputing the product at the call site: a log that worked
 * the number out its own way would be a second answer to "how far in did it go", and the two would disagree the first time the
 * fraction was tuned.
 */
export function motionBlurDepthStuds(zoneLengthStuds: number): number {
	return zoneLengthStuds * MOTION_BLUR_DEPTH_FRACTION;
}

/**
 * Where the clone is placed: **inside the zone, near its front**, in the zone's own frame.
 *
 * ## Which end "front" is, and why that is not a guess
 *
 * Front is `-X`. The tree's own axis rule is `+X` = toward the exit and elimination, `-X` = the front and the spawn edge, and
 * bodies are placed at a negative belt-frame `X`. The zone is checked against with `PointToObjectSpace` in
 * `RoundService.isInsideZone`, so "the zone's local `-X`" is the same axis the round itself uses to decide which end of the box
 * a body is nearest — one definition, two readers.
 *
 * ## It is a fraction of the box, not a coordinate
 *
 * A constant like `x = 0` names a position in whatever frame the reader happens to be thinking in. This names a position
 * **relative to the fixture** — see `MOTION_BLUR_DEPTH_FRACTION` for why the depth is proportional, and for why the version
 * that sat exactly on the face put the effect outside the arena.
 *
 * ## Why a function rather than a `CFrame` expression at the call site
 *
 * Because the anchor is the one part of this effect that is a *position in the world* rather than a value, and it is the part
 * most likely to be re-argued (face, a fifth in, centre, an inset in studs). As a pure function over a `CFrame` and a length it
 * is asserted in `motion-blur.spec.ts` — that the depth is a fraction of the length, that `Y` and `Z` do not move, and that the
 * offset is composed in the **zone's** basis. A call site that composed the offset by hand could get any of those three wrong and
 * no build would notice; a wrong one here fails a test.
 *
 * ## What this returns, and what the clone does with it (rewritten twice — items 142 and 143)
 *
 * It returns a full `CFrame`: the offset is composed in the zone's local space, so the **result's rotation is the zone's**. That
 * is correct *here* — it is what puts the position on the right side of a turned box - and it is no longer what the clone uses.
 *
 * Item 141 argued the opposite of that last clause, and the correction is kept rather than deleted because it is the trap: it
 * said the clone should take "the zone's orientation rather than the asset's authored one, which is the opposite of item 97's
 * rule". The first half of the reasoning was sound and the conclusion was wrong: a fixture gives a stable *position* and has no
 * opinion about which way a **particle asset** was drawn. The asset's author rotated it in Studio precisely so it would render
 * that way, and only the asset knows it. So `motionBlurCloneFrame` takes this anchor's **position** and the asset's
 * **rotation**, and this function's own `Rotation` is unused by the clone.
 *
 * It stays a `CFrame` rather than becoming a `Vector3` because its rotation is the thing the spec asserts — "the offset is
 * composed in the zone's frame" is only checkable through the resulting basis, and a position-only return would make that case
 * vacuous.
 */
export function motionBlurAnchor(zoneFrame: CFrame, zoneLengthStuds: number): CFrame {
	// `CFrame.mul` with a translation composes in the zone's **local** space, so this is "-X by half the box, then back in by
	// the depth fraction" along the zone's own axis whether the zone is axis-aligned or not.
	return zoneFrame.mul(new CFrame(-(zoneLengthStuds / 2) + motionBlurDepthStuds(zoneLengthStuds), 0, 0));
}

/**
 * **The clone's `CFrame`: position from the anchor, rotation from the asset.** Item 97's composition, applied to a
 * fixture-anchored clone instead of a body-anchored one.
 *
 * ## Why this is a second function rather than a line in the controller
 *
 * The rule — *which rotation wins* — is a property of the effect, not of the order a controller happens to construct things in,
 * and the controller cannot be built in this runtime (`CollectionService`, `Workspace`, `TweenService`). Keeping the
 * composition here means the regression that matters can be asserted: an edit that "simplifies" this back to
 * `anchor.mul(assetRotation)` compiles, lints, and renders the effect at the **zone's** orientation while every other test in
 * the tree still passes. `motionBlurActionFor` and `generationOwnsFadeOut` live here for the same reason (item 140).
 *
 * ## Why `new CFrame(position).mul(rotation)` and not the two shorter spellings
 *
 * - `anchor.mul(assetRotation)` — the bug. It composes the **zone's** basis into the asset's, so a zone rotated 90 degrees turns
 *   the effect 90 degrees further than the designer intended. This is exactly what shipped in item 141 and what the user saw.
 * - `anchor.Rotation.mul(assetRotation)` — the same bug written more explicitly.
 * - `new CFrame(anchor.Position).mul(assetRotation)` — a translation frame, then the asset's basis on top of it. The result's
 *   rotation is the asset's *exactly* (multiplying by an identity basis is exact in floating point), and its position is the
 *   anchor's. Both halves come from the source that knows them.
 *
 * **The zone's rotation is therefore visible only through the anchor's position**, never through the clone's orientation — which
 * is what makes "rotate the zone in Studio" mean "slide the effect round the fixture" rather than "also spin the particles".
 */
export function motionBlurCloneFrame(zoneFrame: CFrame, zoneLengthStuds: number, assetRotation: CFrame): CFrame {
	const anchor = motionBlurAnchor(zoneFrame, zoneLengthStuds);
	return new CFrame(anchor.Position).mul(assetRotation);
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
