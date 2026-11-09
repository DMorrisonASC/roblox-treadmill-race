import { ReplicatedStorage, RunService, TweenService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYING_DEADLINE_VALUE_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import {
	CAPTION_IN_SECONDS,
	CAPTION_OUT_SECONDS,
	CountdownStep,
	COUNTDOWN_SECONDS,
	COUNTDOWN_TIMING,
	countdownStepIndex,
	countdownSteps,
	START_FADE_SECONDS,
} from "shared/ui/countdown";
import { getScreenGui } from "shared/ui/layers";
import { getTheme, Theme } from "shared/ui/theme";
import { outlineText } from "shared/ui/text";

/** The phase the countdown belongs to. Published by the server; this controller only reads it. */
const PHASE_WAITING = "Waiting";

/**
 * **Placeholder.** How long the server gets to publish the two values before this controller gives up on one of them.
 *
 * Bounded for the reason item 13 established for `BeltScrollController` and `RoundStateController` repeats: an unbounded
 * `WaitForChild` turns "the server never created it" into a silent infinite yield, and a silent yield is indistinguishable
 * from "not replicated yet".
 */
const REPLICATED_WAIT_SECONDS = 10;

// #region animation — the specification, not a suggestion

/**
 * The four durations and the sequence's total come from `shared/ui/countdown.ts` (item 156).
 *
 * They lived here until the round song needed the same instant. The song's fade-in now begins when the countdown does, and
 * "when the countdown does" is `PlayingDeadline - COUNTDOWN_SECONDS` - so a private copy of that sum here and another in
 * `round-song-controller` would be two numbers that agree only until somebody retunes one of the four durations. The
 * *look* below is still this file's: how far the sweep goes, which easing, what colour.
 */

/** The timeline, built once. Every reader of "which caption now" goes through this table. */
const STEPS: Array<CountdownStep> = countdownSteps(COUNTDOWN_TIMING);

/** Scale at rest: a caption sitting still, which is what `hold` and `fade` keep it at. */
const SCALE_REST = 1;

/** **Placeholder.** How far a caption grows as it is swept off. */
const SCALE_SWEPT = 1.85;

/**
 * **Placeholder.** Where a caption starts before it rushes in.
 *
 * ## Why this is not `6` any more (item 152)
 *
 * `6` was chosen as "from the front", and on this label it means something else. The caption is `TEXT_SIZE` tall inside a
 * `BOX_HEIGHT` box, so at scale `6` the box is `BOX_HEIGHT * 6` — **1320 px on a 1080 px viewport** — and the glyph is
 * taller than the screen. It is centred, so it is not *gone*, but for as long as it is bigger than the viewport the player
 * is looking at the middle of a letter rather than at a number: the caption only becomes a readable glyph in the last part
 * of the tween, which is how a 0.2 s animate-in came to read as an instant flash.
 *
 * `2.7` keeps the "arriving from closer to the camera" read — the glyph starts nearly three times its resting size — while
 * leaving it small enough to be a whole number for the entire tween. The scale is what makes the motion legible; the
 * durations (raised separately) are what make it last.
 */
const SCALE_INCOMING = 2.7;

// The three tweens the sequence uses. `Quad`/`Out` throughout: fast at the start, settling at the end, which is what makes
// the sweep read as something moving past the camera rather than as a linear zoom.
const SWEEP_OUT_TWEEN = new TweenInfo(CAPTION_OUT_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const SWEEP_IN_TWEEN = new TweenInfo(CAPTION_IN_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const START_FADE_TWEEN = new TweenInfo(START_FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

// #endregion

// #region geometry

/**
 * **Placeholder.** The caption's type size, in pixels, before any scaling.
 *
 * Fixed rather than `TextScaled`: `TextScaled` re-typesets at every step of the tween, so the glyphs would reflow their own
 * line height while the `UIScale` was also multiplying the box — two size changes fighting over one word. The frame is
 * transparent and only glyphs draw, so a box this big costs nothing to look at.
 */
const TEXT_SIZE = 144;

/** **Placeholder.** The label's box, in pixels. Wide enough for `Start!` at `TEXT_SIZE`; tall enough for its cap height. */
const BOX_WIDTH = 720;
const BOX_HEIGHT = 220;

/**
 * **Placeholder.** The caption's typeface: `GothamBlack` rather than the game's `GothamMedium` (`FONT`).
 *
 * The same call `payout-controller`, `reward-toast-controller` and the leaderboard's title make — a poster-sized element
 * takes the black weight, and the theme's font stays the font of body copy. Named locally so "what font is the countdown"
 * has one answer in one file.
 */
const COUNTDOWN_FONT = Enum.Font.GothamBlack;

/** **Placeholder.** The outline's thickness, in pixels. Heavier than a panel's 2 px because this is a poster outline. */
const OUTLINE_THICKNESS = 4;

// #endregion

/**
 * The 3-2-1-Start! countdown that fills the last seconds of `Waiting`.
 *
 * ## Why the countdown is in `Waiting` and not a frozen `Playing`
 *
 * Because `Waiting` is already frozen and `Playing` is not. Every moving thing in this game — the belt ramp, `BALL_SPEED`'s
 * decay, pickups, the round song, the motion blur — starts on `Playing` entry, so a countdown drawn inside `Playing` would
 * have to hold all of them back or draw over a race that had already begun. `Waiting` needs nothing held: the belt is
 * stopped (`enterWaiting` sets speed 0), the spawner's simulation is off (`setRoundActive(false)`), and the bodies are
 * already on the belt because they spawn at `Waiting` entry. **No freeze code exists in this round, and none is needed.**
 *
 * ## Why it reads a deadline rather than counting down locally
 *
 * A local countdown is a second clock. It would start when this controller noticed `Waiting` — which for a late joiner is
 * whenever they arrived — and it would drift by every frame the client missed. The server publishes the *time `Waiting`
 * ends*; this controller subtracts the sequence's own length and asks `countdownSteps` which step that is. The same table
 * then serves a client that has been there since the start and one that arrived in the middle, which is the property a
 * chain of `task.delay`s cannot have.
 *
 * ## Why the countdown ends at `Playing` entry rather than starting when the picker closes (item 152)
 *
 * The controller **can** derive the picker's close time — it is `playingDeadline - (WAITING_SECONDS -
 * PICKER_WINDOW_SECONDS)`, and both constants are in `shared/tuning.ts` — so anchoring the sequence to the panel instead of
 * to the phase was available. It was declined, for two reasons.
 *
 * **The first is that alignment cannot make a countdown feel slower.** Sliding a fixed 3 s sequence a second earlier leaves
 * every tween exactly as fast; it only moves the hole. Whatever the caller is feeling, the durations and the incoming scale
 * are the only two things that can change it, which is why those are what item 152 changed.
 *
 * **The second is what `Start!` means.** Ending on the phase change makes the cue land *on* the start; ending early
 * replaces it with three quarters of a second of frozen belt and no caption, which reads as the countdown having finished
 * before the race did. So the sequence keeps `playingDeadline` as its end, and the room for it comes out of the pick
 * window instead — see `PICKER_WINDOW_SECONDS`.
 *
 * ## Why the elements are destroyed rather than hidden
 *
 * One label per phase, kept invisible, is a leak that only shows up after a long session — and the next countdown would
 * have to find and reuse it. `Destroy()` takes the stroke and the `UIScale` with it, because both are children of the label.
 *
 * ## What this controller does not decide
 *
 * Whether the countdown should be playing at all. `RoundState` is the authority: any phase but `Waiting` tears the caption
 * down, which is what makes debug key `3` (force `Playing`) skip it and key `1` (force `Intermission`) clear it, with no
 * key-specific code in this file.
 */
@Controller()
export class CountdownController implements OnStart {
	private readonly theme: Theme = getTheme();

	/** The caption's view while a countdown is on screen, or `undefined` between countdowns. */
	private view?: CountdownView;

	/** The tweens of the current step, so the next step - or a phase change - can cancel them. */
	private running = new Array<Tween>();

	/** The server's current phase, as last read. */
	private phase = "unknown";

	/** The published deadline, in server time. `0` means the server says no countdown is due. */
	private deadline = 0;

	/** Which step is on screen, so a change is a change. `-1` before the countdown starts. */
	private stepIndex = -1;

	/** The deadline the `start` line was last printed for, so it prints once per countdown rather than once per frame. */
	private announcedDeadline = 0;

	/** The deadline the `skipped` line was last printed for, for the same reason. */
	private skippedDeadline = 0;

	public onStart(): void {
		const phase = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, REPLICATED_WAIT_SECONDS);
		const deadline = ReplicatedStorage.WaitForChild(PLAYING_DEADLINE_VALUE_NAME, REPLICATED_WAIT_SECONDS);

		if (phase === undefined || !phase.IsA("StringValue")) {
			warn(`[Countdown] no ${ROUND_STATE_VALUE_NAME} StringValue — no countdown is possible without a phase.`);
			return;
		}

		if (deadline === undefined || !deadline.IsA("NumberValue")) {
			warn(
				`[Countdown] no ${PLAYING_DEADLINE_VALUE_NAME} NumberValue — no countdown is possible without a deadline.`,
			);
			return;
		}

		this.phase = phase.Value;
		this.deadline = deadline.Value;

		// `GetPropertyChangedSignal("Value")` rather than `Changed`: `Changed` also fires for a `Name` write, which would run
		// the whole apply path for a value that had not moved.
		phase.GetPropertyChangedSignal("Value").Connect(() => {
			this.phase = phase.Value;
			this.apply();
		});
		deadline.GetPropertyChangedSignal("Value").Connect(() => {
			this.deadline = deadline.Value;
			this.apply();
		});

		// A client that starts mid-`Waiting` reads both values once and starts where the clock says it is — the same reason
		// `RoundStateController` reads the phase before subscribing to it.
		this.apply();

		// The tick is unconditional and cheap: three comparisons on a controller with nothing on screen. A loop that started
		// and stopped with the phase would be a second thing to keep in step with `apply`.
		RunService.Heartbeat.Connect(() => this.tick());

		print(
			`[Countdown] mounted layer=splash font=${COUNTDOWN_FONT.Name} duration=${COUNTDOWN_SECONDS}s captions=${STEPS.size()}`,
		);
	}

	/**
	 * Reacts to a phase change or a new deadline. Decides only *whether* there is a countdown; *which caption* is `tick`'s
	 * job, because that changes every few frames.
	 */
	private apply(): void {
		if (this.phase !== PHASE_WAITING || this.deadline <= 0) {
			this.clear();
			return;
		}

		const remaining = this.deadline - Workspace.GetServerTimeNow();

		if (remaining <= 0) {
			// The window is over before this client could draw any of it: a late joiner arriving between the deadline and the
			// phase change, or a client whose `Waiting` was entered by a debug jump with no time left. Nothing is wrong, and
			// saying so once is the whole of the handling.
			if (this.skippedDeadline !== this.deadline) {
				this.skippedDeadline = this.deadline;
				print(`[Countdown] skipped (deadline past by ${math.abs(remaining)}s)`);
			}

			this.clear();
			return;
		}

		if (this.announcedDeadline !== this.deadline) {
			this.announcedDeadline = this.deadline;
			// `startsIn` rather than `remaining`: the two differ by the sequence's own length, and it is the one number that
			// says whether this client is watching the gap, joining mid-countdown (negative), or has missed it (the `skipped`
			// branch above). The deadline alone cannot show that.
			print(
				`[Countdown] start playingDeadline=${this.deadline} duration=${COUNTDOWN_SECONDS}s startsIn=${remaining - COUNTDOWN_SECONDS}s`,
			);
		}
	}

	/**
	 * The per-frame driver: works out which step the clock is in and starts that step's tween the first frame it is in it.
	 *
	 * **Derived from the deadline, never from the previous frame.** `elapsed` is measured back from `deadline -
	 * COUNTDOWN_SECONDS` every time, so a dropped frame, a hitch or a paused tab shifts nothing: the caption shown is
	 * always the one the server's clock says it is. This is the same argument `picker-controller`'s `tickCountdown` makes
	 * about its number.
	 */
	private tick(): void {
		if (this.phase !== PHASE_WAITING || this.deadline <= 0) {
			return;
		}

		const elapsed = COUNTDOWN_SECONDS - (this.deadline - Workspace.GetServerTimeNow());

		if (elapsed < 0) {
			// The gap between the picker closing and the `3` arriving. Nothing to draw yet; if a previous countdown's
			// elements somehow survived, they must not show through it.
			this.stepIndex = -1;
			if (this.view !== undefined) {
				this.clear();
			}

			return;
		}

		if (elapsed >= COUNTDOWN_SECONDS) {
			// The sequence is over and `Playing` has not been published yet. The last fade has already left it invisible, so
			// the only thing left to do is stop paying for the element - and to say once that it finished.
			if (this.view !== undefined) {
				print(`[Countdown] done`);
				this.clear();
			}

			return;
		}

		const stepIndex = countdownStepIndex(STEPS, elapsed);
		if (stepIndex === this.stepIndex) {
			return;
		}

		const step = STEPS[stepIndex];
		if (step === undefined) {
			// Unreachable: the index comes from this table and the elapsed window is [0, COUNTDOWN_SECONDS). Stated rather
			// than asserted because a crash in a 60 Hz loop is a worse outcome than a missing caption.
			return;
		}

		this.stepIndex = stepIndex;
		this.showStep(step, this.deadline - Workspace.GetServerTimeNow());
	}

	/**
	 * Puts one step on screen: the caption, the state that step starts from, and its tween.
	 *
	 * The step's *own* opening state is assigned first, every time, rather than trusting wherever the previous tween left
	 * the numbers. That is what makes a client that joins during an `out` step look the same as one that watched the `in`
	 * step finish — and it is also what keeps a cancelled tween from leaving a half-scaled caption behind.
	 */
	private showStep(step: CountdownStep, remaining: number): void {
		const view = this.ensureView();
		if (view === undefined) {
			return;
		}

		// Every step replaces the previous one: the steps are contiguous, so the previous tween has just finished - but a
		// client that hitched can arrive here mid-tween, and two tweens on one property fight.
		this.cancelRunning();

		view.label.Text = step.caption;
		print(`[Countdown] caption=${step.caption} remaining=${remaining}s`);

		if (step.kind === "in") {
			this.setCaptionState(view, SCALE_INCOMING, 1);
			this.play([
				TweenService.Create(view.scale, SWEEP_IN_TWEEN, { Scale: SCALE_REST }),
				TweenService.Create(view.label, SWEEP_IN_TWEEN, { TextTransparency: 0 }),
				// The outline is its own transparency. Leaving it at 0 would draw a black copy of the glyphs over the belt
				// while the fill was still invisible.
				TweenService.Create(view.stroke, SWEEP_IN_TWEEN, { Transparency: 0 }),
			]);
			return;
		}

		if (step.kind === "out") {
			this.setCaptionState(view, SCALE_REST, 0);
			this.play([
				TweenService.Create(view.scale, SWEEP_OUT_TWEEN, { Scale: SCALE_SWEPT }),
				TweenService.Create(view.label, SWEEP_OUT_TWEEN, { TextTransparency: 1 }),
				TweenService.Create(view.stroke, SWEEP_OUT_TWEEN, { Transparency: 1 }),
			]);
			return;
		}

		// `hold` and `fade` are the start cue at rest. `hold` has no tween at all - it is the pause that makes the cue land
		// before anything moves again.
		this.setCaptionState(view, SCALE_REST, 0);

		if (step.kind === "fade") {
			this.play([
				TweenService.Create(view.label, START_FADE_TWEEN, { TextTransparency: 1 }),
				TweenService.Create(view.stroke, START_FADE_TWEEN, { Transparency: 1 }),
			]);
		}
	}

	/** Assigns the three numbers a step starts from. `transparency` applies to both the fill and the outline. */
	private setCaptionState(view: CountdownView, scale: number, transparency: number): void {
		view.scale.Scale = scale;
		view.label.TextTransparency = transparency;
		view.stroke.Transparency = transparency;
	}

	private play(tweens: Array<Tween>): void {
		for (const tween of tweens) {
			tween.Play();
			this.running.push(tween);
		}
	}

	private cancelRunning(): void {
		for (const tween of this.running) {
			tween.Cancel();
		}

		this.running = new Array<Tween>();
	}

	/**
	 * Builds the caption on first use and returns it afterwards.
	 *
	 * No frame: the `TextLabel` is the whole element, anchored at the centre of the splash layer, so scaling it grows it
	 * symmetrically about that anchor and there is nothing else to position. A `UIScale` multiplies its parent's **size**
	 * (`UIScale.Scale`, "the multiplier to apply to the parent UI element's size"), which is why the anchor point is what
	 * keeps the sweep centred rather than the text drifting toward a corner as it grows.
	 */
	private ensureView(): CountdownView | undefined {
		const existing = this.view;
		if (existing !== undefined) {
			return existing;
		}

		const label = new Instance("TextLabel");
		label.Name = "Countdown";
		label.AnchorPoint = new Vector2(0.5, 0.5);
		label.Position = UDim2.fromScale(0.5, 0.5);
		label.Size = UDim2.fromOffset(BOX_WIDTH, BOX_HEIGHT);
		label.BackgroundTransparency = 1;
		label.BorderSizePixel = 0;
		label.Font = COUNTDOWN_FONT;
		label.TextSize = TEXT_SIZE;
		label.TextColor3 = this.theme.colors.textPrimary;
		// Centred alignment, not a hug around the glyphs: it keeps the `3`, the `2` and `Start!` on the same centre line, so
		// the sequence does not appear to wander sideways between captions.
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.Text = "";
		label.Parent = getScreenGui("splash");

		// The project's one outline builder, then tuned for a poster: `outlineText` is sized for body copy on a panel, and a
		// 2 px line around a 144 px glyph is invisible against a belt. `Color` is set for the same reason - the theme's
		// `shadow` rather than pure black, so the caption belongs to the same family as the elimination splash.
		const stroke = outlineText(label);
		stroke.Color = this.theme.colors.shadow;
		stroke.Thickness = OUTLINE_THICKNESS;

		// The scale lives on the label so the glyphs and their outline grow together, and so nothing re-typesets: `TextSize`
		// never changes, only the transform applied to the rendered element.
		const scale = new Instance("UIScale");
		scale.Scale = SCALE_REST;
		scale.Parent = label;

		const view: CountdownView = { label, stroke, scale };
		this.view = view;
		return view;
	}

	/** Cancels the tweens, destroys the caption, and forgets the step. Safe to call when nothing is on screen. */
	private clear(): void {
		this.cancelRunning();
		this.stepIndex = -1;

		const view = this.view;
		if (view === undefined) {
			return;
		}

		// One `Destroy()`: the stroke and the `UIScale` are children of the label.
		view.label.Destroy();
		this.view = undefined;
	}
}

/** One caption's elements. The label is the root; the other two die with it. */
interface CountdownView {
	readonly label: TextLabel;
	readonly stroke: UIStroke;
	readonly scale: UIScale;
}
