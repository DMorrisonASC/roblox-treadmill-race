import { SPACING, TYPOGRAPHY, FONT, Typography } from "./scale";
import { outlineText } from "./text";
import { Theme } from "./theme";
import { attachPressFeedback } from "./press";
import { attachClickSound } from "./sounds";

/**
 * **Placeholder.** Corner radius of a panel's sheet, in pixels.
 *
 * The `Theme` carries colours and paints only — it never had a radius slot, because a slot with no reader is a slot
 * whose value gets guessed at. This is the first reader, so the value lives beside it. Moving it into `Theme` later
 * is a one-line change in two files.
 */
export const PANEL_CORNER_RADIUS = 12;

/** **Placeholder.** Panel border weight. Deliberately hairline: the sheet's edge is a boundary, not an ornament. */
export const PANEL_STROKE_THICKNESS = 1;

/** **Placeholder.** Height of the header band, in pixels. Fixed, so every panel's content starts at the same Y. */
export const PANEL_HEADER_HEIGHT = 44;

/** **Placeholder.** Height of the footer band, in pixels — the status line's strip. */
export const PANEL_FOOTER_HEIGHT = 34;

/** **Placeholder.** Side padding inside the sheet, in pixels. */
const PANEL_SIDE_PADDING = SPACING.md;

/**
 * **Placeholder.** How far the sheet's shadow sits down and to the right, in pixels.
 *
 * The one strong depth cue in the panels, and it belongs to the sheet alone: a tile with its own shadow would
 * compete with the surface it is lying on, and five competing shadows read as noise rather than as depth.
 */
const SHADOW_OFFSET = 6;

/** **Placeholder.** How much of the shadow shows. High, so the drop is felt rather than seen. */
const SHADOW_TRANSPARENCY = 0.72;

/** **Placeholder.** Draw order of the shadow, below the sheet it belongs to. */
const SHADOW_Z_INDEX = 1;

/** **Placeholder.** Draw order of the sheet. */
const SHEET_Z_INDEX = 2;

/** **Placeholder.** Draw order of anything drawn on the sheet. */
const CONTENT_Z_INDEX = 3;

/** **Placeholder.** The close button's box, in pixels. Square, because a `×` in a wide box reads as off-centre. */
const CLOSE_BUTTON_SIZE = 26;

/** What a caller may pass to `Panel`. */
export interface PanelOptions {
	theme: Theme;
	parent: Instance;
	size: UDim2;
}

/** The sheet: the positioned frame a caller anchors, and the surface its bands go on. */
export interface PanelParts {
	frame: Frame;
	surface: Frame;
}

/**
 * Builds the sheet — a centred, rounded, opaque panel with one shadow.
 *
 * ## Why the returned frame is a container
 *
 * The visible sheet is a child of the returned `frame`. That indirection exists for exactly one reason: the shadow
 * has to be a **sibling** of the sheet, because a child cannot draw behind its own parent's background. So both
 * need a common parent, and that parent is the thing a caller positions and sizes as one unit.
 *
 * ## Where the placement is decided
 *
 * `frame` arrives centred (`AnchorPoint 0.5, 0.5` at `0.5, 0.5`) because every panel in this game is a sheet over
 * the middle of the screen. A caller that wanted it elsewhere would move it — the builder does not take a position,
 * because "where" is the caller's question and the builder has no way to answer it well.
 *
 * ## Why the layout is not here
 *
 * The sheet is a plain `Frame`; the bands that fill it are separate builders (`PanelHeader`, `TabStrip`, `Shelf`,
 * `PanelFooter`) and the caller parents them to `surface` in the order it wants. That keeps this function to one
 * job — the paper — and means a panel with no footer or no tabs is the same builder with fewer children, not a
 * flag.
 *
 * Every colour and transparency comes from the theme; the only literals are the geometry at the top of this file.
 */
export function Panel(options: PanelOptions): PanelParts {
	const { theme, parent, size } = options;

	const frame = new Instance("Frame");
	frame.Name = "Panel";
	frame.AnchorPoint = new Vector2(0.5, 0.5);
	frame.Position = UDim2.fromScale(0.5, 0.5);
	frame.Size = size;
	frame.BackgroundTransparency = 1;
	frame.BorderSizePixel = 0;

	const shadow = new Instance("Frame");
	shadow.Name = "Shadow";
	shadow.Position = UDim2.fromOffset(SHADOW_OFFSET, SHADOW_OFFSET);
	shadow.Size = UDim2.fromScale(1, 1);
	shadow.BackgroundColor3 = theme.colors.shadow;
	shadow.BackgroundTransparency = SHADOW_TRANSPARENCY;
	shadow.BorderSizePixel = 0;
	shadow.ZIndex = SHADOW_Z_INDEX;
	// Scenery, so it must not eat a click meant for the sheet.
	shadow.Active = false;
	shadow.Parent = frame;

	const surface = new Instance("Frame");
	surface.Name = "Surface";
	surface.Size = UDim2.fromScale(1, 1);
	surface.BackgroundColor3 = theme.paint.panel.color;
	surface.BackgroundTransparency = theme.paint.panel.transparency;
	surface.BorderSizePixel = 0;
	surface.ClipsDescendants = true;
	surface.ZIndex = SHEET_Z_INDEX;
	surface.Parent = frame;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, PANEL_CORNER_RADIUS);
	corner.Parent = surface;

	const stroke = new Instance("UIStroke");
	stroke.Color = theme.colors.border;
	stroke.Thickness = PANEL_STROKE_THICKNESS;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	stroke.Parent = surface;

	// A vertical list on the sheet, so a band's height is its own business and the shelf takes whatever is left.
	// Stacking bands by `LayoutOrder` is what makes "header, tabs, shelf, footer" a declaration rather than four
	// hand-computed offsets that all change when one band's height changes.
	const layout = new Instance("UIListLayout");
	layout.FillDirection = Enum.FillDirection.Vertical;
	layout.SortOrder = Enum.SortOrder.LayoutOrder;
	layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
	layout.Parent = surface;

	frame.Parent = parent;

	return { frame, surface };
}

/** What a caller may pass to `PanelHeader`. */

/**
 * **Optional type scale and glyph outline, for a caller that has moved the sheet to its own scale.**
 *
 * Both default to the generic behaviour - `TYPOGRAPHY` and no outline - so a band built by any other caller is byte-for-byte
 * what it was. The shop passes `typographyOneStepUp()` and `true`, because the sheet's text is one size larger than the HUD's
 * and every label in it carries the black outline; a band that skipped either would be the only text on the sheet without
 * them, which is the sort of half-migration that reads as a bug.
 */
export interface PanelHeaderOptions {
	theme: Theme;
	parent: Instance;
	title: string;
	onClose: () => void;
	/** Overrides `TYPOGRAPHY` for the heading and the close glyph. */
	typeScale?: Typography;
	/** Outlines the heading and the close glyph in black. */
	outline?: boolean;
}

/**
 * The title band: a heading on the left, a close button on the right.
 *
 * A close button exists here — where the first draft relied on the tab alone — because a panel is a sheet a player
 * opens *over* the game, and a sheet with no dismissal affordance leaves one control as the only way out. The button
 * is the one a player reaches for.
 */
export function PanelHeader(options: PanelHeaderOptions): Frame {
	const { theme, parent, title, onClose } = options;
	const scale = options.typeScale ?? TYPOGRAPHY;

	const band = new Instance("Frame");
	band.Name = "Header";
	band.Size = new UDim2(1, 0, 0, PANEL_HEADER_HEIGHT);
	band.BackgroundTransparency = 1;
	band.ZIndex = CONTENT_Z_INDEX;
	band.LayoutOrder = 1;
	band.Parent = parent;

	const padding = new Instance("UIPadding");
	padding.PaddingLeft = new UDim(0, PANEL_SIDE_PADDING);
	padding.PaddingRight = new UDim(0, PANEL_SIDE_PADDING);
	padding.Parent = band;

	const heading = new Instance("TextLabel");
	heading.Name = "Title";
	heading.Size = new UDim2(1, -(CLOSE_BUTTON_SIZE + SPACING.sm), 1, 0);
	heading.BackgroundTransparency = 1;
	heading.Font = FONT;
	heading.TextSize = scale.h6.size;
	heading.TextColor3 = theme.colors.textPrimary;
	heading.TextXAlignment = Enum.TextXAlignment.Left;
	heading.TextYAlignment = Enum.TextYAlignment.Center;
	heading.Text = title;
	heading.ZIndex = CONTENT_Z_INDEX;
	heading.Parent = band;

	const close = new Instance("TextButton");
	close.Name = "Close";
	close.AnchorPoint = new Vector2(1, 0.5);
	close.Position = UDim2.fromScale(1, 0.5);
	close.Size = UDim2.fromOffset(CLOSE_BUTTON_SIZE, CLOSE_BUTTON_SIZE);
	close.BackgroundColor3 = theme.paint.trough.color;
	close.BackgroundTransparency = theme.paint.trough.transparency;
	close.BorderSizePixel = 0;
	close.AutoButtonColor = false;
	close.Font = FONT;
	close.TextSize = scale.body1.size;
	close.TextColor3 = theme.colors.textSecondary;
	close.Text = "×";
	close.ZIndex = CONTENT_Z_INDEX;
	close.Parent = band;

	// A pill rather than a rounded square: at 26px a square's corner radius is most of its edge, and a circle is
	// what the eye reads a single-glyph button as.
	const closeCorner = new Instance("UICorner");
	closeCorner.CornerRadius = new UDim(1, 0);
	closeCorner.Parent = close;

	if (options.outline === true) {
		outlineText(heading);
		outlineText(close);
	}

	attachPressFeedback(close);
	attachClickSound(close);
	close.Activated.Connect(onClose);

	return band;
}

/** What a caller may pass to `PanelFooter`. */
export interface PanelFooterOptions {
	theme: Theme;
	parent: Instance;
	text: string;
	/** Overrides `TYPOGRAPHY` for the status line. */
	typeScale?: Typography;
	/** Outlines the status line's glyphs in black. */
	outline?: boolean;
}

/**
 * The status band: one quiet line along the bottom of the sheet.
 *
 * This is where a panel says what a player cannot work out from the tiles — whether anything is purchasable, what
 * is missing, what just happened. It is a label rather than a builder that takes a list of messages, because the
 * panels in this game have exactly one thing to say at a time and a list would be a message queue nobody drains.
 */
export function PanelFooter(options: PanelFooterOptions): TextLabel {
	const { theme, parent, text } = options;
	const scale = options.typeScale ?? TYPOGRAPHY;

	const label = new Instance("TextLabel");
	label.Name = "Footer";
	label.Size = new UDim2(1, 0, 0, PANEL_FOOTER_HEIGHT);
	label.BackgroundTransparency = 1;
	label.Font = FONT;
	label.TextSize = scale.caption.size;
	label.TextColor3 = theme.colors.textSecondary;
	label.TextXAlignment = Enum.TextXAlignment.Left;
	label.TextYAlignment = Enum.TextYAlignment.Center;
	label.Text = text;
	label.ZIndex = CONTENT_Z_INDEX;
	label.LayoutOrder = 9;
	label.Parent = parent;

	const padding = new Instance("UIPadding");
	padding.PaddingLeft = new UDim(0, PANEL_SIDE_PADDING);
	padding.PaddingRight = new UDim(0, PANEL_SIDE_PADDING);
	padding.Parent = label;

	if (options.outline === true) {
		outlineText(label);
	}

	return label;
}
