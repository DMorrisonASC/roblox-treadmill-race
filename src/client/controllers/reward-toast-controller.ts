import { ReplicatedStorage, TweenService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { REMOTES_FOLDER_NAME, REWARD_TOAST_REMOTE_NAME } from "shared/remotes";
import { RewardToastMessage } from "shared/rewards";
import { SPACING, TextVariant, TYPOGRAPHY } from "shared/ui/scale";
import { chunkyDarkTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { capToViewport } from "shared/ui/viewport";
import { CHUNKY_CONTROL_OUTLINE, CHUNKY_CONTROL_STROKE } from "shared/ui/chunky-chrome";
import { buildChunkyPanel } from "shared/ui/chunky-panel";
import { playCoinSound } from "shared/ui/sounds";
import { outlineText } from "shared/ui/text";

/** **Placeholder.** The poster weight the chunky titles use. A local literal for the same reason as in `payout-controller`. */
const TITLE_FONT = Enum.Font.GothamBlack;

// #region geometry

/** **Placeholder.** The toast's size in pixels. Wide enough for `PLACEMENT BONUS`-length labels and a three-digit amount. */
const TOAST_WIDTH = 240;
const TOAST_HEIGHT = 52;

/** **Placeholder.** Where the stack starts, as a share of the layer's height. Below the Roblox topbar, above the belt. */
const TOP_SCALE = 0.12;

/** **Placeholder.** Gap between stacked toasts, in pixels. */
const TOAST_GAP = SPACING.sm;

/** **Placeholder.** Inner padding, in pixels. */
const TOAST_PADDING = SPACING.md;

/** **Placeholder.** The amount's fixed column, in pixels. Fixed so the labels of two stacked toasts end at the same x. */
const AMOUNT_WIDTH = 70;

/** **Placeholder.** Diameter of the coin, in pixels. The store's `COIN_SIZE`, because it is the same coin. */
const COIN_SIZE = 20;

// #endregion

// #region timeline

/** **Placeholder.** How long the toast takes to arrive, in seconds. */
const SLIDE_IN_SECONDS = 0.25;
/** **Placeholder.** How long it stays at rest. Three seconds is the brief, and long enough to read two words and a number. */
const HOLD_SECONDS = 3;
/** **Placeholder.** How long it takes to leave. */
const SLIDE_OUT_SECONDS = 0.3;

/**
 * **Placeholder.** How far above its resting place the toast starts, in pixels.
 *
 * A distance rather than an "off screen" offset: the toast is anchored to the top of the layer, and a slide of slightly
 * less than its own height reads as arriving from behind the topbar regardless of how tall the screen is.
 */
const SLIDE_PIXELS = TOAST_HEIGHT + SPACING.md;

const SLIDE_IN_TWEEN = new TweenInfo(SLIDE_IN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const SLIDE_OUT_TWEEN = new TweenInfo(SLIDE_OUT_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In);

// #endregion

/**
 * The reward toast: a small chunky card near the top of the screen that says what was just paid.
 *
 * ## Why this is not the payout panel
 *
 * The payout is a *result* - it replaces the screen's attention for five seconds, and it breaks down a round. A toast is an
 * *interruption that must not interrupt*: 50 coins arriving while the player is choosing a ball must not cover the picker,
 * take a click, or make them wait. So it is one line high, it lives above the HUD and below the wipe, it holds for three
 * seconds, and **it is never `Active`** - no frame in this file can eat a click.
 *
 * ## Why it stacks instead of replacing
 *
 * Toasts are minutes apart in the shipped schedule (a 20-hour daily and a 15-minute stipend), so a collision is a
 * misconfiguration rather than an everyday case - but a `Destroy()` of the previous toast would *silently drop a reward
 * message*, which is the one thing a notification must not do. New toasts take the next slot down, and the list is only
 * ever appended and drained, so there is no reflow to get wrong.
 *
 * ## Why the fade is one driver value
 *
 * The card is three plates and six outlines once the strokes are counted, and `TextTransparency` does not fade a glyph's
 * `UIStroke` with it. One `NumberValue` from `0` to `1` and a `mix` per property keeps "revealed" a single fact, exactly as
 * in `payout-controller` - and it is the same reason that panel needed the trick.
 */
@Controller()
export class RewardToastController implements OnStart {
	private readonly theme: Theme = chunkyDarkTheme();

	/** The toasts on screen, in the order they arrived. Only ever appended and drained; the index is the stack slot. */
	private readonly live = new Array<Frame>();

	public onStart(): void {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, 10);
		if (folder === undefined) {
			warn(`[Toast] no ${REMOTES_FOLDER_NAME} folder — rewards will not be announced.`);
			return;
		}

		const remote = folder.WaitForChild(REWARD_TOAST_REMOTE_NAME, 10);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[Toast] no ${REWARD_TOAST_REMOTE_NAME} remote — rewards will not be announced.`);
			return;
		}

		// Validated, not trusted: an event argument arrives as `unknown`, and `1 + nil` on the first frame would be a
		// permanent error in this controller rather than a refused toast.
		remote.OnClientEvent.Connect((message: unknown) => {
			const parsed = asToastMessage(message);
			if (parsed === undefined) {
				warn(`[Toast] ignored a malformed ${REWARD_TOAST_REMOTE_NAME} payload.`);
				return;
			}

			// **The card always; the sound only when money moved.** A Studio preview (item 135) fires this same payload with
			// `preview = true` and grants nothing, so a coin sound there would announce coins that were never added — the one
			// thing a reward notification must not do. Everything else about the two paths is identical, which is why the flag
			// is a field on the payload rather than a second remote.
			//
			// Unthrottled and safe: the schedules behind it are 20 hours and 15 minutes, and `playtimeBaselineAtLoad` moves a
			// stale stipend stamp forward at load rather than paying it, so the two cannot land in the same second. See
			// `playCoinSound`.
			if (!parsed.preview) {
				playCoinSound();
			}

			this.show(parsed);
		});

		print(`[Toast] mounted on the splash layer (hold=${HOLD_SECONDS}s)`);
	}

	/**
	 * Builds one toast and starts its timeline.
	 *
	 * The slot is taken from `live.size()` at creation and never recomputed: a toast that leaves does not pull the ones below
	 * it upward. Reflowing would be prettier for a burst and is strictly worse for the real case, where a gap opening under a
	 * toast that is already fading out is more motion than the information deserves.
	 */
	private show(message: RewardToastMessage): void {
		const gui = getScreenGui("splash");
		const theme = this.theme;
		const slot = this.live.size();

		const panel = buildChunkyPanel({
			name: "RewardToast",
			parent: gui,
			size: UDim2.fromOffset(TOAST_WIDTH, TOAST_HEIGHT),
			color: theme.paint.panel.color,
		});

		// The builder centres every panel, because every panel before this one was an overlay over the middle of the screen.
		// A toast is the exception, and moving it is the caller's job rather than a second builder's.
		panel.frame.AnchorPoint = new Vector2(0.5, 0);
		const resting = new UDim2(0.5, 0, TOP_SCALE, slot * (TOAST_HEIGHT + TOAST_GAP));
		panel.frame.Position = resting;

		// **Nothing here may take a click.** A `Frame` is inert by default; saying so explicitly is what stops a later edit
		// from making the card a hit area by copying a property from a button.
		panel.frame.Active = false;
		panel.surface.Active = false;
		panel.shadow.Active = false;

		capToViewport(panel.frame);
		this.live.push(panel.frame);

		const faded = new Array<GuiObject>();
		const strokes = new Array<UIStroke>();
		const surfaceStroke = panel.surface.FindFirstChildOfClass("UIStroke");
		if (surfaceStroke !== undefined) {
			strokes.push(surfaceStroke);
		}

		// ## The coin, then the label, then the amount
		//
		// The coin is the store's: `colors.coin`, a full circle, `COIN_SIZE`. It carries a `CHUNKY_CONTROL_OUTLINE` edge here
		// rather than the store's none, because this one stands alone on charcoal instead of inside a saturated price pill.
		const coin = new Instance("Frame");
		coin.Name = "Coin";
		coin.AnchorPoint = new Vector2(0, 0.5);
		coin.Position = UDim2.fromOffset(TOAST_PADDING, TOAST_HEIGHT / 2);
		coin.Size = UDim2.fromOffset(COIN_SIZE, COIN_SIZE);
		coin.BackgroundColor3 = theme.colors.coin;
		coin.BackgroundTransparency = 1;
		coin.BorderSizePixel = 0;
		coin.ZIndex = 3;
		coin.Parent = panel.surface;
		faded.push(coin);

		const coinCorner = new Instance("UICorner");
		coinCorner.CornerRadius = new UDim(1, 0);
		coinCorner.Parent = coin;

		const coinStroke = new Instance("UIStroke");
		coinStroke.Color = CHUNKY_CONTROL_OUTLINE;
		coinStroke.Thickness = CHUNKY_CONTROL_STROKE;
		coinStroke.Transparency = 1;
		coinStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border;
		coinStroke.Parent = coin;
		strokes.push(coinStroke);

		// **Uppercased here, not on the server.** The payload is a description of an event (`"Daily Login"`); shouting is this
		// surface's typographic choice, and the next surface that shows the same event should be free to make its own.
		const label = this.label(
			strokes,
			panel.surface,
			"Label",
			string.upper(message.label),
			"body2",
			TITLE_FONT,
			theme.colors.textPrimary,
			3,
		);
		label.Position = UDim2.fromOffset(
			TOAST_PADDING + COIN_SIZE + SPACING.sm,
			(TOAST_HEIGHT - TYPOGRAPHY.body2.lineHeight) / 2,
		);
		label.Size = UDim2.fromOffset(
			TOAST_WIDTH - TOAST_PADDING * 2 - COIN_SIZE - SPACING.sm - AMOUNT_WIDTH,
			TYPOGRAPHY.body2.lineHeight,
		);
		faded.push(label);

		const amount = this.label(
			strokes,
			panel.surface,
			"Amount",
			`+${tostring(math.floor(message.amount))}`,
			"h6",
			TITLE_FONT,
			theme.colors.coin,
			3,
		);
		amount.Position = UDim2.fromOffset(TOAST_WIDTH - TOAST_PADDING - AMOUNT_WIDTH, 0);
		amount.Size = UDim2.fromOffset(AMOUNT_WIDTH, TOAST_HEIGHT);
		amount.TextXAlignment = Enum.TextXAlignment.Right;
		faded.push(amount);

		this.animate(panel, resting, faded, strokes);
	}

	/**
	 * The reveal, the hold and the teardown.
	 *
	 * The slide and the fade are the same driver: the position is tweened from one toast-height above the resting place while
	 * the reveal goes `0 -> 1`, so the card arrives *and* appears in one gesture rather than in two queued ones.
	 */
	private animate(
		panel: { readonly surface: Frame; readonly shadow: Frame; readonly frame: Frame },
		resting: UDim2,
		faded: Array<GuiObject>,
		strokes: Array<UIStroke>,
	): void {
		const reveal = new Instance("NumberValue");
		reveal.Value = 0;
		reveal.Parent = panel.frame;

		const paint = () => {
			const amount = reveal.Value;

			panel.surface.BackgroundTransparency = mix(1, 0, amount);
			panel.shadow.BackgroundTransparency = mix(1, 0, amount);

			for (const stroke of strokes) {
				stroke.Transparency = mix(1, 0, amount);
			}

			for (const element of faded) {
				if (element.IsA("TextLabel")) {
					element.TextTransparency = mix(1, 0, amount);
				} else {
					element.BackgroundTransparency = mix(1, 0, amount);
				}
			}
		};

		reveal.Changed.Connect(paint);
		paint();

		panel.frame.Position = new UDim2(0.5, 0, TOP_SCALE, resting.Y.Offset - SLIDE_PIXELS);
		TweenService.Create(panel.frame, SLIDE_IN_TWEEN, { Position: resting }).Play();
		TweenService.Create(reveal, SLIDE_IN_TWEEN, { Value: 1 }).Play();

		task.delay(SLIDE_IN_SECONDS + HOLD_SECONDS, () => {
			if (panel.frame.Parent === undefined) {
				return;
			}

			TweenService.Create(reveal, SLIDE_OUT_TWEEN, { Value: 0 }).Play();
			TweenService.Create(panel.frame, SLIDE_OUT_TWEEN, {
				Position: new UDim2(0.5, 0, TOP_SCALE, resting.Y.Offset - SLIDE_PIXELS),
			}).Play();
		});

		task.delay(SLIDE_IN_SECONDS + HOLD_SECONDS + SLIDE_OUT_SECONDS, () => {
			panel.frame.Destroy();

			// Drained by identity rather than by index: a burst can drain out of order, and `remove` on the wrong slot would
			// leave a destroyed frame in the list for ever, which is a permanent stack offset.
			const index = this.live.indexOf(panel.frame);
			if (index !== -1) {
				this.live.remove(index);
			}
		});
	}

	/**
	 * One label in the house style.
	 *
	 * The outline joins `strokes` for the reason `payout-controller` spells out: a `UIStroke`'s transparency is its own
	 * property, so an outlined label whose outline is not faded shows black glyph edges around nothing during the reveal.
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
 * Validates an event argument into a toast payload.
 *
 * `label` is checked for emptiness as well as type: an empty string would build a card with a coin and an amount and no
 * statement of what paid, which is worse than no card at all.
 *
 * `preview` is required rather than defaulted to `false`: both sides of the wire ship together, and a default here would
 * turn a payload that lost the field into a **sound for money that did not move**. The validator is the one place a
 * malformed message is caught, so it is the place to be strict.
 */
function asToastMessage(value: unknown): RewardToastMessage | undefined {
	if (!typeIs(value, "table")) {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const label = record.label;
	const amount = record.amount;
	const preview = record.preview;

	if (!typeIs(label, "string") || label.size() === 0 || !typeIs(amount, "number") || !typeIs(preview, "boolean")) {
		return undefined;
	}

	return { label, amount, preview };
}

/** Linear interpolation, in the one direction this file needs. */
function mix(from: number, to: number, amount: number): number {
	return from + (to - from) * amount;
}
