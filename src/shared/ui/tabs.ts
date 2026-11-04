import { SPACING, TYPOGRAPHY, FONT } from "./scale";
import { Theme } from "./theme";
import { attachPressFeedback } from "./press";

/** **Placeholder.** Height of the tab strip, in pixels. Fixed so the shelf below it never moves. */
export const TAB_STRIP_HEIGHT = 36;

/** **Placeholder.** Corner radius of a tab. */
const TAB_CORNER_RADIUS = 6;

/** **Placeholder.** Tab horizontal padding, in pixels. */
const TAB_SIDE_PADDING = SPACING.md;

/** **Placeholder.** Draw order of a tab, above the sheet. */
const TAB_Z_INDEX = 3;

/** What a caller may pass to `TabStrip`. */
export interface TabStripOptions {
	theme: Theme;
	parent: Instance;
	tabs: Array<string>;
	selected: string;
	onSelect: (tab: string) => void;
}

/** The strip container plus its buttons, so a caller can restyle or read them if it ever needs to. */
export interface TabStripParts {
	frame: Frame;
	buttons: Map<string, TextButton>;
}

/**
 * A row of category tabs, one selected, that restyles itself on click.
 *
 * ## Why the selection state lives here
 *
 * The strip is the only thing that can express "which tab is selected" — it owns the buttons, their colours and the
 * rule that exactly one of them is highlighted. A caller that had to re-apply the style after each click would be
 * duplicating that rule at every call site, and the first call site that forgot would leave two tabs lit. The caller
 * is told *which* tab was chosen (`onSelect`) and does whatever that means for its content; the strip handles what it
 * looks like.
 *
 * ## Why the selected tab is `accent`-filled with `onAccent` text
 *
 * That is the light direction's one strong colour, and a filled pill is the plainest way to say "you are here"
 * without a second decoration. Unselected tabs use `trough` with `textSecondary`, which is the same pairing the
 * close button uses — one vocabulary for "a control on this sheet" rather than three.
 *
 * The strip is `AutomaticSize.X` inside a centred band, so the tabs sit together in the middle of the sheet instead
 * of stretching across it; a tab's width follows its own label, so two tabs and five tabs both look right.
 */
export function TabStrip(options: TabStripOptions): TabStripParts {
	const { theme, parent, tabs, selected, onSelect } = options;

	const frame = new Instance("Frame");
	frame.Name = "Tabs";
	frame.Size = new UDim2(1, 0, 0, TAB_STRIP_HEIGHT);
	frame.BackgroundTransparency = 1;
	frame.LayoutOrder = 2;
	frame.ZIndex = TAB_Z_INDEX;
	frame.Parent = parent;

	const padding = new Instance("UIPadding");
	padding.PaddingLeft = new UDim(0, SPACING.md);
	padding.PaddingRight = new UDim(0, SPACING.md);
	padding.PaddingBottom = new UDim(0, SPACING.sm);
	padding.Parent = frame;

	const row = new Instance("Frame");
	row.Name = "Row";
	row.AnchorPoint = new Vector2(0.5, 0);
	row.Position = UDim2.fromScale(0.5, 0);
	row.Size = new UDim2(0, 0, 1, 0);
	row.AutomaticSize = Enum.AutomaticSize.X;
	row.BackgroundTransparency = 1;
	row.ZIndex = TAB_Z_INDEX;
	row.Parent = frame;

	const rowLayout = new Instance("UIListLayout");
	rowLayout.FillDirection = Enum.FillDirection.Horizontal;
	rowLayout.SortOrder = Enum.SortOrder.LayoutOrder;
	rowLayout.Padding = new UDim(0, SPACING.xs);
	rowLayout.VerticalAlignment = Enum.VerticalAlignment.Center;
	rowLayout.Parent = row;

	const buttons = new Map<string, TextButton>();
	let current = selected;

	const restyle = () => {
		for (const [name, button] of buttons) {
			const isSelected = name === current;
			button.BackgroundColor3 = isSelected ? theme.colors.accent : theme.paint.trough.color;
			button.BackgroundTransparency = isSelected ? 0 : theme.paint.trough.transparency;
			button.TextColor3 = isSelected ? theme.colors.onAccent : theme.colors.textSecondary;
		}
	};

	let order = 1;
	for (const name of tabs) {
		const button = new Instance("TextButton");
		button.Name = `${name}Tab`;
		button.Size = new UDim2(0, 0, 1, 0);
		button.AutomaticSize = Enum.AutomaticSize.X;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Font = FONT;
		button.TextSize = TYPOGRAPHY.body2.size;
		button.Text = name;
		button.LayoutOrder = order;
		button.ZIndex = TAB_Z_INDEX;
		button.Parent = row;
		order++;

		const buttonPadding = new Instance("UIPadding");
		buttonPadding.PaddingLeft = new UDim(0, TAB_SIDE_PADDING);
		buttonPadding.PaddingRight = new UDim(0, TAB_SIDE_PADDING);
		buttonPadding.Parent = button;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, TAB_CORNER_RADIUS);
		corner.Parent = button;

		attachPressFeedback(button);

		button.Activated.Connect(() => {
			if (current === name) {
				return;
			}

			current = name;
			restyle();
			onSelect(name);
		});

		buttons.set(name, button);
	}

	// After the loop, so every button exists before the first style pass runs.
	restyle();

	return { frame, buttons };
}
