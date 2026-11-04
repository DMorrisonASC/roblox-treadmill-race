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

import { Players, ReplicatedStorage } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import {
	PLAYER_COINS_ATTRIBUTE,
	PLAYER_ECONOMY_STATE_ATTRIBUTE,
	PLAYER_OWNED_BALLS_ATTRIBUTE,
} from "shared/attributes";
import {
	BALL_POOL,
	COIN_CHEST_COST,
	ECONOMY_ACTION_COOLDOWN_MS,
	encodeOwnedBalls,
	FUSION_INPUT_COUNT,
	FUSION_TABLE,
	RARITIES,
	RARITY_WEIGHTS,
	Rarity,
	rarityOfBall,
	STARTING_COINS,
} from "shared/economy.config";
import { FUSE_BALLS_REMOTE_NAME, OPEN_COIN_CHEST_REMOTE_NAME, REMOTES_FOLDER_NAME } from "shared/remotes";
import { PlayerDataStore, Profile } from "./player-data-store";

/** What a chest press produced. */
export type ChestResult = { ok: true; ballId: string } | { ok: false; reason: string };

/** What a fusion press produced. */
export type FusionResult =
	{ ok: true; outcome: "success" | "fail"; resultBallId?: string } | { ok: false; reason: string };

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

	public onStart(): void {
		this.store.start();

		this.createRemotes();

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

		const rarity = this.rollRarity();
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

		if (!this.store.saveAsync(player, profile)) {
			profile.coins = coinsBefore;
			restoreOwned(profile, ballId, ownedBefore);
			warn(`[Economy] ${player.Name} chest save failed — no grant`);
			return { ok: false, reason: "save-failed" };
		}

		this.publish(player, profile);
		print(`[Economy] ${player.Name} chest ok ball=${ballId} coins=${profile.coins}`);

		return { ok: true, ballId };
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
	 * Adds coins. **Not called by anything yet** — there is no coin-earn path in this round.
	 *
	 * Written now because the profile is the only thing that can hold coins and this is the only correct way to
	 * change the balance outside a chest: it goes through the same save-before-report path, so the day a round
	 * grants a prize, the prize cannot be granted twice or lost.
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
		chest.OnServerEvent.Connect((player) => {
			if (!this.isAllowed(this.chestCooldowns, player, "chest")) {
				return;
			}

			chest.FireClient(player, this.openCoinChest(player));
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

			fuse.FireClient(player, this.fuseBalls(player, ballId));
		});
	}

	/** Loads in a separate coroutine so a slow store does not hold up the join of the next player. */
	private spawnLoad(player: Player): void {
		player.SetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE, "loading");

		task.spawn(() => {
			const profile = this.store.loadAsync(player, STARTING_COINS);
			if (profile === undefined) {
				player.SetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE, "readonly");
				return;
			}

			this.publish(player, profile);
			player.SetAttribute(PLAYER_ECONOMY_STATE_ATTRIBUTE, "ready");
			print(`[Economy] ${player.Name} loaded coins=${profile.coins} balls=${profile.ownedBalls.size()}`);
		});
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
	private rollRarity(): Rarity {
		let total = 0;
		for (const rarity of RARITIES) {
			total += RARITY_WEIGHTS[rarity];
		}

		let roll = math.random() * total;
		for (const rarity of RARITIES) {
			roll -= RARITY_WEIGHTS[rarity];
			if (roll < 0) {
				return rarity;
			}
		}

		// Unreachable while `total` is positive and `math.random()` is `[0, 1)`, and it is still written out:
		// returning a definite tier is cheaper than a `nil` that would propagate into a stored ball id.
		return RARITIES[RARITIES.size() - 1];
	}
}

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
