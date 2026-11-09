/**
 * **Placeholder.** How far the face is offset from the shadow plate, in pixels. **This is the panel's depth.**
 *
 * ## The arithmetic that decides it
 *
 * `UIStroke` is drawn **centred on the edge**, so half of `CHUNKY_PANEL_STROKE` - `3` pixels - hangs *outside* the face
 * and covers the shadow beside it. The visible band is therefore `depth - stroke / 2`: `10 - 3 = 7` pixels here.
 *
 * **Rule: this must be at least `1.5 x` the stroke.** At the button's ratio (`8` with a `4`-pixel border) the panel
 * would show `7` pixels; anything below `9` starts to read as a thick border rather than as a second plate. Item 113
 * records the identical failure on the button, where a depth of `4` behind a `4`-pixel border left two visible pixels
 * and the card looked flat.
 */
export const CHUNKY_PANEL_DEPTH = 10;

/** **Placeholder.** Panel border weight. Thicker than the button's: a panel's edge is a frame, not a tab. */
export const CHUNKY_PANEL_STROKE = 6;

/** **Placeholder.** Corner radius of both plates, in pixels. Matches `PANEL_CORNER_RADIUS` so the sheets did not move. */
export const CHUNKY_PANEL_CORNER = 12;

/**
 * **Placeholder.** The face colour: a neutral charcoal, **not** the tab's identity colour.
 *
 * A full-height red store sheet would be a wall of saturated red behind pale cards, and every item on it would have to
 * fight the background to be seen. The identity colour stays on the tab that opens the sheet, which is where it is doing
 * its job; the sheet is furniture.
 */
export const CHUNKY_PANEL_FACE = Color3.fromRGB(52, 52, 58);

/**
 * **Placeholder.** The shadow plate: the same charcoal, darker and slightly cooler.
 *
 * **Deliberately not the near-black of the outline.** Shadow and outline are adjacent - the outline's outer half lies on
 * top of the shadow band - so if they are the same value the band disappears and the depth with it. Three values, in
 * order: face `52`, shadow `26`, outline `10`. That ladder is the whole effect.
 */
export const CHUNKY_PANEL_SHADOW = Color3.fromRGB(26, 26, 30);

/** **Placeholder.** The near-black outline. Darker than the shadow, so the shadow band is never lost inside it. */
const CHUNKY_PANEL_OUTLINE = Color3.fromRGB(10, 10, 12);

/** What a caller may pass in. */
export interface ChunkyPanelOptions {
	/** Instance name, so the panel stays findable in the Explorer. */
	readonly name: string;
	/** The instance the panel is parented to. Parented last, so nothing is ever rendered half-built. */
	readonly parent: Instance;
	/** The panel's footprint. Ignored on the Y axis when `autoHeight` is set. */
	readonly size: UDim2;
	/** The bright face. Defaults to `CHUNKY_PANEL_FACE`. */
	readonly color?: Color3;
	/** The plate behind it. Defaults to `CHUNKY_PANEL_SHADOW`. */
	readonly shadowColor?: Color3;
	/**
	 * Grow downward to fit the content instead of taking `size.Y`.
	 *
	 * **The store needs this and the inventory does not.** A sheet at `fromScale(1, 1)` inside a container that is itself
	 * `AutomaticSize.Y` is circular - the container waits for the child's height, the child asks for the container's - and
	 * Roblox resolves it by leaving the child at its floor height, which is what used to clip a store's purchase buttons.
	 * Auto-height at the **container** and a content-driven face is the shape that resolves cleanly.
	 */
	readonly autoHeight?: boolean;
	/** Corner radius of both plates. Defaults to `CHUNKY_PANEL_CORNER`. */
	readonly cornerRadius?: number;
	/**
	 * Clip content that overflows the face.
	 *
	 * The inventory scrolls and wants the cut; the store deliberately does not clip, so an overgrown sheet is a visible
	 * bug rather than a silently amputated one.
	 */
	readonly clipsDescendants?: boolean;
	/** Base draw order. The shadow takes it and the face takes `zIndex + 1`. */
	readonly zIndex?: number;
}

/** The parts a caller needs: the thing to position, and the surface its bands go on. */
export interface ChunkyPanel {
	/** The container a caller positions and sizes as one unit. Transparent. */
	readonly frame: Frame;
	/** The coloured face. Content is parented here. */
	readonly surface: Frame;
	/** The plate behind it, exposed for a caller that wants to retint it with the face. */
	readonly shadow: Frame;
}

/**
 * The chunky offset panel: the same visual language as `buildChunkyButton`, at panel scale.
 *
 * ## Why the shadow is an offset sibling here and an inset child on the button
 *
 * Opposite mechanics, same look, and the difference is forced by the two sizes.
 *
 * A button's box is **fixed** by its layout cell, so the face can be inset *inside* it and the union never overflows -
 * which is what lets a rail of buttons sit in a list without eating each other's gaps. A panel is **free-floating and
 * sometimes auto-sized**: the store's height is decided by its content, so a face at `Size = (1, -depth, 1, -depth)`
 * inside an auto-height container would be a circular size (the container measures the face, the face scales to the
 * container) and the engine resolves that by collapsing one of them. The shadow therefore stays a full-size sibling
 * nudged down and right, exactly as the old `Panel` did, and the face keeps scale-1 sizing so it can grow with the
 * content.
 *
 * The one consequence to know about: the union is `depth` pixels larger than `size` on the right and bottom. For a
 * centred overlay that is invisible; it would matter only if a panel were placed in a `UIListLayout`, which none are.
 *
 * ## What replaced what
 *
 * `Panel` in `./panel` stays as it is - the sheet that nothing has migrated off yet - and this is the chunky one. They
 * return the same `{ frame, surface }` pair on purpose, so a call site swaps one function name and keeps every band it
 * already had.
 */
export function buildChunkyPanel(options: ChunkyPanelOptions): ChunkyPanel {
	const depth = CHUNKY_PANEL_DEPTH;
	const radius = options.cornerRadius ?? CHUNKY_PANEL_CORNER;
	const z = options.zIndex ?? 1;

	const frame = new Instance("Frame");
	frame.Name = options.name;
	// Centred like `Panel`, because every sheet in this game is an overlay over the middle of the screen. A caller that
	// wants it elsewhere moves it; the builder has no way to answer "where" well.
	frame.AnchorPoint = new Vector2(0.5, 0.5);
	frame.Position = UDim2.fromScale(0.5, 0.5);
	frame.Size = options.size;
	frame.BackgroundTransparency = 1;
	frame.BorderSizePixel = 0;
	if (options.autoHeight === true) {
		frame.AutomaticSize = Enum.AutomaticSize.Y;
	}
	frame.Parent = options.parent;

	// ## The shadow: a sibling of the face, never a child.
	//
	// A child cannot draw behind its own parent's background, so the plate has to be the face's sibling and the two need a
	// common parent - that parent is the thing a caller positions as one unit.
	//
	// ## The plate is the SAME SIZE as the face. Only its position moves.
	//
	// Depth is a *position*, not a size: two identical boxes with one pushed `depth` down and right show a uniform strip along
	// those two edges and nothing along the other two, which is what reads as one card sitting on another. A smaller plate reads
	// as a drop shadow from a light source; a larger one reads as a second card framing the first.
	//
	// Two things had to be fixed for that to be true, and both were wrong before:
	//
	// 1. **`fromScale(1, 1)` collapses inside an `AutomaticSize.Y` parent.** The parent asks its children how tall they are, a
	//    scale child answers "100% of you", and the engine breaks the loop by giving it no height at all - the same circular-size
	//    trap the face avoids by being the element that *reports*. The plate has no content and cannot report, so it is **told**,
	//    from the face's resolved height, in `syncShadow` below.
	// 2. **`ApplyStrokeMode.Border` draws the outline half-outside.** A 6-pixel border puts 3 pixels of the visible panel beyond
	//    the face on every edge, so a plate matching the *frame* was 6 pixels short on both axes. Matching the frame plus its
	//    stroke is what makes the two visible boxes equal.
	const halfStroke = CHUNKY_PANEL_STROKE / 2;

	const shadow = new Instance("Frame");
	shadow.Name = "Shadow";
	// Measured between the two *visible* edges, which is `depth` exactly: the face overhangs the frame by `halfStroke`, so the
	// plate starts that much earlier.
	shadow.Position = UDim2.fromOffset(depth - halfStroke, depth - halfStroke);
	shadow.BackgroundColor3 = options.shadowColor ?? CHUNKY_PANEL_SHADOW;
	shadow.BackgroundTransparency = 0;
	shadow.BorderSizePixel = 0;
	shadow.ZIndex = z;
	// Scenery, so it must not eat a click meant for the face.
	shadow.Active = false;
	shadow.Parent = frame;

	const shadowCorner = new Instance("UICorner");
	shadowCorner.CornerRadius = new UDim(0, radius);
	shadowCorner.Parent = shadow;

	const surface = new Instance("Frame");
	surface.Name = "Surface";
	surface.Position = UDim2.fromScale(0, 0);
	if (options.autoHeight === true) {
		// **The face measures its own content, and that is what the container's auto-height follows.** A scale-1 face inside
		// an auto-height container is a circular measurement - the container asks the child for a height, the child scales
		// to the container - so the face is the one that must report. This is the store's `Sheet` shape from before the
		// builder existed, kept because it is the one that resolves.
		surface.Size = new UDim2(1, 0, 0, 0);
		surface.AutomaticSize = Enum.AutomaticSize.Y;
	} else {
		surface.Size = UDim2.fromScale(1, 1);
	}

	// **The plate is sized from the face, once the face knows its size.** `AutomaticSize` writes the resolved content height back
	// into `Size.Y.Offset`, so that offset *is* the face's height in the same design pixels the plate's offsets use - no
	// measurement, no scale arithmetic, and no lag beyond the layout pass the engine is already doing.
	//
	// The frame's own auto-height grows by `CHUNKY_PANEL_STROKE` as a result, because the plate is now the tallest child. That is
	// invisible - the frame is fully transparent and nothing is positioned from its bottom edge - and excluding the plate from
	// `AutomaticSize` is not expressible: there is no "ignore this child", and a scale-sized child is exactly the case that
	// collapses.
	if (options.autoHeight === true) {
		const syncShadow = () => {
			shadow.Size = new UDim2(1, CHUNKY_PANEL_STROKE, 0, surface.Size.Y.Offset + CHUNKY_PANEL_STROKE);
		};

		syncShadow();
		surface.GetPropertyChangedSignal("Size").Connect(syncShadow);
	} else {
		shadow.Size = new UDim2(1, CHUNKY_PANEL_STROKE, 1, CHUNKY_PANEL_STROKE);
	}

	surface.BackgroundColor3 = options.color ?? CHUNKY_PANEL_FACE;
	surface.BackgroundTransparency = 0;
	surface.BorderSizePixel = 0;
	surface.ClipsDescendants = options.clipsDescendants === true;
	surface.ZIndex = z + 1;
	surface.Parent = frame;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, radius);
	corner.Parent = surface;

	// The thick outline is *on the face*, and only on the face: a stroke on the shadow plate as well would overflow the
	// container by half its thickness and, on a large panel, read as two cards stacked rather than one card with depth.
	const stroke = new Instance("UIStroke");
	stroke.Color = CHUNKY_PANEL_OUTLINE;
	stroke.Thickness = CHUNKY_PANEL_STROKE;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	stroke.Parent = surface;

	return { frame, surface, shadow };
}
