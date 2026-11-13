import { ContextActionService, Players, ReplicatedStorage, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { JUMP_REMOTE_NAME, REMOTES_FOLDER_NAME, ROUND_STATE_VALUE_NAME, STEER_AXIS_REMOTE_NAME } from "shared/remotes";
import { JUMP_COOLDOWN_SECONDS, JUMP_IMPULSE, SLOW_DRAIN_RATE, STEER_SPEED } from "shared/tuning";

/** The five actions, named once: `BindAction` and `UnbindAction` both key on these strings. */
const STEER_LEFT_ACTION = "SteerLeft";
const STEER_RIGHT_ACTION = "SteerRight";
const STEER_THUMBSTICK_ACTION = "SteerThumbstick";
const SLOW_ACTION = "SlowDown";
const JUMP_ACTION = "Jump";

/** **Placeholder.** Thumbstick deflection below this reads as centred - stick drift, not a design number. */
const THUMBSTICK_DEADBAND = 0.2;

/** **Placeholder.** How far the axis must move before another message goes out. Ten messages for a full sweep. */
const AXIS_SEND_THRESHOLD = 0.1;

/** The phase a round's steering belongs to. A client cannot import the server's `RoundPhase`. */
const PHASE_PLAYING = "Playing";

/** How long to wait for the remote and the phase value before saying so; the tree's bounded-wait convention. */
const MOUNT_WAIT_SECONDS = 10;

/**
 * The local player's **ball controls**: steering, slow and jump, sent to the server when they change.
 *
 * ## What this is
 *
 * A thin input reader for every per-player ball control the game has. Two continuous axes and one event:
 *
 * - **`lateral`** - `A`/`Left`/`DPadLeft`, `D`/`Right`/`DPadRight`, or the left thumbstick's `X`. Folded into one number.
 * - **`slow`** - `W`/`Up`/`DPadUp` (or `S`/`Down`/`DPadDown`), or the thumbstick's `Y` pulled toward the player. One number,
 *   and the one control that **costs ground**: dropping `BALL_SPEED` below `BELT_SPEED` carries the ball toward the exit
 *   edge, further from where it spawned.
 * - **`jump`** - `Space`/`ButtonA`, an **event**, not a value.
 *
 * `lateral` and `slow` travel together on one `SteerAxis` message as `Vector2(lateral, slow)`, fired when either moves by
 * more than `AXIS_SEND_THRESHOLD`; `jump` has its own remote because it is an instant rather than a state. The server owns
 * every consequence: `BallSpawnerService` reads both axes by the body's `OwnerUserId`, writes `lateral * STEER_SPEED` into
 * the lateral component, drains `BALL_SPEED` by `slow * SLOW_DRAIN_RATE`, and applies `JUMP_IMPULSE` to `Y` when a press
 * has been accepted (items 220, 222).
 *
 * ## Why the file is still called `steer-controller`
 *
 * It now owns all three controls, and the name says one of them. **The rename is not taken because it would touch
 * `flamework.build`'s registry for a change with no behaviour in it** - a whole regenerated file, and a diff that hides the
 * three lines that actually matter. The class docblock is the record; a later round that adds a fourth control, or that
 * splits the touch UI out, is the round to rename it.
 *
 * ## What this is not
 *
 * - **Not a movement system.** It writes no velocity, no position and no attribute; the only thing it produces is a number on
 *   a wire. Everything about how far and how fast a ball moves is on the server, where the round is.
 * - **Not a custom touch UI any more (item 236).** Every `BindAction` here passes `createTouchButton = false`, so the engine
 *   draws nothing on this file's behalf. The four `◀ ▶ ▼ ▲` buttons item 220 shipped are gone: they were a second, chunkier
 *   control scheme laid over the one the engine already draws, and on a phone they read as a right-hand thumbstick that this
 *   game does not have. **The native left joystick is the touch input** - it arrives here as `Enum.KeyCode.Thumbstick1` on the
 *   stick binding below, which is the same physical control the default control scripts use.
 * - **Not the owner of the engine's touch UI, and it must not hide it.** `TouchGui.TouchControlFrame.TouchThumbstick` is the
 *   **left, movement** stick - the very control this file reads - so hiding it would delete the joystick in the act of
 *   "hiding the camera stick". The default mobile UI has no right-hand thumbstick to hide: the camera is dragged on empty
 *   screen, which is not an `Instance` this tree can reach. `TouchJump` is likewise left alone; it is the `ButtonA` the jump
 *   binding listens for.
 * - **Not a `PlayerModule` bridge, and that is a finding rather than a shortcut.** `PlayerModule:GetControls():GetMoveVector()`
 *   is the documented way to read the joystick as a vector, and this place cannot rely on it: item 161's log is
 *   `[Controls] no PlayerModule under Players.<name>.PlayerScripts after 10s`, and `controls-lock.ts` still treats the module as
 *   best-effort for that reason. `Thumbstick1` through `ContextActionService` needs no module lookup, no 10-second wait and no
 *   `require` of a client module, and it is the same stick - so the axis is read from the input event instead.
 *
 * - **Not an owner of the keys.** Every handler returns `Enum.ContextActionResult.Pass`, so the character controller underneath
 *   still sees each press. Returning nothing would **sink** the input - the engine's default for a handler with no return -
 *   and freeze the character for the whole session. See `bindActions`.
 *
 * ## Why the bindings are always active, and why the map is not reset per round
 *
 * The bindings do not know about phases. A player who releases `A` while the round changes still has to tell the server that
 * the axis is now `0`, and the server discarding an axis for a player with no body is free - it is one map lookup per ball in
 * a loop that already runs. Gating the bindings on `Playing` would mean a key held across the transition sends nothing.
 *
 * The server's map persists across rounds for the same reason, and the **one reassert** on `Playing` entry (below) is what
 * makes a stale value impossible: the client sends its current axis once, whether or not it changed, so the server's copy is
 * correct at the first tick of every round rather than whenever the player next moves their hand.
 *
 * ## Why the send is on-change and not per frame
 *
 * At most `1 / AXIS_SEND_THRESHOLD` messages per full sweep - ten - and typically zero or one per second. A per-frame send
 * would be sixty messages a second per player carrying no information ninety-nine percent of the time.
 */
@Controller()
export class SteerController implements OnStart {
	private readonly player = Players.LocalPlayer;

	private leftDown = false;
	private rightDown = false;
	private slowDown = false;
	private thumbstickX = 0;
	private thumbstickY = 0;

	/** The last `(lateral, slow)` this client sent, so the heartbeat can send only real changes. */
	private lastSentLateral = 0;
	private lastSentSlow = 0;

	private remote?: RemoteEvent;
	private jumpRemote?: RemoteEvent;
	private heartbeat?: RBXScriptConnection;

	public onStart(): void {
		this.remote = this.findRemote();
		this.jumpRemote = this.findJumpRemote();
		this.bindActions();

		const heartbeat = RunService.Heartbeat.Connect(() => this.pushAxis());
		this.heartbeat = heartbeat;

		this.watchPhase();
		this.watchTeardown();

		print(
			`[Steer] mounted speed=${STEER_SPEED} slowDrain=${SLOW_DRAIN_RATE} jumpImpulse=${JUMP_IMPULSE} jumpCooldown=${JUMP_COOLDOWN_SECONDS}s touch=native actions=${STEER_LEFT_ACTION},${STEER_RIGHT_ACTION},${STEER_THUMBSTICK_ACTION},${SLOW_ACTION},${JUMP_ACTION}`,
		);
	}

	/** The remote, or `undefined` after a bounded wait. A missing remote is non-fatal: the buttons still move, nothing steers. */
	private findRemote(): RemoteEvent | undefined {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, MOUNT_WAIT_SECONDS);
		if (folder === undefined) {
			warn(`[Steer] no ${REMOTES_FOLDER_NAME} folder — steering will not reach the server.`);
			return undefined;
		}

		const remote = folder.WaitForChild(STEER_AXIS_REMOTE_NAME, MOUNT_WAIT_SECONDS);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[Steer] no ${STEER_AXIS_REMOTE_NAME} RemoteEvent — steering will not reach the server.`);
			return undefined;
		}

		return remote;
	}

	/** The jump remote, or `undefined` after the same bounded wait. Separate because it is a different message. */
	private findJumpRemote(): RemoteEvent | undefined {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, MOUNT_WAIT_SECONDS);
		if (folder === undefined) {
			return undefined;
		}

		const remote = folder.WaitForChild(JUMP_REMOTE_NAME, MOUNT_WAIT_SECONDS);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[Steer] no ${JUMP_REMOTE_NAME} RemoteEvent — the jump button will do nothing.`);
			return undefined;
		}

		return remote;
	}

	/**
	 * Binds the five actions.
	 *
	 * ## Every handler returns `ContextActionResult.Pass`, and that is load-bearing (item 224)
	 *
	 * **A `BindAction` handler that returns nothing Sinks the input.** The installed typings say it on
	 * `ContextActionResult.Sink`: *"This is the default behavior if `functionToBind` does not return anything"*. Sinking means
	 * "no other bound actions under this one will be processed" - and the default character controller is a set of bound
	 * actions on the same stack, at a lower priority.
	 *
	 * So the first version of this file **swallowed `W`/`A`/`S`/`D`, the arrows and `Space` for the whole session** and the
	 * character could not walk anywhere. That is the reported symptom, and it read as "the character is frozen" rather than as
	 * "a controller is eating my keys", because nothing errored and nothing logged.
	 *
	 * **`Pass` lets the input continue to everything below.** This file still reads the key; the character controller also gets
	 * it. There is no conflict of intent, because the body those controls move is frozen for the whole of `Playing` -
	 * `CharacterFreezeController` zeroes `WalkSpeed` and `lockControls` disables the module - so the only phase where both
	 * would react is one where one of them cannot.
	 */
	private bindActions(): void {
		// **`false`: no button of ours.** This file used to pass `true` on four of these bindings, which made the engine draw a
		// `◀ ▶ ▼ ▲` pad over the game - the last of the custom touch UI (item 236). Every touch input now comes from the
		// **engine's own controls**: the left joystick arrives on the `Thumbstick1` binding below, and the jump is the native
		// `TouchJump` button, which fires `ButtonA`. `ContextActionService` still sees both; it just draws nothing.
		ContextActionService.BindAction(
			STEER_LEFT_ACTION,
			(_name, state) => {
				this.leftDown = state === Enum.UserInputState.Begin || state === Enum.UserInputState.Change;
				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.KeyCode.A,
			Enum.KeyCode.Left,
			Enum.KeyCode.DPadLeft,
		);

		ContextActionService.BindAction(
			STEER_RIGHT_ACTION,
			(_name, state) => {
				this.rightDown = state === Enum.UserInputState.Begin || state === Enum.UserInputState.Change;
				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.KeyCode.D,
			Enum.KeyCode.Right,
			Enum.KeyCode.DPadRight,
		);

		// **The slow input** (item 222). **`W`/Up/`DPadUp`** for a keyboard or a d-pad - the "back off" key a player reaches for
		// first, and the one item 222's own brief named; the previous build bound only `S`/Down/`DPadDown`, so a player told to
		// press `W` found nothing there. Those are kept as alternates. The thumbstick's `Y` is read on the stick binding below,
		// because one `BindAction` per physical stick is the only way to get both of its axes.
		//
		// The sign is **positive for "slow down"**, matching the keyboard's own reading: pulling the stick toward the player
		// (`Y` below `0`) is the natural "back off" gesture, so the axis is negated on the way in - see `currentSlow`.
		ContextActionService.BindAction(
			SLOW_ACTION,
			(_name, state) => {
				this.slowDown = state === Enum.UserInputState.Begin || state === Enum.UserInputState.Change;
				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.KeyCode.W,
			Enum.KeyCode.Up,
			Enum.KeyCode.DPadUp,
			// **`S`/Down keep working too.** They were the first build's binding and reading the two arrows as a pair is as
			// natural as reading `W`. Two physical keys per direction on one action refuses nobody and costs nothing.
			Enum.KeyCode.S,
			Enum.KeyCode.Down,
			Enum.KeyCode.DPadDown,
		);

		// **`false`: the stick needs no button**, and `Change` is the state that carries the deflection.
		ContextActionService.BindAction(
			STEER_THUMBSTICK_ACTION,
			(_name, state, input) => {
				if (state === Enum.UserInputState.End) {
					this.thumbstickX = 0;
					this.thumbstickY = 0;
					return Enum.ContextActionResult.Pass;
				}

				this.thumbstickX = input.Position.X;
				this.thumbstickY = input.Position.Y;
				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.KeyCode.Thumbstick1,
		);

		// **The jump, and it is the only binding that does anything on `Begin` alone** (item 222). `End` and `Cancel` are
		// deliberately ignored: one press is one impulse, and the server is what decides whether the press is within the
		// cooldown. There is no client-side rate limit - see the class docblock for why the authority owns it.
		// **`false`: the native `TouchJump` is the button.** The engine's own jump control fires `ButtonA`, which this binding
		// catches; drawing a second `▲` beside it was a duplicate of a control the player already had.
		ContextActionService.BindAction(
			JUMP_ACTION,
			(_name, state) => {
				if (state === Enum.UserInputState.Begin) {
					this.fireJump();
				}

				return Enum.ContextActionResult.Pass;
			},
			false,
			Enum.KeyCode.Space,
			Enum.KeyCode.ButtonA,
		);
	}

	/**
	 * The lateral axis the inputs currently add up to.
	 *
	 * **The stick wins when it is past `THUMBSTICK_DEADBAND`**, because it is analog and a player holding both is unlikely to
	 * mean the keys. Keyboard input is binary, so keyboard steering is full speed or nothing - which is the right reading of a
	 * key, and the only way to get proportional control on a keyboard would be a ramp the player did not ask for.
	 *
	 * `thumbstickX` is the native left joystick's `X` (item 236): `Enum.KeyCode.Thumbstick1`'s `InputObject.Position` is the
	 * same control the default touch scripts drive, read here without a `PlayerModule` lookup.
	 */
	private currentLateral(): number {
		if (math.abs(this.thumbstickX) > THUMBSTICK_DEADBAND) {
			return this.thumbstickX;
		}

		return (this.rightDown ? 1 : 0) - (this.leftDown ? 1 : 0);
	}

	/**
	 * The slow axis, `0 .. 1`: how hard the player is asking to lose speed.
	 *
	 * **Positive means slow, and the thumbstick's `Y` is negated to get there.** Pulling the stick toward the player is
	 * "back off", and a stick reports that as `Y < 0`, so `-Y` is the value the server wants: `1` for a full pull, `0` for
	 * centred and for pushed away. The axis never goes negative because there is nothing to speed up that the game does not
	 * already do - a ball's forward motion is `BALL_SPEED`, and the only control over it is this brake.
	 */
	private currentSlow(): number {
		if (math.abs(this.thumbstickY) > THUMBSTICK_DEADBAND) {
			return math.max(0, -this.thumbstickY);
		}

		return this.slowDown ? 1 : 0;
	}

	/** Sends both axes when either has moved enough to matter. Called from `Heartbeat`. */
	private pushAxis(): void {
		const lateral = this.currentLateral();
		const slow = this.currentSlow();

		const lateralMoved = math.abs(lateral - this.lastSentLateral) > AXIS_SEND_THRESHOLD;
		const slowMoved = math.abs(slow - this.lastSentSlow) > AXIS_SEND_THRESHOLD;
		if (!lateralMoved && !slowMoved) {
			return;
		}

		this.send(lateral, slow);
	}

	/**
	 * Sends both axes, **as two numbers, in `lateral, slow` order.**
	 *
	 * **Two arguments, not a `Vector2`, and that is a fix rather than a preference (item 223).** Item 222 shipped
	 * `FireServer(new Vector2(lateral, slow))` while the handler read `(player, lateral, slow)` as two separate values. A
	 * `Vector2` arrives as the *first* argument and the second is `nil`, so `storeSteerAxis`'s `typeIs(lateral, "number")`
	 * was false on every message and every steer was dropped **silently** - which is exactly why left/right stopped working
	 * while jump, on its own payload-free remote, kept working. A remote's arguments are positional and carry no types across
	 * the wire: the only contract between the two ends is how many there are and what order they come in, and nothing in the
	 * language checks it.
	 */
	private send(lateral: number, slow: number): void {
		this.lastSentLateral = lateral;
		this.lastSentSlow = slow;

		const remote = this.remote;
		if (remote === undefined) {
			return;
		}

		remote.FireServer(lateral, slow);
	}

	/**
	 * Sends one jump press.
	 *
	 * **No local cooldown, and that is the design rather than an omission.** The server owns the rate limit, and it is the only
	 * place a client cannot edit. A guard here would refuse presses the server would have accepted (a dropped `Begin`, a
	 * controller that repeats), and worse, it would look like the rate limit - so the next reader would assume the server had
	 * one.
	 */
	private fireJump(): void {
		const remote = this.jumpRemote;
		if (remote === undefined) {
			return;
		}

		remote.FireServer();
	}

	/**
	 * Reasserts the axis on every entry to `Playing`.
	 *
	 * **This is the fix for the only stale-value path in the design.** The server's map is not cleared per round (a player
	 * holding `A` into the next round expects their ball to steer `A`), and the client only sends on change - so a client
	 * holding `A` across a round boundary would send nothing at all, and the server's copy would be whatever the *last* round
	 * left. Firing the current axis once per `Playing` entry makes the server's copy correct at the first tick of the round,
	 * for one message per player per round.
	 */
	private watchPhase(): void {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, MOUNT_WAIT_SECONDS);
		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[Steer] no ${ROUND_STATE_VALUE_NAME} StringValue — the axis will not be reasserted per round.`);
			return;
		}

		const reassert = () => {
			if (value.Value !== PHASE_PLAYING) {
				return;
			}

			const lateral = this.currentLateral();
			const slow = this.currentSlow();
			this.send(lateral, slow);
			print(`[Steer] reassert axis=${lateral},${slow}`);
		};

		value.Changed.Connect(reassert);

		// A client that mounts mid-round has already missed the change, so the current value is asked once too.
		reassert();
	}

	/**
	 * Unbinds and disconnects when the place shuts down.
	 *
	 * **Flamework v5.9.3 has no `onStop`** (item 31: `OnInit` / `OnStart` / `OnTick` / `OnPhysics` / `OnRender` and nothing
	 * else), so `game.Destroying` is the tree's teardown hook - the same one every other controller uses.
	 */
	private watchTeardown(): void {
		game.Destroying.Connect(() => {
			ContextActionService.UnbindAction(STEER_LEFT_ACTION);
			ContextActionService.UnbindAction(STEER_RIGHT_ACTION);
			ContextActionService.UnbindAction(STEER_THUMBSTICK_ACTION);
			ContextActionService.UnbindAction(SLOW_ACTION);
			ContextActionService.UnbindAction(JUMP_ACTION);

			const heartbeat = this.heartbeat;
			if (heartbeat !== undefined) {
				heartbeat.Disconnect();
				this.heartbeat = undefined;
			}
		});
	}
}
