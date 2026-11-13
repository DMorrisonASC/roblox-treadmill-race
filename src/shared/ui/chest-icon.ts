import { ContentProvider } from "@rbxts/services";
import { COIN_CHEST_IMAGE_ID, PREMIUM_CHEST_IMAGE_ID } from "shared/economy.config";

/**
 * The two chest pictures: the URI built from a bare id, and the one boot-time check that says whether the engine can fetch
 * them (item 235).
 *
 * ## Why the ids are in `economy.config.ts` and the functions are here
 *
 * The ids are **product data** - they sit beside `ROBUX_CHEST_PRODUCT_ID` because the picture and the product are the same
 * thing seen twice, and a designer replacing one is replacing the other. The functions are **UI**, and they are here for
 * the reason `shared/ui/coin.ts` gives: three surfaces can draw a coin and only this store draws a chest, but the moment the
 * URI builder lives inside `shop-controller` there is no second caller it could ever serve and no place to put the preload.
 *
 * ## Bare ids, prefixed once
 *
 * The config holds `"99666339452242"` and this file turns it into `rbxassetid://99666339452242`, which is item 233's
 * `BALL_ICONS` shape and the reason `coinIconUri` exists. The pickup sprite's docblock records what a bare number in an
 * `ImageLabel.Image` does: *"a bare number loads nothing and reports no error"*.
 */

/** The scheme every image id in this tree is written with. Bare ids live in the config; the prefix lives here. */
const CHEST_URI_PREFIX = "rbxassetid://";

/**
 * The `ContentId` for one chest picture, or `""` when the id is empty.
 *
 * **`""` rather than a fallback asset**: an empty `Image` draws nothing, which is exactly the "no art" case - the store's
 * chest square keeps the word `CHEST` it has drawn since item 58, and a missing drawing is a word rather than a broken
 * image. That is the whole fallback.
 */
export function chestIconUri(assetId: string): string {
	return assetId === "" ? "" : `${CHEST_URI_PREFIX}${assetId}`;
}

/**
 * Asks the engine whether it can fetch both chest pictures, once, and says each answer in one line.
 *
 * ## Why this is asked at all
 *
 * The failure it catches is silent and it is the one the audit of this file cannot settle from source: an `ImageLabel`
 * whose `Image` the engine cannot resolve draws **nothing**, and "nothing where the chest was" is indistinguishable from a
 * square that never got its picture. `ContentProvider.PreloadAsync` is the only place the fetch status is observable - the
 * same finding item 144 made for the pickup sprite and item 154 for the coin - so it is asked once and reported once.
 *
 * ## Why the caller gets a callback instead of just a log line
 *
 * The coin's answer is "draw a gap and carry on". A chest's is not: the square is 108 pixels of the store's first section,
 * and a blank one reads as a broken panel rather than as a decoration that did not arrive. So the fallback the store keeps
 * behind the picture - the word `CHEST` - is **re-shown** when the fetch fails, which is the difference between the two
 * cases and the reason this module hands the verdict back rather than only printing it.
 *
 * ## Why the call is fire-and-forget
 *
 * `PreloadAsync` yields. A controller that awaited it in `onStart` would delay its rail by a web request, so this runs on
 * its own thread and the panel is built first. The callback fires whenever the fetch settles, which for a cached asset is
 * before the first frame and for a cold one is a moment later - either way the panel is already on screen, and it is the
 * *word* that changes when it arrives.
 */
export function reportChestIconsLoad(onUnavailable: () => void): void {
	const uris = new Array<string>();
	const ids = new Array<string>();

	// Empty ids are skipped rather than preloaded: `PreloadAsync` on `""` asks the engine about nothing and answers with a
	// failure, which would re-show a word for the bundle that never had a picture to lose.
	for (const assetId of [COIN_CHEST_IMAGE_ID, PREMIUM_CHEST_IMAGE_ID]) {
		if (assetId !== "") {
			ids.push(assetId);
			uris.push(chestIconUri(assetId));
		}
	}

	if (uris.size() === 0) {
		return;
	}

	task.spawn(() => {
		let failed = 0;

		const [ok, failure] = pcall(() => {
			ContentProvider.PreloadAsync(uris, (_contentId: string, status: Enum.AssetFetchStatus) => {
				// The callback reports per asset, so the id is recovered from the URI rather than read positionally - the
				// engine does not promise to answer in the order asked.
				const id = _contentId.sub(CHEST_URI_PREFIX.size() + 1);

				if (status === Enum.AssetFetchStatus.Success) {
					print(`[Chest] icon loaded ${id}`);
					return;
				}

				failed++;
				warn(
					`[Chest] icon did not load ${id} status=${tostring(status)} - the store keeps the word CHEST in that square; check that the id is an image asset this experience can use.`,
				);
			});
		});

		if (!ok) {
			failed++;
			warn(`[Chest] icon preload threw: ${tostring(failure)}`);
		}

		if (failed > 0) {
			onUnavailable();
		}
	});
}
