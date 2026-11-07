import { attachPressFeedback } from "./press";
import { attachClickSound } from "./sounds";

/**
 * **Placeholder.** How far the front plate is inset from the back plate, in pixels. **This is the depth.**
 *
 * ## Why it is 8 and was 4
 *
 * The first version shipped `4` and the card read flat. The arithmetic is the reason, and it is the thing to check before
 * changing this number again: `UIStroke` on the front plate is `BORDER_THICKNESS` wide and Roblox draws it **centred on
 * the edge**, so half of it - `2` pixels - hangs *outside* the front plate and covers the shadow strip beside it. A depth
 * of `4` therefore left `4 - 2 = 2` visible pixels of shadow, which is not a shadow, it is a slightly thick outline. At
 * `8` the strip is `6` pixels, and the back plate stops being a wash behind the border and starts being a plate behind
 * the card.
 *
 * **Rule of thumb: this must be at least twice `BORDER_THICKNESS`.** Below that the outline eats the effect, which is
 * exactly the failure this constant is documented against. Eight pixels on an ~84-pixel card is about a tenth of its
 * width - the proportion the reference art uses.
 */
export const CHUNKY_DEPTH = 8;

/** **Placeholder.** Corner radius shared by both plates, in pixels. */
const CORNER_RADIUS = 8;

/** **Placeholder.** Thickness of the dark border around the front plate, in pixels. */
const BORDER_THICKNESS = 4;

/** **Placeholder.** Thickness of the dark outline around the title glyphs, in pixels. */
const TITLE_STROKE_THICKNESS = 3;

/** **Placeholder.** The near-black used for the border, the title outline and the badge outline. */
const OUTLINE_COLOR = Color3.fromRGB(20, 20, 20);

/** **Placeholder.** The badge's red. */
const BADGE_COLOR = Color3.fromRGB(255, 51, 51);

/** **Placeholder.** Badge diameter, in pixels. */
const BADGE_SIZE = 20;

/** **Placeholder.** Badge border thickness, in pixels. */
const BADGE_STROKE_THICKNESS = 3;

/**
 * **Placeholder.** The icon's square size, in pixels.
 *
 * The slot is this size whether or not the id resolves: an `ImageLabel` whose image fails to load still occupies its box
 * and draws nothing. That empty square in the upper half of a new card is the **reserved icon slot**, not a layout gap -
 * and `shop-controller` now warns at mount while the placeholder ids are still in place, so the two cannot be confused
 * for one another again.
 */
const ICON_SIZE = 40;

/** **Placeholder.** Gap between the front plate's top edge and the icon, in pixels. */
const ICON_TOP_GAP = 8;

/** **Placeholder.** The title band's height, in pixels, measured up from the front plate's bottom edge. */
const TITLE_HEIGHT = 16;

/** **Placeholder.** Gap between the front plate's bottom edge and the title band, in pixels. */
const TITLE_BOTTOM_GAP = 4;

/** **Placeholder.** The title's legibility floor, in pixels. Below this the glyphs are noise. */
const TITLE_MIN_SIZE = 10;

/**
 * **Placeholder.** The title's ceiling, in pixels. Above this a two-word label would fill the card.
 *
 * Both bounds feed a `UITextSizeConstraint`, which is what makes `TextScaled = true` safe here: without one the engine
 * is free to shrink "INVENTORY" to a six-pixel smear on a narrow phone viewport, and to blow "SHOP" up to the width of
 * the card on a monitor.
 *
 * **The ceiling is also what keeps the tabs looking like a set.** `TextScaled` fits each label to its own length, so with
 * a generous cap a five-letter tab renders far larger than a nine-letter one and the rail reads as two different card
 * sizes. The cap is set to what the longest label on the rail can actually reach, so every tab lands at about the same
 * size and the short ones simply stop growing.
 */
const TITLE_MAX_SIZE = 14;

/**
 * **Placeholder.** A tileable pattern to lay over the front plate at 80% transparency.
 *
 * **This id is not an asset you own.** Nothing in the tree ships a pattern, and the brief for this round had none either,
 * so this is a deliberately wrong id that renders nothing rather than a plausible-looking id that renders somebody
 * else's texture. Swap it for the project's own tileable pattern (or for an empty string, which reads as "no overlay")
 * and nothing else has to change.
 */
export const CHUNKY_PATTERN_ASSET_ID = "rbxassetid://123456789";

/** **Placeholder.** Side of one pattern tile, in pixels. A tiled overlay needs a tile size; `Fit` would stretch one copy. */
const PATTERN_TILE_SIZE = 24;

/** **Placeholder.** How much of the pattern shows through. `0.8` is a hint of texture, not a picture. */
const PATTERN_TRANSPARENCY = 0.8;

/** The chunky look's typeface. `GothamBlack` rather than the theme's `GothamMedium`, because the title is a poster. */
const TITLE_FONT = Enum.Font.GothamBlack;

/** Everything a caller may pass in. Colors are **props**, not a theme lookup — see the module docblock. */
export interface ChunkyButtonOptions {
	/** The instance name, so the rail's buttons stay findable in the Explorer. */
	readonly name: string;
	/** The button's footprint, including the shadow plate. The rail's list layout sizes its cells from this. */
	readonly size: UDim2;
	/** The title, drawn uppercase in the bottom band. */
	readonly title: string;
	/** The icon's asset id. An empty string draws no icon at all rather than an empty `ImageLabel`. */
	readonly iconAssetId: string;
	/** The bright face of the card. */
	readonly color: Color3;
	/** The darker plate behind it, which is what makes the card look thick. */
	readonly shadowColor: Color3;
	/** Draws the "!" badge on the top-right corner of the front plate. */
	readonly hasBadge?: boolean;
	/** `LayoutOrder` for a `UIListLayout` parent. Unset leaves the default. */
	readonly layoutOrder?: number;
	/**
	 * The base `ZIndex`. The plates and the badge are placed relative to it, so a caller states one number and the layers
	 * cannot be individually forgotten.
	 */
	readonly zIndex?: number;
	/** Called on `Activated` — a click and a gamepad `A`, both. */
	readonly onActivated: () => void;
	/** The instance the card is parented to. Parented last, so nothing is ever rendered half-built. */
	readonly parent: Instance;
}

/** The pieces a caller may need later. The card is restyled through `setRaised`, not by reaching into the hierarchy. */
export interface ChunkyButton {
	/** The click surface and the layout cell. Transparent; every visible thing is a child of it. */
	readonly root: TextButton;
	/** The coloured plate, exposed so a caller can retint a tab without rebuilding it. */
	readonly front: Frame;
	/** The shadow plate, exposed for the same reason. */
	readonly back: Frame;
	/**
	 * Whether the card sits proud of its shadow (`true`) or flush with it (`false`).
	 *
	 * **This is how the rail says "you are looking at me".** A selected tab is drawn *pressed* — front flush with the
	 * back, shadow gone — which is the same trick as a physical key that is down rather than up. The alternative, a
	 * different colour per state, would need a second colour pair per tab and would fight the tab's own identity.
	 */
	readonly setRaised: (raised: boolean) => void;
}

/**
 * A chunky, offset, thick-stroked card button — the "Figma" look, built entirely from `Frame`s, `UIStroke`s and
 * `ImageLabel`s so it can be tinted and reused without exporting an image per tab.
 *
 * ## How two flat rectangles become one thick button
 *
 * There is no 3D here and no bevel: the depth is a **hard offset shadow**, which is the oldest trick in flat design and
 * works because the eye reads an abrupt tonal step under an edge as a second surface rather than as a border. Two things
 * sell it:
 *
 * 1. **The plates are the same size but not the same place.** The back plate fills the whole cell; the front plate is
 *    inset by `CHUNKY_DEPTH` at its right and bottom edges, so a strip of the darker plate is exposed exactly along the
 *    far edges. A symmetric ring of shadow would read as a second stroke; a one-sided strip reads as thickness.
 * 2. **The offset is a fixed pixel amount, not a scale.** Four pixels of shadow on an 78-pixel card is a twentieth of
 *    the width, which is the proportion that reads as a cast shadow at any card size. A scale-based inset would vanish on
 *    a small card and become a slab on a large one.
 *
 * The border, the pattern, the icon, the outlined title and the badge are all *inside the front plate*, so they travel
 * with it when `setRaised` moves it — the card cannot come apart into layers that disagree about where its face is.
 *
 * ## Why the plates are inset rather than positioned negative
 *
 * The brief described the same look as `Position = UDim2.fromOffset(-4, -4)` with a full-size front plate. That produces
 * the identical relative geometry and a *worse* layout: the card would overhang its own cell by four pixels on the top and
 * left, which in a `UIListLayout` means it eats the gap to its neighbour above and juts into the rail's inset at the
 * screen edge. Insetting the **front** plate on the far edges instead puts the same shadow in the same place with the
 * card's union still exactly the cell it was given. `setRaised(false)` then grows the front plate back to cover the back
 * plate exactly, which is the pressed state.
 *
 * ## Why the colors are arguments and not a `Theme`
 *
 * These are card identities, not surface roles: the shop is red because the shop is red, not because the palette says
 * "accent". A `Theme` lookup would force every caller to either add three one-use colors to the theme or to bypass it,
 * and the second is what this avoids. The builder therefore knows no colors, and a new tab is a data row rather than a
 * new branch — the same argument `rarityLabel` makes for keeping rarity colors in `economy.config`.
 *
 * ## Why `setRaised` rather than a visible flag
 *
 * A tab has to show which panel is open, and the honest expression of that in this visual language is that the selected
 * card is **pushed in**. It also means the selection is a property of the geometry that already exists, with no second
 * colour, no tint math and nothing for a caller to keep in step.
 */
export function buildChunkyButton(options: ChunkyButtonOptions): ChunkyButton {
	const { name, size, title, iconAssetId, color, shadowColor, layoutOrder, zIndex } = options;
	const z = zIndex ?? 1;

	// ## The click surface is the container itself.
	//
	// A `TextButton` over the top of the card would be a seventh layer that exists only to catch input, and the press
	// feedback (`attachPressFeedback`) attaches a `UIScale` to whatever it is given — on an invisible overlay that scale
	// would animate something nobody can see. Making the container the button means the scale moves the whole card, the
	// hover and press read as one object, and there is no transparent sibling to keep aligned with the art.
	const root = new Instance("TextButton");
	root.Name = name;
	root.Size = size;
	root.BackgroundTransparency = 1;
	root.Text = "";
	root.BorderSizePixel = 0;
	// The engine's own pressed tint would be a second piece of feedback for one press, in a different visual language
	// from the scale. Same reason every other control in this tree sets it.
	root.AutoButtonColor = false;
	root.ZIndex = z;
	if (layoutOrder !== undefined) {
		root.LayoutOrder = layoutOrder;
	}
	root.Parent = options.parent;

	// ## The back plate: the shadow.
	const back = new Instance("Frame");
	back.Name = "Shadow";
	back.Size = UDim2.fromScale(1, 1);
	back.Position = UDim2.fromScale(0, 0);
	back.BackgroundColor3 = shadowColor;
	back.BorderSizePixel = 0;
	back.ZIndex = z;
	back.Parent = root;

	const backCorner = new Instance("UICorner");
	backCorner.CornerRadius = new UDim(0, CORNER_RADIUS);
	backCorner.Parent = back;

	// ## The front plate: the face, inset on the far edges so the shadow shows.
	const front = new Instance("Frame");
	front.Name = "Face";
	front.BackgroundColor3 = color;
	front.BorderSizePixel = 0;
	front.ZIndex = z + 1;
	front.Parent = root;

	const frontCorner = new Instance("UICorner");
	frontCorner.CornerRadius = new UDim(0, CORNER_RADIUS);
	frontCorner.Parent = front;

	// **`ApplyStrokeMode.Border`, not the default.** On a `Frame` the contextual mode strokes the frame's own box, which
	// is what this wants, but saying so explicitly is what stops the next editor from wondering whether the default is
	// the outline or the fill. The thickness is the thickest single element on the card, after the shadow.
	const frontStroke = new Instance("UIStroke");
	frontStroke.Color = OUTLINE_COLOR;
	frontStroke.Thickness = BORDER_THICKNESS;
	frontStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	frontStroke.Parent = front;

	// A tiled black wash at 20% strength. It breaks up a flat saturated rectangle without becoming a picture, and it is
	// the only layer whose asset is a placeholder — see `CHUNKY_PATTERN_ASSET_ID`.
	const pattern = new Instance("ImageLabel");
	pattern.Name = "Pattern";
	pattern.Size = UDim2.fromScale(1, 1);
	pattern.Position = UDim2.fromScale(0, 0);
	pattern.BackgroundTransparency = 1;
	pattern.Image = CHUNKY_PATTERN_ASSET_ID;
	pattern.ImageColor3 = Color3.fromRGB(0, 0, 0);
	pattern.ImageTransparency = PATTERN_TRANSPARENCY;
	pattern.ScaleType = Enum.ScaleType.Tile;
	pattern.TileSize = UDim2.fromOffset(PATTERN_TILE_SIZE, PATTERN_TILE_SIZE);
	pattern.ZIndex = z + 1;
	pattern.Parent = front;

	if (iconAssetId !== "") {
		const icon = new Instance("ImageLabel");
		icon.Name = "Icon";
		icon.AnchorPoint = new Vector2(0.5, 0);
		icon.Position = new UDim2(0.5, 0, 0, ICON_TOP_GAP);
		icon.Size = UDim2.fromOffset(ICON_SIZE, ICON_SIZE);
		icon.BackgroundTransparency = 1;
		icon.Image = iconAssetId;
		// `Fit` and not `Stretch`: the icons are the user's own art with their own aspect, and a square `Fit` never
		// distorts one. A `Stretch` would make a tall icon squat and nobody would know why.
		icon.ScaleType = Enum.ScaleType.Fit;
		icon.ZIndex = z + 1;
		icon.Parent = front;
	}

	const label = new Instance("TextLabel");
	label.Name = "Title";
	label.AnchorPoint = new Vector2(0.5, 1);
	label.Position = new UDim2(0.5, 0, 1, -TITLE_BOTTOM_GAP);
	label.Size = new UDim2(1, -BORDER_THICKNESS * 2, 0, TITLE_HEIGHT);
	label.BackgroundTransparency = 1;
	label.Font = TITLE_FONT;
	label.Text = title;
	label.TextColor3 = Color3.fromRGB(255, 255, 255);
	label.TextScaled = true;
	label.ZIndex = z + 1;
	label.Parent = front;

	// `TextScaled` without a constraint is a licence the engine spends badly at both extremes. The floor keeps the title
	// legible on a narrow viewport; the ceiling stops a short word from growing until it touches the border.
	const titleSizeLimit = new Instance("UITextSizeConstraint");
	titleSizeLimit.MinTextSize = TITLE_MIN_SIZE;
	titleSizeLimit.MaxTextSize = TITLE_MAX_SIZE;
	titleSizeLimit.Parent = label;

	// **The outline is a `UIStroke` on the `TextLabel`, with the default contextual mode.** Contextual on a text object
	// strokes the glyphs, which is the "sticker" outline the mockup has; `Border` would draw a rectangle around the
	// label instead. This is the one place in the card where the default mode is the correct one, which is why the
	// front plate's stroke names its mode and this one does not.
	const titleStroke = new Instance("UIStroke");
	titleStroke.Color = Color3.fromRGB(0, 0, 0);
	titleStroke.Thickness = TITLE_STROKE_THICKNESS;
	titleStroke.Parent = label;

	if (options.hasBadge === true) {
		const badge = new Instance("Frame");
		badge.Name = "Badge";
		// Straddling the corner rather than sitting inside it: half the badge hangs off the face, which is what makes it
		// read as an attachment instead of as another part of the art.
		badge.AnchorPoint = new Vector2(0.5, 0.5);
		badge.Position = UDim2.fromScale(1, 0);
		badge.Size = UDim2.fromOffset(BADGE_SIZE, BADGE_SIZE);
		badge.BackgroundColor3 = BADGE_COLOR;
		badge.BorderSizePixel = 0;
		badge.ZIndex = z + 2;
		badge.Parent = front;

		const badgeCorner = new Instance("UICorner");
		// `UDim.new(1, 0)` is a full-radius circle at any diameter, which a fixed pixel radius is not.
		badgeCorner.CornerRadius = new UDim(1, 0);
		badgeCorner.Parent = badge;

		const badgeStroke = new Instance("UIStroke");
		badgeStroke.Color = OUTLINE_COLOR;
		badgeStroke.Thickness = BADGE_STROKE_THICKNESS;
		badgeStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		badgeStroke.Parent = badge;

		const mark = new Instance("TextLabel");
		mark.Name = "Mark";
		mark.Size = UDim2.fromScale(1, 1);
		mark.BackgroundTransparency = 1;
		mark.Font = Enum.Font.GothamBlack;
		mark.Text = "!";
		mark.TextColor3 = Color3.fromRGB(255, 255, 255);
		mark.TextScaled = true;
		mark.ZIndex = z + 2;
		mark.Parent = badge;

		const markLimit = new Instance("UITextSizeConstraint");
		markLimit.MinTextSize = 8;
		markLimit.MaxTextSize = BADGE_SIZE - BADGE_STROKE_THICKNESS * 2;
		markLimit.Parent = mark;
	}

	const setRaised = (raised: boolean) => {
		if (raised) {
			// Flush with the top-left corner, short by `CHUNKY_DEPTH` on the far edges: the shadow shows along the bottom
			// and right, which is what a light above and to the left would cast.
			front.Position = UDim2.fromScale(0, 0);
			front.Size = new UDim2(1, -CHUNKY_DEPTH, 1, -CHUNKY_DEPTH);
			return;
		}

		// Pushed in: the face fills the cell, covering the back plate completely so the shadow is gone. **It has to grow,
		// not slide** - a face of the raised size moved to the shadow's offset leaves an L of shadow along the left and
		// top edges, which reads as a card shoved sideways rather than pressed. Nothing overflows the cell in either
		// state, so the layout never moves.
		front.Position = UDim2.fromScale(0, 0);
		front.Size = UDim2.fromScale(1, 1);
	};

	setRaised(true);

	// The press feedback's `UIScale` lands on the root, so the whole card grows and shrinks as one object and the layout
	// cell it occupies never changes — which is the reason `attachPressFeedback` scales rather than resizes.
	attachPressFeedback(root);
	attachClickSound(root);
	root.Activated.Connect(() => options.onActivated());

	return { root, front, back, setRaised };
}
