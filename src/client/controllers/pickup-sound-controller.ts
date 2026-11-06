import { ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PICKUP_SOUND_REMOTE_NAME, REMOTES_FOLDER_NAME } from "shared/remotes";
import { playPickupSound } from "shared/ui/sounds";

/** **Placeholder.** How long to wait for the `Remotes` folder and the pickup-sound remote before giving up loudly. */
const RESOLVE_TIMEOUT_SECONDS = 10;

/**
 * The pickup sound: one broadcast, one clip, played on every client that receives it.
 *
 * ## Why this is a controller of its own
 *
 * The nearest existing home was `HitEffectController`, which already resolves the `Remotes` folder, subscribes to a
 * broadcast and plays a sound on receipt — but it is named for the hit *effect* and it builds geometry. Adding a pickup
 * remote there would mean editing a controller whose docblock is an argument about particle carriers to add a line about
 * pickups, and the next reader looking for "where does the pickup sound live" would not look in a file called
 * `hit-effect-controller`. `EliminationSplashController` is the precedent for a controller that owns an audio remote, and
 * this is the same shape at the smallest size: resolve one remote, subscribe, play.
 *
 * The cost is one line in `flamework.build`, which is generated — and the registry was rebuilt for it rather than
 * hand-edited.
 *
 * ## What this controller does not decide
 *
 * **Not that a pickup happened, and not whether it was worth a sound.** The server fires only when `speedAfterPickup`
 * raised the ball's speed, and fires inside the same `after !== before` guard that writes `BALL_SPEED` — so a no-op
 * re-touch of a `recycle` pad under a resting ball never reaches this file. A client that re-derived the condition would
 * be a second opinion about a number the server already compared, and the two would disagree exactly when the arithmetic
 * changed.
 *
 * **No phase gate.** The phase gate is the server's (`PickupService.onPhaseChanged` stops the spawning loop outside
 * `Playing`, so nothing is on the belt to collect), and asking this client for one would be asking it for a fact the
 * server already applied before it sent anything.
 *
 * **The throttle is in `playPickupSound`, not here.** This controller plays on every event it receives and knows nothing
 * about timing, deliberately: item 91 measured a resting `recycle` ball producing nineteen events in one rest, and the
 * collapse belongs beside the other two per-sound intervals in `shared/sounds.config.ts` rather than as a second rule in a
 * controller that owns one remote.
 *
 * ## Why the handler takes no argument
 *
 * The remote carries nothing: the sound is non-positional and identical for every collection, so there is nothing to
 * unpack. The hit effect's remote carries a `Vector3` because that one *draws*; this one only plays.
 */
@Controller()
export class PickupSoundController implements OnStart {
	public onStart(): void {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, RESOLVE_TIMEOUT_SECONDS);
		if (folder === undefined || !folder.IsA("Folder")) {
			warn(`[PickupSound] no ${REMOTES_FOLDER_NAME} folder — pickups will be silent.`);
			return;
		}

		const remote = folder.WaitForChild(PICKUP_SOUND_REMOTE_NAME, RESOLVE_TIMEOUT_SECONDS);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[PickupSound] no ${PICKUP_SOUND_REMOTE_NAME} remote — pickups will be silent.`);
			return;
		}

		// One connection for the session, made once at boot. The remote is created by the server before any round can
		// start, so a missing one is a wiring fault rather than a race, and the warning above is how it is told apart from
		// a pickup that simply did not boost.
		remote.OnClientEvent.Connect(() => playPickupSound());

		print(`[PickupSound] listening on ${PICKUP_SOUND_REMOTE_NAME}`);
	}
}
