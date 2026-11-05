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

import { DataStoreService, RunService } from "@rbxts/services";

/** The DataStore every profile lives in. Changing this orphans every existing profile — it is a version bump. */
const DATASTORE_NAME = "PlayerEconomy";

/**
 * The key for one player: `Player_<UserId>`.
 *
 * A prefix rather than the bare id so the store is browsable: in the DataStore editor, `Player_1234` reads as
 * player data and `1234` reads as a typo. The prefix also leaves room for future non-player keys in the same
 * store without a second DataStore.
 *
 * ## This is the shipped key, and changing it is a silent wipe
 *
 * Every profile the game has ever written lives under this prefix, and every key is built by `profileKeyFor` below from
 * this one constant. Changing the string does not rename anything: it points the
 * store at keys that do not exist, so every load misses and every player is handed `emptyProfile`. Their real data is
 * still there, orphaned under the old prefix, and no code will ever look at it again. That is a wipe with no deletion,
 * no error and no log line, which is exactly why it is dangerous.
 *
 * **This was done once, deliberately, and had to be undone.** Item 64 appended a `v2` marker to this prefix to get a
 * fresh profile for a reproduction — a dev wipe with no engine access, since a key cannot be deleted from outside the
 * engine. It
 * worked, and it was left in place long enough that every session was loading a blank profile and writing to a second
 * key while the real data sat untouched. Item 66's task was to put it back. The lesson is not "never bump this": it is
 * that a bump is indistinguishable from a bad commit, so it must not be the mechanism.
 *
 * ## What to do instead when a fresh profile is needed
 *
 * Use `/dev wipeData <player>` (item 65). It resets the profile **through the store** — `STARTING_COINS`, no balls, no
 * purchase history — so the result is a real write under the real key, visible in the attribute the client reads, and
 * reversible in the sense that the old contents are gone only because somebody asked for them to be. It also costs one
 * command instead of an edit, a rebuild and a playtest restart.
 *
 * **`SCHEMA_VERSION` is a different tool and not a substitute.** A version bump makes `readStored` refuse the old data
 * and the session goes read-only; it does not hand out a fresh profile, which is the only thing a wipe is for.
 */
const KEY_PREFIX = "Player_";

/**
 * **Placeholder.** Appended to the key when the server is running inside Studio: `Player_41354175_Dev`.
 *
 * ## Why Studio and live do not share a namespace
 *
 * They share one DataStore, and a playtest is not a rehearsal — it grants coins, opens chests and writes purchases with
 * the same verbs the live game uses. Under one namespace, testing changes what ships: a `/dev setCoins` in a playtest
 * edits the profile a live player will load, and there is no undo for it. Separate keys make "this was a test" a
 * property of the storage location rather than a thing somebody has to remember.
 *
 * The **lock contention disappears as a side effect**, and that is worth naming because it was the more visible symptom:
 * the lock is one `session` field inside the stored value, so a playtest holding `Player_41354175` made a live server
 * refuse that player with `[Store] … locked by another session`, and a live lock refused the playtest the same way. Two
 * namespaces cannot contest a lock they do not share. This is a consequence of the design, not the reason for it — a
 * namespace that only existed to dodge locks would still let a playtest edit live data whenever no lock was held.
 *
 * ## The cost, stated plainly
 *
 * **A playtest's profile is invisible to a live server and vice versa.** A player who tested in Studio and then joins
 * the live game sees their live profile, not the one they were just editing, and neither copy updates the other. That is
 * the intended behaviour and it will still surprise somebody, so it is written down here.
 *
 * **Studio keys are never cleaned up.** They accumulate, they cost storage, and deleting one is a manual operation in
 * the DataStore editor — no key-deletion call exists in this tree, by item 65's rule. Nothing reads them except another
 * Studio session, so the only consequence of leaving them is clutter.
 *
 * ## Why a suffix and not a second DataStore
 *
 * A separate `DataStore` per environment would be the same idea with a bigger blast radius: the store name is baked into
 * every call site that mentions it, while the key is built in exactly one function. A suffix also keeps the Studio and
 * live values visible side by side in the editor, which is what makes "am I looking at test data" answerable at a
 * glance — the question this whole mechanism exists to make answerable.
 */
export const STUDIO_KEY_SUFFIX = "_Dev";

/**
 * The key for one player in one namespace. **The only place a key is built.**
 *
 * Pure, and `studio` is a parameter rather than a call to `RunService`, so the mapping from environment to key can be
 * tested without an environment — which matters because the alternative is asserting it in a playtest by hand.
 *
 * `tostring` rather than template interpolation for the id: the live key must stay **byte-identical** to what earlier
 * builds wrote, and `tostring` on an integer user id is the one form that was already proven against real stored data.
 * A key that formats differently is a key that misses, and a miss is a fresh profile.
 */
export function profileKeyFor(userId: number, studio: boolean): string {
	return KEY_PREFIX + tostring(userId) + (studio ? STUDIO_KEY_SUFFIX : "");
}

/**
 * The key this server should use for `player`.
 *
 * **`RunService.IsStudio()` is read here and nowhere else in the tree.** One read means the namespace cannot be half a
 * namespace — a `loadAsync` that agreed with `release` but not with `saveAsync` would strand a lock on a key nobody
 * reads again. It also means there is exactly one thing to audit when the question is "could anything choose the
 * namespace": the answer is this function, and nothing else in `src/` calls `profileKeyFor` with a computed flag.
 *
 * Note what the predicate does and does not mean: `IsStudio()` reports the *environment*, not the *place's publication
 * state*, so a playtest of a published place is Studio too and gets the `_Dev` key. That is the case this exists for.
 * A live server is the one place it returns false.
 */
function profileKey(player: Player): string {
	return profileKeyFor(player.UserId, RunService.IsStudio());
}

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

	/**
	 * The `PurchaseId`s already granted to this player, newest last, capped at `PURCHASE_HISTORY_CAP`.
	 *
	 * ## Why the profile carries this at all
	 *
	 * `ProcessReceipt` may deliver the same receipt more than once ? a retry after a timeout, or a rejoin while the first
	 * grant was in flight. Without a record, the second delivery grants a second ball, which the player did not pay for
	 * and which cannot be clawed back. The list is the dedupe key.
	 *
	 * ## Why it is part of `Profile` and not a separate store
	 *
	 * Because the record and the grant must be written by the **same** `UpdateAsync` transform. Two keys would mean two
	 * writes, and a crash between them either double-grants (record lost) or eats a purchase (grant lost). One profile,
	 * one write, no window.
	 */
	purchases: Array<string>;
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
	/**
	 * Optional **on disk** even though it is required in `Profile`.
	 *
	 * That asymmetry is the whole migration: every profile written before this round has no such key, and
	 * `readStored` fills the gap with an empty list. Adding a *required* field with a default is a default, not a guess
	 * about what an old value meant, so the "refuse an unknown version, never upgrade" rule (item 51) still holds and
	 * `SCHEMA_VERSION` stays at 1.
	 */
	purchases?: Array<string>;
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
 * Ball ids that were renamed, as `old -> new` pairs.
 *
 * ## Why a read-time table and not a `SCHEMA_VERSION` bump
 *
 * Because a bump would cost every player everything. `readStored` **refuses** any profile whose version is not this
 * build's, and a refused profile puts the session in `readonly`: no coins, no balls, no chest, no round — the same
 * outcome item 64 produced by accident with a key prefix. A rename is not a schema change: the field is still
 * `ownedBalls`, the shape is still `id -> count`, and this mapping is **exact** rather than a guess about what an old
 * field meant. So the version stays at `1` and the old id is translated on the way in.
 *
 * ## What it prevents
 *
 * `ownedBallsFrom` drops any id `BALL_POOL` does not know. Without this table, a rename would leave every existing
 * `split_ball` count sitting in the profile and invisible: not listed in the inventory, not offered by the picker, and
 * nothing anywhere logging that a ball had disappeared. **Silent, permanent and unlogged** — the same three properties
 * that make a key-prefix bump dangerous, and the reason this lives at the one gate every load passes through.
 *
 * A pair list rather than a `Map`: two entries of `[from, to]` are the whole mechanism, it needs no constructor form
 * roblox-ts might compile differently, and the next rename is a row rather than a version.
 *
 * **This is the only place the retired id is written down in `src/`.** A second occurrence is how a rename gets
 * half-applied; if one appears, delete it or move it here.
 */
const BALL_ID_RENAMES: ReadonlyArray<[string, string]> = [
	["split_ball", "decoy_ball"],
	["prism_ball", "recycle_ball"],
];

/** The current id for a stored ball id: the renamed one if there is a row for it, the same id otherwise. */
function migratedBallId(storedBallId: string): string {
	for (const [from, to] of BALL_ID_RENAMES) {
		if (storedBallId === from) {
			return to;
		}
	}

	return storedBallId;
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
	for (const [storedBallId, count] of pairs(rawOwned as Record<string, unknown>)) {
		if (!typeIs(storedBallId, "string") || !typeIs(count, "number")) {
			return undefined;
		}

		// Read through the rename table, so a profile written before the `decoy_ball` rename still owns its balls — see
		// `BALL_ID_RENAMES` for what its absence would cost. The count is **added** to whatever is already under the new
		// id rather than assigned, so a stored table containing both the old and the new id (only reachable from a profile
		// written by two different builds) keeps both grants instead of silently losing one of them.
		const ballId = migratedBallId(storedBallId);
		ownedBalls.set(ballId, (ownedBalls.get(ballId) ?? 0) + count);
	}

	// **Absent is normal.** Every profile written before the Robux chest existed has no `purchases` key; a missing list
	// means "nothing granted yet", which is exactly true. A *malformed* list is not a hard failure either ? treating it
	// as empty costs at most one duplicate grant, while refusing the profile would cost the player their whole account
	// state over a field they never wrote.
	const rawPurchases = (value as { purchases?: unknown }).purchases;
	const purchases = new Array<string>();
	if (rawPurchases !== undefined && typeIs(rawPurchases, "table")) {
		for (const entry of rawPurchases as Array<unknown>) {
			if (typeIs(entry, "string")) {
				purchases.push(entry);
			}
		}
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

	return { profile: { version: SCHEMA_VERSION, coins, ownedBalls, purchases }, lock };
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
		purchases: profile.purchases,
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
	return { version: SCHEMA_VERSION, coins: startingCoins, ownedBalls: new Map(), purchases: [] };
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
		const key = profileKey(player);

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
		const key = profileKey(player);

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
			const key = profileKey(player);

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
						// **Every field has to be restated here, and this one was nearly lost.** The clear is a *rebuild*
						// of the stored value, not a patch of one key, so any field this literal omits is silently
						// erased — releasing the lock would have wiped the purchase history and re-opened the door to a
						// duplicate grant on the player's next purchase.
						purchases: stored.profile.purchases,
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
