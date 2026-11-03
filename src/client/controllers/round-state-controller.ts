import { ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";

/**
 * Reports the server's current phase on the client, once at startup and on every change.
 *
 * ## Why this controller exists at all
 *
 * The phase is a replicated `StringValue`, so any future GUI controller can simply read it — none of
 * them needs a helper. This one exists to make the broadcast *visible* in a log: without a client that
 * prints the value it read, "the server changed phase" and "clients saw the change" are two claims that
 * only a person staring at two windows can tell apart, and a broadcast bug looks exactly like a missing
 * GUI.
 *
 * ## Why it reads once and then subscribes
 *
 * A client can start at any point in the cycle, including between two transitions. Reading the value in
 * `onStart` is what catches the current phase; the `Changed` connection covers everything after. A
 * controller that only subscribed would sit silent until the next transition and give no evidence about
 * the phase the client started in — which is the case a late-joining player actually experiences.
 *
 * The wait is bounded for the reason item 13 established for `BeltScrollController`: an unbounded
 * `WaitForChild` turns "the server never created it" into a silent infinite yield, and a silent yield is
 * indistinguishable from "not replicated yet". A bound converts it into one warning.
 */
const ROUND_STATE_WAIT_SECONDS = 10;

@Controller()
export class RoundStateController implements OnStart {
	public onStart(): void {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);

		if (value === undefined) {
			warn(
				`[RoundState] GAVE UP waiting ${ROUND_STATE_WAIT_SECONDS}s for ${ROUND_STATE_VALUE_NAME} in ReplicatedStorage — the server did not create it.`,
			);
			return;
		}

		if (!value.IsA("StringValue")) {
			warn(`[RoundState] ${value.GetFullName()} is a ${value.ClassName}, not a StringValue.`);
			return;
		}

		print(`[RoundState] initial=${value.Value}`);

		value.Changed.Connect((phase) => {
			print(`[RoundState] ${phase}`);
		});
	}
}
