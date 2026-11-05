import { ReplicatedStorage, TweenService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { ELIMINATION_REMOTE_NAME, REMOTES_FOLDER_NAME } from "shared/remotes";
import { FONT, TYPOGRAPHY } from "shared/ui/scale";
import { getTheme, Theme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";

/** **Placeholder.** The one word the splash shows. Changing the wording is this constant and nothing else. */
const SPLASH_TEXT = "ELIMINATED";

// #region animation — the specification, not a suggestion

/**
 * **Placeholder.** How far the splash overshoots before settling, as a scale.
 *
 * The frame is scaled, never the label's `TextSize`: scaling a frame does not re-typeset, so the glyphs stay identical
 * through the whole pop, and a `TextScaled` label would reflow its own line height at every step of the tween.
 */
const POP_SCALE = 1.15;

/** **Placeholder.** Seconds for the overshoot. */
const POP_SECONDS = 0.15;

/** **Placeholder.** Seconds for the settle back to rest. */
const SETTLE_SECONDS = 0.1;

/** **Placeholder.** Seconds the splash holds at full size before fading. */
const HOLD_SECONDS = 0.5;

/** **Placeholder.** Seconds for the fade. */
const FADE_SECONDS = 0.2;

/**
 * **Placeholder.** Total lifetime, in seconds: pop + settle + hold + fade.
 *
 * Derived rather than written, because the destroy below is the only thing that stops a splash from existing forever and a
 * literal that drifted from the sum would either cut the fade short or leave a dead frame behind.
 */
const LIFETIME_SECONDS = POP_SECONDS + SETTLE_SECONDS + HOLD_SECONDS + FADE_SECONDS;

const POP_TWEEN = new TweenInfo(POP_SECONDS, Enum.EasingStyle.Back, Enum.EasingDirection.Out);
const SETTLE_TWEEN = new TweenInfo(SETTLE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
const FADE_TWEEN = new TweenInfo(FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In);

// #endregion

// #region geometry

/**
 * **Placeholder.** How far down the layer the splash sits, as a share of its height.
 *
 * 26% is high enough to clear the competitors and low enough to be inside the field of view. A share of the *layer*
 * rather than an offset, because the layer is inset to the core UI area — an offset from the physical top would sit under
 * the Roblox topbar on a phone while looking correct on a monitor.
 */
const SPLASH_TOP_SCALE = 0.26;

/** **Placeholder.** Height of the splash's frame, in pixels. Its width is the full layer. */
const SPLASH_HEIGHT = 64;

/** **Placeholder.** The outline's thickness, in pixels. Thicker than a HUD border: it is what makes one word legible. */
const STROKE_THICKNESS = 3;

/** **Placeholder.** How transparent the outline starts, so it reads as a shadow rather than as a border. */
const STROKE_TRANSPARENCY = 0.25;

// #endregion

/**
 * The arcade-style elimination splash: one big word that pops, holds, fades and destroys itself.
 *
 * ## Why this is not the phase banner
 *
 * The banner is a *state display*: it reads `RoundState` and `WinnerName` and stays up for the whole phase, because the
 * phase is a fact. A splash is a one-shot *event* — it happens once, at the moment a player's ball leaves the belt, and its
 * whole design is about being over. Sharing one controller would mean one object with two lifetimes and two readers, and
 * the first attempt to hide the banner would have to ask which of the two it was.
 *
 * ## Why the server tells it, rather than the client working it out
 *
 * A client can see its own competitor destroyed, but it cannot tell an elimination from a teardown, from the cap, or from
 * somebody else's round ending — and "was I eliminated" is exactly that distinction. The server makes the call
 * (`splashTargetUserId`) and fires one player; this controller renders what it is told and decides nothing.
 *
 * ## The theme direction
 *
 * `getTheme()` — the HUD direction — not `surfaceOpaqueTheme()`. The splash draws over the *world*, not over a panel, and
 * the reference's legibility comes from a light glyph on a near-black outline rather than from the glyph colour alone: that
 * pair survives both a pale arena and a dark one. The light direction's dark ink would need a light outline to be visible
 * against a dark sky, which inverts the look the splash is modelled on.
 *
 * ## Why the frame is destroyed and not hidden
 *
 * One frame per elimination, kept invisible, is a leak that only shows up after a long session — and it would also mean the
 * next splash had to find and reuse the old one. `Destroy()` at the end of the lifetime is the whole fix, and the last tween
 * cannot outlive it: `LIFETIME_SECONDS` is the sum of the four durations above.
 */
@Controller()
export class EliminationSplashController implements OnStart {
	private readonly theme: Theme = getTheme();

	public onStart(): void {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, 10);
		if (folder === undefined) {
			warn(`[Splash] no ${REMOTES_FOLDER_NAME} folder — eliminations will not be shown.`);
			return;
		}

		const remote = folder.WaitForChild(ELIMINATION_REMOTE_NAME, 10);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[Splash] no ${ELIMINATION_REMOTE_NAME} remote — eliminations will not be shown.`);
			return;
		}

		remote.OnClientEvent.Connect(() => this.splash());
		print(`[Splash] mounted on the splash layer`);
	}

	/**
	 * Builds one splash and starts its animation.
	 *
	 * Everything is local to this call, so two eliminations in quick succession produce two independent splashes that each
	 * destroy themselves. Nothing is stored on the controller, which is what keeps "is a splash showing" from becoming state
	 * that has to be reasoned about.
	 */
	private splash(): void {
		const gui = getScreenGui("splash");

		const frame = new Instance("Frame");
		frame.Name = "EliminationSplash";
		frame.AnchorPoint = new Vector2(0.5, 0.5);
		frame.Position = UDim2.fromScale(0.5, SPLASH_TOP_SCALE);
		frame.Size = new UDim2(1, 0, 0, SPLASH_HEIGHT);
		frame.BackgroundTransparency = 1;
		frame.BorderSizePixel = 0;
		frame.Parent = gui;

		// Word-only: no background, no panel, no toast. The text is the whole element.
		const label = new Instance("TextLabel");
		label.Name = "Word";
		label.Size = UDim2.fromScale(1, 1);
		label.BackgroundTransparency = 1;
		label.Font = FONT;
		label.TextSize = TYPOGRAPHY.h4.size;
		label.TextColor3 = this.theme.colors.textPrimary;
		label.TextXAlignment = Enum.TextXAlignment.Center;
		label.TextYAlignment = Enum.TextYAlignment.Center;
		label.Text = SPLASH_TEXT;
		label.Parent = frame;

		// `Contextual` so the outline hugs the glyphs rather than the label's box; without it the stroke draws a rectangle
		// around the text and the word reads as a caption in a box.
		const stroke = new Instance("UIStroke");
		stroke.Color = this.theme.colors.shadow;
		stroke.Thickness = STROKE_THICKNESS;
		stroke.Transparency = STROKE_TRANSPARENCY;
		stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual;
		stroke.Parent = label;

		// The scale lives on the frame so both the word and its outline grow together, and so nothing re-typesets.
		const scale = new Instance("UIScale");
		scale.Scale = 0;
		scale.Parent = frame;

		const pop = TweenService.Create(scale, POP_TWEEN, { Scale: POP_SCALE });
		const settle = TweenService.Create(scale, SETTLE_TWEEN, { Scale: 1 });
		const fade = TweenService.Create(label, FADE_TWEEN, { TextTransparency: 1 });
		const fadeOutline = TweenService.Create(stroke, FADE_TWEEN, { Transparency: 1 });

		pop.Play();
		task.delay(POP_SECONDS, () => settle.Play());
		task.delay(POP_SECONDS + SETTLE_SECONDS + HOLD_SECONDS, () => {
			fade.Play();
			// The outline fades with the word: leaving it would show an empty outline hanging in the air for 0.2 s.
			fadeOutline.Play();
		});

		task.delay(LIFETIME_SECONDS, () => frame.Destroy());
	}
}
