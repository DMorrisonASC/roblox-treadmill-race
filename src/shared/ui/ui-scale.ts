import { Workspace } from "@rbxts/services";

/**
 * **Placeholder.** How much of the viewport a composition may fill, per axis.
 *
 * The same shape as `capToViewport`'s own fraction, and deliberately a little looser vertically: a sheet that fills 92% of the
 * width and 90% of the height still reads as an overlay, while going further looks like the panel *is* the screen.
 */
const MAX_FRACTION = new Vector2(0.92, 0.9);

/**
 * **Placeholder.** The smallest a composition is drawn at, as a fraction of its designed size.
 *
 * **This is a legibility floor, not a layout one**, and it is the one place the two requirements in the brief pull against each
 * other. A uniform `UIScale` shrinks type with everything else, so "the same composition, smaller" and "text stays readable"
 * cannot both hold all the way down: at `0.35` the sheet's captions (designed at 12) render at four points and are gone.
 *
 * `0.45` is where a phone in **landscape** — the orientation this game is played in — lands with room to spare (a 844 × 390
 * viewport fits an 880 × 466 store at `0.74`), so the floor only binds on a portrait phone, where the honest answer is that a
 * landscape composition shown on a portrait screen is small. Anything below this and the sheet is technically on screen and
 * practically unreadable, which is worse than being clipped: a clip is visible and reportable.
 */
export const MIN_PANEL_SCALE = 0.45;

/**
 * What scale a composition should be drawn at, given the viewport and its own designed size.
 *
 * ## The two rules, and why it takes a `Vector2` of each
 *
 * **Uniform, so the composition is preserved.** One number multiplies width, height, gaps, type and stroke together, which is
 * the whole point — a phone gets the *desktop arrangement*, smaller, rather than a rearranged one. Anything that scaled the
 * axes independently would squash the sheet and re-flow every band inside it.
 *
 * **The smaller axis wins.** A landscape phone is wide and short and a portrait one is narrow and tall; fitting by width alone
 * drops a landscape panel's bottom off the screen, and fitting by height alone overflows a portrait one. `min` is the only
 * answer that puts the whole composition on screen in both.
 *
 * **It never enlarges.** Above the reference the answer is `1`, because a 4K monitor showing a 2000-pixel store is a second
 * design nobody tuned; the panels are measured in pixels because those pixels *are* the design.
 *
 * ## Why it is pure
 *
 * Same argument as `songWrapTarget`, `countdownSteps` and `drawLobbyStart`: the rule is arithmetic and belongs in a spec, and a
 * function that read `Workspace.CurrentCamera` could not be asserted against literals. Everything impure — the camera, the
 * `UIScale`, the two signals — is in `applyPanelScale`.
 *
 * ## The zero cases
 *
 * A minimised window reports `0`; a panel mid-layout reports `0` height before `AutomaticSize` resolves. Both mean "not
 * saying" rather than "infinitely small", so an axis with no value is skipped and a design with no value at all answers `1`.
 * Without that guard the first frame of every auto-height panel would scale to nothing and then jump.
 */
export function panelScaleFor(viewport: Vector2, design: Vector2): number {
	let smallest = math.huge;

	if (viewport.X > 0 && design.X > 0) {
		smallest = math.min(smallest, (viewport.X * MAX_FRACTION.X) / design.X);
	}

	if (viewport.Y > 0 && design.Y > 0) {
		smallest = math.min(smallest, (viewport.Y * MAX_FRACTION.Y) / design.Y);
	}

	if (smallest === math.huge) {
		return 1;
	}

	return math.clamp(smallest, MIN_PANEL_SCALE, 1);
}

/**
 * Scales a whole composition to fit the screen, and returns the function that stops it.
 *
 * ## Why this replaces `capToViewport` on these panels rather than joining it
 *
 * **They would fight, and the constraint would win the wrong argument.** `UISizeConstraint` clamps *layout* size: given a
 * 880-pixel sheet and a 390-pixel viewport it sets the width to 358 and the height to whatever the height clamp says — which
 * squashes the composition horizontally and leaves every band inside it at its designed proportions, i.e. it produces exactly
 * the distortion the uniform scale exists to avoid. `UIScale` is a render transform, applied after layout, so the panel keeps
 * its design geometry and is drawn smaller. The two mechanisms answer the same question and only one of them can.
 *
 * The `Size` therefore stays the designed size on every screen: **no fixed width is removed, which is what "avoid fixed pixel
 * widths that overflow" is actually asking for.** An 880-pixel sheet does not overflow a 390-pixel screen when it is drawn at
 * `0.41`; it overflows when something clamps it to 358 wide and 466 tall and calls that fitting.
 *
 * ## Why the design size is read from the panel itself
 *
 * `UIScale` multiplies rendering and **does not touch `Size`**, so `root.Size`'s offsets are the design size in design pixels
 * at all times — including for an auto-height sheet, where `AutomaticSize.Y` writes the resolved content height back into
 * `Size.Y.Offset`. That is what lets one function serve six panels with no per-panel constants: the store's 880 × 466, the
 * picker's 640 × n, and a 240 × 52 toast all describe themselves.
 *
 * A panel that has not been laid out yet reports a `0` height, which `panelScaleFor` skips; the `Size` subscription recomputes
 * when the layout pass writes the real number, so the first frame converges without any special case.
 *
 * ## Why the connection is returned *and* wired to `Destroying`
 *
 * The payout panel is rebuilt once per round and a toast once per reward, so a camera connection that outlived its panel would
 * accumulate with every round and every reward — invisible until the session is long. The `Destroying` hook means the caller
 * that forgets still cleans up; the return value exists so the caller that remembers can be explicit.
 */
export function applyPanelScale(root: GuiObject, panel: string): () => void {
	const existing = root.FindFirstChild("PanelScale");
	let uiScale: UIScale;

	if (existing !== undefined && existing.IsA("UIScale")) {
		uiScale = existing;
	} else {
		uiScale = new Instance("UIScale");
		uiScale.Name = "PanelScale";
		uiScale.Parent = root;
	}

	const camera = Workspace.CurrentCamera;

	let reported = -1;
	let cameraChanged: RBXScriptConnection | undefined;
	let resized: RBXScriptConnection | undefined;
	let detached = false;

	const detach = () => {
		if (detached) {
			return;
		}

		detached = true;

		if (cameraChanged !== undefined) {
			cameraChanged.Disconnect();
			cameraChanged = undefined;
		}

		if (resized !== undefined) {
			resized.Disconnect();
			resized = undefined;
		}
	};

	const recompute = () => {
		if (detached) {
			return;
		}

		const viewport = camera !== undefined ? camera.ViewportSize : new Vector2(0, 0);
		const design = new Vector2(root.Size.X.Offset, root.Size.Y.Offset);
		const rescaled = panelScaleFor(viewport, design);

		uiScale.Scale = rescaled;

		// One line per *change*, not per event: a window drag fires these continuously and moves the scale by a thousandth.
		if (rescaled !== reported) {
			reported = rescaled;
			print(
				`[UiScale] panel=${panel} design=${math.round(design.X)}x${math.round(design.Y)} viewport=${math.round(viewport.X)}x${math.round(viewport.Y)} scale=${math.round(rescaled * 100) / 100}`,
			);
		}
	};

	// The panel's own size, because that is where an auto-height sheet publishes its height once the layout pass resolves it.
	resized = root.GetPropertyChangedSignal("Size").Connect(recompute);

	if (camera !== undefined) {
		cameraChanged = camera.GetPropertyChangedSignal("ViewportSize").Connect(recompute);
	}

	root.Destroying.Connect(detach);
	recompute();

	return detach;
}
