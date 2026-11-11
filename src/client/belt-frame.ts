/**
 * The belt's forward direction, resolved once on the client and cached.
 *
 * ## Why this is a module and not a method on each controller
 *
 * Two controllers need the same answer (`wind-boost-controller`, `tail-wind-controller`) and two more independently
 * re-implement the same tag walk for their own axes (`ball-render-controller`, `marker-spin-controller`). Adding a third
 * and fourth copy of the cache would be four places to forget the invalidation rule. This module is the one place that
 * walk and that rule live for the effects; the two older copies were left alone because they answer a different question
 * (a spin axis) and touching them would be unrelated work.
 *
 * ## Why a cache at all
 *
 * `syncTrails` asks once per ball **per frame**, and the belt's direction cannot change while the belt is anchored. A
 * `GetTagged` walk per ball per frame at the 50-body cap would be 3000 enumerations a second to answer a question that only
 * changes when the tag does.
 *
 * ## What invalidates it, and what happens before a belt exists
 *
 * The belt's own `Parent` going nil is what a Studio re-tag or a scene reload looks like from here, and it is the same rule
 * `marker-spin-controller` uses. Before any belt has replicated the answer is `undefined` — a real window, since the log
 * shows `[BeltScroll] controller started … found=0` before bind, and effects start before the arena arrives. `undefined`
 * is returned rather than a guessed axis so each caller can keep its previous behaviour for that frame; guessing would
 * point every trail somewhere arbitrary and then snap it when the belt appeared.
 */
import { CollectionService } from "@rbxts/services";
import { TAGS } from "shared/tags";
import { vfxForward } from "shared/vfx-scale";

let cachedBelt: BasePart | undefined;

/** Start-ward, from the first tagged belt this client can see; `undefined` until one replicates. */
export function beltForward(): Vector3 | undefined {
	if (cachedBelt === undefined || cachedBelt.Parent === undefined) {
		cachedBelt = undefined;

		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				cachedBelt = instance;
				break;
			}
		}
	}

	return cachedBelt === undefined ? undefined : vfxForward(cachedBelt.CFrame);
}
