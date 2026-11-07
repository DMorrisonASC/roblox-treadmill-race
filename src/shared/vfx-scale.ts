import { BASE_BALL_RADIUS, VFX_SCALE_MULTIPLIER } from "./tuning";

/**
 * How a cloned VFX asset is scaled onto a ball: **one implementation, shared by every effect controller.**
 *
 * ## Why this module exists (item 101)
 *
 * `windBoost` and `tailWind` were written a round apart and each carried its own copy of this arithmetic and its own
 * `*_SCALE_MULTIPLIER`. The copies diverged — `windBoost` was tuned down to `0.1` while `tailWind` was still `1` — and the
 * visible result was a tail-wind effect **ten times the size of the boost effect on the same ball**. That is precisely the
 * failure a copied constant produces: both files look right, both build, and the difference is only visible on screen.
 *
 * Sharing the *function* but not the *number* would not have prevented it, so both are here: `effectScaleFor` is the only
 * place a clone's scale is decided, and `VFX_SCALE_MULTIPLIER` is one number in `tuning.ts`. **A future effect that genuinely
 * wants a different size should add a deliberate multiplier argument at its own call site and say why in a comment** — not fork
 * this file.
 *
 * ## Why the scale is derived from the ball at all
 *
 * The pack was authored against a 1x1x1 ball (`BASE_BALL_RADIUS`), so every distance in a clone has to be multiplied by the
 * ratio between the real ball's radius and that one. That is what lets a designer change `Size` in `ball-spawner-service`
 * without touching an asset or a controller.
 */

/**
 * The multiplier to apply to a cloned effect for one ball: the ball's radius over the pack's design radius, times the one
 * shared effect multiplier.
 *
 * `ball.Size.X / 2` is the radius because the pool is spheres-only (item 12). A body whose `Size` has not replicated reads
 * `0`, and `(0 / 0.5) * 0.1` is `0` — a clone scaled to nothing, which is the honest degradation: an effect at zero scale is
 * invisible rather than a hundred-stud smear across the arena. The next tick cannot fix it because the scale is applied once,
 * at attach, so `attach` in each controller is guarded by the attribute transition rather than retried — accepted, because a
 * body whose `Size` has not replicated cannot yet be rendered either.
 */
export function effectScaleFor(ball: BasePart): number {
	if (!(BASE_BALL_RADIUS > 0)) {
		return VFX_SCALE_MULTIPLIER;
	}

	return (ball.Size.X / 2 / BASE_BALL_RADIUS) * VFX_SCALE_MULTIPLIER;
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
