import { ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { FONT, SPACING, TYPOGRAPHY } from "shared/ui/scale";
import { surfaceOpaqueTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { Panel, PanelFooter, PanelHeader } from "shared/ui/panel";
import { TabStrip } from "shared/ui/tabs";
import { Shelf } from "shared/ui/shelf";
import { Tile } from "shared/ui/tile";
import { attachPressFeedback } from "shared/ui/press";
import { capToViewport } from "shared/ui/viewport";

/** The one phase the tabs belong to. Written out here because a client cannot import the server's `RoundPhase`. */
const PHASE_INTERMISSION = "Intermission";

/** **Placeholder.** The shop sheet, in pixels. Clamped to the viewport by `capToViewport`. */
const SHOP_PANEL_SIZE = UDim2.fromOffset(460, 360);

/** **Placeholder.** The inventory sheet, in pixels. Shorter than the shop: it holds one line. */
const INVENTORY_PANEL_SIZE = UDim2.fromOffset(380, 280);

/** **Placeholder.** Height of one edge tab, in pixels. */
const TAB_HEIGHT = 34;

/**
 * **Placeholder.** How deep the rail's left inset is, in pixels.
 *
 * The rail itself sits on the screen's left edge — that is where a tab belongs. This inset keeps the tab's rounded
 * corner off the frame edge, which otherwise reads as a clipped card rather than as a tab.
 */
const TAB_EDGE_INSET = SPACING.sm;

/** **Placeholder.** Draw order of the tabs. Above every band inside a sheet, so a tab is never buried by a panel. */
const TAB_Z_INDEX = 4;

/** **Placeholder.** Tab border weight. Hairline, so a tab is a labelled rectangle rather than a second sheet. */
const TAB_STROKE_THICKNESS = 1;

/** **Placeholder.** The shop's categories. Two, because there are two kinds of thing the game could sell. */
const SHOP_CATEGORIES = ["Balls", "Perks"];

/** **Placeholder.** The category the shop opens on. */
const SHOP_DEFAULT_CATEGORY = "Balls";

/** **Placeholder.** The shop's placeholder stock. Names only — nothing here is purchasable. */
const SHOP_BALL_NAMES = ["Bully Ball", "Ghost Ball", "Bounce Ball"];

/** **Placeholder.** The shop's status line. It says the same thing on both tabs, because both are placeholders. */
const SHOP_FOOTER = "Nothing here is purchasable yet.";

/** **Placeholder.** The empty state of the shop's second category. */
const PERKS_EMPTY = "No perks yet";

/** **Placeholder.** The inventory's empty state. */
const INVENTORY_EMPTY = "Nothing yet";

/** **Placeholder.** The inventory's status line. */
const INVENTORY_FOOTER = "Nothing can be held yet.";

/** Which panel the controller can open. */
type PanelId = "shop" | "inventory";

/**
 * The shop and the inventory: two edge tabs, two sheets, one open state.
 *
 * ## Why one controller owns both panels
 *
 * "Which panel is open" is a single fact with three values — `shop`, `inventory`, `none` — and **both** tabs write to
 * it. Split into a `ShopController` and an `InventoryController`, that fact would have to live on a shared instance,
 * both controllers would subscribe to it to know whether to hide themselves, and each would hold half of a rule that
 * only makes sense whole ("opening one closes the other"). That is one controller with a `Value` in the middle plus
 * two subscribers, which is more moving parts than the thing it models — rule 8's "builders, not a framework"
 * applied to controllers. One file, one `open` field, one place where exclusivity is true by construction.
 *
 * ## The phase rule, and which of the two readings it is
 *
 * **The tabs are visible only during `Intermission`. A panel that is already open stays open when the phase
 * changes, and is closed on entry to the *next* `Intermission` — not on exit from this one.** That is the (B)
 * reading, and the difference is the whole point: a player who is mid-decision when `Waiting` begins keeps their
 * sheet and their place in it, but the tab is gone, so they cannot open a second one until the next intermission
 * starts. Forcing the sheet shut on exit would be (A), which throws away what the player was reading to punish them
 * for the clock.
 *
 * Closing on the *next* entry rather than on exit is also what makes the two rules not fight: the sheet is only ever
 * closed at a moment when opening it would immediately be wrong, because the tab that opens it is being revealed at
 * the same instant.
 *
 * ## Why the panels are built lazily
 *
 * A sheet is a few hundred instances — a header, a tab strip, a grid of tiles, a footer, and the strokes and corners
 * on each. Built at mount, both sheets would exist for every player for the whole session even though most players
 * in most sessions never click either tab, and the cost would be paid inside the same frame as the HUD's own mount.
 * Built on first open, the cost is paid by the player who asked for the panel, in the frame they asked for it, and a
 * panel that is never opened costs nothing. The trade is that the first open is one frame heavier than the second —
 * which is not observable, because the panel appears with no animation either way.
 *
 * ## Why nothing here is authoritative
 *
 * There is no currency, no purchase and no remote in this file. A tile logs the name it carries and stops. The
 * moment a click has to change something the server owns, that click becomes a remote with a server-side handler,
 * and the tile grows a result to report — neither of which exists yet.
 */
@Controller()
export class ShopController implements OnStart {
	private readonly light: Theme = surfaceOpaqueTheme();

	private readonly panels = new Map<PanelId, Frame>();
	private readonly tabButtons = new Map<PanelId, TextButton>();

	private rail!: Frame;
	private open: "shop" | "inventory" | "none" = "none";
	private phase = "unknown";

	public onStart(): void {
		const gui = getScreenGui("hudCore");
		this.rail = this.buildTabRail(gui);
		this.applyPhase(this.readPhase());

		print(`[Shop] mounted phase=${this.phase} tabs=${this.rail.Visible ? "visible" : "hidden"}`);
	}

	/**
	 * Reads the phase once and subscribes.
	 *
	 * A client can start at any point in the cycle, including the middle of an `Intermission`, so a controller that
	 * only subscribed would leave a late joiner with no tabs until the *next* intermission — the exact case a player
	 * joining a running server experiences. Same shape as `RoundStateController`, for the same reason, and bounded
	 * for the same reason: an unbounded `WaitForChild` turns "the server never created it" into a silent yield.
	 *
	 * A missing value is a warning and no tabs, not a failed mount: the rest of the HUD is unaffected by a panel that
	 * cannot know its phase, and a controller that threw would take the UI layer down with it.
	 */
	private readPhase(): string {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, 10);

		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[Shop] no ${ROUND_STATE_VALUE_NAME} StringValue in ReplicatedStorage — tabs stay hidden.`);
			return "unknown";
		}

		value.Changed.Connect(() => {
			this.applyPhase(value.Value);
		});

		return value.Value;
	}

	/** Applies the (B) rule to a phase. Used for the mount read and for every change, so there is one rule. */
	private applyPhase(phase: string): void {
		this.phase = phase;

		const inIntermission = phase === PHASE_INTERMISSION;
		this.rail.Visible = inIntermission;

		if (!inIntermission) {
			// (B): the sheet stays open. Only the way back in is removed.
			return;
		}

		// Closed on entry to the next `Intermission`, never on exit from this one. A no-op at mount, because
		// nothing can be open yet.
		if (this.open !== "none") {
			this.setOpen("none");
		}
	}

	private buildTabRail(parent: Instance): Frame {
		const rail = new Instance("Frame");
		rail.Name = "PanelTabs";
		rail.AnchorPoint = new Vector2(0, 0.5);
		rail.Position = UDim2.fromScale(0, 0.5);
		rail.Size = new UDim2(0, 0, 0, 0);
		rail.AutomaticSize = Enum.AutomaticSize.XY;
		rail.BackgroundTransparency = 1;
		rail.BorderSizePixel = 0;
		rail.Visible = false;
		rail.ZIndex = TAB_Z_INDEX;
		rail.Parent = parent;

		const padding = new Instance("UIPadding");
		padding.PaddingLeft = new UDim(0, TAB_EDGE_INSET);
		padding.Parent = rail;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.sm);
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Left;
		layout.Parent = rail;

		this.buildTab(rail, "shop", "Shop", 1);
		this.buildTab(rail, "inventory", "Inventory", 2);
		this.restyleTabs();

		return rail;
	}

	private buildTab(parent: Instance, id: PanelId, label: string, order: number): void {
		const button = new Instance("TextButton");
		button.Name = `${label}Tab`;
		button.Size = new UDim2(0, 0, 0, TAB_HEIGHT);
		button.AutomaticSize = Enum.AutomaticSize.X;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Font = FONT;
		button.TextSize = TYPOGRAPHY.body1.size;
		button.Text = label;
		button.LayoutOrder = order;
		button.ZIndex = TAB_Z_INDEX;
		button.Parent = parent;

		const padding = new Instance("UIPadding");
		padding.PaddingLeft = new UDim(0, SPACING.md);
		padding.PaddingRight = new UDim(0, SPACING.md);
		padding.Parent = button;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, TAB_EDGE_INSET);
		corner.Parent = button;

		const stroke = new Instance("UIStroke");
		stroke.Color = this.light.colors.border;
		stroke.Thickness = TAB_STROKE_THICKNESS;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = button;

		attachPressFeedback(button);
		button.Activated.Connect(() => {
			this.toggle(id);
		});

		this.tabButtons.set(id, button);
	}

	/** Which tab looks selected is a statement about `open`, so it is derived from `open` and never stored twice. */
	private restyleTabs(): void {
		const light = this.light;

		for (const [id, button] of this.tabButtons) {
			const selected = this.open === id;
			button.BackgroundColor3 = selected ? light.colors.accent : light.paint.card.color;
			button.BackgroundTransparency = selected ? 0 : light.paint.card.transparency;
			button.TextColor3 = selected ? light.colors.onAccent : light.colors.textPrimary;
		}
	}

	private toggle(target: PanelId): void {
		this.setOpen(this.open === target ? "none" : target);
	}

	private setOpen(target: "shop" | "inventory" | "none"): void {
		this.open = target;

		if (target !== "none") {
			// Built before the visibility pass so the panel it just created is included in it.
			this.ensurePanel(target);
		}

		for (const [id, panel] of this.panels) {
			panel.Visible = id === target;
		}

		this.restyleTabs();
		print(`[Shop] open=${this.open} phase=${this.phase}`);
	}

	private ensurePanel(id: PanelId): Frame {
		const existing = this.panels.get(id);
		if (existing !== undefined) {
			return existing;
		}

		const gui = getScreenGui("hudCore");
		const panel = id === "shop" ? this.buildShop(gui) : this.buildInventory(gui);
		panel.Visible = false;
		this.panels.set(id, panel);

		return panel;
	}

	private buildShop(parent: Instance): Frame {
		const light = this.light;
		const parts = Panel({ theme: light, parent, size: SHOP_PANEL_SIZE });
		const surface = parts.surface;

		capToViewport(parts.frame);

		PanelHeader({
			theme: light,
			parent: surface,
			title: "Shop",
			onClose: () => this.setOpen("none"),
		});

		const ballsShelf = Shelf({ theme: light, parent: surface });
		for (let index = 0; index < SHOP_BALL_NAMES.size(); index++) {
			const name = SHOP_BALL_NAMES[index];
			const tile = Tile({
				theme: light,
				parent: ballsShelf,
				title: name,
				onClick: () => print(`[Shop] ${name} clicked`),
			});
			tile.LayoutOrder = index + 1;
		}

		const perksShelf = Shelf({ theme: light, parent: surface });
		perksShelf.Visible = false;

		const perksEmpty = this.buildEmptyState(surface, PERKS_EMPTY);

		PanelFooter({ theme: light, parent: surface, text: SHOP_FOOTER });

		TabStrip({
			theme: light,
			parent: surface,
			tabs: SHOP_CATEGORIES,
			selected: SHOP_DEFAULT_CATEGORY,
			onSelect: (tab) => {
				const balls = tab === SHOP_DEFAULT_CATEGORY;
				ballsShelf.Visible = balls;
				perksShelf.Visible = !balls;
				perksEmpty.Visible = !balls;
			},
		});

		perksEmpty.Visible = false;

		return parts.frame;
	}

	private buildInventory(parent: Instance): Frame {
		const light = this.light;
		const parts = Panel({ theme: light, parent, size: INVENTORY_PANEL_SIZE });
		const surface = parts.surface;

		capToViewport(parts.frame);

		PanelHeader({
			theme: light,
			parent: surface,
			title: "Inventory",
			onClose: () => this.setOpen("none"),
		});

		// No shelf here. There is nothing to scroll and nothing to hold, and an empty scrolling canvas would be a
		// blank frame that says "this is broken" rather than "this is empty". The one line says it instead.
		this.buildEmptyState(surface, INVENTORY_EMPTY);

		PanelFooter({ theme: light, parent: surface, text: INVENTORY_FOOTER });

		return parts.frame;
	}

	/**
	 * The centred, quiet line a panel shows when it has no content.
	 *
	 * Fills the space the shelf would have taken, so an empty panel and a full one put the same band in the same
	 * place — the sheet does not change shape because of what is in it.
	 */
	private buildEmptyState(parent: Instance, text: string): TextLabel {
		const label = new Instance("TextLabel");
		label.Name = "EmptyState";
		label.Size = new UDim2(1, 0, 0, 0);
		label.BackgroundTransparency = 1;
		label.Font = FONT;
		label.TextSize = TYPOGRAPHY.body2.size;
		label.TextColor3 = this.light.colors.textSecondary;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.TextWrapped = true;
		label.Text = text;
		label.LayoutOrder = 4;
		label.ZIndex = TAB_Z_INDEX;
		label.Parent = parent;

		const flex = new Instance("UIFlexItem");
		flex.FlexMode = Enum.UIFlexMode.Fill;
		flex.Parent = label;

		const padding = new Instance("UIPadding");
		padding.PaddingLeft = new UDim(0, SPACING.md);
		padding.PaddingRight = new UDim(0, SPACING.md);
		padding.Parent = label;

		return label;
	}
}
