import { ReplicatedStorage, TweenService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { REMOTES_FOLDER_NAME, ROUND_PAYOUT_REMOTE_NAME } from "shared/remotes";
import { PLACEMENT_BONUS_COINS, RoundPayoutMessage } from "shared/round-payout";
import { POST_GAME_SECONDS } from "shared/tuning";
import { getOrdinal } from "shared/ordinal";
import { FONT, SPACING, TextVariant, TYPOGRAPHY } from "shared/ui/scale";
import { chunkyDarkTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { capToViewport } from "shared/ui/viewport";
import { playCoinSound } from "shared/ui/sounds";
import { CHUNKY_CONTROL_OUTLINE, CHUNKY_CONTROL_STROKE } from "shared/ui/chunky-chrome";
import { buildChunkyPanel, CHUNKY_PANEL_CORNER } from "shared/ui/chunky-panel";
import { outlineText, TEXT_OUTLINE_THICKNESS } from "shared/ui/text";
import { coinIconUri, reportCoinIconLoad } from "shared/ui/coin";

/*
 * # Why this panel was rebuilt in the house style
 *
 * Its first version was a "sleek fintech" card: near-black glass at 0.1 transparency, a hairline gold border, GothamMedium at
 * a light weight. It was internally consistent and wrong. **The visual identity of this game is a contract** - thick
 * near-black outlines, an offset shadow plate, saturated fills, outlined poster type - and a payout screen is one of the
 * most-seen surfaces in the game. A panel that speaks a different language reads as a different product, and the player
 * meets it right after a round ends, which is the moment the game is trying hardest to look like itself.
 *
 * So the paint came across to Chunky and the *motion* did not move: the reveal driver, the counting `TweenService`s, the
 * derived hold and the self-destructing frame are unchanged from the version that was already tuned. That split is the point
 * worth keeping - a style is a set of colours, weights and offsets, and none of those are animation decisions.
 */

/**
 * **Placeholder.** The poster weight the chunky titles use.
 *
 * A local literal rather than a second export from `scale.ts`, because that module deliberately exports **one** font
 * (`FONT`, GothamMedium) and a second one there would be a second answer to "what font is this game". `GothamBlack` is this
 * family's *display* weight, and it is already a local constant in `chunky-button` (`TITLE_FONT`) and a local literal in
 * `leaderboard-controller` for the same three jobs: a panel title, a rank and a number that is the point of the screen.
 */
const TITLE_FONT = Enum.Font.GothamBlack;

// #region geometry

/** **Placeholder.** The panel's size in pixels. `capToViewport` clamps it on a phone, so this is a desktop measure. */
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 236;

/** **Placeholder.** Inner padding, in pixels. The sheet's own rhythm: one step of the ladder and a half. */
const PANEL_PADDING = SPACING.lg + SPACING.xs;

/**
 * Row geometry, in pixels, measured from the panel's top-left. Named so the stack reads as a list rather than as a column
 * of magic numbers, and so the panel's height is a consequence of its bands instead of a number that has to be re-guessed.
 */
const TITLE_TOP = PANEL_PADDING;
const BASE_ROW_TOP = TITLE_TOP + TYPOGRAPHY.h6.lineHeight + SPACING.sm;
const BONUS_ROW_TOP = BASE_ROW_TOP + TYPOGRAPHY.h6.lineHeight + SPACING.sm;
const BAR_TOP = BONUS_ROW_TOP + TYPOGRAPHY.h6.lineHeight + SPACING.sm;

/**
 * **Placeholder.** Height of the progress track, in pixels: **sixteen**, up from the hairline's four.
 *
 * The thin bar was the most obviously foreign thing in the fintech version - a 4-pixel rule with no edge. A chunky bar is a
 * *recessed well* with its own outline, and it needs enough height for `CHUNKY_CONTROL_STROKE` to read at the top and the
 * bottom of the fill without swallowing it.
 */
const BAR_HEIGHT = 16;

/** **Placeholder.** The balance plate's top edge, and its height derived from the two lines it holds. */
const BALANCE_PLATE_TOP = BAR_TOP + BAR_HEIGHT + SPACING.md;
const PLATE_PADDING = SPACING.sm + SPACING.xs;
const PLATE_HEIGHT =
	PLATE_PADDING + TYPOGRAPHY.overline.lineHeight + SPACING.xs + TYPOGRAPHY.h4.lineHeight + PLATE_PADDING;

/** The cap's baseline inside the plate, and the number's top edge below it. */
const BALANCE_LABEL_TOP = PLATE_PADDING;
const BALANCE_NUMBER_TOP = BALANCE_LABEL_TOP + TYPOGRAPHY.overline.lineHeight + SPACING.xs;

/** **Placeholder.** Diameter of the coin, in pixels. **The store's `COIN_SIZE`**, because it is the same coin. */
const COIN_SIZE = 20;

// #endregion

// #region timeline

/**
 * The animation's budget, and the one number it is derived from.
 *
 * **`POST_GAME_SECONDS` is the hard ceiling.** The payout is fired as `PostGame` begins and the phase is wiped into
 * `Intermission` five seconds later, with the wipe drawn *above* this layer - so a panel that outlived the phase would be cut
 * in half by a black cover mid-count. The hold is therefore computed backwards from the phase rather than written as `3` and
 * hoped for, and `PAYOUT_TAIL_SECONDS` is the margin that keeps the fade finishing before the wipe starts.
 *
 * This is the concrete thing the brief for this feature got wrong: it asked for a fade in, two counting labels, a bar, a
 * rolling balance **and then three seconds of hold**. Those add up to about six seconds, one more than the phase that shows
 * them.
 */
const FADE_IN_SECONDS = 0.2;
const FADE_OUT_SECONDS = 0.35;
/** **Placeholder.** How long the two earned-amount labels take to count up. */
const COUNT_SECONDS = 0.7;
/** **Placeholder.** When the balance starts rolling, relative to the panel appearing. Overlaps the count by design. */
const ROLL_START_SECONDS = 0.55;
/** **Placeholder.** How long the balance takes to roll. Short: a balance is a fact, not a slot machine. */
const ROLL_SECONDS = 0.7;
/** **Placeholder.** Clearance before the wipe, in seconds. */
const PAYOUT_TAIL_SECONDS = 0.2;

/** The stretch that must fit before the hold: whichever of the two parallel animations finishes last. */
const ANIMATION_SECONDS = math.max(COUNT_SECONDS, ROLL_START_SECONDS + ROLL_SECONDS);

/** Derived, never written: the stillness after the numbers land, inside the phase that is showing them. */
const HOLD_SECONDS = POST_GAME_SECONDS - FADE_IN_SECONDS - ANIMATION_SECONDS - FADE_OUT_SECONDS - PAYOUT_TAIL_SECONDS;

const FADE_IN_TWEEN = new TweenInfo(FADE_IN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const FADE_OUT_TWEEN = new TweenInfo(FADE_OUT_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In);
const COUNT_TWEEN = new TweenInfo(COUNT_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const ROLL_TWEEN = new TweenInfo(ROLL_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

// #endregion

/**
 * The post-round payout panel: a chunky sheet that counts the round's earnings up and rolls the new balance.
 *
 * ## Why the panel is destroyed rather than hidden
 *
 * Same rule as the elimination splash. One frame per round, kept invisible, is a leak that only appears after a long
 * session - and a reused frame would have to be reset field by field, which is a second description of the layout that can
 * disagree with the first. `Destroy()` at the end of the lifetime is the whole fix, and the lifetime is derived from
 * `POST_GAME_SECONDS` so a tween cannot outlive it.
 *
 * ## Why this controller decides nothing
 *
 * The numbers arrive in the payload: what was earned, in which place, and what the balance was before and after. The client
 * cannot recompute them - `grantCoins` publishes the new balance before this fires, so "before" exists only on the server -
 * and it must not propose them. This is a renderer.
 *
 * ## The roll, and why it is a tweened `NumberValue` rather than a `RenderStepped` loop
 *
 * A render loop is a connection that has to be disconnected at exactly the right moment on a panel that destroys itself,
 * and a missed disconnect is a permanent per-frame leak. `TweenService` interpolates on the engine's own clock, finishes on
 * its own, and is deleted with the instance it drives. The label is written from the value's `Changed` signal, so the text
 * and the tween cannot disagree - the same "one writer per fact" rule the server-side replicated values follow.
 *
 * ## Why the face is the shared builder and the inner bands are not
 *
 * The sheet is `buildChunkyPanel`, so its shadow offset, corner radius, outline weight and the "outline on the face only"
 * rule are the *same constants* the store and the inventory use; a copy of those numbers here would be a second description
 * of the house style that drifts the first time either is retuned. The inner bands are hand-built because they are
 * decoration: `applyChunkyChrome` is a **button** helper whose job is to make a hit area invisible behind a face, and using
 * it for a plate would drag a `GuiButton` into a place that must not be clickable.
 */
@Controller()
export class PayoutController implements OnStart {
	/** The panel currently on screen, if any. A payout arriving mid-animation replaces it rather than stacking on it. */
	private active?: Frame;

	/**
	 * The chunky direction, constructed once per controller.
	 *
	 * `chunkyDarkTheme()` and not `getTheme()`: the latter is the older HUD direction, and this panel is sheet chrome. The
	 * leaderboard makes the same choice for the same reason, which is what keeps the two overlays in one palette.
	 */
	private readonly theme: Theme = chunkyDarkTheme();

	public onStart(): void {
		// **Does the coin asset resolve? (item 154.)** Idempotent across the three controllers that draw one, so this and its
		// twins in the store and the toast produce a single `[Coin]` line per session. Asked before the remote is found, so a
		// session with no payout remote still reports the asset — the two facts are unrelated.
		reportCoinIconLoad();

		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, 10);
		if (folder === undefined) {
			warn(`[Payout] no ${REMOTES_FOLDER_NAME} folder — round payouts will not be shown.`);
			return;
		}

		const remote = folder.WaitForChild(ROUND_PAYOUT_REMOTE_NAME, 10);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[Payout] no ${ROUND_PAYOUT_REMOTE_NAME} remote — round payouts will not be shown.`);
			return;
		}

		// The payload is validated rather than trusted: an event argument arrives as `unknown`, and a malformed one would
		// otherwise put `nil` into a `TextLabel` and a tween target on the first frame.
		remote.OnClientEvent.Connect((message: unknown) => {
			const parsed = asPayoutMessage(message);
			if (parsed === undefined) {
				warn(`[Payout] ignored a malformed ${ROUND_PAYOUT_REMOTE_NAME} payload.`);
				return;
			}

			// **The coin sound hangs on this event rather than on a remote of its own.** One event, two effects — the panel
			// and the ear — which is the shape item 88 used for the hit sound. Fired before `show` so a panel that fails to
			// build cannot cost the player the confirmation, and only for a *valid* payload, so a malformed one is silent.
			//
			// Unthrottled: the server fires this once per round per player, from `RoundService.payOut`. See `playCoinSound`.
			playCoinSound();

			this.show(parsed);
		});

		print(`[Payout] mounted on the splash layer (hold=${HOLD_SECONDS}s of ${POST_GAME_SECONDS}s PostGame)`);
	}

	/**
	 * Builds one panel and starts its timeline.
	 *
	 * Local state only: the frame, the tweens and the driver values are all created here and destroyed with the frame, so
	 * two payouts in quick succession produce two independent panels - which cannot happen through the phase machine, and is
	 * still the cheapest thing to be true.
	 */
	private show(message: RoundPayoutMessage): void {
		this.active?.Destroy();

		const gui = getScreenGui("splash");
		const theme = this.theme;

		// **The shared builder, not a copy of its hierarchy.** It brings the offset shadow plate, the `6`-pixel outline on the
		// face only, the `12`-pixel corner radius and the centring anchor - every one of those is a house-style decision that
		// already has one home. What it does *not* bring is a fade, so the parts it returns are made invisible below and driven
		// by the reveal value along with everything else.
		const panel = buildChunkyPanel({
			name: "RoundPayout",
			parent: gui,
			size: UDim2.fromOffset(PANEL_WIDTH, PANEL_HEIGHT),
			// The sheet's face, from the theme rather than from the module default: `paint.panel` *is* `CHUNKY_PANEL_FACE`
			// (the theme says so), and naming the theme here is what makes a future retint of the sheet reach this panel.
			color: theme.paint.panel.color,
			cornerRadius: CHUNKY_PANEL_CORNER,
		});
		this.active = panel.frame;

		// The one `UISizeConstraint` recipe in the tree. It changes the *size* and never the placement: the builder anchors
		// the panel at its middle, so a clamped panel stays centred.
		capToViewport(panel.frame);

		const contentWidth = PANEL_WIDTH - PANEL_PADDING * 2;

		// Everything that fades is collected as it is built. The sheet's outline comes back on the face rather than as a
		// return value, so it is found once here - the alternative is a second builder that exists only to hand it over.
		const faded = new Array<GuiObject>();
		const strokes = new Array<UIStroke>();
		const surfaceStroke = panel.surface.FindFirstChildOfClass("UIStroke");
		if (surfaceStroke !== undefined) {
			strokes.push(surfaceStroke);
		}

		const title = this.label(
			strokes,
			panel.surface,
			"Title",
			"ROUND EARNINGS",
			"h6",
			TITLE_FONT,
			theme.colors.textPrimary,
			3,
		);
		title.Position = UDim2.fromOffset(PANEL_PADDING, TITLE_TOP);
		title.Size = UDim2.fromOffset(contentWidth, TYPOGRAPHY.h6.lineHeight);
		faded.push(title);

		this.buildRows(panel.surface, contentWidth, message, faded, strokes);

		// ## The balance, on its own recessed plate
		//
		// The fintech version separated it with a hairline rule. A hairline is the one thing this language never draws: bands
		// are separated here by a **value step** - a darker plate with its own outline - which is the same move the store's
		// bands make. The plate is `paint.surface`, one step below the face, so the total reads as inset rather than raised.
		const plate = new Instance("Frame");
		plate.Name = "BalancePlate";
		plate.Position = UDim2.fromOffset(PANEL_PADDING, BALANCE_PLATE_TOP);
		plate.Size = UDim2.fromOffset(contentWidth, PLATE_HEIGHT);
		plate.BackgroundColor3 = theme.paint.surface.color;
		plate.BackgroundTransparency = 1;
		plate.BorderSizePixel = 0;
		plate.ZIndex = 3;
		plate.Parent = panel.surface;
		faded.push(plate);

		const plateCorner = new Instance("UICorner");
		plateCorner.CornerRadius = new UDim(0, CHUNKY_PANEL_CORNER - SPACING.xs);
		plateCorner.Parent = plate;

		// `CHUNKY_CONTROL_OUTLINE` - the family's own near-black, `rgb(20, 20, 20)` - at the control weight. An inner band only
		// has to separate two charcoals, so it carries the *edge* of the language without the sheet's depth.
		const plateStroke = new Instance("UIStroke");
		plateStroke.Color = CHUNKY_CONTROL_OUTLINE;
		plateStroke.Thickness = CHUNKY_CONTROL_STROKE;
		plateStroke.Transparency = 1;
		plateStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		plateStroke.Parent = plate;
		strokes.push(plateStroke);

		const balanceCap = this.label(
			strokes,
			plate,
			"BalanceCap",
			"NEW BALANCE",
			"overline",
			FONT,
			theme.colors.textSecondary,
			4,
		);
		balanceCap.Position = UDim2.fromOffset(PLATE_PADDING, BALANCE_LABEL_TOP);
		balanceCap.Size = UDim2.fromOffset(contentWidth - PLATE_PADDING * 2, TYPOGRAPHY.overline.lineHeight);
		faded.push(balanceCap);

		// **The coin, at the store's own parameters — now the store's own icon (item 154).** `COIN_SIZE` is the store's
		// `COIN_SIZE` and the picture is `coinIconUri()`, so the coin beside a balance is literally the coin beside a price.
		// The store's dot has **no** outline because it lives inside a saturated price pill; this one sits on a charcoal plate
		// at the same 20 pixels next to the largest number on screen, where an edge is what makes it a coin rather than a
		// spot — so it **keeps** `colors.shadow` at the text-outline weight, drawn on the image exactly as it was drawn on the
		// circle. The alternative (drop it because the icon has its own edge) would have made this panel disagree with the
		// toast, which keeps its chunky outline for the same reason this one keeps its shadow.
		const coin = new Instance("ImageLabel");
		coin.Name = "Coin";
		coin.AnchorPoint = new Vector2(0, 0.5);
		coin.Position = UDim2.fromOffset(PLATE_PADDING, BALANCE_NUMBER_TOP + TYPOGRAPHY.h4.lineHeight / 2);
		coin.Size = UDim2.fromOffset(COIN_SIZE, COIN_SIZE);
		coin.BackgroundTransparency = 1;
		coin.BorderSizePixel = 0;
		coin.Image = coinIconUri();
		coin.ScaleType = Enum.ScaleType.Fit;
		// **`ImageTransparency`, not `BackgroundTransparency`, is the fade.** The reveal driver below fades a `Frame` by its
		// background; on an `ImageLabel` the background is already transparent and the *image* is the ink, so this starts at
		// `1` and the driver moves this property. See `paint`.
		coin.ImageTransparency = 1;
		coin.ZIndex = 4;
		coin.Parent = plate;
		faded.push(coin);

		const coinStroke = new Instance("UIStroke");
		coinStroke.Color = theme.colors.shadow;
		coinStroke.Thickness = TEXT_OUTLINE_THICKNESS;
		coinStroke.Transparency = 1;
		coinStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		coinStroke.Parent = coin;
		strokes.push(coinStroke);

		const total = this.label(strokes, plate, "Total", "0", "h4", TITLE_FONT, theme.colors.coin, 4);
		total.Position = UDim2.fromOffset(PLATE_PADDING + COIN_SIZE + SPACING.sm, BALANCE_NUMBER_TOP);
		total.Size = UDim2.fromOffset(
			contentWidth - PLATE_PADDING * 2 - COIN_SIZE - SPACING.sm,
			TYPOGRAPHY.h4.lineHeight,
		);
		faded.push(total);

		this.animate(panel, faded, strokes, total, message);
	}

	/**
	 * The two earned-amount rows and the chunky progress bar.
	 *
	 * Everything it creates is pushed onto `faded`/`strokes` rather than returned: the caller's only interest is "what must be
	 * revealed", and a second return value would be a second list to keep in step with the first.
	 */
	private buildRows(
		surface: Frame,
		width: number,
		message: RoundPayoutMessage,
		faded: Array<GuiObject>,
		strokes: Array<UIStroke>,
	): void {
		const theme = this.theme;

		const base = this.label(
			strokes,
			surface,
			"BaseLabel",
			"PARTICIPATION",
			"body2",
			FONT,
			theme.colors.textSecondary,
			3,
		);
		base.Position = UDim2.fromOffset(PANEL_PADDING, BASE_ROW_TOP);
		// Same height as its value, not its own line height: both are centred in their box, and two boxes of different
		// heights sharing a top edge put the label two pixels off the baseline it belongs to.
		base.Size = UDim2.fromOffset(width * 0.6, TYPOGRAPHY.h6.lineHeight);
		faded.push(base);

		const baseValue = this.label(strokes, surface, "BaseValue", "+0", "h6", TITLE_FONT, theme.colors.coin, 3);
		baseValue.Position = UDim2.fromOffset(PANEL_PADDING, BASE_ROW_TOP);
		baseValue.Size = UDim2.fromOffset(width, TYPOGRAPHY.h6.lineHeight);
		baseValue.TextXAlignment = Enum.TextXAlignment.Right;
		faded.push(baseValue);

		// The place is in the label rather than in a second badge: `1ST` tells the player what the bonus was *for*, and
		// `shared/ordinal` already owns what "the right suffix" means.
		const bonusText =
			message.placement === 0
				? "PLACEMENT BONUS (NONE)"
				: `PLACEMENT BONUS (${string.upper(getOrdinal(message.placement))})`;

		const bonus = this.label(
			strokes,
			surface,
			"BonusLabel",
			bonusText,
			"body2",
			FONT,
			theme.colors.textSecondary,
			3,
		);
		bonus.Position = UDim2.fromOffset(PANEL_PADDING, BONUS_ROW_TOP);
		bonus.Size = UDim2.fromOffset(width * 0.7, TYPOGRAPHY.h6.lineHeight);
		faded.push(bonus);

		const bonusValue = this.label(strokes, surface, "BonusValue", "+0", "h6", TITLE_FONT, theme.colors.coin, 3);
		bonusValue.Position = UDim2.fromOffset(PANEL_PADDING, BONUS_ROW_TOP);
		bonusValue.Size = UDim2.fromOffset(width, TYPOGRAPHY.h6.lineHeight);
		bonusValue.TextXAlignment = Enum.TextXAlignment.Right;
		faded.push(bonusValue);

		// ## The bar
		//
		// The **trough** is a well, not a line: `paint.trough` (a value below every plate in the theme) with its own outline,
		// so an empty bar still reads as a slot cut into the panel. The **fill** is the coin colour with the same outline,
		// which is what makes a half-full bar look like a solid object in the well rather than a tint.
		const track = new Instance("Frame");
		track.Name = "BonusTrack";
		track.Position = UDim2.fromOffset(PANEL_PADDING, BAR_TOP);
		track.Size = UDim2.fromOffset(width, BAR_HEIGHT);
		track.BackgroundColor3 = theme.paint.trough.color;
		track.BackgroundTransparency = 1;
		track.BorderSizePixel = 0;
		track.ClipsDescendants = true;
		track.ZIndex = 3;
		track.Parent = surface;
		faded.push(track);

		const trackCorner = new Instance("UICorner");
		trackCorner.CornerRadius = new UDim(0, SPACING.xs);
		trackCorner.Parent = track;

		const trackStroke = new Instance("UIStroke");
		trackStroke.Color = CHUNKY_CONTROL_OUTLINE;
		trackStroke.Thickness = CHUNKY_CONTROL_STROKE;
		trackStroke.Transparency = 1;
		trackStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		trackStroke.Parent = track;
		strokes.push(trackStroke);

		const fill = new Instance("Frame");
		fill.Name = "BonusFill";
		// **Zero-width start, and the animation is untouched.** It is the same `Size` tween to the same fraction as the fintech
		// version; the outline that makes it chunky is drawn on whatever rectangle it currently has, so at frame zero there is
		// no area to outline and the well simply reads as empty.
		fill.Size = UDim2.fromScale(0, 1);
		fill.BackgroundColor3 = theme.colors.coin;
		fill.BackgroundTransparency = 1;
		fill.BorderSizePixel = 0;
		fill.ZIndex = 4;
		fill.Parent = track;
		faded.push(fill);

		const fillCorner = new Instance("UICorner");
		fillCorner.CornerRadius = new UDim(0, SPACING.xs);
		fillCorner.Parent = fill;

		const fillStroke = new Instance("UIStroke");
		fillStroke.Color = CHUNKY_CONTROL_OUTLINE;
		fillStroke.Thickness = CHUNKY_CONTROL_STROKE;
		fillStroke.Transparency = 1;
		fillStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		fillStroke.Parent = fill;
		strokes.push(fillStroke);

		// The counts and the bar are one animation each, driven by a value the label reads. `Changed` rather than a step in
		// the tween loop: the label follows the number even if the tween is interrupted, which a per-frame read would not.
		this.countUp(baseValue, message.base, COUNT_TWEEN);
		this.countUp(bonusValue, message.bonus, COUNT_TWEEN);

		const maxBonus = PLACEMENT_BONUS_COINS[0] ?? 1;
		TweenService.Create(fill, COUNT_TWEEN, { Size: UDim2.fromScale(message.bonus / maxBonus, 1) }).Play();
	}

	/**
	 * Drives one `+N` label from zero to its amount.
	 *
	 * The `+` is written here rather than held in a separate label: a sign that can be separated from its number is a sign
	 * that can end up beside the wrong one, and the whole row is one label and one value.
	 */
	private countUp(label: TextLabel, amount: number, info: TweenInfo): void {
		const driver = new Instance("NumberValue");
		driver.Value = 0;
		driver.Parent = label;

		driver.Changed.Connect(() => {
			label.Text = `+${tostring(math.floor(driver.Value))}`;
		});

		TweenService.Create(driver, info, { Value: amount }).Play();
	}

	/**
	 * The reveal, the roll and the teardown.
	 *
	 * ## Why the fade is one number instead of a tween per element
	 *
	 * A dozen elements fade, each from its own resting transparency - a tween per element is a dozen `TweenInfo`s to keep in
	 * step and a dozen chances to forget one, and a forgotten one is an element that pops in while the rest are still
	 * arriving. One `NumberValue` from `0` to `1` and a `mix` per property makes "revealed" a single fact: everything visible
	 * is `mix(invisible, resting, reveal)`, and the same driver runs the fade out backwards.
	 *
	 * **The chunky version is why the lists exist.** A sheet is not one rectangle: the face, the shadow plate behind it and
	 * the outline on the face fade on three *different* properties, and every inner band and bar carries an outline of its
	 * own. They are collected as they are built so this method never has to know the hierarchy - which is the thing that
	 * would drift the moment a band was added.
	 *
	 * ## Why the balance starts before the counts finish
	 *
	 * The brief's order - count the parts, then roll the total - needs about six seconds inside a five-second phase. A
	 * `0.55`s head start means the balance begins moving while the second amount is still landing, which reads as one gesture
	 * rather than as two animations queued behind each other, and it fits the phase.
	 */
	private animate(
		panel: { readonly surface: Frame; readonly shadow: Frame; readonly frame: Frame },
		faded: Array<GuiObject>,
		strokes: Array<UIStroke>,
		total: TextLabel,
		message: RoundPayoutMessage,
	): void {
		const reveal = new Instance("NumberValue");
		reveal.Value = 0;
		reveal.Parent = panel.frame;

		const paint = () => {
			const amount = reveal.Value;

			// The sheet's layers: the face and the plate behind it. Both are opaque in the theme, so "revealed" is `0` for
			// both, and the outline and every inner band's outline follow the same driver rather than their own tween.
			panel.surface.BackgroundTransparency = mix(1, 0, amount);
			panel.shadow.BackgroundTransparency = mix(1, 0, amount);

			for (const stroke of strokes) {
				stroke.Transparency = mix(1, 0, amount);
			}

			for (const element of faded) {
				// **Three cases, because an `ImageLabel`'s ink is not its background (item 154).** The coin became an image,
				// and `BackgroundTransparency` on one fades a box that is already invisible: the coin would have appeared fully
				// opaque on the first frame while the panel behind it was still nothing, which is the one element of this panel
				// that would have popped rather than faded.
				if (element.IsA("ImageLabel")) {
					element.ImageTransparency = mix(1, 0, amount);
				} else if (element.IsA("TextLabel")) {
					element.TextTransparency = mix(1, 0, amount);
				} else {
					element.BackgroundTransparency = mix(1, 0, amount);
				}
			}
		};

		reveal.Changed.Connect(paint);
		paint();

		TweenService.Create(reveal, FADE_IN_TWEEN, { Value: 1 }).Play();

		const balance = new Instance("NumberValue");
		balance.Value = message.balanceBefore;
		balance.Parent = panel.frame;
		balance.Changed.Connect(() => {
			total.Text = formatCoins(balance.Value);
		});
		total.Text = formatCoins(message.balanceBefore);

		task.delay(ROLL_START_SECONDS, () => {
			if (panel.frame.Parent === undefined) {
				return;
			}
			TweenService.Create(balance, ROLL_TWEEN, { Value: message.balanceAfter }).Play();
		});

		const outAt = FADE_IN_SECONDS + ANIMATION_SECONDS + HOLD_SECONDS;
		task.delay(outAt, () => {
			if (panel.frame.Parent === undefined) {
				return;
			}
			TweenService.Create(reveal, FADE_OUT_TWEEN, { Value: 0 }).Play();
		});

		task.delay(outAt + FADE_OUT_SECONDS, () => {
			panel.frame.Destroy();
			if (this.active === panel.frame) {
				this.active = undefined;
			}
		});
	}

	/**
	 * One label in the house style: the requested weight, a variant size, outlined glyphs and no background.
	 *
	 * ## Why the outline joins `strokes`
	 *
	 * `outlineText` builds the `UIStroke`, and a stroke's transparency is **its own property** - lowering a label's
	 * `TextTransparency` does not fade its outline with it, which is exactly why `elimination-splash-controller` tweens the
	 * word and its stroke as two targets. If the outlines were left out of the reveal driver, the first `0.2`s of every payout
	 * would be black glyph outlines with no glyphs inside them. The stroke is therefore collected here, at the one place a
	 * label is made, rather than rediscovered later by walking the children.
	 *
	 * ## Why `outlineText` is applied once, at creation, and never again
	 *
	 * The rolling balance changes its `Text` on almost every frame of the roll, and the obvious worry is that the outline
	 * would have to be reapplied. It does not: `UIStroke` in its default `Contextual` mode outlines **the glyphs that are
	 * currently drawn**, so a stroke added once follows every later string automatically. Re-applying would add a second
	 * `UIStroke`, and a `GuiObject` can only have one - the newer replaces the older, which is a silent no-op that would
	 * also leak an instance per frame.
	 */
	private label(
		strokes: Array<UIStroke>,
		parent: Instance,
		name: string,
		text: string,
		variant: TextVariant,
		font: Enum.Font,
		color: Color3,
		order: number,
	): TextLabel {
		const spec = TYPOGRAPHY[variant];

		const label = new Instance("TextLabel");
		label.Name = name;
		label.BackgroundTransparency = 1;
		label.BorderSizePixel = 0;
		label.Font = font;
		label.TextSize = spec.size;
		label.TextColor3 = color;
		label.Text = text;
		label.TextXAlignment = Enum.TextXAlignment.Left;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.ZIndex = order;
		label.TextTransparency = 1;
		label.Parent = parent;
		outlineText(label);

		const outline = label.FindFirstChildOfClass("UIStroke");
		if (outline !== undefined) {
			strokes.push(outline);
		}

		return label;
	}
}

/**
 * Validates an event argument into a payload.
 *
 * Every field is checked because the panel does arithmetic on them and tweens to them: a `nil` amount becomes `+nan`, and a
 * `nil` balance becomes a tween target the engine silently ignores. A malformed payload is refused whole rather than
 * repaired - half a payout breakdown is a worse thing to show than none.
 */
function asPayoutMessage(value: unknown): RoundPayoutMessage | undefined {
	if (!typeIs(value, "table")) {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const base = record.base;
	const bonus = record.bonus;
	const total = record.total;
	const placement = record.placement;
	const balanceBefore = record.balanceBefore;
	const balanceAfter = record.balanceAfter;

	if (
		!typeIs(base, "number") ||
		!typeIs(bonus, "number") ||
		!typeIs(total, "number") ||
		!typeIs(placement, "number") ||
		!typeIs(balanceBefore, "number") ||
		!typeIs(balanceAfter, "number")
	) {
		return undefined;
	}

	return { base, bonus, total, placement, balanceBefore, balanceAfter };
}

/**
 * A balance as a player reads one: `1,250`.
 *
 * Built from the digits backwards rather than with a pattern, because `string.format` in Luau has no grouping and the
 * grouping is the point - a five-digit balance without separators is a number you have to count.
 */
function formatCoins(amount: number): string {
	const digits = tostring(math.abs(math.floor(amount)));

	let grouped = "";
	let count = 0;
	for (let index = digits.size(); index >= 1; index--) {
		grouped = `${digits.sub(index, index)}${grouped}`;
		count++;
		if (count % 3 === 0 && index > 1) {
			grouped = `,${grouped}`;
		}
	}

	return amount < 0 ? `-${grouped}` : grouped;
}

/** Linear interpolation, in the one direction this file needs. */
function mix(from: number, to: number, amount: number): number {
	return from + (to - from) * amount;
}
