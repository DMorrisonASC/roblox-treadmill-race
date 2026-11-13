import { Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYER_COINS_ATTRIBUTE } from "shared/attributes";
import { ballName, rarityLabel } from "shared/ball-name";
import { colorForBall } from "shared/ball-color";
import { attachBallIcon } from "shared/ui/ball-swatch";
import { Rarity, rarityOfBall } from "shared/economy.config";
import { PickerOfferMessage, PickerResult, PICKER_OPTION_COUNT, REROLL_COST_COINS } from "shared/picker";
import { pickerVisible } from "shared/picker";
import {
	PICKER_OFFER_REMOTE_NAME,
	PICKER_PICK_REMOTE_NAME,
	PICKER_REROLL_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
	ROUND_STATE_VALUE_NAME,
} from "shared/remotes";
import { FONT, SPACING, TYPOGRAPHY, typographyOneStepUp } from "shared/ui/scale";
import { chunkyDarkTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { applyChunkyChrome, ChunkyChrome, dimChunkyChrome, shadowOf } from "shared/ui/chunky-chrome";
import { buildChunkyPanel } from "shared/ui/chunky-panel";
import { outlineText } from "shared/ui/text";
import { attachClickSound } from "shared/ui/sounds";
import { attachPressFeedback } from "shared/ui/press";
import { applyPanelScale } from "shared/ui/ui-scale";

/**
 * **Placeholder.** Draw order for the sheet's labels.
 *
 * Above both surfaces a label can be parented to in this file: a card's own background (`CARD_Z_INDEX`), and a footer
 * button's chrome face, which takes `button.ZIndex + 1`. A label at the same order as the surface it sits on is drawn
 * *underneath* it and vanishes - `ZIndex` is relative to a parent's group, so a child at a higher number draws over its
 * parent's own background but not over a same-numbered sibling. One number for the whole sheet, because no label here is
 * nested inside another label's stack.
 */
const LABEL_Z_INDEX = 6;

/**
 * **Placeholder.** Draw order for a card.
 *
 * Below `LABEL_Z_INDEX` so the card's own labels sit above its background, and above the sheet's face so the cards are
 * drawn on the sheet rather than behind it. **One number, not a stack** (item 215): the card is a single object now, where
 * the chrome put a shadow at this order and a face at `+1`, and the rarity ring took a third order on top of both.
 */
const CARD_Z_INDEX = 3;

/** The one phase the picker belongs to. A client cannot import the server's `RoundPhase`. */
const PHASE_WAITING = "Waiting";

// #region geometry

/** **Placeholder.** Height of the title/countdown band, in pixels. */
const HEADER_HEIGHT = 44;

/** **Placeholder.** Card width, in pixels. Equal for every card, so a longer offer reflows the row rather than the cards. */
const CARD_WIDTH = 200;

/**
 * **Placeholder.** Card height, in pixels: a name, a 126-pixel ball, a rarity line, the gaps between them, and the room around
 * that block.
 *
 * The block is `20 + 4 + 126 + 4 + 18 = 172` - each label is its type size plus `SPACING.xs`, see `label` - and the card pads
 * `12` at the top and the bottom, so `222` leaves the **26 px of residual** the card had at `180`. The card's list is
 * vertically centred, so that is 13 above the name and 13 below the rarity.
 *
 * **History, because this number has moved three times for three different reasons.** `190` with 8-pixel padding gave a
 * residual of 44 and the name read as pressed against the card's top edge, so item 217 raised it to `220`. Item 218's
 * screenshot pass then cut it to `180` - the card is the button now, so the plate that needed the extra room is gone. **This
 * round adds the 42 pixels the ball grew** (`CARD_BALL` 84 -> 126) and nothing else, which is why the residual is held at
 * 26 rather than restored to item 217's 66: the proportion that matters is the space around the ball, and it is unchanged.
 */
const CARD_HEIGHT = 222;

/**
 * **Placeholder.** Extra height the card band needs beyond one card, in pixels.
 *
 * A horizontal `ScrollingFrame` draws its scrollbar *inside* its own box, so a band exactly as tall as a card clips the
 * bottom of every card by the bar's thickness. This is that thickness plus a hair, and it is the whole reason the first
 * build's cards looked cut off.
 */
const CHOICES_SCROLLBAR_ROOM = SPACING.sm;

/**
 * **Placeholder.** Diameter of the ball inside a card, in pixels.
 *
 * **50% larger than the 84 items 226-233 shipped** (item 234). At `84` the drawing read as a badge on the card rather than as
 * the ball the card is offering - the icon is the only part of the card a player is actually choosing between, and it was the
 * smallest thing on it.
 *
 * The icon is not sized here: `attachBallIcon` draws it at `UDim2.fromScale(1, 1)` inside this frame, so the drawing grows
 * with the circle and there is no second number to keep in step.
 */
const CARD_BALL = 126;

/**
 * **Placeholder.** Height of one footer button: the taller of its two stacks of lines, plus the room around it.
 *
 * The taller stack is `Reroll`'s - a `20`-pixel cost row, a `20`-pixel name and an `18`-pixel reason, **58** in all - and the
 * button's face is `FOOTER_HEIGHT` less `CHUNKY_CONTROL_DEPTH` (6). At `64` that left the face exactly 58 tall and therefore
 * **zero residual**: the reason caption sat on the face's bottom edge, which is what the screenshot shows as `random per round`
 * touching the sheet. `72` gives the face 66 and the stack 8 (item 217).
 */
const FOOTER_HEIGHT = 72;

/** **Placeholder.** Padding above and below the sheet's contents, in pixels. */
const SHEET_PADDING = SPACING.md;

/**
 * **Placeholder.** Padding to the left and right of the sheet's contents, in pixels.
 *
 * **Larger than the vertical padding, and the sheet's width is derived from it** (item 218). The card row is
 * `CARD_WIDTH * PICKER_OPTION_COUNT + BAND_GAP * 2 = 616` wide, and the sheet used to be exactly `row + SHEET_PADDING * 2` -
 * so the row filled its band edge to edge and the outermost cards sat 12 px from the sheet's face, behind a 6-pixel border.
 * The measured screenshot gap was 13 device pixels, which reads as the panel's frame touching the cards.
 */
const SHEET_PADDING_X = SPACING.lg;

/**
 * **Placeholder.** Gap between each band's own contents and the band's edge, in pixels.
 *
 * **This is what stops the card row clipping its own outline.** A `ScrollingFrame` clips its descendants, so a card laid out
 * at the band's `x = 0` has the outer half of its centred `UIStroke` cut away - the outer cards would read as thinner-edged
 * than the middle one. Eight pixels of band padding puts every stroke inside the clip.
 */
const BAND_GUTTER = SPACING.sm;

/** **Placeholder.** Gap between the three bands, in pixels. */
const BAND_GAP = SPACING.sm;

/**
 * **Placeholder.** Border weight of an unselected card.
 *
 * Equal to `CHUNKY_CONTROL_STROKE`, so a picker card and a footer button draw the same weight of edge. It was `1` while the
 * card also carried `applyChunkyChrome`'s 3-pixel near-black outline **and** `addChunkyRing`'s hairline - a hairline was all
 * that was left for the ring because the black outline was doing the work of being an edge. With both gone this stroke *is*
 * the card's edge and its rarity at once, and 1 pixel of a mid-grey cannot carry a colour across a 200-pixel card
 * (item 215).
 */
const CARD_STROKE = 3;

/** **Placeholder.** Border weight of the selected card. Thicker, not larger: a size change would reflow the row. */
const CARD_STROKE_SELECTED = 5;

/*
 * The disabled fade is no longer a constant here. `dimChunkyChrome` carries its own wash (0.45), and the two numbers
 * disagreeing is exactly how a screen ends up with one button dimmer than another - see `shared/ui/chunky-chrome`.
 */

/** **Placeholder.** Seconds after which an unanswered call stops blocking the buttons. */
const REPLY_TIMEOUT_SECONDS = 10;

/**
 * **Placeholder.** Sheet width, in pixels: one full row of cards plus the gaps and padding around it.
 *
 * Declared after the parts it measures, because it is a derivation rather than a knob — changing a card width or a gap must
 * move the sheet with it, and a second literal would be the thing that silently stopped matching.
 */
const SHEET_WIDTH =
	CARD_WIDTH * PICKER_OPTION_COUNT + BAND_GAP * (PICKER_OPTION_COUNT - 1) + BAND_GUTTER * 2 + SHEET_PADDING_X * 2;

/** **Placeholder.** How far the small diamond is rotated, in degrees. A square at 45 degrees is the shape without an asset. */
const DIAMOND_ROTATION = 45;

/** **Placeholder.** Side length of that diamond, in pixels. */
const DIAMOND_SIZE = 10;

// #endregion

/** One rendered card, kept whole so the selection pass cannot mark the wrong button. */
interface BallCard {
	readonly ballId: string;
	/** The card itself, and its only surface: the selection pass repaints this rather than a plate. */
	readonly button: TextButton;
	/** The card's one `UIStroke` - its edge and its rarity, restyled to the selection colour when marked. */
	readonly stroke: UIStroke;
	readonly nameLabel: TextLabel;
}

/**
 * The `Waiting`-phase ball picker: a title, a countdown, one card per offered ball, and two footer buttons.
 *
 * ```
 * BallPicker                       (vertical UIListLayout)
 *   Header                         (horizontal: title left, countdown right)
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
 *
 * ## One stroke per card, no plate (item 215)
 *
 * The cards were `applyChunkyChrome`'s five-layer control — a shadow strip, an inset face, a 3-pixel near-black outline on
 * that face, and `addChunkyRing`'s second stroke inside it — which is **four visible edges on one 200-pixel card**, three
 * times a row, under a sheet that already has its own outline. The complaint was "excessive layering", and the layer count
 * was the whole of it: every one of those layers was a deliberate decision from an earlier round (117, 118, 122).
 *
 * **A picker card is a choice, not a button on a surface.** The press a player makes on it *is* the selection, so its
 * feedback is the fill and the stroke colour changing — not a face sinking into a plate that exists only to be sunk into.
 * The chrome went, the ring went, and the card's single `UIStroke` now carries both its edge and its rarity.
 *
 * **The footer keeps its chrome, deliberately.** Those two buttons are pressed for an *action*, one of them is disabled with
 * a reason, and `setRaised` + `dimChunkyChrome` are the two states they need. The trade is real and it belongs here rather
 * than in a report nobody re-reads: the footer has more layers than the cards because it does more.
 */
@Controller()
export class PickerController implements OnStart {
	private readonly theme: Theme = chunkyDarkTheme();

	/**
	 * The sheet's type scale: every variant one step larger than the game scale.
	 *
	 * Same table the store and the inventory use, for the same reason - one decision, one table, and the bands that size
	 * themselves from a label's line height grow with it. Read `typographyOneStepUp`.
	 */
	private readonly type = typographyOneStepUp();
	private readonly player = Players.LocalPlayer;

	private phase = "unknown";
	private mainFrame?: Frame;
	private titleLabel?: TextLabel;
	private countdownLabel?: TextLabel;
	private choices?: ScrollingFrame;
	private loadingLabel?: TextLabel;
	private allBallsButton?: GuiButton;
	private allBallsReason?: TextLabel;
	private rerollButton?: GuiButton;
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
	 * Shows the panel only in `Waiting` **and only when this client has an offer for this window** (item 212).
	 *
	 * ## Why the phase alone was wrong
	 *
	 * It read `frame.Visible = phase === "Waiting"`, which is a statement about the round rather than about this player. The
	 * offer is not implied by the phase: `openOffers` sends one only to players in `enrolledUserIds`, and a client that joins
	 * during `Waiting` was not enrolled (the window closed at the end of `Intermission`), so no `PickerOpen` is ever fired at
	 * them. That client saw an **empty panel with a countdown and no cards** for the rest of the phase - which reads as "pick a
	 * ball" while offering nothing to pick.
	 *
	 * The panel is the state of "I have an offer", not the state of "the round is between rounds". `offer !== undefined` is that
	 * fact, and it is the same field `renderCards` fills.
	 *
	 * ## One rule for the mount read and for every change
	 *
	 * Same reason the store keeps one: two copies of "when is this visible" is how a panel ends up on screen in a phase the other
	 * copy thought was fine. `refreshVisibility` is therefore called from `applyPhase` *and* from `onOffer` - the offer can
	 * arrive after the phase read, and the phase can change after the offer arrived.
	 *
	 * Leaving the phase also **drops the offer**. The countdown is not a timer this file owns - it informs, and the phase change
	 * is what ends the window. A stale offer that reappeared on the next entry would be a set of cards the server has already
	 * discarded.
	 */
	private applyPhase(phase: string): void {
		this.phase = phase;

		const frame = this.mainFrame;
		if (frame === undefined) {
			return;
		}

		if (phase !== PHASE_WAITING) {
			this.offer = undefined;
			this.chosen = undefined;
			this.clearCards();
			this.setLoading(true);
		}

		this.refreshVisibility();
	}

	/**
	 * The one place the panel is shown or hidden: **`Waiting` *and* an offer.**
	 *
	 * Called when the phase changes and when an offer arrives, because either can be the last of the two facts to land: a client
	 * that starts during `Waiting` reads the phase first and receives its offer a moment later, and a client whose offer arrived
	 * during the tail of `Intermission` has the phase land second. Both orders end in the same visibility.
	 */
	private refreshVisibility(): void {
		const frame = this.mainFrame;
		if (frame === undefined) {
			return;
		}

		frame.Visible = pickerVisible(this.phase, this.offer !== undefined);
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
		// **The arrive-second case.** On a client that joined during `Waiting` the phase read happened at mount with no offer, so
		// nothing was shown; this is the moment the panel earns its visibility.
		this.refreshVisibility();
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
	 * **One object, one stroke** (item 215). The card *is* the button: `paint.card` fills it, a single `UIStroke` in the
	 * rarity colour draws its edge, and it takes the same corner radius as a footer button. `shared/ui/tile.ts` builds its
	 * cards the same way, for the same reason - with no shadow plate there is nothing to invert the stack for, so the
	 * button's own background is the face.
	 *
	 * The selection state is a **border and a fill**, never a size: a card that grew on selection would reflow every sibling
	 * in the row, which for a nine-card premium offer is a visible jump under the pointer that just clicked it.
	 *
	 * ## The vertical room (items 217, 234)
	 *
	 * `CARD_HEIGHT` (222) and 12-pixel top and bottom padding leave **26 pixels of residual** around the 172-pixel block, and the
	 * vertically centred list splits them evenly: 13 above the name, 13 below the rarity. The residual is what this card had at
	 * `180` with an 84-pixel ball; the ball grew and the frame around it grew with it, so the *proportion* is unchanged.
	 */
	private buildCard(parent: Instance, ballId: string, order: number): BallCard {
		const rarity: Rarity = rarityOfBall(ballId) ?? "common";
		const tint = this.theme.colors.rarity[rarity];

		const button = new Instance("TextButton");
		button.Name = `Card_${order}`;
		button.Size = UDim2.fromOffset(CARD_WIDTH, CARD_HEIGHT);
		button.BackgroundColor3 = this.theme.paint.card.color;
		button.BackgroundTransparency = this.theme.paint.card.transparency;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Text = "";
		button.ZIndex = CARD_Z_INDEX;
		button.LayoutOrder = order;
		button.Parent = parent;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, SPACING.sm);
		corner.Parent = button;

		// The card's only stroke, and its only rarity indicator. `Border` mode is named because this object is a
		// `TextButton`: left contextual it would stroke the button's (empty) glyphs rather than its edge.
		const stroke = new Instance("UIStroke");
		stroke.Color = tint;
		stroke.Thickness = CARD_STROKE;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		stroke.Parent = button;

		// **The scale is the whole press state now.** `setRaised` was the pressed cue while the card had a plate to cover;
		// one flat surface has nothing to sink into, so the press is the hover/press `UIScale` every other control in this
		// tree already has, and it leaves the card's layout box alone so the row cannot shift under the pointer.
		attachPressFeedback(button);

		// A card is a button, so it clicks like one. Attached here rather than at the call site because the cards are
		// built in a loop: one call covers every card in every offer, including the nine-card premium set.
		attachClickSound(button);

		// **Twelve top and bottom, eight at the sides** (item 217). The block inside is `130` pixels of fixed-height children, so
		// the padding and the centring share whatever the card height leaves: `220 - 12 - 12 - 130 = 66`, split 33/33 by
		// `VerticalAlignment = Center` below. The sides stay at `sm` because the card's width is the row's width - a wider gutter
		// would only squeeze the ball.
		const cardPadding = new Instance("UIPadding");
		cardPadding.PaddingTop = new UDim(0, SPACING.md);
		cardPadding.PaddingBottom = new UDim(0, SPACING.md);
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

		// 2. The ball placeholder: a tinted circle, not an invented asset, and not in a box of its own.
		const ball = new Instance("Frame");
		ball.Name = "Ball";
		ball.Size = UDim2.fromOffset(CARD_BALL, CARD_BALL);
		// **The ball's own colour, or its rarity tint when the id has none** (item 226). The stroke below stays the rarity, so a
		// card still says which tier it is while the circle says which ball it is - the same split the store's cards use.
		ball.BackgroundColor3 = colorForBall(ballId) ?? tint;
		ball.BackgroundTransparency = 0.1;
		ball.BorderSizePixel = 0;
		// **Above the card, not at the default 1** (item 218). The ball was occupying its 84-pixel slot and painting nothing:
		// the two labels around it are at `LABEL_Z_INDEX` and showed, while this frame at the default behaved as if it were
		// behind the card's own fill - the signature of `ZIndexBehavior.Global`, where a child at a lower `ZIndex` than its
		// parent is drawn behind the parent's background. `CARD_Z_INDEX + 1` is correct under either behaviour and is one
		// number rather than a guess at the gui's setting.
		ball.ZIndex = CARD_Z_INDEX + 1;
		ball.LayoutOrder = 2;
		ball.Parent = button;

		const ballCorner = new Instance("UICorner");
		ballCorner.CornerRadius = new UDim(1, 0);
		ballCorner.Parent = ball;

		// **The ball's own drawing, inside the circle the colour fills** (item 233). The colour stays as the fill behind it, so a
		// card whose icon has not resolved is still the card item 226 shipped rather than a hole. `shared/ui/ball-swatch.ts`
		// explains why the icon is a child rather than a replacement, and why the `UICorner` above does not clip it.
		attachBallIcon(ball, ballId);

		// **One line, on the first card of every offer** (item 218). The slot is reserved and nothing paints, so the only
		// facts that distinguish "not drawing" from "drawing somewhere else" are the resolved box and the paint properties.
		// `AbsoluteSize` is read on the next resumption because a layout pass has to run first.
		if (order === 1) {
			task.defer(() => {
				print(
					`[Picker] card ball bg=${tostring(ball.BackgroundColor3)} transparency=${ball.BackgroundTransparency} z=${ball.ZIndex} visible=${tostring(ball.Visible)} size=${tostring(ball.AbsoluteSize)} at=${tostring(ball.AbsolutePosition)}`,
				);
			});
		}

		// 3. The description slot: the rarity, because no ball has a power, an effect or any other text to put here. Kept
		// alongside the stroke rather than replaced by it - a colour alone is not a rarity for a reader who cannot separate
		// the four, and the caption is the one indicator that survives that.
		const description = this.label(button, rarityLabel(rarity), "caption", "secondary", 3);
		description.TextXAlignment = Enum.TextXAlignment.Center;

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
	 *
	 * The stroke's rarity colour is recomputed from `card.ballId` rather than remembered on the card, for the same reason
	 * the mark is by id: an offer can hold the same ball three times, and a remembered colour is a second copy of
	 * `rarityOfBall` that a re-offer could leave stale.
	 */
	private markChosen(ballId: string | undefined): void {
		for (const card of this.cards) {
			const selected = ballId !== undefined && card.ballId === ballId;

			// **Selection is one fill, one stroke and one text colour, and nothing else** (item 215). It used to be
			// `setRaised` plus a shadow that followed the face, because the card had two plates; a single card has neither,
			// so the whole statement is the four lines below and there is no second place for the state to disagree.
			card.button.BackgroundColor3 = selected ? this.theme.colors.accent : this.theme.paint.card.color;
			card.stroke.Color = selected
				? this.theme.colors.onAccent
				: this.theme.colors.rarity[rarityOfBall(card.ballId) ?? "common"];
			card.stroke.Thickness = selected ? CARD_STROKE_SELECTED : CARD_STROKE;
			card.nameLabel.TextColor3 = selected ? this.theme.colors.onAccent : this.theme.colors.textPrimary;
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
			// **The wash goes through the chrome, not through the button.** `BackgroundTransparency` on the button no longer
			// paints anything - the plates are its children now - so the old line would have left a disabled button looking
			// fully enabled. `dimChunkyChrome` walks the face and its labels instead.
			dimChunkyChrome(this.allBallsButton, true);
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
		dimChunkyChrome(rerollButton, !enabled);

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
		label.TextColor3 = remaining <= 3 ? this.theme.colors.error : this.theme.colors.textSecondary;

		// **The window closes on its own deadline, not on the phase change (item 149).** The two used to be the same instant,
		// so hiding the panel was `applyPhase`'s job alone. `PICKER_WINDOW_SECONDS` is shorter than `WAITING_SECONDS` now, and
		// the last stretch belongs to the countdown - a panel still on screen through it would be a set of cards the server has
		// already discarded, sitting in front of the 3-2-1. `Visible = false` also stops it taking clicks, which is the other
		// half of what closing means. The next `Waiting` re-shows it from `applyPhase`.
		if (remaining <= 0) {
			this.mainFrame.Visible = false;
			print(`[Picker] closed deadline=${offer.deadline}`);
		}
	}

	// #endregion

	// #region construction

	private buildMainFrame(parent: Instance): Frame {
		// **The sheet, through the same builder as the store and the inventory.** Before this round the picker was the last
		// panel built by hand - a translucent card with a hairline outline - so a player who opened the store and then
		// reached the `Waiting` phase saw two different games.
		//
		// **An offset, not a share of the screen.** A 60%-wide sheet with three cards left a third of the panel empty on the
		// right, which reads as a card that failed to load; the reference's panel is only as wide as its content. The row of
		// `PICKER_OPTION_COUNT` cards *is* the content, and a premium offer wider than that scrolls inside this width.
		// `applyPanelScale` supplies the ceiling on a narrow window, where an offset would otherwise overflow - it draws the whole
		// composition smaller rather than clamping the box, which would squeeze every band inside it (item 160).
		//
		// **Clipping, deliberately, and this is the one panel that does.** The bands are fixed-height and their contents are
		// laid out rather than positioned, so a child taller than its band escapes the sheet entirely - the first build had a
		// footer line drawn below the panel. `buildChunkyPanel` exposes that as a flag instead of deciding it.
		const panel = buildChunkyPanel({
			name: "BallPicker",
			parent,
			size: new UDim2(
				0,
				SHEET_WIDTH,
				0,
				HEADER_HEIGHT + CARD_HEIGHT + CHOICES_SCROLLBAR_ROOM + FOOTER_HEIGHT + BAND_GAP * 2 + SHEET_PADDING * 2,
			),
			autoHeight: true,
			clipsDescendants: true,
		});

		const frame = panel.frame;
		frame.Visible = false;

		// **Vertical and horizontal are separate numbers here** (item 218). `SHEET_PADDING_X` is what the sheet's width is
		// derived from, and it is the only thing standing between the card row and the panel's own border.
		const padding = new Instance("UIPadding");
		padding.PaddingTop = new UDim(0, SHEET_PADDING);
		padding.PaddingBottom = new UDim(0, SHEET_PADDING);
		padding.PaddingLeft = new UDim(0, SHEET_PADDING_X);
		padding.PaddingRight = new UDim(0, SHEET_PADDING_X);
		padding.Parent = panel.surface;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, BAND_GAP);
		layout.Parent = panel.surface;

		this.buildHeader(panel.surface);
		this.buildChoices(panel.surface);
		this.buildFooter(panel.surface);

		applyPanelScale(frame, "picker");
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

		// The same gutter the cards get, so the title's left edge and the first card's left edge are one line (item 218).
		const gutter = new Instance("UIPadding");
		gutter.PaddingLeft = new UDim(0, BAND_GUTTER);
		gutter.PaddingRight = new UDim(0, BAND_GUTTER);
		gutter.Parent = header;

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
		choices.ScrollBarImageColor3 = this.theme.colors.border;
		choices.ScrollingDirection = Enum.ScrollingDirection.X;
		choices.CanvasSize = UDim2.fromOffset(0, 0);
		choices.AutomaticCanvasSize = Enum.AutomaticSize.X;
		choices.ElasticBehavior = Enum.ElasticBehavior.Never;
		choices.LayoutOrder = 2;
		choices.Parent = parent;

		// **The gutter that keeps the cards off the clip** (item 218). A `ScrollingFrame` clips its descendants, and the row is
		// exactly as wide as the band's content: without this every outer card's centred `UIStroke` loses its outer half.
		const gutter = new Instance("UIPadding");
		gutter.PaddingLeft = new UDim(0, BAND_GUTTER);
		gutter.PaddingRight = new UDim(0, BAND_GUTTER);
		gutter.Parent = choices;

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

		// The same gutter as the header and the cards: one left edge for the whole sheet (item 218).
		const gutter = new Instance("UIPadding");
		gutter.PaddingLeft = new UDim(0, BAND_GUTTER);
		gutter.PaddingRight = new UDim(0, BAND_GUTTER);
		gutter.Parent = footer;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.sm);
		layout.Parent = footer;

		const allBalls = this.footerButton(footer, "AllBalls", 1);
		// White-on-accent, from the theme's own slot. `textPrimary` here is dark-on-blue, which is what the first build shipped.
		const free = this.label(allBalls.face, "FREE", "caption", "onAccent", 1);
		free.TextColor3 = this.theme.colors.success;
		this.label(allBalls.face, "All Balls", "body1", "onAccent", 2);
		this.allBallsReason = this.label(allBalls.face, "random per round", "caption", "onAccent", 3);
		this.allBallsButton = allBalls.button;

		const reroll = this.footerButton(footer, "Reroll", 2);

		// The cost line: a small diamond and the number. A square rotated 45 degrees is a diamond without an asset, which is
		// the same rule the ball placeholder follows: neither invents an art id.
		const costRow = new Instance("Frame");
		costRow.Name = "Cost";
		// **Explicit height, auto width.** `AutomaticSize.XY` around a child whose height is `1, 0` is circular — the row asks
		// the label how tall it is and the label asks the row — which squeezed the cost line into a few pixels at the top.
		costRow.Size = new UDim2(0, 0, 0, this.type.body2.size + SPACING.xs);
		costRow.AutomaticSize = Enum.AutomaticSize.X;
		costRow.BackgroundTransparency = 1;
		costRow.LayoutOrder = 1;
		costRow.Parent = reroll.face;

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
		diamond.BackgroundColor3 = this.theme.colors.coin;
		diamond.BorderSizePixel = 0;
		diamond.LayoutOrder = 1;
		diamond.Parent = costRow;

		const diamondCorner = new Instance("UICorner");
		diamondCorner.CornerRadius = new UDim(0, 1);
		diamondCorner.Parent = diamond;

		const cost = this.label(costRow, tostring(REROLL_COST_COINS), "body2", "onAccent", 2);
		cost.Size = new UDim2(0, 0, 1, 0);
		cost.AutomaticSize = Enum.AutomaticSize.X;
		cost.TextColor3 = this.theme.colors.coin;
		this.rerollCostLabel = cost;

		this.label(reroll.face, "REROLL", "body1", "onAccent", 2);
		// **The caption is a reason, never the button's own name.** The first build wrote "REROLL" into this label as well, so
		// the footer said it twice — once inside the button and once below the sheet, where the overflow landed.
		this.rerollReason = this.label(reroll.face, "", "caption", "onAccent", 3);

		reroll.button.Activated.Connect(() => this.reroll());
		this.rerollButton = reroll.button;
	}

	/**
	 * A footer button: half the row, a nested vertical list for its lines, no engine pressed-tint, and the chunky plates.
	 *
	 * **Returns the chrome rather than the button**, because both callers put their lines inside it: the chrome turns the
	 * button into a transparent hit area, so a label parented to the button itself would be drawn underneath the face.
	 */
	private footerButton(parent: Instance, name: string, order: number): ChunkyChrome {
		const button = new Instance("TextButton");
		button.Name = name;
		button.Size = new UDim2(0.5, -SPACING.xs, 1, 0);
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Text = "";
		button.LayoutOrder = order;
		button.Parent = parent;

		const chrome = applyChunkyChrome(button, {
			color: this.theme.colors.accent,
			shadowColor: shadowOf(this.theme.colors.accent),
			zIndex: CARD_Z_INDEX,
			corner: SPACING.sm,
		});

		// Both footer buttons - `All Balls` and `Reroll` - come through here, so one call covers the pair.
		attachClickSound(button);

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Parent = chrome.face;

		return chrome;
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
		label.Size = new UDim2(1, 0, 0, this.type[variant].size + SPACING.xs);
		label.BackgroundTransparency = 1;
		label.Font = FONT;
		label.TextSize = this.type[variant].size;
		// `onAccent` for text inside an accent-filled button: `textPrimary` on the accent is dark-on-blue, the low-contrast
		// pairing the first build shipped. The theme has a slot for exactly this and it was not being used.
		label.ZIndex = LABEL_Z_INDEX;
		// The outline every label on the sheet carries - `shared/ui/text.ts`'s one helper, the same stroke the store's
		// labels get. Without it a pale label on a `h4`-scale title reads as washed out against charcoal.
		outlineText(label);

		label.TextColor3 =
			colour === "primary"
				? this.theme.colors.textPrimary
				: colour === "onAccent"
					? this.theme.colors.onAccent
					: this.theme.colors.textSecondary;
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
