import { outlineText } from "./text";

/**
 * **Placeholder.** How far the face is inset inside a control's cell, in pixels. **This is the depth cue.**
 *
 * Same arithmetic as the chunky card buttons and the sheet: `UIStroke` is drawn **centred on the edge**, so half of
 * `CHUNKY_CONTROL_STROKE` lies *on top of* the shadow strip beside the face. The visible band is `depth - stroke / 2`,
 * which at these values is `6 - 1.5 = 4.5` pixels.
 *
 * **Rule: depth must be at least `1.5 x` the stroke**, or the outline eats the shadow (item 113's failure, recorded on
 * `CHUNKY_DEPTH` and `CHUNKY_PANEL_DEPTH` as well).
 *
 * `6` rather than the card's `8` because a control inside a panel is 30-45 pixels tall, not 84: the same proportion of a
 * much smaller box. It also fits inside a 36-pixel tab after the stroke, which is the tightest control here.
 */
export const CHUNKY_CONTROL_DEPTH = 6;

/** **Placeholder.** Control border weight. Thinner than the sheet's `6`, because a control is a button on the sheet. */
export const CHUNKY_CONTROL_STROKE = 3;

/** **Placeholder.** Corner radius of a control's two plates. Matches `SPACING.sm`. */
export const CHUNKY_CONTROL_CORNER = 8;

/** **Placeholder.** The near-black outline, one step darker than any shadow a caller passes. */
export const CHUNKY_CONTROL_OUTLINE = Color3.fromRGB(20, 20, 20);

/** What a caller may pass to `applyChunkyChrome`. */
export interface ChunkyChromeOptions {
	/** The bright face. */
	readonly color: Color3;
	/** The plate behind it. Kept a dark shade of the same hue, never a second colour. */
	readonly shadowColor: Color3;
	/** The face's draw order. The shadow takes this and the face takes `zIndex + 1`. */
	readonly zIndex: number;
	/** Overrides `CHUNKY_CONTROL_DEPTH`. */
	readonly depth?: number;
	/** Overrides `CHUNKY_CONTROL_STROKE`. */
	readonly stroke?: number;
	/** Overrides `CHUNKY_CONTROL_CORNER`. */
	readonly corner?: number;
	/**
	 * Draws a centred label on the face and returns it. **Required for any button whose own `Text` is used**, because the
	 * face is a child of the button and would cover the button's glyphs.
	 */
	readonly label?: ChunkyLabelOptions;
}

/** The centred label `applyChunkyChrome` can build on the face. */
export interface ChunkyLabelOptions {
	readonly text: string;
	readonly textSize: number;
	readonly color: Color3;
	/** Defaults to `Enum.Font.GothamMedium`, the game's font. */
	readonly font?: Enum.Font;
	/**
	 * **Draw order of the label.** Must be above `ChunkyChromeOptions.zIndex + 1`, or the face covers it - the one number
	 * in this module that a caller cannot leave to the default.
	 */
	readonly zIndex: number;
	/** Outlines the glyphs in black. On by default: every control on the sheet is outlined. */
	readonly outline?: boolean;
}

/** What `applyChunkyChrome` returns. */
export interface ChunkyChrome {
	/**
	 * The control itself, for `Active`, `Activated` and any other property of the button rather than of its paint.
	 *
	 * Carried on the handle so a caller never has to keep both: a list of these is a list of controls whose plates are
	 * reachable, and `setRaised` / the face stay one dereference away from whatever `Active` was written on.
	 */
	readonly button: GuiButton;
	/** The plate behind the face. */
	readonly shadow: Frame;
	/** The coloured face. Parent content here, not to the button. */
	readonly face: Frame;
	/** The centred label, when `label` was passed. */
	readonly label?: TextLabel;
	/**
	 * Whether the control sits proud of its shadow (`true`) or flush with it (`false`).
	 *
	 * The pressed state, and the reason selection can be shown without a second colour: a chosen tab is drawn pressed.
	 */
	readonly setRaised: (raised: boolean) => void;
}

/**
 * Gives an **existing** button the chunky offset-card treatment: a shadow plate behind, a coloured face in front, a thick
 * outline around it, and the whole thing one pixel-offset stack inside the button's own cell.
 *
 * ## Why this exists separately from `buildChunkyButton`
 *
 * `buildChunkyButton` *builds* a card, with an icon slot, a title band and a badge - the right thing for the rail, the
 * wrong thing for a chest button that already has two lines of live text in a layout. What those controls need is only the
 * **chrome**: the depth, the outline and the two plates. So this function decorates a button the caller already made, and
 * returns the face to parent content to. The button keeps its cell, its layout order, its press feedback, its click
 * sound and its handlers; only its background moves to a child.
 *
 * ## Why the button's own background has to go
 *
 * A child **cannot draw behind its own parent's background** - the same rule that makes the sheet's shadow a sibling
 * rather than a child, recorded on `Panel`. So depth on an existing button means inverting the stack: the button becomes a
 * transparent hit area, and the two plates become its children. In exchange, the button's own `Text` is covered by the
 * face, which is what `label` is for: a button that carries text gets a `TextLabel` on the face instead, at
 * `zIndex + 2` or above.
 *
 * ## The button's own background must stay invisible
 *
 * `applyChunkyChrome` sets `BackgroundTransparency = 1` on the button, and **nothing else may ever set it back**. A caller
 * that dims a button by writing `button.BackgroundTransparency` - the obvious thing to do before this module existed -
 * re-opens the hit area as a visible plate in front of *nothing*, and what shows is Roblox's default light grey: the face
 * and shadow cover the middle of the cell, and a rounded shadow leaves its own corners uncovered, so the failure looks like
 * pale wedges at every corner rather than like a grey box. Use `dimChunkyChrome`, which washes the face and its labels.
 *
 * ## The pressed state
 *
 * `setRaised(false)` grows the face to the full cell, covering the shadow. It has to **grow rather than slide**, or the
 * plate underneath shows as an L along two edges and the control reads as misaligned instead of pressed.
 */
export function applyChunkyChrome(button: GuiButton, options: ChunkyChromeOptions): ChunkyChrome {
	const depth = options.depth ?? CHUNKY_CONTROL_DEPTH;
	const stroke = options.stroke ?? CHUNKY_CONTROL_STROKE;
	const corner = options.corner ?? CHUNKY_CONTROL_CORNER;
	const z = options.zIndex;

	// The button keeps its box, its layout cell and its handlers; only the paint moves down one level.
	button.BackgroundTransparency = 1;
	button.BorderSizePixel = 0;

	// **The shadow is rounded, like the face and like the card's.** It fills the cell and carries the same `UICorner`
	// radius as the face; a square plate under a rounded face is a silhouette mismatch, and it is the one thing that made
	// controls look like a different component family from the tabs that open them.
	const shadow = new Instance("Frame");
	shadow.Name = "Chunk";
	shadow.Position = UDim2.fromScale(0, 0);
	shadow.Size = UDim2.fromScale(1, 1);
	shadow.BackgroundColor3 = options.shadowColor;
	shadow.BorderSizePixel = 0;
	shadow.ZIndex = z;
	shadow.Parent = button;

	const shadowCorner = new Instance("UICorner");
	shadowCorner.CornerRadius = new UDim(0, corner);
	shadowCorner.Parent = shadow;

	const face = new Instance("Frame");
	face.Name = "Face";
	face.Position = UDim2.fromScale(0, 0);
	face.Size = new UDim2(1, -depth, 1, -depth);
	face.BackgroundColor3 = options.color;
	face.BorderSizePixel = 0;
	face.ZIndex = z + 1;
	face.Parent = button;

	const faceCorner = new Instance("UICorner");
	faceCorner.CornerRadius = new UDim(0, corner);
	faceCorner.Parent = face;

	const faceStroke = new Instance("UIStroke");
	faceStroke.Color = CHUNKY_CONTROL_OUTLINE;
	faceStroke.Thickness = stroke;
	faceStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	faceStroke.Parent = face;

	let label: TextLabel | undefined;
	const labelOptions = options.label;
	if (labelOptions !== undefined) {
		const created = new Instance("TextLabel");
		created.Name = "Text";
		created.Position = UDim2.fromScale(0, 0);
		created.Size = UDim2.fromScale(1, 1);
		created.BackgroundTransparency = 1;
		created.BorderSizePixel = 0;
		created.Font = labelOptions.font ?? Enum.Font.GothamMedium;
		created.TextSize = labelOptions.textSize;
		created.TextColor3 = labelOptions.color;
		created.TextXAlignment = Enum.TextXAlignment.Center;
		created.TextYAlignment = Enum.TextYAlignment.Center;
		created.TextTruncate = Enum.TextTruncate.AtEnd;
		created.Text = labelOptions.text;
		created.ZIndex = labelOptions.zIndex;
		created.Parent = face;

		if (labelOptions.outline !== false) {
			outlineText(created);
		}

		label = created;
	}

	const setRaised = (raised: boolean) => {
		if (raised) {
			face.Position = UDim2.fromScale(0, 0);
			face.Size = new UDim2(1, -depth, 1, -depth);
			return;
		}

		// Flush: the face fills the cell and swallows the shadow. Grown, not moved - see the docblock.
		face.Position = UDim2.fromScale(0, 0);
		face.Size = UDim2.fromScale(1, 1);
	};

	return { button, shadow, face, label, setRaised };
}

/**
 * Draws a tinted ring **inside** a chunky face, without stealing its outline.
 *
 * ## Why this is a frame and not a second `UIStroke` on the face
 *
 * **Roblox applies exactly one `UIStroke` to a GuiObject.** Adding a second does not stack it - the newer instance takes
 * over - so a caller that wants "the chunky black border plus my own coloured hairline" and writes it as two strokes on the
 * face gets only the hairline. The border silently disappears and the control's edge takes the caller's colour, which reads
 * as "the button changed colour" rather than as "a stroke went missing".
 *
 * So the ring is its own transparent `Frame` filling the face, carrying one stroke and a corner copied from the face. Two
 * strokes, two objects, both visible.
 *
 * `ZIndex` is `face.ZIndex + 1` so the ring draws over the face's fill; the face's own outline is drawn by the face itself
 * and is unaffected either way.
 */
export function addChunkyRing(face: Frame, color: Color3, thickness: number): Frame {
	const ring = new Instance("Frame");
	ring.Name = "Ring";
	ring.Position = UDim2.fromScale(0, 0);
	ring.Size = UDim2.fromScale(1, 1);
	ring.BackgroundTransparency = 1;
	ring.BorderSizePixel = 0;
	ring.ZIndex = face.ZIndex + 1;
	ring.Parent = face;

	// Copied from the face so the ring follows its rounded edge rather than outlining its bounding box.
	const faceCorner = face.FindFirstChildOfClass("UICorner");
	if (faceCorner !== undefined) {
		const ringCorner = new Instance("UICorner");
		ringCorner.CornerRadius = faceCorner.CornerRadius;
		ringCorner.Parent = ring;
	}

	const stroke = new Instance("UIStroke");
	stroke.Color = color;
	stroke.Thickness = thickness;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	stroke.Parent = ring;

	return ring;
}

/** The name `applyChunkyChrome` gives the face, so a later pass can find it without holding the handle. */
export const CHUNKY_FACE_NAME = "Face";

/**
 * Dims or restores a control that `applyChunkyChrome` decorated - the disabled look.
 *
 * ## Why this is not `button.TextTransparency` any more
 *
 * The chrome makes the button a transparent hit area and moves its caption onto a label inside the face, so the button's own
 * `TextTransparency` has nothing left to fade. Dimming has to reach the **face and every label the caller parented into it**,
 * which is what this walks.
 *
 * It finds the face by name rather than by handle so a caller that keeps only the `TextButton` - a list of purchasable
 * buttons, say - can still dim it. That is the one place in this module where a name lookup beats a handle, and it is why
 * `CHUNKY_FACE_NAME` is exported rather than left as a literal in two files.
 *
 * `0.45` is the wash the disabled premium buttons already used; it is high enough to read as inactive on a saturated fill
 * and low enough that the caption is still legible, which matters when the caption says *why* it is inactive.
 */
export function dimChunkyChrome(button: GuiButton, dimmed: boolean): void {
	const face = button.FindFirstChild(CHUNKY_FACE_NAME);
	if (face === undefined || !face.IsA("Frame")) {
		return;
	}

	const wash = dimmed ? 0.45 : 0;
	face.BackgroundTransparency = wash;

	for (const descendant of face.GetDescendants()) {
		if (descendant.IsA("TextLabel") || descendant.IsA("TextButton")) {
			descendant.TextTransparency = wash;
		}
	}
}

/**
 * **Placeholder.** A shadow colour from a face colour: the same hue, three fifths of the brightness.
 *
 * Used by the panel's controls, which take their identity from the theme and would otherwise need a hand-picked shadow
 * beside every one. **Designed values are the rule in this tree** (`TINTS` says why), so this is deliberately the one
 * exception and it is confined to derived shadows: a shadow that is a scalar multiple of its own face can never drift out
 * of hue, which is the specific failure the hand-picked pairs were there to avoid.
 */
export function shadowOf(face: Color3): Color3 {
	return Color3.fromRGB(
		math.floor(face.R * 255 * 0.45),
		math.floor(face.G * 255 * 0.45),
		math.floor(face.B * 255 * 0.45),
	);
}
