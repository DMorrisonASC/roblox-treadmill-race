/**
 * **The local player's "watch the race" ask, shared between the two controllers that have to agree about it** (item 209).
 *
 * ## Why a module and not a `Player` attribute
 *
 * The obvious shape is an attribute, mirroring item 193's `Competing`. It does not work here: the ask is made **on the client**
 * by a button press, and a client cannot `SetAttribute` on a `Player` instance - that is a server-owned object, so the write
 * would be rejected. An attribute would therefore need a remote to carry one boolean up and back down again, which is a round
 * trip for a value that never leaves this machine.
 *
 * ## Why not merge the freeze controller into `spectate-controller`
 *
 * That works today and would be the smallest diff, but the two controllers answer different questions: the button owns *"has
 * the player asked"*, and the freeze owns *"may this character walk"*. The second is a function of three facts - phase,
 * competing and spectating - and it will outlive the button: a future spectator mode with no button still needs the answer.
 * Folding them would put a `Humanoid` walk write inside a controller whose docblock is about a HUD control.
 *
 * ## Why a plain listener list and not a `Signal`
 *
 * `@rbxts/lemon-signal` is not a dependency of this project, and adding one for a single boolean would be the wrong trade. The
 * list below is the whole mechanism: one array, one index loop, callbacks removed by identity.
 */

let spectating = false;

const listeners = new Array<() => void>();

/** The current ask. `false` before anyone presses the button and after any phase change that withdraws it. */
export function isSpectating(): boolean {
	return spectating;
}

/**
 * Sets the ask and notifies only on a real change.
 *
 * **Value-equal writes are dropped**, which is what keeps the freeze controller's transitions one per press rather than one per
 * call: `setSpectating` is reached from a toggle *and* from the spectate controller's competitor guard, and the second is not a
 * press.
 */
export function setSpectating(on: boolean): void {
	if (spectating === on) {
		return;
	}

	spectating = on;

	// The length is read once: a listener that unsubscribes during the sweep would otherwise shift the array under the loop and
	// skip the next one.
	const count = listeners.size();
	for (let index = 0; index < count; index++) {
		const listener = listeners[index];
		if (listener !== undefined) {
			listener();
		}
	}
}

/**
 * Subscribes to changes and returns the unsubscribe.
 *
 * A plain function rather than an `RBXScriptConnection`: there is no engine object behind this, and returning a connection would
 * mean constructing one. Returning an idempotent unsubscribe matches the shape `lockControls` already uses.
 */
export function onSpectatingChanged(callback: () => void): () => void {
	listeners.push(callback);

	let spent = false;

	return () => {
		if (spent) {
			return;
		}

		spent = true;

		const index = listeners.indexOf(callback);
		if (index >= 0) {
			listeners.remove(index);
		}
	};
}
