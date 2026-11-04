import { Workspace } from "@rbxts/services";

/** **Placeholder.** How much of the viewport a panel may fill before it is clamped, per axis. */
const DEFAULT_MAX_FRACTION = new Vector2(0.92, 0.88);

/**
 * Holds a panel inside the viewport, and keeps holding it there as the screen changes size.
 *
 * ## Why a constraint is needed at all
 *
 * A panel sized in pixels is comfortable on a desktop and can be **wider than the whole screen** on a phone, and no
 * pixel maximum catches every device. `UISizeConstraint` takes plain `Vector2` pixels — there is no `Scale` form of
 * it — so a cap written as "92% of the screen" has to be evaluated against a screen and re-evaluated whenever that
 * screen is a different size. Which happens more often than it sounds: a phone rotated, a desktop window dragged
 * narrower, a tablet in split view.
 *
 * ## Why the camera is read now and then watched
 *
 * `ViewportSize` is the only honest answer to "how big is the screen". Computing the cap once at mount would describe
 * the screen the panel was built on rather than the one it is on — the same class of bug as a `Position` captured
 * from a viewport that has since changed.
 *
 * **A missing camera is not an error.** There is no viewport to read before one exists, so the panel keeps whatever
 * size it was given. That is the graceful answer for the one moment it can happen rather than a reason to fail the
 * mount.
 *
 * The connection is kept for the lifetime of the instance: it is made once, it is cheap, and a panel lives as long as
 * its `ScreenGui` does.
 */
export function capToViewport(frame: GuiObject): UISizeConstraint | undefined {
	const camera = Workspace.CurrentCamera;
	if (camera === undefined) {
		return undefined;
	}

	const constraint = new Instance("UISizeConstraint");
	constraint.MaxSize = new Vector2(
		camera.ViewportSize.X * DEFAULT_MAX_FRACTION.X,
		camera.ViewportSize.Y * DEFAULT_MAX_FRACTION.Y,
	);
	constraint.Parent = frame;

	camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
		if (frame.Parent === undefined) {
			return;
		}

		constraint.MaxSize = new Vector2(
			camera.ViewportSize.X * DEFAULT_MAX_FRACTION.X,
			camera.ViewportSize.Y * DEFAULT_MAX_FRACTION.Y,
		);
	});

	return constraint;
}
