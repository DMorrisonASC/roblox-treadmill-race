import { SPACING, TYPOGRAPHY, FONT } from "./scale";
import { Theme } from "./theme";
import { attachPressFeedback } from "./press";
import { attachClickSound } from "./sounds";

/**
 * **Placeholder.** Corner radius of a tile. Smaller than `PANEL_CORNER_RADIUS` so a tile reads as content lying on
 * the sheet rather than as a small panel on top of it.
 */
export const TILE_CORNER_RADIUS = 8;

/** **Placeholder.** Tile border weight. Hairline: the grid's rhythm comes from spacing, not from outlines. */
const TILE_STROKE_THICKNESS = 1;

/** **Placeholder.** Padding inside a tile, in pixels. */
const TILE_PADDING = SPACING.sm;

/** **Placeholder.** How much of the tile's height the name line takes, so a two-word name still fits one line. */
const TILE_NAME_FRACTION = 0.55;

/** **Placeholder.** Tile draw order, above the shelf's canvas. */
const TILE_Z_INDEX = 3;

/** What a caller may pass to `Tile`. */
export interface TileOptions {
	theme: Theme;
	parent: Instance;
	title: string;
	onClick: () => void;
}

/**
 * One item tile: a card face, a name, a subtitle line, and the restrained hover-and-press scale.
 *
 * ## Why it is a `TextButton` whose labels are children
 *
 * The tile has to be the hit area, so it is a button. But it needs two lines in two type sizes, and a `TextButton`
 * renders exactly one — so the button carries the surface, the border and the corner, and the labels are children.
 * The rule that made the earlier single-label shape right ("the label and the hit area are the same rectangle") is
 * preserved by the labels filling the button's padded interior rather than by the button drawing its own text.
 *
 * `AutoButtonColor = false` because the engine's pressed tint would be a second piece of feedback for one press, in a
 * different visual language from the scale.
 *
 * ## Why the card is never `accent`-filled
 *
 * There is nothing to select: this project has no equipped item, no ownership and no purchase. A tile is a name and a
 * reaction. The accent belongs to the tab strip's current tab and to the panel's own call to action, which are the
 * only places a "you are here" statement is currently true.
 *
 * ## No shadow on a tile
 *
 * The sheet has the one drop shadow in the panel; a tile that added its own would compete with the surface carrying
 * it. A hairline `UIStroke` in `border` is all the separation a card needs on paper.
 *
 * The subtitle is a placeholder state line — "Not available" — because a tile with only a name looks like a control
 * that does nothing, and this game has nothing to sell yet. It is the honest thing to put in the second line.
 */
export function Tile(options: TileOptions): TextButton {
	const { theme, parent, title, onClick } = options;

	const button = new Instance("TextButton");
	button.Name = `Tile_${title}`;
	button.Size = new UDim2(1, 0, 1, 0);
	button.BackgroundColor3 = theme.paint.card.color;
	button.BackgroundTransparency = theme.paint.card.transparency;
	button.BorderSizePixel = 0;
	button.AutoButtonColor = false;
	button.Text = "";
	button.ZIndex = TILE_Z_INDEX;
	button.Parent = parent;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, TILE_CORNER_RADIUS);
	corner.Parent = button;

	const stroke = new Instance("UIStroke");
	stroke.Color = theme.colors.border;
	stroke.Thickness = TILE_STROKE_THICKNESS;
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
	stroke.Parent = button;

	const padding = new Instance("UIPadding");
	padding.PaddingTop = new UDim(0, TILE_PADDING);
	padding.PaddingBottom = new UDim(0, TILE_PADDING);
	padding.PaddingLeft = new UDim(0, TILE_PADDING);
	padding.PaddingRight = new UDim(0, TILE_PADDING);
	padding.Parent = button;

	const nameLabel = new Instance("TextLabel");
	nameLabel.Name = "Name";
	nameLabel.Size = new UDim2(1, 0, TILE_NAME_FRACTION, 0);
	nameLabel.BackgroundTransparency = 1;
	nameLabel.Font = FONT;
	nameLabel.TextSize = TYPOGRAPHY.body2.size;
	nameLabel.TextColor3 = theme.colors.textPrimary;
	nameLabel.TextXAlignment = Enum.TextXAlignment.Left;
	nameLabel.TextYAlignment = Enum.TextYAlignment.Center;
	nameLabel.TextWrapped = true;
	nameLabel.Text = title;
	nameLabel.ZIndex = TILE_Z_INDEX;
	nameLabel.Parent = button;

	const subtitle = new Instance("TextLabel");
	subtitle.Name = "Subtitle";
	subtitle.Position = new UDim2(0, 0, TILE_NAME_FRACTION, 0);
	subtitle.Size = new UDim2(1, 0, 1 - TILE_NAME_FRACTION, 0);
	subtitle.BackgroundTransparency = 1;
	subtitle.Font = FONT;
	subtitle.TextSize = TYPOGRAPHY.caption.size;
	subtitle.TextColor3 = theme.colors.textDisabled;
	subtitle.TextXAlignment = Enum.TextXAlignment.Left;
	subtitle.TextYAlignment = Enum.TextYAlignment.Top;
	subtitle.TextWrapped = true;
	subtitle.Text = "Not available";
	subtitle.ZIndex = TILE_Z_INDEX;
	subtitle.Parent = button;

	attachPressFeedback(button);
	attachClickSound(button);
	button.Activated.Connect(onClick);

	return button;
}
