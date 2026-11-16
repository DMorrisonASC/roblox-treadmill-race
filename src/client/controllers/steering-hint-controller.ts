import { Players, ReplicatedStorage, TweenService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYER_COMPETING_ATTRIBUTE } from "shared/attributes";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { steeringHintActionFor, steeringHintFadeOutAtSeconds, steeringHintScale } from "shared/steering-hint";
import { getScreenGui } from "shared/ui/layers";
import { getTheme, Theme } from "shared/ui/theme";
import { outlineText } from "shared/ui/text";
import {
	STEERING_HINT_FADE_IN_SECONDS,
	STEERING_HINT_FADE_OUT_SECONDS,
	STEERING_HINT_LEFT_GLYPH,
	STEERING_HINT_LEFT_X,
	STEERING_HINT_OUTLINE_THICKNESS,
	STEERING_HINT_RIGHT_GLYPH,
	STEERING_HINT_RIGHT_X,
	STEERING_HINT_TEXT_SIZE,
	STEERING_HINT_TRANSPARENCY,
	STEERING_HINT_Y,
	STEERING_HINT_Z_INDEX,
} from "shared/tuning";

/** How long to wait for `RoundState` before giving up and saying so; the tree's bounded-wait convention (item 13). */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * The arrows' typeface: `GothamBlack`, the countdown's (item 149), so the hint reads as the same poster a tenth of a second
 * after `Start!` leaves the screen.
 */
const STEERING_HINT_FONT = Enum.Font.GothamBlack;

/** Symmetric easing on the way in and out; the two fades differ in length, not in curve. */
const STEERING_HINT_EASING_STYLE = Enum.EasingStyle.Quad;

/** See `STEERING_HINT_EASING_STYLE`. */
const STEERING_HINT_EASING_DIRECTION = Enum.EasingDirection.Out;

/** One arrow: the glyph, the outline that keeps it legible over a belt, and the transform that sizes it. */
interface HintArrow {
	label: TextLabel;
	stroke: UIStroke;
}

/** One showing of the hint. Both arrows are children of `root`, so a destroy is one call. */
interface HintView {
	root: Frame;
	arrows: Array<HintArrow>;
	/** The `UIScale` both arrows were drawn at, kept for the log line rather than for layout. */
	scale: number;
}

/**
 * **Two arrows for three seconds, once per session, and then never again.**
 *
 * ## The gap this fills
 *
 * A player arrives in `Playing` having never steered a ball, and there is **nothing on screen that suggests they can**. Item 236
 * deleted the drawn touch pad and item 237 replaced it with a virtual stick that is read from raw touches on the left half of
 * the screen and draws nothing until a thumb is already there - which is the one thing a player who does not know the controls
 * will never do. The picker taught them to choose a ball and the countdown told them when the race starts; both are gone by the
 * time the belt is moving, and the controls the game actually reads (`A`/`D`, the left-half stick, the gamepad) are invisible.
 *
 * So this is not decoration. It is the only on-screen statement that lateral control exists, it is made in the only vocabulary
 * that survives a language barrier and a nine-year-old (two arrows, no words), and it is made once, because the second round
 * is not the round the player is confused in.
 *
 * ## Why `hudCore` and not `splash`
 *
 * The countdown lives on `splash` (display order `35`) and its `Start!` fades out on the frame this hint fades in. Putting the
 * hint on `hudCore` (`20`) draws it **under** that fading caption rather than over it, which is the correct hierarchy: the
 * countdown is the *moment*, and the hint is the affordance that follows it - so for a tenth of a second the two coexist with
 * the poster on top and the arrows emerging beneath it, and neither has to know the other's timing. Nothing is added to the
 * layer chain either: the guide states that chain as total, and this element never draws over a sheet or a wipe.
 *
 * ## Why a glyph rather than two drawn chevrons
 *
 * A frame-built chevron is two rotated rectangles and a joint, and it survives any question about font coverage. The glyph is
 * one `TextLabel` that inherits the countdown's `outlineText` stroke, its fade, and its `UIScale`, for a fraction of the
 * instances. The coverage question was answered empirically before this round: item 220 shipped `◀` and `▶` as touch-button
 * titles and they drew on screen until item 236 deleted the pad, so the two characters render in this engine. The residual risk
 * - that `GothamBlack` specifically lacks them and the engine falls back to a different face - is a Studio check, and it is
 * named in the report rather than defended against with a second rendering path nothing would ever test.
 *
 * ## Why `TweenService`, and not a per-frame driver
 *
 * The countdown drives itself from `RenderStepped` because its deadline is **absolute and frame-exact**: it has to show the
 * caption the server's clock says is current, so it derives the step from the deadline every frame and never accumulates. This
 * hint has no deadline and no shared clock - it is three seconds of local animation started by a local event - and a per-frame
 * driver for four properties would be sixty evaluations a second to reproduce what four `Tween` objects do natively.
 *
 * ## Why the teardown is immediate and the fade-out is not
 *
 * The fade-out is the hint finishing. The teardown is the hint being **wrong**: the phase left `Playing`, or this player stopped
 * competing, and an arrow pointing at a belt that is no longer the player's to steer is worse than no arrow. So a phase or
 * attribute change destroys on the spot with no fade, and the `generation` counter is what makes the in-flight `task.delay`
 * from the fade-out sequence inert afterwards rather than a race against a view that no longer exists.
 */
@Controller()
export class SteeringHintController implements OnStart {
	private readonly theme: Theme = getTheme();

	/** The phase this client last read, kept so an attribute change can be re-evaluated without another `WaitForChild`. */
	private phase = "";

	/** This player's own copy of the replicated fact: `true` only while they have a body on the belt. */
	private competing = false;

	/**
	 * **Whether this client has ever seen the hint.** Set when the arrows are *shown*, never on `Playing` entry - the difference
	 * is what lets a spectator who watches round one still be taught in the first round they race. It is session state and it
	 * outlives the arrows deliberately: "once" is the requirement, not "while competing".
	 */
	private shown = false;

	/** What is on screen, or `undefined`. One field, so "is it up" is one question. */
	private view?: HintView;

	/** Bumped by both a show and a teardown; every continuation checks the number it was scheduled under. */
	private generation = 0;

	/** Tweens in flight, so a destroy can cancel them rather than leave a fade writing to a destroyed label. */
	private running = new Array<Tween>();

	public onStart(): void {
		const player = Players.LocalPlayer;
		if (player === undefined) {
			return;
		}

		// The phase: a `StringValue` the server writes on every transition. Bounded wait, matching every other controller's
		// discipline - an unbounded `WaitForChild` turns "the server never created it" into a client that yields for ever.
		const state = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (state === undefined || !state.IsA("StringValue")) {
			warn(
				`[SteeringHint] no ${ROUND_STATE_VALUE_NAME} after ${ROUND_STATE_WAIT_SECONDS}s - the hint will not be shown.`,
			);
			return;
		}

		this.phase = state.Value;
		state.GetPropertyChangedSignal("Value").Connect(() => {
			this.phase = state.Value;
			this.apply();
		});

		// **Watched rather than polled**, for the reason `CharacterFreezeController` gives: the attribute arrives asynchronously
		// from `RoundService` and a client can start mid-round, so it is read once here as well. `Competing` is the same fact
		// item 212 uses to point the camera, read on the same signal, so the hint and the camera never disagree about whether
		// this player is in the round.
		player.GetAttributeChangedSignal(PLAYER_COMPETING_ATTRIBUTE).Connect(() => {
			this.competing = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE) === true;
			this.apply();
		});
		this.competing = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE) === true;

		// **The first frame is a decision like any other.** A client that starts while a round is already running is exactly the
		// player the hint is for, and one that starts in `Intermission` must draw nothing.
		this.apply();

		print(`[SteeringHint] mounted phase=${this.phaseName()} competing=${tostring(this.competing)}`);
	}

	/** The one place the phase and the attribute become an action: draw, tear down, or leave alone. */
	private apply(): void {
		const action = steeringHintActionFor(this.phase, this.competing, this.shown);

		if (action === "show") {
			this.show();
		} else if (action === "teardown") {
			this.destroy(`phase ${this.phaseName()} competing=${tostring(this.competing)}`);
		}
	}

	/**
	 * Draws both arrows, fades them in, schedules the fade-out, and schedules the destroy.
	 *
	 * **`shown` is set before the arrows exist**, so the flag records the decision rather than the pixels: a `Playing ->
	 * Playing` restart that lands in the same frame as the show then finds the flag already set and draws nothing, which is the
	 * "no replay" requirement without a second suppression flag.
	 */
	private show(): void {
		const generation = ++this.generation;
		this.shown = true;

		const view = this.build();
		this.view = view;

		this.fade(view, STEERING_HINT_FADE_IN_SECONDS, STEERING_HINT_TRANSPARENCY);

		// **The fade-out starts at `SECONDS - FADE_OUT`, not at `SECONDS - FADE_IN - FADE_OUT`.** The fade-in is inside the
		// three seconds - it begins on this frame - so subtracting it again would end the hint at 2.75 s. See
		// `steeringHintFadeOutAtSeconds` for the arithmetic, which is asserted in the spec.
		task.delay(steeringHintFadeOutAtSeconds(), () => {
			if (generation !== this.generation) {
				return;
			}

			this.fade(view, STEERING_HINT_FADE_OUT_SECONDS, 1);
		});

		task.delay(steeringHintFadeOutAtSeconds() + STEERING_HINT_FADE_OUT_SECONDS, () => {
			if (generation !== this.generation) {
				return;
			}

			this.destroy("faded");
		});

		print(
			`[SteeringHint] show generation=${generation} scale=${tostring(view.scale)} text=${STEERING_HINT_TEXT_SIZE}`,
		);
	}

	/** Builds the container and the two arrows. Nothing is parented into view until the container is complete. */
	private build(): HintView {
		const root = new Instance("Frame");
		root.Name = "SteeringHint";
		root.Size = UDim2.fromScale(1, 1);
		root.BackgroundTransparency = 1;
		root.BorderSizePixel = 0;
		root.ZIndex = STEERING_HINT_Z_INDEX;

		// One scale for both arrows, read from the screen they are about to be drawn on. A missing camera is not an error: the
		// designed size is the honest fallback for the one moment there is no viewport to measure.
		const scale = steeringHintScale(this.viewport());

		const arrows = [
			this.buildArrow(root, "SteeringHintLeft", STEERING_HINT_LEFT_X, STEERING_HINT_LEFT_GLYPH, scale),
			this.buildArrow(root, "SteeringHintRight", STEERING_HINT_RIGHT_X, STEERING_HINT_RIGHT_GLYPH, scale),
		];

		root.Parent = getScreenGui("hudCore");

		return { root, arrows, scale };
	}

	/** One arrow: a centred glyph, the project's outline, and a `UIScale` sized from the viewport. */
	private buildArrow(parent: Frame, name: string, x: number, glyph: string, scale: number): HintArrow {
		const label = new Instance("TextLabel");
		label.Name = name;
		label.AnchorPoint = new Vector2(0.5, 0.5);
		label.Position = UDim2.fromScale(x, STEERING_HINT_Y);
		// Sized from the glyph rather than from the screen: the arrow is drawn about its own centre and nothing is laid out
		// against it, so the box only has to be big enough that the stroke is not cropped.
		label.Size = UDim2.fromOffset(STEERING_HINT_TEXT_SIZE * 2, STEERING_HINT_TEXT_SIZE * 1.4);
		label.BackgroundTransparency = 1;
		label.BorderSizePixel = 0;
		label.Font = STEERING_HINT_FONT;
		label.TextSize = STEERING_HINT_TEXT_SIZE;
		label.TextColor3 = this.theme.colors.textPrimary;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.Text = glyph;
		// **Invisible on the first frame, not already at the target.** The fade-in is the entrance; starting at the final
		// transparency would make the first frame a pop and the tween a no-op.
		label.TextTransparency = 1;
		label.ZIndex = 1;
		label.Parent = parent;

		// The project's one outline builder, then tuned for a poster: `outlineText` is sized for body copy on a panel, and a 2 px
		// line around a 96 px glyph is invisible against a belt.
		const stroke = outlineText(label);
		stroke.Color = this.theme.colors.shadow;
		stroke.Thickness = STEERING_HINT_OUTLINE_THICKNESS;
		// A stroke's transparency is its own property and does not ride along with the label's (item 149), so it is faded
		// separately on both ends - which is the whole reason `outlineText` returns the stroke.
		stroke.Transparency = 1;

		// **On the label, not on the container.** A `UIScale` multiplies the size of the element it is parented to, and the
		// label is what has a glyph in it: scaling the container would scale the two positions and leave the type at 96 px.
		const uiScale = new Instance("UIScale");
		uiScale.Scale = scale;
		uiScale.Parent = label;

		return { label, stroke };
	}

	/** Fades both arrows' glyphs and both outlines to `target`, replacing whatever was in flight. */
	private fade(view: HintView, seconds: number, target: number): void {
		this.cancelRunning();

		const info = new TweenInfo(seconds, STEERING_HINT_EASING_STYLE, STEERING_HINT_EASING_DIRECTION);

		for (const arrow of view.arrows) {
			this.play(TweenService.Create(arrow.label, info, { TextTransparency: target }));
			this.play(TweenService.Create(arrow.stroke, info, { Transparency: target }));
		}
	}

	private play(tween: Tween): void {
		this.running.push(tween);
		tween.Play();
	}

	private cancelRunning(): void {
		for (const tween of this.running) {
			tween.Cancel();
		}

		this.running = new Array<Tween>();
	}

	/**
	 * Removes the hint **now**, and makes every scheduled continuation inert.
	 *
	 * Safe to call when nothing is on screen, which is what lets the caller be a one-line decision: the teardown action does not
	 * have to ask whether the show ever happened.
	 */
	private destroy(reason: string): void {
		// **Bumped first.** The generation is what a pending `task.delay` checks, so moving it before the destroy is what makes
		// "phase changed during the hold" a destroy rather than a destroy racing a fade onto a label that no longer exists.
		this.generation++;
		this.cancelRunning();

		const view = this.view;
		if (view === undefined) {
			return;
		}

		// One `Destroy()`: the stroke and the `UIScale` are children of the labels, which are children of the root.
		view.root.Destroy();
		this.view = undefined;

		print(`[SteeringHint] destroy (${reason})`);
	}

	/** The screen the arrows are about to be drawn on, or the designed reference when there is no camera to ask. */
	private viewport(): Vector2 {
		const camera = Workspace.CurrentCamera;
		if (camera === undefined) {
			return new Vector2(STEERING_HINT_TEXT_SIZE * 4, STEERING_HINT_TEXT_SIZE * 4);
		}

		return camera.ViewportSize;
	}

	/** `phase` or `(empty)`, so a log line never ends in a space. */
	private phaseName(): string {
		return this.phase === "" ? "(empty)" : this.phase;
	}
}
