import { MarketplaceService, Players, PolicyService, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import {
	PLAYER_COINS_ATTRIBUTE,
	PLAYER_ECONOMY_STATE_ATTRIBUTE,
	PLAYER_OWNED_BALLS_ATTRIBUTE,
} from "shared/attributes";
import {
	BALL_POOL,
	canAffordChests,
	chestBatchCost,
	COIN_CHEST_COST,
	MAX_BULK_OPEN,
	ECONOMY_ACTION_COOLDOWN_MS,
	FUSION_INPUT_COUNT,
	FUSION_TABLE,
	RARITIES,
	RARITY_WEIGHTS,
	Rarity,
	ROBUX_CHEST_BUNDLE_COUNT,
	ROBUX_CHEST_BUNDLE_PRICE_ROBUX,
	ROBUX_CHEST_BUNDLE_PRODUCT_ID,
	ROBUX_CHEST_PRICE_ROBUX,
	ROBUX_CHEST_PRODUCT_ID,
	ROBUX_CHEST_RARITIES,
	robuxChestWeights,
} from "shared/economy.config";
import { ChestOdd, chestOdds, robuxChestOdds } from "shared/odds";
import {
	FUSE_BALLS_REMOTE_NAME,
	OPEN_COIN_CHEST_REMOTE_NAME,
	PURCHASE_GRANTED_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
	ROUND_STATE_VALUE_NAME,
} from "shared/remotes";
import { FONT, SPACING, TYPOGRAPHY, typographyOneStepUp } from "shared/ui/scale";
import { outlineText } from "shared/ui/text";
import { chunkyDarkTheme, Theme } from "shared/ui/theme";
import { fusionOddsForBall, OwnedBall, ownedBallsFrom } from "shared/inventory";
import { policyAllowsPurchase, PolicyState, policyStateFrom } from "shared/policy";
import { getScreenGui } from "shared/ui/layers";
import { lockControls } from "client/controls-lock";
import { PanelFooter, PANEL_FOOTER_HEIGHT, PANEL_HEADER_HEIGHT, PanelHeader } from "shared/ui/panel";
import { TabStrip, TAB_STRIP_HEIGHT } from "shared/ui/tabs";
import { buildChunkyButton, ChunkyButton } from "shared/ui/chunky-button";
import { buildChunkyPanel } from "shared/ui/chunky-panel";
import {
	addChunkyRing,
	applyChunkyChrome,
	CHUNKY_CONTROL_DEPTH,
	dimChunkyChrome,
	shadowOf,
} from "shared/ui/chunky-chrome";
import { attachPressFeedback } from "shared/ui/press";
import { attachClickSound, playPurchaseSound } from "shared/ui/sounds";
import { applyPanelScale } from "shared/ui/ui-scale";
import { coinIconUri, reportCoinIconLoad } from "shared/ui/coin";
import { ballName as displayName, rarityLabel as tierName } from "shared/ball-name";

/**
 * **The sheet's type scale: every variant one step larger than the game scale.**
 *
 * One table, built from one decision - read `typographyOneStepUp` for why it is not a hundred edited call sites. Every
 * `PANEL_TYPE` read below is what `TYPOGRAPHY` used to be, so a label that asked for `body2` now renders at `body1`, and the
 * band that sized itself at `body2`'s line height grew with it.
 *
 * `TYPOGRAPHY` is still imported for the `variant` **type** in `text()`, which is the same closed set.
 */
const PANEL_TYPE = typographyOneStepUp();

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

/** **Placeholder.** A section title's height, in pixels. */
const SECTION_TITLE_HEIGHT = 24;

/** **Placeholder.** The chest-preview row's height, in pixels. */
const PREVIEW_ROW_HEIGHT = 116;

/** **Placeholder.** The chest image placeholder's side, in pixels. Compact, as the brief asks. */
const CHEST_SQUARE = 108;

/** **Placeholder.** Height of the `Prize Preview` / `View All` header row, in pixels. */
const PRIZE_HEADER_HEIGHT = 28;

/** **Placeholder.** Height of the scrolling prize shelf, in pixels. */
const SHELF_HEIGHT = 82;

/** **Placeholder.** Prize card width, in pixels. */
const CARD_WIDTH = 82;

/** **Placeholder.** Prize card art height, in pixels. */
const CARD_ART = 46;

/**
 * **Placeholder.** The `View All` control's cell, in pixels.
 *
 * Height-matched to `PRIZE_HEADER_HEIGHT` rather than chosen: the control sits in that row and a button shorter than the
 * band would float in it. `28` is the smallest band that still satisfies the chunky depth rule for a control
 * (`CHUNKY_CONTROL_DEPTH = 6` against `CHUNKY_CONTROL_STROKE = 3`, so `D >= 2X` holds at exactly 6 and the visible strip is
 * 4.5 px) while leaving a face tall enough for a `caption` label. The band was 22 px when it held a text placeholder; it
 * grew by six when the placeholder became something a player can press.
 */
const VIEW_ALL_WIDTH = 96;

// #region the expanded prize view (item 155)

/**
 * **Placeholder.** Fraction of the viewport height the expanded view's grid may take.
 *
 * The sheet is clamped to 88% of the viewport by `capToViewport`, and everything above the grid - header, back row, chest
 * band, title band, status line and their gaps - is about 250 pixels. `0.42` of a 720-pixel viewport is 302, which leaves
 * the whole sheet comfortably inside the clamp; the bounds below take over on a short window.
 *
 * **A fixed height rather than `AutomaticSize.Y`, and that is the decision this constant exists to record.** The sheet and
 * its face both measure their own content, so a grid that sized itself from its contents would make the sheet grow to fit
 * ten cards - past the viewport clamp, with the overflow drawn outside the frame rather than scrolled inside it
 * (`clipsDescendants` is false on the face, deliberately). Giving the grid a height is what turns "ten cards" into "a box
 * ten cards scroll inside", which is the only shape in which `ScrollingFrame` does anything.
 */
const PRIZE_GRID_VIEWPORT_FRACTION = 0.42;

/** **Placeholder.** Floor for that height, in pixels: below this a grid shows one row and reads as broken rather than small. */
const PRIZE_GRID_MIN_HEIGHT = 180;

/** **Placeholder.** Ceiling for that height, in pixels, so a very tall monitor does not turn the sheet into a phone book. */
const PRIZE_GRID_MAX_HEIGHT = 340;

/** **Placeholder.** A card in the expanded grid, in pixels. Wider than a shelf card because it carries a third line. */
const PRIZE_CARD_WIDTH = 96;

/** **Placeholder.** Its height: art block, name, probability. */
const PRIZE_CARD_HEIGHT = 100;

/** **Placeholder.** The art block inside one, in pixels. */
const PRIZE_CARD_ART = 52;

/** **Placeholder.** The chest block in the expanded view's identity band, in pixels. Compact: it is one row, not a column. */
const PRIZE_CHEST_BLOCK = 44;

/** **Placeholder.** Height of the `Back` row, in pixels. Same cell as `View All`, so the two read as the same control. */
const PRIZE_BACK_HEIGHT = 28;

/** **Placeholder.** The `Back` control's width, in pixels. Wide enough for the chevron and the word. */
const PRIZE_BACK_WIDTH = 88;

/** **Placeholder.** Height of the title band above the grid, in pixels. */
const PRIZE_TITLE_HEIGHT = 22;

/** **Placeholder.** Separator between the tier percentages on the identity band's odds line. */
const ODDS_SEPARATOR = "  ·  ";

// #endregion

/** **Placeholder.** Height of the purchase-button row, in pixels. A tall target, as in the reference. */
const BUTTON_ROW_HEIGHT = 58;

/** **Placeholder.** Inset between the sheet edge and its content, in pixels. */
const SHEET_INSET = SPACING.md;

/** **Placeholder.** Gap between stacked bands, in pixels. */
const BAND_GAP = SPACING.xs + 2;

/** **Placeholder.** Diameter of the coin placeholder circle, in pixels. */
const COIN_SIZE = 20;

/**
 * **Placeholder.** How long a chest call may go unanswered before the client stops waiting.
 *
 * A bulk open rolls ten times and saves once, so its reply can take longer than a single chest — but it is still one
 * round trip, and 15 s is far beyond a healthy store. The value is not a timeout the server is expected to meet; it is
 * the point at which "still waiting" would become "the store is stuck", and the guard has to be released either way.
 */
const BULK_REPLY_TIMEOUT_SECONDS = 15;

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

/**
 * **Deleted in item 160: `STORE_NARROW_WIDTH`.**
 *
 * It was the store's and the inventory's only breakpoint, and it stacked both of them below 900 viewport pixels — a *different
 * composition* for a small screen, which is precisely what was reported as wrong. Both arrangements are now unconditional and
 * the whole sheet is drawn at a uniform `UIScale` (`applyPanelScale`), so nothing in this file branches on screen size.
 */

/** **Placeholder.** Height of the policy reason line under the Premium buttons, in pixels. */
const POLICY_NOTE_HEIGHT = 18;

/** **Placeholder.** Gap between the two chest sections when they sit side by side, in pixels. */
const STORE_COLUMN_GAP = SPACING.sm;

/**
 * **Placeholder.** Border weight of a chest section's outline, in pixels.
 *
 * Thin on purpose: this outline's job is to separate two products on one sheet, not to compete with the prize cards'
 * rarity borders or the action buttons it is tinted to match.
 */
const SECTION_STROKE_THICKNESS = 1;

/**
 * **Placeholder.** Seconds after which a purchase prompt's guard is released regardless.
 *
 * `PromptProductPurchase` returns nothing, so `PromptProductPurchaseFinished` is the only cancellation signal — and it
 * has been observed not to fire in some Studio configurations. A guard released only by that signal can latch for the
 * whole session, so this is the backstop. Releasing early is harmless: the worst outcome is a second dialog.
 */
const PURCHASE_GUARD_TIMEOUT_SECONDS = 30;

// #endregion

// #region inventory geometry

/**
 * **Placeholder.** Height of the collection/detail row, in pixels.
 *
 * The sheet's height is this plus its three fixed bands. **Offset, not a fraction of the screen**: the row is a scroll
 * area, so it has to have a height of its own for `AutomaticCanvasSize` to have something to be taller than, and a
 * fraction would make a tall monitor stretch a grid of 84-pixel cards over 900 pixels of emptiness.
 */
const INVENTORY_ROW_HEIGHT = 300;

/** The inventory sheet: one comfortable column, tall enough for the row plus its bands. */
const INVENTORY_PANEL_SIZE = UDim2.fromOffset(
	STORE_MAX_WIDTH,
	PANEL_HEADER_HEIGHT + TAB_STRIP_HEIGHT + INVENTORY_ROW_HEIGHT + PANEL_FOOTER_HEIGHT,
);

/**
 * **Placeholder.** One rail tab's footprint, in pixels.
 *
 * A square card rather than the previous 34-pixel pill: the art has an icon above a title and a shadow plate behind
 * both, so the tab needs room in two dimensions. The size is the **whole** card including its shadow - `buildChunkyButton`
 * insets the face inside this box rather than hanging it outside, so the list layout's cells are exactly what they say.
 */
const RAIL_TAB_SIZE = UDim2.fromOffset(84, 84);

/**
 * **Placeholder.** The store's icon. **This is not an asset you own** - the tree ships no icon art, so this id renders
 * nothing until it is replaced with the shop icon.
 */
const RAIL_STORE_ICON = "rbxassetid://123456789";

/**
 * **Placeholder.** The inventory's icon, same caveat as `RAIL_STORE_ICON`.
 */
const RAIL_INVENTORY_ICON = "rbxassetid://123456788";

/** One rail tab, as data. A new tab is a row here, not another branch in `buildRail`. */
interface RailTabSpec {
	readonly id: PanelId;
	readonly title: string;
	readonly icon: string;
	/** The bright face of the card. */
	readonly color: Color3;
	/** The plate behind it. Always the same hue, dark: the shadow is a shade of the card, never a second colour. */
	readonly shadow: Color3;
}

/**
 * **Placeholder.** The rail's tabs, in draw order.
 *
 * **The shadow is a shade of its own card, not a near-black.** It has to be dark enough to read as "the same surface, in
 * shadow" and light enough not to merge with the `CHUNKY_DEPTH`-pixel outline that runs along its inner edge: the first
 * pass used shadows dark enough that the two read as one border and the card looked flat.
 *
 * **The colours live here and not in the theme.** They are the card's identity - the store is red because the store is
 * red, not because the palette has an "accent" - and a theme entry would be three one-use colours in a file every
 * panel reads. `buildChunkyButton` takes them as arguments for exactly this reason.
 *
 * **The labels stay `STORE` and `INVENTORY`**, the words the rail already used, rather than the brief's `SHOP`: renaming
 * a tab is a copy decision, not a visual one, and the sheets behind them are still the store and the inventory.
 */
const RAIL_TABS: Array<RailTabSpec> = [
	{
		id: "shop",
		title: "STORE",
		icon: RAIL_STORE_ICON,
		color: Color3.fromRGB(232, 68, 68),
		shadow: Color3.fromRGB(170, 34, 34),
	},
	{
		id: "inventory",
		title: "INVENTORY",
		icon: RAIL_INVENTORY_ICON,
		color: Color3.fromRGB(64, 140, 240),
		shadow: Color3.fromRGB(26, 82, 160),
	},
];

/** **Placeholder.** Rail inset from the screen edge, in pixels, so a rounded corner is not clipped. */
const RAIL_INSET = SPACING.sm;

/** **Placeholder.** Draw order of the rail tabs. */
const RAIL_Z_INDEX = 4;

/** **Placeholder.** The inventory's empty state: a sentence, not an empty grid. */
const INVENTORY_EMPTY = "You do not own any balls yet. Open a chest in the Store.";

/** **Placeholder.** The fusion tab's empty state. */
const INVENTORY_FUSION_EMPTY = "Open a chest to get balls to fuse.";

/** **Placeholder.** The inventory's status line. */
const INVENTORY_FOOTER = "Fusing spends both balls, win or lose.";

/** **Placeholder.** The inventory's two tabs. */
const INVENTORY_TABS = ["Balls", "Fusion"];

/** **Placeholder.** Share of the row taken by the collection; the detail pane takes the rest (~75/25). */
const INVENTORY_COLLECTION_FRACTION = 0.72;

/** **Placeholder.** Card size in the collection grid, in pixels. */
const INVENTORY_CARD_WIDTH = 84;
const INVENTORY_CARD_HEIGHT = 86;

/** **Placeholder.** Height of one row in the fusion material list, in pixels. */
const FUSION_ROW_HEIGHT = 34;

/** **Placeholder.** Height of the detail pane's preview block, in pixels. */
const INVENTORY_PREVIEW_HEIGHT = 96;

/** **Placeholder.** Diameter of the ball drawn inside that preview, in pixels. */
const INVENTORY_PREVIEW_BALL = 56;

// #endregion

/** What the server answers a chest press with, mirroring `EconomyService`'s union.
 *
 * **Widened from a single `ballId`.** A bulk open grants several, and the reply is now the client's only account of what
 * happened: `balls` is in roll order so the status line can name them, and `coins` is the balance the *server* computed
 * for that call. The balance is also an attribute, but the attribute is published for the whole session and the reply is
 * what this press actually did.
 */
type ChestResult = { ok: true; balls: Array<string>; coins: number } | { ok: false; reason: string };

/** One purchase button and the number of chests it buys, so affordability can be evaluated per button. */
interface ChestButton {
	readonly button: TextButton;
	readonly count: number;
	/** The price line, rewritten to `have/price` when the balance cannot cover this batch. */
	readonly priceLabel: TextLabel;
	/** The action line, dimmed with the price when the button cannot act. */
	readonly actionLabel: TextLabel;
}

/** What the server answers a fusion with. */
type FusionResult = { ok: true; outcome: "success" | "fail"; resultBallId?: string } | { ok: false; reason: string };

/** Which panel the controller can open. */
type PanelId = "shop" | "inventory";

/** Which chest a section is, and therefore which pool the expanded prize view lists. */
type ChestKind = "coin" | "premium";

/**
 * Everything the expanded prize view needs to describe one chest (item 155).
 *
 * ## Why this is a value rather than four lookups at the call sites
 *
 * Both chest sections have a `View All` and a shelf of clickable cards, so the view has two possible subjects. Passing the
 * *kind* and re-deriving the rest inside the view would put the coin/premium branch in two places - once where the shelf is
 * filled and once where the grid is - and the third chest would need it in three. A spec built by `chestSpecOf` means the
 * view is written once against a description, and "which chests exist" stays a fact about `economy.config.ts`.
 *
 * `weights` and `odds` are carried together because they are the same fact in two forms: per-ball probability needs the
 * weights, the band's summary line needs the apportioned percentages, and deriving one from the other at the call site is
 * how the grid and the summary would end up disagreeing.
 */
interface ChestSpec {
	readonly kind: ChestKind;
	readonly title: string;
	/** The tiers this chest can actually grant, in display order. `RARITIES` for the coin chest, minus common for the paid one. */
	readonly rarities: ReadonlyArray<Rarity>;
	readonly weights: Record<Rarity, number>;
	/** What `oddsFrom` makes of `weights`: the same numbers the chest section's stat column already prints. */
	readonly odds: Array<ChestOdd>;
}

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
 * light direction pushed nothing either (it would repaint the phase banner), so a store label asking big-ui for
 * "primary" got whichever palette the HUD had pushed - and, on the old paper sheet, white ink that vanished. The colour
 * clash is gone now that the sheet is dark, but the other half of the reason stands: assigning `TextColor3` after
 * construction does not reliably survive the library's own hydration. Assigning `TextColor3` after construction does not reliably survive the library's own
 * hydration.
 *
 * So the store builds plain `TextLabel`s through Fusion and sets font, size and colour itself. That is one less layer
 * between the theme and the pixel, and it is the same idiom `PhaseBannerController` already uses for its container.
 */
@Controller()
export class ShopController implements OnStart {
	private readonly theme: Theme = chunkyDarkTheme();
	private readonly player = Players.LocalPlayer;

	private readonly panels = new Map<PanelId, Frame>();
	private readonly railButtons = new Map<PanelId, ChunkyButton>();

	private rail!: Frame;

	private open: "shop" | "inventory" | "none" = "none";
	private phase = "unknown";

	/**
	 * Releases the movement lock while a panel is open, or `undefined` when movement is the player's (item 161).
	 *
	 * The *presence* of this function is the lock state — there is no separate boolean to keep in step with it, which is what
	 * makes `applyModal`'s "already in the state we want" test a single comparison.
	 */
	private controlsRelease?: () => void;

	// #region store state

	private chestRemote?: RemoteEvent;
	private fusionRemote?: RemoteEvent;

	/** The store's Fusion scope. Created with the panel and never before it — a closed store owns nothing. */
	private scope?: Fusion.Scope<unknown>;

	private coinsLabel?: TextLabel;
	private statusLabel?: TextLabel;
	/**
	 * Every prize shelf the store builds, which is now two: the coin chest's and the Premium chest's.
	 *
	 * A list rather than a second field because `drivePrizeShelf` is the only reader and its body is shelf-agnostic —
	 * two fields would mean two identical branches, and the second one would be the one somebody forgot to add when a
	 * third chest arrives.
	 */
	private readonly prizeShelves = new Array<ScrollingFrame>();
	private fusionOddsLabel?: TextLabel;
	private fusionButton?: TextButton;
	/** The fuse button's caption. The chrome makes the button a hit area, so its word lives on the face. */
	private fusionLabel?: TextLabel;
	private chestButtons = new Array<ChestButton>();

	private chestSection?: Frame;

	// #region expanded prize view state (item 155)

	/**
	 * The expanded view's band, or `undefined` before the store has been built.
	 *
	 * **A second state of the same sheet, not a second sheet.** It is a sibling of `Content` inside the store's own vertical
	 * list, hidden until a `View All` or a shelf card asks for it; the header, the coin pill and the close button above it
	 * are the store's, unchanged and not duplicated. Only one of `Content`/`prizeView` is ever visible, so the two sharing a
	 * `LayoutOrder` is a tie that cannot be observed - and a hidden child is not laid out at all, so the band takes no space
	 * while the chest sections are showing.
	 */
	private prizeView?: Frame;

	/** The store's normal content band, kept so the two states can be swapped without rebuilding either. */
	private storeContent?: Frame;

	/** The grid the cards are built into, and the message shown instead when a chest has no pool. */
	private prizeGrid?: ScrollingFrame;
	private prizeEmpty?: TextLabel;

	/** The identity band's three live pieces: the tinted block, the chest's name, and its tier summary. */
	private prizeChestBlock?: Frame;
	private prizeChestName?: TextLabel;
	private prizeOddsLabel?: TextLabel;

	/** The title band's right-hand count. */
	private prizeCountLabel?: TextLabel;

	/** Which chest is expanded, or `undefined` while the chest sections are showing. The whole of the view's state. */
	private expandedChest?: ChestKind;

	/** The cards currently in the grid, so a re-open for the other chest can drop the previous set. */
	private readonly prizeCards = new Array<TextButton>();

	// #endregion

	/** True between a press and its reply, so one press cannot become three. */
	private busy = false;

	/**
	 * Identifies the chest call currently in flight.
	 *
	 * A counter rather than a boolean because the reply and the watchdog can both arrive, and only one of them concerns
	 * the call that is still open: without an id, a late watchdog from call A would clear the guard on call B and let a
	 * third press through while the first is still being saved.
	 */
	private chestCallId = 0;

	// #region premium chest state

	/**
	 * The cached paid-random-item gate.
	 *
	 * **Starts at `loading`, which is not allowed.** The gate must never fail open: the initial value, a failed read and a
	 * restricted player all render the same disabled button, and only an explicit
	 * `ArePaidRandomItemsRestricted: false` from Roblox enables it.
	 */
	private policy: PolicyState = "loading";

	/** True between a prompt and its finished signal (or the timeout), so one click cannot open two dialogs. */
	private purchasePending = false;

	/** The Premium buttons, so the gate can restyle them without rebuilding the section. */
	private readonly premiumButtons = new Array<TextButton>();

	/** The line under those buttons that says why they are disabled. */
	private policyNote?: TextLabel;

	/** The two chest sections, for the responsive row. */
	private readonly chestColumns = new Array<Frame>();

	// #region inventory state

	/** Which inventory tab is showing. Separate from the store's (now removed) strip. */
	private inventoryTab: "Balls" | "Fusion" = "Balls";

	/**
	 * The `Balls` tab's inspected ball.
	 *
	 * **A different fact from `fusionMaterialId`.** Inspecting a ball is "tell me about this one"; choosing a fusion
	 * material is "I intend to spend two of these". Sharing one field would mean switching tabs silently reinterprets the
	 * last click as a different intent — the player would return to `Balls` to find a random ball highlighted, or to
	 * `Fusion` with a material already selected that they never chose.
	 */
	private inspectBallId?: string;

	/** The `Fusion` tab's chosen material. */
	private fusionMaterialId?: string;

	/**
	 * The inventory's footer label.
	 *
	 * **Separate from the store's.** Both panels stay built for the session, so one shared `statusLabel` would be
	 * whichever was constructed last, and a fusion result would be written into the other panel's hidden footer.
	 */
	private inventoryStatus?: TextLabel;

	private inventoryScope?: Fusion.Scope<unknown>;
	private inventoryFrame?: Frame;
	private inventoryRow?: Frame;
	/**
	 * The `BallsView`/`FusionView` band lists, which are the ones that flip between side-by-side and stacked.
	 *
	 * **Not the row's list.** The row holds the two views, of which exactly one is visible, so its direction is always
	 * horizontal and flipping it would do nothing. The direction that has to change is the one *inside* a view, between
	 * its collection and its detail pane.
	 */
	private readonly inventorySplitLayouts = new Array<UIListLayout>();
	private ballsView?: Frame;
	private fusionView?: Frame;
	private ballsGrid?: ScrollingFrame;
	private fusionList?: ScrollingFrame;
	private detailPreview?: Frame;
	private detailBall?: Frame;
	private detailName?: TextLabel;
	private detailRarity?: TextLabel;
	private detailCount?: TextLabel;
	private detailHint?: TextLabel;
	private fusionMaterialLabel?: TextLabel;
	private fusionEmptyLabel?: TextLabel;

	private readonly ballsCards = new Array<TextButton>();
	private readonly fusionRows = new Array<TextButton>();

	// #endregion
	private chestRowLayout?: UIListLayout;
	private chestRow?: Frame;

	// #endregion

	// #endregion

	public onStart(): void {
		const gui = getScreenGui("sheet");
		this.rail = this.buildRail(gui);

		this.applyPhase(this.readPhase());
		this.connectRemotes();
		this.connectAttributes();
		this.connectPolicyGate();
		this.connectPurchasePrompt();
		this.drivePrizeShelf();

		// **Does the coin asset resolve? (item 154.)** Once per session across every panel that draws one — the helper is
		// idempotent, so this line here and the identical ones in the payout and toast controllers produce one log line
		// between them. The panels are already built by now: a missing icon draws a gap, and a gap is better than a shop
		// that refused to open over a picture.
		reportCoinIconLoad();

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
	 * Finds the economy remotes and subscribes to their replies.
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

		// **The purchase sound's only trigger, and the reason it is a third remote rather than a branch in the two
		// handlers above.** The Robux chest's grant happens inside `ProcessReceipt`, server to server, and never answers a
		// client request — so without this signal the one purchase that costs real money would be the only silent one.
		// Nothing here listens to `PromptProductPurchaseFinished`: that reports a dialog closing, and the file's own note
		// beside `connectPurchasePrompt` explains why the client may not treat it as a grant.
		const purchaseGranted = folder.WaitForChild(PURCHASE_GRANTED_REMOTE_NAME, 10);
		if (purchaseGranted !== undefined && purchaseGranted.IsA("RemoteEvent")) {
			purchaseGranted.OnClientEvent.Connect(() => playPurchaseSound());
		} else {
			warn(`[Shop] no ${PURCHASE_GRANTED_REMOTE_NAME} remote — a granted purchase will be silent.`);
		}
	}

	/**
	 * Reads the paid-random-item policy once, and caches it for the session.
	 *
	 * ## Why the gate exists at all
	 *
	 * A randomised item sold for Robux is not permitted for every player in every region. `ArePaidRandomItemsRestricted`
	 * is how Roblox tells this game that a given player may not be shown one. Skipping the read would mean prompting a
	 * purchase that is illegal for that player and taking money for something they must not be sold.
	 *
	 * ## Why every failure lands on a blocked state
	 *
	 * The call can fail — no network, a transient backend error, an unauthenticated Studio session. A gate that treated a
	 * failure as permission would fail **open**, and failing open sells a restricted item to a restricted player. That
	 * cannot be undone: the money is taken, the item is delivered, and the remedy is a refund this game cannot issue. So
	 * an error is `unknown`, `unknown` is treated exactly like `restricted`, and the buttons simply stay disabled until a
	 * later session reads a real record.
	 *
	 * ## Why once
	 *
	 * Policy does not change during a session in any way this UI can act on, and re-reading per prompt would put a
	 * network round trip between a click and a purchase dialog, which reads as a broken button.
	 */
	private connectPolicyGate(): void {
		this.applyPolicy("loading");

		task.spawn(() => {
			const [ok, info] = pcall(() => PolicyService.GetPolicyInfoForPlayerAsync(this.player));

			if (!ok) {
				warn(`[Store] policy=unknown reason=error`);
				this.applyPolicy("unknown");
				return;
			}

			const state = policyStateFrom(info as PolicyInfo);
			this.applyPolicy(state);
		});
	}

	/** Applies a gate state to the cached value, the buttons and the note. One writer, so they cannot disagree. */
	private applyPolicy(state: PolicyState): void {
		this.policy = state;

		const allowed = policyAllowsPurchase(state);

		for (const button of this.premiumButtons) {
			button.Active = allowed;
			// The button has no `Text` of its own any more - the chrome moved the caption onto the face - so the wash goes
			// through the chrome's face and labels rather than through `TextTransparency`, which would now do nothing.
			dimChunkyChrome(button, !allowed);
		}

		if (this.policyNote !== undefined) {
			this.policyNote.Text = allowed ? "" : policyBlockedReason(state);
			this.policyNote.Visible = !allowed;
		}

		// One line per transition, not per frame: a state that does not change says nothing.
		print(`[Store] policy=${state} reason=${allowed ? "allowed" : "blocked"}`);
	}

	/**
	 * Connects `PromptProductPurchaseFinished` **only** to release the busy guard.
	 *
	 * ## Why this must not grant anything
	 *
	 * The name invites it: "finished" plus "was purchased" reads like the moment to hand over the item. It is not. The
	 * server's `ProcessReceipt` is the sole grant path, because it is the only path that can be trusted — a client can lie
	 * about `isPurchased`, and a client-side grant would also be lost if the player left before the profile saved. This
	 * connection exists for one reason: the prompt is modal, the player may cancel it, and without a release the buttons
	 * would stay disabled for the rest of the session.
	 *
	 * ## Why a timeout is also needed
	 *
	 * `PromptProductPurchase` returns `void` — there is no result to await — so `PromptProductPurchaseFinished` is the
	 * only cancellation signal. The typings document it as a signal but say nothing about it being guaranteed, and it has
	 * been observed not to fire in some Studio configurations. A guard that only that signal can release can therefore
	 * latch forever, so a timeout releases it too. Releasing early is harmless: the worst case is a second prompt.
	 */
	private connectPurchasePrompt(): void {
		MarketplaceService.PromptProductPurchaseFinished.Connect(() => {
			// Deliberately ignores all three arguments. Nothing here may depend on what the client believes happened.
			this.releasePurchaseGuard();
		});
	}

	/** Clears the busy flag and re-enables whatever is permitted. Safe to call twice. */
	private releasePurchaseGuard(): void {
		this.purchasePending = false;
		this.busy = false;
		this.applyPolicy(this.policy);
	}

	/**
	 * Fires a purchase prompt for a Developer Product, or explains why it will not.
	 *
	 * The gate is checked **here**, immediately before the prompt, rather than only when the button was styled: a state
	 * that changed between the two would otherwise let a click through on a stale decision.
	 */
	private promptProduct(productId: number, productName: string): void {
		if (!policyAllowsPurchase(this.policy)) {
			print(`[Store] ${productName} prompt refused ? policy=${this.policy}`);
			return;
		}

		if (this.purchasePending) {
			return;
		}

		this.purchasePending = true;
		this.busy = true;
		for (const button of this.premiumButtons) {
			button.Active = false;
			dimChunkyChrome(button, true);
		}

		// `void` return: the dialog is asynchronous and the only signals are `PromptProductPurchaseFinished` and the
		// server's receipt. Hence the timeout beside the finished connection.
		MarketplaceService.PromptProductPurchase(this.player, productId);

		task.delay(PURCHASE_GUARD_TIMEOUT_SECONDS, () => {
			if (this.purchasePending) {
				this.releasePurchaseGuard();
			}
		});
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

		// **`Modal` follows the phase as well as the panel, so the phase change has to re-answer it (item 161).**
		//
		// It is called here *before* the early return, and that ordering is the whole point: item 50's rule below leaves the
		// sheet open when the phase leaves `Intermission`, so this is the one moment the panel is still visible and must stop
		// swallowing input. Putting it after the return would make a store left open across `Playing` keep a dead joystick for
		// the rest of the round — the failure this round exists to prevent, arriving from the other side.
		this.applyModal();

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

		// An indexed loop rather than `entries()`: roblox-ts compiles against a Lua table, and the array iterator's tuple form
		// is not in its lib. The array order is the draw order, so a tab inserted in the middle of the table needs no
		// renumbering here.
		for (let index = 0; index < RAIL_TABS.size(); index++) {
			const tab = RAIL_TABS[index];
			const button = buildChunkyButton({
				name: `${tab.title}Tab`,
				size: RAIL_TAB_SIZE,
				title: tab.title,
				iconAssetId: tab.icon,
				color: tab.color,
				shadowColor: tab.shadow,
				layoutOrder: index + 1,
				zIndex: RAIL_Z_INDEX,
				onActivated: () => this.toggle(tab.id),
				parent: rail,
			});

			this.railButtons.set(tab.id, button);
		}

		this.restyleRail();

		// **A placeholder icon id renders nothing while still occupying its slot**, which looks exactly like a layout
		// mistake - an unexplained empty square in the upper half of every card. Saying so once at mount is the cheapest
		// way to stop that being diagnosed as a bug; the ids are the only thing to change.
		for (const tab of RAIL_TABS) {
			if (tab.icon === RAIL_STORE_ICON || tab.icon === RAIL_INVENTORY_ICON) {
				warn(
					`[Shop] rail tab ${tab.title} is still using a placeholder icon (${tab.icon}) - its icon slot is reserved and empty until that id is swapped.`,
				);
			}
		}

		return rail;
	}

	/**
	 * Which rail tab looks selected is a statement about `open`, derived from it and never stored twice.
	 *
	 * The chunky card expresses selection by **depth rather than colour**: the tab whose panel is open is drawn pressed,
	 * its face flush with the shadow plate, and the others sit proud. That is why this loop no longer touches a
	 * `BackgroundColor3` - the card owns its own colours, and inverting them here would be a second palette to keep in
	 * step with `RAIL_TABS`.
	 */
	private restyleRail(): void {
		for (const [id, button] of this.railButtons) {
			button.setRaised(this.open !== id);
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

		if (target !== "none") {
			// A panel may have been built several intermissions ago; opening it is the moment to re-read the profile.
			this.refreshCoins();
			this.refreshOwned();
		}

		this.restyleRail();
		this.applyModal();
		print(`[Shop] open=${this.open} phase=${this.phase}`);
	}

	/**
	 * Decides whether movement is taken away, and it is the **only place the lock is taken or released in this controller** (item
	 * 161).
	 *
	 * ## Why not a GUI blocker
	 *
	 * The brief's `ScreenGui.Modal` does not exist on `ScreenGui` in this tree's typings — `Modal` is declared on `GuiButton`
	 * (`None.d.ts:21905`), where it means *"the mouse will not be locked unless the right mouse button is down"*, a cursor-lock
	 * rule rather than an input capture. And the obvious substitute, a full-screen transparent `TextButton` swallowing every
	 * touch, **stops the click and not the character**: the dynamic thumbstick is drawn and driven by the `PlayerModule`'s touch
	 * controls, which read `UserInputService` rather than GUI hit-testing. See `client/controls-lock.ts` for the whole argument.
	 *
	 * ## Why it is `open !== "none"` **and** the phase is `Intermission`
	 *
	 * This is where item 50's phase rule and this round's input fix collide, and the collision is real: item 50 says a panel left
	 * open when the phase changes **stays open**, so a store opened in `Intermission` and left open is still on screen during
	 * `Playing`. If the lock followed visibility alone, that player could not move for the whole race — the panel over the belt
	 * *and* the character frozen, with nothing in any log to say why.
	 *
	 * So it follows both. A panel left open across a phase change keeps item 50's behaviour exactly — visible, not closed by the
	 * phase — but gives movement back, so the player can still race under it. The cost is named rather than hidden: **a panel
	 * covering the belt is something the player can still drive under.** Closing it with the `X` restores both.
	 */
	private applyModal(): void {
		const wants = this.open !== "none" && this.phase === PHASE_INTERMISSION;

		if (wants === (this.controlsRelease !== undefined)) {
			return;
		}

		if (wants) {
			this.controlsRelease = lockControls();
		} else {
			const release = this.controlsRelease;
			this.controlsRelease = undefined;
			if (release !== undefined) {
				release();
			}
		}

		// One line per *toggle*, not per call: "why is the joystick not working" is answered here in one read, and a line printed on
		// every `setOpen` would bury the two that matter.
		print(`[Shop] modal=${tostring(wants)} open=${this.open} phase=${this.phase}`);
	}

	private ensurePanel(id: PanelId): Frame {
		const existing = this.panels.get(id);
		if (existing !== undefined) {
			return existing;
		}

		const gui = getScreenGui("sheet");
		const panel = id === "shop" ? this.buildStore(gui) : this.buildInventory(gui);
		panel.Visible = false;

		// **A destroyed panel must release the lock (item 161).** If it is torn down while open, nothing else will: the lock would
		// stay held and the character would be frozen for the rest of the session with nothing on screen to explain it.
		panel.Destroying.Connect(() => {
			if (this.controlsRelease !== undefined) {
				const release = this.controlsRelease;
				this.controlsRelease = undefined;
				release();
			}
		});

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
	 *   Content                   (Vertical)        ─┐ exactly one of these
	 *     Coin Chest Section      (Vertical)         │ two is visible, because
	 *       "Coin Chest"          (title)            │ the expanded prize view
	 *       Preview Row           (Horizontal: chest square, rarity stats)
	 *       Prize Preview Header  (Horizontal: "Prize Preview", View All)
	 *       Prize Scroller        (Horizontal, auto-scrolling, clickable cards)
	 *       Purchase Buttons      (Horizontal: Open 1, Open 10)
	 *     Premium Chest Section   (Vertical, same shape, Robux)
	 *   PrizeView                 (Vertical)        ─┘
	 *     Back Row                (Horizontal: Back)
	 *     Chest Band              (Horizontal: tinted CHEST block, name, tier odds)
	 *     All Prizes              (Horizontal: title, spacer, "<N> items")
	 *     Prize Grid              (ScrollingFrame + UIGridLayout, fixed height)
	 *   Status                    (one line, shared by both states)
	 * ```
	 *
	 * **The expanded prize view is a second state of this band, not a second sheet (item 155).** It is a sibling of
	 * `Content` inside the same list, hidden until a `View All` or a shelf card asks for it, so the header, the coin pill and
	 * the close button above both of them are literally the same objects in both states. Only one of the two is ever
	 * visible, which is why they share a `LayoutOrder` without a tie anybody can see.
	 *
	 * **The category tabs are gone.** They held `Balls` and `Fusion`, and both of those are now tabs of the inventory
	 * sheet, which is where a player's own balls belong. A single-tab strip would have been a button that does nothing.
	 *
	 * **Every level is a real container with a real layout**, which is the point of the rewrite: the previous version
	 * positioned four bands by hand inside a 90%-tall sheet and the result read as scattered. A list of lists cannot
	 * leave a 200-pixel gap between a section title and the thing it titles.
	 *
	 * **The sheet is sized by its content.** `Size = UDim2.new(STORE_WIDTH_SCALE, 0, 0, 0)` with
	 * `AutomaticSize = Y` means the panel hugs the chest section; `capToViewport` supplies a pixel ceiling so a short
	 * window scrolls nothing and a tall one is not stretched. That single change removes the empty space.
	 *
	 * **Charcoal throughout: `chunkyDarkTheme()` supplies every colour**, chrome included, and the only literals in this
	 * method are the geometry constants above.
	 */
	private buildStore(parent: Instance): Frame {
		const scope = Fusion.scoped(Fusion);
		this.scope = scope;

		// **The chunky chrome is one call now.** The container, the offset shadow plate, the face, the corner and the thick
		// outline all come from `buildChunkyPanel`, so the store and the inventory cannot drift apart again - and the
		// face colour is a neutral charcoal rather than the store's red, because the red already did its job on the tab
		// that opened this sheet.
		//
		// **`autoHeight`, and the reason is a resolved circular size.** The face used to be a child at `fromScale(1, 1)`
		// inside an `AutomaticSize.Y` container: the container waited for the child's height, the child asked for the
		// container's, and the engine resolved it by leaving the face at its floor height - which clipped the purchase
		// buttons at the bottom of the sheet. Auto-height on the container with content-driven sizing on the face is the
		// shape that resolves, and it is what `capToViewport` is then applied to.
		const panel = buildChunkyPanel({
			name: "Store",
			parent,
			// **The designed width, on every screen (item 160).** This stays `880` and is *not* turned into a fraction: the sheet
			// is laid out at its design size and the whole composition is then drawn at `panelScaleFor`'s multiplier, which is
			// what keeps a phone's store identical to a desktop's. Narrowing the sheet instead is the change that produced a
			// stacked, overflowing phone layout — a fixed width does not overflow a small screen when the screen is not what it is
			// measured in.
			size: UDim2.fromOffset(STORE_MAX_WIDTH, 0),
			autoHeight: true,
			cornerRadius: SPACING.md,
			// Not clipping, deliberately: every child is inset by `SHEET_INSET`, so the rounded corner has nothing to cut,
			// and a sheet that visibly overflows is a bug somebody reports rather than one nobody ever sees.
			clipsDescendants: false,
			zIndex: STORE_Z_INDEX,
		});

		const surface = panel.surface;
		// **The scale replaces the clamp, it does not join it (item 160).** `capToViewport` constrains *layout* size — it would set
		// the width to 92% of a phone's screen while leaving the height and every band at their designed proportions, which squashes
		// the composition. `applyPanelScale` is a render transform applied after layout, so the panel keeps its geometry and is drawn
		// smaller. The two answer the same question and only one can be right.
		applyPanelScale(panel.frame, "store");

		// Level 0: the store's own vertical list. Header, tabs, content - in that order, nothing positioned by hand.
		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, BAND_GAP),
			Parent: surface,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SHEET_INSET),
			PaddingBottom: new UDim(0, SHEET_INSET),
			PaddingLeft: new UDim(0, SHEET_INSET),
			PaddingRight: new UDim(0, SHEET_INSET),
			Parent: surface,
		});

		this.buildHeader(scope, surface);
		this.buildContent(scope, surface);
		this.buildPrizeView(scope, surface);

		// The status band: one line at the foot, where a refusal or a result appears. Part of the same vertical list,
		// so it sits under the content rather than floating at a fixed offset.
		this.statusLabel = this.text(
			scope,
			surface,
			"",
			"caption",
			"secondary",
			4,
			new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight + SPACING.xs),
			false,
		);
		this.statusLabel.TextXAlignment = Enum.TextXAlignment.Center;
		this.statusLabel.TextYAlignment = Enum.TextYAlignment.Center;

		this.refreshCoins();
		this.refreshOwned();

		// **The gate is re-applied once the buttons exist.** `connectPolicyGate` runs at mount, before this sheet is built
		// — the store is lazy — so if the policy read has already returned by now, the only `applyPolicy` call happened
		// against an empty button list and every Premium button would stay disabled for the whole session despite an
		// allowing policy. Applying the cached state here is what makes the two orders equivalent.
		this.applyPolicy(this.policy);

		return panel.frame;
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
			BackgroundColor3: this.theme.paint.trough.color,
			BackgroundTransparency: this.theme.paint.trough.transparency,
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
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Text: "",
			LayoutOrder: 4,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: header,
		});

		// The close button is as clickable as anything else on the sheet, so it gets the same depth. Its "X" moves onto the
		// face as a label: the chrome turns the button into a transparent hit area, and its own `Text` would sit under the
		// face.
		applyChunkyChrome(close, {
			color: this.theme.paint.trough.color,
			shadowColor: shadowOf(this.theme.paint.trough.color),
			zIndex: STORE_Z_INDEX + 3,
			corner: SPACING.xs,
			label: {
				text: "X",
				textSize: PANEL_TYPE.h6.size,
				color: this.theme.colors.textPrimary,
				font: FONT,
				zIndex: STORE_Z_INDEX + 5,
			},
		});

		attachPressFeedback(close);
		attachClickSound(close);
		close.Activated.Connect(() => this.setOpen("none"));
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

		// The Balls tab holds a row of two chest sections; the Fusion tab holds its own section.
		// **One tab means no tab strip, and therefore one thing in here.** Removing the store's `Fusion`
		// section left a single category, and a strip with one button is an affordance that does nothing — so the
		// strip went with it and the chest row is the store's only content.
		this.chestSection = this.buildChestRow(scope, content, 1);

		// **A handle on the band, because the expanded view swaps with it (item 155).** The store has two states and they are
		// the same sheet, so the only thing the swap needs is a reference to what to hide.
		this.storeContent = content;
	}

	// #endregion

	// #region the chest section

	/**
	 * The two chest sections, side by side on every screen.
	 *
	 * ## Why this breakpoint is new
	 *
	 * The store is a single vertical column since item 59 — the side-by-side mechanism that existed in item 57 was
	 * removed when the sheet was rebuilt to a one-column hierarchy. So there is no existing pattern to match, and this is
	 * the only responsive rule in the file. It is deliberately the same *idea* as before (two containers, a horizontal
	 * list, a vertical list under the breakpoint) so a future reader is not learning a second idiom.
	 *
	 * ## Why the sections are given a height rather than auto-sizing in the row
	 *
	 * A horizontal `UIListLayout` does not stretch its children to the row's height, and the two sections have different
	 * intrinsic heights (the Premium one adds a policy note). Without a shared height the shorter one would leave a gap
	 * and the row would look ragged, so both are pinned to the row's height and each keeps its own internal list.
	 */
	private buildChestRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number): Frame {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "ChestRow",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		this.chestRow = row;

		this.chestRowLayout = Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, STORE_COLUMN_GAP),
			Parent: row,
		});

		this.chestColumns.push(this.buildChestSection(scope, row, 1));
		this.chestColumns.push(this.buildPremiumChestSection(scope, row, 2));

		this.applyChestRowLayout();
		this.watchChestRow();

		return row;
	}

	/**
	 * Lays the two chest sections out for the current width.
	 *
	 * One function, called at build and on every viewport change, so the rule has a single definition. Above the
	 * breakpoint each section takes half the row; below it they stack and each takes the full width. A ~430-pixel column
	 * is still usable (a 108-pixel preview plus a stats column plus a shelf), which is why half-width is the desktop
	 * answer rather than a wider single column.
	 */
	private applyChestRowLayout(): void {
		const layout = this.chestRowLayout;
		if (layout === undefined || this.chestColumns.size() === 0) {
			return;
		}

		// **One arrangement, on every screen (item 160).**
		//
		// This used to branch on `width < STORE_NARROW_WIDTH` and stack the two sections vertically below it. That is a
		// *different composition* for a small screen, and it is exactly what was reported: a phone showed the two chests one
		// above the other, twice as tall, and the bottom of the sheet left the screen. The sheet is now a fixed design width
		// drawn through a `UIScale` (see `applyPanelScale`), so a phone is the desktop composition at a smaller multiplier — and
		// a rule that rearranges by viewport width would be undoing that on every device narrower than the desktop.
		//
		// The parameter is gone with the branch. A future rule that genuinely needs the viewport width belongs in
		// `applyPanelScale`, which is now the only thing that reacts to it.

		layout.FillDirection = Enum.FillDirection.Horizontal;

		for (const section of this.chestColumns) {
			section.Size = new UDim2(0.5, -STORE_COLUMN_GAP / 2, 0, 0);
		}
	}

	/** Watches the viewport so a window resize re-sizes the expanded prize grid. */
	private watchChestRow(): void {
		const camera = Workspace.CurrentCamera;
		if (camera === undefined) {
			return;
		}

		camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
			if (this.scope === undefined) {
				return;
			}

			this.applyChestRowLayout();
			// **The grid is re-sized from the same event (item 155).** The sheet is built once and a window can change shape
			// afterwards; a grid left at the height it was born with would either overflow a short window or waste a tall one.
			// One watcher for both, because they are both answers to "how big is the screen".
			this.applyPrizeGridHeight();
		});
	}

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
			// **An outlined group, not a filled card.** It used to carry `paint.card`'s fill, which put a lighter plate
			// behind everything - and since the purchase buttons now draw their own chunky plates inset 6 pixels inside
			// their cells, that fill showed as a pale ring around them with the section's own stroke outside it: a "white
			// box" whose edges belonged to nothing. The fill is gone and the **1-pixel outline stays**, so the section is
			// still one identifiable offer and the only things with depth are the controls you can press.
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		this.corners(scope, section, SPACING.sm);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.theme.colors.accent,
			Thickness: SECTION_STROKE_THICKNESS,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: section,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SPACING.sm),
			PaddingBottom: new UDim(0, SPACING.sm),
			PaddingLeft: new UDim(0, SPACING.sm),
			PaddingRight: new UDim(0, SPACING.sm),
			Parent: section,
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

		this.buildPreviewRow(scope, section, 2, chestOdds());
		this.buildPrizeHeaderRow(scope, section, 3, "coin");

		const shelf = this.buildPrizeShelf(scope, section, 4);
		this.fillPrizeShelf(scope, shelf, RARITIES, "coin");
		this.prizeShelves.push(shelf);

		this.buildPurchaseRow(scope, section, 5);

		return section;
	}

	/**
	 * The Premium chest, structurally a mirror of the Coin chest.
	 *
	 * ## What is deliberately identical
	 *
	 * The band order — title, preview, prize header, prize shelf, buttons — and every builder between them. Two chest
	 * sections that drifted apart would read as two different features rather than two products, and the second one
	 * would grow its own private set of constants.
	 *
	 * ## What is deliberately different
	 *
	 * Three things, each because it would be *wrong* to share it:
	 *
	 * - **The odds** come from `robuxChestOdds()`, which is three rows and no common. Reusing `chestOdds()` would print a
	 *   60% common chance for a chest that cannot grant one.
	 * - **The prize shelf** is fed `ROBUX_CHEST_RARITIES`, so it lists only rare and above. A verbatim copy of the coin
	 *   shelf would advertise commons the chest cannot give — the "looks right, is wrong" failure this section exists to
	 *   avoid, and the reason `fillPrizeShelf` now takes its tier list as a parameter instead of reading `RARITIES`.
	 * - **The buttons** prompt a Developer Product and are gated on policy, where the coin buttons fire a remote.
	 */
	private buildPremiumChestSection(scope: Fusion.Scope<unknown>, parent: Instance, order: number): Frame {
		const section = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PremiumChestSection",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			// Same outlined-group treatment as the coin section, in `premium` rather than `accent`: two boxes outlined in
			// one colour would look like one product split in half, and the whole point of the premium tint is that the paid
			// offer is identifiable before the price is read. The fill is gone for the reason spelled out on the coin
			// section - it was a pale plate showing around the chunky buttons.
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		this.corners(scope, section, SPACING.sm);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.theme.colors.premium,
			Thickness: SECTION_STROKE_THICKNESS,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: section,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SPACING.sm),
			PaddingBottom: new UDim(0, SPACING.sm),
			PaddingLeft: new UDim(0, SPACING.sm),
			PaddingRight: new UDim(0, SPACING.sm),
			Parent: section,
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

		const titleRow = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Title",
			Size: new UDim2(1, 0, 0, SECTION_TITLE_HEIGHT),
			BackgroundTransparency: 1,
			LayoutOrder: 1,
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
			Padding: new UDim(0, SPACING.xs),
			Parent: titleRow,
		});

		const title = this.text(scope, titleRow, "Premium Chest", "h6", "primary", 1, new UDim2(0, 0, 1, 0), true);
		title.TextYAlignment = Enum.TextYAlignment.Center;

		// The Robux badge, in place of the coin pill: it says "this one costs Robux" before the player presses anything.
		const badge = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "RobuxBadge",
			Size: new UDim2(0, 0, 0, COIN_SIZE + SPACING.xs),
			AutomaticSize: Enum.AutomaticSize.X,
			BackgroundColor3: this.theme.colors.premium,
			BackgroundTransparency: 0.85,
			BorderSizePixel: 0,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: titleRow,
		});

		this.corners(scope, badge, SPACING.xs);

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingLeft: new UDim(0, SPACING.xs),
			PaddingRight: new UDim(0, SPACING.xs),
			Parent: badge,
		});

		const badgeLabel = this.text(scope, badge, "R$", "caption", "primary", 1, new UDim2(0, 0, 1, 0), true);
		badgeLabel.TextColor3 = this.theme.colors.premium;
		badgeLabel.TextYAlignment = Enum.TextYAlignment.Center;

		this.buildPreviewRow(scope, section, 2, robuxChestOdds());
		this.buildPrizeHeaderRow(scope, section, 3, "premium");

		const shelf = this.buildPrizeShelf(scope, section, 4);
		this.fillPrizeShelf(scope, shelf, ROBUX_CHEST_RARITIES, "premium");
		this.prizeShelves.push(shelf);

		this.buildPremiumPurchaseRow(scope, section, 5);

		return section;
	}

	/**
	 * The Premium buttons, plus the policy line beneath them.
	 *
	 * Two products rather than one with a quantity: Roblox charges per Developer Product, so the bundle has to exist as
	 * its own product. The button labels therefore name the count and the price, and the IDs come from config so a
	 * dashboard change is one constant.
	 */
	private buildPremiumPurchaseRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PremiumButtons",
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
			Padding: new UDim(0, SPACING.xs),
			Parent: row,
		});

		this.buildPremiumButton(scope, row, "Open 1", ROBUX_CHEST_PRICE_ROBUX, ROBUX_CHEST_PRODUCT_ID, 1, 1);

		this.buildPremiumButton(
			scope,
			row,
			`Open ${ROBUX_CHEST_BUNDLE_COUNT}`,
			ROBUX_CHEST_BUNDLE_PRICE_ROBUX,
			ROBUX_CHEST_BUNDLE_PRODUCT_ID,
			2,
			2,
		);

		this.policyNote = this.text(
			scope,
			parent,
			"",
			"caption",
			"secondary",
			order + 1,
			new UDim2(1, 0, 0, POLICY_NOTE_HEIGHT),
			false,
		);
		this.policyNote.TextXAlignment = Enum.TextXAlignment.Center;
		this.policyNote.TextYAlignment = Enum.TextYAlignment.Center;
		this.policyNote.Visible = false;
	}

	/** One Premium button: label on top, `price R$` beneath, disabled unless policy allows. */
	private buildPremiumButton(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		label: string,
		price: number,
		productId: number,
		order: number,
		slot: number,
	): void {
		const button = Fusion.New(
			scope,
			"TextButton",
		)({
			Name: `Premium${slot}`,
			Size: new UDim2(0.5, -SPACING.xs / 2, 1, 0),
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Text: "",
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: parent,
		});

		// The chrome, then the two lines go on its face rather than on the button: the face is a child of the button, so
		// anything parented to the button itself would be drawn underneath it.
		const chrome = applyChunkyChrome(button, {
			color: this.theme.colors.premium,
			shadowColor: shadowOf(this.theme.colors.premium),
			zIndex: STORE_Z_INDEX + 3,
		});

		attachPressFeedback(button);
		attachClickSound(button);

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: chrome.face,
		});

		const top = this.text(
			scope,
			chrome.face,
			label,
			"body1",
			"primary",
			1,
			new UDim2(1, 0, 0, PANEL_TYPE.body1.size),
			false,
		);
		top.TextColor3 = this.theme.colors.onAccent;
		top.TextXAlignment = Enum.TextXAlignment.Center;

		const priceLabel = this.text(
			scope,
			chrome.face,
			`${price} R$`,
			"body2",
			"primary",
			2,
			new UDim2(1, 0, 0, PANEL_TYPE.body2.size),
			false,
		);
		priceLabel.TextColor3 = this.theme.colors.onAccent;
		priceLabel.TextXAlignment = Enum.TextXAlignment.Center;

		// **The gate is checked inside the handler, not only by the styling.** A state that changed between mount and
		// click would otherwise let one prompt through on a stale decision.
		button.Activated.Connect(() => this.promptProduct(productId, label));

		// Starts disabled: `policy` is `"loading"` until the read returns, and loading is not permission.
		button.Active = false;
		dimChunkyChrome(button, true);
		this.premiumButtons.push(button);
	}

	/**
	 * Preview row: a compact chest square on the left, rarity statistics immediately beside it.
	 *
	 * **The square is a fixed 124 pixels, not a fraction.** The previous version gave the preview a share of the panel
	 * width, so it stretched into a wide empty box on a large screen — the "oversized empty container" the brief calls
	 * out. A fixed square beside a fixed-width statistics column keeps the two grouped.
	 */
	private buildPreviewRow(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		order: number,
		odds: Array<ChestOdd>,
	): void {
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
			BackgroundColor3: this.theme.paint.trough.color,
			BackgroundTransparency: this.theme.paint.trough.transparency,
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
			Color: this.theme.colors.border,
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
			Size: new UDim2(1, 0, 0, PANEL_TYPE.body2.size + SPACING.xs),
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
		value.TextColor3 = this.theme.colors.rarity[rarity];
	}

	/**
	 * `Prize Preview` on the left, the **`View All` control** on the right (item 155).
	 *
	 * ## What this row was, and why the placeholder is now a button
	 *
	 * It read *"a placeholder by design: the brief says it needs no functionality yet. It is a label rather than a button so
	 * nothing invites a click that would do nothing."* Both halves of that were right for a round that had nothing to open:
	 * a label cannot invite a click. What changed is that there is now somewhere to go, so the same reasoning points the
	 * other way - a control that looks pressable and is not is the state this round exists to leave behind.
	 *
	 * ## Why it is a `TextButton` with `applyChunkyChrome` rather than `buildChunkyButton`
	 *
	 * `buildChunkyButton` is the card builder: it takes a required `iconAssetId`, a title band and a badge, and its whole
	 * shape is a poster. This needs chrome and one word. `applyChunkyChrome` is the builder for exactly that case - it is
	 * what the inventory's ball cards and the fusion rows already use - and its `label` option exists because the button's
	 * own `Text` is covered by the face.
	 *
	 * ## Why the row is a nested list rather than two hand-placed children
	 *
	 * The left label takes the remaining width and the control keeps its own cell on the right, which is the same
	 * arrangement the header uses for the coin pill and the close button. Hand-placing an `AnchorPoint(1, 0.5)` control
	 * would also work and would be the first element in this sheet positioned by arithmetic instead of by a layout.
	 */
	private buildPrizeHeaderRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number, kind: ChestKind): void {
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

		const left = this.text(
			scope,
			row,
			"Prize Preview",
			"body2",
			"primary",
			1,
			new UDim2(1, -VIEW_ALL_WIDTH - SPACING.sm, 1, 0),
			false,
		);
		left.TextYAlignment = Enum.TextYAlignment.Center;

		// The right-hand cell. A list with `HorizontalAlignment.Right` is what lets the control keep its fixed width while the
		// row's spare pixels are absorbed here rather than by a magic number on the control's position.
		const right = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Actions",
			Size: new UDim2(0, VIEW_ALL_WIDTH, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: row,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			HorizontalAlignment: Enum.HorizontalAlignment.Right,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Parent: right,
		});

		const control = new Instance("TextButton");
		control.Name = "ViewAll";
		control.Size = UDim2.fromOffset(VIEW_ALL_WIDTH, PRIZE_HEADER_HEIGHT);
		control.BorderSizePixel = 0;
		control.AutoButtonColor = false;
		control.Text = "";
		control.LayoutOrder = 1;
		control.ZIndex = STORE_Z_INDEX + 3;
		control.Parent = right;

		// The face is `paint.trough`'s colour, not an accent: this is a secondary affordance beside a section that already
		// has two saturated buttons, and a third accent-tinted control in one column would compete with the things that
		// spend money. The shadow is derived from the same colour, so the three-value ladder holds without a second literal.
		applyChunkyChrome(control, {
			color: this.theme.paint.trough.color,
			shadowColor: shadowOf(this.theme.paint.trough.color),
			zIndex: STORE_Z_INDEX + 3,
			corner: SPACING.xs,
			label: {
				text: "View All",
				textSize: PANEL_TYPE.caption.size,
				color: this.theme.colors.textPrimary,
				// The face is at `+4` and its own outline is part of it, so the label needs `+5` to sit above both.
				zIndex: STORE_Z_INDEX + 5,
			},
		});

		attachPressFeedback(control);
		attachClickSound(control);
		control.Activated.Connect(() => this.showPrizeView(kind));
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
	 *
	 * **The duplication is also why a card is not a door (item 155).** Every card in a shelf opens the same expanded view,
	 * and there are two of each - so a click has to be idempotent about which copy it landed on. That is handled at the
	 * destination (`showPrizeView` returns immediately if that chest is already expanded), not here: making the second pass
	 * unclickable would be two kinds of card in one shelf, and the seam moves as the canvas scrolls anyway.
	 */
	private buildPrizeShelf(scope: Fusion.Scope<unknown>, parent: Instance, order: number): ScrollingFrame {
		const shelf = Fusion.New(
			scope,
			"ScrollingFrame",
		)({
			Name: "PrizeShelf",
			Size: new UDim2(1, 0, 0, SHELF_HEIGHT),
			BackgroundColor3: this.theme.paint.surface.color,
			BackgroundTransparency: this.theme.paint.surface.transparency,
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
	private fillPrizeShelf(
		scope: Fusion.Scope<unknown>,
		shelf: ScrollingFrame,
		rarities: ReadonlyArray<Rarity>,
		kind: ChestKind,
	): void {
		const cards = new Array<{ id: string; rarity: Rarity }>();

		for (const rarity of rarities) {
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
				this.buildPrizeCard(scope, shelf, card.id, card.rarity, order, kind);
				order++;
			}
		}
	}

	/**
	 * One prize card: a tinted art block with a ball silhouette, and the ball's name beneath.
	 *
	 * ## Why this is a button now (item 155)
	 *
	 * It was a `Frame`, because it had no job beyond being looked at. Every card in the shelf now opens the expanded prize
	 * view for the chest it belongs to, so it is a control and takes the chunky treatment the rest of the sheet's controls
	 * take: a transparent cell, a shadow plate, a face, a thick outline, and a rarity ring on a frame of its own.
	 *
	 * **The ring is the reason this cannot stay a `Frame` with a coloured `UIStroke`.** The old card's rarity border was a
	 * single hairline on the frame; once the card is chromed, that hairline and the chunky outline are two strokes on one
	 * object and the newer wins - item 118's failure, recorded on `addChunkyRing`.
	 *
	 * The tint is the *ring*, not the face: a shelf of saturated cards would out-shout the chest buttons below it, and the
	 * rarity is already carried by the art block inside.
	 */
	private buildPrizeCard(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		ballId: string,
		rarity: Rarity,
		order: number,
		kind: ChestKind,
	): void {
		const tint = this.theme.colors.rarity[rarity];

		const card = new Instance("TextButton");
		card.Name = `Prize_${ballId}_${order}`;
		// **The cell is the old card plus the chrome's depth.** The face is inset by `CHUNKY_CONTROL_DEPTH`, so a cell of the
		// old height would give the face six pixels less than the art block and the name needed - and the name, being drawn
		// above the art, would clip the art's bottom edge. Adding the depth back keeps every inner measurement as it was.
		card.Size = UDim2.fromOffset(
			CARD_WIDTH,
			CARD_ART + PANEL_TYPE.caption.lineHeight + SPACING.xs * 2 + CHUNKY_CONTROL_DEPTH,
		);
		card.BorderSizePixel = 0;
		card.AutoButtonColor = false;
		// The name is drawn on the face below, so the button itself carries nothing.
		card.Text = "";
		card.LayoutOrder = order;
		card.ZIndex = STORE_Z_INDEX + 2;
		card.Parent = parent;

		const chrome = applyChunkyChrome(card, {
			color: this.theme.paint.card.color,
			shadowColor: shadowOf(this.theme.paint.card.color),
			zIndex: STORE_Z_INDEX + 2,
			corner: SPACING.xs,
		});

		addChunkyRing(chrome.face, tint, HAIRLINE);

		const art = new Instance("Frame");
		art.Name = "Art";
		art.Size = new UDim2(1, -SPACING.xs * 2, 0, CARD_ART);
		art.Position = UDim2.fromOffset(SPACING.xs, SPACING.xs);
		art.BackgroundColor3 = tint;
		art.BackgroundTransparency = 0.84;
		art.BorderSizePixel = 0;
		art.ZIndex = STORE_Z_INDEX + 4;
		art.Parent = chrome.face;

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

		const name = new Instance("TextLabel");
		name.Name = "Name";
		name.AnchorPoint = new Vector2(0, 1);
		name.Position = UDim2.fromScale(0, 1);
		name.Size = new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight);
		name.BackgroundTransparency = 1;
		name.Font = FONT;
		name.TextSize = PANEL_TYPE.caption.size;
		name.TextColor3 = this.theme.colors.textPrimary;
		name.TextXAlignment = Enum.TextXAlignment.Center;
		name.TextYAlignment = Enum.TextYAlignment.Center;
		name.TextTruncate = Enum.TextTruncate.AtEnd;
		name.Text = displayName(ballId);
		// Above the art and the ball, because a tie in `ZIndex` is resolved by creation order - item 5.4 in the style guide.
		name.ZIndex = STORE_Z_INDEX + 6;
		name.Parent = chrome.face;

		outlineText(name);

		attachPressFeedback(card);
		attachClickSound(card);
		card.Activated.Connect(() => this.showPrizeView(kind));
	}

	// #region the expanded prize view (item 155)

	/**
	 * The expanded view: a second state of the store sheet, built once and shown on demand.
	 *
	 * ```
	 * PrizeView                       (Vertical list; hidden until something asks)
	 *   Back row                      (Back control, left)
	 *   Chest band                    (Horizontal: tinted CHEST block, name + tier odds)
	 *   Title band                    (Horizontal: "All Prizes", "<N> items")
	 *   Prize grid                    (ScrollingFrame + UIGridLayout, fixed height)
	 * ```
	 *
	 * ## What it deliberately does not have
	 *
	 * **No second header.** The title, the coin pill and the close button above this band are the store's, and they are
	 * the same objects in both states - so a player who is looking at the catalog still sees their balance and can still
	 * close the sheet. A copy of the header here would be a second place for `refreshCoins` to have to write.
	 *
	 * **No purchase buttons.** They live in the chest sections, which are hidden while this is showing. Duplicating them
	 * would mean a second call site for the same remotes, a second `busy` guard and a second policy gate - three places for
	 * one bug - so this view is read-only and the player backs out to buy. That is the one place this departs from the
	 * reference, which puts `Open 1`/`Open 10` in its footer.
	 *
	 * **No category row.** The store has one vertical hierarchy and a `Shop`/`Inventory` rail; the categories the reference
	 * shows were removed here on purpose and are not coming back inside a sub-view.
	 *
	 * ## Why one chest at a time
	 *
	 * Both chest sections have a `View All` and both shelves are clickable, so the view has two possible subjects and takes
	 * whichever was asked for. `showPrizeView` fills it from a `ChestSpec`, which is why nothing here branches on which
	 * chest it is.
	 */
	private buildPrizeView(scope: Fusion.Scope<unknown>, parent: Instance): void {
		const view = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PrizeView",
			Size: new UDim2(1, 0, 0, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			BackgroundTransparency: 1,
			// The same order as `Content`: exactly one of the two is ever visible, and a hidden child is not laid out at all,
			// so the tie cannot be observed. Sharing the slot is what keeps the status line below both of them.
			LayoutOrder: 3,
			ZIndex: STORE_Z_INDEX + 2,
			Visible: false,
			Parent: parent,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, BAND_GAP),
			Parent: view,
		});

		this.buildPrizeBackRow(scope, view, 1);
		this.buildPrizeChestBand(scope, view, 2);
		this.buildPrizeTitleBand(scope, view, 3);
		this.buildPrizeGrid(scope, view, 4);

		this.prizeView = view;
	}

	/**
	 * The `Back` control and nothing else, on its own row.
	 *
	 * **`Back` is section-level, not sheet-level.** The rail's `Shop`/`Inventory` switch is the store's navigation and is
	 * untouched; this returns to the chest sections the player came from, with both sections exactly as they were - the
	 * shelf scroll positions, the coin balance and the status line are all still live, because none of them were rebuilt.
	 */
	private buildPrizeBackRow(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "BackRow",
			Size: new UDim2(1, 0, 0, PRIZE_BACK_HEIGHT),
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
			HorizontalAlignment: Enum.HorizontalAlignment.Left,
			Parent: row,
		});

		const control = new Instance("TextButton");
		control.Name = "Back";
		control.Size = UDim2.fromOffset(PRIZE_BACK_WIDTH, PRIZE_BACK_HEIGHT);
		control.BorderSizePixel = 0;
		control.AutoButtonColor = false;
		control.Text = "";
		control.LayoutOrder = 1;
		control.ZIndex = STORE_Z_INDEX + 3;
		control.Parent = row;

		// The same face as `View All`, for the same reason: two navigation controls on one sheet should look like one control
		// in two positions, and neither should read as a purchase.
		applyChunkyChrome(control, {
			color: this.theme.paint.trough.color,
			shadowColor: shadowOf(this.theme.paint.trough.color),
			zIndex: STORE_Z_INDEX + 3,
			corner: SPACING.xs,
			label: {
				text: "<  Back",
				textSize: PANEL_TYPE.caption.size,
				color: this.theme.colors.textPrimary,
				zIndex: STORE_Z_INDEX + 5,
			},
		});

		attachPressFeedback(control);
		attachClickSound(control);
		control.Activated.Connect(() => this.backToChests());
	}

	/**
	 * The chest's identity, in one band.
	 *
	 * The reference puts this in a whole column - a large render, a name plate and a stacked odds table. This game has no
	 * chest art (item 58 established the tinted `CHEST` block as the placeholder and an invented `rbxassetid` is a broken
	 * image on every client), so the column collapses to a row: block, name, and the tier percentages on one line. The odds
	 * are here rather than only in the chest section because this is where the player is reading what the chest can give.
	 */
	private buildPrizeChestBand(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const band = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "ChestBand",
			Size: new UDim2(1, 0, 0, PRIZE_CHEST_BLOCK),
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
			Parent: band,
		});

		const block = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "ChestBlock",
			Size: UDim2.fromOffset(PRIZE_CHEST_BLOCK, PRIZE_CHEST_BLOCK),
			BackgroundColor3: this.theme.paint.trough.color,
			BackgroundTransparency: this.theme.paint.trough.transparency,
			BorderSizePixel: 0,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: band,
		});

		this.corners(scope, block, SPACING.sm);

		Fusion.New(
			scope,
			"UIStroke",
		)({
			Color: this.theme.colors.border,
			Thickness: HAIRLINE,
			ApplyStrokeMode: Enum.ApplyStrokeMode.Border,
			Parent: block,
		});

		const blockLabel = this.text(scope, block, "CHEST", "overline", "disabled", 1, UDim2.fromScale(1, 1), false);
		blockLabel.TextXAlignment = Enum.TextXAlignment.Center;
		blockLabel.TextYAlignment = Enum.TextYAlignment.Center;

		// The name and the odds, stacked in one cell so the band is one row high however long the odds line gets.
		const textColumn = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Identity",
			Size: new UDim2(1, -PRIZE_CHEST_BLOCK - SPACING.md, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: band,
		});

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Parent: textColumn,
		});

		this.prizeChestName = this.text(
			scope,
			textColumn,
			"",
			"h6",
			"primary",
			1,
			new UDim2(1, 0, 0, PANEL_TYPE.h6.lineHeight),
			false,
		);
		this.prizeChestName.TextYAlignment = Enum.TextYAlignment.Center;

		this.prizeOddsLabel = this.text(
			scope,
			textColumn,
			"",
			"caption",
			"secondary",
			2,
			new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight),
			false,
		);
		this.prizeOddsLabel.TextYAlignment = Enum.TextYAlignment.Center;

		this.prizeChestBlock = block;
	}

	/** `All Prizes` on the left, `<N> items` on the right. The count is derived from the pool, never written. */
	private buildPrizeTitleBand(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const band = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "AllPrizes",
			Size: new UDim2(1, 0, 0, PRIZE_TITLE_HEIGHT),
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
			Parent: band,
		});

		const title = this.text(scope, band, "All Prizes", "body1", "primary", 1, new UDim2(0, 0, 1, 0), true);
		title.TextYAlignment = Enum.TextYAlignment.Center;

		const spacer = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Spacer",
			Size: new UDim2(0, 0, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: 2,
			Parent: band,
		});

		Fusion.New(scope, "UIFlexItem")({ FlexMode: Enum.UIFlexMode.Fill, Parent: spacer });

		this.prizeCountLabel = this.text(scope, band, "", "caption", "secondary", 3, new UDim2(0, 0, 1, 0), true);
		this.prizeCountLabel.TextXAlignment = Enum.TextXAlignment.Right;
		this.prizeCountLabel.TextYAlignment = Enum.TextYAlignment.Center;
	}

	/**
	 * The scroll box the catalog lives in.
	 *
	 * ## Why the columns are not chosen
	 *
	 * `UIGridLayout` fills from its container's width, so the column count is a *consequence* of `PRIZE_CARD_WIDTH` and the
	 * sheet's width - the same decision item 50 made for the shelf and item 59 for the sheet. At the store's 880-pixel
	 * maximum the inner width is 856 pixels: eight 96-pixel cards plus their 4-pixel gaps is 804, so eight fit and the
	 * derived count is 8. A ninth would need a card narrower than the art block inside it reads well.
	 *
	 * ## Why the height is a number
	 *
	 * See `PRIZE_GRID_VIEWPORT_FRACTION`: the sheet measures its own content, so a self-sizing grid would grow the sheet past
	 * the viewport clamp instead of scrolling. `applyPrizeGridHeight` keeps the box inside the sheet's budget and re-applies
	 * it on a resize, because the sheet is built once and a window can change shape afterwards.
	 */
	private buildPrizeGrid(scope: Fusion.Scope<unknown>, parent: Instance, order: number): void {
		const grid = Fusion.New(
			scope,
			"ScrollingFrame",
		)({
			Name: "PrizeGrid",
			Size: new UDim2(1, 0, 0, PRIZE_GRID_MIN_HEIGHT),
			BackgroundColor3: this.theme.paint.surface.color,
			BackgroundTransparency: this.theme.paint.surface.transparency,
			BorderSizePixel: 0,
			ClipsDescendants: true,
			ScrollBarThickness: SPACING.xs,
			ScrollBarImageColor3: this.theme.colors.border,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			CanvasSize: UDim2.fromOffset(0, 0),
			AutomaticCanvasSize: Enum.AutomaticSize.Y,
			ElasticBehavior: Enum.ElasticBehavior.Never,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 2,
			Parent: parent,
		});

		this.corners(scope, grid, SPACING.sm);

		Fusion.New(
			scope,
			"UIGridLayout",
		)({
			CellSize: UDim2.fromOffset(PRIZE_CARD_WIDTH, PRIZE_CARD_HEIGHT),
			CellPadding: UDim2.fromOffset(SPACING.xs, SPACING.xs),
			SortOrder: Enum.SortOrder.LayoutOrder,
			FillDirectionMaxCells: 0,
			Parent: grid,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SPACING.xs),
			PaddingBottom: new UDim(0, SPACING.xs),
			PaddingLeft: new UDim(0, SPACING.xs),
			PaddingRight: new UDim(0, SPACING.xs),
			Parent: grid,
		});

		// The message that takes the grid's place when a chest has no pool. Inside the band rather than a fourth state of the
		// view, because "no cards" is still a catalog - it just has nothing in it, and a player should be told that rather
		// than shown an empty box.
		this.prizeEmpty = this.text(
			scope,
			parent,
			"",
			"caption",
			"disabled",
			order + 1,
			new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight),
			false,
		);
		this.prizeEmpty.TextXAlignment = Enum.TextXAlignment.Center;
		this.prizeEmpty.TextYAlignment = Enum.TextYAlignment.Center;
		this.prizeEmpty.Visible = false;

		this.prizeGrid = grid;
		this.applyPrizeGridHeight();
	}

	/** Sizes the grid from the viewport, bounded. Called at build and on every viewport change. */
	private applyPrizeGridHeight(): void {
		const grid = this.prizeGrid;
		if (grid === undefined) {
			return;
		}

		const camera = Workspace.CurrentCamera;
		const viewport = camera !== undefined ? camera.ViewportSize.Y : PRIZE_GRID_MIN_HEIGHT * 2;
		const height = math.clamp(
			viewport * PRIZE_GRID_VIEWPORT_FRACTION,
			PRIZE_GRID_MIN_HEIGHT,
			PRIZE_GRID_MAX_HEIGHT,
		);

		grid.Size = new UDim2(1, 0, 0, height);
	}

	/**
	 * Everything about a chest the view needs, in one value.
	 *
	 * The weights are carried with the odds because per-ball probability and the tier summary are the same table read two
	 * ways, and a view that derived one of them from a different source is how the two would come to disagree.
	 */
	private chestSpecOf(kind: ChestKind): ChestSpec {
		if (kind === "premium") {
			return {
				kind,
				title: "Premium Chest",
				rarities: ROBUX_CHEST_RARITIES,
				weights: robuxChestWeights(),
				odds: robuxChestOdds(),
			};
		}

		return {
			kind,
			title: "Coin Chest",
			rarities: RARITIES,
			weights: RARITY_WEIGHTS,
			odds: chestOdds(),
		};
	}

	/**
	 * One ball's chance of coming out of one roll, as a percentage of the chest.
	 *
	 * ## Why this is a derivation and not a table
	 *
	 * `chestOdds()` apportions `RARITY_WEIGHTS` into per-**tier** rows. Within a tier every ball is equally likely, so one
	 * ball's chance is its tier's share divided by how many balls that tier holds. Writing the ten numbers out would be a
	 * second table to update when `BALL_POOL` changes, and the first ball added after it drifted would print a wrong
	 * percentage on a card - the "looks right, is wrong" failure the odds module exists to avoid.
	 *
	 * `total` is the sum of the chest's own weights rather than 100: the coin chest's sum to 1000 and the paid one's do too,
	 * but nothing in the types makes that true, and dividing by the table's own total is correct either way.
	 */
	private perBallPercent(spec: ChestSpec, rarity: Rarity): number {
		let total = 0;
		for (const tier of RARITIES) {
			total += spec.weights[tier];
		}

		const pool = BALL_POOL[rarity];
		if (total <= 0 || pool.size() === 0) {
			return 0;
		}

		return ((spec.weights[rarity] / total) * 100) / pool.size();
	}

	/**
	 * A percentage for a card, at the store's own rounding.
	 *
	 * `chestOdds()` rounds to one decimal through largest-remainder apportionment, so `60` prints as `60%` and `4.5` as
	 * `4.5%`. This matches that scale - one decimal, with a whole number printing without a trailing `.0` - rather than
	 * inventing a second convention beside the odds line the chest section already shows.
	 */
	private formatPercent(value: number): string {
		const rounded = math.round(value * 10) / 10;
		return `${rounded}%`;
	}

	/**
	 * Shows the expanded view for one chest.
	 *
	 * ## Idempotent by construction
	 *
	 * Three things can call this for the same chest - the `View All` control, a shelf card in the first copy of the shelf,
	 * and the same card in the duplicated copy the auto-scroll wraps through - and a second call must not rebuild the grid
	 * or reset the scroll position the player put it at. The guard is one line: if that chest is already expanded, do
	 * nothing, so a click on either copy of a card is the same click.
	 *
	 * Comparing against `expandedChest` rather than a boolean is what makes the guard also correct for the day a card for a
	 * *different* chest is reachable from here: today both entry points live in the band this view hides, so a chest can only
	 * be changed by backing out first - but the comparison is already written for the alternative.
	 */
	private showPrizeView(kind: ChestKind): void {
		const view = this.prizeView;
		if (view === undefined || this.expandedChest === kind) {
			return;
		}

		this.expandedChest = kind;
		this.fillPrizeView(this.chestSpecOf(kind));

		if (this.storeContent !== undefined) {
			this.storeContent.Visible = false;
		}
		view.Visible = true;

		// The shelf's scroll position is reset while hidden: returning to the chest section should show it from the start
		// rather than wherever the two states happened to leave the canvas.
		for (const shelf of this.prizeShelves) {
			shelf.CanvasPosition = new Vector2(0, 0);
		}
	}

	/** Returns to the chest sections. Sheet-level state (balance, status, phase) is untouched because none of it was rebuilt. */
	private backToChests(): void {
		const view = this.prizeView;
		if (view === undefined || this.expandedChest === undefined) {
			return;
		}

		this.expandedChest = undefined;
		view.Visible = false;

		if (this.storeContent !== undefined) {
			this.storeContent.Visible = true;
		}
	}

	/** Drops the previous chest's cards and rebuilds from the spec. Progress bars and balances are not this method's business. */
	private fillPrizeView(spec: ChestSpec): void {
		for (const card of this.prizeCards) {
			card.Destroy();
		}
		this.prizeCards.clear();

		if (this.prizeChestName !== undefined) {
			this.prizeChestName.Text = spec.title;
		}

		// The tier summary, built from the same rows the chest section's stat column prints. The separator is a constant so
		// the line reads as one string rather than as three labels fighting for a row.
		if (this.prizeOddsLabel !== undefined) {
			const parts = new Array<string>();
			for (const row of spec.odds) {
				parts.push(`${tierName(row.rarity)} ${this.formatPercent(row.percent)}`);
			}
			this.prizeOddsLabel.Text = parts.join(ODDS_SEPARATOR);
		}

		if (this.prizeChestBlock !== undefined) {
			// The block is tinted per chest, so the paid one is not described by the coin chest's accent - the same
			// distinction the two sections' outlines make. Both the well and its hairline move, because a tinted hairline on
			// a neutral well is a 1-pixel difference nobody would see.
			const tint = spec.kind === "premium" ? this.theme.colors.premium : this.theme.colors.accent;
			this.prizeChestBlock.BackgroundColor3 = tint;
			this.prizeChestBlock.BackgroundTransparency = 0.85;

			const stroke = this.prizeChestBlock.FindFirstChildOfClass("UIStroke");
			if (stroke !== undefined) {
				stroke.Color = tint;
			}
		}

		const grid = this.prizeGrid;
		const empty = this.prizeEmpty;
		if (grid === undefined || empty === undefined) {
			return;
		}

		let order = 1;
		for (const rarity of spec.rarities) {
			for (const ballId of BALL_POOL[rarity]) {
				this.prizeCards.push(this.buildPrizeCatalogCard(grid, ballId, rarity, order, spec));
				order++;
			}
		}

		const count = this.prizeCards.size();
		if (this.prizeCountLabel !== undefined) {
			// Derived, so adding a ball to `BALL_POOL` changes this line and adds a card with no code change here.
			this.prizeCountLabel.Text = count === 1 ? "1 item" : `${count} items`;
		}

		// An empty pool is not a state `BALL_POOL` can be in today, but a grid of nothing is indistinguishable from a broken
		// grid - so the box hides and one line says why.
		grid.Visible = count > 0;
		empty.Visible = count === 0;
		empty.Text = count === 0 ? "This chest has no prizes configured." : "";
	}

	/**
	 * One card in the catalog: art, name, rarity ring, and that ball's own chance.
	 *
	 * A `GuiButton` with the chunky chrome rather than a flat `Frame`, because it is the same object as a shelf card and the
	 * style guide's rule is that a card is a control. Its `Activated` re-opens the view it is already in, which the guard in
	 * `showPrizeView` makes a no-op - the alternative was a card that looks pressable (depth, hover, click sound) and
	 * ignores the press, which is the state this round is removing from `View All`.
	 */
	private buildPrizeCatalogCard(
		parent: Instance,
		ballId: string,
		rarity: Rarity,
		order: number,
		spec: ChestSpec,
	): TextButton {
		const tint = this.theme.colors.rarity[rarity];

		const card = new Instance("TextButton");
		card.Name = `Catalog_${ballId}`;
		card.Size = UDim2.fromOffset(PRIZE_CARD_WIDTH, PRIZE_CARD_HEIGHT);
		card.BorderSizePixel = 0;
		card.AutoButtonColor = false;
		card.Text = "";
		card.LayoutOrder = order;
		card.ZIndex = STORE_Z_INDEX + 3;
		card.Parent = parent;

		const chrome = applyChunkyChrome(card, {
			color: this.theme.paint.card.color,
			shadowColor: shadowOf(this.theme.paint.card.color),
			zIndex: STORE_Z_INDEX + 3,
			corner: SPACING.xs,
		});

		// The rarity, on its own frame. A second `UIStroke` on the face would silently replace the chunky outline - the
		// failure `addChunkyRing` exists to prevent, and the reason both card builders in this file call it.
		addChunkyRing(chrome.face, tint, HAIRLINE);

		const art = new Instance("Frame");
		art.Name = "Art";
		art.Size = new UDim2(1, -SPACING.xs * 2, 0, PRIZE_CARD_ART);
		art.Position = UDim2.fromOffset(SPACING.xs, SPACING.xs);
		art.BackgroundColor3 = tint;
		art.BackgroundTransparency = 0.84;
		art.BorderSizePixel = 0;
		art.ZIndex = STORE_Z_INDEX + 5;
		art.Parent = chrome.face;

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
		ball.ZIndex = STORE_Z_INDEX + 6;
		ball.Parent = art;

		const ballCorner = new Instance("UICorner");
		ballCorner.CornerRadius = ROUND;
		ballCorner.Parent = ball;

		const name = new Instance("TextLabel");
		name.Name = "Name";
		name.AnchorPoint = new Vector2(0.5, 1);
		name.Position = new UDim2(0.5, 0, 1, -PANEL_TYPE.overline.lineHeight - SPACING.xs / 2);
		name.Size = new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight);
		name.BackgroundTransparency = 1;
		name.Font = FONT;
		name.TextSize = PANEL_TYPE.caption.size;
		name.TextColor3 = this.theme.colors.textPrimary;
		name.TextXAlignment = Enum.TextXAlignment.Center;
		name.TextYAlignment = Enum.TextYAlignment.Center;
		name.TextTruncate = Enum.TextTruncate.AtEnd;
		name.Text = displayName(ballId);
		name.ZIndex = STORE_Z_INDEX + 7;
		name.Parent = chrome.face;

		outlineText(name);

		// The probability, in the tier's own colour so the number and the ring agree about what kind of ball it is.
		const chance = new Instance("TextLabel");
		chance.Name = "Chance";
		chance.AnchorPoint = new Vector2(0.5, 1);
		chance.Position = UDim2.fromScale(0.5, 1);
		chance.Size = new UDim2(1, 0, 0, PANEL_TYPE.overline.lineHeight);
		chance.BackgroundTransparency = 1;
		chance.Font = FONT;
		chance.TextSize = PANEL_TYPE.overline.size;
		chance.TextColor3 = tint;
		chance.TextXAlignment = Enum.TextXAlignment.Center;
		chance.TextYAlignment = Enum.TextYAlignment.Center;
		chance.TextTruncate = Enum.TextTruncate.AtEnd;
		chance.Text = this.formatPercent(this.perBallPercent(spec, rarity));
		chance.ZIndex = STORE_Z_INDEX + 7;
		chance.Parent = chrome.face;

		outlineText(chance);

		attachPressFeedback(card);
		attachClickSound(card);
		card.Activated.Connect(() => this.showPrizeView(spec.kind));

		return card;
	}

	// #endregion

	/**
	 * Purchase buttons: `Open 1` and `Open MAX_BULK_OPEN`, equal width, side by side.
	 *
	 * ## Both buttons are one server call now
	 *
	 * `Open 10` used to be ten ordinary opens **queued on the client**, drained one per `ECONOMY_ACTION_COOLDOWN_MS`.
	 * That loop was the bug: the rate limiter refused presses the client had already counted, so ten presses bought nine
	 * chests, and ten saves in five seconds put the DataStore into its request queue. `EconomyService.openChestsBulk`
	 * replaces it — one call, one roll loop, one save, one reply — and the client's job here collapses to sending a count.
	 *
	 * `Open 1` sends `count = 1`, which the server routes to the single-chest verb so a one-chest purchase pays for
	 * nothing it cannot use. The client does not know or care which verb runs; both answer with the same shape.
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

		this.buildPurchaseButton(scope, row, "Open 1", chestBatchCost(1), 1, 1);
		this.buildPurchaseButton(scope, row, `Open ${MAX_BULK_OPEN}`, chestBatchCost(MAX_BULK_OPEN), 2, MAX_BULK_OPEN);
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
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Text: "",
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: parent,
		});

		const chrome = applyChunkyChrome(button, {
			color: this.theme.colors.accent,
			shadowColor: shadowOf(this.theme.colors.accent),
			zIndex: STORE_Z_INDEX + 3,
		});

		attachPressFeedback(button);
		attachClickSound(button);
		button.Activated.Connect(() => this.fireChest(count));

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
			Parent: chrome.face,
		});

		const top = this.text(
			scope,
			chrome.face,
			action,
			"body1",
			"primary",
			1,
			new UDim2(1, 0, 0, PANEL_TYPE.body1.size),
			false,
		);
		top.TextColor3 = this.theme.colors.onAccent;
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
			ZIndex: STORE_Z_INDEX + 5,
			Parent: chrome.face,
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
		amount.TextColor3 = this.theme.colors.onAccent;
		amount.TextYAlignment = Enum.TextYAlignment.Center;

		this.coinDot(scope, priceRow, COIN_SIZE, 2);

		this.chestButtons.push({ button, count, priceLabel: amount, actionLabel: top });
	}

	/**
	 * The coin: **the user's icon, at `COIN_SIZE` pixels** (item 154).
	 *
	 * ## What this replaced, and why the old reasoning is kept
	 *
	 * It was a `Frame` with a `UICorner` at `UDim.new(1, 0)` filled with `theme.colors.coin` — *"the yellow coin placeholder:
	 * a plain circle, because the tree ships no coin image"*. That was true until the designer uploaded one, and the
	 * placeholder is exactly what a placeholder is for: the two facts it encoded are worth keeping even though neither is
	 * live. The shape was a circle because a circle reads as money in every icon set, and the colour was `colors.coin`
	 * rather than a literal because "this is money" is a domain meaning (item 58).
	 *
	 * Both are now the asset's job. The **colour survives as a meaning but not as the coin's fill** — see
	 * `theme.colors.coin` — and the circle survives only as a memory.
	 *
	 * ## Why the `UICorner` is gone and no stroke replaced it
	 *
	 * An image is its own shape; a corner radius on an `ImageLabel` would clip a picture that already has an outline drawn
	 * into it. The **absence of a stroke is deliberate here and is the one place the three coin sites disagree**: this coin
	 * sits inside a saturated price pill where an added edge was removed on purpose (item 58), and an icon carries its own.
	 * The payout panel and the reward toast keep theirs, for the reason stated at each of them.
	 *
	 * ## `fromOffset`, not `fromScale`
	 *
	 * `COIN_SIZE` is a pixel count and this is a screen-space UI element inside a `UIListLayout`; `fromScale` would make it
	 * a share of its row and the coin would change size with the pill. The same class of unit error item 145 found in the
	 * sprite's billboard — the wrong `UDim2` component — one coordinate system over.
	 */
	private coinDot(scope: Fusion.Scope<unknown>, parent: Instance, size: number, order: number): ImageLabel {
		return Fusion.New(
			scope,
			"ImageLabel",
		)({
			Name: "Coin",
			Size: UDim2.fromOffset(size, size),
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			Image: coinIconUri(),
			ScaleType: Enum.ScaleType.Fit,
			ImageTransparency: 0,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 5,
			Parent: parent,
		});
	}

	// #endregion

	// #region the fusion section

	// #endregion

	// #region builders

	/**
	 * A plain `TextLabel`, built directly rather than through big-ui.
	 *
	 * See the class comment: big-ui's `Text` takes its ink from whatever palette the HUD pushed, not from the sheet's own
	 * direction, and it never reaches this one - so every label it produced on the old paper sheet rendered in the HUD's
	 * white and disappeared. The colour clash is gone now that the sheet is dark, but the hydration problem is not: this
	 * builder sets font, size and colour from `scale.ts` and the sheet's `Theme` with nothing in between, and `autoWidth`
	 * says the caller wants the label to shrink-wrap, which a fixed-size label cannot do.
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
			TextSize: PANEL_TYPE[variant].size,
			TextColor3:
				colour === "primary"
					? this.theme.colors.textPrimary
					: colour === "secondary"
						? this.theme.colors.textSecondary
						: this.theme.colors.textDisabled,
			TextXAlignment: Enum.TextXAlignment.Left,
			TextYAlignment: Enum.TextYAlignment.Top,
			TextTruncate: Enum.TextTruncate.AtEnd,
			Text: content,
			LayoutOrder: order,
			// `+5`, not `+3`: the chunky chrome puts a face at `button.ZIndex + 1`, so a label at the old order would be drawn
			// underneath it. Every button on the sheet is at `+3`, which makes this the first order that is reliably above one.
			ZIndex: STORE_Z_INDEX + 5,
			Parent: parent,
		});

		// Every label the panel builds through this factory gets the black glyph outline, so the sheets read the same on any
		// surface they are painted on. The handful of labels built by hand are outlined at their own creation sites.
		outlineText(label);

		return label;
	}

	/** Adds a `UICorner`, because Fusion's builder takes one instance at a time. */
	private corners(scope: Fusion.Scope<unknown>, parent: Instance, radius: number, udim?: UDim): void {
		Fusion.New(scope, "UICorner")({ CornerRadius: udim ?? new UDim(0, radius), Parent: parent });
	}

	// #endregion

	// #region behaviour

	/**
	 * Scrolls every prize shelf continuously, and nothing else.
	 *
	 * One `RenderStepped` connection for the controller's lifetime, gated on the store being open — a closed store costs
	 * one boolean test per frame. The loop wraps at **half** the canvas width because `fillPrizeShelf` lays the prize list
	 * out twice, so the second half is a pixel-identical copy of the first and the jump back to zero is invisible.
	 *
	 * `CanvasPosition` is a `Vector2`; assigning a property on it in place does nothing, so a new one is constructed.
	 *
	 * **Every shelf, not just the first.** Both chests preview their prizes the same way, and a shelf that only scrolls
	 * when it happens to be the coin chest is the kind of asymmetry a player reads as "this one is broken" rather than as
	 * a deliberate difference. Each shelf keeps its own `CanvasPosition`, so they scroll independently.
	 */
	private drivePrizeShelf(): void {
		RunService.RenderStepped.Connect((dt) => {
			if (this.open !== "shop") {
				return;
			}

			// **Nothing to scroll while the catalog is showing (item 155).** The shelves are children of the band the expanded
			// view hides, so they are off screen - and their `Visible` property is still `true`, because hiding an ancestor does
			// not write it. Two shelf loops running behind a hidden band is not a bug, but it is work for nothing, and a reader
			// who sees the check will know that.
			if (this.expandedChest !== undefined) {
				return;
			}

			for (const shelf of this.prizeShelves) {
				if (!shelf.Visible) {
					continue;
				}

				const half = shelf.AbsoluteCanvasSize.X / 2;
				if (half <= shelf.AbsoluteSize.X) {
					// Nothing overflows: two copies fit inside the viewport, so there is no seam to hide and nothing to
					// scroll. Move to the start so a resized window does not leave it parked mid-canvas.
					shelf.CanvasPosition = new Vector2(0, 0);
					continue;
				}

				let x = shelf.CanvasPosition.X + SHELF_SCROLL_SPEED * dt;
				if (x >= half) {
					x -= half;
				}

				shelf.CanvasPosition = new Vector2(x, 0);
			}
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

		// Affordability is a function of the balance, so the buttons are refreshed wherever the balance is.
		this.refreshChestButtons();

		if (typeIs(coins, "number")) {
			label.Text = tostring(coins);
			label.TextColor3 = this.theme.colors.textPrimary;
			return;
		}

		// Three situations share "no number": still loading, locked elsewhere, never loaded. Naming them is the
		// difference between a store that looks broken and one that says why it cannot act.
		label.Text = state === "readonly" ? "read-only" : state === "loading" ? "..." : "0";
		label.TextColor3 = this.theme.colors.textSecondary;
	}

	/**
	 * Rebuilds both of the inventory's lists from the `OwnedBalls` attribute.
	 *
	 * One reader for two tabs. `ownedBallsFrom` is the only source, so the `Balls` grid and the `Fusion` list cannot
	 * disagree about what the player owns — and neither of them can reach `BALL_POOL`, which is what would turn the
	 * inventory into a second store listing balls the player does not have.
	 *
	 * The two views keep separate selections, so both are rebuilt from the same read but resolve their own highlight.
	 */
	private refreshOwned(): void {
		const owned = ownedBallsFrom(this.ownedAttribute());

		for (const card of this.ballsCards) {
			card.Destroy();
		}
		this.ballsCards.clear();

		for (const row of this.fusionRows) {
			row.Destroy();
		}
		this.fusionRows.clear();

		// An inspected ball that has been spent stops being inspected, and one that was never chosen falls back to the
		// rarest owned ball: the detail pane is "what do I have", so it opens showing something rather than nothing.
		if (findOwned(owned, this.inspectBallId) === undefined) {
			this.inspectBallId = owned.size() > 0 ? owned[0].id : undefined;
		}

		// The fusion material is **not** defaulted. Choosing it is an intent to spend two, so opening the tab must not
		// arrive with one already picked that the player never clicked.
		if (findOwned(owned, this.fusionMaterialId) === undefined) {
			this.fusionMaterialId = undefined;
		}

		const grid = this.ballsGrid;
		if (grid !== undefined) {
			let order = 1;
			for (const ball of owned) {
				this.ballsCards.push(this.buildBallCard(grid, ball, order));
				order++;
			}
		}

		const list = this.fusionList;
		if (list !== undefined) {
			let order = 1;
			for (const ball of owned) {
				this.fusionRows.push(this.buildFusionRow(list, ball, order));
				order++;
			}
		}

		this.refreshDetailPanel();
		this.refreshFusionPanel();
	}

	/** One ball in the `Balls` grid. Clicking inspects it; it does not choose it for fusion. */
	private buildBallCard(parent: Instance, ball: OwnedBall, order: number): TextButton {
		const tint = this.theme.colors.rarity[ball.rarity];
		const selected = ball.id === this.inspectBallId;
		const artHeight = INVENTORY_CARD_HEIGHT - PANEL_TYPE.caption.lineHeight - SPACING.xs * 2;

		const card = new Instance("TextButton");
		card.Name = `Ball_${ball.id}`;
		card.Size = UDim2.fromOffset(INVENTORY_CARD_WIDTH, INVENTORY_CARD_HEIGHT);
		card.BorderSizePixel = 0;
		card.AutoButtonColor = false;
		// The name is drawn on the chrome's face below, so the button itself carries nothing.
		card.Text = "";
		card.LayoutOrder = order;
		card.ZIndex = STORE_Z_INDEX + 3;
		card.Parent = parent;

		// **A ball card is clickable, so it gets the depth.** The face is the literal `card` surface colour, the shadow a
		// darker shade of it, and the name is a label pinned to the bottom of the face ? the same place it used to be
		// drawn by the button's own `Text`.
		const cardChrome = applyChunkyChrome(card, {
			color: selected ? this.theme.colors.accent : this.theme.paint.card.color,
			shadowColor: shadowOf(selected ? this.theme.colors.accent : this.theme.paint.card.color),
			zIndex: STORE_Z_INDEX + 3,
			corner: SPACING.xs,
		});

		const cardName = new Instance("TextLabel");
		cardName.Name = "Name";
		cardName.AnchorPoint = new Vector2(0, 1);
		cardName.Position = UDim2.fromScale(0, 1);
		// **A real height, not `(1, 0)`.** A zero-height label clips its own glyphs, so the name rendered as nothing at all -
		// the caption's line height is exactly the room the text needs.
		cardName.Size = new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight);
		cardName.BackgroundTransparency = 1;
		cardName.Font = FONT;
		cardName.TextSize = PANEL_TYPE.caption.size;
		cardName.TextColor3 = selected ? this.theme.colors.onAccent : this.theme.colors.textPrimary;
		cardName.TextXAlignment = Enum.TextXAlignment.Center;
		cardName.TextYAlignment = Enum.TextYAlignment.Bottom;
		cardName.TextTruncate = Enum.TextTruncate.AtEnd;
		cardName.Text = displayName(ball.id);
		// **Above the art block and the count**, not level with them: the art is drawn over the face and would otherwise
		// cover the name, and a tie in `ZIndex` is resolved by creation order - which is exactly the kind of thing that
		// looks like "the text disappeared" on one card and not another.
		cardName.ZIndex = STORE_Z_INDEX + 8;
		cardName.Parent = cardChrome.face;

		outlineText(cardName);

		// **The rarity tint is a ring on its own frame, not a second stroke on the face.** Roblox applies one `UIStroke` per
		// GuiObject and the newer one wins, so putting the tint on the face replaced the chunky black outline with a hairline
		// in the ball's rarity colour - every card's border changed colour and the depth was gone. `addChunkyRing` gives the
		// tint an object of its own so both are visible.
		addChunkyRing(cardChrome.face, tint, selected ? 2 : HAIRLINE);

		const art = new Instance("Frame");
		art.Name = "Art";
		art.Size = new UDim2(1, -SPACING.xs * 2, 0, artHeight);
		art.Position = UDim2.fromOffset(SPACING.xs, SPACING.xs);
		art.BackgroundColor3 = tint;
		art.BackgroundTransparency = selected ? 0.72 : 0.84;
		art.BorderSizePixel = 0;
		art.ZIndex = STORE_Z_INDEX + 5;
		art.Parent = cardChrome.face;

		const artCorner = new Instance("UICorner");
		artCorner.CornerRadius = new UDim(0, SPACING.xs);
		artCorner.Parent = art;

		const pip = new Instance("Frame");
		pip.Name = "Ball";
		pip.AnchorPoint = new Vector2(CENTRE, CENTRE);
		pip.Position = UDim2.fromScale(CENTRE, CENTRE);
		pip.Size = UDim2.fromOffset(SWATCH, SWATCH);
		pip.BackgroundColor3 = tint;
		pip.BorderSizePixel = 0;
		pip.ZIndex = STORE_Z_INDEX + 6;
		pip.Parent = art;

		const pipCorner = new Instance("UICorner");
		pipCorner.CornerRadius = ROUND;
		pipCorner.Parent = pip;

		const countLabel = new Instance("TextLabel");
		countLabel.Name = "Count";
		countLabel.AnchorPoint = new Vector2(1, 0);
		countLabel.Position = UDim2.fromScale(1, 0);
		countLabel.Size = UDim2.fromOffset(SPACING.xl, SPACING.lg);
		countLabel.BackgroundTransparency = 1;
		countLabel.Font = FONT;
		countLabel.TextSize = PANEL_TYPE.caption.size;
		countLabel.TextColor3 = this.theme.colors.textPrimary;
		countLabel.TextXAlignment = Enum.TextXAlignment.Right;
		countLabel.Text = `x${ball.count}`;
		countLabel.ZIndex = STORE_Z_INDEX + 7;
		countLabel.Parent = art;

		outlineText(countLabel);

		attachPressFeedback(card);
		attachClickSound(card);
		card.Activated.Connect(() => {
			this.inspectBallId = ball.id;
			this.refreshOwned();
		});

		return card;
	}

	/**
	 * One material in the `Fusion` list.
	 *
	 * A row rather than a card because this tab asks a different question — "which of these am I spending" is one
	 * choice followed by one action, and a list leaves room for the count and the resulting tier beside the name.
	 */
	private buildFusionRow(parent: Instance, ball: OwnedBall, order: number): TextButton {
		const tint = this.theme.colors.rarity[ball.rarity];
		const selected = ball.id === this.fusionMaterialId;
		const rule = FUSION_TABLE[ball.rarity];

		const row = new Instance("TextButton");
		row.Name = `Material_${ball.id}`;
		row.Size = new UDim2(1, 0, 0, FUSION_ROW_HEIGHT);
		row.BorderSizePixel = 0;
		row.AutoButtonColor = false;
		row.Text = "";
		row.LayoutOrder = order;
		row.ZIndex = STORE_Z_INDEX + 3;
		row.Parent = parent;

		// A material row is a button too, so it gets the depth. As on the ball card, the rarity tint moves from a border
		// on the button to a thin inner ring on the face, which is the only layer of the two that is visible.
		const rowChrome = applyChunkyChrome(row, {
			color: selected ? this.theme.colors.accent : this.theme.paint.card.color,
			shadowColor: shadowOf(selected ? this.theme.colors.accent : this.theme.paint.card.color),
			zIndex: STORE_Z_INDEX + 3,
			corner: SPACING.xs,
		});

		addChunkyRing(rowChrome.face, tint, selected ? 2 : HAIRLINE);

		const pip = new Instance("Frame");
		pip.Name = "Ball";
		pip.AnchorPoint = new Vector2(0, CENTRE);
		pip.Position = UDim2.fromScale(0, 0.5);
		pip.Size = UDim2.fromOffset(SWATCH - SPACING.xs, SWATCH - SPACING.xs);
		pip.BackgroundColor3 = tint;
		pip.BorderSizePixel = 0;
		pip.ZIndex = STORE_Z_INDEX + 5;
		pip.Parent = rowChrome.face;

		const pipCorner = new Instance("UICorner");
		pipCorner.CornerRadius = ROUND;
		pipCorner.Parent = pip;

		const nameLabel = new Instance("TextLabel");
		nameLabel.Name = "Name";
		nameLabel.Position = UDim2.fromOffset(SWATCH + SPACING.xs, 0);
		nameLabel.Size = new UDim2(1, -(SWATCH + SPACING.xl), 1, 0);
		nameLabel.BackgroundTransparency = 1;
		nameLabel.Font = FONT;
		nameLabel.TextSize = PANEL_TYPE.body2.size;
		nameLabel.TextColor3 = selected ? this.theme.colors.onAccent : this.theme.colors.textPrimary;
		nameLabel.TextXAlignment = Enum.TextXAlignment.Left;
		nameLabel.TextTruncate = Enum.TextTruncate.AtEnd;
		nameLabel.Text = rule === undefined ? `${displayName(ball.id)} (top tier)` : displayName(ball.id);
		nameLabel.ZIndex = STORE_Z_INDEX + 5;
		nameLabel.Parent = rowChrome.face;

		outlineText(nameLabel);

		const countLabel = new Instance("TextLabel");
		countLabel.Name = "Count";
		countLabel.AnchorPoint = new Vector2(1, 0.5);
		countLabel.Position = UDim2.fromScale(1, 0.5);
		countLabel.Size = UDim2.fromOffset(SPACING.xl, FUSION_ROW_HEIGHT);
		countLabel.BackgroundTransparency = 1;
		countLabel.Font = FONT;
		countLabel.TextSize = PANEL_TYPE.caption.size;
		countLabel.TextColor3 = selected ? this.theme.colors.onAccent : this.theme.colors.textSecondary;
		countLabel.TextXAlignment = Enum.TextXAlignment.Right;
		countLabel.Text = `x${ball.count}`;
		countLabel.ZIndex = STORE_Z_INDEX + 5;
		countLabel.Parent = rowChrome.face;

		outlineText(countLabel);

		attachPressFeedback(row);
		attachClickSound(row);
		row.Activated.Connect(() => {
			this.fusionMaterialId = ball.id;
			this.refreshOwned();
		});

		return row;
	}

	/** The `Balls` tab's detail pane, from whatever is currently inspected. */
	private refreshDetailPanel(): void {
		const label = this.detailName;
		if (label === undefined) {
			return;
		}

		const ball = this.ownedBall(this.inspectBallId);
		if (ball === undefined) {
			if (this.detailBall !== undefined) {
				this.detailBall.BackgroundColor3 = this.theme.colors.textDisabled;
			}

			label.Text = "Nothing selected";
			label.TextColor3 = this.theme.colors.textSecondary;

			if (this.detailRarity !== undefined) {
				this.detailRarity.Text = "";
			}

			if (this.detailCount !== undefined) {
				this.detailCount.Text = "";
			}

			if (this.detailHint !== undefined) {
				this.detailHint.Text = INVENTORY_EMPTY;
			}

			return;
		}

		const tint = this.theme.colors.rarity[ball.rarity];

		if (this.detailBall !== undefined) {
			this.detailBall.BackgroundColor3 = tint;
		}

		label.Text = displayName(ball.id);
		label.TextColor3 = this.theme.colors.textPrimary;

		if (this.detailRarity !== undefined) {
			this.detailRarity.Text = tierName(ball.rarity);
			this.detailRarity.TextColor3 = tint;
		}

		if (this.detailCount !== undefined) {
			this.detailCount.Text = `Owned: ${ball.count}`;
			this.detailCount.TextColor3 = this.theme.colors.textSecondary;
		}

		if (this.detailHint !== undefined) {
			this.detailHint.Text = fusionHint(ball);
			this.detailHint.TextColor3 = this.theme.colors.textSecondary;
		}
	}

	/** The `Fusion` tab's facts pane: the chosen material, what it becomes, and whether the button may act. */
	/**
	 * Sets the fuse button's caption and its dimming, on the label rather than on the button.
	 *
	 * **One place instead of six.** The chrome makes the button a transparent hit area, so `button.Text` and
	 * `button.TextTransparency` no longer draw anything; both now live on the label the chrome built. Six scattered rewrites
	 * would each have to remember that, and the one that forgot would silently show a stale caption.
	 */
	private setFusionCaption(text: string, transparency: number): void {
		const label = this.fusionLabel;
		if (label === undefined) {
			return;
		}

		label.Text = text;
		label.TextTransparency = transparency;
	}

	private refreshFusionPanel(): void {
		const button = this.fusionButton;
		if (button === undefined) {
			return;
		}

		const ball = this.ownedBall(this.fusionMaterialId);
		if (ball === undefined) {
			if (this.fusionMaterialLabel !== undefined) {
				this.fusionMaterialLabel.Text = "Select a ball";
				this.fusionMaterialLabel.TextColor3 = this.theme.colors.textSecondary;
			}

			if (this.fusionOddsLabel !== undefined) {
				// The empty case is said here rather than in the scroller: a leftover label inside a `UIListLayout` is a
				// list item, so it would be pushed into the flow instead of sitting where it was placed.
				this.fusionOddsLabel.Text =
					ownedBallsFrom(this.ownedAttribute()).size() === 0
						? INVENTORY_FUSION_EMPTY
						: `Fusing costs ${FUSION_INPUT_COUNT} of one ball, win or lose.`;
				this.fusionOddsLabel.TextColor3 = this.theme.colors.textSecondary;
			}

			this.setFusionCaption("Select a ball", 0.45);
			button.Active = false;
			return;
		}

		const tint = this.theme.colors.rarity[ball.rarity];
		const rule = FUSION_TABLE[ball.rarity];

		if (this.fusionMaterialLabel !== undefined) {
			this.fusionMaterialLabel.Text = `${displayName(ball.id)} x${ball.count}`;
			this.fusionMaterialLabel.TextColor3 = tint;
		}

		if (this.fusionOddsLabel !== undefined) {
			if (rule === undefined) {
				this.fusionOddsLabel.Text = "Legendary is the top tier. Nothing is above it.";
				this.fusionOddsLabel.TextColor3 = this.theme.colors.textSecondary;
			} else {
				this.fusionOddsLabel.Text = `One ${tierName(rule.nextRarity)} on a ${rule.successPercent}% roll. Both are spent either way.`;
				this.fusionOddsLabel.TextColor3 = this.theme.colors.textSecondary;
			}
		}

		if (ball.count < FUSION_INPUT_COUNT) {
			this.setFusionCaption(`Need ${FUSION_INPUT_COUNT}: you have ${ball.count}`, 0.45);
			button.Active = false;
			return;
		}

		if (rule === undefined) {
			this.setFusionCaption("Cannot fuse", 0.45);
			button.Active = false;
			return;
		}

		this.setFusionCaption(`Fuse ${FUSION_INPUT_COUNT} into ${tierName(rule.nextRarity)}`, this.busy ? 0.45 : 0);
		button.Active = !this.busy;
	}

	/**
	 * One ball from the ledger, or `undefined`.
	 *
	 * Reads the attribute rather than a cached list: the cache would be a second copy of the profile that a missed
	 * attribute write could leave stale, and this runs only on a tab switch or an attribute change.
	 */
	private ownedBall(id: string | undefined): OwnedBall | undefined {
		return findOwned(ownedBallsFrom(this.ownedAttribute()), id);
	}

	/**
	 * Asks the server for `count` chests in **one** call, and guards against a second press until it answers.
	 *
	 * ## What this replaced, and why
	 *
	 * The previous version fired `count` separate `FireServer` calls 500 ms apart and tracked a queue of pending opens.
	 * Both are gone. The loop's failures are documented on `EconomyService.openChestsBulk`; from this side the important
	 * one is that the client decremented its counter per press *fired*, not per chest *granted*, so a refusal was
	 * indistinguishable from a purchase and the queue happily paid for nine chests out of ten presses.
	 *
	 * ## Why affordability is checked here as well as on the server
	 *
	 * The server is the authority and refuses a batch it cannot be paid for. This check exists so the player is not
	 * offered the chance to ask: a press the balance cannot cover is answered in words, immediately, without a round
	 * trip. It cannot be the only check, because a client is not trusted ? and it is not the only check, because
	 * `openChestsBulk` re-validates and re-reads the balance before it rolls anything.
	 *
	 * ## Why the guard is released by the reply and not by a timer
	 *
	 * A bulk call does ten rolls and one save, which takes longer than one chest and varies with the store's health. A
	 * timer short enough to feel responsive would release the guard before the reply and allow a second call to overlap
	 * the first ? the exact interleaving whose stale revert produced the confusing balance in the 14:47 log. So the reply
	 * releases it, and a watchdog releases it only if the reply never comes.
	 */
	private fireChest(count: number): void {
		if (this.busy) {
			return;
		}

		const remote = this.chestRemote;
		if (remote === undefined) {
			this.setStatus("The server is not accepting chests.");
			return;
		}

		const coins = this.coinsAttribute();
		if (coins !== undefined && !canAffordChests(coins, count)) {
			this.setStatus(this.shortfallText(count, coins));
			return;
		}

		this.chestCallId += 1;
		const callId = this.chestCallId;

		this.busy = true;
		this.refreshChestButtons();
		remote.FireServer(count);

		// **The watchdog is not the normal path.** `PromptProductPurchase` taught this file that a reply is not
		// guaranteed; here a missing reply would latch `busy` forever and leave the store dead until rejoin. The id check
		// is what stops a late watchdog from a completed call clearing the guard on a later one.
		task.delay(BULK_REPLY_TIMEOUT_SECONDS, () => {
			if (this.chestCallId !== callId || !this.busy) {
				return;
			}

			this.busy = false;
			this.refreshChestButtons();
			this.setStatus("The server did not answer. Your coins have not been checked ? reopen the store to retry.");
		});
	}

	/**
	 * Rewrites both purchase buttons for the current balance.
	 *
	 * A disabled button with no explanation is the thing this is here to prevent: the price line becomes `have/price`
	 * (`500/1000`) so the reason is on the control the player is looking at, and the whole button dims so it does not
	 * read as pressable. `NaN` or a missing balance reports "cannot afford", which is the safe direction ? the server
	 * checks again anyway.
	 */
	private refreshChestButtons(): void {
		const coins = this.coinsAttribute();

		for (const entry of this.chestButtons) {
			const price = chestBatchCost(entry.count);
			const known = coins !== undefined;
			const affordable = known && canAffordChests(coins, entry.count);
			const enabled = affordable && !this.busy;

			entry.button.Active = enabled;
			entry.priceLabel.Text = affordable || !known ? tostring(price) : `${coins}/${price}`;

			// **The wash goes through the chrome, exactly as `applyPolicy` does for the Premium buttons.**
			//
			// This block used to write `entry.button.BackgroundTransparency = enabled ? 0 : DISABLED_WASH`, and that one line
			// is the "pointy white box": `applyChunkyChrome` makes the button a transparent hit area and draws the face and
			// shadow as its children, so setting a transparency of `0` back onto the button paints **Roblox's default light
			// grey** behind both plates. The plates cover the middle; what it shows through is the corners, because a rounded
			// shadow does not cover its own bounding box - pale wedges at every corner of every chest button.
			//
			// `dimChunkyChrome` re-washes the face and its labels instead - the only two properties that actually draw - and it
			// is the same call the Premium buttons use, so all six buttons dim identically instead of two of them using this
			// file's own pair of constants.
			dimChunkyChrome(entry.button, !enabled);
		}
	}

	/** The balance, or `undefined` while it is unknown ? loading, read-only, or never published. */
	private coinsAttribute(): number | undefined {
		const coins = this.player.GetAttribute(PLAYER_COINS_ATTRIBUTE);
		return typeIs(coins, "number") ? coins : undefined;
	}

	/** `Not enough coins ? 10 chests cost 1000. You have 500.` One line, both numbers, no arithmetic for the player. */
	private shortfallText(count: number, coins: number): string {
		if (count === 1) {
			return `Not enough coins ? a chest costs ${COIN_CHEST_COST}. You have ${coins}.`;
		}

		return `Not enough coins ? ${count} chests cost ${chestBatchCost(count)}. You have ${coins}.`;
	}

	private ownedAttribute(): string {
		const encoded = this.player.GetAttribute(PLAYER_OWNED_BALLS_ATTRIBUTE);
		return typeIs(encoded, "string") ? encoded : "";
	}

	/**
	 * Spends the chosen material on one server-validated fusion.
	 *
	 * The guard here suppresses flicker inside one cooldown; it is not the authority. The server re-reads the profile and
	 * re-checks the count, so a client that fires twice is refused rather than double-spending, and nothing about the
	 * outcome is predicted locally.
	 */
	private pressFusion(): void {
		if (this.busy) {
			return;
		}

		const ballId = this.fusionMaterialId;
		const remote = this.fusionRemote;
		if (ballId === undefined || remote === undefined) {
			return;
		}

		this.busy = true;
		this.refreshFusionPanel();
		remote.FireServer(ballId);

		task.delay(ECONOMY_ACTION_COOLDOWN_MS / 1000, () => {
			this.busy = false;
			this.refreshOwned();
		});
	}

	private onChestResult(result: unknown): void {
		const reply = result as ChestResult | undefined;
		if (reply === undefined) {
			return;
		}

		// **The reply is what releases the guard.** Reaching here means the call this press started has been answered,
		// whatever the answer was, so the next press is a new action rather than an overlap.
		this.busy = false;

		if (reply.ok) {
			const names = new Array<string>();
			for (const ballId of reply.balls) {
				names.push(displayName(ballId));
			}

			// A bulk open names everything it granted, in roll order. There is no partial result to describe: a batch
			// either lands whole or grants nothing, so the sentence never has to hedge.
			this.setStatus(
				names.size() === 1 ? `You got ${names[0]}.` : `You got ${names.join(", ")}. (${names.size()} balls)`,
			);
		} else {
			this.setStatus(this.reasonText(reply.reason));
		}

		this.refreshCoins();
		this.refreshOwned();
		this.refreshChestButtons();
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

		if (reason === "empty-pool") {
			return "That tier has no balls configured. Nothing was charged.";
		}

		// The bulk count's validation codes. Distinct lines because they mean different things: a malformed request is this
		// build's bug, while a count above the cap is a client asking for more than the store offers.
		if (reason === "above-cap" || reason === "not-positive") {
			return `You can open between 1 and ${MAX_BULK_OPEN} chests at a time.`;
		}

		if (reason === "not-a-number" || reason === "nan" || reason === "infinite" || reason === "not-an-integer") {
			return "That was not a valid number of chests.";
		}

		return "That did not work. Try again.";
	}

	/** Writes one line into whichever panel is open, so a reply never lands in the other panel's hidden footer. */
	private setStatus(text: string): void {
		const label = this.open === "inventory" ? this.inventoryStatus : this.statusLabel;
		if (label !== undefined) {
			label.Text = text;
		} else {
			print(`[Shop] ${text}`);
		}
	}

	// #endregion

	// #region the inventory

	/**
	 * The inventory sheet: header, `Balls`/`Fusion` tabs, and a collection-beside-detail row.
	 *
	 * ## Why this is not a second controller
	 *
	 * "Which panel is open" is one fact with three values — `shop`, `inventory`, `none` — and **both rail tabs write to
	 * it**. A separate `InventoryController` would have to share that fact, so each controller would subscribe to the
	 * other's state to know whether to hide itself and the exclusivity rule would stop being true by construction. That is
	 * the argument item 50 used to put both panels in one file; file length does not defeat it, because the alternative
	 * is coordination code more complex than the builder it displaces.
	 *
	 * ## Why the sheet reuses `Panel`
	 *
	 * `Panel` already owns the shadow-as-sibling, the corner, the border and the band list, and `capToViewport` is
	 * already the sizing mechanism. A second sheet would be a second place for the offset and radius to drift. `TabStrip`
	 * supplies the two tabs and their selected/unselected styling.
	 */
	private buildInventory(parent: Instance): Frame {
		const scope = Fusion.scoped(Fusion);
		this.inventoryScope = scope;

		// **The same chunky chrome as the store**, through the same builder: neutral charcoal face, offset shadow plate,
		// thick outline. The sheet is a fixed size here rather than content-driven, so `autoHeight` stays off.
		const parts = buildChunkyPanel({
			name: "Inventory",
			parent,
			size: INVENTORY_PANEL_SIZE,
			// The row scrolls, so this one *does* clip - the opposite of the store, which lets an overgrown sheet show.
			clipsDescendants: true,
		});
		const surface = parts.surface;

		this.inventoryFrame = parts.frame;
		applyPanelScale(parts.frame, "inventory");

		// The bands below stack by `LayoutOrder`, so the face needs the list `Panel` used to bring with it. Reproduced
		// here rather than built into `buildChunkyPanel`, because the store brings its own list with its own padding and
		// a builder that supplied one would give the store two.
		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			HorizontalAlignment: Enum.HorizontalAlignment.Center,
			Parent: surface,
		});

		PanelHeader({
			theme: this.theme,
			parent: surface,
			title: "Inventory",
			onClose: () => this.setOpen("none"),
			typeScale: PANEL_TYPE,
			outline: true,
		});

		TabStrip({
			theme: this.theme,
			parent: surface,
			tabs: INVENTORY_TABS,
			selected: this.inventoryTab,
			onSelect: (tab) => this.selectInventoryTab(tab === "Fusion" ? "Fusion" : "Balls"),
			typeScale: PANEL_TYPE,
			outline: true,
		});

		this.inventoryStatus = PanelFooter({
			theme: this.theme,
			parent: surface,
			text: INVENTORY_FOOTER,
			typeScale: PANEL_TYPE,
			outline: true,
		});

		const row = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "InventoryContent",
			Size: new UDim2(1, 0, 0, INVENTORY_ROW_HEIGHT),
			BackgroundTransparency: 1,
			// 3, not 2: `TabStrip` already claims 2, and two equal orders in a `LayoutOrder` list is undefined order.
			LayoutOrder: 3,
			ZIndex: STORE_Z_INDEX,
			Parent: surface,
		});

		this.inventoryRow = row;

		// The row holds the two views, of which exactly one is ever visible, so its own direction is fixed. Each view
		// carries the list that flips - see `buildInventoryPane`.
		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, STORE_COLUMN_GAP),
			Parent: row,
		});

		this.ballsView = this.buildBallsView(scope, row);
		this.fusionView = this.buildFusionView(scope, row);

		this.applyInventoryLayout();
		this.watchInventoryRow();

		this.refreshOwned();

		return parts.frame;
	}

	/** Switches the inventory between its two tabs. One writer, so the two views cannot both be visible. */
	private selectInventoryTab(tab: "Balls" | "Fusion"): void {
		this.inventoryTab = tab;

		if (this.ballsView !== undefined) {
			this.ballsView.Visible = tab === "Balls";
		}

		if (this.fusionView !== undefined) {
			this.fusionView.Visible = tab === "Fusion";
		}

		// Switching tabs must not leave the fuse guard latched from a press made on the other tab.
		this.busy = false;
		this.refreshFusionPanel();
		this.refreshDetailPanel();
	}

	/** The `Balls` tab: a grid of owned balls on the left, the selected ball's facts on the right. */
	private buildBallsView(scope: Fusion.Scope<unknown>, parent: Instance): Frame {
		const view = this.buildInventoryPane(scope, parent, "BallsView", 1, true);

		const grid = Fusion.New(
			scope,
			"ScrollingFrame",
		)({
			Name: "Collection",
			Size: new UDim2(INVENTORY_COLLECTION_FRACTION, -STORE_COLUMN_GAP / 2, 1, 0),
			BackgroundColor3: this.theme.paint.surface.color,
			BackgroundTransparency: this.theme.paint.surface.transparency,
			BorderSizePixel: 0,
			ClipsDescendants: true,
			ScrollBarThickness: SPACING.xs,
			ScrollBarImageColor3: this.theme.colors.border,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			CanvasSize: UDim2.fromOffset(0, 0),
			AutomaticCanvasSize: Enum.AutomaticSize.Y,
			ElasticBehavior: Enum.ElasticBehavior.Never,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX,
			Parent: view,
		});

		this.corners(scope, grid, SPACING.sm);
		this.ballsGrid = grid;

		Fusion.New(
			scope,
			"UIGridLayout",
		)({
			CellSize: UDim2.fromOffset(INVENTORY_CARD_WIDTH, INVENTORY_CARD_HEIGHT),
			CellPadding: UDim2.fromOffset(SPACING.xs, SPACING.xs),
			SortOrder: Enum.SortOrder.LayoutOrder,
			Parent: grid,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SPACING.xs),
			PaddingBottom: new UDim(0, SPACING.xs),
			PaddingLeft: new UDim(0, SPACING.xs),
			PaddingRight: new UDim(0, SPACING.xs),
			Parent: grid,
		});

		const detail = this.buildInventoryPane(scope, view, "Detail", 2);

		const detailScope = Fusion.scoped(Fusion);

		this.detailPreview = Fusion.New(
			detailScope,
			"Frame",
		)({
			Name: "Preview",
			Size: new UDim2(1, 0, 0, INVENTORY_PREVIEW_HEIGHT),
			BackgroundColor3: this.theme.paint.trough.color,
			BackgroundTransparency: this.theme.paint.trough.transparency,
			BorderSizePixel: 0,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX,
			Parent: detail,
		});

		this.corners(detailScope, this.detailPreview, SPACING.sm);

		const ball = Fusion.New(
			detailScope,
			"Frame",
		)({
			Name: "Ball",
			AnchorPoint: new Vector2(CENTRE, CENTRE),
			Position: UDim2.fromScale(CENTRE, CENTRE),
			Size: UDim2.fromOffset(INVENTORY_PREVIEW_BALL, INVENTORY_PREVIEW_BALL),
			BackgroundColor3: this.theme.colors.textDisabled,
			BorderSizePixel: 0,
			ZIndex: STORE_Z_INDEX + 1,
			Parent: this.detailPreview,
		});

		this.corners(detailScope, ball, 0, ROUND);
		this.detailBall = ball;

		this.detailName = this.text(
			detailScope,
			detail,
			"",
			"h6",
			"primary",
			2,
			new UDim2(1, 0, 0, PANEL_TYPE.h6.size),
			false,
		);
		this.detailRarity = this.text(
			detailScope,
			detail,
			"",
			"body2",
			"secondary",
			3,
			new UDim2(1, 0, 0, PANEL_TYPE.body2.size),
			false,
		);
		this.detailCount = this.text(
			detailScope,
			detail,
			"",
			"body2",
			"secondary",
			4,
			new UDim2(1, 0, 0, PANEL_TYPE.body2.size),
			false,
		);
		this.detailHint = this.text(
			detailScope,
			detail,
			"",
			"caption",
			"secondary",
			5,
			new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight * 3),
			false,
		);
		this.detailHint.TextWrapped = true;
		this.detailHint.TextYAlignment = Enum.TextYAlignment.Top;

		return view;
	}

	/**
	 * The `Fusion` tab: a row of owned materials on the left, the odds and the fuse button on the right.
	 *
	 * ## Why this does not mirror the `Balls` grid
	 *
	 * The balls tab answers "what do I have" — a grid is right for scanning a collection. The fusion tab answers "which
	 * of these am I spending", which is a single choice followed by a single action, so a short list with an explicit
	 * selected state reads better than a grid of identical cards, and it leaves room to put the odds beside the button
	 * where the decision is made.
	 */
	private buildFusionView(scope: Fusion.Scope<unknown>, parent: Instance): Frame {
		const view = this.buildInventoryPane(scope, parent, "FusionView", 2, true);
		view.Visible = false;

		const list = Fusion.New(
			scope,
			"ScrollingFrame",
		)({
			Name: "Materials",
			Size: new UDim2(INVENTORY_COLLECTION_FRACTION, -STORE_COLUMN_GAP / 2, 1, 0),
			BackgroundColor3: this.theme.paint.surface.color,
			BackgroundTransparency: this.theme.paint.surface.transparency,
			BorderSizePixel: 0,
			ClipsDescendants: true,
			ScrollBarThickness: SPACING.xs,
			ScrollBarImageColor3: this.theme.colors.border,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			CanvasSize: UDim2.fromOffset(0, 0),
			AutomaticCanvasSize: Enum.AutomaticSize.Y,
			ElasticBehavior: Enum.ElasticBehavior.Never,
			LayoutOrder: 1,
			ZIndex: STORE_Z_INDEX,
			Parent: view,
		});

		this.corners(scope, list, SPACING.sm);
		this.fusionList = list;

		Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, SPACING.xs),
			Parent: list,
		});

		Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SPACING.xs),
			PaddingBottom: new UDim(0, SPACING.xs),
			PaddingLeft: new UDim(0, SPACING.xs),
			PaddingRight: new UDim(0, SPACING.xs),
			Parent: list,
		});

		const facts = this.buildInventoryPane(scope, view, "FusionFacts", 2);

		const factsScope = Fusion.scoped(Fusion);

		this.fusionMaterialLabel = this.text(
			factsScope,
			facts,
			"Select a ball",
			"h6",
			"primary",
			1,
			new UDim2(1, 0, 0, PANEL_TYPE.h6.size),
			false,
		);

		this.fusionOddsLabel = this.text(
			factsScope,
			facts,
			"",
			"body2",
			"secondary",
			2,
			new UDim2(1, 0, 0, PANEL_TYPE.body2.size * 2),
			false,
		);
		this.fusionOddsLabel.TextWrapped = true;

		this.fusionButton = Fusion.New(
			factsScope,
			"TextButton",
		)({
			Name: "Fuse",
			Size: new UDim2(1, 0, 0, BUTTON_ROW_HEIGHT),
			BorderSizePixel: 0,
			AutoButtonColor: false,
			Text: "",
			LayoutOrder: 3,
			ZIndex: STORE_Z_INDEX + 3,
			Parent: facts,
		});

		// The primary action of the whole panel, so it gets the depth for the same reason the chest buttons do. Its caption
		// is a label on the face, kept in `fusionLabel`, because the six places below rewrite it.
		const fuseChrome = applyChunkyChrome(this.fusionButton, {
			color: this.theme.colors.accent,
			shadowColor: shadowOf(this.theme.colors.accent),
			zIndex: STORE_Z_INDEX + 3,
			label: {
				text: "Select a ball",
				textSize: PANEL_TYPE.button.size,
				color: this.theme.colors.onAccent,
				font: FONT,
				zIndex: STORE_Z_INDEX + 5,
			},
		});

		this.fusionLabel = fuseChrome.label;

		attachPressFeedback(this.fusionButton);
		attachClickSound(this.fusionButton);
		this.fusionButton.Activated.Connect(() => this.pressFusion());
		this.fusionButton.Active = false;
		if (this.fusionLabel !== undefined) {
			this.fusionLabel.TextTransparency = 0.45;
		}

		return view;
	}

	/**
	 * A pane with a band list.
	 *
	 * `horizontal` distinguishes the two roles this builder has. A **view** (`BallsView`, `FusionView`) holds the
	 * collection beside the detail, so its list runs horizontally and is the one `applyInventoryLayout` flips; a
	 * **detail pane** holds stacked labels, so its list runs vertically and must never be flipped.
	 */
	private buildInventoryPane(
		scope: Fusion.Scope<unknown>,
		parent: Instance,
		name: string,
		order: number,
		horizontal = false,
	): Frame {
		const pane = Fusion.New(
			scope,
			"Frame",
		)({
			Name: name,
			Size: horizontal
				? new UDim2(1, 0, 1, 0)
				: new UDim2(INVENTORY_COLLECTION_FRACTION, -STORE_COLUMN_GAP / 2, 1, 0),
			BackgroundTransparency: 1,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX,
			Parent: parent,
		});

		const layout = Fusion.New(
			scope,
			"UIListLayout",
		)({
			FillDirection: horizontal ? Enum.FillDirection.Horizontal : Enum.FillDirection.Vertical,
			SortOrder: Enum.SortOrder.LayoutOrder,
			Padding: new UDim(0, STORE_COLUMN_GAP),
			Parent: pane,
		});

		if (horizontal) {
			this.inventorySplitLayouts.push(layout);
		}

		return pane;
	}

	/**
	 * Places the inventory's collection and detail panes: **always side by side, on every screen** (item 160).
	 *
	 * This used to have a stacked branch below `STORE_NARROW_WIDTH`, chosen from the *viewport* width. With the sheet now drawn at
	 * a fixed design width through a `UIScale`, a viewport-width test would rearrange a phone's inventory while leaving the store
	 * beside it — two different answers to the same question, and the rearranged one is the composition that was reported as
	 * wrong. The branch is gone; the wide arrangement is the only arrangement, so a phone gets the desktop inventory, smaller.
	 *
	 * The function remains because it still sets sizes: the row's height, each pane's split, each band's height. What it no longer
	 * does is *decide* anything from the screen — which is the whole point of a uniform scale.
	 */
	private applyInventoryLayout(): void {
		const row = this.inventoryRow;
		if (row === undefined) {
			return;
		}

		// No width to read any more: the arrangement below is the only arrangement, which is what keeps a phone's inventory
		// identical to a desktop's.

		for (const layout of this.inventorySplitLayouts) {
			layout.FillDirection = Enum.FillDirection.Horizontal;
		}

		row.Size = new UDim2(1, 0, 0, INVENTORY_ROW_HEIGHT);

		if (this.inventoryFrame !== undefined) {
			// **No `capToViewport` here any more.** It used to re-clamp the sheet on every resize, which fought the scale by
			// squashing the width while the height stayed — the distortion `applyPanelScale` exists to avoid.
			this.inventoryFrame.Size = UDim2.fromOffset(
				STORE_MAX_WIDTH,
				PANEL_HEADER_HEIGHT + TAB_STRIP_HEIGHT + INVENTORY_ROW_HEIGHT + PANEL_FOOTER_HEIGHT,
			);
		}

		for (const view of [this.ballsView, this.fusionView]) {
			if (view === undefined) {
				continue;
			}

			for (const child of view.GetChildren()) {
				if (!child.IsA("Frame") && !child.IsA("ScrollingFrame")) {
					continue;
				}

				const isCollection = child.Name === "Collection" || child.Name === "Materials";
				child.Size = new UDim2(
					isCollection ? INVENTORY_COLLECTION_FRACTION : 1 - INVENTORY_COLLECTION_FRACTION,
					-STORE_COLUMN_GAP / 2,
					1,
					0,
				);
			}
		}
	}

	private watchInventoryRow(): void {
		const camera = Workspace.CurrentCamera;
		if (camera === undefined) {
			return;
		}

		camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
			if (this.inventoryScope === undefined) {
				return;
			}

			this.applyInventoryLayout();
		});
	}

	// #endregion
}

/**
 * Why a paid-random-item gate is closed, in words the player can act on.
 *
 * "The button is disabled" and "the player understands why" are different requirements: a disabled button with no
 * explanation reads as a bug, and the player's only recourse — asking an adult or checking their account settings — is
 * invisible to them.
 */
function policyBlockedReason(state: PolicyState): string {
	if (state === "restricted") {
		return "Purchases with Robux are not available on this account.";
	}

	if (state === "loading") {
		return "Checking whether Robux purchases are available...";
	}

	return "Could not check whether Robux purchases are available. Rejoin to try again.";
}

/** One ball from an already-read ledger, or `undefined`. Split out so a refresh reads the attribute once, not once per query. */
function findOwned(owned: Array<OwnedBall>, id: string | undefined): OwnedBall | undefined {
	if (id === undefined) {
		return undefined;
	}

	for (const ball of owned) {
		if (ball.id === id) {
			return ball;
		}
	}

	return undefined;
}

/**
 * What the detail pane says about a ball beyond its name, tier and count.
 *
 * Built from `fusionOddsForBall` rather than a table of sentences, so retuning `FUSION_TABLE` moves the sentence with
 * the roll. A ball with no fusion rule gets the top-tier line instead of a percentage nobody can act on.
 */
function fusionHint(ball: OwnedBall): string {
	const odds = fusionOddsForBall(ball.id);
	if (odds.size() === 0) {
		return "Top tier. Nothing is above it, so it cannot be fused.";
	}

	if (ball.count < FUSION_INPUT_COUNT) {
		return `Fusing needs ${FUSION_INPUT_COUNT}; you have ${ball.count}.`;
	}

	return `${FUSION_INPUT_COUNT} become one tier higher on a ${odds[0].percent}% roll. Both are spent either way.`;
}

/**
 * A tier as a label, and a ball id as a label.
 *
 * **Both live in `shared/ball-name.ts` now.** They were duplicated here and in the picker within one round of each other,
 * and two copies of a derivation are one opinion plus one future bug — the visible symptom being `Bully ball` in one panel
 * and `Bully Ball` in the next. The aliases keep every call site in this file reading as it did.
 */
