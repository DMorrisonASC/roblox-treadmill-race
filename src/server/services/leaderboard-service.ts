import { CollectionService, ReplicatedStorage } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { LEADERBOARD_INTERVAL_SECONDS, LeaderboardEntry } from "shared/leaderboard";
import { LEADERBOARD_UPDATE_REMOTE_NAME, REMOTES_FOLDER_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import { BallSpawnerService } from "./ball-spawner-service";
import { TreadmillService } from "./treadmill-service";
import { RoundService } from "./round-service";

/**
 * **Placeholder.** How many studs ahead a body must be before it takes a rank from the body above it.
 *
 * ## Why a sorted list is not enough on its own
 *
 * Distances here move continuously and by tiny amounts: a body drifts at whatever `BALL_SPEED` decay has left it, so two
 * bodies on the same line of the belt pass each other by hundredths of a stud, cross back, and cross again. A plain sort
 * publishes a new order on almost every tick, and the client animates a swap it has to interrupt half a second later -
 * which is exactly the flicker this threshold exists to remove.
 *
 * Two studs is roughly **two body diameters** and about twenty seconds of drift at the decay rate, so a rank change now means
 * somebody has genuinely taken ground rather than that two numbers swapped order in the third decimal.
 *
 * **`0` disables it** and restores a plain ascending sort, which is useful for testing the comparator.
 */
const SWAP_THRESHOLD_STUDS = 2;

/**
 * Publishes the race standings: who is where, sorted, once a second while a round is `Playing`.
 *
 * ## What it reads, and what it deliberately does not touch
 *
 * The service is **read-only over the world**. It enumerates the bodies `RoundService` already tracks (`getLiveBalls`),
 * keeps the ones carrying an owner identity, measures each one in the belt's own frame, sorts, and fires. It writes no
 * attribute, moves no body, and knows nothing about elimination - so a round cannot behave differently because a HUD is
 * watching it. That is the property that makes it safe to add a leaderboard to a shipped game.
 *
 * ## Why the belt's frame rather than world `X`
 *
 * `PointToObjectSpace` gives the offset from the belt's geometric centre along the belt's own axes. World `X` happens to be
 * the along-belt axis in this scene, but it is a coincidence of how the fixture is placed and rotated: re-CFrame the belt in
 * Studio and a world-`X` leaderboard would rank bodies by an axis the belt no longer lies on. The frame costs one transform
 * per body per half second and survives the fixture moving.
 *
 * ## Why the spawn end is the lead, and why ascending sorts it that way
 *
 * This is a **last-one-standing race on a treadmill**, and the elimination edge is at code-frame `+X`. A body therefore
 * leaves the race with the *largest* distance from the spawn edge, and the body holding its ground has the *smallest* -
 * so ranking ascending puts the safest racer first. A body that has drifted ten studs toward the exit is ten studs closer
 * to being gone, not ten studs ahead; the drift is `BALL_SPEED` decaying below the belt reference, and the only thing that
 * reverses it is a pickup.
 *
 * That is the opposite of how a foot race reads, which is exactly why this paragraph exists: a leaderboard sorted by
 * "distance travelled" looks correct and puts the loser in first place.
 *
 * ## Why a loop rather than a `Heartbeat` connection
 *
 * A 2 Hz poll wants a timer, not a per-frame callback with a guard. `task.wait` in a spawned thread is exact enough for a
 * HUD, costs nothing between ticks, and cannot be forgotten by a phase transition - the loop asks the round what phase it
 * is in and skips the broadcast otherwise.
 */
@Service()
export class LeaderboardService implements OnStart {
	private remote?: RemoteEvent;

	/**
	 * The ids of the last published order, leader first. **The half of the hysteresis that lives on the server.**
	 *
	 * A threshold alone does not stabilise a sort: comparing two bodies pairwise needs to know which of them currently holds
	 * the rank, and a comparator cannot answer that - a sort asks "which of these two is first" with no memory of the answer
	 * it gave last time. Keeping the previous order and repairing it (see `rank`) is what makes the comparison
	 * order-dependent, and it is why this list exists at all.
	 *
	 * Cleared whenever the phase leaves `Playing`: the ids are user ids, and the next round reuses them for different
	 * bodies, so a stale rank would be a claim about a body that no longer exists.
	 */
	private previousRanked = new Array<string>();

	/**
	 * A stable, unique key per body: `B1`, `B2`, ...
	 *
	 * **`GetFullName()` is not unique, and that was the single-row bug.** Every ball is a sibling called `Ball` under
	 * `Workspace.SpawnedBalls`, so all of them report the *same* full name. The client keys its rows by this string, so
	 * seventeen bodies collapsed into one row and each broadcast overwrote it with whichever body happened to be last in the
	 * map. A counter is the only thing here guaranteed distinct, and it is assigned once per body so a rank change never
	 * looks like a different racer.
	 */
	private readonly bodyKeys = new Map<BasePart, string>();
	private nextBodyKey = 1;

	public constructor(
		private readonly round: RoundService,
		private readonly treadmill: TreadmillService,
		private readonly spawner: BallSpawnerService,
	) {}

	public onStart(): void {
		this.remote = this.createRemote();
		task.spawn(() => this.loop());
	}

	/** The publish loop. Runs for the life of the server; every iteration either broadcasts or explains nothing. */
	private loop(): void {
		while (true) {
			task.wait(LEADERBOARD_INTERVAL_SECONDS);

			// **No race, no standings.** Firing an empty array would be a second way to say "not playing", and a client that
			// happened to receive it after a phase read would index a list it had already hidden.
			if (this.round.getPhase() !== "Playing") {
				this.previousRanked = [];
				// Per-round, like the ranking: the numbers restart so a new round's rows are not renumbered by the last one's
				// leftovers, and a body from a finished round cannot hold a key.
				this.bodyKeys.clear();
				this.nextBodyKey = 1;
				continue;
			}

			// **A tick that throws must not take the publisher with it.** The first version of this loop died on its first
			// `Playing` tick - an index error inside the ranking pass - and because the loop lives in a `task.spawn` thread,
			// the thread ended and the HUD stayed empty for the rest of the session with one line of output to explain it.
			// The hook is a HUD: one bad frame should cost one broadcast, not the feature.
			const [ok, result] = pcall(() => this.collect());
			if (!ok) {
				warn(`[Leaderboard] tick failed, retrying next interval: ${tostring(result)}`);
				continue;
			}

			if (result.size() === 0) {
				continue;
			}

			const remote = this.remote;
			if (remote !== undefined) {
				remote.FireAllClients(result);
			}
		}
	}

	/**
	 * **Every live body**, measured and ranked - not just the ones with owners.
	 *
	 * ## Why "any ball" and not "any player"
	 *
	 * The first version filtered to bodies carrying an owner identity, on the theory that only those compete. That is true of
	 * the *winner rule* and wrong for a HUD: it meant a solo playtest with no bots showed an empty board, and it excluded
	 * exactly the bodies a designer adds while testing. Every tagged body on the belt is something the player can see moving,
	 * so every tagged body gets a row; the ones with an owner are named after the owner, and the rest fall back to their own
	 * instance name.
	 *
	 * The winner rule is still `RoundService`'s business and this service does not touch it - an ownerless decoy twin can
	 * appear in the standings and still not be a competitor. That is the same asymmetry the `decoy` power is built on.
	 */
	private collect(): Array<LeaderboardEntry> {
		const belt = this.beltGeometry();
		const entries = new Array<LeaderboardEntry>();

		for (const ball of this.round.getLiveBalls()) {
			if (ball.Parent === undefined) {
				continue;
			}

			// **The spawner answers "who does this body represent", not "what is on this body".** A `decoy` twin carries no
			// owner attributes at all - it would be a competitor if it did - so reading them here published it as `Decoy 12`
			// and told every player which body was the fake. `ownerIdentityFor` follows the twin back to its parent, so the
			// standings show two bodies with the player's own name and nothing distinguishes them.
			//
			// **This does not touch the winner rule.** `RoundService` decides who competes from the *attribute on the body*;
			// this is a display question and it writes nothing. A twin reporting its parent's identity here is still an
			// ownerless body everywhere the simulation looks.
			const identity = this.spawner.ownerIdentityFor(ball);

			// **Studs from the belt's spawn edge**, in the belt's own frame: `0` at the edge a body is placed on, growing
			// toward the exit. Measured from the *belt* rather than from the spawner so the number survives the spawner being
			// moved in Studio, and so every body is measured against one origin instead of its own birth point.
			const localX = belt.frame.PointToObjectSpace(ball.Position).X;
			const key = this.keyFor(ball);
			entries.push({
				key,
				userId: identity === undefined ? 0 : identity.userId,
				// `identity.name` for a player's body **and for their twin**, which is the point: the two rows must be
				// indistinguishable. A body with no owner at all - a debug ball, a stray, an orphaned twin - still carries its
				// key in its name, because there can be fifty of them and they are all called `Ball` or `Decoy`.
				name: identity === undefined ? `${ball.Name} ${key.sub(2)}` : identity.name,
				distance: localX + belt.halfLength,
			});
		}

		// The ranking pass. **No cap**: the board shows every body on the belt, which is what a player watching the race can
		// actually see - at seventeen bodies a five-row window hid the racers being watched. The client scrolls, and the
		// payload is at most `MaxLiveBalls` entries of four small fields.
		const ranked = this.rank(entries);
		this.previousRanked = this.idsOf(ranked);
		return ranked;
	}

	/**
	 * The published order: the previous ranking, repaired, rather than a fresh sort.
	 *
	 * ## The algorithm, and why it is a repair
	 *
	 * 1. Start from `previousRanked`, keeping the bodies that are still in the race. That list *is* the current held order -
	 *    nobody has lost or gained anything since it was published, as far as anybody watching is concerned.
	 * 2. Append the bodies that were not in it, at the bottom. A newcomer has no rank to defend, so it starts last and has
	 *    to earn its place like everybody else.
	 * 3. Bubble it: swap two neighbours **only when the one below is at least `SWAP_THRESHOLD_STUDS` ahead of the one above**.
	 *    Repeat while anything swapped. The loop terminates because every swap removes an inversion and a finite list has
	 *    finitely many.
	 *
	 * ## Why a comparator cannot do this
	 *
	 * `Array.sort` asks "which of these two comes first" and expects an answer that depends only on the pair. Hysteresis is
	 * not that: the answer depends on **who currently holds the rank**, which is state the comparator does not have and must
	 * not have - a comparator that consulted it would be non-transitive and could make the sort produce nonsense or never
	 * finish. Repairing a known-good order is the way to express "keep what you have unless the challenger is clearly
	 * better", and it is the same shape as insertion sort on nearly-sorted data: almost no work per tick.
	 *
	 * ## Ascending is still the base relation
	 *
	 * Smaller distance from the spawn edge is safer, so a body may only move **up** by being smaller by the threshold. With
	 * `SWAP_THRESHOLD_STUDS = 0` the bubble pass is a plain ascending sort, just a slow one - which is exactly the behaviour
	 * to compare against when the threshold is being tuned.
	 */
	private rank(entries: Array<LeaderboardEntry>): Array<LeaderboardEntry> {
		const byKey = new Map<string, LeaderboardEntry>();
		for (const entry of entries) {
			byKey.set(entry.key, entry);
		}

		const ordered = new Array<LeaderboardEntry>();
		const placed = new Set<string>();

		for (const key of this.previousRanked) {
			const entry = byKey.get(key);
			if (entry !== undefined && !placed.has(key)) {
				ordered.push(entry);
				placed.add(key);
			}
		}

		for (const entry of entries) {
			if (!placed.has(entry.key)) {
				ordered.push(entry);
				placed.add(entry.key);
			}
		}

		// **A single body short-circuits, and this is not an optimisation.** roblox-ts lowers
		// `for (let i = 0; i + 1 < n; i++)` to `for i = 0, n - 1`, which runs one iteration too many when `n` is small - with
		// one entry it ran once and indexed `ordered[2]`, which is `nil`, and the loop thread died on its first `Playing`
		// tick. The bound is therefore spelled out in a local and the degenerate case returns early, so the lowering has
		// nothing to get wrong.
		if (ordered.size() < 2) {
			return ordered;
		}

		const lastIndex = ordered.size() - 1;
		let swapped = true;
		while (swapped) {
			swapped = false;
			for (let index = 0; index < lastIndex; index++) {
				const ahead = ordered[index];
				const behind = ordered[index + 1];
				// `>=` rather than `>`: a swap exactly at the threshold is the first one the player can see, and including it
				// makes the constant mean "the gap at which a rank changes" rather than "one stud more than that".
				if (behind.distance + SWAP_THRESHOLD_STUDS <= ahead.distance) {
					ordered[index] = behind;
					ordered[index + 1] = ahead;
					swapped = true;
				}
			}
		}

		return ordered;
	}

	/** `B1`, `B2`, ... - assigned once per body, so the client's row identity survives a rank change. */
	private keyFor(ball: BasePart): string {
		const existing = this.bodyKeys.get(ball);
		if (existing !== undefined) {
			return existing;
		}

		const key = `B${this.nextBodyKey}`;
		this.nextBodyKey++;
		this.bodyKeys.set(ball, key);
		return key;
	}

	/** The keys of an order, for `previousRanked`. */
	private idsOf(entries: Array<LeaderboardEntry>): Array<string> {
		const keys = new Array<string>();
		for (const entry of entries) {
			keys.push(entry.key);
		}
		return keys;
	}

	/**
	 * The belt's frame and its half-length, or a neutral pair when no belt is tagged.
	 *
	 * The **half-length is needed as well as the frame**: `PointToObjectSpace` measures from the belt's *geometric centre*,
	 * and the number this service publishes is measured from the belt's **spawn edge**, so the centre offset has to be added
	 * back. Reading it from the part's `Size` rather than hard-coding `28` means a longer or shorter belt keeps the origin at
	 * the edge it actually has.
	 *
	 * The fallback is the identity frame with half-length `0`, so a server with no belt yet degrades to world coordinates
	 * and a coherent ordering rather than to every body at the origin.
	 */
	private beltGeometry(): { frame: CFrame; halfLength: number } {
		const frame = this.treadmill.getBeltFrame();
		if (frame !== undefined) {
			const belt = this.beltPart();
			return { frame, halfLength: belt === undefined ? 0 : belt.Size.X / 2 };
		}

		const belt = this.beltPart();
		if (belt !== undefined) {
			return { frame: belt.CFrame, halfLength: belt.Size.X / 2 };
		}

		return { frame: new CFrame(), halfLength: 0 };
	}

	/** The tagged belt, if one exists. Only read for its `Size.X`; the frame itself comes from `TreadmillService` when it can. */
	private beltPart(): BasePart | undefined {
		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance;
			}
		}

		return undefined;
	}

	/**
	 * Creates the broadcast remote, in the shared `Remotes` folder.
	 *
	 * The folder is created on demand with the same three lines every service in this tree uses: whichever service starts
	 * first makes it, and no service owns it. That is why this does not reach into `RoundService` for a handle - the cost is
	 * one `FindFirstChild` at boot, and the alternative is a dependency edge for a folder.
	 */
	private createRemote(): RemoteEvent {
		let folder = ReplicatedStorage.FindFirstChild(REMOTES_FOLDER_NAME);
		if (folder === undefined || !folder.IsA("Folder")) {
			const created = new Instance("Folder");
			created.Name = REMOTES_FOLDER_NAME;
			created.Parent = ReplicatedStorage;
			folder = created;
		}

		const remote = new Instance("RemoteEvent");
		remote.Name = LEADERBOARD_UPDATE_REMOTE_NAME;
		remote.Parent = folder;
		return remote;
	}
}
