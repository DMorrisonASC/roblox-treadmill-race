/**
 * **Placeholder.** Thickness of the black outline drawn around panel text, in pixels.
 *
 * `2` is the weight that survives being read at `caption` size on a charcoal face without closing the counters of small
 * glyphs. The chunky button's title uses `3` because it is a poster at 14-18 pixels on a saturated card; body copy wants
 * less ink than a title does, or a dense panel starts to look embossed rather than outlined.
 */
export const TEXT_OUTLINE_THICKNESS = 2;

/** **Placeholder.** The outline is pure black, matching the button's title stroke and the sheet's own outline family. */
const TEXT_OUTLINE_COLOR = Color3.fromRGB(0, 0, 0);

/**
 * Outlines a label's glyphs in black, so text reads on any surface it is placed on.
 *
 * ## Why a `UIStroke` and why no `ApplyStrokeMode`
 *
 * `UIStroke` on a `TextLabel`/`TextButton` defaults to `ApplyStrokeMode.Contextual`, and for a text object that means **the
 * glyphs**, not the label's rectangle - which is exactly the comic-book outline the chunky style wants. Setting
 * `ApplyStrokeMode.Border` would draw a box around the label instead, which is why this leaves the default alone; the sheet
 * and the chunky plates name `Border` explicitly for the opposite reason.
 *
 * ## Why it is a function and not a flag on every builder
 *
 * Text in the panels is created in three ways - the controller's own `text()` factory, a handful of `TextLabel`s built by
 * hand for cards, and `TextButton`s that carry their label themselves - and the outline has to be on all of them or the
 * panel looks half-finished. One function called at each creation site is the only shape where "every label is outlined" is
 * something a reader can verify by searching for one name.
 *
 * Idempotent by construction rather than by a check: a second call adds a second stroke, which is a bug at the call site
 * rather than a case worth guarding. Nothing in the tree calls it twice.
 *
 * ## Why it returns the stroke (item 149)
 *
 * Because a stroke's transparency is **its own property** and does not ride along with the label's - the finding
 * `payout-controller` records for text outlines ("lowering a label's `TextTransparency` leaves the outline solid"). Anything
 * that fades a label out has to fade the outline separately, and it cannot do that through a function that hands back
 * nothing: the countdown would have to build its own stroke, which is the one thing this function exists to stop. Callers
 * that only want the outline ignore the return; `CountdownController` is the first that does not.
 */
export function outlineText(text: TextLabel | TextButton): UIStroke {
	const stroke = new Instance("UIStroke");
	stroke.Color = TEXT_OUTLINE_COLOR;
	stroke.Thickness = TEXT_OUTLINE_THICKNESS;
	stroke.Parent = text;
	return stroke;
}
