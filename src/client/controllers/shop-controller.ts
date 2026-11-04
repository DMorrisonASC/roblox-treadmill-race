import { Players, ReplicatedStorage, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import {
	PLAYER_COINS_ATTRIBUTE,
	PLAYER_ECONOMY_STATE_ATTRIBUTE,
	PLAYER_OWNED_BALLS_ATTRIBUTE,
} from "shared/attributes";
import {
	BALL_POOL,
	COIN_CHEST_COST,
	decodeOwnedBalls,
	ECONOMY_ACTION_COOLDOWN_MS,
	FUSION_INPUT_COUNT,
	FUSION_TABLE,
	RARITIES,
	Rarity,
	rarityOfBall,
} from "shared/economy.config";
import { chestOdds, fusionOdds } from "shared/odds";
import {
	FUSE_BALLS_REMOTE_NAME,
	OPEN_COIN_CHEST_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
	ROUND_STATE_VALUE_NAME,
} from "shared/remotes";
import { FONT, SPACING, TYPOGRAPHY } from "shared/ui/scale";
import { surfaceOpaqueTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { Panel, PanelFooter, PanelHeader } from "shared/ui/panel";
import { attachPressFeedback } from "shared/ui/press";
import { capToViewport } from "shared/ui/viewport";

/** The one phase the tabs belong to. A client cannot import the server's `RoundPhase`. */
const PHASE_INTERMISSION = "Intermission";

// #region geometry

/**
 * **Placeholder.** The store's width in pixels, clamped down by `capToViewport` on a narrow screen.
 *
 * **Neither dimension is a fraction of the screen any more, and that is the fix for the clipping.** The sheet sizes
 * itself to its content (`AutomaticSize.Y`), so its height is whatever the bands add up to; its width is a fixed,
 * comfortable column that `capToViewport` shrinks only when the viewport is narrower than it. A fraction of the width
 * made the store a 1500-pixel letterbox on a monitor, and a fraction of the height is what produced the empty space
 * the previous version was criticised for.
 */
const STORE_MAX_WIDTH = 880;

/** **Placeholder.** Header band height, in pixels. */
const HEADER_HEIGHT = 50;

/** **Placeholder.** Category tab height, in pixels. */
const TAB_HEIGHT = 46;

/** **Placeholder.** A section title's height, in pixels. */
const SECTION_TITLE_HEIGHT = 24;

/** **Placeholder.** The chest-preview row's height, in pixels. */
const PREVIEW_ROW_HEIGHT = 116;

/** **Placeholder.** The chest image placeholder's side, in pixels. Compact, as the brief asks. */
const CHEST_SQUARE = 108;

/** **Placeholder.** Height of the `Prize Preview` / `View All` header row, in pixels. */
const PRIZE_HEADER_HEIGHT = 22;

/** **Placeholder.** Height of the scrolling prize shelf, in pixels. */
const SHELF_HEIGHT = 82;

/** **Placeholder.** Prize card width, in pixels. */
const CARD_WIDTH = 82;

/** **Placeholder.** Prize card art height, in pixels. */
const CARD_ART = 46;

/** **Placeholder.** Height of the purchase-button row, in pixels. A tall target, as in the reference. */
const BUTTON_ROW_HEIGHT = 58;

/** **Placeholder.** Inset between the sheet edge and its content, in pixels. */
const SHEET_INSET = SPACING.md;

/** **Placeholder.** Gap between stacked bands, in pixels. */
const BAND_GAP = SPACING.xs + 2;

/** **Placeholder.** Diameter of the coin placeholder circle, in pixels. */
const COIN_SIZE = 20;

/** **Placeholder.** Scroll speed of the prize shelf, in pixels per second. */
const SHELF_SCROLL_SPEED = 26;

/** **Placeholder.** Diameter of a rarity swatch circle, in pixels. */
const SWATCH = 24;

/** **Placeholder.** Draw order of the store's chrome, above `hudCore`'s rail. */
const STORE_Z_INDEX = 5;

/** **Placeholder.** Hairline border weight. */
const HAIRLINE = 1;

/** **Placeholder.** A full circle's corner radius: round at any size. */
const ROUND = new UDim(1, 0);

/** **Placeholder.** Half, for centre-anchored elements. */
const CENTRE = 0.5;

// #endregion

// #region inventory geometry

/** The inventory sheet, unchanged from the placeholder round. */
const INVENTORY_PANEL_SIZE = UDim2.fromOffset(380, 280);

/** **Placeholder.** Height of one rail tab, in pixels. */
const RAIL_TAB_HEIGHT = 34;

/** **Placeholder.** Rail inset from the screen edge, in pixels, so a rounded corner is not clipped. */
const RAIL_INSET = SPACING.sm;

/** **Placeholder.** Draw order of the rail tabs. */
const RAIL_Z_INDEX = 4;

/** **Placeholder.** The inventory's empty state. */
const INVENTORY_EMPTY = "Nothing yet";

/** **Placeholder.** The inventory's status line. */
const INVENTORY_FOOTER = "Nothing can be held yet.";

// #endregion

/**
 * **Placeholder.** The two categories.
 *
 * The brief's hierarchy names `Balls` and `Emotes`. **`Emotes` does not exist in this game** — there is no emote
 * data, no emote storage and no way to grant one — so a tab for it would be a button that leads to an empty section,
 * which the same brief forbids ("Do not add unnecessary categories", "Do not create placeholder content"). The second
 * tab is therefore `Fusion`, the game's other real action: it consumes two owned balls and rolls for a higher tier.
 * Both tabs are real; neither invents content.
 */
const STORE_TABS = ["Balls", "Fusion"] as const;

type StoreTab = (typeof STORE_TABS)[number];

/** What the server answers a chest press with, mirroring `EconomyService`'s union. */
type ChestResult = { ok: true; ballId: string } | { ok: false; reason: string };

/** What the server answers a fusion with. */
type FusionResult = { ok: true; outcome: "success" | "fail"; resultBallId?: string } | { ok: false; reason: string };

/** Which panel the controller can open. */
type PanelId = "shop" | "inventory";

/**
 * The store and the inventory: two rail tabs, two sheets, one open state.
 *
 * ## Why one controller owns both panels
 *
 * "Which panel is open" is one fact with three values that both rail tabs write. Split into a `ShopController` and an
 * `InventoryController`, that fact would live on a shared instance with two subscribers, and each controller would hold
 * half of a rule that only makes sense whole ("opening one closes the other"). One file, one `open` field, one place
 * where exclusivity is true by construction.
 *
 * ## The phase rule, and which of the two readings it is
 *
 * **Tabs are visible only during `Intermission`. A panel already open stays open when the phase changes, and closes on
 * entry to the *next* `Intermission` — not on exit from this one.** That is reading (B): a player mid-decision when
 * `Waiting` begins keeps their sheet and their place in it, but the way back in is gone until the next intermission.
 *
 * ## Why the store's text is NOT big-ui `Text`
 *
 * The previous version used big-ui's `Text` for every label and every one of them rendered **invisible**. The cause is
 * structural, not a typo: `Text` resolves `TextColor3` and `TextTransparency` from big-ui's module-level `Palette`,
 * `getTheme()` is the only direction ever pushed into that table, and it is the **dark** HUD palette — pale ink. The
 * light direction deliberately pushes nothing (it would repaint the phase banner), so a store label asking big-ui for
 * "primary" gets white on paper. Assigning `TextColor3` after construction does not reliably survive the library's own
 * hydration.
 *
 * So the store builds plain `TextLabel`s through Fusion and sets font, size and colour itself. That is one less layer
 * between the theme and the pixel, and it is the same idiom `PhaseBannerController` already uses for its container.
 */
@Controller()
export class ShopController implements OnStart {
	private readonly light: Theme = surfaceOpaqueTheme();
	private readonly player = Players.LocalPlayer;

	private readonly panels = new Map<PanelId, Frame>();
	private readonly railButtons = new Map<PanelId, TextButton>();

	private rail!: Frame;
	private open: "shop" | "inventory" | "none" = "none";
	private phase = "unknown";

	// #region store state

	private chestRemote?: RemoteEvent;
	private fusionRemote?: RemoteEvent;

	/** The store's Fusion scope. Created with the panel and never before it — a closed store owns nothing. */
	private scope?: Fusion.Scope<unknown>;

	private coinsLabel?: TextLabel;
	private statusLabel?: TextLabel;
	private prizeShelf?: ScrollingFrame;
	private ownedShelf?: ScrollingFrame;
	private ownedEmpty?: TextLabel;
	private fusionDetailLabel?: TextLabel;
	private fusionOddsLabel?: TextLabel;
	private fusionButton?: TextButton;
	private chestButtons = new Array<TextButton>();

	private chestSection?: Frame;
	private fusionSection?: Frame;
	private readonly storeTabButtons = new Map<StoreTab, TextButton>();
	private readonly storeTabStrokes = new Map<StoreTab, UIStroke>();
	private readonly ownedCards = new Array<TextButton>();

	/** The ball the player is about to fuse, or `undefined` when nothing is selected. */
	private selectedBallId?: string;

	/** True between a press and its reply, so one press cannot become three. */
	private busy = false;

	/** Queue of pending chest opens, drained one per cooldown — see `openChests`. */
	private pendingOpens = 0;

	// #endregion

	public onStart(): void {
		const gui = getScreenGui("hudCore");
		this.rail = this.buildRail(gui);
		this.applyPhase(this.readPhase());
		this.connectRemotes();
		this.connectAttributes();
		this.drivePrizeShelf();

		print(`[Shop] mounted phase=${this.phase} tabs=${this.rail.Visible ? "visible" : "hidden"}`);
	}

	/**
	 * Keeps the store in step with the three player attributes.
	 *
	 * Connected once at mount, because the attributes are the only channel the server has into the store: a remote
	 * reply carries an outcome, not a balance. Every handler no-ops while the panel does not exist.
	 */
	private connectAttributes(): void {
		this.player.GetAttributeChangedSignal(PLAYER_COINS_ATTRIBUTE).Connect(() => this.refreshCoins());
		this.player.GetAttributeChangedSignal(PLAYER_ECONOMY_STATE_ATTRIBUTE).Connect(() => this.refreshCoins());
		this.player.GetAttributeChangedSignal(PLAYER_OWNED_BALLS_ATTRIBUTE).Connect(() => this.refreshOwned());
	}

	/**
	 * Finds the two economy remotes and subscribes to their replies.
	 *
	 * Bounded waits, for the reason `PhaseBannerController` states: an unbounded `WaitForChild` turns "the server never
	 * made it" into a client that hangs with no error. A missing remote is a warning and a dead button, not a failed
	 * mount.
	 */
	private connectRemotes(): void {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, 10);
		if (folder === undefined) {
			warn(`[Shop] no ${REMOTES_FOLDER_NAME} folder — the store's buttons will do nothing.`);
			return;
		}

		const chest = folder.WaitForChild(OPEN_COIN_CHEST_REMOTE_NAME, 10);
		if (chest !== undefined && chest.IsA("RemoteEvent")) {
			this.chestRemote = chest;
			chest.OnClientEvent.Connect((result: unknown) => this.onChestResult(result));
		} else {
			warn(`[Shop] no ${OPEN_COIN_CHEST_REMOTE_NAME} remote — the chest button will do nothing.`);
		}

		const fusion = folder.WaitForChild(FUSE_BALLS_REMOTE_NAME, 10);
		if (fusion !== undefined && fusion.IsA("RemoteEvent")) {
			this.fusionRemote = fusion;
			fusion.OnClientEvent.Connect((result: unknown) => this.onFusionResult(result));
		} else {
			warn(`[Shop] no ${FUSE_BALLS_REMOTE_NAME} remote — fusion will do nothing.`);
		}
	}

	/** Reads the phase once so a player joining mid-`Intermission` gets the tabs, then subscribes. */
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

		// Closed on entry to the next `Intermission`, never on exit from this one.
		if (this.open !== "none") {
			this.setOpen("none");
		}
	}

	// #region rail and open state

	private buildRail(parent: Instance): Frame {
		const rail = new Instance("Frame");
		rail.Name = "PanelTabs";
		rail.AnchorPoint = new Vector2(0, 0.5);
		rail.Position = UDim2.fromScale(0, 0.5);
		rail.Size = new UDim2(0, 0, 0, 0);
		rail.AutomaticSize = Enum.AutomaticSize.XY;
		rail.BackgroundTransparency = 1;
		rail.BorderSizePixel = 0;
		rail.Visible = false;
		rail.ZIndex = RAIL_Z_INDEX;
		rail.Parent = parent;

		const padding = new Instance("UIPadding");
		padding.PaddingLeft = new UDim(0, RAIL_INSET);
		padding.Parent = rail;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.sm);
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Left;
		layout.Parent = rail;

		this.buildRailTab(rail, "shop", "Store", 1);
		this.buildRailTab(rail, "inventory", "Inventory", 2);
		this.restyleRail();

		return rail;
	}

	private buildRailTab(parent: Instance, id: PanelId, label: string, order: number): void {
		const button = new Instance("TextButton");
		button.Name = `${label}Tab`;
		button.Size = new UDim2(0, 0, 0, RAIL_TAB_HEIGHT);
		button.AutomaticSize = Enum.AutomaticSize.X;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Font = FONT;
		button.TextSize = TYPOGRAPHY.body1.size;
		button.Text = label;
		button.LayoutOrder = order;
		button.ZIndex = RAIL_Z_INDEX;
		button.Parent = parent;

		const padding = new Instance("UIPadding");
		padding.PaddingLeft = new UDim(0, SPACING.md);
		padding.PaddingRight = new UDim(0, SPACING.md);
		padding.Parent = button;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, RAIL_INSET);
		corner.Parent = button;

		const stroke = new Instance("UIStroke");
		stroke.Color = this.light.colors.border;
		stroke.Thickness = HAIRLINE;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = button;

		attachPressFeedback(button);
		button.Activated.Connect(() => this.toggle(id));

		this.railButtons.set(id, button);
	}

	/** Which rail tab looks selected is a statement about `open`, derived from it and never stored twice. */
	private restyleRail(): void {
		for (const [id, button] of this.railButtons) {
			const selected = this.open === id;
			button.BackgroundColor3 = selected ? this.light.colors.accent : this.light.paint.card.color;
			button.BackgroundTransparency = selected ? 0 : this.light.paint.card.transparency;
			button.TextColor3 = selected ? this.light.colors.onAccent : this.light.colors.textPrimary;
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

		if (target === "shop") {
			// The store may have been built several intermissions ago; opening it is the moment to re-read the profile.
			this.refreshCoins();
			this.refreshOwned();
		}

		this.restyleRail();
		print(`[Shop] open=${this.open} phase=${this.phase}`);
	}

	private ensurePanel(id: PanelId): Frame {
		const existing = this.panels.get(id);
		if (existing !== undefined) {
			return existing;
		}

		const gui = getScreenGui("hudCore");
		const panel = id === "shop" ? this.buildStore(gui) : this.buildInventory(gui);
		panel.Visible = false;
		this.panels.set(id, panel);

		return panel;
	}

	// #endregion

	// #region the store — hierarchy

	/**
	 * The store, built as the brief's hierarchy rather than as free-floating elements.
	 *
	 * ```
	 * Store                       (Vertical list)
	 *   Header                    (Horizontal: title, spacer, coin pill, close)
	 *   Category Tabs             (Horizontal: Balls, Fusion)
	 *   Content                   (Vertical, fills)
	 *     Coin Chest Section      (Vertical)
	 *       "Coin Chest"          (title)
	 *       Preview Row           (Horizontal: chest square, rarity stats)
	 *       Prize Preview Header  (Horizontal: "Prize Preview", "View All >")
	 *       Prize Scroller        (Horizontal, auto-scrolling)
	 *       Purchase Buttons      (Horizontal: Open 1, Open 10)
	 *     Fusion Section          (Vertical, shown on the Fusion tab)
	 * ```
	 *
	 * **Every level is a real container with a real layout**, which is the point of the rewrite: the previous version
	 * positioned four bands by hand inside a 90%-tall sheet and the result read as scattered. A list of lists cannot
	 * leave a 200-pixel gap between a section title and the thing it titles.
	 *
	 * **The sheet is sized by its content.** `Size = UDim2.new(STORE_WIDTH_SCALE, 0, 0, 0)` with
	 * `AutomaticSize = Y` means the panel hugs the chest section; `capToViewport` supplies a pixel ceiling so a short
	 * window scrolls nothing and a tall one is not stretched. That single change removes the empty space.
	 *
	 * Light paper throughout: `surfaceOpaqueTheme()` supplies every colour, and the only literals are the geometry
	 * constants above.
	 */
	private buildStore(parent: Instance): Frame {
		const scope = Fusion.scoped(Fusion);
		this.scope = scope;

		const shell = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Store",
			AnchorPoint: new Vector2(CENTRE, CENTRE),
			Position: UDim2.fromScale(CENTRE, CENTRE),
			Size: UDim2.fromOffset(STORE_MAX_WIDTH, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			ZIndex: STORE_Z_INDEX,
			Parent: parent,
		});

		capToViewport(shell);

		// The one shadow, a sibling of the sheet: a child cannot draw behind its own parent.
		Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Shadow",
			Position: UDim2.fromOffset(SPACING.xs, SPACING.xs),
			Size: UDim2.fromScale(1, 1),
			BackgroundColor3: this.light.colors.shadow,
			BackgroundTransparency: 0.8,
			BorderSizePixel: 0,
			Active: false,
			ZIndex: STORE_Z_INDEX,
			Parent: shell,
		});

		const sheet = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Sheet",
			// **Height is 0 and driven by `AutomaticSize`, not 100% of the shell ? this is the clipping fix.** A sheet at
			// `fromScale(1, 1)` inside a shell that is itself `AutomaticSize.Y` is circular: the shell waits for the
			// child's height, the child asks for the parent's. Roblox resolves it by leaving the sheet at its floor, so
			// the content overflowed the sheet and `ClipsDescendants` cut the bottom band ? the purchase buttons ? off.
			// Auto-height here makes the sheet report its real content height, and the shell follows it.
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundColor3: this.light.paint.panel.color,
			BackgroundTransparency: this.light.paint.panel.transparency,
			BorderSizePixel: 0,
			// **Deliberately not clipping.** Every child is inset by `SHEET_INSET`, so the rounded corner has nothing to
			// cut; leaving `ClipsDescendants` on would re-introduce silent amputation if the content ever outgrew the
			// cap, and a panel that overflows visibly is a bug somebody reports rather than one they never see.
			ClipsDescendants: false,
			ZIndex: STORE_Z_INDEX + 1,
			Parent: shell,
		});

		this.corners(scope, sheet, SPACING.md);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.light.colors.border,
			Thickness: HAIRLINE,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: sheet,
		});

		// Level 0: the store's own vertical list. Header, tabs, content — in that order, nothing positioned by hand.
		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, BAND_GAP),
			Parent: sheet,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SHEET_INSET),
			PaddingBottom: new UDim(0, SHEET_INSET),
			PaddingLeft: new UDim(0, SHEET_INSET),
			PaddingRight: new UDim(0, SHEET_INSET),
			Parent: sheet,
		});

		this.buildHeader(scope, sheet);
		this.buildCategoryTabs(scope, sheet);
		this.buildContent(scope, sheet);

		// The status band: one line at the foot, where a refusal or a result appears. Part of the same vertical list,
		// so it sits under the content rather than floating at a fixed offset.
		this.statusLabel = this.text(
			scope,
			sheet,
			"",
			"caption",
			"secondary",
			4,
			new UDim2(1, 0, 0, TYPOGRAPHY.caption.lineHeight + SPACING.xs),
			false,
		);
		this.statusLabel.TextXAlignment = Enum.TextXAlignment.Center;
		this.statusLabel.TextYAlignment = Enum.TextYAlignment.Center;

		this.refreshCoins();
		this.refreshOwned();
		this.selectTab("Balls");

		return shell;
	}

	/** Header: title left, coin balance right, close at the far right. */
	private buildHeader(scope: Fusion.Scope<unknown>, parent: Instance): void {
		const header = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Header",
			Size: new UDim2(1, 0, 0, HEADER_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.sm),
			Parent: header,
		});

		this.text(scope, header, "Store", "h4", "primary", 1, new UDim2(0, 0, 1, 0), true);

		// A spacer that takes the leftover width, so the coin balance and the close button sit against the right edge
		// without either of them being positioned by hand. If flex ever fails to apply the two simply sit next to the
		// title, which is a wrong-looking row rather than a broken one.
		const spacer = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Spacer",
			Size: new UDim2(0, 0, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			Parent: header,
		});

		Fusion.New(scope, "UIFlexItem")({ FlexMode: Enum.UIFlexMode.Fill, Parent: spacer });

		const pill = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Coins",
			Size: new UDim2(0, 0, 0, COIN_SIZE + SPACING.md),
			AutomaticSize: Enum.AutomaticSize.X,
			BackgroundColor3: this.light.paint.trough.color,
			BackgroundTransparency: this.light.paint.trough.transparency,
			BorderSizePixel: 0,
			LayoutOrder: 3,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: header,
		});

		this.corners(scope, pill, SPACING.sm);

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingLeft: new UDim(0, SPACING.sm),
			PaddingRight: new UDim(0, SPACING.sm),
			Parent: pill,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.sm),
			Parent: pill,
		});

		this.coinDot(scope, pill, COIN_SIZE, 1);

		const coins = this.text(scope, pill, "0", "h6", "primary", 2, new UDim2(0, 0, 1, 0), true);
		coins.TextYAlignment = Enum.TextYAlignment.Center;
		this.coinsLabel = coins;

		const close = Fusion.New(
			scope,
			"TextButton",
		)({
			Name: "Close",
			Size: UDim2.fromOffset(HEADER_HEIGHT - SPACING.md, HEADER_HEIGHT - SPACING.md),
			BackgroundColor3: this.light.paint.trough.color,
			BackgroundTransparency: this.light.paint.trough.transparency,
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Font: FONT,
			TextSize: TYPOGRAPHY.h6.size,
			TextColor3: this.light.colors.textSecondary,
			Text: "X",
			LayoutOrder: 4,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: header,
		});

		this.corners(scope, close, SPACING.xs);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.light.colors.border,
			Thickness: HAIRLINE,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: close,
		});

		attachPressFeedback(close);
		close.Activated.Connect(() => this.setOpen("none"));
	}

	/** Category tabs: two equal-width buttons, horizontal. */
	private buildCategoryTabs(scope: Fusion.Scope<unknown>, parent: Instance): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "CategoryTabs",
			Size: new UDim2(1, 0, 0, TAB_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.sm),
			Parent: row,
		});

		for (let index = 0; index < STORE_TABS.size(); index++) {
			const tab = STORE_TABS[index];

			const button = Fusion.New(
				scope,
				"TextButton",
			)({
				Name: `${tab}Tab`,
				Size: new UDim2(1 / STORE_TABS.size(), -SPACING.sm, 1, 0),
				BackgroundColor3: this.light.paint.card.color,
				BackgroundTransparency: this.light.paint.card.transparency,
				BorderSizePixel: 0,
				AutoButtonColor: false,
				Font: FONT,
				TextSize: TYPOGRAPHY.h6.size,
				TextColor3: this.light.colors.textPrimary,
				Text: tab,
				LayoutOrder: index + 1,
				ZIndex: STORE_Z_INDEX + 2,
				Parent: row,
			});

			this.corners(scope, button, SPACING.sm);

			const stroke = Fusion.New(
				scope,
				"UIStroke",
			)({
				Color: this.light.colors.border,
				Thickness: HAIRLINE,
				ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
				Parent: button,
			});

			this.storeTabStrokes.set(tab, stroke);
			attachPressFeedback(button);
			button.Activated.Connect(() => this.selectTab(tab));
			this.storeTabButtons.set(tab, button);
		}
	}

	/** Content container: one vertical list holding the two sections; only one is visible at a time. */
	private buildContent(scope: Fusion.Scope<unknown>, parent: Instance): void {
		const content = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Content",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: 3,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.sm),
			Parent: content,
		});

		this.chestSection = this.buildChestSection(scope, content, 1);
		this.fusionSection = this.buildFusionSection(scope, content, 2);
	}

	// #endregion

	// #region the chest section

	/**
	 * The coin chest, as a single vertical list of five bands.
	 *
	 * Bands, in the brief's order: title, preview row, prize header, prize scroller, purchase buttons. Each is a
	 * child of one list, so no band can drift away from the one above it.
	 */
	private buildChestSection(scope: Fusion.Scope<unknown>, parent: Instance, order: number): Frame {
		const section = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "CoinChestSection",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, BAND_GAP),
			Parent: section,
		});

		this.text(scope, section, "Coin Chest", "h6", "primary", 1, new UDim2(1, 0, 0, SECTION_TITLE_HEIGHT), false);

		this.buildPreviewRow(scope, section, 2);
		this.buildPrizeHeaderRow(scope, section, 3);

		this.prizeShelf = this.buildPrizeShelf(scope, section, 4);
		this.fillPrizeShelf(scope, this.prizeShelf);

		this.buildPurchaseRow(scope, section, 5);

		return section;
	}

	/**
	 * Preview row: a compact chest square on the left, rarity statistics immediately beside it.
	 *
	 * **The square is a fixed 124 pixels, not a fraction.** The previous version gave the preview a share of the panel
	 * width, so it stretched into a wide empty box on a large screen — the "oversized empty container" the brief calls
	 * out. A fixed square beside a fixed-width statistics column keeps the two grouped.
	 */
	private buildPreviewRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PreviewRow",
			Size: new UDim2(1, 0, 0, PREVIEW_ROW_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.md),
			Parent: row,
		});

		// The chest image placeholder: a square well with the word CHEST in it. No chest asset exists in the tree and an
		// invented rbxassetid is a silent broken image, so a tinted placeholder is the honest version of "art goes here".
		const preview = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "ChestPreview",
			Size: UDim2.fromOffset(CHEST_SQUARE, CHEST_SQUARE),
			BackgroundColor3: this.light.paint.trough.color,
			BackgroundTransparency: this.light.paint.trough.transparency,
			BorderSizePixel: 0,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: row,
		});

		this.corners(scope, preview, SPACING.sm);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.light.colors.border,
			Thickness: HAIRLINE,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: preview,
		});

		const previewLabel = this.text(scope, preview, "CHEST", "caption", "disabled", 1, UDim2.fromScale(1, 1), false);
		previewLabel.TextXAlignment = Enum.TextXAlignment.Center;
		previewLabel.TextYAlignment = Enum.TextYAlignment.Center;

		// Rarity statistics, immediately beside the square. A vertical list so the four rows are evenly spaced however
		// many tiers exist, from `chestOdds()` rather than from a copy.
		const stats = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "RarityStats",
			Size: new UDim2(1, -CHEST_SQUARE - SPACING.md, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: row,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: stats,
		});

		const odds = chestOdds();
		for (let index = 0; index < odds.size(); index++) {
			this.buildStatRow(scope, stats, odds[index].rarity, odds[index].percent, index + 1);
		}
	}

	/** One `Tier ....... 79%` row, the value tinted by its rarity. */
	private buildStatRow(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		rarity: Rarity,
		percent: number,
		order: number,
	): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: `Stat_${rarity}`,
			Size: new UDim2(1, 0, 0, TYPOGRAPHY.body2.size + SPACING.xs),
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		const label = this.text(scope, row, tierName(rarity), "body2", "secondary", 1, new UDim2(0.7, 0, 1, 0), false);
		label.TextYAlignment = Enum.TextYAlignment.Center;

		const value = this.text(scope, row, `${percent}%`, "body2", "primary", 2, new UDim2(0.3, 0, 1, 0), false);
		value.Position = UDim2.fromScale(0.7, 0);
		value.TextXAlignment = Enum.TextXAlignment.Right;
		value.TextYAlignment = Enum.TextYAlignment.Center;
		value.TextColor3 = this.light.colors.rarity[rarity];
	}

	/** `Prize Preview` on the left, a `View All >` placeholder on the right. */
	private buildPrizeHeaderRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PrizeHeader",
			Size: new UDim2(1, 0, 0, PRIZE_HEADER_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Parent: row,
		});

		const left = this.text(scope, row, "Prize Preview", "body2", "primary", 1, new UDim2(0.5, 0, 1, 0), false);
		left.TextYAlignment = Enum.TextYAlignment.Center;

		// A placeholder by design: the brief says it needs no functionality yet. It is a label rather than a button so
		// nothing invites a click that would do nothing.
		const viewAll = this.text(scope, row, "View All >", "caption", "secondary", 2, new UDim2(0.5, 0, 1, 0), false);
		viewAll.TextXAlignment = Enum.TextXAlignment.Right;
		viewAll.TextYAlignment = Enum.TextYAlignment.Center;
	}

	/**
	 * The prize scroller: a horizontally scrolling shelf of the balls the chest can actually grant.
	 *
	 * ## Why the cards are the real pool
	 *
	 * The brief asks for "the items that players can actually win". `BALL_POOL` is that list — every ball id the chest
	 * can roll, with its tier colour as the card border. Showing four rarity cards instead (which the previous version
	 * did) would have been a diagram of the odds rather than a preview of the prizes.
	 *
	 * ## Why the contents are duplicated
	 *
	 * `drivePrizeShelf` scrolls the canvas and wraps at half its width. That is only seamless if the second half
	 * repeats the first exactly, so the shelf is filled twice and the wrap point is invisible.
	 */
	private buildPrizeShelf(scope: Fusion.Scope<unknown>, parent: Instance, order: number): ScrollingFrame {
		const shelf = Fusion.New(
			scope,
			"ScrollingFrame",
		)({
			Name: "PrizeShelf",
			Size: new UDim2(1, 0, 0, SHELF_HEIGHT),
			BackgroundColor3: this.light.paint.surface.color,
			BackgroundTransparency: this.light.paint.surface.transparency,
			BorderSizePixel: 0,
			ClipsDescendants: true,
			ScrollBarThickness: 0,
			ScrollingDirection: Enum.ScrollingDirection.X,
			CanvasSize: UDim2.fromOffset(0, 0),
			AutomaticCanvasSize: Enum.AutomaticSize.X,
			ElasticBehavior: Enum.ElasticBehavior.Never,
			ScrollingEnabled: false,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		this.corners(scope, shelf, SPACING.sm);

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: shelf,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingLeft: new UDim(0, SPACING.xs),
			PaddingRight: new UDim(0, SPACING.xs),
			Parent: shelf,
		});

		return shelf;
	}

	/** Fills a shelf twice: once per ball, then the same list again so the scroll can wrap invisibly. */
	private fillPrizeShelf(scope: Fusion.Scope<unknown>, shelf: ScrollingFrame): void {
		const cards = new Array<{ id: string; rarity: Rarity }>();

		for (const rarity of RARITIES) {
			for (const ballId of BALL_POOL[rarity]) {
				cards.push({ id: ballId, rarity });
			}
		}

		if (cards.size() === 0) {
			return;
		}

		let order = 1;
		for (let pass = 0; pass < 2; pass++) {
			for (const card of cards) {
				this.buildPrizeCard(scope, shelf, card.id, card.rarity, order);
				order++;
			}
		}
	}

	/** One prize card: a tinted art block with a ball silhouette, and the ball's name beneath. */
	private buildPrizeCard(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		ballId: string,
		rarity: Rarity,
		order: number,
	): void {
		const card = Fusion.New(
			scope,
			"Frame",
		)({
			Name: `Prize_${ballId}_${order}`,
			Size: UDim2.fromOffset(CARD_WIDTH, CARD_ART + TYPOGRAPHY.caption.lineHeight + SPACING.xs * 2),
			BackgroundColor3: this.light.paint.card.color,
			BackgroundTransparency: this.light.paint.card.transparency,
			BorderSizePixel: 0,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		this.corners(scope, card, SPACING.xs);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.light.colors.rarity[rarity],
			Thickness: HAIRLINE,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: card,
		});

		const art = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Art",
			Size: new UDim2(1, -SPACING.xs * 2, 0, CARD_ART),
			Position: UDim2.fromOffset(SPACING.xs, SPACING.xs),
			BackgroundColor3: this.light.colors.rarity[rarity],
			BackgroundTransparency: 0.84,
			BorderSizePixel: 0,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: card,
		});

		this.corners(scope, art, SPACING.xs);

		const ball = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Ball",
			AnchorPoint: new Vector2(CENTRE, CENTRE),
			Position: UDim2.fromScale(CENTRE, CENTRE),
			Size: UDim2.fromOffset(SWATCH, SWATCH),
			BackgroundColor3: this.light.colors.rarity[rarity],
			BorderSizePixel: 0,
			ZIndex: STORE_Z_INDEX + 4,
			Parent: art,
		});

		this.corners(scope, ball, 0, ROUND);

		const name = this.text(
			scope,
			card,
			displayName(ballId),
			"caption",
			"primary",
			2,
			new UDim2(1, -SPACING.xs * 2, 0, TYPOGRAPHY.caption.lineHeight),
			false,
		);
		name.Position = UDim2.fromOffset(SPACING.xs, CARD_ART + SPACING.xs);
		name.TextXAlignment = Enum.TextXAlignment.Center;
		name.TextYAlignment = Enum.TextYAlignment.Center;
		name.TextTruncate = Enum.TextTruncate.AtEnd;
	}

	/**
	 * Purchase buttons: `Open 1` and `Open 10`, equal width, side by side.
	 *
	 * ## `Open 10` is ten real opens, not a new economy action
	 *
	 * The brief's hierarchy asks for both buttons, and the economy has exactly one verb: `OpenCoinChest`, one ball per
	 * accepted call, rate-limited to one per `ECONOMY_ACTION_COOLDOWN_MS`. There is no bulk remote, and adding one
	 * would change `EconomyService` — explicitly out of scope.
	 *
	 * So `Open 10` **queues ten ordinary opens on the client**, draining one every `ECONOMY_ACTION_COOLDOWN_MS` so the
	 * server accepts each. Every open is individually validated and individually charged; the price shown is exactly
	 * `10 * COIN_CHEST_COST`. Nothing about the economy changes — the player simply does not have to press ten times.
	 * If they run out of coins partway, the remaining opens are refused by the server like any other press, and the
	 * status line says so.
	 */
	private buildPurchaseRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PurchaseButtons",
			Size: new UDim2(1, 0, 0, BUTTON_ROW_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.sm),
			Parent: row,
		});

		this.buildPurchaseButton(scope, row, "Open 1", COIN_CHEST_COST, 1, 1);
		this.buildPurchaseButton(scope, row, "Open 10", COIN_CHEST_COST * 10, 2, 10);
	}

	/** A tall two-line button: action on the first line, `price` plus a coin circle on the second. */
	private buildPurchaseButton(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		action: string,
		price: number,
		order: number,
		count: number,
	): void {
		const button = Fusion.New(
			scope,
			"TextButton",
		)({
			Name: `Open${count}`,
			Size: new UDim2(0.5, -SPACING.xs, 1, 0),
			BackgroundColor3: this.light.colors.accent,
			BackgroundTransparency: 0,
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Text: "",
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: parent,
		});

		this.corners(scope, button, SPACING.sm);
		attachPressFeedback(button);
		button.Activated.Connect(() => this.openChests(count));

		// The two lines are children of the button, in a vertical list, so the pair stays centred as one block rather
		// than being positioned one line at a time.
		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: button,
		});

		const top = this.text(
			scope,
			button,
			action,
			"body1",
			"primary",
			1,
			new UDim2(1, 0, 0, TYPOGRAPHY.body1.size),
			false,
		);
		top.TextColor3 = this.light.colors.onAccent;
		top.TextXAlignment = Enum.TextXAlignment.Center;

		const priceRow = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Price",
			Size: new UDim2(0, 0, 0, COIN_SIZE + SPACING.xs),
			AutomaticSize: Enum.AutomaticSize.X,
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 4,
			Parent: button,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: priceRow,
		});

		const amount = this.text(scope, priceRow, tostring(price), "body2", "primary", 1, new UDim2(0, 0, 1, 0), true);
		amount.TextColor3 = this.light.colors.onAccent;
		amount.TextYAlignment = Enum.TextYAlignment.Center;

		this.coinDot(scope, priceRow, COIN_SIZE, 2);

		this.chestButtons.push(button);
	}

	/** The yellow coin placeholder: a plain circle, because the tree ships no coin image. */
	private coinDot(scope: Fusion.Scope<unknown>, parent: Instance, size: number, order: number): Frame {
		const dot = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Coin",
			Size: UDim2.fromOffset(size, size),
			BackgroundColor3: this.light.colors.coin,
			BorderSizePixel: 0,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 4,
			Parent: parent,
		});

		this.corners(scope, dot, 0, ROUND);

		return dot;
	}

	// #endregion

	// #region the fusion section

	/**
	 * The second category: the game's other real action.
	 *
	 * Shown on the `Fusion` tab and hidden on `Balls`. Same band structure as the chest section so switching tabs does
	 * not change the sheet's proportions.
	 */
	private buildFusionSection(scope: Fusion.Scope<unknown>, parent: Instance, order: number): Frame {
		const section = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "FusionSection",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: order,
			Visible: false,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, BAND_GAP),
			Parent: section,
		});

		this.text(scope, section, "Fusion", "h6", "primary", 1, new UDim2(1, 0, 0, SECTION_TITLE_HEIGHT), false);

		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PreviewRow",
			Size: new UDim2(1, 0, 0, PREVIEW_ROW_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: section,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.md),
			Parent: row,
		});

		const preview = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "FusePreview",
			Size: UDim2.fromOffset(CHEST_SQUARE, CHEST_SQUARE),
			BackgroundColor3: this.light.paint.trough.color,
			BackgroundTransparency: this.light.paint.trough.transparency,
			BorderSizePixel: 0,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: row,
		});

		this.corners(scope, preview, SPACING.sm);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.light.colors.rarity.epic,
			Thickness: HAIRLINE,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: preview,
		});

		const previewLabel = this.text(scope, preview, "FUSE", "caption", "disabled", 1, UDim2.fromScale(1, 1), false);
		previewLabel.TextXAlignment = Enum.TextXAlignment.Center;
		previewLabel.TextYAlignment = Enum.TextYAlignment.Center;

		const facts = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "FuseFacts",
			Size: new UDim2(1, -CHEST_SQUARE - SPACING.md, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: row,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: facts,
		});

		this.fusionDetailLabel = this.text(
			scope,
			facts,
			"Selected: none",
			"body2",
			"secondary",
			1,
			new UDim2(1, 0, 0, TYPOGRAPHY.body2.size + SPACING.xs),
			false,
		);

		this.fusionOddsLabel = this.text(
			scope,
			facts,
			`Costs ${FUSION_INPUT_COUNT} of one ball`,
			"body2",
			"secondary",
			2,
			new UDim2(1, 0, 0, TYPOGRAPHY.body2.size + SPACING.xs),
			false,
		);

		this.text(scope, section, "Your Balls", "body2", "primary", 3, new UDim2(1, 0, 0, PRIZE_HEADER_HEIGHT), false);

		this.ownedShelf = Fusion.New(
			scope,
			"ScrollingFrame",
		)({
			Name: "OwnedShelf",
			Size: new UDim2(1, 0, 0, SHELF_HEIGHT),
			BackgroundColor3: this.light.paint.surface.color,
			BackgroundTransparency: this.light.paint.surface.transparency,
			BorderSizePixel: 0,
			ClipsDescendants: true,
			ScrollBarThickness: SPACING.xs,
			ScrollBarImageColor3: this.light.colors.border,
			ScrollingDirection: Enum.ScrollingDirection.X,
			CanvasSize: UDim2.fromOffset(0, 0),
			AutomaticCanvasSize: Enum.AutomaticSize.X,
			ElasticBehavior: Enum.ElasticBehavior.Never,
			LayoutOrder: 4,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: section,
		});

		this.corners(scope, this.ownedShelf, SPACING.sm);

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: this.ownedShelf,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingLeft: new UDim(0, SPACING.xs),
			PaddingRight: new UDim(0, SPACING.xs),
			Parent: this.ownedShelf,
		});

		this.ownedEmpty = this.text(
			scope,
			section,
			"Nothing yet — open a chest.",
			"caption",
			"secondary",
			5,
			new UDim2(1, 0, 0, TYPOGRAPHY.caption.lineHeight + SPACING.xs),
			false,
		);
		this.ownedEmpty.TextXAlignment = Enum.TextXAlignment.Center;

		const buttonRow = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "FuseButtons",
			Size: new UDim2(1, 0, 0, BUTTON_ROW_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: 6,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: section,
		});

		this.fusionButton = Fusion.New(
			scope,
			"TextButton",
		)({
			Name: "Fuse",
			Size: new UDim2(1, 0, 1, 0),
			BackgroundColor3: this.light.colors.accent,
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Font: FONT,
			TextSize: TYPOGRAPHY.button.size,
			TextColor3: this.light.colors.onAccent,
			Text: "Select a ball",
			ZIndex: STORE_Z_INDEX + 3,
			Parent: buttonRow,
		});

		this.corners(scope, this.fusionButton, SPACING.sm);
		attachPressFeedback(this.fusionButton);
		this.fusionButton.Activated.Connect(() => this.pressFusion());
		this.fusionButton.Active = false;
		this.fusionButton.TextTransparency = 0.45;

		return section;
	}

	// #endregion

	// #region builders

	/**
	 * A plain `TextLabel`, built directly rather than through big-ui.
	 *
	 * See the class comment: big-ui's `Text` paints from the dark palette and the light direction never reaches it, so
	 * every label it produced was invisible on paper. This builder sets font, size and colour from `scale.ts` and
	 * `surfaceOpaqueTheme()` with nothing in between — and `autoWidth` says the caller wants the label to shrink-wrap,
	 * which a fixed-size label cannot do.
	 */
	private text(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		content: string,
		variant: keyof typeof TYPOGRAPHY,
		colour: "primary" | "secondary" | "disabled",
		order: number,
		size: UDim2,
		autoWidth: boolean,
	): TextLabel {
		const label = Fusion.New(
			scope,
			"TextLabel",
		)({
			Name: `Text_${variant}`,
			Size: size,
			AutomaticSize: autoWidth ? Enum.AutomaticSize.X : Enum.AutomaticSize.None,
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			Font: FONT,
			TextSize: TYPOGRAPHY[variant].size,
			TextColor3:
				colour === "primary"
					? this.light.colors.textPrimary
					: colour === "secondary"
						? this.light.colors.textSecondary
						: this.light.colors.textDisabled,
			TextXAlignment: Enum.TextXAlignment.Left,
			TextYAlignment: Enum.TextYAlignment.Top,
			TextTruncate: Enum.TextTruncate.AtEnd,
			Text: content,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: parent,
		});

		return label;
	}

	/** Adds a `UICorner`, because Fusion's builder takes one instance at a time. */
	private corners(scope: Fusion.Scope<unknown>, parent: Instance, radius: number, udim?: UDim): void {
		Fusion.New(scope, "UICorner")({ CornerRadius: udim ?? new UDim(0, radius), Parent: parent });
	}

	// #endregion

	// #region behaviour

	/** Shows the section for the chosen tab and accents that tab. */
	private selectTab(tab: StoreTab): void {
		for (const [name, button] of this.storeTabButtons) {
			const active = name === tab;
			button.BackgroundColor3 = active ? this.light.colors.accent : this.light.paint.card.color;
			button.TextColor3 = active ? this.light.colors.onAccent : this.light.colors.textPrimary;
		}

		for (const [name, stroke] of this.storeTabStrokes) {
			stroke.Color = name === tab ? this.light.colors.accent : this.light.colors.border;
			stroke.Thickness = name === tab ? 2 : HAIRLINE;
		}

		if (this.chestSection !== undefined) {
			this.chestSection.Visible = tab === "Balls";
		}

		if (this.fusionSection !== undefined) {
			this.fusionSection.Visible = tab === "Fusion";
		}
	}

	/**
	 * Scrolls the prize shelf continuously, and nothing else.
	 *
	 * One `RenderStepped` connection for the controller's lifetime, gated on the shelf existing and the store being
	 * open — a closed store costs one boolean test per frame. The loop wraps at **half** the canvas width because
	 * `fillPrizeShelf` lays the prize list out twice, so the second half is a pixel-identical copy of the first and the
	 * jump back to zero is invisible.
	 *
	 * `CanvasPosition` is a `Vector2`; assigning a property on it in place does nothing, so a new one is constructed.
	 */
	private drivePrizeShelf(): void {
		RunService.RenderStepped.Connect((dt) => {
			const shelf = this.prizeShelf;
			if (shelf === undefined || this.open !== "shop" || !shelf.Visible) {
				return;
			}

			const half = shelf.AbsoluteCanvasSize.X / 2;
			if (half <= shelf.AbsoluteSize.X) {
				// Nothing overflows: two copies fit inside the viewport, so there is no seam to hide and nothing to
				// scroll. Move to the start so a resized window does not leave it parked mid-canvas.
				shelf.CanvasPosition = new Vector2(0, 0);
				return;
			}

			let x = shelf.CanvasPosition.X + SHELF_SCROLL_SPEED * dt;
			if (x >= half) {
				x -= half;
			}

			shelf.CanvasPosition = new Vector2(x, 0);
		});
	}

	/** Reads `Coins` and writes it into the header. The attribute is the only source; the store never counts. */
	private refreshCoins(): void {
		const label = this.coinsLabel;
		if (label === undefined) {
			return;
		}

		const coins = this.player.GetAttribute(PLAYER_COINS_ATTRIBUTE);
		const state = this.player.GetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE);

		if (typeIs(coins, "number")) {
			label.Text = tostring(coins);
			label.TextColor3 = this.light.colors.textPrimary;
			return;
		}

		// Three situations share "no number": still loading, locked elsewhere, never loaded. Naming them is the
		// difference between a store that looks broken and one that says why it cannot act.
		label.Text = state === "readonly" ? "read-only" : state === "loading" ? "..." : "0";
		label.TextColor3 = this.light.colors.textSecondary;
	}

	/** Rebuilds the owned shelf from the `OwnedBalls` attribute. */
	private refreshOwned(): void {
		const shelf = this.ownedShelf;
		if (shelf === undefined) {
			return;
		}

		for (const card of this.ownedCards) {
			card.Destroy();
		}
		this.ownedCards.clear();

		const owned = decodeOwnedBalls(this.ownedAttribute());

		if (owned.size() === 0) {
			if (this.ownedEmpty !== undefined) {
				this.ownedEmpty.Visible = true;
			}

			this.selectedBallId = undefined;
			this.refreshSelection(owned);
			return;
		}

		if (this.ownedEmpty !== undefined) {
			this.ownedEmpty.Visible = false;
		}

		// Sorted, so the shelf cannot reorder itself between two reads of the same profile.
		const ids = new Array<string>();
		for (const [ballId] of owned) {
			ids.push(ballId);
		}
		ids.sort((left, right) => left < right);

		let order = 1;
		for (const ballId of ids) {
			this.ownedCards.push(
				this.buildOwnedCard(shelf, ballId, rarityOfBall(ballId), owned.get(ballId) ?? 0, order),
			);
			order++;
		}

		// A selection that is no longer owned stops being a selection.
		if (this.selectedBallId !== undefined && !owned.has(this.selectedBallId)) {
			this.selectedBallId = undefined;
		}

		this.refreshSelection(owned);
	}

	/** One owned ball card. Clicking selects it for fusion. */
	private buildOwnedCard(
		parent: Instance,
		ballId: string,
		rarity: Rarity | undefined,
		count: number,
		order: number,
	): TextButton {
		const tint = rarity !== undefined ? this.light.colors.rarity[rarity] : this.light.colors.border;
		const selected = ballId === this.selectedBallId;

		const card = new Instance("TextButton");
		card.Name = `Owned_${ballId}`;
		card.Size = UDim2.fromOffset(CARD_WIDTH, CARD_ART + TYPOGRAPHY.caption.lineHeight + SPACING.xs * 2);
		card.BackgroundColor3 = selected ? this.light.colors.accent : this.light.paint.card.color;
		card.BackgroundTransparency = selected ? 0 : this.light.paint.card.transparency;
		card.BorderSizePixel = 0;
		card.AutoButtonColor = false;
		card.Font = FONT;
		card.TextSize = TYPOGRAPHY.caption.size;
		card.TextColor3 = selected ? this.light.colors.onAccent : this.light.colors.textPrimary;
		card.Text = displayName(ballId);
		card.TextTruncate = Enum.TextTruncate.AtEnd;
		card.TextYAlignment = Enum.TextYAlignment.Bottom;
		card.LayoutOrder = order;
		card.ZIndex = STORE_Z_INDEX + 3;
		card.Parent = parent;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, SPACING.xs);
		corner.Parent = card;

		const stroke = new Instance("UIStroke");
		stroke.Color = tint;
		stroke.Thickness = selected ? 2 : HAIRLINE;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = card;

		const art = new Instance("Frame");
		art.Name = "Art";
		art.Size = new UDim2(1, -SPACING.xs * 2, 0, CARD_ART);
		art.Position = UDim2.fromOffset(SPACING.xs, SPACING.xs);
		art.BackgroundColor3 = tint;
		art.BackgroundTransparency = selected ? 0.72 : 0.84;
		art.BorderSizePixel = 0;
		art.ZIndex = STORE_Z_INDEX + 4;
		art.Parent = card;

		const artCorner = new Instance("UICorner");
		artCorner.CornerRadius = new UDim(0, SPACING.xs);
		artCorner.Parent = art;

		const ball = new Instance("Frame");
		ball.Name = "Ball";
		ball.AnchorPoint = new Vector2(CENTRE, CENTRE);
		ball.Position = UDim2.fromScale(CENTRE, CENTRE);
		ball.Size = UDim2.fromOffset(SWATCH, SWATCH);
		ball.BackgroundColor3 = tint;
		ball.BorderSizePixel = 0;
		ball.ZIndex = STORE_Z_INDEX + 5;
		ball.Parent = art;

		const ballCorner = new Instance("UICorner");
		ballCorner.CornerRadius = ROUND;
		ballCorner.Parent = ball;

		const countLabel = new Instance("TextLabel");
		countLabel.Name = "Count";
		countLabel.AnchorPoint = new Vector2(1, 0);
		countLabel.Position = UDim2.fromScale(1, 0);
		countLabel.Size = UDim2.fromOffset(SPACING.xl, SPACING.lg);
		countLabel.BackgroundTransparency = 1;
		countLabel.Font = FONT;
		countLabel.TextSize = TYPOGRAPHY.caption.size;
		countLabel.TextColor3 = this.light.colors.textPrimary;
		countLabel.TextXAlignment = Enum.TextXAlignment.Right;
		countLabel.Text = `x${count}`;
		countLabel.ZIndex = STORE_Z_INDEX + 6;
		countLabel.Parent = art;

		card.Activated.Connect(() => {
			this.selectedBallId = ballId;
			this.refreshOwned();
		});

		return card;
	}

	/** What the fusion button says and whether it can be pressed, given the current selection. */
	private refreshSelection(owned: Map<string, number>): void {
		const button = this.fusionButton;
		const detail = this.fusionDetailLabel;
		const oddsLabel = this.fusionOddsLabel;
		if (button === undefined) {
			return;
		}

		const ballId = this.selectedBallId;
		if (ballId === undefined) {
			button.Text = "Select a ball";
			button.Active = false;
			button.TextTransparency = 0.45;
			if (detail !== undefined) {
				detail.Text = "Selected: none";
				detail.TextColor3 = this.light.colors.textSecondary;
			}
			if (oddsLabel !== undefined) {
				oddsLabel.Text = `Costs ${FUSION_INPUT_COUNT} of one ball`;
				oddsLabel.TextColor3 = this.light.colors.textSecondary;
			}
			return;
		}

		const rarity = rarityOfBall(ballId);
		const count = owned.get(ballId) ?? 0;
		const rule = rarity !== undefined ? FUSION_TABLE[rarity] : undefined;

		if (detail !== undefined) {
			detail.Text = `Selected: ${displayName(ballId)} (x${count})`;
			detail.TextColor3 = rarity !== undefined ? this.light.colors.rarity[rarity] : this.light.colors.textPrimary;
		}

		if (oddsLabel !== undefined) {
			if (rarity === undefined) {
				oddsLabel.Text = "Unknown ball type";
				oddsLabel.TextColor3 = this.light.colors.error;
			} else if (rule === undefined) {
				oddsLabel.Text = "Legendary is the top tier — cannot fuse";
				oddsLabel.TextColor3 = this.light.colors.textSecondary;
			} else {
				const odds = fusionOdds(rarity);
				oddsLabel.Text = odds.size() === 2 ? `${odds[0].percent}% chance of ${tierName(rule.nextRarity)}` : "";
				oddsLabel.TextColor3 = this.light.colors.textSecondary;
			}
		}

		if (count < FUSION_INPUT_COUNT) {
			button.Text = `Need ${FUSION_INPUT_COUNT} — you have ${count}`;
			button.Active = false;
			button.TextTransparency = 0.45;
			return;
		}

		if (rule === undefined) {
			button.Text = "Cannot fuse";
			button.Active = false;
			button.TextTransparency = 0.45;
			return;
		}

		button.Text = `Fuse ${FUSION_INPUT_COUNT} into ${tierName(rule.nextRarity)}`;
		button.Active = !this.busy;
		button.TextTransparency = this.busy ? 0.45 : 0;
	}

	/**
	 * Queues `count` ordinary chest opens and drains them one per cooldown.
	 *
	 * One press is one remote call is one server-validated open — for `count = 1` exactly as before. For `count = 10`
	 * the client simply sends ten of them with `ECONOMY_ACTION_COOLDOWN_MS` between each, because the server refuses a
	 * second call inside that window. Nothing is batched, nothing is trusted: if the player can only afford four, the
	 * fifth is refused and the status line reports it.
	 */
	private openChests(count: number): void {
		const remote = this.chestRemote;
		if (remote === undefined) {
			this.setStatus("The server is not accepting chests.");
			return;
		}

		this.pendingOpens += count;
		this.drainOpens();
	}

	private drainOpens(): void {
		if (this.busy || this.pendingOpens <= 0) {
			return;
		}

		const remote = this.chestRemote;
		if (remote === undefined) {
			this.pendingOpens = 0;
			return;
		}

		this.busy = true;
		for (const button of this.chestButtons) {
			button.Active = false;
			button.TextTransparency = 0.5;
		}

		this.pendingOpens -= 1;
		remote.FireServer();

		task.delay(ECONOMY_ACTION_COOLDOWN_MS / 1000, () => {
			this.busy = false;

			if (this.pendingOpens > 0) {
				this.drainOpens();
				return;
			}

			for (const button of this.chestButtons) {
				button.Active = true;
				button.TextTransparency = 0;
			}

			this.refreshSelection(decodeOwnedBalls(this.ownedAttribute()));
		});
	}

	private ownedAttribute(): string {
		const encoded = this.player.GetAttribute(PLAYER_OWNED_BALLS_ATTRIBUTE);
		return typeIs(encoded, "string") ? encoded : "";
	}

	private pressFusion(): void {
		if (this.busy) {
			return;
		}

		const ballId = this.selectedBallId;
		const remote = this.fusionRemote;
		if (ballId === undefined || remote === undefined) {
			return;
		}

		this.busy = true;
		this.fusionButton!.TextTransparency = 0.45;
		remote.FireServer(ballId);

		task.delay(ECONOMY_ACTION_COOLDOWN_MS / 1000, () => {
			this.busy = false;
			this.refreshSelection(decodeOwnedBalls(this.ownedAttribute()));
		});
	}

	private onChestResult(result: unknown): void {
		const reply = result as ChestResult | undefined;
		if (reply === undefined) {
			return;
		}

		if (reply.ok) {
			this.setStatus(`You got ${displayName(reply.ballId)}.`);
		} else if (reply.reason === "insufficient-coins" && this.pendingOpens > 0) {
			// Out of coins mid-queue: drop the rest rather than firing ten guaranteed refusals.
			this.pendingOpens = 0;
			this.setStatus(this.reasonText(reply.reason));
		} else {
			this.setStatus(this.reasonText(reply.reason));
		}

		this.refreshCoins();
		this.refreshOwned();
	}

	private onFusionResult(result: unknown): void {
		const reply = result as FusionResult | undefined;
		if (reply === undefined) {
			return;
		}

		if (!reply.ok) {
			this.setStatus(this.reasonText(reply.reason));
		} else if (reply.outcome === "success" && reply.resultBallId !== undefined) {
			this.setStatus(`Fused into ${displayName(reply.resultBallId)}.`);
		} else {
			this.setStatus("The fusion failed — both balls are gone.");
		}

		this.refreshOwned();
	}

	/**
	 * The server's refusal codes, in words.
	 *
	 * The codes are `EconomyService`'s `reason` strings, matched literally because the reply is a plain table over a
	 * `RemoteEvent`. An unknown code falls through to a generic line: a player cannot act on `save-failed`.
	 */
	private reasonText(reason: string): string {
		if (reason === "insufficient-coins") {
			return `Not enough coins — a chest costs ${COIN_CHEST_COST}.`;
		}

		if (reason === "not-enough") {
			return `You need ${FUSION_INPUT_COUNT} of that ball.`;
		}

		if (reason === "top-tier") {
			return "Legendaries cannot be fused — nothing is above them.";
		}

		if (reason === "no-profile") {
			return "Your data is not available this session (read-only).";
		}

		return "That did not work. Try again.";
	}

	private setStatus(text: string): void {
		if (this.statusLabel !== undefined) {
			this.statusLabel.Text = text;
		} else {
			print(`[Shop] ${text}`);
		}
	}

	// #endregion

	// #region the inventory

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

		this.buildEmptyState(surface, INVENTORY_EMPTY);

		PanelFooter({ theme: light, parent: surface, text: INVENTORY_FOOTER });

		return parts.frame;
	}

	/** The centred, quiet line a panel shows when it has no content. */
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
		label.ZIndex = RAIL_Z_INDEX;
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

	// #endregion
}

/**
 * A tier as a label: `legendary` becomes `Legendary`.
 *
 * Derived rather than tabled. A display-name map would be a second place to update when a tier is added, and falling
 * out of step with `RARITIES` is the drift the `Record<Rarity, ...>` in the theme prevents by type.
 */
function tierName(rarity: Rarity): string {
	return `${rarity.upper().sub(1, 1)}${rarity.sub(2)}`;
}

/**
 * A ball id as a label: `bully_ball` becomes `Bully ball`.
 *
 * Ids are the stored unit and the wire format, so they are not the display unit. Title-casing and replacing
 * separators is the whole transformation — there is no display-name table to fall out of step with `BALL_POOL`.
 */
function displayName(ballId: string): string {
	const spaced = ballId.gsub("_", " ")[0];
	return `${spaced.upper().sub(1, 1)}${spaced.sub(2)}`;
}
