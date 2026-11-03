import { ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { Text } from "@rbxts/big-ui";
import { ROUND_STATE_VALUE_NAME, WINNER_NAME_VALUE_NAME } from "shared/remotes";
import { getScreenGui } from "shared/ui/layers";
import { SPACING, TextVariant } from "shared/ui/scale";
import { getTheme } from "shared/ui/theme";

/**
 * **Placeholder.** Seconds to wait for `RoundState` / `WinnerName` before giving up loudly.
 *
 * Both values are created by `RoundService.onStart` on the server, so in a normal session they are already
 * present when this controller mounts. The bound exists because the alternative — an unbounded `WaitForChild`
 * — turns "the server never created it" into a client that yields forever with no error, which is
 * indistinguishable from a dead client. Same discipline as `BeltScrollController`'s texture wait (item 13),
 * which was itself the fix for exactly that symptom.
 */
const PHASE_BANNER_WAIT_SECONDS = 10;

/** The four phase values `RoundService` writes. Anything else is a defect and renders as `Unknown`. */
const KNOWN_PHASES = new Set<string>(["Intermission", "Waiting", "Playing", "PostGame"]);

/**
 * The banner's variant: the design's `heading3` on big-ui's nearest name.
 *
 * Typed `TextVariant`, which is `keyof Typography` in `scale.ts`, which is big-ui's own `TypographyVariant`
 * union. **This is rule 6 in practice**: there is no size here, and no size anywhere in this file — the app
 * names a variant and big-ui resolves it from the theme table that `pushBigUiTheme` filled.
 */
const BANNER_VARIANT: TextVariant = "h6";

/** Distinct unknown phase values already reported, so a wrong phase cannot print on every recompute. */
const reportedUnknown = new Set<string>();

/**
 * The label's text, decided in one place.
 *
 * Pure apart from its one-shot warning. It is the only branch in this controller with a rule stated as policy
 * ("`PostGame` shows the winner", "anything else is `Unknown`"), so it should be readable without reading the
 * mounting code around it.
 *
 * `PostGame` with an empty winner is `PostGame — no winner` rather than a bare `PostGame`, because "the round
 * ended and nobody won" is a different fact from "the round is in its result phase and the result has not
 * arrived" — and a player looking at `PostGame` alone cannot tell which.
 *
 * ## Why the warning lives here
 *
 * `RoundState` is written by one service and compared here by literal, so a rename or a fifth phase would
 * silently render as `Unknown` with nothing anywhere saying which string arrived. Fusion calls this function
 * whenever either input changes, so the `Set` is what makes it one line per distinct bad value instead of one
 * per transition: a phase that is wrong tends to stay wrong. Distinct bad values are *not* deduped against
 * each other — two different unknown strings are two different defects, and both are worth a line.
 */
export function bannerText(phase: string, winner: string): string {
	if (phase === "PostGame") {
		return winner === "" ? "PostGame — no winner" : `PostGame — ${winner}`;
	}

	if (KNOWN_PHASES.has(phase)) {
		return phase;
	}

	if (!reportedUnknown.has(phase)) {
		reportedUnknown.add(phase);
		print(`[PhaseBanner] unknown ${ROUND_STATE_VALUE_NAME} value="${phase}"`);
	}

	return "Unknown";
}

/**
 * Draws the current round phase at the top centre of the screen, and nothing else.
 *
 * ## What this element is
 *
 * A fact display: `RoundState`, plus `WinnerName` while `PostGame`. It does not count down, animate, poll or
 * accept input. A timer here would be a second source of truth for a value the server already publishes, and
 * the first thing to disagree with it.
 *
 * ## The push that this controller no longer does
 *
 * Earlier rounds left section 6a step 4 as a named stub: big-ui was installed, the theme was not pushed into
 * it. `getTheme()` now does that push (`[Theme] mounted` then `[BigUi] theme pushed`, both before this
 * controller builds anything), so the theme this file reads and the theme big-ui's `Text` reads are the same
 * object's values.
 *
 * ## How a phase change reaches the label — no update loop, no `Changed` handler here
 *
 * ```
 * RoundState.Value ──OnChange──▶ Fusion Value ──┐
 *                                              ├─ Computed(bannerText) ─▶ big-ui Text
 * WinnerName.Value ──OnChange─▶ Fusion Value ──┘
 * ```
 *
 * `Fusion.Computed` re-runs `bannerText` when either `Value` changes, because the callback reads both through
 * `use`, which is how Fusion records a dependency. `big-ui.Text` accepts `text: Fusion.UsedAs<string>`, so the
 * `Computed` is bound straight into the label's `Text` property by Fusion's own observer — the controller has
 * no per-change code path at all.
 *
 * **What `OnChange` actually is, honestly:** `Fusion.OnChange("Value")` is a special key for a property table
 * that connects `GetPropertyChangedSignal("Value")` and calls the handler — verified in
 * `fusion-3.0/src/Instances/OnChange.luau`. So under the reactive surface there *is* a property-change
 * connection; Fusion owns it, scopes it with the controller, and the app writes none. This package (0.1.0,
 * `Fusion.version` 0.3.0) has no primitive that subscribes to a `StringValue` on its own, so `OnChange` feeding
 * a `Value` is the simplest supported pattern, and that is what shipped.
 *
 * One caveat that is a fact about `Hydrate`, not a preference: `Hydrate` adds the target instance to the scope
 * as an object it owns, so cleaning this scope would `Destroy()` the two `ReplicatedStorage` values. Nothing
 * calls `Fusion.doCleanup` on this scope and nothing should; if that ever changes, the one-line replacement is
 * `table.insert(scope, roundState.GetPropertyChangedSignal("Value"):Connect(...))`, which is precisely what
 * `OnChange` does internally minus the ownership.
 *
 * ## Why it mounts rather than draws
 *
 * The controller owns the element's lifetime and its scope; `getScreenGui` owns the layer. That split is what
 * keeps draw order and the inset contract in one place — see `src/shared/ui/layers.ts`.
 */
@Controller()
export class PhaseBannerController implements OnStart {
	public onStart(): void {
		// First read: constructs the theme and pushes it into big-ui. Everything below reads the result.
		const theme = getTheme();
		const gui = getScreenGui("hudTopbar");

		// **The waits come before the build.** The label's first paint carries the current phase, so building
		// with empty values would mean either a visible blank banner or a second build pass. The waits are
		// bounded either way, so their position relative to the build changes nothing about the discipline.
		const roundState = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, PHASE_BANNER_WAIT_SECONDS);
		if (roundState === undefined || !roundState.IsA("StringValue")) {
			warn(
				`[PhaseBanner] GAVE UP waiting for ${ROUND_STATE_VALUE_NAME} after ${PHASE_BANNER_WAIT_SECONDS}s — the server did not create it. Banner not mounted.`,
			);
			return;
		}

		const winnerName = ReplicatedStorage.WaitForChild(WINNER_NAME_VALUE_NAME, PHASE_BANNER_WAIT_SECONDS);
		if (winnerName === undefined || !winnerName.IsA("StringValue")) {
			warn(
				`[PhaseBanner] GAVE UP waiting for ${WINNER_NAME_VALUE_NAME} after ${PHASE_BANNER_WAIT_SECONDS}s — the server did not create it. Banner not mounted.`,
			);
			return;
		}

		// One scope for the whole element: it owns the two `Value`s, the `Computed`, the `OnChange`
		// connections, and every instance Fusion creates. See the class comment before adding a cleanup call.
		const scope = Fusion.scoped(Fusion);

		const phase = Fusion.Value(scope, roundState.Value);
		const winner = Fusion.Value(scope, winnerName.Value);

		// Seeded above with the current value, then kept in step by the library's own property-change key.
		Fusion.Hydrate(
			scope,
			roundState,
		)({
			[Fusion.OnChange("Value")]: (value: unknown) => {
				if (typeIs(value, "string")) {
					phase.set(value);
				}
			},
		});
		Fusion.Hydrate(
			scope,
			winnerName,
		)({
			[Fusion.OnChange("Value")]: (value: unknown) => {
				if (typeIs(value, "string")) {
					winner.set(value);
				}
			},
		});

		// The whole update path. `use` is Fusion's tracked read: calling it is what subscribes this computation
		// to the two values it reads.
		const text = Fusion.Computed(scope, (use) => bannerText(use(phase), use(winner)));

		// `UIPadding` on the container rather than a nested padded frame: padding a container insets its
		// children, which is exactly "space between the text and the panel edge" without a second instance to
		// auto-size through. The step comes from the app's spacing ladder, because big-ui's own `Spacing()` is a
		// function used by big-ui's internals and is not themable.
		const padding = Fusion.New(
			scope,
			"UIPadding",
		)({
			PaddingTop: new UDim(0, SPACING.sm),
			PaddingBottom: new UDim(0, SPACING.sm),
			PaddingLeft: new UDim(0, SPACING.sm),
			PaddingRight: new UDim(0, SPACING.sm),
		});

		// **big-ui builds the text.** `Text` resolves `variant` through big-ui's live `Typography` table — so the
		// font, size and line height are the ones `pushBigUiTheme` put there, not literals in this file — and
		// binds `text` (a Fusion `Computed`) to the label's `Text` property itself.
		const label = Text(scope, {
			text,
			variant: BANNER_VARIANT,
			color: "primary",
			align: Enum.TextXAlignment.Center,
			size: UDim2.fromOffset(0, 0),
		});

		// big-ui's `Text` maps `size` to `AutomaticSize = None` (its default is a full-width, fixed-height bar).
		// The banner wants the opposite — a chip that shrink-wraps its own text — so the one property big-ui does
		// not expose is re-applied here through Fusion, on the instance big-ui just made.
		Fusion.Hydrate(scope, label)({ AutomaticSize: Enum.AutomaticSize.XY });

		// **The container is Fusion's `New`, not a big-ui component.** big-ui 1.1.3 has no plain container
		// primitive: its nearest is `Card`, which unconditionally adds a `UICorner`, adds a `UIStroke` unless
		// `elevation: 0`, wraps its children in a vertical `UIListLayout`, and drops `AutomaticSize` the moment a
		// `size` is supplied — four properties this banner's spec forbids or fights. The panel is therefore
		// painted from the same `Theme` the push reads, which is what the cascade test needs.
		const frame = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "PhaseBanner",
			AnchorPoint: new Vector2(0.5, 0),
			Position: UDim2.fromScale(0.5, 0),
			Size: UDim2.fromOffset(0, 0),
			AutomaticSize: Enum.AutomaticSize.XY,
			BackgroundColor3: theme.paint.panel.color,
			BackgroundTransparency: theme.paint.panel.transparency,
			BorderSizePixel: 0,
			Parent: gui,
			[Fusion.Children]: [padding, label],
		});

		this.reportMounted(frame, gui, Fusion.peek(text), theme.paint.panel.color);
	}

	/**
	 * One line at mount, carrying the fields the UI doc's rule 10 asks for.
	 *
	 * `panel=<Color3>` is included because nearly every way this element can be wrong is a *pairing* mistake
	 * that a text-only line cannot show: white text on a white panel, or a panel still carrying big-ui's
	 * default palette because the push never ran. `tostring(Color3)` prints `r, g, b` in `[0, 1]`, enough to
	 * compare two runs.
	 *
	 * **Deferred by one resumption, because `AbsoluteSize` is zero until the layout pass runs.** Printing the
	 * geometry synchronously reports `size=(0, 0)` for an element that is about to be 120×40, which reads as
	 * "the banner has no size" — the exact wrong conclusion this line exists to prevent.
	 */
	private reportMounted(frame: Frame, gui: ScreenGui, text: string, panel: Color3): void {
		task.defer(() => {
			print(
				`[PhaseBanner] mounted pos=${tostring(frame.AbsolutePosition)} size=${tostring(frame.AbsoluteSize)} parent=${gui.Name} drawOrder=${gui.DisplayOrder} visible=${tostring(gui.Enabled)} text="${text}" panel=${tostring(panel)}`,
			);
		});
	}
}
