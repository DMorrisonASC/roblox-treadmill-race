import { ReplicatedStorage, UserInputService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import {
	DEBUG_PLAYING_REMOTE_NAME,
	DEBUG_SPAWN_REMOTE_NAME,
	DEBUG_WAITING_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
} from "shared/remotes";

/**
 * Drives the round from the keyboard for Studio testing: `1` → `Waiting`, `2` → `Playing`, `3` → spawn
 * four competitors.
 *
 * ## Why one controller for three keys
 *
 * This replaced `AdvancePhaseController`, which owned one key and one phase-advance remote. That split
 * was justified when the keys meant different things — `1` spawned balls from the *spawner* service and
 * `2` advanced the *round* — so they belonged to different services and different files. They now all
 * address `RoundService`, and a keypress that lands in the wrong service is exactly the kind of
 * misrouting that produced an untracked ghost ball in the 21:20 log. One controller, one remote folder,
 * one service on the other end.
 *
 * ## What each key does, and what it does not
 *
 * - **`1`** forces the machine to `Waiting`, which spawns **one** owned competitor. From `Playing` or
 *   `PostGame` it clears every ball first and restarts the synthetic `Debug#N` numbering — a jump back is
 *   a reset, not a nudge.
 * - **`2`** forces `Playing` from any other phase. It is refused while already `Playing`, because the
 *   alternative — restart the round — would destroy every competitor for one stray keypress.
 * - **`3`** spawns one competitor per bound spawner, each with its own owner. Refused outside `Playing`,
 *   because a body added to a phase whose tick is not running would never be counted or cleaned up.
 *
 * The client does not know the phase and does not try: every refusal is the server's, logged with the
 * phase that caused it, so a key that "did nothing" says why in one line rather than looking broken.
 *
 * `gameProcessedEvent` is checked before acting, so typing `1`, `2` or `3` into the chat bar does not
 * drive the machine.
 */
@Controller()
export class DebugKeysController implements OnStart {
	public onStart(): void {
		// The server creates these during startup, so they may not be replicated yet. Yielding here is safe
		// — Flamework runs `onStart` asynchronously — and it means the connections below are made once,
		// against remotes that exist, rather than every keypress re-checking for them.
		const remotes = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME);
		const waiting = remotes.WaitForChild(DEBUG_WAITING_REMOTE_NAME);
		const playing = remotes.WaitForChild(DEBUG_PLAYING_REMOTE_NAME);
		const spawn = remotes.WaitForChild(DEBUG_SPAWN_REMOTE_NAME);

		if (!waiting.IsA("RemoteEvent") || !playing.IsA("RemoteEvent") || !spawn.IsA("RemoteEvent")) {
			warn(`[DebugKeys] one of the debug remotes is not a RemoteEvent; debug keys disabled.`);
			return;
		}

		UserInputService.InputBegan.Connect((input, gameProcessedEvent) => {
			if (gameProcessedEvent) {
				return;
			}

			// No arguments on any of them: each remote carries one fixed request, so nothing a client sends
			// can influence which phase the server enters or how many bodies it makes.
			if (input.KeyCode === Enum.KeyCode.One) {
				waiting.FireServer();
			} else if (input.KeyCode === Enum.KeyCode.Two) {
				playing.FireServer();
			} else if (input.KeyCode === Enum.KeyCode.Three) {
				spawn.FireServer();
			}
		});
	}
}
