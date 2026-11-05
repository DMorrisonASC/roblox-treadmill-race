import { ReplicatedStorage, UserInputService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import {
	DEBUG_INTERMISSION_REMOTE_NAME,
	DEBUG_PLAYING_REMOTE_NAME,
	DEBUG_SPAWN_REMOTE_NAME,
	DEBUG_WAITING_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
} from "shared/remotes";

/**
 * Drives the round from the keyboard for Studio testing, **one key per phase, in phase order**:
 * `1` ? `Intermission`, `2` ? `Waiting`, `3` ? `Playing`, `4` ? spawn four competitors.
 *
 * ## Why the keys moved, and what they used to be
 *
 * They were `1` Waiting, `2` Playing, `3` spawn. That order left `Intermission` reachable only by waiting out its
 * thirty-second timer, so testing anything that lives in the lobby ? the ball picker, most of all ? cost half a minute per
 * attempt. The keys now walk the phase machine in the order it runs, and **`1` was Waiting before this change**; a reader
 * holding an older log will otherwise watch `1` jump to the lobby and conclude the key broke.
 *
 * ## Why one controller for four keys
 *
 * This replaced `AdvancePhaseController`, which owned one key and one phase-advance remote. That split
 * was justified when the keys meant different things ? `1` spawned balls from the *spawner* service and
 * `2` advanced the *round* ? so they belonged to different services and different files. They now all
 * address `RoundService`, and a keypress that lands in the wrong service is exactly the kind of
 * misrouting that produced an untracked ghost ball in the 21:20 log. One controller, one remote folder,
 * one service on the other end.
 *
 * ## What each key does, and what it does not
 *
 * - **`1`** forces `Intermission` from any phase. It goes through the same teardown as the timed transition ? the belt
 *   ramp stops, the simulation stops, every body is cleared, and the intermission timer is re-armed from the forced entry.
 * - **`2`** forces `Waiting`, which spawns **one** owned competitor per player. From `Playing` or `PostGame` it clears
 *   every ball first and restarts the synthetic `Debug#N` numbering ? a jump back is a reset, not a nudge.
 * - **`3`** forces `Playing` from any other phase. It is refused while already `Playing`, because the
 *   alternative ? restart the round ? would destroy every competitor for one stray keypress.
 * - **`4`** spawns one competitor per bound spawner, each with its own owner. Refused outside `Playing`,
 *   because a body added to a phase whose tick is not running would never be counted or cleaned up.
 *
 * The client does not know the phase and does not try: every refusal is the server's, logged with the
 * phase that caused it, so a key that "did nothing" says why in one line rather than looking broken.
 *
 * `gameProcessedEvent` is checked before acting, so typing `1`, `2`, `3` or `4` into the chat bar does not
 * drive the machine.
 */
@Controller()
export class DebugKeysController implements OnStart {
	public onStart(): void {
		// The server creates these during startup, so they may not be replicated yet. Yielding here is safe
		// — Flamework runs `onStart` asynchronously — and it means the connections below are made once,
		// against remotes that exist, rather than every keypress re-checking for them.
		const remotes = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME);
		const intermission = remotes.WaitForChild(DEBUG_INTERMISSION_REMOTE_NAME);
		const waiting = remotes.WaitForChild(DEBUG_WAITING_REMOTE_NAME);
		const playing = remotes.WaitForChild(DEBUG_PLAYING_REMOTE_NAME);
		const spawn = remotes.WaitForChild(DEBUG_SPAWN_REMOTE_NAME);

		if (
			!intermission.IsA("RemoteEvent") ||
			!waiting.IsA("RemoteEvent") ||
			!playing.IsA("RemoteEvent") ||
			!spawn.IsA("RemoteEvent")
		) {
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
				intermission.FireServer();
			} else if (input.KeyCode === Enum.KeyCode.Two) {
				waiting.FireServer();
			} else if (input.KeyCode === Enum.KeyCode.Three) {
				playing.FireServer();
			} else if (input.KeyCode === Enum.KeyCode.Four) {
				spawn.FireServer();
			}
		});
	}
}
