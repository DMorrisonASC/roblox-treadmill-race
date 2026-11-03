import { ReplicatedStorage, UserInputService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { REMOTES_FOLDER_NAME, START_ROUND_REMOTE_NAME } from "shared/remotes";

/**
 * Sends a start-round request when the player presses `2`.
 *
 * Deliberately the same shape as `SpawnTriggerController` — same `WaitForChild` on the shared remotes
 * folder, same `gameProcessedEvent` guard, same "ask, never decide" contract — because the two keys are
 * the same kind of thing: a local keypress that the server is free to ignore. Two controllers with one
 * behaviour each, rather than one controller branching on a keycode, so either can be deleted without
 * touching the other.
 *
 * The client does not know what phase the round is in and must not: a client that knew would be tempted
 * to grey out the key or show a countdown, and neither is in scope. The server answers by logging the
 * phase and by ignoring the press if it is not allowed.
 *
 * `gameProcessedEvent` is checked before acting, so typing "2" into the chat bar does not start a round
 * — the same reason the spawn key checks it.
 */
@Controller()
export class StartRoundController implements OnStart {
	public onStart(): void {
		// The server creates the remote during startup, so it may not be replicated yet. Yielding here is
		// safe — Flamework runs `onStart` asynchronously — and it means the connection below is made once,
		// against a remote that exists, rather than every keypress re-checking for it.
		const remotes = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME);
		const startEvent = remotes.WaitForChild(START_ROUND_REMOTE_NAME);

		if (!startEvent.IsA("RemoteEvent")) {
			warn(`[StartRound] ${startEvent.GetFullName()} is not a RemoteEvent; key 2 disabled.`);
			return;
		}

		UserInputService.InputBegan.Connect((input, gameProcessedEvent) => {
			if (gameProcessedEvent) {
				return;
			}

			if (input.KeyCode !== Enum.KeyCode.Two) {
				return;
			}

			// No arguments: whether a round may start is the server's decision, and anything sent from a
			// client is untrusted anyway.
			startEvent.FireServer();
		});
	}
}
