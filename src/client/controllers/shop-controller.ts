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
	Rarity,
	ROBUX_CHEST_BUNDLE_COUNT,
	ROBUX_CHEST_BUNDLE_PRICE_ROBUX,
	ROBUX_CHEST_BUNDLE_PRODUCT_ID,
	ROBUX_CHEST_PRICE_ROBUX,
	ROBUX_CHEST_PRODUCT_ID,
	ROBUX_CHEST_RARITIES,
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
import { PanelFooter, PANEL_FOOTER_HEIGHT, PANEL_HEADER_HEIGHT, PanelHeader } from "shared/ui/panel";
import { TabStrip, TAB_STRIP_HEIGHT } from "shared/ui/tabs";
import { buildChunkyButton, ChunkyButton } from "shared/ui/chunky-button";
import { buildChunkyPanel } from "shared/ui/chunky-panel";
import { addChunkyRing, applyChunkyChrome, dimChunkyChrome, shadowOf } from "shared/ui/chunky-chrome";
import { attachPressFeedback } from "shared/ui/press";
import { attachClickSound, playPurchaseSound } from "shared/ui/sounds";
import { capToViewport } from "shared/ui/viewport";
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
 * **Placeholder.** Below this viewport width the two chest sections stack instead of sitting side by side, in pixels.
 *
 * A **new** constant, because the responsive mechanism it belongs to was removed in item 59: the store is a single
 * vertical column, so there is no existing breakpoint to reuse. The columns are 880 / 2 = ~430 wide above this and the
 * full width below it.
 */
const STORE_NARROW_WIDTH = 900;

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

/** **Placeholder.** Share of the stacked row taken by the collection when the sheet is below the breakpoint. */
const INVENTORY_STACKED_SPLIT = 0.55;

/**
 * **Placeholder.** How much taller the row gets when it is stacked, as a multiplier.
 *
 * Two panes stacked in the height of one do not fit: the detail pane is a 96-pixel preview plus four lines, so at the
 * desktop row height its lower half would spill over the collection above it. Growing the row and letting
 * `capToViewport` cut it back on a short window keeps the content inside the sheet on a phone and costs a desktop
 * nothing, because a desktop never enters this branch.
 */
const INVENTORY_STACKED_GROWTH = 1.7;

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
		const gui = getScreenGui("hudCore");
		this.rail = this.buildRail(gui);
		this.applyPhase(this.readPhase());
		this.connectRemotes();
		this.connectAttributes();
		this.connectPolicyGate();
		this.connectPurchasePrompt();
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
	 *   Content                   (Vertical)
	 *     Coin Chest Section      (Vertical)
	 *       "Coin Chest"          (title)
	 *       Preview Row           (Horizontal: chest square, rarity stats)
	 *       Prize Preview Header  (Horizontal: "Prize Preview", "View All >")
	 *       Prize Scroller        (Horizontal, auto-scrolling)
	 *       Purchase Buttons      (Horizontal: Open 1, Open 10)
	 *     Premium Chest Section   (Vertical, same shape, Robux)
	 * ```
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
			size: UDim2.fromOffset(STORE_MAX_WIDTH, 0),
			autoHeight: true,
			cornerRadius: SPACING.md,
			// Not clipping, deliberately: every child is inset by `SHEET_INSET`, so the rounded corner has nothing to cut,
			// and a sheet that visibly overflows is a bug somebody reports rather than one nobody ever sees.
			clipsDescendants: false,
			zIndex: STORE_Z_INDEX,
		});

		const surface = panel.surface;
		capToViewport(panel.frame);

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
	}

	// #endregion

	// #region the chest section

	/**
	 * The two chest sections, side by side above `STORE_NARROW_WIDTH` and stacked below it.
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

		this.applyChestRowLayout(this.viewportWidth());
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
	private applyChestRowLayout(width: number): void {
		const layout = this.chestRowLayout;
		if (layout === undefined || this.chestColumns.size() === 0) {
			return;
		}

		const narrow = width < STORE_NARROW_WIDTH;
		layout.FillDirection = narrow ? Enum.FillDirection.Vertical : Enum.FillDirection.Horizontal;

		for (const section of this.chestColumns) {
			section.Size = narrow ? new UDim2(1, 0, 0, 0) : new UDim2(0.5, -STORE_COLUMN_GAP / 2, 0, 0);
		}
	}

	private viewportWidth(): number {
		const camera = Workspace.CurrentCamera;
		return camera !== undefined ? camera.ViewportSize.X : STORE_NARROW_WIDTH;
	}

	/** Watches the viewport so a window resize re-lays the two sections. */
	private watchChestRow(): void {
		const camera = Workspace.CurrentCamera;
		if (camera === undefined) {
			return;
		}

		camera.GetPropertyChangedSignal("ViewportSize").Connect(() => {
			if (this.scope === undefined) {
				return;
			}

			this.applyChestRowLayout(camera.ViewportSize.X);
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
		this.buildPrizeHeaderRow(scope, section, 3);

		const shelf = this.buildPrizeShelf(scope, section, 4);
		this.fillPrizeShelf(scope, shelf, RARITIES);
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
		this.buildPrizeHeaderRow(scope, section, 3);

		const shelf = this.buildPrizeShelf(scope, section, 4);
		this.fillPrizeShelf(scope, shelf, ROBUX_CHEST_RARITIES);
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
	private fillPrizeShelf(scope: Fusion.Scope<unknown>, shelf: ScrollingFrame, rarities: ReadonlyArray<Rarity>): void {
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
			Size: UDim2.fromOffset(CARD_WIDTH, CARD_ART + PANEL_TYPE.caption.lineHeight + SPACING.xs * 2),
			BackgroundColor3: this.theme.paint.card.color,
			BackgroundTransparency: this.theme.paint.card.transparency,
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
			Color: this.theme.colors.rarity[rarity],
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
			BackgroundColor3: this.theme.colors.rarity[rarity],
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
			BackgroundColor3: this.theme.colors.rarity[rarity],
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
			new UDim2(1, -SPACING.xs * 2, 0, PANEL_TYPE.caption.lineHeight),
			false,
		);
		name.Position = UDim2.fromOffset(SPACING.xs, CARD_ART + SPACING.xs);
		name.TextXAlignment = Enum.TextXAlignment.Center;
		name.TextYAlignment = Enum.TextYAlignment.Center;
		name.TextTruncate = Enum.TextTruncate.AtEnd;
	}

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

	/** The yellow coin placeholder: a plain circle, because the tree ships no coin image. */
	private coinDot(scope: Fusion.Scope<unknown>, parent: Instance, size: number, order: number): Frame {
		const dot = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "Coin",
			Size: UDim2.fromOffset(size, size),
			BackgroundColor3: this.theme.colors.coin,
			BorderSizePixel: 0,
			LayoutOrder: order,
			ZIndex: STORE_Z_INDEX + 5,
			Parent: parent,
		});

		this.corners(scope, dot, 0, ROUND);

		return dot;
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
		capToViewport(parts.frame);

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

		this.applyInventoryLayout(this.viewportWidth());
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
	 * Re-lays every inventory view: collection beside detail above the breakpoint, stacked below it.
	 *
	 * Three things change together and must, or the layout overflows: the band direction inside each view, each band's
	 * size, and the height of the row the views sit in. Stacking two full-height bands inside one row is the only way
	 * this arrangement fails, so the stacked branch grows the row and lets `capToViewport` cut the sheet back on a short
	 * window - a desktop never takes this branch and so costs nothing.
	 */
	private applyInventoryLayout(width: number): void {
		const row = this.inventoryRow;
		if (row === undefined) {
			return;
		}

		const narrow = width < STORE_NARROW_WIDTH;

		for (const layout of this.inventorySplitLayouts) {
			layout.FillDirection = narrow ? Enum.FillDirection.Vertical : Enum.FillDirection.Horizontal;
		}

		const rowHeight = narrow ? math.round(INVENTORY_ROW_HEIGHT * INVENTORY_STACKED_GROWTH) : INVENTORY_ROW_HEIGHT;
		row.Size = new UDim2(1, 0, 0, rowHeight);

		if (this.inventoryFrame !== undefined) {
			this.inventoryFrame.Size = UDim2.fromOffset(
				STORE_MAX_WIDTH,
				PANEL_HEADER_HEIGHT + TAB_STRIP_HEIGHT + rowHeight + PANEL_FOOTER_HEIGHT,
			);
			capToViewport(this.inventoryFrame);
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
				child.Size = narrow
					? new UDim2(
							1,
							0,
							isCollection ? INVENTORY_STACKED_SPLIT : 1 - INVENTORY_STACKED_SPLIT,
							-STORE_COLUMN_GAP / 2,
						)
					: new UDim2(
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

			this.applyInventoryLayout(camera.ViewportSize.X);
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
