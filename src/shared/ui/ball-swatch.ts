import { iconForBall } from "shared/ball-icon";

/**
 * **Draws one ball's icon inside a swatch that is already there.**
 *
 * ## Why this is a helper rather than seven lines repeated
 *
 * Seven places draw a ball in the UI - the picker's card, the reveal's face, the store's prize card and `View All` catalog
 * card, the inventory's `Balls` card, the fusion row's material pip, and the inventory's detail preview - and they are all the
 * same object: a small `Frame` filled with the ball's own colour (item 226) and rounded by a `UICorner`. Adding the icon at
 * seven call sites means seven chances to set `ScaleType` differently or forget the `ZIndex`, and the seventh is the one nobody
 * looks at. Here they are identical by construction, and the next site is one line.
 *
 * ## Why the icon goes *inside* the frame and does not replace it
 *
 * **An `ImageLabel` whose `Image` is missing, empty or still loading draws nothing at all** - item 165 recorded the same fact
 * for a `BillboardGui`, and the pickup sprite (item 144) is the tree's own example of an asset failing silently. Replacing the
 * tinted frame with an image would make "the icon has not resolved" a hole in the layout. Inside, the ball's colour is already
 * painted underneath, so the failure mode is the swatch the player has been looking at since item 226 rather than a gap.
 *
 * ## `ScaleType.Fit`, and why not `Stretch`
 *
 * The frames are square by construction (every call site passes one offset size twice), and the icons are square drawings, so
 * both settings look identical when everything is as designed. `Fit` is the one that stays honest when it is not: a
 * non-square drawing letterboxes inside the square rather than being stretched into an oval, and a stretched ball is a bug
 * nobody notices until a designer uploads a 512x256 asset.
 *
 * ## The `ZIndex`
 *
 * One above the frame's own. Every one of these panels runs `ZIndexBehavior.Global` - the picker's own comment records the
 * trap - so a child at a lower `ZIndex` than its parent is drawn behind the parent's background and would be invisible. `+ 1`
 * is correct under either behaviour, which is why it is written as the parent's value rather than as a literal.
 *
 * ## The `UICorner` is not a clip
 *
 * A `UICorner` rounds the frame's **background**; it does not clip its children, and none of the seven swatches sets
 * `ClipsDescendants`. So the icon is drawn whole, and a silhouette that is not perfectly round - `bully`'s spikes,
 * `sprinter`'s speed lines, `decoy`'s twin - is not cut off by the circle behind it.
 */
export function attachBallIcon(frame: GuiObject, ballId: string): ImageLabel {
	const icon = new Instance("ImageLabel");

	icon.Name = "Icon";
	icon.Size = UDim2.fromScale(1, 1);
	icon.Position = UDim2.fromScale(0, 0);
	icon.AnchorPoint = new Vector2(0, 0);
	icon.BackgroundTransparency = 1;
	icon.BorderSizePixel = 0;
	// `?? ""` rather than a fallback id: an empty `Image` draws nothing, which is the "colour shows through" case above.
	icon.Image = iconForBall(ballId) ?? "";
	icon.ScaleType = Enum.ScaleType.Fit;
	icon.ZIndex = frame.ZIndex + 1;
	icon.Parent = frame;

	return icon;
}
