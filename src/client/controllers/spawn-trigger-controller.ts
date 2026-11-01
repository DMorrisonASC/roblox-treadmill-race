import { ReplicatedStorage, UserInputService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { REMOTES_FOLDER_NAME, SPAWN_BALL_REMOTE_NAME } from "shared/remotes";

/**
 * Sends a manual spawn request when the player presses `1`.
 *
 * This is the only client-side code in the slice, and it does exactly one thing: it asks. It does
 * not create a ball, predict one, or optimistically show one, because the server is the only place
 * a ball exists. The visible cost is that the ball appears one round-trip later than the keypress;
 * for a test fixture that is the point rather than a defect, since anything else would be
 * client-side prediction — explicitly out of scope for this slice.
 *
 * `gameProcessedEvent` is checked before acting. Roblox sets it for input the engine already
 * consumed, and the important case is the chat bar: without the check, typing "1" into chat would
 * fire the remote, which is exactly the sort of accidental trigger that makes a fixture look flaky.
 */
@Controller()
export class SpawnTriggerController implements OnStart {
	public onStart(): void {
		// The server creates the remote during startup, so it may not be replicated yet. Yielding here
		// is safe — Flamework runs `onStart` asynchronously — and it means the connection below is made
		// exactly once, against a remote that exists, instead of every keypress re-checking for it.
		const remotes = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME);
		const spawnEvent = remotes.WaitForChild(SPAWN_BALL_REMOTE_NAME);

		if (!spawnEvent.IsA("RemoteEvent")) {
			warn(`[SpawnTrigger] ${spawnEvent.GetFullName()} is not a RemoteEvent; manual spawn disabled.`);
			return;
		}

		UserInputService.InputBegan.Connect((input, gameProcessedEvent) => {
			if (gameProcessedEvent) {
				return;
			}

			if (input.KeyCode !== Enum.KeyCode.One) {
				return;
			}

			// No arguments: the server decides which spawner fires, at what size, and whether this
			// player is allowed to ask at all. Anything sent from here would be untrusted anyway.
			spawnEvent.FireServer();
		});
	}
}
