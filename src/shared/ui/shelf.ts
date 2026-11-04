import { SPACING } from "./scale";
import { Theme } from "./theme";

/** **Placeholder.** Tile width in the grid, in pixels. Fixed, and that is the responsive decision — see below. */
export const SHELF_TILE_WIDTH = 132;

/** **Placeholder.** Tile height in the grid, in pixels. */
export const SHELF_TILE_HEIGHT = 76;

/** **Placeholder.** Gap between tiles, in pixels. */
const SHELF_TILE_GAP = SPACING.sm;

/**
 * **Placeholder.** Inset between the shelf's clip edge and the first tile, in pixels.
 *
 * A shelf clips — it has to, it scrolls — so a tile standing on the canvas's own corner has its outline, its corner
 * and its hover overscale cut off by the frame's edge. The inset has to be *inside* that clip, which is why it is
 * padding on the shelf itself rather than a margin invented by each tile.
 */
const SHELF_INSET = SPACING.sm;

/** **Placeholder.** Scrollbar width, in pixels. Thin, because a wide bar on a light sheet is a dark stripe. */
const SHELF_SCROLLBAR_THICKNESS = 6;

/** **Placeholder.** Draw order of the shelf, above the sheet. */
const SHELF_Z_INDEX = 3;

/** What a caller may pass to `Shelf`. */
export interface ShelfOptions {
	theme: Theme;
	parent: Instance;
}

/**
 * A scrolling area whose tiles are a fixed size in a wrapping grid.
 *
 * ## Why the cells are fixed pixels when everything else here is scale
 *
 * **It is the one place where fixed is the responsive answer rather than the lazy one.** A scrolling canvas has no
 * scale to divide — its size exists *because* of its contents, so a scale-height cell would be a fraction of the
 * thing the fraction is meant to determine. Fixed cells also give the column count for free: a `UIGridLayout` fits as
 * many `SHELF_TILE_WIDTH` cells across as the width allows and wraps the rest, so the panel gets fewer columns on a
 * phone without anybody choosing three or four.
 *
 * ## Why the padding and the layout are on the same frame
 *
 * A tile's box comes from its `CellSize`, so the layout that gives it one must be on the frame the tiles are parented
 * to — and the inset must be inside the clip, which is the same frame. An inner holder would take the layout with it
 * and leave every tile zero-sized, which is the failure this comment exists to stop someone reintroducing.
 *
 * `AutomaticCanvasSize` is vertical only, so the canvas grows downwards and the scrollbar appears when it has to.
 * `ElasticBehavior` is off because a shelf that rubber-bands away from the pointer is a shelf that moves under a
 * click.
 *
 * `UIFlexItem` with `Fill` lets the shelf take whatever vertical space the bands above and below it leave, which is
 * what keeps one panel definition working at any panel height.
 */
export function Shelf(options: ShelfOptions): ScrollingFrame {
	const { theme, parent } = options;

	const shelf = new Instance("ScrollingFrame");
	shelf.Name = "Shelf";
	shelf.Size = new UDim2(1, 0, 0, 0);
	shelf.BackgroundTransparency = 1;
	shelf.BorderSizePixel = 0;
	shelf.ScrollBarThickness = SHELF_SCROLLBAR_THICKNESS;
	shelf.ScrollBarImageColor3 = theme.colors.border;
	shelf.ScrollingDirection = Enum.ScrollingDirection.Y;
	shelf.CanvasSize = UDim2.fromOffset(0, 0);
	shelf.AutomaticCanvasSize = Enum.AutomaticSize.Y;
	shelf.ElasticBehavior = Enum.ElasticBehavior.Never;
	shelf.LayoutOrder = 3;
	shelf.ZIndex = SHELF_Z_INDEX;
	shelf.Parent = parent;

	const flex = new Instance("UIFlexItem");
	flex.FlexMode = Enum.UIFlexMode.Fill;
	flex.Parent = shelf;

	const padding = new Instance("UIPadding");
	padding.PaddingTop = new UDim(0, SHELF_INSET);
	padding.PaddingBottom = new UDim(0, SHELF_INSET);
	padding.PaddingLeft = new UDim(0, SHELF_INSET);
	padding.PaddingRight = new UDim(0, SHELF_INSET);
	padding.Parent = shelf;

	const grid = new Instance("UIGridLayout");
	grid.CellSize = UDim2.fromOffset(SHELF_TILE_WIDTH, SHELF_TILE_HEIGHT);
	grid.CellPadding = UDim2.fromOffset(SHELF_TILE_GAP, SHELF_TILE_GAP);
	grid.SortOrder = Enum.SortOrder.LayoutOrder;
	grid.HorizontalAlignment = Enum.HorizontalAlignment.Left;
	grid.Parent = shelf;

	return shelf;
}
