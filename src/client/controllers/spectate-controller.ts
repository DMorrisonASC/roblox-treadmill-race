import { Players, ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYER_COMPETING_ATTRIBUTE } from "shared/attributes";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { spectateAvailable } from "shared/spectate";
import { applyChunkyChrome, shadowOf } from "shared/ui/chunky-chrome";
import { getScreenGui } from "shared/ui/layers";
import { chunkyDarkTheme } from "shared/ui/theme";
import {
	SPECTATE_BUTTON_HEIGHT,
	SPECTATE_BUTTON_MARGIN,
	SPECTATE_BUTTON_WIDTH,
	SPECTATE_LABEL_OFF,
	SPECTATE_LABEL_ON,
	SPECTATE_LABEL_TEXT_SIZE,
} from "shared/tuning";
import { TreadmillCameraController } from "./treadmill-camera-controller";

/**
 * **A button for the players who are not in the round**, which hands them the arena camera and gives it back.
 *
 * ## Why the button exists at all
 *
 * Before item 193 a non-competitor's camera was taken by the phase rule alone (`TreadmillCameraController`), so the arena
 * pose was on screen from `Waiting` to `PostGame` whether they wanted it or not, and there was nothing to toggle — an `off`
 * state that the camera was already in would have been a lie. The camera now excludes non-competitors from the automatic
 * engage, which is what makes this control meaningful: it is the *only* way a spectator sees the race.
 *
 * ## When it is on screen
 *
 * `spectateAvailable(phase, competing)` — never for a competitor, and only in `Waiting`, `Playing` and `PostGame`. That is
 * the same window the camera can be taken over for, so the control is offered exactly when pressing it does something.
 * `Intermission` is excluded because there is nothing to watch: every body was cleared on the way in and the wipe covers part
 * of the phase.
 *
 * ## Where it lives
 *
 * `hudCore`, with the picker and the leaderboard — it is a HUD control, not a page. It has no layer of its own because a new
 * `ScreenGui` would need a new display order in a chain the guide states as total (`UI_STYLE_GUIDE.md` §4.3), and this
 * element never draws over a sheet or a wipe: at order 20 it sits under both, which is correct for a control that belongs to
 * the round rather than to a modal.
 *
 * ## What it touches
 *
 * One flag, through `TreadmillCameraController.setSpectating`. Every camera decision — engage, restore, survival across a
 * phase change, the reset suppression — stays in the controller that already owns it; the button has no camera code and no
 * second restore path.
 */
@Controller()
export class SpectateController implements OnStart {
	/** The chrome's label, so the two words are one assignment. */
	private label?: TextLabel;

	private button?: TextButton;

	/** The phase the camera is keyed on, kept so a change can be re-read without another `WaitForChild`. */
	private roundState?: StringValue;

	/** This player's own copy of the replicated fact. */
	private competing = false;

	/** Whether the player has asked to watch. The camera owns the consequence; this owns the label. */
	private spectating = false;

	/** Injected so the button can ask the camera directly rather than through an attribute or an event. */
	constructor(private readonly camera: TreadmillCameraController) {}

	public onStart(): void {
		const theme = chunkyDarkTheme();

		const button = new Instance("TextButton");
		button.Name = "SpectateButton";
		// Bottom centre, inside the inset the layer already applies. `AnchorPoint` at the bottom edge means the margin is
		// measured from that edge rather than from the button's own centre.
		button.AnchorPoint = new Vector2(0.5, 1);
		button.Position = new UDim2(0.5, 0, 1, -SPECTATE_BUTTON_MARGIN);
		button.Size = UDim2.fromOffset(SPECTATE_BUTTON_WIDTH, SPECTATE_BUTTON_HEIGHT);
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		// **Empty and never drawn.** `applyChunkyChrome` turns the button into a transparent hit area and puts the paint one
		// level down; the text has to be a label on the face or the face covers it.
		button.Text = "";
		button.Visible = false;
		button.Parent = getScreenGui("hudCore");

		const chrome = applyChunkyChrome(button, {
			color: theme.colors.accent,
			shadowColor: shadowOf(theme.colors.accent),
			zIndex: 1,
			// Above the face (`zIndex + 1`) and its ring, or the label is drawn under the plates.
			label: {
				text: SPECTATE_LABEL_OFF,
				textSize: SPECTATE_LABEL_TEXT_SIZE,
				color: theme.colors.onAccent,
				zIndex: 6,
			},
		});

		this.button = button;
		this.label = chrome.label;

		button.Activated.Connect(() => this.toggle());

		// The phase: a `StringValue` the server writes on every transition. Bounded wait, matching every other controller's
		// discipline — an unbounded `WaitForChild` turns "the server never created it" into a client that yields for ever.
		const state = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, 10);
		if (state === undefined || !state.IsA("StringValue")) {
			warn(`[Spectate] no ${ROUND_STATE_VALUE_NAME} — the spectate button will not be offered this session.`);
			return;
		}

		this.roundState = state;
		state.GetPropertyChangedSignal("Value").Connect(() => this.refresh());

		// **The competitor fact, watched rather than polled.** A client can start mid-round, so it is read once here as well;
		// it arrives asynchronously from `RoundService` and `GetAttributeChangedSignal` is what makes its timing irrelevant.
		const player = Players.LocalPlayer;
		if (player !== undefined) {
			player.GetAttributeChangedSignal(PLAYER_COMPETING_ATTRIBUTE).Connect(() => {
				this.competing = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE) === true;
				this.refresh();
			});
			this.competing = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE) === true;
		}

		this.refresh();
		print(`[Spectate] mounted competing=${tostring(this.competing)} phase=${this.phaseName()}`);
	}

	/** Flips the ask and lets the camera act on it. */
	private toggle(): void {
		this.spectating = !this.spectating;
		this.camera.setSpectating(this.spectating);
		this.refresh();
		print(`[Spectate] spectating=${tostring(this.spectating)} phase=${this.phaseName()}`);
	}

	/**
	 * The one place the button's visibility and its words are decided.
	 *
	 * **A competitor clears the latch**, and that is not bookkeeping: a racer watching their own ball from a fixed pose cannot
	 * play, so the moment this player is spawned into a round the ask is withdrawn and the camera returns to the phase rule.
	 * The case is reachable — a spectator in `Intermission` who enrolls, or a debug spawn — which is why it is stated here
	 * rather than assumed impossible.
	 */
	private refresh(): void {
		const button = this.button;
		const label = this.label;

		if (button === undefined || label === undefined) {
			return;
		}

		if (this.competing && this.spectating) {
			this.spectating = false;
			this.camera.setSpectating(false);
		}

		const available = spectateAvailable(this.phaseName(), this.competing);
		button.Visible = available;
		label.Text = this.spectating ? SPECTATE_LABEL_ON : SPECTATE_LABEL_OFF;
	}

	/** The current phase, or `none` before `RoundState` has replicated. */
	private phaseName(): string {
		const state = this.roundState;
		return state === undefined ? "none" : state.Value;
	}
}
