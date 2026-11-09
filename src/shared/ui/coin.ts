import { ContentProvider } from "@rbxts/services";

/**
 * The coin icon: the asset id, the URI built from it, and the one boot-time check that says whether the engine can fetch
 * it (item 154).
 *
 * ## Why this is its own module and not a constant in `tuning.ts`
 *
 * `tuning.ts` is a file of **values** — it exports no functions, and that is a property a reader relies on when scanning it
 * for "what can I retune". The coin needs three things: the id, a `uri` builder, and a preload that logs. `sounds.config.ts`
 * is the precedent for exactly this shape — `SOUND_TUNING` holds ids and `soundUri` builds the one string — and this module
 * is the image equivalent of it, for the three panels that draw a coin rather than for one controller.
 *
 * It lives in `shared/ui` because all three callers are client controllers and none of them owns the coin: the store's
 * pill, the payout panel and the reward toast draw the same picture at the same size, and the moment the id lives in one of
 * them the other two are copies of it.
 */

/**
 * **The user's upload.** Not a `Placeholder.`: `128573978747266` is the asset the designer chose, in the same class as
 * `HIT_SOUND_ASSET_ID` and `PICKUP_SPRITE_ASSET_ID`, and proposing a different value here would be a guess presented as a
 * decision.
 */
export const COIN_ICON_ASSET_ID = "128573978747266";

/**
 * The `ContentId` an `ImageLabel` needs, built in the one place the id is consumed.
 *
 * **The prefix is required, and this is the tree's working convention rather than a preference.** `ImageLabel.Image` is a
 * `ContentId` that the engine resolves from a scheme; the pickup sprite's docblock records the measured consequence of
 * getting it wrong — *"a bare number loads nothing and reports no error"* — which is why `PickupSpriteController` returns
 * `` `rbxassetid://${PICKUP_SPRITE_ASSET_ID}` `` and `BELT_TEXTURE_ASSET` carries its prefix inside the constant.
 *
 * The id stays bare above and is prefixed here for the same reason `soundUri` exists: one id, one place that turns it into
 * a URI, so there is no second string to forget.
 */
export function coinIconUri(): string {
	return `rbxassetid://${COIN_ICON_ASSET_ID}`;
}

/**
 * Whether this session has already reported the coin's load. **The guard that keeps the line to one,** and it is module
 * state rather than per-controller because there are three controllers that draw a coin: without it a session would print
 * three lines about one asset, which reads as three assets.
 */
let reported = false;

/**
 * Asks the engine whether it can fetch the coin, once per session, and says the answer in one line.
 *
 * ## Why a preload at all
 *
 * The failure this catches is silent: an `ImageLabel` whose `Image` the engine cannot resolve draws **nothing**, and
 * "nothing where the coin was" is indistinguishable from a panel that never built the coin. `ContentProvider.PreloadAsync`
 * is the only place the fetch status is observable — the same finding item 144 made for the pickup sprite — so it is
 * asked once and reported once.
 *
 * ## Why the panels render either way
 *
 * A missing coin is a cosmetic failure. The number beside it is the information, and hiding a price row or a payout panel
 * because one picture did not arrive would turn a decoration into a broken shop. Nothing here changes behaviour; the log is
 * the whole of the response, and the report says the panels draw a hole where the coin was.
 *
 * ## Why the call is fire-and-forget
 *
 * `PreloadAsync` yields. A controller that awaited it in `onStart` would delay building its panel by a web request, so this
 * runs on its own thread and the panel is built first. The status callback fires whenever the fetch completes, which for a
 * cached asset is before the first frame and for a cold one is a moment later — either way the line arrives.
 */
export function reportCoinIconLoad(): void {
	if (reported) {
		return;
	}

	reported = true;

	const uri = coinIconUri();

	task.spawn(() => {
		const [ok, failure] = pcall(() => {
			ContentProvider.PreloadAsync([uri], (contentId, status) => {
				if (status === Enum.AssetFetchStatus.Success) {
					print(`[Coin] icon loaded ${COIN_ICON_ASSET_ID}`);
				} else {
					warn(
						`[Coin] icon did not load ${COIN_ICON_ASSET_ID} status=${tostring(status)} — the coin will draw as a gap; check that the id is an image asset this experience can use.`,
					);
				}
			});
		});

		if (!ok) {
			warn(`[Coin] icon preload threw: ${tostring(failure)}`);
		}
	});
}
