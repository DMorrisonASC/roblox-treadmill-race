import { TweenService } from "@rbxts/services";

/** **Placeholder.** The scale a clickable control grows to under the pointer. */
const HOVER_SCALE = 1.03;

/** **Placeholder.** The scale it shrinks to while pressed — below rest, so a press reads as pushing *in*. */
const PRESS_SCALE = 0.97;

/** **Placeholder.** The scale it returns to. */
const REST_SCALE = 1;

/**
 * The three tweens, stated once so the durations are a single edit.
 *
 * Hover and press are both `0.1 s`; the return is `0.15 s`. The asymmetry is deliberate: arriving at a scale is
 * feedback and wants to feel immediate, while returning is the eye catching up — a release as fast as the press
 * reads as a flicker rather than as settling.
 */
const HOVER_TWEEN = new TweenInfo(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const PRESS_TWEEN = new TweenInfo(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const RETURN_TWEEN = new TweenInfo(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

/**
 * Attaches the restrained hover-and-press scale to a button, and returns the `UIScale` it drives.
 *
 * ## Why this is a function and not a builder
 *
 * Every clickable control in the panels wants the same three tweens, and none of them wants anything else. Making
 * it a builder would mean either a `Control` abstraction that has to know whether it is a tab, a tile or a close
 * button — the flag rule 8 warns about — or four copies of the same eight lines. A function that takes a button
 * and adds one child is the smallest thing that is neither.
 *
 * ## Why `UIScale` and not a size tween
 *
 * Scaling does not change the control's layout box, so pressing one tile in a grid cannot nudge its neighbours.
 * A size tween would re-flow everything laid out around it, which for a grid means the whole shelf moves under a
 * click.
 *
 * **One `UIScale` for the life of the control.** Every event retargets the same instance rather than replacing it,
 * so a fast in-and-out cannot leave two scales fighting over one button.
 *
 * The caller is responsible for `AutoButtonColor = false`: the engine's own pressed tint would be a second piece of
 * feedback for one press, in a different visual language from the scale.
 */
export function attachPressFeedback(button: GuiButton): UIScale {
	const scale = new Instance("UIScale");
	scale.Scale = REST_SCALE;
	scale.Parent = button;

	const tweenTo = (target: number, info: TweenInfo) => {
		TweenService.Create(scale, info, { Scale: target }).Play();
	};

	button.MouseEnter.Connect(() => tweenTo(HOVER_SCALE, HOVER_TWEEN));
	button.MouseLeave.Connect(() => tweenTo(REST_SCALE, RETURN_TWEEN));
	button.MouseButton1Down.Connect(() => tweenTo(PRESS_SCALE, PRESS_TWEEN));
	// Back to hover rather than to rest: the pointer is still on the control when the button comes up, so rest
	// would be a scale the control never actually sits at.
	button.MouseButton1Up.Connect(() => tweenTo(HOVER_SCALE, RETURN_TWEEN));

	return scale;
}
