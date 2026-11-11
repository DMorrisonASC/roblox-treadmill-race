/**
 * **Placeholder.** Panel border weight. Thicker than the button's: a panel's edge is a frame, not a tab.
 *
 * **This is now the whole of a panel's edge treatment.** A panel has no shadow plate (item 195) - the outline is what
 * separates it from whatever is behind it, so this number is doing the job the plate used to do.
 */
export const CHUNKY_PANEL_STROKE = 6;

/** **Placeholder.** Corner radius of the face, in pixels. Matches `PANEL_CORNER_RADIUS` so the sheets did not move. */
export const CHUNKY_PANEL_CORNER = 12;

/**
 * **Placeholder.** The face colour: a neutral charcoal, **not** the tab's identity colour.
 *
 * A full-height red store sheet would be a wall of saturated red behind pale cards, and every item on it would have to
 * fight the background to be seen. The identity colour stays on the tab that opens the sheet, which is where it is doing
 * its job; the sheet is furniture.
 */
export const CHUNKY_PANEL_FACE = Color3.fromRGB(52, 52, 58);

/** **Placeholder.** The near-black outline. */
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
	/**
	 * Grow downward to fit the content instead of taking `size.Y`.
	 *
	 * **The store needs this and the inventory does not.** A sheet at `fromScale(1, 1)` inside a container that is itself
	 * `AutomaticSize.Y` is circular - the container waits for the child's height, the child asks for the container's - and
	 * Roblox resolves it by leaving the child at its floor height, which is what used to clip a store's purchase buttons.
	 * Auto-height at the **container** and a content-driven face is the shape that resolves cleanly.
	 */
	readonly autoHeight?: boolean;
	/** Corner radius. Defaults to `CHUNKY_PANEL_CORNER`. */
	readonly cornerRadius?: number;
	/**
	 * Clip content that overflows the face.
	 *
	 * The inventory scrolls and wants the cut; the store deliberately does not clip, so an overgrown sheet is a visible
	 * bug rather than a silently amputated one.
	 */
	readonly clipsDescendants?: boolean;
	/** Draw order of the face. */
	readonly zIndex?: number;
}

/** The parts a caller needs: the thing to position, and the surface its bands go on. */
export interface ChunkyPanel {
	/** The container a caller positions and sizes as one unit. Transparent, and exactly the face's size. */
	readonly frame: Frame;
	/** The coloured face and the outline. Content is parented here. */
	readonly surface: Frame;
}

/**
 * The chunky panel: **one face, one outline, one corner radius.** No shadow plate.
 *
 * ## Why the depth is gone (item 195)
 *
 * The plate was an **offset sibling** nudged `depth` pixels down and right, on the argument that a child cannot draw
 * behind its own parent's background. That argument is true and the design was still wrong, because of what an offset
 * sibling does to an **auto-sized** container: the container measures *all* its children, so it grew by the plate's
 * overhang, the face stopped being the frame's own box, and the plate was left as a sliver along two edges. Two symptoms
 * followed from that one cause and both were reported repeatedly:
 *
 * - **no plate under the panel** - the visible band was narrower than the offset, so on a short chip there was nothing
 *   that read as depth at all;
 * - **a black line at a corner** - the sliver's edge showing past the face's `UICorner` arc.
 *
 * Item 123 had already spent a round on a variant of this ("the pale corner was never the shadow"), and item 122 on
 * another (a square plate under a rounded face). Three attempts at a cosmetic plate is the signal: **the plate is the
 * defect.** A panel is a surface, not an object sitting on another one, and the depth belongs only to things you press -
 * where the box is a **fixed layout cell** and the face is inset *inside* it, which is a shape with no overhang and no
 * measurement feedback (see `applyChunkyChrome`). The store, the inventory, the picker, the payout, the toast, the chest
 * reveal and the phase banner are all readouts or containments; none of them is pressed.
 *
 * **What is lost, stated plainly:** the sheets no longer read as cards raised off the screen. They read as flat panels
 * with a thick near-black outline and a rounded corner, which is the same silhouette the rest of the UI has and is the
 * look the report asked for. `CHUNKY_PANEL_DEPTH` and `CHUNKY_PANEL_SHADOW` are deleted rather than left at zero - this
 * tree removes inert values.
 *
 * ## What replaced what
 *
 * `Panel` in `./panel` stays as it is - the sheet that nothing has migrated off yet - and this is the chunky one. Both
 * return a `{ frame, surface }` pair, so a call site swaps one function name and keeps every band it already had. This one
 * used to return a third member, `shadow`; it is gone with the plate, and the two callers that faded it no longer have a
 * second plate to fade.
 */
export function buildChunkyPanel(options: ChunkyPanelOptions): ChunkyPanel {
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

	const surface = new Instance("Frame");
	surface.Name = "Surface";
	surface.Position = UDim2.fromScale(0, 0);
	if (options.autoHeight === true) {
		// **The face measures its own content, and that is what the container's auto-height follows.** A scale-1 face inside
		// an auto-height container is a circular measurement - the container asks the child for a height, the child scales to
		// the container - so the face is the one that must report. This is the store's `Sheet` shape from before the builder
		// existed, kept because it is the one that resolves.
		surface.Size = new UDim2(1, 0, 0, 0);
		surface.AutomaticSize = Enum.AutomaticSize.Y;
	} else {
		surface.Size = UDim2.fromScale(1, 1);
	}

	surface.BackgroundColor3 = options.color ?? CHUNKY_PANEL_FACE;
	surface.BackgroundTransparency = 0;
	surface.BorderSizePixel = 0;
	surface.ClipsDescendants = options.clipsDescendants === true;
	surface.ZIndex = z;
	surface.Parent = frame;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, radius);
	corner.Parent = surface;

	// The thick outline is the panel's only edge. `ApplyStrokeMode.Border` is the default and is left implicit: a centred
	// stroke on a face that is the container's own box is the look, and the half that hangs outside is what makes the panel
	// reach a couple of pixels past its declared `Size` rather than being eaten by it.
	const stroke = new Instance("UIStroke");
	stroke.Color = CHUNKY_PANEL_OUTLINE;
	stroke.Thickness = CHUNKY_PANEL_STROKE;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	stroke.Parent = surface;

	return { frame, surface };
}
