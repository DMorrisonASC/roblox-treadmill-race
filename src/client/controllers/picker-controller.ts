import { Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYER_COINS_ATTRIBUTE } from "shared/attributes";
import { ballName, rarityLabel } from "shared/ball-name";
import { Rarity, rarityOfBall } from "shared/economy.config";
import { PickerOfferMessage, PickerResult, PICKER_OPTION_COUNT, REROLL_COST_COINS } from "shared/picker";
import {
	PICKER_OFFER_REMOTE_NAME,
	PICKER_PICK_REMOTE_NAME,
	PICKER_REROLL_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
	ROUND_STATE_VALUE_NAME,
} from "shared/remotes";
import { FONT, SPACING, TYPOGRAPHY } from "shared/ui/scale";
import { surfaceOpaqueTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { capToViewport } from "shared/ui/viewport";

/** The one phase the picker belongs to. A client cannot import the server's `RoundPhase`. */
const PHASE_WAITING = "Waiting";

// #region geometry

/** **Placeholder.** Height of the title/countdown band, in pixels. */
const HEADER_HEIGHT = 44;

/** **Placeholder.** Card width, in pixels. Equal for every card, so a longer offer reflows the row rather than the cards. */
const CARD_WIDTH = 200;

/** **Placeholder.** Card height, in pixels: a name, an 84-pixel ball, a rarity line and their gaps. */
const CARD_HEIGHT = 190;

/**
 * **Placeholder.** Extra height the card band needs beyond one card, in pixels.
 *
 * A horizontal `ScrollingFrame` draws its scrollbar *inside* its own box, so a band exactly as tall as a card clips the
 * bottom of every card by the bar's thickness. This is that thickness plus a hair, and it is the whole reason the first
 * build's cards looked cut off.
 */
const CHOICES_SCROLLBAR_ROOM = SPACING.sm;

/** **Placeholder.** Diameter of the tinted ball placeholder inside a card. */
const CARD_BALL = 84;

/** **Placeholder.** Height of one footer button. Tall enough for two stacked lines and a caption. */
const FOOTER_HEIGHT = 64;

/** **Placeholder.** Padding inside the sheet, in pixels. */
const SHEET_PADDING = SPACING.md;

/** **Placeholder.** Gap between the three bands, in pixels. */
const BAND_GAP = SPACING.sm;

/** **Placeholder.** Border weight of the sheet and of an unselected card. */
const BORDER = 1;

/** **Placeholder.** Border weight of the selected card. Thicker, not larger: a size change would reflow the row. */
const SELECTED_BORDER = 3;

/** **Placeholder.** How far a disabled button fades, so it does not read as pressable. */
const DISABLED_WASH = 0.55;

/** **Placeholder.** Seconds after which an unanswered call stops blocking the buttons. */
const REPLY_TIMEOUT_SECONDS = 10;

/**
 * **Placeholder.** Sheet width, in pixels: one full row of cards plus the gaps and padding around it.
 *
 * Declared after the parts it measures, because it is a derivation rather than a knob — changing a card width or a gap must
 * move the sheet with it, and a second literal would be the thing that silently stopped matching.
 */
const SHEET_WIDTH = CARD_WIDTH * PICKER_OPTION_COUNT + BAND_GAP * (PICKER_OPTION_COUNT - 1) + SHEET_PADDING * 2;

/** **Placeholder.** How far the small diamond is rotated, in degrees. A square at 45 degrees is the shape without an asset. */
const DIAMOND_ROTATION = 45;

/** **Placeholder.** Side length of that diamond, in pixels. */
const DIAMOND_SIZE = 10;

// #endregion

/** One rendered card, kept whole so the selection pass cannot mark the wrong button. */
interface BallCard {
	readonly ballId: string;
	readonly button: TextButton;
	readonly stroke: UIStroke;
	readonly nameLabel: TextLabel;
}

/**
 * The `Waiting`-phase ball picker: a title, a countdown, one card per offered ball, and two footer buttons.
 *
 * ```
 * BallPicker                       (vertical UIListLayout)
 *   Header                         (horizontal: title, spacer, countdown)
 *   BallChoices                    (horizontal scroller: one card per offer entry)
 *     Card                         (vertical: name, tinted ball, rarity)
 *   Footer                         (horizontal: All Balls, Reroll)
 * ```
 *
 * ## Why the parenting is the layout
 *
 * Every band is a real list and every child is a list item. The previous version offset cards by hand inside one row, which
 * works for exactly three cards — and three is only the count for a player who owns at least three balls. A premium offer
 * is every ball the player owns, so the count has to come from the offer and the row has to accept any length. That is what
 * a `UIListLayout` inside a horizontal scroller gives, and it is the whole of this file's layout code: the only absolute
 * placement anywhere is the sheet's own anchor, because a panel has to be somewhere on screen.
 *
 * ## What the panel is allowed to decide
 *
 * The offer, the premium roll and the timeout pick are the server's (`src/server/picker.ts`, item 69). This file renders
 * `options` and sends `PickerPick`; the reply can refuse, and a refusal un-marks the card. Nothing about the round changes
 * locally.
 *
 * ## Two elements of the reference are absent on purpose
 *
 * - **No ball power description.** No ball has a power, an effect or any text: `BALL_POOL` is a rarity-to-ids map and
 *   `rarityOfBall` is the only per-ball query. The description slot renders the *rarity*, the one fact the game can answer,
 *   and it is its own child so a later round replaces one line rather than inserting a new one.
 * - **No ball image.** No ball has an asset — item 58 recorded the same finding for the store, which draws a tinted `Frame`
 *   + `UICorner` circle rather than inventing an asset id. This does the same, tinted by rarity.
 */
@Controller()
export class PickerController implements OnStart {
	private readonly light: Theme = surfaceOpaqueTheme();
	private readonly player = Players.LocalPlayer;

	private phase = "unknown";
	private mainFrame?: Frame;
	private titleLabel?: TextLabel;
	private countdownLabel?: TextLabel;
	private choices?: ScrollingFrame;
	private loadingLabel?: TextLabel;
	private allBallsButton?: TextButton;
	private allBallsReason?: TextLabel;
	private rerollButton?: TextButton;
	private rerollCostLabel?: TextLabel;
	private rerollReason?: TextLabel;

	private offerRemote?: RemoteEvent;
	private pickRemote?: RemoteEvent;
	private rerollRemote?: RemoteEvent;

	/** The offer currently on screen, or `undefined` before one arrives and after the phase leaves `Waiting`. */
	private offer?: PickerOfferMessage;

	/** The id the player asked for, so the highlight can be restored if a reply refuses the choice. */
	private chosen?: string;

	private busy = false;
	private callId = 0;

	private readonly cards = new Array<BallCard>();

	public onStart(): void {
		const gui = getScreenGui("hudCore");
		this.mainFrame = this.buildMainFrame(gui);

		this.connectRemotes();
		this.applyPhase(this.readPhase());

		RunService.Heartbeat.Connect(() => this.tickCountdown());
		// **The balance arrives after the offer.** The first build evaluated the price once, when the offer landed, and the
		// `Coins` attribute had not replicated yet — so the re-roll button stayed washed out at a balance that could afford it.
		this.player.GetAttributeChangedSignal(PLAYER_COINS_ATTRIBUTE).Connect(() => this.refreshFooter());
		this.refreshFooter();

		print(`[Picker] mounted phase=${this.phase}`);
	}

	/** Reads the phase once so a player who joins during `Waiting` sees the picker, then subscribes. */
	private readPhase(): string {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, 10);

		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[Picker] no ${ROUND_STATE_VALUE_NAME} StringValue — the picker stays hidden.`);
			return "unknown";
		}

		value.Changed.Connect(() => this.applyPhase(value.Value));
		return value.Value;
	}

	/**
	 * Shows the panel only during `Waiting`.
	 *
	 * One rule for the mount read and for every change, for the same reason the store keeps one: two copies of "when is this
	 * visible" is how a panel ends up on screen in a phase the other copy thought was fine.
	 *
	 * Leaving the phase also **drops the offer**. The countdown is not a timer this file owns — it informs, and the phase
	 * change is what ends the window. A stale offer that reappeared on the next entry would be a set of cards the server has
	 * already discarded.
	 */
	private applyPhase(phase: string): void {
		this.phase = phase;

		const frame = this.mainFrame;
		if (frame === undefined) {
			return;
		}

		const waiting = phase === PHASE_WAITING;
		frame.Visible = waiting;

		if (waiting) {
			return;
		}

		this.offer = undefined;
		this.chosen = undefined;
		this.clearCards();
		this.setLoading(true);
	}

	private connectRemotes(): void {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, 10);
		if (folder === undefined) {
			warn(`[Picker] no ${REMOTES_FOLDER_NAME} folder — the picker will not work.`);
			return;
		}

		const offer = folder.WaitForChild(PICKER_OFFER_REMOTE_NAME, 10);
		if (offer !== undefined && offer.IsA("RemoteEvent")) {
			this.offerRemote = offer;
			offer.OnClientEvent.Connect((message: unknown) => this.onOffer(message));
		} else {
			warn(`[Picker] no ${PICKER_OFFER_REMOTE_NAME} remote — no offers will arrive.`);
		}

		const pick = folder.WaitForChild(PICKER_PICK_REMOTE_NAME, 10);
		if (pick !== undefined && pick.IsA("RemoteEvent")) {
			this.pickRemote = pick;
			pick.OnClientEvent.Connect((result: unknown) => this.onPickResult(result));
		}

		const reroll = folder.WaitForChild(PICKER_REROLL_REMOTE_NAME, 10);
		if (reroll !== undefined && reroll.IsA("RemoteEvent")) {
			this.rerollRemote = reroll;
			reroll.OnClientEvent.Connect((result: unknown) => this.onRerollResult(result));
		}
	}

	// #region rendering

	/**
	 * Renders a new offer.
	 *
	 * The card count is `offer.options.size()` and nothing else. A one-ball player is offered that ball three times and sees
	 * three cards; a premium player sees every ball they own; neither case is special here, which is the property criterion 2
	 * is about.
	 */
	private onOffer(message: unknown): void {
		const offer = message as PickerOfferMessage | undefined;
		if (offer === undefined || offer.options.size() === 0) {
			this.setLoading(true);
			return;
		}

		this.offer = offer;
		this.chosen = undefined;
		this.renderCards(offer);
		this.setLoading(false);
		this.refreshFooter();
	}

	private renderCards(offer: PickerOfferMessage): void {
		this.clearCards();

		const choices = this.choices;
		if (choices === undefined) {
			return;
		}

		let order = 1;
		for (const ballId of offer.options) {
			this.cards.push(this.buildCard(choices, ballId, order));
			order++;
		}

		choices.CanvasPosition = new Vector2(0, 0);
	}

	private clearCards(): void {
		for (const card of this.cards) {
			card.button.Destroy();
		}

		this.cards.clear();
	}

	/**
	 * One card: name, tinted ball, rarity — siblings in a vertical list, in that order.
	 *
	 * The selection state is a **border and a fill**, never a size: a card that grew on selection would reflow every sibling
	 * in the row, which for a nine-card premium offer is a visible jump under the pointer that just clicked it.
	 */
	private buildCard(parent: Instance, ballId: string, order: number): BallCard {
		const rarity: Rarity = rarityOfBall(ballId) ?? "common";
		const tint = this.light.colors.rarity[rarity];

		const button = new Instance("TextButton");
		button.Name = `Card_${order}`;
		button.Size = UDim2.fromOffset(CARD_WIDTH, CARD_HEIGHT);
		button.BackgroundColor3 = this.light.paint.card.color;
		button.BackgroundTransparency = this.light.paint.card.transparency;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Text = "";
		button.LayoutOrder = order;
		button.Parent = parent;

		const buttonCorner = new Instance("UICorner");
		buttonCorner.CornerRadius = new UDim(0, SPACING.sm);
		buttonCorner.Parent = button;

		const cardPadding = new Instance("UIPadding");
		cardPadding.PaddingTop = new UDim(0, SPACING.sm);
		cardPadding.PaddingBottom = new UDim(0, SPACING.sm);
		cardPadding.PaddingLeft = new UDim(0, SPACING.sm);
		cardPadding.PaddingRight = new UDim(0, SPACING.sm);
		cardPadding.Parent = button;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		// Centred vertically so the block sits in the card rather than hugging its top edge.
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.xs);
		layout.Parent = button;

		// 1. Name.
		const nameLabel = this.label(button, ballName(ballId), "body2", "primary", 1);
		nameLabel.TextWrapped = true;

		// 2. The ball placeholder: a tinted circle, not an invented asset.
		const ball = new Instance("Frame");
		ball.Name = "Ball";
		ball.Size = UDim2.fromOffset(CARD_BALL, CARD_BALL);
		ball.BackgroundColor3 = tint;
		ball.BackgroundTransparency = 0.1;
		ball.BorderSizePixel = 0;
		ball.LayoutOrder = 2;
		ball.Parent = button;

		const ballCorner = new Instance("UICorner");
		ballCorner.CornerRadius = new UDim(1, 0);
		ballCorner.Parent = ball;

		// 3. The description slot: the rarity, because no ball has a power, an effect or any other text to put here.
		const description = this.label(button, rarityLabel(rarity), "caption", "secondary", 3);
		description.TextXAlignment = Enum.TextXAlignment.Center;

		const stroke = new Instance("UIStroke");
		stroke.Color = tint;
		stroke.Thickness = BORDER;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = button;

		button.Activated.Connect(() => this.pick(ballId));

		return { ballId, button, stroke, nameLabel };
	}

	/** Loading, not empty: before an offer arrives the band says so rather than showing zero cards. */
	private setLoading(loading: boolean): void {
		if (this.loadingLabel !== undefined) {
			this.loadingLabel.Visible = loading;
		}
	}

	/**
	 * Marks every card whose id is `ballId`, or none when it is `undefined`.
	 *
	 * By id rather than by card index, because an offer legitimately repeats an id — a player who owns one ball is offered
	 * that ball three times, and all three cards *are* that choice. A per-card highlight would make the three identical
	 * cards look like three different balls that happened to share a name.
	 */
	private markChosen(ballId: string | undefined): void {
		for (const card of this.cards) {
			const selected = ballId !== undefined && card.ballId === ballId;

			card.stroke.Thickness = selected ? SELECTED_BORDER : BORDER;
			card.stroke.Color = selected
				? this.light.colors.accent
				: this.light.colors.rarity[rarityOfBall(card.ballId) ?? "common"];
			card.button.BackgroundColor3 = selected ? this.light.colors.accent : this.light.paint.card.color;
			card.button.BackgroundTransparency = selected ? 0 : this.light.paint.card.transparency;
			card.nameLabel.TextColor3 = selected ? this.light.colors.onAccent : this.light.colors.textPrimary;
		}
	}

	// #endregion

	// #region actions

	/**
	 * Asks the server for `ballId`.
	 *
	 * The card is marked immediately because a click is unambiguous, but the mark is a *request*: the reply can refuse it and
	 * `onPickResult` puts the highlight back. Nothing about the round changes locally.
	 */
	private pick(ballId: string): void {
		const remote = this.pickRemote;
		if (remote === undefined || this.busy) {
			return;
		}

		this.busy = true;
		this.callId += 1;
		const callId = this.callId;

		this.chosen = ballId;
		this.markChosen(ballId);
		remote.FireServer(ballId);

		// The watchdog shape item 66 established: the reply releases the guard, and this only covers a reply that never
		// arrives. The id stops a late watchdog from a completed call clearing a later one.
		task.delay(REPLY_TIMEOUT_SECONDS, () => {
			if (this.callId === callId && this.busy) {
				this.busy = false;
			}
		});
	}

	private onPickResult(result: unknown): void {
		const reply = result as PickerResult | undefined;
		this.busy = false;

		if (reply !== undefined && !reply.ok) {
			// Refused: drop the optimistic mark so the panel shows what the server actually recorded.
			this.chosen = undefined;
			this.markChosen(undefined);
			warn(`[Picker] pick refused: ${reply.reason}`);
		}
	}

	/** Asks the server to replace the offer. The price is the server's; this only refuses an obviously unaffordable press. */
	private reroll(): void {
		const remote = this.rerollRemote;
		if (remote === undefined || this.busy) {
			return;
		}

		const coins = this.coins();
		if (coins === undefined || coins < REROLL_COST_COINS) {
			return;
		}

		this.busy = true;
		this.callId += 1;
		const callId = this.callId;

		this.refreshFooter();
		remote.FireServer();

		task.delay(REPLY_TIMEOUT_SECONDS, () => {
			if (this.callId === callId && this.busy) {
				this.busy = false;
				this.refreshFooter();
			}
		});
	}

	private onRerollResult(result: unknown): void {
		const reply = result as PickerResult | undefined;
		this.busy = false;

		if (reply === undefined) {
			this.refreshFooter();
			return;
		}

		if (!reply.ok) {
			warn(`[Picker] reroll refused: ${reply.reason}`);
			this.refreshFooter();
			return;
		}

		// The replacement rides on the reply rather than arriving as a second message, so the panel cannot briefly show the
		// old cards under a new balance.
		const offer = (reply as { offer?: PickerOfferMessage }).offer;
		if (offer !== undefined) {
			this.onOffer(offer);
		}

		this.refreshFooter();
	}

	// #endregion

	// #region chrome

	private coins(): number | undefined {
		const coins = this.player.GetAttribute(PLAYER_COINS_ATTRIBUTE);
		return typeIs(coins, "number") ? coins : undefined;
	}

	/**
	 * Rewrites both footer buttons for the current balance and offer.
	 *
	 * ## `All Balls` cannot be enabled, and says why on the button
	 *
	 * The premium upgrade is a **random per-phase roll** on the server: every player gets a 10% chance at an offer of
	 * everything they own, rolled once when `Waiting` begins. There is no "show me everything" action to bind a button to, and
	 * inventing one would be inventing a mechanic. So the button renders disabled with the reason where its price would be,
	 * the same place item 66 put `have/price`. An enabled button that does nothing is the worse outcome.
	 *
	 * ## `Reroll` shows the price, or `have/price` when the balance cannot cover it
	 *
	 * The shortfall is on the control the player is looking at, so a dead button is never a mystery. A premium offer replaces
	 * the price with the reason, because no price makes a re-roll of it meaningful — the offer already *is* everything they
	 * own, and the server refuses it.
	 */
	private refreshFooter(): void {
		const offer = this.offer;
		const coins = this.coins();

		if (this.allBallsButton !== undefined && this.allBallsReason !== undefined) {
			this.allBallsButton.Active = false;
			this.allBallsButton.BackgroundTransparency = DISABLED_WASH;
			this.allBallsReason.Text = "random per round";
		}

		const rerollButton = this.rerollButton;
		const costLabel = this.rerollCostLabel;
		const reasonLabel = this.rerollReason;
		if (rerollButton === undefined || costLabel === undefined || reasonLabel === undefined) {
			return;
		}

		const premium = offer !== undefined && offer.premium;
		const affordable = coins !== undefined && coins >= REROLL_COST_COINS;
		const enabled = !this.busy && !premium && affordable && offer !== undefined;

		rerollButton.Active = enabled;
		rerollButton.BackgroundTransparency = enabled ? 0 : DISABLED_WASH;

		if (premium) {
			costLabel.Text = "-";
			reasonLabel.Text = "all balls shown";
			return;
		}

		costLabel.Text =
			affordable || coins === undefined ? tostring(REROLL_COST_COINS) : `${coins}/${REROLL_COST_COINS}`;
		reasonLabel.Text = affordable || coins === undefined ? "" : "not enough coins";
	}

	/**
	 * Repaints the countdown from the server deadline.
	 *
	 * **The number is the server's.** The deadline arrives absolute, computed on the server's clock when the offer was rolled,
	 * and is compared against `Workspace.GetServerTimeNow()` — a clock the engine keeps synchronised with the server.
	 * Subtracting a local clock instead would drift: `os.clock()` is process uptime and says nothing about the server's phase,
	 * and a per-frame decrement accumulates every frame's error plus every hitch. What remains is the client's one-time
	 * offset estimate, which shifts when the countdown *starts* rather than making it wrong by the end — and the phase change,
	 * not this number, is what ends the window.
	 */
	private tickCountdown(): void {
		const label = this.countdownLabel;
		const offer = this.offer;
		if (label === undefined || offer === undefined || this.mainFrame === undefined || !this.mainFrame.Visible) {
			return;
		}

		const remaining = math.max(0, offer.deadline - Workspace.GetServerTimeNow());
		label.Text = tostring(math.ceil(remaining));
		label.TextColor3 = remaining <= 3 ? this.light.colors.error : this.light.colors.textSecondary;
	}

	// #endregion

	// #region construction

	private buildMainFrame(parent: Instance): Frame {
		const frame = new Instance("Frame");
		frame.Name = "BallPicker";
		frame.AnchorPoint = new Vector2(0.5, 0.5);
		frame.Position = UDim2.fromScale(0.5, 0.5);
		// **An offset, not a share of the screen.** A 60%-wide sheet with three cards left a third of the panel empty on the
		// right, which reads as a card that failed to load; the reference's panel is only as wide as its content. The row of
		// `PICKER_OPTION_COUNT` cards *is* the content, and a premium offer wider than that scrolls inside this width.
		// `capToViewport` supplies the ceiling on a narrow window, where an offset would otherwise overflow.
		frame.Size = new UDim2(
			0,
			SHEET_WIDTH,
			0,
			HEADER_HEIGHT + CARD_HEIGHT + CHOICES_SCROLLBAR_ROOM + FOOTER_HEIGHT + BAND_GAP * 2 + SHEET_PADDING * 2,
		);
		// **Belt and braces against leaking.** The bands are fixed-height and their contents are laid out, not positioned, so
		// a child taller than its band escapes the sheet entirely — the first build had a footer line drawn below the panel.
		// Clipping means a mistake costs a few clipped pixels inside the sheet instead of text floating on the game world.
		frame.ClipsDescendants = true;
		frame.AutomaticSize = Enum.AutomaticSize.Y;
		frame.BackgroundColor3 = this.light.paint.panel.color;
		frame.BackgroundTransparency = this.light.paint.panel.transparency;
		frame.BorderSizePixel = 0;
		frame.Visible = false;
		frame.Parent = parent;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, SPACING.md);
		corner.Parent = frame;

		const stroke = new Instance("UIStroke");
		stroke.Color = this.light.colors.border;
		stroke.Thickness = BORDER;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = frame;

		const padding = new Instance("UIPadding");
		padding.PaddingTop = new UDim(0, SHEET_PADDING);
		padding.PaddingBottom = new UDim(0, SHEET_PADDING);
		padding.PaddingLeft = new UDim(0, SHEET_PADDING);
		padding.PaddingRight = new UDim(0, SHEET_PADDING);
		padding.Parent = frame;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, BAND_GAP);
		layout.Parent = frame;

		this.buildHeader(frame);
		this.buildChoices(frame);
		this.buildFooter(frame);

		capToViewport(frame);
		return frame;
	}

	/** Band 1: the title on the left, the countdown on the right, as two halves so neither end can overlap or overflow. */
	private buildHeader(parent: Instance): void {
		const header = new Instance("Frame");
		header.Name = "Header";
		header.Size = new UDim2(1, 0, 0, HEADER_HEIGHT);
		header.BackgroundTransparency = 1;
		header.LayoutOrder = 1;
		header.Parent = parent;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.sm);
		layout.Parent = header;

		// **Two half-width labels, not "title, spacer, countdown".** A spacer sized `1, 0` inside a horizontal `UIListLayout`
		// is a scale width, so the row's total width exceeds the header and everything after the spacer is laid out past the
		// right edge — which is where the countdown went in the first build. Halves cannot overflow: they always sum to one.
		const title = this.label(header, "CHOOSE YOUR BALL", "h6", "primary", 1);
		title.Size = new UDim2(0.5, -SPACING.xs, 1, 0);
		title.TextXAlignment = Enum.TextXAlignment.Left;
		this.titleLabel = title;

		const countdown = this.label(header, "", "h6", "secondary", 2);
		countdown.Size = new UDim2(0.5, -SPACING.xs, 1, 0);
		countdown.TextXAlignment = Enum.TextXAlignment.Right;
		this.countdownLabel = countdown;
	}

	/**
	 * Band 2: the cards.
	 *
	 * A `ScrollingFrame` rather than a plain frame because the row's length is the offer's length: three cards fit, a premium
	 * offer of nine does not, and a row that overflows its sheet is worse than one that scrolls.
	 */
	private buildChoices(parent: Instance): void {
		const choices = new Instance("ScrollingFrame");
		choices.Name = "BallChoices";
		choices.Size = new UDim2(1, 0, 0, CARD_HEIGHT + CHOICES_SCROLLBAR_ROOM);
		choices.BackgroundTransparency = 1;
		choices.BorderSizePixel = 0;
		choices.ScrollBarThickness = SPACING.xs;
		choices.ScrollBarImageColor3 = this.light.colors.border;
		choices.ScrollingDirection = Enum.ScrollingDirection.X;
		choices.CanvasSize = UDim2.fromOffset(0, 0);
		choices.AutomaticCanvasSize = Enum.AutomaticSize.X;
		choices.ElasticBehavior = Enum.ElasticBehavior.Never;
		choices.LayoutOrder = 2;
		choices.Parent = parent;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		// Centred, not left-aligned: three cards in a wide sheet left a large dead area on the right, which reads as a
		// missing fourth card. `Top` leaves the scrollbar its own strip instead of drawing over the cards.
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.VerticalAlignment = Enum.VerticalAlignment.Top;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.sm);
		layout.Parent = choices;

		const loading = this.label(choices, "Waiting for your balls...", "body2", "secondary", 1);
		loading.Size = new UDim2(1, 0, 1, 0);
		this.loadingLabel = loading;
		this.choices = choices;
	}

	/**
	 * Band 3: two buttons.
	 *
	 * `All Balls` is permanently disabled (the premium upgrade is a server roll, not an action — see `refreshFooter`), and
	 * `Reroll` is priced. Both are stacked labels inside one button, which is the smallest shape that can show a name and a
	 * reason without a tooltip.
	 */
	private buildFooter(parent: Instance): void {
		const footer = new Instance("Frame");
		footer.Name = "Footer";
		footer.Size = new UDim2(1, 0, 0, FOOTER_HEIGHT);
		footer.BackgroundTransparency = 1;
		footer.LayoutOrder = 3;
		footer.Parent = parent;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.sm);
		layout.Parent = footer;

		const allBalls = this.footerButton(footer, "AllBalls", 1);
		// White-on-accent, from the theme's own slot. `textPrimary` here is dark-on-blue, which is what the first build shipped.
		const free = this.label(allBalls, "FREE", "caption", "onAccent", 1);
		free.TextColor3 = this.light.colors.success;
		this.label(allBalls, "All Balls", "body1", "onAccent", 2);
		this.allBallsReason = this.label(allBalls, "random per round", "caption", "onAccent", 3);
		this.allBallsButton = allBalls;

		const reroll = this.footerButton(footer, "Reroll", 2);

		// The cost line: a small diamond and the number. A square rotated 45 degrees is a diamond without an asset, which is
		// the same rule the ball placeholder follows: neither invents an art id.
		const costRow = new Instance("Frame");
		costRow.Name = "Cost";
		// **Explicit height, auto width.** `AutomaticSize.XY` around a child whose height is `1, 0` is circular — the row asks
		// the label how tall it is and the label asks the row — which squeezed the cost line into a few pixels at the top.
		costRow.Size = new UDim2(0, 0, 0, TYPOGRAPHY.body2.size + SPACING.xs);
		costRow.AutomaticSize = Enum.AutomaticSize.X;
		costRow.BackgroundTransparency = 1;
		costRow.LayoutOrder = 1;
		costRow.Parent = reroll;

		const costLayout = new Instance("UIListLayout");
		costLayout.FillDirection = Enum.FillDirection.Horizontal;
		costLayout.VerticalAlignment = Enum.VerticalAlignment.Center;
		costLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		costLayout.Padding = new UDim(0, SPACING.xs);
		costLayout.Parent = costRow;

		const diamond = new Instance("Frame");
		diamond.Name = "Diamond";
		diamond.Size = UDim2.fromOffset(DIAMOND_SIZE, DIAMOND_SIZE);
		diamond.Rotation = DIAMOND_ROTATION;
		diamond.BackgroundColor3 = this.light.colors.coin;
		diamond.BorderSizePixel = 0;
		diamond.LayoutOrder = 1;
		diamond.Parent = costRow;

		const diamondCorner = new Instance("UICorner");
		diamondCorner.CornerRadius = new UDim(0, 1);
		diamondCorner.Parent = diamond;

		const cost = this.label(costRow, tostring(REROLL_COST_COINS), "body2", "onAccent", 2);
		cost.Size = new UDim2(0, 0, 1, 0);
		cost.AutomaticSize = Enum.AutomaticSize.X;
		cost.TextColor3 = this.light.colors.coin;
		this.rerollCostLabel = cost;

		this.label(reroll, "REROLL", "body1", "onAccent", 2);
		// **The caption is a reason, never the button's own name.** The first build wrote "REROLL" into this label as well, so
		// the footer said it twice — once inside the button and once below the sheet, where the overflow landed.
		this.rerollReason = this.label(reroll, "", "caption", "onAccent", 3);

		reroll.Activated.Connect(() => this.reroll());
		this.rerollButton = reroll;
	}

	/** A footer button: half the row, a nested vertical list for its lines, no engine pressed-tint. */
	private footerButton(parent: Instance, name: string, order: number): TextButton {
		const button = new Instance("TextButton");
		button.Name = name;
		button.Size = new UDim2(0.5, -SPACING.xs, 1, 0);
		button.BackgroundColor3 = this.light.colors.accent;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Text = "";
		button.LayoutOrder = order;
		button.Parent = parent;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, SPACING.sm);
		corner.Parent = button;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Parent = button;

		return button;
	}

	/** A label with the sheet's typography. Every size and font comes from `shared/ui/scale.ts`; none is a literal here. */
	private label(
		parent: Instance,
		text: string,
		variant: keyof typeof TYPOGRAPHY,
		colour: "primary" | "secondary" | "onAccent",
		order: number,
	): TextLabel {
		const label = new Instance("TextLabel");
		label.Name = `Label_${variant}`;
		label.Size = new UDim2(1, 0, 0, TYPOGRAPHY[variant].size + SPACING.xs);
		label.BackgroundTransparency = 1;
		label.Font = FONT;
		label.TextSize = TYPOGRAPHY[variant].size;
		// `onAccent` for text inside an accent-filled button: `textPrimary` on the accent is dark-on-blue, the low-contrast
		// pairing the first build shipped. The theme has a slot for exactly this and it was not being used.
		label.TextColor3 =
			colour === "primary"
				? this.light.colors.textPrimary
				: colour === "onAccent"
					? this.light.colors.onAccent
					: this.light.colors.textSecondary;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.TextTruncate = Enum.TextTruncate.AtEnd;
		label.Text = text;
		label.LayoutOrder = order;
		label.Parent = parent;

		return label;
	}

	// #endregion
}
