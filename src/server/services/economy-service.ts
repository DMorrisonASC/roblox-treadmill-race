/**
 * The economy's three verbs — open a chest, fuse two balls, grant coins — and the rules that make each of them
 * safe to be wrong about.
 *
 * ## The one ordering that matters
 *
 * Every action here mutates the in-memory profile, **saves, and only then** reports success. A failed save
 * reverts the mutation and refuses. The alternative — grant now, persist later — is worse in the exact way that
 * is hardest to notice: the player sees a ball they do not own, and the discrepancy only appears on rejoin, long
 * after the log line that would have explained it. Spending nothing on failure is a player who can press again;
 * spending something on failure is a support ticket.
 *
 * ## Why read-only instead of a retry loop on the player's behalf
 *
 * When the DataStore cannot give this server a profile — every attempt failed, the schema is foreign, or another
 * session holds the lock — the session is **read-only**: the verbs refuse, log once, and stop. There is no
 * retrying into the player's session and no queuing of actions to replay later. A queue would mean an action
 * whose cost was checked against a balance that has since changed, and a retry loop would mean the player waits
 * on a spinner for a store that is refusing everyone. A refusal is a state the UI can display and the player can
 * understand.
 *
 * ## No `MarketplaceService`, and why that is a decision rather than an omission
 *
 * Coins are earned, and this round does not spend them on anything but the chest; there is no receipt to process
 * because nothing is for sale for Robux. A purchase path added before the persistence path is proven would be a
 * money-losing bug with no way to reproduce it — the DataStore either round-trips or it does not, and that
 * question is answered for free by the chest before a single Robux is at stake.
 */

import { MarketplaceService, Players, ReplicatedStorage, TextChatService } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { checkCoinAmount, findPlayerByName, isAdmin, parseDevCommand } from "../admin";
import {
	PLAYER_COINS_ATTRIBUTE,
	PLAYER_ECONOMY_STATE_ATTRIBUTE,
	PLAYER_OWNED_BALLS_ATTRIBUTE,
} from "shared/attributes";
import {
	BALL_POOL,
	canAffordChests,
	checkBulkOpenCount,
	chestBatchCost,
	COIN_CHEST_COST,
	DAILY_LOGIN_COOLDOWN_SECONDS,
	DAILY_LOGIN_REWARD_COINS,
	ECONOMY_ACTION_COOLDOWN_MS,
	encodeOwnedBalls,
	FUSION_INPUT_COUNT,
	FUSION_TABLE,
	PLAYTIME_REWARD_COINS,
	PLAYTIME_REWARD_INTERVAL_SECONDS,
	PLAYTIME_TICK_SECONDS,
	PURCHASE_HISTORY_CAP,
	RARITIES,
	RARITY_WEIGHTS,
	Rarity,
	rarityOfBall,
	ROBUX_CHEST_BUNDLE_COUNT,
	ROBUX_CHEST_BUNDLE_GUARANTEE,
	ROBUX_CHEST_BUNDLE_PRODUCT_ID,
	ROBUX_CHEST_PRODUCT_ID,
	robuxChestWeights,
	STARTING_COINS,
} from "shared/economy.config";
import {
	FUSE_BALLS_REMOTE_NAME,
	OPEN_COIN_CHEST_REMOTE_NAME,
	PURCHASE_GRANTED_REMOTE_NAME,
	REMOTES_FOLDER_NAME,
	REWARD_TOAST_REMOTE_NAME,
} from "shared/remotes";
import {
	DAILY_LOGIN_LABEL,
	PLAYTIME_LABEL,
	playtimeBaselineAtLoad,
	RewardToastMessage,
	rewardDue,
} from "shared/rewards";
import { isStudioSession, PlayerDataStore, Profile } from "./player-data-store";

/** What a chest press produced. */
export type ChestResult = { ok: true; balls: Array<string>; coins: number } | { ok: false; reason: string };

/** What a fusion press produced. */
export type FusionResult =
	{ ok: true; outcome: "success" | "fail"; resultBallId?: string } | { ok: false; reason: string };

/**
 * What an admin verb produced.
 *
 * A union of tokens rather than a boolean because the three failures have three different remedies: `no-profile` means
 * the store refused this session and rejoining is the only fix, `save-failed` means try again in a moment, and
 * `bad-amount` means the argument was wrong and nothing was attempted. A single `false` would collapse them into one
 * message that is wrong two times out of three.
 */
export type AdminOutcome = "ok" | "no-profile" | "save-failed" | "bad-amount";

/**
 * What spending coins produced.
 *
 * `insufficient-coins` is separate from `bad-amount` because one is a player who cannot afford something and the other
 * is a caller with a broken price — they are the same refusal to the caller but different defects in the log.
 */
export type SpendOutcome = "ok" | "insufficient-coins" | "no-profile" | "save-failed" | "bad-amount";

/**
 * The folder the engine keeps chat commands in.
 *
 * A name, not a path: `TextChatService` has no typed `TextChatCommands` property in the installed typings, so the folder
 * is found by name and created if absent — the engine only makes it when it has default commands to put there.
 */
const ADMIN_COMMANDS_FOLDER_NAME = "TextChatCommands";

/** The command instance's name, which is what shows up in the Explorer and in error reports. */
const ADMIN_COMMAND_NAME = "DevCommand";

/**
 * The alias, **one word on purpose**.
 *
 * `PrimaryAlias` is typed `string`, so `"/dev setCoins"` would compile. Whether the matcher treats the space as part of
 * the alias or as the end of it is engine behaviour with no typing to check, and a wrong guess fails silently — the
 * command never fires and nothing reports it. One word plus a subcommand in the text cannot fail that way.
 */
const ADMIN_COMMAND_ALIAS = "/dev";

@Service()
export class EconomyService implements OnStart {
	private readonly store = new PlayerDataStore();

	/**
	 * Last accepted time per player, per remote.
	 *
	 * **Two maps, not one**, because the two verbs are independent: a player fusing should not have their chest
	 * press swallowed because it arrived 200 ms later, and the moment they share a budget the UI that fires both
	 * would appear to randomly ignore one.
	 */
	private readonly chestCooldowns = new Map<Player, number>();
	private readonly fusionCooldowns = new Map<Player, number>();

	/** Tells one buyer a grant succeeded. See `PURCHASE_GRANTED_REMOTE_NAME` for why the Robux path needs it. */
	private purchaseGrantedRemote?: RemoteEvent;

	/**
	 * Tells one player a time-based reward was paid, so a toast can say so.
	 *
	 * Optional like every other remote: a grant that happened without a toast is a reward the player sees in their balance
	 * and not in a pop-up, which is a cosmetic loss. The reverse - refusing the grant because the remote is missing - would
	 * be an economy error caused by a UI failure.
	 */
	private rewardToastRemote?: RemoteEvent;

	public onStart(): void {
		this.store.start();

		// The single `ProcessReceipt` assignment in the tree. See `handleReceipt` for why there must be exactly one.
		MarketplaceService.ProcessReceipt = (receiptInfo) => this.handleReceipt(receiptInfo);

		this.createRemotes();
		this.createAdminCommand();
		this.startPlaytimeRewards();

		Players.PlayerAdded.Connect((player) => this.spawnLoad(player));
		Players.PlayerRemoving.Connect((player) => this.unload(player));

		// Players who arrived before this service started (the local player in Studio's Play, for one) never
		// fire `PlayerAdded` again.
		for (const player of Players.GetPlayers()) {
			this.spawnLoad(player);
		}
	}

	/**
	 * Opens one coin chest.
	 *
	 * The roll order is cost first, then rarity, then ball: refusing before rolling is what stops a player who
	 * cannot afford a chest from consuming a roll and, worse, from learning the outcome of a roll they did not
	 * pay for.
	 */
	public openCoinChest(player: Player): ChestResult {
		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} read-only — no profile`);
			return { ok: false, reason: "no-profile" };
		}

		if (profile.coins < COIN_CHEST_COST) {
			warn(`[Economy] ${player.Name} cannot afford a chest: coins=${profile.coins} cost=${COIN_CHEST_COST}`);
			return { ok: false, reason: "insufficient-coins" };
		}

		const rarity = rollFromWeights(RARITY_WEIGHTS);
		const pool = BALL_POOL[rarity];
		if (pool.size() === 0) {
			// A misconfigured pool is a build bug, not a player's problem — refuse and spend nothing rather than
			// grant a ball with no id.
			warn(`[Economy] ${player.Name} rolled ${rarity} but its pool is empty — refused, nothing spent.`);
			return { ok: false, reason: "empty-pool" };
		}

		const ballId = pool[math.floor(math.random() * pool.size())];
		const coinsBefore = profile.coins;
		const ownedBefore = profile.ownedBalls.get(ballId) ?? 0;

		profile.coins = coinsBefore - COIN_CHEST_COST;
		profile.ownedBalls.set(ballId, ownedBefore + 1);

		// **Captured here, not read after the save.** `saveAsync` yields, so `profile.coins` at the far side of it is a
		// shared field that a second in-flight chest may already have changed. Reading it there produced log lines whose
		// balance appeared not to move — `chest ok ball=<id> coins=74100` twice in a row in the 14:47 run — which
		// reads as a free chest and is really a delayed print of somebody else's debit.
		const coinsAfter = profile.coins;

		if (!this.store.saveAsync(player, profile)) {
			profile.coins = coinsBefore;
			restoreOwned(profile, ballId, ownedBefore);
			warn(`[Economy] ${player.Name} chest save failed — no grant`);
			return { ok: false, reason: "save-failed" };
		}

		this.publish(player, profile);
		print(`[Economy] ${player.Name} chest ok ball=${ballId} coins=${coinsBefore}->${coinsAfter}`);

		return { ok: true, balls: [ballId], coins: coinsAfter };
	}

	/**
	 * Opens `count` chests as **one** purchase: one roll loop, one save, one reply.
	 *
	 * ## Why this exists instead of `count` calls to `openCoinChest`
	 *
	 * The ten-press loop lived in the client, and it failed in three ways that a single call cannot:
	 *
	 * 1. **The rate limiter ate presses.** Ten presses 500 ms apart meant the fourth landed 200 ms after the third and
	 *    was answered `chest ignored — within 500ms cooldown`. The client counted presses it *fired*, not presses the
	 *    server *accepted*, so a refused press was silently spent and ten presses bought nine chests.
	 * 2. **The debits raced.** Every call mutates one shared `Profile` and then yields inside `saveAsync`, so a failing
	 *    call restored a `coinsBefore` captured before a later call had decremented — a revert that clobbers a debit it
	 *    never saw. One call has no concurrent sibling to clobber.
	 * 3. **Ten writes, not one.** The 14:47 run drew `DataStore request was added to queue` — eight writes a second is
	 *    above budget for one player pressing a button.
	 *
	 * ## The ordering, and why the affordability check is before the first roll
	 *
	 * Cost, then rolls, then one save, then one publish — the same shape as `openCoinChest`, widened. Checking the
	 * balance up front means a call that cannot be paid for rolls **nothing**, so a refusal cannot leak the outcome of a
	 * roll the player did not buy. That is also what makes the whole batch atomic at the boundary: after the check there
	 * is no branch that grants a partial batch, because every failure path restores the snapshot instead.
	 *
	 * ## Why the single verb is not this verb with `count = 1`
	 *
	 * It is a near-identical shape, and the duplication is deliberate and bounded: a one-chest purchase should not take
	 * a snapshot of `ownedBalls` it cannot need, and `openCoinChest` is the path whose failure modes have actually been
	 * observed. The single would become `openChestsBulk(player, 1)` the day a second verb needs the batch's roll-order
	 * reporting or its per-call log line — not before, because the change would then be justified by a second caller
	 * rather than by tidiness.
	 */
	public openChestsBulk(player: Player, count: unknown): ChestResult {
		const check = checkBulkOpenCount(count);
		if (!check.ok) {
			warn(`[Economy] ${player.Name} bulk open refused: ${check.reason}`);
			return { ok: false, reason: check.reason };
		}

		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} read-only — no profile (bulk open count=${check.count})`);
			return { ok: false, reason: "no-profile" };
		}

		if (!canAffordChests(profile.coins, check.count)) {
			warn(
				`[Economy] ${player.Name} cannot afford ${check.count} chests: coins=${profile.coins} cost=${chestBatchCost(check.count)}`,
			);
			return { ok: false, reason: "insufficient-coins" };
		}

		const coinsBefore = profile.coins;
		const result = applyChestBatch(
			profile,
			check.count,
			(candidate) => this.store.saveAsync(player, candidate),
			() => rollFromWeights(RARITY_WEIGHTS),
			(rarity) => pickBallFrom(rarity),
		);

		if (result.outcome !== "ok") {
			warn(
				`[Economy] ${player.Name} bulk open count=${check.count} refused: ${result.outcome} — nothing granted`,
			);
			return { ok: false, reason: result.outcome };
		}

		this.publish(player, profile);
		print(
			`[Economy] ${player.Name} bulk open count=${check.count} coins=${coinsBefore}->${result.coins} balls=${result.balls.join(",")}`,
		);

		return { ok: true, balls: result.balls, coins: result.coins };
	}

	/**
	 * Attempts to fuse two of one ball into one of the tier above.
	 *
	 * The materials are the cost, so there is nothing to charge and no balance to check — which makes the
	 * *consumption* the thing that has to be atomic. Both inputs come off before the roll is applied to the
	 * result, so a failure still spends them: that is the wager the player was shown odds for.
	 */
	public fuseBalls(player: Player, ballId: string): FusionResult {
		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} read-only — no profile`);
			return { ok: false, reason: "no-profile" };
		}

		const owned = profile.ownedBalls.get(ballId) ?? 0;
		if (owned < FUSION_INPUT_COUNT) {
			warn(`[Economy] ${player.Name} fusion refused: ${ballId} x${owned} needs ${FUSION_INPUT_COUNT}`);
			return { ok: false, reason: "not-enough" };
		}

		const rarity = rarityOfBall(ballId);
		if (rarity === undefined) {
			warn(`[Economy] ${player.Name} fusion refused: ${ballId} is not in any pool`);
			return { ok: false, reason: "unknown-ball" };
		}

		const rule = FUSION_TABLE[rarity];
		if (rule === undefined) {
			// Legendary is the top tier; there is nothing above it to fuse into. Refused, not consumed — see the
			// table's comment for why a legendary-for-legendary trade is not offered instead.
			warn(`[Economy] ${player.Name} fusion refused: ${rarity} has no tier above it`);
			return { ok: false, reason: "top-tier" };
		}

		const succeeded = math.random() * 100 < rule.successPercent;
		const resultPool = BALL_POOL[rule.nextRarity];
		if (succeeded && resultPool.size() === 0) {
			warn(`[Economy] ${player.Name} fusion rolled ${rule.nextRarity} but its pool is empty — refused.`);
			return { ok: false, reason: "empty-pool" };
		}

		const resultBallId = succeeded ? resultPool[math.floor(math.random() * resultPool.size())] : undefined;
		const resultBefore = resultBallId !== undefined ? (profile.ownedBalls.get(resultBallId) ?? 0) : 0;
		const inputsBefore = owned;

		profile.ownedBalls.set(ballId, inputsBefore - FUSION_INPUT_COUNT);
		if (resultBallId !== undefined) {
			profile.ownedBalls.set(resultBallId, resultBefore + 1);
		}

		if (!this.store.saveAsync(player, profile)) {
			profile.ownedBalls.set(ballId, inputsBefore);
			if (resultBallId !== undefined) {
				restoreOwned(profile, resultBallId, resultBefore);
			}

			warn(`[Economy] ${player.Name} fusion save failed — nothing consumed`);
			return { ok: false, reason: "save-failed" };
		}

		this.publish(player, profile);
		print(
			`[Economy] ${player.Name} fusion ok outcome=${succeeded ? "success" : "fail"} result=${resultBallId ?? "none"}`,
		);

		return succeeded && resultBallId !== undefined
			? { ok: true, outcome: "success", resultBallId }
			: { ok: true, outcome: "fail" };
	}

	/**
	 * Grants one rare-or-better ball for a validated Robux purchase, once per `purchaseId`.
	 *
	 * Public and deliberately callable from the command bar, for the same reason `grantCoins` is: it is the only way to
	 * exercise the grant path in Studio, because Studio cannot drive `ProcessReceipt`.
	 */
	public grantRobuxChestPurchase(player: Player, purchaseId: string): GrantOutcome {
		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} read-only ? no profile (robux chest purchase ${purchaseId})`);
			return "no-profile";
		}

		const outcome = applyRobuxChestGrant(
			profile,
			purchaseId,
			(candidate) => this.store.saveAsync(player, candidate),
			() => rollFromWeights(robuxChestWeights()),
			(rarity) => pickBallFrom(rarity),
		);

		if (outcome === "granted") {
			this.publish(player, profile);
			// The Robux path has no reply of its own — the receipt is server-to-server — so this is the buyer's only
			// confirmation. `duplicate` deliberately does not reach it: the grant happened in an earlier session.
			this.notifyGranted(player);
		}

		print(`[Economy] ${player.Name} robux chest ${outcome} purchase=${purchaseId}`);
		return outcome;
	}

	/**
	 * Grants the bundle: ten balls for one purchase id.
	 *
	 * Public for the same reason the single is ? a `save-failed` receipt has to be recoverable from the command bar
	 * against the `PurchaseId` the log printed.
	 */
	public grantRobuxBundlePurchase(player: Player, purchaseId: string): GrantOutcome {
		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} read-only ? no profile (robux bundle purchase ${purchaseId})`);
			return "no-profile";
		}

		const result = applyRobuxChestBundleGrant(
			profile,
			purchaseId,
			ROBUX_CHEST_BUNDLE_COUNT,
			(candidate) => this.store.saveAsync(player, candidate),
			() => rollFromWeights(robuxChestWeights()),
			(rarity) => pickBallFrom(rarity),
			// The product's term. See `ROBUX_CHEST_BUNDLE_GUARANTEE`: the bundle cannot fail to deliver one of these, which is
			// what makes it worth more than ten singles rather than merely cheaper.
			ROBUX_CHEST_BUNDLE_GUARANTEE,
		);

		if (result.outcome === "granted") {
			this.publish(player, profile);
			this.notifyGranted(player);

			// **The floor is logged, always, when it fired.** A guaranteed legendary that the player cannot tell apart from a
			// lucky roll is a promise with no evidence; this line is the only record that the purchase kept its word, and it is
			// the line a support question about "my bundle had no legendary" would be answered from.
			if (result.floored) {
				print(
					`[Economy] bundle floor: guaranteed ${ROBUX_CHEST_BUNDLE_GUARANTEE} added purchase=${purchaseId}`,
				);
			}

			print(
				`[Economy] ${player.Name} robux bundle granted purchase=${purchaseId} count=${result.granted.size()} balls=${result.granted.join(",")}`,
			);
		} else {
			print(`[Economy] ${player.Name} robux bundle ${result.outcome} purchase=${purchaseId}`);
		}

		return result.outcome;
	}

	/**
	 * The `ProcessReceipt` callback: the only place a Robux purchase turns into balls.
	 *
	 * ## Read this before changing anything here
	 *
	 * **Robux is deducted before this callback runs.** By the time any line below decides anything, the money has already
	 * left the player's account. Granting is not a step that happens after payment ? it is the only thing left to do with
	 * a payment that has already happened. There is therefore no branch here that can "decline" a purchase, and none that
	 * should try: the only question is whether the product was delivered.
	 *
	 * **`NotProcessedYet` is a retry request, not a refund.** It does not return the Robux, it does not put the product
	 * back on sale, and it does not notify the player. It asks Roblox to deliver this same receipt again later, and that
	 * is all it does. Anybody reading it as "cancel the purchase" will write a path that charges the player and delivers
	 * nothing while believing it refunded them.
	 *
	 * **The retry is not guaranteed.** Roblox delivers the receipt again when the player rejoins this experience or
	 * purchases something else in this server. A player who buys, sees nothing, and never comes back is never retried ?
	 * so a save that fails on every attempt ends with the player charged and unserved, and no code here can prevent that.
	 * This is why the save path is worth so much care and why the failure is logged so heavily.
	 *
	 * **The log line is the only recovery path.** A `save-failed` for a real purchase prints the `PlayerId`, the
	 * `PurchaseId`, the `ProductId` and the reason, because the remedy is a human reading that line and calling
	 * `grantRobuxBundlePurchase(player, purchaseId)` or `grantRobuxChestPurchase(player, purchaseId)` from the server
	 * command bar once the store is healthy again ? against the exact id printed. The game cannot issue a refund, so a
	 * server that loses this line loses the only record that the player is owed something.
	 *
	 * **This server cannot gate on region.** `ArePaidRandomItemsRestricted` is read through `PolicyService` for a
	 * *player*, and `ProcessReceipt` arrives without a region to consult ? the buyer may not even be in this server by the
	 * time it is handled. The client-side gate before `PromptProductPurchase` is therefore the only gate there is. Its
	 * absence here is deliberate rather than an oversight, and it is the reason the client must never fail open.
	 *
	 * ## Why this is a property assignment and not a connection
	 *
	 * `MarketplaceService.ProcessReceipt` is a plain callback, not an event: assigning replaces whatever was there, and
	 * **only one function can hold it**. That is why there is exactly one assignment in `src/` ? a second would silently
	 * take over from this one and leave the other product unhandled.
	 *
	 * ## Why nothing here throws
	 *
	 * The callback must always answer with a decision. An error surfaces as a failure and Roblox retries; returning
	 * nothing is not in the type and is treated the same way. Every path returns a decision.
	 *
	 * ## Why receipts are not rate-limited
	 *
	 * `ECONOMY_ACTION_COOLDOWN_MS` exists to stop a player spamming a remote. A receipt is money that already changed
	 * hands; delaying or dropping it would be dropping a sale.
	 *
	 * ## Why one bundle receipt is one duplicate, not ten
	 *
	 * A bundle is a single Developer Product, so Roblox issues a single `PurchaseId` for it (`ReceiptInfo` carries one id
	 * per receipt, not per item). The ten balls are this server's dissection of one purchase, which is why the id is
	 * recorded once in `applyRobuxChestBundleGrant` and why a redelivery matches that one id and stops.
	 */
	private handleReceipt(receiptInfo: ReceiptInfo): Enum.ProductPurchaseDecision {
		if (receiptInfo.ProductId === ROBUX_CHEST_PRODUCT_ID) {
			const player = this.findBuyer(receiptInfo, "single");
			if (player === undefined) {
				return Enum.ProductPurchaseDecision.NotProcessedYet;
			}

			const outcome = this.grantRobuxChestPurchase(player, receiptInfo.PurchaseId);
			if (outcome === "save-failed" || outcome === "no-profile") {
				this.logUnservedReceipt(receiptInfo, outcome);
			}

			return receiptDecision(outcome);
		}

		if (receiptInfo.ProductId === ROBUX_CHEST_BUNDLE_PRODUCT_ID) {
			const player = this.findBuyer(receiptInfo, "bundle");
			if (player === undefined) {
				return Enum.ProductPurchaseDecision.NotProcessedYet;
			}

			const outcome = this.grantRobuxBundlePurchase(player, receiptInfo.PurchaseId);
			if (outcome === "save-failed" || outcome === "no-profile") {
				this.logUnservedReceipt(receiptInfo, outcome);
			}

			return receiptDecision(outcome);
		}

		// **Deliberately `NotProcessedYet`.** Consuming a purchase this server does not understand would take the
		// player's money and give nothing, with no retry to recover. The cost is that a misconfigured product id
		// retries forever ? which is loud in the log and fixable, unlike a silently swallowed sale.
		warn(
			`[Economy] receipt for unknown product=${receiptInfo.ProductId} purchase=${receiptInfo.PurchaseId} user=${receiptInfo.PlayerId} ? not processed`,
		);
		return Enum.ProductPurchaseDecision.NotProcessedYet;
	}

	/** The buyer, or `undefined` after logging why. The buyer is frequently absent: receipts outlive sessions. */
	private findBuyer(receiptInfo: ReceiptInfo, kind: string): Player | undefined {
		const player = Players.GetPlayerByUserId(receiptInfo.PlayerId);
		if (player === undefined) {
			warn(
				`[Economy] ${kind} receipt not processed yet: player=${receiptInfo.PlayerId} purchase=${receiptInfo.PurchaseId} product=${receiptInfo.ProductId} reason=buyer-not-in-server`,
			);
		}

		return player;
	}

	/**
	 * The line that makes a failed receipt recoverable.
	 *
	 * Every field needed to act later is here on purpose: `PlayerId` identifies who is owed the product, `PurchaseId` is
	 * the id to pass to the command-bar grant, `ProductId` says which grant to call, and the outcome says whether the
	 * profile was missing or the write failed. Nothing else in the game records that this player paid and received
	 * nothing, so this line is the whole recovery trail.
	 */
	private logUnservedReceipt(receiptInfo: ReceiptInfo, outcome: GrantOutcome): void {
		warn(
			`[Economy] UNSERVED receipt: player=${receiptInfo.PlayerId} purchase=${receiptInfo.PurchaseId} product=${receiptInfo.ProductId} outcome=${outcome} ? grant manually from the command bar once the store is healthy`,
		);
	}

	/**
	 * Adds coins. The only caller is `RoundService.payOut`, which prices a finished round (base plus placement bonus).
	 *
	 * Written before that existed because the profile is the only thing that can hold coins and this is the only correct
	 * way to change the balance outside a chest: it goes through the same save-before-report path, so a round's prize
	 * cannot be granted twice or lost.
	 */
	public grantCoins(player: Player, amount: number): boolean {
		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} read-only — no profile`);
			return false;
		}

		const coinsBefore = profile.coins;
		profile.coins = coinsBefore + amount;

		if (!this.store.saveAsync(player, profile)) {
			profile.coins = coinsBefore;
			warn(`[Economy] ${player.Name} grant of ${amount} failed — nothing added`);
			return false;
		}

		this.publish(player, profile);
		print(`[Economy] ${player.Name} grant ok amount=${amount} coins=${profile.coins}`);

		return true;
	}

	/**
	 * Sets a player's balance to exactly `amount`.
	 *
	 * ## Absolute, not a delta
	 *
	 * This sets `profile.coins = amount`; it does **not** add. `grantCoins` above is the delta, and the two exist side by
	 * side because they answer different questions: "this player should have 500" and "this player earned 50". Confusing
	 * them is the classic admin mistake — typing `setCoins prospeed1 500` against a delta would leave the target with
	 * their old balance plus 500, which looks correct in a log and is wrong by exactly the amount they already had.
	 *
	 * ## Why the validation is here as well as in the caller
	 *
	 * The method is `public` precisely so it can be called from the command bar when the chat command is unavailable, and
	 * that call site has no parser in front of it. Re-checking the amount in the only place that writes means a bad value
	 * cannot reach `profile.coins` by any route — the same argument `openCoinChest` makes about being the only roller.
	 *
	 * ## The ordering
	 *
	 * Mutate, save, and only then publish — identical to every other verb in this file. The revert is a plain assignment
	 * because coins are a scalar: there is nothing to snapshot, and no other field is touched.
	 *
	 * ## What it deliberately does not log
	 *
	 * Success prints nothing. The audit line naming the admin, the target and the value is written by the command layer,
	 * which is the only place that knows who the admin is; printing here as well would make every action two lines, and
	 * the second one would not say who did it.
	 */
	public setCoins(player: Player, amount: number): AdminOutcome {
		const check = checkCoinAmount(amount);
		if (!check.ok) {
			warn(`[Economy] ${player.Name} setCoins refused: ${check.reason}`);
			return "bad-amount";
		}

		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} setCoins refused: read-only, no profile`);
			return "no-profile";
		}

		const outcome = applyCoinSet(profile, check.amount, (candidate) => this.store.saveAsync(player, candidate));
		if (outcome === "ok") {
			this.publish(player, profile);
			return outcome;
		}

		warn(`[Economy] ${player.Name} setCoins=${check.amount} failed: ${outcome} — balance restored`);
		return outcome;
	}

	/**
	 * Resets a player's profile to a brand-new player's: `STARTING_COINS`, no balls, no purchase history.
	 *
	 * ## It writes a profile; it does not delete a key
	 *
	 * Deleting the key is undone by the next write, and this server makes one on `PlayerRemoving` — so the delete that
	 * "worked" is silently reversed seconds later, by the session that had the profile in memory all along. Item 64 hit
	 * exactly that and reached for a key-prefix bump instead. A reset is a **write**: it goes through `saveAsync`, so the
	 * session lock, the retry schedule and the save-before-report ordering all apply as they do everywhere else, and
	 * there is no second writer to lose a race to.
	 *
	 * ## Why the session lock is left alone
	 *
	 * The lock records which session owns this profile, not what the profile contains. Releasing it after a reset would
	 * let a second server load the same player *during* this session — two servers, two copies, last save wins — which is
	 * the exact failure the lock exists to prevent. The reset changes the data; it does not change who is holding it.
	 *
	 * ## Why nothing is reported before the save
	 *
	 * On failure the profile is restored from snapshots taken before the mutation, so a failed wipe leaves the player's
	 * balls and purchases exactly as they were. The alternative — clear in memory, then save — leaves a half-reset
	 * profile that the *next* unrelated save persists, which is a wipe nobody asked for and nobody can undo.
	 */
	public wipeData(player: Player): AdminOutcome {
		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} wipeData refused: read-only, no profile`);
			return "no-profile";
		}

		const outcome = applyProfileReset(profile, (candidate) => this.store.saveAsync(player, candidate));
		if (outcome === "ok") {
			// Republished so the client sees 500 coins and an empty inventory without rejoining: the reset is a write to
			// the same attributes the HUD and the store read, and a stale attribute would show the pre-wipe profile until
			// the next unrelated change.
			this.publish(player, profile);
			return outcome;
		}

		warn(`[Economy] ${player.Name} wipeData failed: ${outcome} — profile untouched`);
		return outcome;
	}

	/**
	 * Charges a player `amount` coins for something already decided, and reports whether the charge landed.
	 *
	 * ## Why this is a verb and not a call to `setCoins`
	 *
	 * `setCoins` is absolute and admin-flavoured: it validates against `ADMIN_COIN_CAP` and its whole purpose is "make
	 * the balance this". A price is a **delta with an affordability precondition**, which is the same shape as
	 * `openCoinChest`'s cost check and the opposite of an absolute set. Expressing a purchase as
	 * `setCoins(player, coins - price)` would read the balance in the caller, which is a read-modify-write across a
	 * remote — the pattern that lost a debit in the 14:47 log.
	 *
	 * ## Why the cost is checked here rather than by the caller
	 *
	 * The caller has a price it thinks is affordable, but the profile is the only authority on the balance and it may
	 * have changed since the caller last looked. Checking inside the same function that debits makes
	 * "refused means nothing was written" true without the caller having to reason about a second read.
	 *
	 * ## The ordering
	 *
	 * Cheap refusals first (a malformed price cannot spend anything), then the balance, then mutate, save, and revert on
	 * failure. Identical to every other verb in this file.
	 */
	public spendCoins(player: Player, amount: number): SpendOutcome {
		if (!typeIs(amount, "number") || amount !== amount || amount <= 0 || amount % 1 !== 0) {
			warn(`[Economy] ${player.Name} spend refused: bad amount`);
			return "bad-amount";
		}

		const profile = this.store.getProfile(player);
		if (profile === undefined) {
			warn(`[Economy] ${player.Name} spend refused: read-only, no profile`);
			return "no-profile";
		}

		if (profile.coins < amount) {
			// Logged with both numbers: the caller decided the price, so a refusal here is the only place the discrepancy
			// between what it expected and what the profile holds is visible.
			warn(`[Economy] ${player.Name} cannot afford ${amount}: coins=${profile.coins}`);
			return "insufficient-coins";
		}

		const outcome = applyCoinSpend(profile, amount, (candidate) => this.store.saveAsync(player, candidate));
		if (outcome === "ok") {
			this.publish(player, profile);
			return outcome;
		}

		warn(`[Economy] ${player.Name} spend of ${amount} failed: ${outcome} — balance restored`);
		return outcome;
	}

	/** Whether this player may act on `remote` now, and records the accept if so. */
	private isAllowed(cooldowns: Map<Player, number>, player: Player, action: string): boolean {
		const now = os.clock();
		const last = cooldowns.get(player);

		if (last !== undefined && (now - last) * 1000 < ECONOMY_ACTION_COOLDOWN_MS) {
			// Rate-limited rather than dropped silently: the press happened and somebody will wonder where the
			// result went, so the log says which verb and which player.
			print(`[Economy] ${player.Name} ${action} ignored — within ${ECONOMY_ACTION_COOLDOWN_MS}ms cooldown`);
			return false;
		}

		cooldowns.set(player, now);
		return true;
	}

	/**
	 * Creates the two remotes and their handlers.
	 *
	 * The find-or-create duplicates `RoundService`'s rather than being factored out, for the reason stated there:
	 * whichever service runs first still has to handle the other's absence, and the only thing a shared helper
	 * could disagree about is which one created the folder — where both outcomes are identical.
	 *
	 * **Every argument from the client is treated as hostile.** `FuseBalls` receives an id and the handler
	 * validates it against the profile the server already holds; the remote itself decides nothing.
	 */
	private createRemotes(): void {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const chest = new Instance("RemoteEvent");
		chest.Name = OPEN_COIN_CHEST_REMOTE_NAME;
		chest.Parent = folder;
		chest.OnServerEvent.Connect((player, count: unknown) => {
			if (!this.isAllowed(this.chestCooldowns, player, "chest")) {
				return;
			}

			// **The cooldown is charged once for the whole request**, not once per chest. A bulk call is one action by one
			// player; gating it ten times is the bug this round removes, and the gate cannot see how many chests a call
			// buys because it only records "when" — which is the point.
			//
			// `count` is untrusted and may be absent, a string, a table, NaN or negative. The single verb is chosen only
			// for the literal number `1`; everything else goes to the bulk verb, whose validator produces the refusal.
			const reply = count === 1 ? this.openCoinChest(player) : this.openChestsBulk(player, count);
			chest.FireClient(player, reply);

			// The reply is the result; this is the confirmation the buyer's client plays a sound for. Fired from the
			// reply's own `ok` rather than from the verb, so a refusal cannot reach it by either route.
			if (reply.ok) {
				this.notifyGranted(player);
			}
		});

		const fuse = new Instance("RemoteEvent");
		fuse.Name = FUSE_BALLS_REMOTE_NAME;
		fuse.Parent = folder;
		fuse.OnServerEvent.Connect((player, ballId) => {
			if (!this.isAllowed(this.fusionCooldowns, player, "fusion")) {
				return;
			}

			if (!typeIs(ballId, "string")) {
				warn(`[Economy] ${player.Name} fusion refused: ballId was a ${typeOf(ballId)}, not a string`);
				fuse.FireClient(player, { ok: false, reason: "bad-request" } as FusionResult);
				return;
			}

			const reply = this.fuseBalls(player, ballId);
			fuse.FireClient(player, reply);

			// **Success only.** A fusion that rolled a failure consumed both materials and granted nothing, so it reports
			// `ok: true` with `outcome: "fail"` — a granted ball is the only thing that makes a purchase noise.
			if (reply.ok && reply.outcome === "success") {
				this.notifyGranted(player);
			}
		});

		// One player, no arguments: the sound is the same clip for every purchase and the client needs nothing else.
		const purchaseGranted = new Instance("RemoteEvent");
		purchaseGranted.Name = PURCHASE_GRANTED_REMOTE_NAME;
		purchaseGranted.Parent = folder;
		this.purchaseGrantedRemote = purchaseGranted;

		// Server to client only, no `OnServerEvent` connection: a reward is the server's statement about a grant it made, and
		// a client that could fire this remote could claim a reward it never earned. The absence of a handler is the whole
		// authorisation model, exactly as on the payout remote.
		const rewardToast = new Instance("RemoteEvent");
		rewardToast.Name = REWARD_TOAST_REMOTE_NAME;
		rewardToast.Parent = folder;
		this.rewardToastRemote = rewardToast;
	}

	/**
	 * Tells one buyer that a purchase was granted.
	 *
	 * Called only where the outcome is known to be a grant: the chest reply's `ok`, the fusion reply's
	 * `outcome === "success"`, and a Robux receipt's `granted`. A `duplicate` receipt is a redelivery of a purchase that
	 * was already granted in an earlier session — the player heard the sound then, and replaying it on the retry would
	 * tell them they had just bought something they had not.
	 */
	private notifyGranted(player: Player): void {
		const remote = this.purchaseGrantedRemote;
		if (remote === undefined) {
			return;
		}

		remote.FireClient(player);
	}

	/**
	 * Creates the `/dev` chat command, once, on the server.
	 *
	 * ## Why this is a chat command and not a `RemoteEvent`
	 *
	 * Verified in `@rbxts/types` 1.0.960: `TextChatCommand` exists, is creatable, exposes `PrimaryAlias` /
	 * `SecondaryAlias` as `string`, and fires `Triggered: (originTextSource: TextSource, unfilteredText: string)`. That
	 * is enough to handle the whole command **on the server**, so this round adds no client code at all — and no remote
	 * means no new attack surface: a remote whose only job is to write coins is a remote a client can try to call, and
	 * the "is this an admin" check inside it would be the only thing between a stranger and the economy.
	 *
	 * ## What the typing does *not* give us
	 *
	 * Two things, both handled by being tolerant rather than by assuming:
	 *
	 * 1. `Triggered` hands over a **`TextSource`, not a `Player`.** `TextSource.UserId` is typed `number`, so the player
	 *    is resolved with `Players.GetPlayerByUserId` — and an unresolvable source is a logged refusal rather than a
	 *    nil index.
	 * 2. Whether `unfilteredText` still contains the alias, and whether an alias may contain a space, are engine
	 *    behaviours the typings say nothing about. So the alias is one word (`/dev`) and the subcommand is read out of
	 *    the text, which `parseDevCommand` is written to tolerate with or without a leading alias token.
	 *
	 * ## Why `AutocompleteVisible` is false
	 *
	 * Autocomplete suggestions are shown to every player in the server. An admin command that advertises itself invites
	 * strangers to try it, and the refusals then fill the log with noise that hides a real attempt. The command still
	 * fires when typed — the flag only hides the suggestion.
	 */
	private createAdminCommand(): void {
		const chat = TextChatService;

		// Find-or-create, because the engine only creates this folder when it has default commands to put in it and
		// `TextChatService.CreateDefaultCommands` is a build setting rather than a guarantee.
		let folder = chat.FindFirstChild(ADMIN_COMMANDS_FOLDER_NAME);
		if (folder === undefined) {
			const created = new Instance("Folder");
			created.Name = ADMIN_COMMANDS_FOLDER_NAME;
			created.Parent = chat;
			folder = created;
		}

		const command = new Instance("TextChatCommand");
		command.Name = ADMIN_COMMAND_NAME;
		command.PrimaryAlias = ADMIN_COMMAND_ALIAS;
		command.AutocompleteVisible = false;
		command.Enabled = true;
		command.Parent = folder;

		command.Triggered.Connect((source, unfilteredText) => this.onDevCommand(source, unfilteredText));

		print(`[Admin] ${ADMIN_COMMAND_ALIAS} registered; autocomplete hidden, authorised UserIds are server-only`);
	}

	/**
	 * The `/dev` command's whole surface: authorise, then parse, then resolve, then dispatch.
	 *
	 * ## Why authorisation is the first statement and reads nothing but the UserId
	 *
	 * A non-admin's chat text is **never parsed**. That is not only about permission — it is about information: if a
	 * stranger's malformed argument produced "setCoins needs a player name and an amount", the reply would confirm the
	 * command exists, name its subcommands and teach its syntax. Refusing on the UserId alone means every non-admin gets
	 * the same one line whatever they typed.
	 *
	 * ## Why every branch returns after logging
	 *
	 * There is no fall-through and no partial action: each refusal is one line and zero writes, so a half-executed
	 * command is not a state this function can reach.
	 *
	 * ## The audit line
	 *
	 * One `print` per action, naming the admin, the target (username **and** display name, because the log is read by a
	 * human who saw one of them) and the value or outcome. It is written here rather than inside `setCoins`/`wipeData`
	 * because this is the only place that knows who the admin is, and a second line from the service would be a line
	 * that cannot say who did it.
	 */
	private onDevCommand(source: TextSource, unfilteredText: string): void {
		const admin = Players.GetPlayerByUserId(source.UserId);

		// **The authorisation check, before anything else.** `isAdmin` reads a hard-coded server-only list; nothing a
		// client can send, set or replicate takes part in it.
		if (!isAdmin(source.UserId)) {
			warn(
				`[Admin] refused: userId=${source.UserId}${admin !== undefined ? ` name=${admin.Name}` : ""} is not an admin`,
			);
			return;
		}

		if (admin === undefined) {
			warn(`[Admin] refused: admin userId=${source.UserId} is not a player in this server`);
			return;
		}

		const who = `${admin.Name}/${admin.DisplayName}`;
		const command = parseDevCommand(unfilteredText);

		if (!command.ok) {
			warn(`[Admin] ${who} refused: ${command.reason}`);
			return;
		}

		const target = findPlayerByName(Players.GetPlayers(), command.target);
		if (target === undefined) {
			// Not a silent no-op: "nothing happened" is indistinguishable from a broken command, and the admin has no
			// other way to learn that the target has to be in this server for their profile to exist here.
			warn(`[Admin] ${who} ${command.kind} refused: no player named "${command.target}" in this server`);
			return;
		}

		if (command.kind === "setCoins") {
			const amount = tonumber(command.amount);
			if (amount === undefined) {
				warn(`[Admin] ${who} setCoins refused: "${command.amount}" is not a number`);
				return;
			}

			const outcome = this.setCoins(target, amount);
			print(`[Admin] ${who} setCoins target=${target.Name}/${target.DisplayName} value=${amount} -> ${outcome}`);
			return;
		}

		const outcome = this.wipeData(target);
		print(`[Admin] ${who} wipeData target=${target.Name}/${target.DisplayName} value=reset -> ${outcome}`);
	}

	/** Loads in a separate coroutine so a slow store does not hold up the join of the next player. */
	private spawnLoad(player: Player): void {
		player.SetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE, "loading");

		task.spawn(() => {
			const profile = this.store.loadAsync(player, STARTING_COINS);
			if (profile === undefined) {
				player.SetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE, "readonly");

				// A read-only session cannot be paid, but in Studio the toast is the thing being looked at, not the coins. See
				// `previewDailyLogin`.
				if (isStudioSession()) {
					this.previewDailyLogin(player);
				}

				return;
			}

			// **The playtime clock is baselined before anything can read it.** `getProfile` returns this profile as soon as
			// `loadAsync` has it, so the playtime ticker can see it on the very next pass - and a stored timestamp that is
			// hours old would pay a stipend for time that was not spent playing. See `playtimeBaselineAtLoad`.
			profile.lastPlaytimeRewardAt = playtimeBaselineAtLoad(
				os.time(),
				profile.lastPlaytimeRewardAt,
				PLAYTIME_REWARD_INTERVAL_SECONDS,
			);

			this.publish(player, profile);
			player.SetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE, "ready");
			print(`[Economy] ${player.Name} loaded coins=${profile.coins} balls=${profile.ownedBalls.size()}`);

			// **After `ready`, so the toast lands on a client that knows its own balance.** The load itself is deliberately not
			// part of the reward path: a session that is read-only never reaches here, and a session that does is guaranteed a
			// profile to stamp.
			if (rewardDue(os.time(), profile.lastDailyRewardAt, DAILY_LOGIN_COOLDOWN_SECONDS)) {
				this.award(player, profile, "lastDailyRewardAt", DAILY_LOGIN_REWARD_COINS, DAILY_LOGIN_LABEL);
			} else if (isStudioSession()) {
				// Paid already, so nothing is granted - but a playtest exists to look at the UI, and the one thing a designer
				// cannot see by waiting twenty hours is the toast. See `previewDailyLogin`.
				this.previewDailyLogin(player);
			}
		});
	}

	/**
	 * Grants one time-based reward, stamping the timestamp **in the same write as the coins**.
	 *
	 * ## The ordering, which is the whole safety story
	 *
	 * The stamp is set *before* `grantCoins`, not after, because `grantCoins` is the thing that saves: it writes the whole
	 * profile, so the timestamp and the balance land in **one** `UpdateAsync`. Stamping afterwards would need a second save,
	 * and a crash between the two would leave the coins granted and the clock unread - the next pass would pay again, and
	 * again, until a save happened to succeed.
	 *
	 * ## What happens when the save fails
	 *
	 * `grantCoins` reverts the balance and returns `false`; this reverts the stamp and returns without a toast. Nothing was
	 * persisted, so nothing happened - the profile in memory is left exactly as it was, and the next pass (or the next join)
	 * sees the reward as still due. The alternative - keeping the stamp on a failed save - would silently skip a reward the
	 * player never received, which is the failure mode a player reports and a log cannot confirm.
	 *
	 * `previous` is captured rather than assumed to be `0`: a reward that fails a minute before the next one is due must
	 * leave the *original* stamp in place, not a cleared one.
	 */
	private award(
		player: Player,
		profile: Profile,
		field: "lastDailyRewardAt" | "lastPlaytimeRewardAt",
		amount: number,
		label: string,
	): boolean {
		const previous = profile[field];
		profile[field] = os.time();

		if (!this.grantCoins(player, amount)) {
			profile[field] = previous;
			return false;
		}

		// One line per reward, and it carries the balance because the reward's own amount is already in `grantCoins`'s line:
		// what a log reader cannot otherwise see is *which schedule* paid and what the clock was set to.
		print(
			`[Economy] ${player.Name} reward ${label} amount=${amount} total=${profile.coins} stamp=${profile[field]}`,
		);
		this.toast(player, label, amount);

		return true;
	}

	/**
	 * Shows the daily-login toast **without granting anything**, and only ever in Studio.
	 *
	 * ## Why the coins are allowed to lie here, and only here
	 *
	 * The daily fires at most once per twenty hours, so the toast is a surface a designer can look at roughly once a working
	 * day - and never at all if the store still has a recent stamp. A playtest exists to look at the UI, which makes "show the
	 * card, move no coins" the useful behaviour: the panel, its slide, its stack slot and its text are all exercised, and the
	 * **economy is untouched** - no grant, no save, and `lastDailyRewardAt` keeps the value it had, so the real reward still
	 * arrives on its real schedule.
	 *
	 * It is gated on `isStudioSession()` rather than on a debug key because a key cannot fire it: the whole point is that it
	 * happens on a plain `Play`, without a step somebody has to remember.
	 *
	 * ## Why the balance does not move and the toast still says `+50`
	 *
	 * A previewed grant that actually paid would be a repeat reward, which is the thing this must not be. The number is the
	 * schedule's nominal value because the toast is being *rendered*, not reported - the log line says `preview` so the two
	 * can never be confused after the fact.
	 */
	private previewDailyLogin(player: Player): void {
		print(
			`[Economy] ${player.Name} reward ${DAILY_LOGIN_LABEL} preview amount=${DAILY_LOGIN_REWARD_COINS} (studio, no grant)`,
		);
		this.toast(player, DAILY_LOGIN_LABEL, DAILY_LOGIN_REWARD_COINS);
	}

	/**
	 * Fires the reward toast, if the client is listening.
	 *
	 * Split out of `award` so the preview path can reach the client without reaching the economy: the grant and the message
	 * are two separate facts, and only one of them is what a Studio preview fakes.
	 */
	private toast(player: Player, label: string, amount: number): void {
		const remote = this.rewardToastRemote;
		if (remote === undefined) {
			return;
		}

		remote.FireClient(player, { label, amount } as RewardToastMessage);
	}

	/**
	 * Starts the playtime stipend's ticker.
	 *
	 * ## Why one thread walking the player list, and not a timer per player
	 *
	 * A per-player `task.spawn` would be a thread parked in `task.wait` for every joiner, all of them waking on their own
	 * schedule, for an interval measured in minutes. One thread that wakes once a minute and asks each profile a question
	 * costs one iteration over a list that is a few dozen long at most, and it cannot leak: there is exactly one of it for
	 * the life of the server.
	 *
	 * ## Why the pass is `pcall`ed
	 *
	 * A background thread that throws is **gone for the session** - no restart, no error beyond the one line it printed - so
	 * a single bad profile would silently switch off the stipend for everyone still connected. The `pcall` is the difference
	 * between one failed pass and a feature that never runs again.
	 *
	 * ## Why the wait comes first
	 *
	 * Nothing can be due at second zero: `spawnLoad` baselines every joining profile, and the first pass at `t=60` finds the
	 * players who loaded in the first minute. Starting with a pass would iterate an empty list and prove nothing.
	 */
	private startPlaytimeRewards(): void {
		task.spawn(() => {
			while (true) {
				task.wait(PLAYTIME_TICK_SECONDS);

				const [ok] = pcall(() => this.payPlaytimeRewards());
				if (!ok) {
					warn(`[Economy] playtime pass failed — it will try again in ${PLAYTIME_TICK_SECONDS}s.`);
				}
			}
		});
	}

	/**
	 * One pass of the playtime stipend.
	 *
	 * `os.time()` is read **once**, so every player in one pass is judged against the same instant. Reading it per player
	 * would let a slow pass straddle the boundary and pay two players whose clocks agree on screen.
	 *
	 * Players whose profile is missing are skipped silently: that is the loading, read-only, or already-released case, and
	 * `spawnLoad`/`loadAsync` has already logged why for the ones that matter.
	 */
	private payPlaytimeRewards(): void {
		const now = os.time();

		for (const player of Players.GetPlayers()) {
			const profile = this.store.getProfile(player);
			if (profile === undefined) {
				continue;
			}

			if (!rewardDue(now, profile.lastPlaytimeRewardAt, PLAYTIME_REWARD_INTERVAL_SECONDS)) {
				continue;
			}

			this.award(player, profile, "lastPlaytimeRewardAt", PLAYTIME_REWARD_COINS, PLAYTIME_LABEL);
		}
	}

	/** Saves and then releases, in that order: a release clears the lock the save still needs to match. */
	private unload(player: Player): void {
		const profile = this.store.getProfile(player);
		if (profile !== undefined) {
			this.store.saveAsync(player, profile);
		}

		this.store.release(player);
		this.chestCooldowns.delete(player);
		this.fusionCooldowns.delete(player);
	}

	/** Writes the three replicated attributes the HUD reads. One function, so they can never be updated apart. */
	private publish(player: Player, profile: Profile): void {
		player.SetAttribute(PLAYER_COINS_ATTRIBUTE, profile.coins);
		player.SetAttribute(PLAYER_OWNED_BALLS_ATTRIBUTE, encodeOwnedBalls(profile.ownedBalls));
	}

	/**
	 * One weighted pick.
	 *
	 * **`math.random()` rather than `Random.new()`**: it is what the rest of this tree uses — the belt bounce,
	 * the shape pool, the lateral weave and the pickup X all draw from it — and a second RNG in the same process
	 * buys nothing but a second thing to seed. The trade-off is that the economy shares a stream with cosmetic
	 * randomness, which is not a fairness problem (the server is the only roller) but is a reason not to add a
	 * *predictable* consumer to the same stream.
	 *
	 * Multiply-then-subtract against a running total, so a weight can be edited without touching any other row.
	 */
}

/**
 * One weighted pick over a weight map: **the only rarity roll in the tree**.
 *
 * ## Why it takes the weights instead of reading `RARITY_WEIGHTS`
 *
 * Because there are now two chests with different pools, and a second pick written for the Robux chest would be a second
 * place for "the filter" to be forgotten. Both chests call this: the coin chest with `RARITY_WEIGHTS`, the Robux chest
 * with `robuxChestWeights()`.
 *
 * ## The invariant that keeps commons out of the Robux chest
 *
 * A tier whose weight is `0` **cannot be returned**. The loop subtracts each tier's weight from a roll that starts in
 * `[0, total)`; for a zero-weight tier the subtraction changes nothing, so `roll < 0` cannot become true on that tier's
 * turn. The exclusion is therefore arithmetic ? there is no filter branch that a later edit could drop, and no way for
 * the roll to disagree with the displayed odds, which are computed from the same map by `oddsFrom`.
 *
 * Unreachable fallback: a `nil` would propagate into a stored ball id, so a definite tier is returned instead.
 */
export function rollFromWeights(weights: Record<Rarity, number>): Rarity {
	let total = 0;
	for (const rarity of RARITIES) {
		total += weights[rarity];
	}

	let roll = math.random() * total;
	for (const rarity of RARITIES) {
		roll -= weights[rarity];
		if (roll < 0) {
			return rarity;
		}
	}

	return RARITIES[RARITIES.size() - 1];
}

/** A uniformly random ball id from a tier's pool, or `undefined` when the pool is empty. */
export function pickBallFrom(rarity: Rarity): string | undefined {
	const pool = BALL_POOL[rarity];
	if (pool.size() === 0) {
		return undefined;
	}

	return pool[math.floor(math.random() * pool.size())];
}

// #region Robux chest

/** What granting a Robux chest purchase did. */
export type GrantOutcome = "granted" | "duplicate" | "no-profile" | "save-failed";

/**
 * Trims the purchase history to `PURCHASE_HISTORY_CAP`, oldest first.
 *
 * Oldest-first because the entries that matter are the recent ones: a receipt redelivered days later is not a realistic
 * retry, while one redelivered seconds later is the case this exists for. Trimming from the front keeps the window
 * around "now", which is where duplicates actually come from.
 */
function trimPurchases(profile: Profile): void {
	while (profile.purchases.size() > PURCHASE_HISTORY_CAP) {
		profile.purchases.remove(0);
	}
}

/**
 * The grant itself, as a function rather than a method, so it can be tested without a DataStore, a `Player` or a
 * published place.
 *
 * ## Why this is not a method on `EconomyService`
 *
 * The service's constructor creates a `PlayerDataStore`, whose first act is `DataStoreService.GetDataStore` ? which
 * **throws in an unpublished place**, so a spec cannot construct the service at all. That is why the existing suite
 * asserts tables rather than behaviour. Taking the save as a callback means the whole grant ? ordering, dedupe, revert ?
 * is exercised by a test with a fake save and no engine services, which is the only way criteria about
 * "save before grant" can be *proved* rather than inspected.
 *
 * ## The ordering, and why it is this way round
 *
 * Mutate the cached profile, **save**, and only report success if the save landed. On failure every mutation is undone,
 * including the purchase id, so a redelivered receipt is still treated as un-granted and can succeed next time. The
 * alternative ? grant now, persist later ? hands out a ball the player does not own and only reveals it on rejoin.
 *
 * The purchase id is recorded **before** the save for the same reason: it has to be in the value that is written, or the
 * dedupe would only work for a session in which the grant also succeeded in memory.
 */
export function applyRobuxChestGrant(
	profile: Profile,
	purchaseId: string,
	save: (profile: Profile) => boolean,
	roll: () => Rarity,
	pickBall: (rarity: Rarity) => string | undefined,
): "granted" | "duplicate" | "save-failed" {
	if (profile.purchases.includes(purchaseId)) {
		// Nothing is written and nothing is granted: the ball from the first delivery is already in `ownedBalls`, and
		// granting again is the exact bug this list exists to prevent.
		return "duplicate";
	}

	const ballId = pickBall(roll());
	if (ballId === undefined) {
		// A tier with an empty pool is a build bug, not a player's problem. Reporting it as a failure leaves the receipt
		// unprocessed rather than consuming it for nothing.
		warn(`[Economy] robux chest: the rolled tier has an empty pool ? purchase ${purchaseId} not granted.`);
		return "save-failed";
	}

	const ownedBefore = profile.ownedBalls.get(ballId) ?? 0;

	profile.ownedBalls.set(ballId, ownedBefore + 1);
	profile.purchases.push(purchaseId);
	trimPurchases(profile);

	if (!save(profile)) {
		restoreOwned(profile, ballId, ownedBefore);
		// Removes only the id just pushed: `trimPurchases` removes from the front, so the new id is still last.
		profile.purchases.pop();

		return "save-failed";
	}

	return "granted";
}

/**
 * Restores `ownedBalls` and `purchases` to copies taken before a grant.
 *
 * ## Why the arrays are refilled in place rather than reassigned
 *
 * `Profile` is shared by reference with whatever holds the cache, so `profile.purchases = saved` would replace the array
 * for this caller only and leave every other holder pointing at the mutated one. Clearing and refilling keeps the
 * identity, which is the difference between a revert and an illusion of one.
 *
 * The purchases array is restored **in full**, not merely stripped of the id that was pushed: a bundle trims the array to
 * `PURCHASE_HISTORY_CAP` before saving, so a trim that is not undone would silently discard an older receipt id and make
 * that older purchase re-grantable.
 */
function restoreProfile(profile: Profile, balls: Map<string, number>, purchases: Array<string>): void {
	profile.ownedBalls.clear();
	for (const [ballId, count] of balls) {
		profile.ownedBalls.set(ballId, count);
	}

	while (profile.purchases.size() > 0) {
		profile.purchases.pop();
	}

	for (const purchaseId of purchases) {
		profile.purchases.push(purchaseId);
	}
}

/** A defensive copy of a map, so a later mutation of the original cannot reach the snapshot. */
function copyOwnedBalls(source: Map<string, number>): Map<string, number> {
	const copy = new Map<string, number>();
	for (const [ballId, count] of source) {
		copy.set(ballId, count);
	}

	return copy;
}

/** A defensive copy of an array, for the same reason. */
function copyPurchases(source: Array<string>): Array<string> {
	const copy = new Array<string>();
	for (const purchaseId of source) {
		copy.push(purchaseId);
	}

	return copy;
}

/**
 * What a batch open produced. `balls` is in roll order, so the reply and the log can name them in the order they were
 * rolled rather than in pool order.
 */
export type ChestBatchOutcome =
	| { outcome: "ok"; balls: Array<string>; coins: number }
	| { outcome: "bad-count" }
	| { outcome: "empty-pool" }
	| { outcome: "save-failed" };

/**
 * Rolls `count` chests, debits them, and saves **once** — as a function, so it can be tested without a `Player`.
 *
 * ## Why this is not `count` calls to the single grant
 *
 * The same argument `applyRobuxChestBundleGrant` makes, and it is worth stating again because the failure is silent: a
 * per-chest loop reverts only the chest that failed, so a save failure on the seventh leaves six balls granted in memory
 * for a purchase that was never recorded — and the next unrelated save persists that state, with nothing in the log
 * pointing at it. One snapshot, one save, one outcome.
 *
 * ## Why the snapshot is restored rather than unwound
 *
 * Undoing forward is where the arithmetic mistakes live. `ownedBalls` is cleared and refilled from a copy of itself, and
 * `coins` is restored from one captured integer, so "nothing happened" is a restore and not a subtraction.
 *
 * ## Why `coins` is captured before the save
 *
 * `save` yields. Reading `profile.coins` on the far side of it would read a field another in-flight call could have
 * changed, which is exactly how the 14:47 log printed the same balance twice for two accepted chests. The returned
 * balance is the batch's own, taken while the batch still had the only reference.
 *
 * ## The empty-pool abort
 *
 * A tier with no entries is a misconfigured build, not a player's problem. A partial batch would charge for chests that
 * granted nothing, so the whole batch is abandoned and the snapshot restored — the player is told to try again and has
 * lost nothing.
 *
 * `count` is assumed to have passed `checkBulkOpenCount`; `bad-count` exists so the function is total rather than
 * trusting its caller, and it takes no snapshot and writes nothing.
 */
export function applyChestBatch(
	profile: Profile,
	count: number,
	save: (profile: Profile) => boolean,
	roll: () => Rarity,
	pickBall: (rarity: Rarity) => string | undefined,
): ChestBatchOutcome {
	if (count < 1) {
		return { outcome: "bad-count" };
	}

	const coinsBefore = profile.coins;
	const ballsBefore = copyOwnedBalls(profile.ownedBalls);
	// The batch does not touch purchases. The copy is taken only so `restoreProfile` can be handed an honest "before"
	// for every field it covers — passing the live array would make the restore a no-op that looks like a snapshot.
	const purchasesBefore = copyPurchases(profile.purchases);

	const granted = new Array<string>();

	for (let index = 0; index < count; index++) {
		const ballId = pickBall(roll());
		if (ballId === undefined) {
			profile.coins = coinsBefore;
			restoreProfile(profile, ballsBefore, purchasesBefore);
			return { outcome: "empty-pool" };
		}

		granted.push(ballId);
		profile.ownedBalls.set(ballId, (profile.ownedBalls.get(ballId) ?? 0) + 1);
		profile.coins -= COIN_CHEST_COST;
	}

	const coinsAfter = profile.coins;

	if (!save(profile)) {
		profile.coins = coinsBefore;
		restoreProfile(profile, ballsBefore, purchasesBefore);
		return { outcome: "save-failed" };
	}

	return { outcome: "ok", balls: granted, coins: coinsAfter };
}

// #region admin verbs
/**
 * Sets a balance to exactly `amount`, as a function so it can be tested without a `Player` or a `DataStore`.
 *
 * ## Why the pieces are here and not all in `EconomyService`
 *
 * The service's constructor creates a `PlayerDataStore`, whose first DataStore call throws in an unpublished place, so
 * no spec can construct the service — the same wall `applyRobuxChestGrant` was factored out to get around. Taking the
 * save as a callback puts the ordering and the revert under test with a fake save, which is what makes "a refused save
 * leaves the balance untouched" provable rather than inspectable.
 *
 * ## Why a scalar needs a snapshot at all
 *
 * It does not need a copy — `coinsBefore` is the whole story, because coins are one number and nothing else is touched.
 * The revert is only here because a caller that reported success and then failed to persist would leave the HUD showing
 * a balance the profile does not have, and the player would discover it on rejoin.
 *
 * `0` is a legal value and is not special-cased: an admin zeroing a balance is a normal thing to want, and refusing it
 * would be refusing the most useful value in the list.
 */
export function applyCoinSet(profile: Profile, amount: number, save: (profile: Profile) => boolean): AdminOutcome {
	const coinsBefore = profile.coins;
	profile.coins = amount;

	if (!save(profile)) {
		profile.coins = coinsBefore;
		return "save-failed";
	}

	return "ok";
}

/**
 * Resets a profile to a brand-new player's, all of it or none of it.
 *
 * ## Why the snapshot covers balls and purchases but not coins
 *
 * `ownedBalls` and `purchases` are containers that get *cleared*, and a clear cannot be undone by remembering one value.
 * Both are copied before the mutation and restored in place on failure — in place, because `Profile` is shared by
 * reference with whatever holds the cache, so reassigning the field would fix this caller and leave every other holder
 * pointing at the emptied container.
 *
 * ## Why the in-memory profile is mutated before the save
 *
 * Because the value that is written **is** the profile. `saveAsync` serialises whatever is in the map when it runs, so a
 * reset that saved first and cleared afterwards would persist the old data. The ordering is mutate, save, revert on
 * failure — the same as every other verb, and the reason the revert is a full restore rather than a best effort.
 *
 * ## What is deliberately not reset
 *
 * `version` and the session lock. The schema is this build's, and the lock answers "which session owns this profile",
 * which a content change does not affect — releasing it would let a second server load the same player mid-session.
 */
export function applyProfileReset(profile: Profile, save: (profile: Profile) => boolean): AdminOutcome {
	const coinsBefore = profile.coins;
	const ballsBefore = copyOwnedBalls(profile.ownedBalls);
	const purchasesBefore = copyPurchases(profile.purchases);

	profile.coins = STARTING_COINS;
	profile.ownedBalls.clear();
	while (profile.purchases.size() > 0) {
		profile.purchases.pop();
	}

	if (!save(profile)) {
		profile.coins = coinsBefore;
		restoreProfile(profile, ballsBefore, purchasesBefore);
		return "save-failed";
	}

	return "ok";
}

/**
 * Charges `amount` coins and saves once, restoring the balance on failure.
 *
 * The scalar sibling of `applyCoinSet`: same ordering, same single-field revert, opposite direction. It exists as a
 * function for the same reason the others do — the price path's "refused means nothing changed" claim has to be provable
 * with a fake save, and `EconomyService` cannot be constructed in this runtime.
 *
 * Affordability is checked here as well as in the service. That duplication is deliberate: one check is where the balance
 * is read to report a refusal, the other is where it is written, and the second is the one that cannot be bypassed by a
 * caller that forgot.
 */
export function applyCoinSpend(profile: Profile, amount: number, save: (profile: Profile) => boolean): SpendOutcome {
	if (!typeIs(amount, "number") || amount !== amount || amount <= 0 || amount % 1 !== 0) {
		return "bad-amount";
	}

	if (profile.coins < amount) {
		return "insufficient-coins";
	}

	const coinsBefore = profile.coins;
	profile.coins = coinsBefore - amount;

	if (!save(profile)) {
		profile.coins = coinsBefore;
		return "save-failed";
	}

	return "ok";
}

// #endregion

/**
 * Grants `count` rare-or-better balls for **one** purchase id, all of it or none of it.
 *
 * Returns the balls actually granted, in roll order, so the log and the reply can say what the player received rather
 * than only that something happened.
 *
 * ## Why this cannot be `count` calls to `applyRobuxChestGrant`
 *
 * Because the money is charged once. A bundle is one Developer Product, one receipt and one `PurchaseId`, and the only
 * correct outcomes are "ten balls" and "nothing". Ten independent grants give neither: each reverts only itself, so a
 * save failure on the eighth leaves seven balls granted in memory for a purchase that was never recorded ? and that
 * profile state can be written by the *next* unrelated save, which is the worst kind of corruption because nothing in
 * the log points at it.
 *
 * Hence the snapshot. Everything the loop touches is copied first, and every failure path restores those copies rather
 * than trying to undo the loop step by step. Undoing forward is where the arithmetic mistakes live; restoring a copy
 * cannot be wrong.
 *
 * ## Why the purchase id is pushed once, after the loop
 *
 * It identifies the *purchase*, not the balls. Pushing it per ball would record ten ids for one receipt, fill the
 * history cap ten times faster, and make a redelivered receipt match only the first of them.
 *
 * ## Why a failed save must remove the id as well as the balls
 *
 * This is the sentence that matters. A failure returns `NotProcessedYet`, which asks Roblox to deliver the same receipt
 * again. If the id survived the rollback, the retry would hit the duplicate guard, report `"duplicate"`, and be answered
 * `PurchaseGranted` ? the player charged, the receipt consumed, and no balls. Restoring the array is what makes the
 * retry a fresh attempt instead of a false duplicate.
 *
 * ## The floor, and why it forces the *last* roll rather than upgrading the worst
 *
 * `guaranteed` is the bundle's tier promise (`ROBUX_CHEST_BUNDLE_GUARANTEE`). If the preceding rolls have not produced
 * that tier, the final roll is taken from it directly instead of being rolled. Two reasons this is the last roll and not
 * a post-hoc upgrade:
 *
 * 1. **A replacement has to move two numbers.** Upgrading the weakest granted ball means decrementing that ball's count
 *    and incrementing another's, and a bug there corrupts `ownedBalls` rather than merely mis-stating a rarity. Forcing a
 *    roll leaves the grant as "ten balls, each added exactly once" - the property the all-or-nothing snapshot already
 *    relies on.
 * 2. **The promise is about the bundle, not about any particular roll.** "At least one of these ten" is a statement about
 *    the set, and taking the last slot is the smallest way to make it true: the first nine rolls keep their honest odds.
 *
 * The `floored` flag comes back so the caller can log that the floor did something. A silent guarantee is a guarantee a
 * player support conversation has to take on faith.
 */
export function applyRobuxChestBundleGrant(
	profile: Profile,
	purchaseId: string,
	count: number,
	save: (profile: Profile) => boolean,
	roll: () => Rarity,
	pickBall: (rarity: Rarity) => string | undefined,
	guaranteed?: Rarity,
): { outcome: "granted" | "duplicate" | "save-failed"; granted: Array<string>; floored: boolean } {
	if (profile.purchases.includes(purchaseId)) {
		return { outcome: "duplicate", granted: [], floored: false };
	}

	const ballsBefore = copyOwnedBalls(profile.ownedBalls);
	const purchasesBefore = copyPurchases(profile.purchases);

	const granted = new Array<string>();
	let sawGuarantee = false;
	let floored = false;

	for (let index = 0; index < count; index++) {
		let rarity: Rarity;

		if (guaranteed !== undefined && !sawGuarantee && index === count - 1) {
			rarity = guaranteed;
			floored = true;
		} else {
			rarity = roll();
		}

		if (guaranteed !== undefined && rarity === guaranteed) {
			sawGuarantee = true;
		}

		const ballId = pickBall(rarity);
		if (ballId === undefined) {
			// An empty pool is a build bug, and the money has already been taken. Nothing is granted, nothing is
			// recorded, and the receipt stays unprocessed so a fixed build can still deliver it.
			restoreProfile(profile, ballsBefore, purchasesBefore);
			warn(`[Economy] robux bundle: the rolled tier has an empty pool ? purchase ${purchaseId} not granted.`);
			return { outcome: "save-failed", granted: [], floored: false };
		}

		profile.ownedBalls.set(ballId, (profile.ownedBalls.get(ballId) ?? 0) + 1);
		granted.push(ballId);
	}

	profile.purchases.push(purchaseId);
	trimPurchases(profile);

	if (!save(profile)) {
		restoreProfile(profile, ballsBefore, purchasesBefore);
		return { outcome: "save-failed", granted: [], floored: false };
	}

	return { outcome: "granted", granted, floored };
}

/**
 * Maps a grant outcome to the decision Roblox is told.
 *
 * **`duplicate` must be `PurchaseGranted`.** Returning `NotProcessedYet` for a receipt whose ball was already given
 * tells Roblox the sale failed, so it retries ? forever, because every retry is also a duplicate. That is an infinite
 * loop that also blocks the player's next purchase.
 *
 * A refused session (`no-profile`) and a failed write (`save-failed`) are genuinely "not yet": the player paid and has
 * nothing, so a retry is the only outcome that can still deliver the product.
 */
export function receiptDecision(outcome: GrantOutcome): Enum.ProductPurchaseDecision {
	if (outcome === "granted" || outcome === "duplicate") {
		return Enum.ProductPurchaseDecision.PurchaseGranted;
	}

	return Enum.ProductPurchaseDecision.NotProcessedYet;
}

// #endregion

/**
 * Puts a ball count back the way it was, including removing the entry when there was none.
 *
 * A revert that leaves `bully_ball = 0` behind is not a revert: the profile would then own a ball it never
 * owned, and the fusion UI would offer a Fuse button for a ball the player has none of.
 */
function restoreOwned(profile: Profile, ballId: string, previous: number): void {
	if (previous <= 0) {
		profile.ownedBalls.delete(ballId);
		return;
	}

	profile.ownedBalls.set(ballId, previous);
}
