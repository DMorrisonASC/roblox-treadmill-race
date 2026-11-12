import { GuiService, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import {
	INTERMISSION_DEADLINE_VALUE_NAME,
	ROUND_PLAYING_DEADLINE_VALUE_NAME,
	ROUND_REFUSAL_VALUE_NAME,
	ROUND_STATE_VALUE_NAME,
	WINNER_NAME_VALUE_NAME,
} from "shared/remotes";
import { formatClock, phaseHasClock } from "shared/round-status";
import { bannerHeaderText, bannerMessageText, bannerWinnerText } from "shared/phase-banner";
import { getScreenGui } from "shared/ui/layers";
import { FONT, SPACING, TYPOGRAPHY } from "shared/ui/scale";
import { getTheme } from "shared/ui/theme";
import { outlineText } from "shared/ui/text";

/**
 * **Placeholder.** Seconds to wait for `RoundState` / `WinnerName` before giving up loudly.
 *
 * Both values are created by `RoundService.onStart` on the server, so in a normal session they are already present when this
 * controller mounts. The bound exists because the alternative - an unbounded `WaitForChild` - turns "the server never created
 * it" into a client that yields forever with no error, which is indistinguishable from a dead client.
 */
const PHASE_BANNER_WAIT_SECONDS = 10;

/**
 * The round's phase as a **two-row text strip** under the topbar: a small centred header and a larger status line.
 *
 * ```
 *              RESULT • BestDefault          <- header: phase token, bullet, winner (h6)
 *                  BestDefault wins!          <- message (h5)
 * ```
 *
 * ## What this is not
 *
 * **It is not the chunky panel of items 193-195, and that decision is reversed here on purpose.** Those rounds put the banner
 * in the same charcoal-plate language as the store, the inventory, the payout and the toast, on the argument that a banner is
 * the most-seen surface in the game after the ball itself. The designer has since looked at it: a plate at the top of the screen
 * collides with the Roblox topbar and the chat controls, and it reads as a *dialog* floating over the arena rather than as a
 * status line belonging to it. So the plate, its rounded corner, its plate stroke and its face are all gone, and the only visible
 * geometry left is the text and the black glyph outline that keeps it legible over a bright sky.
 *
 * **It is not a watermark either.** The two rows are centred as a block under the topbar, so they read as a caption for the
 * screen rather than as a label stuck in a corner. Whether that lands as deliberate HUD or as floating text is a judgement only
 * a screenshot answers; the structure is the part that can be got right in code.
 *
 * ## How a change reaches the labels
 *
 * **Two `GetPropertyChangedSignal("Value")` connections, both calling one `refresh()`.** One connection per `StringValue`, not
 * one per label: the four labels are decided by `(phase, winner)` between them, and a handler per label would read the same two
 * values four times and could disagree with itself mid-transition. The previous build used Fusion's `Computed` because big-ui's
 * `Text` binds one `text` field per label; there is no big-ui here any more, so a plain refresh is the smaller mechanism and it
 * keeps every write in one function where they cannot drift apart.
 *
 * ## Why the strip is full width, and what the layer had to change for it
 *
 * **The layer no longer uses `TopbarSafeInsets` (item 213).** That value is not a vertical inset: the engine describes its
 * region as "dynamic and ... limited to the space available within the top bar area itself", so a tenant that centres inside it
 * centres on a box whose width is decided by the top bar - which is why this strip drew visibly off-centre while its own
 * `Size.X.Scale` was `1` and every row inside it was centred. `hudTopbar` is now `DeviceSafeInsets` (device cutouts only, no
 * core-UI inset), so the gui is the full physical width on desktop and the notch-safe width on a phone, and `Size.X.Scale = 1`
 * now means the screen.
 *
 * **That moves the vertical offset into this element**, where it already was: `GuiService:GetGuiInset()` is read at mount and
 * re-read whenever `TopbarInset` changes, and the root sits at that Y. One owner for both halves is deliberate - a gui cannot
 * give "full width" and "below the topbar" at once, because the only inset that clears the top bar is also the one that narrows
 * the box.
 *
 * The root is anchored at `(0, 0)` with `Size.X.Scale = 1`, which is centred by construction: the box spans the gui, so its
 * midpoint is the gui’s midpoint. A centred anchor (`AnchorPoint = (0.5, 0)` at `Position.X.Scale = 0.5`) would describe the
 * same rectangle with one more pair of numbers to disagree.
 */
/**
 * The header's separator: **a bullet, written as itself.**
 *
 * A literal character rather than a `\uXXXX` escape, because roblox-ts rejects those in string literals (item 50's rule and the
 * `grep "\\u[0-9a-fA-F]{4}" src` check that keeps it true). The emitted Luau carries the real UTF-8 byte, so the engine draws a
 * bullet and not an escape sequence.
 *
 * **If a device ever renders this as a box**, the substitution is a plain ASCII `" | "` - the strip's width is its own content, so
 * nothing else has to change.
 */
const SEPARATOR_TEXT = "•";

@Controller()
export class PhaseBannerController implements OnStart {
	/** The strip's root, kept so the topbar offset can be re-applied when the inset changes. */
	private root?: Frame;

	/** The header's three tokens, in row order. The bullet and the winner hide together when there is no winner. */
	private phaseLabel?: TextLabel;
	private separatorLabel?: TextLabel;
	private winnerLabel?: TextLabel;

	/** The status line under the header. */
	private messageLabel?: TextLabel;

	/** The refusal reason, or `""`. Read at mount and on change; it overrides the message row (item 214). */
	private refusal?: StringValue;

	/** When `Intermission` ends, or `0`. The banner's clock counts to it (item 214). */
	private intermissionDeadline?: NumberValue;

	/** When `Playing` reaches its cap, or `0`. */
	private playingDeadline?: NumberValue;

	/** The clock label on the header row. Hidden whenever the active phase has no clock. */
	private clockLabel?: TextLabel;

	private roundState?: StringValue;
	private winnerName?: StringValue;

	/**
	 * A `ReplicatedStorage` value this client reads, or `undefined` if the server did not create it.
	 *
	 * Bounded, for the tree's usual reason: an unbounded `WaitForChild` turns "the server never created it" into a client that
	 * yields for ever with no error. A missing value is non-fatal here - the banner simply has no clock and no refusal - so every
	 * caller treats `undefined` as "that feature is off".
	 */
	private value<T extends StringValue | NumberValue>(name: string): T | undefined {
		const found = ReplicatedStorage.WaitForChild(name, PHASE_BANNER_WAIT_SECONDS);
		if (found === undefined) {
			warn(
				`[PhaseBanner] no ${name} after ${PHASE_BANNER_WAIT_SECONDS}s - that part of the strip stays off this session.`,
			);
			return undefined;
		}

		// `IsA` on each branch rather than a cast: the two shapes the callers ask for are exactly the two the server creates, and a
		// wrong class is worth a line rather than a silent `nil` read later.
		if (name === "RoundIntermissionDeadline" || name === "RoundPlayingDeadline") {
			return found.IsA("NumberValue") ? (found as T) : undefined;
		}

		return found.IsA("StringValue") ? (found as T) : undefined;
	}

	public onStart(): void {
		// First read: constructs the theme and pushes it into big-ui for every other element. `hudDark`'s `textPrimary` is
		// white, which is the ink for every label below; the *outline* that makes white legible over a bright sky comes from
		// `outlineText`, not from the theme.
		const theme = getTheme();
		const gui = getScreenGui("hudTopbar");

		const roundState = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, PHASE_BANNER_WAIT_SECONDS);
		if (roundState === undefined || !roundState.IsA("StringValue")) {
			warn(
				`[PhaseBanner] GAVE UP waiting for ${ROUND_STATE_VALUE_NAME} after ${PHASE_BANNER_WAIT_SECONDS}s - the server did not create it. Banner not mounted.`,
			);
			return;
		}

		const winnerName = ReplicatedStorage.WaitForChild(WINNER_NAME_VALUE_NAME, PHASE_BANNER_WAIT_SECONDS);
		if (winnerName === undefined || !winnerName.IsA("StringValue")) {
			warn(
				`[PhaseBanner] GAVE UP waiting for ${WINNER_NAME_VALUE_NAME} after ${PHASE_BANNER_WAIT_SECONDS}s - the server did not create it. Banner not mounted.`,
			);
			return;
		}

		this.roundState = roundState;
		this.winnerName = winnerName;

		// **The three values the clock and the refusal read (item 214).** Bounded waits for the same reason as the two above: an
		// unbounded `WaitForChild` turns "the server never created it" into a client that yields for ever. A missing value is
		// non-fatal - the banner simply has no clock and no refusal - so each falls through to `undefined` rather than aborting the
		// whole strip.
		this.refusal = this.value<StringValue>(ROUND_REFUSAL_VALUE_NAME);
		this.intermissionDeadline = this.value<NumberValue>(INTERMISSION_DEADLINE_VALUE_NAME);
		this.playingDeadline = this.value<NumberValue>(ROUND_PLAYING_DEADLINE_VALUE_NAME);

		// The root: full width of the layer, growing downward with its two rows, drawn from nothing.
		const root = new Instance("Frame");
		root.Name = "RoundStatus";
		root.AnchorPoint = new Vector2(0, 0);
		root.Position = UDim2.fromOffset(0, this.topbarInset());
		root.Size = new UDim2(1, 0, 0, 0);
		root.AutomaticSize = Enum.AutomaticSize.Y;
		// **Transparent and borderless - the whole point of this rewrite.** A frame here is a layout anchor, not a surface.
		root.BackgroundTransparency = 1;
		root.BorderSizePixel = 0;
		root.Parent = gui;
		this.root = root;

		const padding = new Instance("UIPadding");
		// Only vertical: the strip is full width, so horizontal padding would inset the *centring* rather than the text and the
		// two rows would no longer centre on the screen's own axis.
		padding.PaddingTop = new UDim(0, SPACING.sm);
		padding.PaddingBottom = new UDim(0, SPACING.xs);
		padding.Parent = root;

		const stack = new Instance("UIListLayout");
		stack.FillDirection = Enum.FillDirection.Vertical;
		stack.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		stack.SortOrder = Enum.SortOrder.LayoutOrder;
		stack.Padding = new UDim(0, SPACING.xs);
		stack.Parent = root;

		// The header row: a horizontal stack of tokens whose width is its content, centred by the vertical stack above it.
		const header = new Instance("Frame");
		header.Name = "Header";
		header.LayoutOrder = 1;
		header.BackgroundTransparency = 1;
		header.BorderSizePixel = 0;
		// **`XY`, not `Y`.** The row has no authored width; its width is the sum of its tokens, which is what lets the vertical
		// stack's `HorizontalAlignment.Center` centre the *row* rather than a full-width frame with centred text inside it.
		header.Size = new UDim2(0, 0, 0, 0);
		header.AutomaticSize = Enum.AutomaticSize.XY;
		header.Parent = root;

		const row = new Instance("UIListLayout");
		row.FillDirection = Enum.FillDirection.Horizontal;
		row.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		row.VerticalAlignment = Enum.VerticalAlignment.Center;
		row.SortOrder = Enum.SortOrder.LayoutOrder;
		row.Padding = new UDim(0, SPACING.xs);
		row.Parent = header;

		this.phaseLabel = this.label(header, "Phase", 1, TYPOGRAPHY.h6.size, theme.colors.textPrimary);
		// **The text is set here, not left to the layout.** An empty separator would draw no bullet at all, which is a silently
		// broken row rather than a missing glyph - and the mounted line prints the header's *width*, so a row that lost its
		// separator reads as a narrower header rather than as an error.
		this.separatorLabel = this.label(header, "Separator", 2, TYPOGRAPHY.body2.size, theme.colors.textPrimary);
		this.separatorLabel.Text = SEPARATOR_TEXT;
		this.winnerLabel = this.label(header, "Winner", 3, TYPOGRAPHY.h6.size, theme.colors.textPrimary);

		// **The clock: a fourth token, right of the phase and left of nothing** (item 214). The winner token is empty in both phases
		// that have a clock (`Intermission`, `Playing`), so in practice the row reads `RACE • 1:47` - the clock sits where the
		// winner would, which is why it needs no second bullet of its own.
		//
		// **Layout consequence, named:** the row is centred as a *group* by the vertical stack, so adding a token widens it
		// asymmetrically - the phase name moves left of the message's centre by half the clock's width. That is the honest trade for
		// a right-hand readout in a centred row; the alternative (a clock row of its own between header and message) adds a third
		// line to a strip the designer asked to be two.
		this.clockLabel = this.label(header, "Clock", 4, TYPOGRAPHY.h6.size, theme.colors.textPrimary);
		this.clockLabel.Visible = false;

		// The status line. `TextXAlignment.Center` and a full width rather than a shrink-wrapped label here: a sentence that
		// outgrows the viewport has to wrap inside the strip rather than push it wider than the screen.
		const message = this.label(root, "StatusMessage", 2, TYPOGRAPHY.h5.size, theme.colors.textPrimary);
		message.Size = new UDim2(1, 0, 0, 0);
		message.AutomaticSize = Enum.AutomaticSize.Y;
		message.TextXAlignment = Enum.TextXAlignment.Center;
		message.TextWrapped = true;
		this.messageLabel = message;

		this.refresh();

		// **The inset is not a constant.** `TopbarInset` is a `Rect` on `GuiService` and it moves when the topbar collapses, when
		// a device rotates, and when the player changes their topbar transparency settings - so the strip is re-offset on every
		// change rather than sitting a fixed number of pixels from an edge that has moved.
		GuiService.GetPropertyChangedSignal("TopbarInset").Connect(() => this.applyTopbarInset());

		roundState.GetPropertyChangedSignal("Value").Connect(() => this.refresh());
		winnerName.GetPropertyChangedSignal("Value").Connect(() => this.refresh());

		// **The refusal changes the message, so it re-runs the same refresh** (item 214). Not a second handler that writes the
		// message itself: the message's text is decided in one function, and a second writer is a second copy of the refusal
		// override.
		this.refusal?.GetPropertyChangedSignal("Value").Connect(() => this.refresh());

		// **One `RenderStepped` for the clock, and it does nothing in the phases without one.** The alternative - connecting at
		// `Intermission` entry and disconnecting at `Waiting` - is two more listeners whose lifetimes have to be kept in step with
		// the phase machine, for a function that costs one comparison when there is no clock.
		RunService.RenderStepped.Connect(() => this.refreshClock());

		this.reportMounted(gui, theme.colors.textPrimary);
	}

	/**
	 * Builds one outlined label.
	 *
	 * Every visible `TextLabel` in this controller goes through here, which is what makes "all four are stroked" a structural
	 * fact rather than four remembered calls. `TextScaled` is left `false` - a status message that scaled to fit would be
	 * illegible at a phone's smallest viewport, and every other HUD element in this tree uses a fixed size from the scale.
	 */
	private label(parent: Instance, name: string, order: number, size: number, color: Color3): TextLabel {
		const label = new Instance("TextLabel");
		label.Name = name;
		label.LayoutOrder = order;
		label.BackgroundTransparency = 1;
		label.BorderSizePixel = 0;
		label.Font = FONT;
		label.TextSize = size;
		label.TextColor3 = color;
		label.TextScaled = false;
		label.Text = "";
		label.Size = new UDim2(0, 0, 0, 0);
		label.AutomaticSize = Enum.AutomaticSize.XY;
		label.Parent = parent;

		// **The glyph outline, and the only stroke in this element.** `outlineText` attaches a `UIStroke` to the *label*, which
		// strokes the glyphs; a stroke on a frame would outline a rectangle, which is the border this rewrite removes.
		outlineText(label);

		return label;
	}

	/** Writes every label from the two `StringValue`s. The one place the strings are decided. */
	private refresh(): void {
		const phaseLabel = this.phaseLabel;
		const separatorLabel = this.separatorLabel;
		const winnerLabel = this.winnerLabel;
		const messageLabel = this.messageLabel;
		const roundState = this.roundState;
		const winnerName = this.winnerName;
		if (
			phaseLabel === undefined ||
			separatorLabel === undefined ||
			winnerLabel === undefined ||
			messageLabel === undefined ||
			roundState === undefined ||
			winnerName === undefined
		) {
			return;
		}

		const phase = roundState.Value;
		const winner = winnerName.Value;

		const header = bannerHeaderText(phase);
		const winnerText = bannerWinnerText(phase, winner);

		phaseLabel.Text = header;
		winnerLabel.Text = winnerText;
		// **The bullet is the winner token's punctuation, so it lives and dies with it.** A `UIListLayout` skips an invisible
		// child, so hiding both leaves a one-token row; leaving the bullet visible would print `RESULT •` with nothing after it,
		// which reads as a typo rather than as "nobody won".
		separatorLabel.Visible = winnerText !== "";
		winnerLabel.Visible = winnerText !== "";

		// The message is the only one of the two that reports an unknown phase - `bannerMessageText` owns that line, and the header
		// is a pure mapper. Evaluating it here therefore covers the header's `UNKNOWN` too: the two are computed in the same
		// refresh, so a bad value always prints exactly once however many labels it touched.
		const refusal = this.refusal === undefined ? "" : this.refusal.Value;
		messageLabel.Text = bannerMessageText(phase, winner, refusal);

		this.refreshClock();
	}

	/**
	 * The distance from the physical top of the screen to the bottom of the Roblox topbar, in pixels.
	 *
	 * `GuiService:GetGuiInset()` returns **two** `Vector2`s - the inset as it applies to un-inset guis, and the topbar's own
	 * offset - and the second's `Y` is the height the strip has to clear. Read from the service rather than relied on from
	 * `ScreenInsets` because the layer's `TopbarSafeInsets` contributed nothing on this client: the previous mounted line
	 * reported `pos=…, 0`, which is the strip drawing level with the Roblox buttons.
	 *
	 * **The larger of the two inset readings wins.** `GetGuiInset`'s second value and `TopbarInset.Height` disagree on clients
	 * where the in-experience topbar is collapsed, and clearance is the requirement rather than a specific number.
	 */
	private topbarInset(): number {
		const [, topbar] = GuiService.GetGuiInset();
		const fromRect = GuiService.TopbarInset.Height;

		return math.max(topbar.Y, fromRect);
	}

	/** Re-applies the topbar offset. Called at mount and on every `TopbarInset` change. */
	private applyTopbarInset(): void {
		const root = this.root;
		if (root === undefined) {
			return;
		}

		root.Position = UDim2.fromOffset(0, this.topbarInset());
	}

	/**
	 * One line at mount carrying the fields a reader needs, deferred one resumption.
	 *
	 * **Deferred because `AbsoluteSize` is zero until the layout pass runs.** Printing the geometry synchronously reports
	 * `size=(0, 0)` for an element that is about to be `640x60`, which reads as "the banner has no size" - the exact wrong
	 * conclusion this line exists to prevent.
	 *
	 * `textColor` is on the line because the previous build printed the chunky panel's *face* colour instead, and
	 * `0.203922, 0.203922, 0.227451` is `chunkyDarkTheme.paint.panel` - a charcoal, not `hudDark`'s white text. A reader could not
	 * tell whether the banner was painted from the HUD theme at all. `stroke` proves `outlineText` ran; a stroke of `0` would
	 * mean white text with no outline, invisible over a bright sky.
	 *
	 * **`centre=` and `screenCentre=` are on the line because the reported bug was an off-centre strip** (item 213), and the two
	 * numbers are the whole test: `centre` is the strip's own horizontal midpoint, `screenCentre` is half the physical viewport
	 * width. They were different before this round - the strip was centred in a box sized to the top bar's own space - and a reader
	 * could not see it, because `pos=` and `size=` are both relative to the gui rather than to the screen.
	 */
	private reportMounted(gui: ScreenGui, textColor: Color3): void {
		task.defer(() => {
			const root = this.root;
			const phaseLabel = this.phaseLabel;
			const winnerLabel = this.winnerLabel;
			const messageLabel = this.messageLabel;
			const clockLabel = this.clockLabel;
			if (
				root === undefined ||
				phaseLabel === undefined ||
				winnerLabel === undefined ||
				messageLabel === undefined
			) {
				return;
			}

			const stroke = messageLabel.FindFirstChildOfClass("UIStroke");
			// **The strip's midpoint against the physical viewport's midpoint.** `ViewportSize` rather than
			// `GuiService.GetScreenResolution()`: the latter is the display's pixel size, which on a scaled or letterboxed client is
			// not the area guis are laid out in, so it would report a mismatch on a correct layout.
			const camera = Workspace.CurrentCamera;
			const viewportWidth = camera === undefined ? 0 : camera.ViewportSize.X;
			const centre = root.AbsolutePosition.X + root.AbsoluteSize.X / 2;

			print(
				`[PhaseBanner] mounted pos=${tostring(root.AbsolutePosition)} size=${tostring(root.AbsoluteSize)} parent=${gui.Name} drawOrder=${gui.DisplayOrder} header="${phaseLabel.Text}" winner="${winnerLabel.Text}" clock="${clockLabel === undefined ? "none" : clockLabel.Text}" refusal="${this.refusal === undefined ? "none" : this.refusal.Value}" message="${messageLabel.Text}" textColor=${tostring(textColor)} stroke=${stroke === undefined ? "none" : tostring(stroke.Thickness)} topbarInset=${tostring(this.topbarInset())} headerW=${tostring(this.headerWidth())} guiW=${tostring(gui.AbsoluteSize.X)} centre=${tostring(math.round(centre))} screenCentre=${tostring(math.round(viewportWidth / 2))} screenW=${tostring(math.round(viewportWidth))}`,
			);
		});
	}

	/**
	 * Shows, hides and ticks the header's clock (item 214).
	 *
	 * ## Which deadline is active
	 *
	 * `Intermission` shows time to the lobby's own deadline; `Playing` shows time to the cap. `Waiting` and `PostGame` show
	 * nothing - `Waiting` has the 3-2-1 (`CountdownController`, item 149) over the same span and a second clock there would
	 * disagree with it by a frame, and `PostGame` lasts five seconds.
	 *
	 * ## Why the value is read every frame rather than counted down locally
	 *
	 * A `NumberValue` holding a deadline is set **once** per phase, so its `Changed` never fires again - there is nothing for a
	 * listener to react to. The remaining time is `deadline - Workspace:GetServerTimeNow()` recomputed on each `RenderStepped`,
	 * which is the server's clock rather than this machine's, so two clients in one server agree to the frame and a client whose
	 * own clock is wrong still shows the right number.
	 *
	 * ## Why the label is hidden rather than blanked
	 *
	 * A `UIListLayout` skips an invisible child but still reserves a visible empty one, so an empty-but-visible clock would leave a
	 * gap after the bullet. `Visible = false` is what makes the row two tokens again in `Waiting` and `PostGame`.
	 */
	private refreshClock(): void {
		const clockLabel = this.clockLabel;
		const roundState = this.roundState;
		if (clockLabel === undefined || roundState === undefined) {
			return;
		}

		const phase = roundState.Value;
		const deadline = this.activeDeadline(phase);
		if (deadline === undefined || deadline <= 0) {
			clockLabel.Visible = false;
			clockLabel.Text = "";
			return;
		}

		clockLabel.Visible = true;
		clockLabel.Text = formatClock(deadline - Workspace.GetServerTimeNow());
	}

	/** The deadline the clock counts to in `phase`, or `undefined` when the phase has no clock. */
	private activeDeadline(phase: string): number | undefined {
		if (!phaseHasClock(phase)) {
			return undefined;
		}

		const value = phase === "Intermission" ? this.intermissionDeadline : this.playingDeadline;
		return value === undefined ? undefined : value.Value;
	}

	/** The header row's drawn width, for the mount line. `0` when the row has not resolved yet. */
	private headerWidth(): number {
		const phaseLabel = this.phaseLabel;
		const header = phaseLabel === undefined ? undefined : phaseLabel.Parent;
		return header !== undefined && header.IsA("Frame") ? header.AbsoluteSize.X : 0;
	}
}
