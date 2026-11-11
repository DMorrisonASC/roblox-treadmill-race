import { BASE_BALL_RADIUS } from "./tuning";

/**
 * How a cloned VFX asset is scaled onto a ball: **one implementation, and one tuner per effect.**
 *
 * ## Why this module exists (item 101)
 *
 * `windBoost` and `tailWind` were written a round apart and each carried its own copy of this arithmetic and its own
 * `*_SCALE_MULTIPLIER`. The copies diverged — `windBoost` was tuned down to `0.1` while `tailWind` was still `1` — and the
 * visible result was a tail-wind effect **ten times the size of the boost effect on the same ball**. That is precisely the
 * failure a copied constant produces: both files look right, both build, and the difference is only visible on screen.
 *
 * ## What item 177 changed, and why this paragraph is rewritten rather than deleted
 *
 * Item 101's answer was to hoist the **function and the number** into one place: `effectScaleFor` here, and a single
 * `VFX_SCALE_MULTIPLIER` in `tuning.ts`, with a note that a future effect wanting a different size should pass a deliberate
 * multiplier at its own call site. That answer was right about the function and wrong about the number, for a reason item 101
 * could not see from where it stood: it was looking at two effects that *should* look alike, and the third effect that
 * arrived later — the hit burst — should **not** be resized by a decision about the trails. One shared number meant
 * "make the burst legible" also widened both trails, and the value was left untouched twice for exactly that reason.
 *
 * So the function stays shared and the number is now a **parameter**: `effectScaleFor(ball, multiplier)` and
 * `effectScaleForRadius(radius, multiplier)`. Each effect passes its own, from its own config file
 * (`shared/config/windBoost.config.ts`, `tailWind.config.ts`, `hitEffect.config.ts`). `VFX_SCALE_MULTIPLIER` is deleted
 * rather than left at `0.1` for a default, because a default is what let a caller forget to choose.
 *
 * **The drift item 101 was protecting against is now structurally impossible in the direction that mattered**, and this is
 * the part worth keeping straight: there is still exactly one implementation of "multiply a clone's distances", so two
 * effects cannot disagree about *how* to scale. They are allowed to disagree about *how much*, and a reader who wants to know
 * which is which has three small files to read instead of one number with three callers.
 *
 * ## Why the scale is derived from the ball at all
 *
 * The pack was authored against a 1x1x1 ball (`BASE_BALL_RADIUS`), so every distance in a clone has to be multiplied by the
 * ratio between the real ball's radius and that one. That is what lets a designer change `Size` in `ball-spawner-service`
 * without touching an asset or a controller. `BASE_BALL_RADIUS` therefore **stays in `tuning.ts`**: it is the shared divisor,
 * the one thing all three effects must agree on, and a copy per config would let them disagree about what a design radius is.
 */

/**
 * The direction every directional ball effect faces: **toward the belt's start**, which is the opposite of the elimination
 * edge.
 *
 * ## The arithmetic, from `stepBallSpeeds`
 *
 * That loop writes the along-belt velocity as `right.mul(-relative)` with `right = belt.CFrame.RightVector` and
 * `relative = BALL_SPEED - BELT_SPEED`. A ball's speed only decays, so `relative` is negative for most of a ride and
 * `-relative` is positive: the velocity points along **`+RightVector`**, which is therefore the **elimination** direction.
 * The log confirms it on the current scene — `rightVector = (0, 0, -1)` and a body's belt-local X runs from `-135` at spawn
 * to `+168` at the exit — so start-ward is `-RightVector`.
 *
 * ## Why this is a function of the belt's frame and not of world `+X`
 *
 * The belt fixture has changed axes between rounds (an earlier belt ran along X; this one runs along `-Z`). A sign written
 * against world axes would be silently inverted on the next scene, which is exactly the class of bug this helper exists to
 * prevent. Every consumer asks the belt, and the belt answers in its own basis.
 *
 * ## Why it is not "the direction the ball is travelling"
 *
 * A shove or a hit can send a ball backwards, and the effect must not flip when that happens. The direction is a property
 * of the **arena**, not of the body: the effect is decorative and points home regardless.
 */
export function vfxForward(beltCFrame: CFrame): Vector3 {
	return beltCFrame.RightVector.mul(-1);
}

/**
 * The transform a ball-attached effect should take: **the ball's position, the belt's forward direction, the asset's own
 * tilt.**
 *
 * ## What replaces item 97's rule, and why
 *
 * Item 97 established that a trail takes position from the ball and rotation from the asset, because a ball's rotation is
 * a per-body accident (a random spawn tumble, then rolling) and copying it made the effect spin. That half still holds:
 * the ball's own rotation is never read here.
 *
 * The other half — that the asset's **yaw** is the effect's orientation — does not, and item 176 overrides it. The asset
 * was authored pointing somewhere arbitrary inside `ReplicatedStorage`, so every trail pointed wherever its author happened
 * to leave it. The yaw now comes from the belt, and the asset contributes only its **tilt**, passed as `lookAlong`'s `up`.
 *
 * **What that costs, stated:** an up vector is only meaningful perpendicular to a look direction, so the component of the
 * asset's `UpVector` that points along the new forward is projected away. For an asset authored flat — up `+Y`, forward
 * horizontal, which is what the trails are — that projection is a **no-op** and the authored tilt survives exactly. For an
 * asset authored with a deliberate *pitch* into its forward axis, the pitch is partly straightened. A plain
 * `CFrame.lookAt`/`lookAlong` with the default up would instead force world up and lose the roll in every case, which is
 * why the asset's own `UpVector` is passed.
 *
 * ## Why `lookAlong` and not a hand-built basis
 *
 * `CFrame.lookAlong(at, direction, up)` is `CFrame.lookAt(at, at + direction, up)` — verified in the installed typings — and
 * it is the one call whose name says what is wanted. Building three basis vectors by hand would repeat the same
 * orthonormalisation with more places to get the sign wrong.
 *
 * ## The degenerate case
 *
 * `up` parallel to `forward` has no defined roll, and `lookAlong` would return an arbitrary rotation. That happens if an
 * asset was authored standing on end relative to the belt. The fallback drops the asset's tilt and uses the default up,
 * which is the same choice the engine makes; a missing roll is a smaller fault than a `NaN` basis.
 */
export function vfxFrameFor(position: Vector3, forward: Vector3, authored: CFrame): CFrame {
	if (forward.Magnitude < 1e-3) {
		return new CFrame(position).mul(authored);
	}

	const direction = forward.Unit;
	const up = authored.UpVector;

	if (up.Cross(direction).Magnitude < 1e-3) {
		return CFrame.lookAlong(position, direction);
	}

	return CFrame.lookAlong(position, direction, up);
}

/**
 * What an offset does to this function's result, since the two are composed by the caller: `vfxFrameFor` fixes the forward
 * axis and the up, and `vfxHeadingOffset(result, degrees)` then turns that whole frame about **the frame's own** up. With no
 * offset the frame above is used unchanged, so every effect keeps pointing home until a designer sets a number in its config.
 * An offset is a *heading*, not a correction of the asset: the composition never consults the asset's own yaw, so "this
 * asset was authored 90 degrees wrong" and "this effect should point 90 degrees off belt-ward" are the same number only by
 * coincidence. See `vfxHeadingOffset`.
 */

/**
 * Turns a composed frame about **its own vertical axis** by `degrees` — the per-effect heading offset (item 178).
 *
 * ## Why an offset exists at all
 *
 * `vfxFrameFor` composes a frame as "belt-ward forward, asset's up", which is what makes every trail point home and is
 * exactly why **rotating the asset in Studio about the vertical axis does nothing**: the yaw is the component the
 * composition replaces. A designer who wants one effect pointed off belt-ward therefore has no asset-side lever; the number
 * has to live in code. This is that number.
 *
 * ## Composition order, and which way a positive number turns
 *
 * `frame.mul(CFrame.Angles(0, rad(degrees), 0))` — **post**-multiplied, so the rotation is in the frame's **local** space and
 * the axis is the frame's own up, not world `+Y`. That is the whole reason for post-multiplication: a trail composed around a
 * tilted up vector must turn about *that* up, or the effect would lean as it turned. Pre-multiplying (`.mul` on the other
 * side) would rotate the world-space position as well, moving the effect off the ball.
 *
 * **Positive is a left turn on the vertical axis as the engine measures it**, stated as the literal it is: a frame facing
 * `-Z` (`LookVector = (0, 0, -1)`) turned by `+90` faces `-X` (`LookVector = (-1, 0, 0)`); by `-90` it faces `+X`. Put
 * differently, on a belt whose start is world `+Z`, an effect at `+90` points across the belt instead of down it. This is the
 * right-hand rule about `+Y` (`R_y(+90°)` maps `+Z` to `+X`), which is why `-90` and `+90` are the two "sideways" headings:
 * the four headings a designer should try first are `0` (home), `180` (away), `+90`, and `-90`.
 *
 * ## Zero returns the frame itself
 *
 * Not a recomposed frame that is numerically near-identical: `degrees === 0` returns the **same instance**, so "no offset" is
 * the default behaviour with no rounding noise and without a branch at every call site. `CFrame.Angles(0, 0, 0)` is not used
 * for that case precisely because it re-derives an identity rotation and would make a zero offset a *different* frame by
 * `Object.is`, which would be visible to a spec and to a reader asking whether anything moved.
 */
export function vfxHeadingOffset(frame: CFrame, degrees: number): CFrame {
	if (degrees === 0) {
		return frame;
	}

	return frame.mul(CFrame.Angles(0, math.rad(degrees), 0));
}

/**
 * The multiplier to apply to a cloned effect for one ball: the ball's radius over the pack's design radius, times **that
 * effect's own** multiplier.
 *
 * `multiplier` is required, not defaulted. A default would be one effect's number silently applying to another — the coupling
 * item 177 removed — and a required parameter means a new call site that forgets it fails to compile rather than drawing at
 * whatever the last decided value happened to be.
 *
 * `ball.Size.X / 2` is the radius because the pool is spheres-only (item 12). A body whose `Size` has not replicated reads
 * `0`, and `(0 / 0.5) * anyMultiplier` is `0` — a clone scaled to nothing, which is the honest degradation: an effect at zero
 * scale is invisible rather than a hundred-stud smear across the arena. The next tick cannot fix it because the scale is
 * applied once, at attach, so `attach` in each controller is guarded by the attribute transition rather than retried —
 * accepted, because a body whose `Size` has not replicated cannot yet be rendered either.
 */
export function effectScaleFor(ball: BasePart, multiplier: number): number {
	return effectScaleForRadius(ball.Size.X / 2, multiplier);
}

/**
 * The same arithmetic, from a radius rather than a body.
 *
 * Extracted so the hit burst can be sized from a **number carried on the remote** — a burst arrives where a contact
 * happened, and the two bodies that made it are not available to the client that draws it. One formula serves both a live
 * `BasePart` and a radius in a payload; a second copy of `radius / BASE_BALL_RADIUS * multiplier` written at the burst's call
 * site is exactly the drift item 101 removed.
 *
 * **The reference length is `BASE_BALL_RADIUS` for this function too.** The burst's radius arrives over the wire and the
 * trails' comes from a `BasePart`, but both are ball radii, so both numbers mean "design radii above a 0.5-stud ball" and the
 * same multiplier draws the same multiple of authored size. What differs is the *source* of the radius, not its meaning —
 * worth stating, because "a number that came from the server" reads like different units and is not.
 *
 * A non-positive radius (a body whose `Size` has not replicated, or an older server that sent nothing) returns `1` rather
 * than `0`: an unscaled burst is the honest degradation for "no size was reported", and it is visible rather than a
 * hundred-stud smear, which is the opposite trade from `effectScaleFor`'s zero. The difference is deliberate — a trail
 * with no size is attached to a body that cannot render yet, while a burst arrives after the contact. Note that this
 * fallback ignores `multiplier` on purpose: it means "unknown size", not "scaled by this effect's number".
 */
export function effectScaleForRadius(radius: number, multiplier: number): number {
	if (!(BASE_BALL_RADIUS > 0) || !(radius > 0)) {
		return 1;
	}

	return (radius / BASE_BALL_RADIUS) * multiplier;
}

/**
 * Scales one cloned effect by `ratio`, on **the five properties that are distances**.
 *
 * ## Why `Size` is not `emitter.Size = emitter.Size * ratio`
 *
 * `ParticleEmitter.Size` is a `NumberSequence`, not a number — `new NumberSequence(0.5, 1.5)` is a ramp, and a reader who
 * writes `emitter.Size = 2` gets a type error that reads as a mystery because the property *looks* like a scalar. Scaling it
 * means rebuilding the sequence: every `NumberSequenceKeypoint`'s `Value` **and** `Envelope` multiplied, with `Time` left alone
 * (time is not a distance). `NumberSequence` is immutable in the typings, so there is no in-place path.
 *
 * ## What is scaled, and why only these
 *
 * `Size` (`NumberSequence`), `Speed` (`NumberRange`), `Acceleration` (`Vector3`), `Attachment.Position` (`Vector3`) and the
 * clone's own root `Size` — every one of them is measured in studs. **`Rate`, `Lifetime`, `Color`, `Transparency`,
 * `LightEmission`, `Rotation`, `RotSpeed`, `SpreadAngle`, `EmissionDirection` and `Drag` are deliberately not scaled**: they
 * are design and time, not distance. A bigger ball wants the same effect stretched, not a denser or longer-lived one —
 * scaling `Rate` would make the trail thicker purely because the ball grew, which is a different effect rather than a larger
 * one.
 */
export function scaleEffect(root: BasePart, ratio: number): void {
	if (ratio === 1) {
		return;
	}

	root.Size = root.Size.mul(ratio);

	for (const descendant of root.GetDescendants()) {
		if (descendant.IsA("Attachment")) {
			descendant.Position = descendant.Position.mul(ratio);
		} else if (descendant.IsA("ParticleEmitter")) {
			const keypoints = new Array<NumberSequenceKeypoint>();

			for (const keypoint of descendant.Size.Keypoints) {
				keypoints.push(
					new NumberSequenceKeypoint(keypoint.Time, keypoint.Value * ratio, keypoint.Envelope * ratio),
				);
			}

			descendant.Size = new NumberSequence(keypoints);
			descendant.Speed = new NumberRange(descendant.Speed.Min * ratio, descendant.Speed.Max * ratio);
			descendant.Acceleration = descendant.Acceleration.mul(ratio);
		}
	}
}
