/**
 * The one place a player's persistent state is read and written.
 *
 * ## Why `UpdateAsync` and never `SetAsync`
 *
 * `SetAsync` is a blind write: it replaces whatever is at the key with whatever this server happens to be
 * holding, with no knowledge of what was there a moment ago. **`UpdateAsync` runs a transform against the
 * current stored value, and the platform guarantees no other write interleaves with that transform.** That
 * makes read-modify-write atomic — which is the entire difference between "the last writer wins" and "the
 * second writer saw the first writer's data". With `SetAsync`, two servers touching one player's key is a lost
 * coin balance; with `UpdateAsync`, the second one re-reads and applies its change on top.
 *
 * The transform is also where every refusal lives: cancelling the write (returning nothing) is how "the lock is
 * held" and "the schema is not mine" are expressed without ever having read-then-decided-then-written across a
 * gap another server can reach into.
 *
 * ## Why a session lock at all
 *
 * A player is one entity but may be *loaded* by more than one server: a rejoin before the old session's
 * `PlayerRemoving` finished, a teleport between places, two Studio clients testing the same account. Without a
 * lock, both sessions hold a profile in memory, both save, and the slower one overwrites the faster one's
 * earnings — silently, because both saves "succeeded". The lock makes the second load return `undefined`, which
 * the economy service turns into a **read-only** session: it may read nothing, grant nothing, and spend nothing.
 * The lock is refreshed on every save, so a live session cannot have its lock taken; a *dead* one's lock goes
 * stale after `LOCK_TIMEOUT_SECONDS` and the next session claims it.
 *
 * ## Why every call is retried
 *
 * DataStore requests fail transiently — throttling, backend hiccups, a request that times out. A single attempt
 * therefore reports failure for a reason that is not the player's fault and will not be true a second later.
 * `RETRY_DELAYS` is the backoff schedule: **one attempt plus one retry per entry**, so three entries buy four
 * attempts at 0 s, 1 s, 2 s and 4 s. Retries stop at the first success or the first *definitive* answer (a held
 * lock, an unknown schema) — retrying a refusal would just be a slower refusal.
 *
 * ## Why this file yields instead of returning promises
 *
 * `roblox-ts` compiles `async` to `TS.async`, which **returns a `Promise` immediately** and runs the body in a
 * separate coroutine. That is fine for a click handler and wrong for `BindToClose`: the shutdown callback must
 * *itself* yield, or the server closes underneath a save that has already started. Every public method here is a
 * plain function that yields on the DataStore call, so `BindToClose` can call `saveAllTracked` directly and the
 * shutdown genuinely waits. It also matches the rest of this tree, which has no promise anywhere.
 */

import { DataStoreService } from "@rbxts/services";

/** The DataStore every profile lives in. Changing this orphances every existing profile — it is a version bump. */
const DATASTORE_NAME = "PlayerEconomy";

/**
 * The key for one player: `Player_<UserId>`.
 *
 * A prefix rather than the bare id so the store is browsable: in the DataStore editor, `Player_1234` reads as
 * player data and `1234` reads as a typo. The prefix also leaves room for future non-player keys in the same
 * store without a second DataStore.
 */
const KEY_PREFIX = "Player_";

/** The schema this build reads and writes. A profile at any other version is refused, never upgraded. */
export const SCHEMA_VERSION = 1;

/** **Placeholder.** Seconds after which a lock is assumed dead and may be claimed by another session. */
const LOCK_TIMEOUT_SECONDS = 60;

/**
 * Retry schedule in seconds. **One entry per retry**: this array buys four attempts in total, at 0 s, 1 s, 2 s
 * and 4 s. Delays rather than a fixed wait because the two common failures differ — throttling clears when the
 * burst ends, a transient 500 clears on its own schedule — and a fixed 1 s retry storm is what generates the
 * throttle in the first place.
 */
const RETRY_DELAYS = [1, 2, 4];

/**
 * **Placeholder.** Seconds of the shutdown window this wrapper will spend saving.
 *
 * The platform allows roughly 30 s for `BindToClose`. Ten seconds are deliberately left unspent: saves are
 * sequential and each may itself retry for up to 7 s, so a budget equal to the window would guarantee the last
 * save is cut off mid-write — the one failure mode worse than not trying.
 */
const SHUTDOWN_SAVE_BUDGET_SECONDS = 20;

/**
 * A player's live state.
 *
 * `ownedBalls` is a `Map` in memory and a plain table on disk. The two shapes are deliberately not the same
 * type: a `Map`'s internals are roblox-ts's business and could change with a compiler upgrade, so persisting one
 * directly would make the saved format depend on the transpiler. Serialising it explicitly is what makes the
 * stored schema a decision rather than an accident.
 */
export interface Profile {
	version: number;
	coins: number;
	ownedBalls: Map<string, number>;
}

/** Who holds a profile and since when, as stored. */
interface StoredLock {
	session: string;
	at: number;
}

/** A profile as it exists on disk: the map becomes a table, plus the lock this build needs. */
interface StoredProfile {
	version: number;
	coins: number;
	ownedBalls: Record<string, number>;
	lock?: StoredLock;
}

/** A profile plus its lock, as validated out of the store. */
interface Stored {
	profile: Profile;
	lock?: StoredLock;
}

/** What the transform did, so the caller can log a reason rather than a bare `false`. */
type ClaimOutcome = "claimed" | "locked" | "unrecognised";

/** What a save did. */
type SaveOutcome = "saved" | "locked" | "unrecognised" | "failed";

/**
 * The session identity this server writes into locks.
 *
 * `game.JobId` is the server's stable identity and is empty in Studio, so a Studio session falls back to the
 * literal and the random tail keeps two Studio clients apart — which is exactly the case the lock exists to
 * refuse.
 */
const SESSION_ID = `${game.JobId !== "" ? game.JobId : "studio"}-${math.random(100000, 999999)}`;

/** Whether a lock has aged past the timeout. A clock that runs backwards reads as "not stale", which is safe. */
function isStale(lock: StoredLock | undefined): boolean {
	if (lock === undefined) {
		return true;
	}

	return os.time() - lock.at >= LOCK_TIMEOUT_SECONDS;
}

/**
 * Validates a stored value and converts it to a live profile.
 *
 * **Every field is checked with `typeIs` rather than trusted from the type parameter.** The generic on
 * `UpdateAsync` is an assertion by the author, not a guarantee from the platform: the key could hold a string
 * from a previous experimental build, a table missing `coins`, or a number where a table belongs. A validator
 * that trusted the generic would index `nil` and throw inside a DataStore transform, which surfaces as an
 * opaque "request failed" rather than as "this profile is not mine".
 *
 * A `version` that is not this build's is **refused, not upgraded**. Upgrading is a guess about what the old
 * fields meant; refusing is a fact about what this build knows. The player loses nothing either way — the data
 * is still there, untouched, for a build that does understand it.
 */
export function readStored(value: unknown): Stored | undefined {
	if (!typeIs(value, "table")) {
		return undefined;
	}

	const version = (value as { version?: unknown }).version;
	if (!typeIs(version, "number") || version !== SCHEMA_VERSION) {
		return undefined;
	}

	const coins = (value as { coins?: unknown }).coins;
	if (!typeIs(coins, "number")) {
		return undefined;
	}

	const rawOwned = (value as { ownedBalls?: unknown }).ownedBalls;
	if (!typeIs(rawOwned, "table")) {
		return undefined;
	}

	const ownedBalls = new Map<string, number>();
	for (const [ballId, count] of pairs(rawOwned as Record<string, unknown>)) {
		if (!typeIs(ballId, "string") || !typeIs(count, "number")) {
			return undefined;
		}

		ownedBalls.set(ballId, count);
	}

	const rawLock = (value as { lock?: unknown }).lock;
	let lock: StoredLock | undefined;
	if (rawLock !== undefined) {
		if (!typeIs(rawLock, "table")) {
			return undefined;
		}

		const session = (rawLock as { session?: unknown }).session;
		const at = (rawLock as { at?: unknown }).at;
		if (!typeIs(session, "string") || !typeIs(at, "number")) {
			return undefined;
		}

		lock = { session, at };
	}

	return { profile: { version: SCHEMA_VERSION, coins, ownedBalls }, lock };
}

/**
 * The value written to the store: the profile's map flattened, and the lock stamped with this session and now.
 *
 * The lock is refreshed here rather than in a separate call because a save *is* the proof that this session is
 * alive. A second write would double the request budget to say the same thing.
 */
export function toStored(profile: Profile, session: string): StoredProfile {
	return {
		version: SCHEMA_VERSION,
		coins: profile.coins,
		ownedBalls: flattenOwned(profile.ownedBalls),
		lock: { session, at: os.time() },
	};
}

/** The stored form of the map: a plain table, because that is what a DataStore value is. */
export function flattenOwned(ownedBalls: Map<string, number>): Record<string, number> {
	const flat: Record<string, number> = {};
	for (const [ballId, count] of ownedBalls) {
		flat[ballId] = count;
	}

	return flat;
}

/** A brand-new profile. Coins are granted here and nowhere else, so "a new player" has exactly one definition. */
function emptyProfile(startingCoins: number): Profile {
	return { version: SCHEMA_VERSION, coins: startingCoins, ownedBalls: new Map() };
}

/**
 * Packs a decision's result into the tuple `UpdateAsync` requires.
 *
 * Returning the first element as `undefined` is how a write is **cancelled**: the platform leaves the key alone
 * and the caller learns the refusal from the flag the decision set, not from the value. That is why every refusal
 * above reads as "decide to write nothing" rather than "throw".
 */
function asTuple(value: StoredProfile | undefined) {
	// eslint-disable-next-line roblox-ts/no-user-defined-lua-tuple -- UpdateAsync's transform signature requires a LuaTuple; this is the API's shape, not a helper invented here.
	return $tuple(value);
}

export class PlayerDataStore {
	private readonly store = DataStoreService.GetDataStore(DATASTORE_NAME);

	/**
	 * The profiles this server currently owns, keyed by player.
	 *
	 * Held here rather than in the economy service for one reason: `BindToClose` has to save every live profile,
	 * and this is the object that knows which keys exist. A second copy of this map in the service would be two
	 * answers to "what is loaded" that can disagree, and the one that disagreed during a shutdown would be the
	 * one that lost data.
	 */
	private readonly tracked = new Map<Player, Profile>();

	/** The profile this server owns for a player, or `undefined` while loading, read-only, or after release. */
	public getProfile(player: Player): Profile | undefined {
		return this.tracked.get(player);
	}

	/** How many profiles this server currently owns. Logged at shutdown so a count can be compared to a roster. */
	public getTrackedCount(): number {
		return this.tracked.size();
	}

	/**
	 * Loads a player's profile and claims the session lock, or returns `undefined`.
	 *
	 * `undefined` covers three different situations that the caller must not distinguish for its behaviour but
	 * must be able to read in a log: the store rejected every attempt, the schema is not this build's, and
	 * **another session holds the lock**. All three mean the same thing to the economy — this session may not
	 * grant or spend — which is why they share a return type and differ only by their log line.
	 */
	public loadAsync(player: Player, startingCoins: number): Profile | undefined {
		const key = KEY_PREFIX + tostring(player.UserId);

		let outcome: ClaimOutcome | "failed" = "failed";
		let loaded: Profile | undefined;

		for (let attempt = 0; attempt <= RETRY_DELAYS.size(); attempt++) {
			if (attempt > 0) {
				task.wait(RETRY_DELAYS[attempt - 1]);
			}

			outcome = "failed";
			const [ok] = pcall(() => {
				const [updated] = this.store.UpdateAsync<StoredProfile, StoredProfile>(key, (current) => {
					if (current !== undefined) {
						const stored = readStored(current);
						if (stored === undefined) {
							outcome = "unrecognised";
							return asTuple(undefined);
						}

						if (stored.lock !== undefined && stored.lock.session !== SESSION_ID && !isStale(stored.lock)) {
							outcome = "locked";
							return asTuple(undefined);
						}

						outcome = "claimed";
						return asTuple(toStored(stored.profile, SESSION_ID));
					}

					outcome = "claimed";
					return asTuple(toStored(emptyProfile(startingCoins), SESSION_ID));
				});

				if (outcome === "claimed" && updated !== undefined) {
					const stored = readStored(updated);
					if (stored !== undefined) {
						loaded = stored.profile;
					}
				}
			});

			// A thrown call is a transient failure and the only outcome worth retrying. "Locked" and
			// "unrecognised" are definitive answers: another attempt asks the same question of the same data.
			if (!ok) {
				continue;
			}

			break;
		}

		// **Cast, not an oversight.** `outcome` is assigned inside the `pcall` closure, which control-flow
		// analysis cannot see through, so it believes the variable is still `"failed"` here. Restating the
		// declared union is what makes the comparisons below expressible.
		const finalOutcome = outcome as ClaimOutcome | "failed";

		if (finalOutcome === "locked") {
			warn(`[Store] ${player.Name} is locked by another session — this session is read-only.`);
			return undefined;
		}

		if (finalOutcome === "unrecognised") {
			warn(`[Store] ${player.Name}'s profile is not schema v${SCHEMA_VERSION} — refused, left untouched.`);
			return undefined;
		}

		if (loaded === undefined) {
			warn(`[Store] ${player.Name}'s profile failed to load after ${RETRY_DELAYS.size() + 1} attempts.`);
			return undefined;
		}

		this.tracked.set(player, loaded);
		return loaded;
	}

	/**
	 * Writes a profile, refreshing the lock. Returns `false` on any failure, including "we no longer hold it".
	 *
	 * **The caller saves before it grants, and grants nothing if this returns `false`.** That ordering is the
	 * whole safety story of the economy: an action that spends nothing on failure is one the player can retry,
	 * while an action that granted in memory and failed to persist hands out a ball that vanishes on rejoin — and
	 * the second kind of bug is invisible until somebody rejoins.
	 */
	public saveAsync(player: Player, profile: Profile): boolean {
		const key = KEY_PREFIX + tostring(player.UserId);

		let outcome: SaveOutcome = "failed";

		for (let attempt = 0; attempt <= RETRY_DELAYS.size(); attempt++) {
			if (attempt > 0) {
				task.wait(RETRY_DELAYS[attempt - 1]);
			}

			outcome = "failed";
			const [ok] = pcall(() => {
				const [updated] = this.store.UpdateAsync<StoredProfile, StoredProfile>(key, (current) => {
					if (current !== undefined) {
						const stored = readStored(current);
						if (stored === undefined) {
							outcome = "unrecognised";
							return asTuple(undefined);
						}

						// Someone else claimed the lock while this session was alive. Writing now would overwrite
						// their profile with ours, so the write is cancelled and reported — the in-memory change is
						// abandoned rather than persisted.
						if (stored.lock !== undefined && stored.lock.session !== SESSION_ID) {
							outcome = "locked";
							return asTuple(undefined);
						}
					}

					outcome = "saved";
					return asTuple(toStored(profile, SESSION_ID));
				});

				if (outcome === "saved" && updated === undefined) {
					outcome = "failed";
				}
			});

			if (!ok) {
				continue;
			}

			break;
		}

		// **Cast, not an oversight** — same reason as in `loadAsync`: the assignment happens in the closure.
		const finalOutcome = outcome as SaveOutcome;

		if (finalOutcome !== "saved") {
			warn(
				`[Store] ${player.Name}'s profile save failed (${finalOutcome}) — the action is refused, nothing granted.`,
			);
			return false;
		}

		this.tracked.set(player, profile);
		return true;
	}

	/**
	 * Stops tracking a player and clears the lock, both best-effort.
	 *
	 * `void` and not a result because there is nothing to do with a failure: the player has left, the session is
	 * over, and a lock that is not cleared becomes claimable by the timeout instead. The clear is spawned rather
	 * than performed inline so `PlayerRemoving` never holds the server's leave path on a DataStore round trip.
	 */
	public release(player: Player): void {
		this.tracked.delete(player);

		task.spawn(() => {
			const key = KEY_PREFIX + tostring(player.UserId);

			const [ok] = pcall(() => {
				this.store.UpdateAsync<StoredProfile, StoredProfile>(key, (current) => {
					if (current === undefined) {
						return asTuple(undefined);
					}

					const stored = readStored(current);
					if (stored === undefined || stored.lock === undefined || stored.lock.session !== SESSION_ID) {
						return asTuple(undefined);
					}

					const cleared: StoredProfile = {
						version: SCHEMA_VERSION,
						coins: stored.profile.coins,
						ownedBalls: flattenOwned(stored.profile.ownedBalls),
						lock: undefined,
					};

					return asTuple(cleared);
				});
			});

			if (!ok) {
				warn(`[Store] ${player.Name}'s lock was not cleared — it expires in ${LOCK_TIMEOUT_SECONDS}s.`);
			}
		});
	}

	/**
	 * Registers the shutdown save.
	 *
	 * ## Why `BindToClose` exists in a DataStore that saves on `PlayerRemoving`
	 *
	 * `PlayerRemoving` does not fire the way a designer imagines it does. A server that shuts down — a normal
	 * close, a crash recovery, a Studio stop — does not give every session a polite `PlayerRemoving` first; the
	 * connections between server and clients are cut and the server is given a short window to finish.
	 * `BindToClose` is that window, and it is the only hook that runs *after* the server has decided to die and
	 * *before* it is allowed to. Without it, every shutdown loses whatever was earned since the last save.
	 *
	 * Registered by the economy service rather than in this class's constructor: a constructor that installs a
	 * global handler runs before the service graph is complete, cannot be undone, and would fire for a store that
	 * was constructed but never used.
	 */
	public start(): void {
		game.BindToClose((reason) => {
			this.saveAllTracked(`server closing (${reason.Name})`);
		});
	}

	/**
	 * Saves every tracked profile inside the shutdown budget, then reports.
	 *
	 * Sequential and grouped by outcome rather than one line per player: during a shutdown the log is a single
	 * burst that nobody will filter, and what a reader needs is "how many landed", not a list. The per-player
	 * failures still come from `saveAsync` itself.
	 *
	 * A profile that cannot be saved before the budget runs out is **abandoned**, not force-written with a
	 * shorter timeout: a write that has begun when the process dies is the one way to leave a key in an
	 * indeterminate state, while a write that was never started leaves the last good save intact.
	 */
	private saveAllTracked(reason: string): void {
		const players = new Array<Player>();
		for (const [player] of this.tracked) {
			players.push(player);
		}

		const deadline = os.clock() + SHUTDOWN_SAVE_BUDGET_SECONDS;
		let saved = 0;
		let failed = 0;
		let skipped = 0;

		for (const player of players) {
			const profile = this.tracked.get(player);
			if (profile === undefined) {
				continue;
			}

			if (os.clock() >= deadline) {
				skipped++;
				continue;
			}

			if (this.saveAsync(player, profile)) {
				saved++;
			} else {
				failed++;
			}
		}

		print(
			`[Store] shutdown save (${reason}) profiles=${players.size()} saved=${saved} failed=${failed} skipped=${skipped}`,
		);
	}
}
