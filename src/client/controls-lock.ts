import { GuiService, Players } from "@rbxts/services";

/**
 * Takes movement away from the player while a panel is open, and gives it back when the last one closes (item 161).
 *
 * ## Why a GUI blocker does not do this
 *
 * The obvious fix — an invisible full-screen `TextButton`, `Active = true`, swallowing every touch — stops clicks reaching the
 * world and **does not stop the character walking**. The dynamic thumbstick is drawn and driven by the `PlayerModule`'s own
 * touch controls, which read touches from `UserInputService` rather than from GUI hit-testing, so a blocker under the finger
 * eats the click and the stick still moves the character. That is precisely the reported symptom — *"I keep moving while in the
 * panels by mistake when I touch the left side"* — and a blocker would have looked like a fix in the code while changing
 * nothing on the device.
 *
 * ## Two mechanisms, and the one that cannot fail
 *
 * **1. `GuiService.TouchControlsEnabled = false` — the primary.** Its own documentation is the argument: *"Used to enable and
 * disable touch controls and touch control display UI."* It is a plain `GuiService` property, so it needs no module lookup, no
 * wait and no `pcall`: it either works or the property write throws. This is the mechanism that guarantees the reported
 * symptom is fixed on the device that reported it.
 *
 * **2. `PlayerModule:GetControls():Disable()` — best effort, and it is second for a reason.** It is the documented way to take
 * movement away across *all* inputs (gamepad and keyboard as well as touch), and it is what Roblox's own modals use — but the
 * first Studio run of this feature proved it is not something to depend on: the module was not resolvable, `WaitForChild`
 * blocked the client for **2.6 seconds** (the shop's own `modal=true` line landed after it), and a permanent "unavailable" flag
 * then gave up for the whole session. It now runs on a background thread, retries on the next panel, and a failure costs
 * nothing because mechanism 1 has already done the job.
 *
 * `UserInputService.ModalEnabled` is *not* used: it is deprecated in these typings in favour of `GuiService.TouchControlsEnabled`,
 * which is the same idea expressed by the service that now owns it.
 *
 * ## The counter, and the flags beside it
 *
 * Two panels can want the lock at once (a phase change closes the shop as the picker opens), so the lock is counted: the
 * property is written on the first hold and restored on the last release. A double release — a destroyed panel, a phase change
 * firing twice — is a no-op, because a count driven negative and then clamped would leave the *next* lock needing one release
 * more than it has and the character frozen for the session.
 *
 * **`touchControlsWere` captures the previous value rather than assuming `true`.** A game that ships with touch controls
 * disabled would otherwise have them switched *on* the first time a panel closed.
 *
 * `disabled` records that *this* module actually called `Disable()`, so `Enable()` is never fired at a controls object that was
 * never disabled, and a deferred disable that landed after its release cannot leave the character stuck.
 */

type PlayerControls = {
	Disable(): void;
	Enable(): void;
};

/** The resolved controls, cached on first success. Best effort — the touch-control lock does not need it. */
let controls: PlayerControls | undefined;
/** `true` while a background thread is trying to resolve the module, so concurrent locks share one attempt. */
let resolving = false;
/** `true` once a failure has been reported, so the warning is one line per session rather than one per panel. */
let reported = false;
/** `true` while *this* module has called `Disable()`. */
let disabled = false;
/** How many holders want movement off. */
let held = 0;
/** `GuiService.TouchControlsEnabled` as it was before the first hold, so the last release restores rather than assumes. */
let touchControlsWere = true;

/**
 * What is actually inside `PlayerScripts`, for the one log line that turns "it did not work" into a diagnosis.
 *
 * The first version's failure said what was missing and nothing about what was there, which is why the cause could not be
 * identified from the log alone. A dozen names and classes is enough to see a module that is nested, renamed or still arriving.
 */
function describeChildren(container: Instance): string {
	const parts = new Array<string>();
	let count = 0;

	for (const child of container.GetChildren()) {
		if (count >= 12) {
			parts.push("...");
			break;
		}

		parts.push(`${child.Name}(${child.ClassName})`);
		count++;
	}

	return parts.size() > 0 ? parts.join(",") : "none";
}

/**
 * Finds the `PlayerModule`'s controls, **blocking**, so it must only be called from a background thread.
 *
 * `FindFirstChild` recursively before `WaitForChild`: the module has been a direct child of `PlayerScripts` for years, but a
 * nested copy is still a copy and a recursive search costs one walk. `WaitForChild` then covers a container that exists before
 * its module does.
 */
function resolveControls(): PlayerControls | undefined {
	if (controls !== undefined) {
		return controls;
	}

	const playerScripts = Players.LocalPlayer.FindFirstChildOfClass("PlayerScripts");
	if (playerScripts === undefined) {
		if (!reported) {
			reported = true;
			warn(`[Controls] no PlayerScripts — only the touch-control lock is in effect.`);
		}
		return undefined;
	}

	let moduleScript = playerScripts.FindFirstChild("PlayerModule", true);
	if (moduleScript === undefined) {
		moduleScript = playerScripts.WaitForChild("PlayerModule", 10);
	}

	if (moduleScript === undefined || !moduleScript.IsA("ModuleScript")) {
		if (!reported) {
			reported = true;
			warn(
				`[Controls] no PlayerModule under ${playerScripts.GetFullName()} after 10s — only the touch-control lock is in effect. It contains: ${describeChildren(playerScripts)}`,
			);
		}
		return undefined;
	}

	const [ok, result] = pcall(() => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- a runtime `ModuleScript` inside the player, not a build-time import; the instance is the only way to reach `GetControls()`.
		const playerModule = require(moduleScript as ModuleScript) as { GetControls(): PlayerControls };
		return playerModule.GetControls();
	});

	if (!ok) {
		if (!reported) {
			reported = true;
			warn(
				`[Controls] PlayerModule.GetControls() failed (${tostring(result)}) — only the touch-control lock is in effect.`,
			);
		}
		return undefined;
	}

	controls = result as PlayerControls;
	return controls;
}

/** Disables the touch controls, and asks the `PlayerModule` to do the same for every other input — on a thread, never inline. */
function takeMovement(): void {
	// **Captured, not assumed.** See `touchControlsWere`.
	touchControlsWere = GuiService.TouchControlsEnabled;
	GuiService.TouchControlsEnabled = false;

	if (controls !== undefined) {
		disabled = true;
		const [ok, failure] = pcall(() => (controls as PlayerControls).Disable());
		if (!ok) {
			warn(
				`[Controls] GetControls():Disable() failed (${tostring(failure)}) — the touch controls are still locked.`,
			);
		}
		return;
	}

	if (resolving) {
		return;
	}

	resolving = true;

	task.spawn(() => {
		const found = resolveControls();
		resolving = false;

		// **The release that arrived while this thread was waiting.** Nothing is open any more, so the disable is not owed — and
		// applying it here would freeze a character with no panel on screen to explain it.
		if (found === undefined || held <= 0) {
			return;
		}

		disabled = true;
		const [ok, failure] = pcall(() => found.Disable());
		if (!ok) {
			warn(
				`[Controls] GetControls():Disable() failed (${tostring(failure)}) — the touch controls are still locked.`,
			);
		}
	});
}

/** Restores the touch controls, and re-enables the module's if this module disabled them. */
function giveMovementBack(): void {
	GuiService.TouchControlsEnabled = touchControlsWere;

	if (!disabled) {
		return;
	}

	disabled = false;

	if (controls === undefined) {
		// A disable is in flight on the background thread; it will see `held === 0` and not apply. Nothing to undo.
		return;
	}

	const [ok, failure] = pcall(() => (controls as PlayerControls).Enable());
	if (!ok) {
		warn(`[Controls] GetControls():Enable() failed (${tostring(failure)}) — movement may stay disabled.`);
	}
}

/**
 * Takes movement away and returns the function that gives it back.
 *
 * **Non-blocking**, and the returned release is the only correct way to give movement back. It is safe to call any number of
 * times: a second call is a no-op, which is what stops a double release from driving the count negative and leaving the
 * character frozen for the session.
 */
export function lockControls(): () => void {
	held++;

	if (held === 1) {
		takeMovement();
	}

	let spent = false;

	return () => {
		if (spent) {
			return;
		}

		spent = true;
		held--;

		if (held > 0) {
			return;
		}

		// Clamped rather than trusted: a caller that released without locking would otherwise leave this negative, and every later
		// lock would then need an extra release to reach zero.
		held = 0;

		giveMovementBack();
	};
}
