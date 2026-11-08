import { SoundService } from "@rbxts/services";
import {
	canPlay,
	CLICK_SOUND_ASSET_ID,
	COIN_SOUND_ASSET_ID,
	ELIMINATION_SOUND_ASSET_ID,
	HIT_SOUND_ASSET_ID,
	PICKUP_SOUND_ASSET_ID,
	PICKUP_SOUND_MIN_INTERVAL_SECONDS,
	PURCHASE_SOUND_ASSET_ID,
	soundTuningFor,
	soundUri,
} from "shared/sounds.config";

/**
 * The six UI sounds, played on the local client — and the throttle that guards three of them.
 *
 * ## Why this lives beside `press.ts` rather than under `src/client/`
 *
 * The buttons this has to cover are not all built in `src/client/`. `TabStrip` builds one button per tab, `PanelHeader`
 * builds the close button and `Tile` builds a tile — three builders in this folder — and `attachPressFeedback` already
 * lives here for exactly the same reason: it is called from those builders *and* from the controllers, and a helper only
 * the controllers can reach would leave the tab strip and the sheet's close button silent. The brief for this round
 * predicted that those two would be missed; the way not to miss them is to make the helper reachable from the code that
 * creates them.
 *
 * **Nothing under `src/server/` imports `shared/ui/`**, and `SoundService.PlayLocalSound` is a client method
 * (*"Plays a copy of a Sound locally, such that it will only be heard by the client calling this method"*). A server
 * module importing this file would therefore be a bug in the layering rather than a sound played twice.
 *
 * ## Why one `Sound` per id, reused
 *
 * `PlayLocalSound` copies the instance it is given, so the instance only has to exist and carry the right `SoundId`. One
 * per id, created on first use and kept, means five `Sound` instances for the session and no per-press garbage: a
 * `Sound` created per press would leak an instance per click, and the click is the one that fires most.
 *
 * **The same reuse is why the playback values are written there and nowhere else.** `Volume` and `PlaybackSpeed` come from
 * `SOUND_TUNING` in `shared/sounds.config.ts` and are applied when the instance is built; a write on every play could not
 * change either value and would only suggest that it might.
 *
 * Created lazily rather than at module load because a client that never reaches a button, a purchase or an elimination
 * — the loading screen, or a session that fails before `Remotes` exists — has no reason to own five audio instances.
 *
 * ## Only the elimination, hit and pickup sounds are throttled, and this is why
 *
 * The previous version of this file put every sound behind one throttle. That was wrong for two of the three, and the
 * distinction is worth stating because it is the first thing a reader will question:
 *
 *  - **Elimination is throttled because it fires in a loop.** `settleEliminations` walks the live set and destroys every
 *    body that has left the zone, so four eliminations in one tick are four remote signals in one frame. Four restarts of
 *    one clip in one frame does not sound like four eliminations; it sounds like a stutter, or like one clipped transient.
 *    `canPlay` + `lastPlayedAt` collapse the burst into one start. Since item 87 the signal is **targeted** at the one
 *    player whose ball landed the last touch, which narrows *who* hears a burst but not *whether* one client can receive
 *    several signals in one frame: a body knocked off the belt takes the bodies behind it with it, so the same attacker is
 *    routinely credited for more than one elimination in a pass. The throttle is still the thing that makes that one sound.
 *  - **The hit sound is throttled for the same shape, not for the same event.** Two bodies in contact re-fire `Touched`
 *    on essentially every physics step, so a single pair in contact is already a burst before anyone joins in, and a
 *    crowded belt is many pairs at once — the server's `POWER_COLLISION_COOLDOWN` guards the *transfer*, not the sound,
 *    and the hit effect's own burst is deliberately allowed on every transfer. Left unthrottled this would be a machine
 *    gun; the rule it needs is exactly the elimination sound's, so it is the same `canPlay` against the same interval.
 *  - **The click is not throttled, because one activation is one press.** A player who presses twice in half a second is
 *    making two deliberate presses — two cards, a re-roll then a card, a chest then the close button. A throttle there
 *    does not prevent a repeat, it swallows the second press, and a button that does not answer reads as broken rather
 *    than as guarded. The half second is a limit on *the same clip restarting itself*, not on the player.
 *  - **The purchase sound is not throttled, because a grant is already gated twice.** A second chest press is refused by
 *    this client's `busy` flag before it leaves the machine, and again by `EconomyService`'s
 *    `ECONOMY_ACTION_COOLDOWN_MS` if it somehow did. A throttle on top of two refusals can never fire, so it is not a
 *    safeguard — it is a third rule that would only matter on the day one of the first two was removed, and on that day it
 *    would hide the second purchase instead of reporting the missing gate.
 *  - **The pickup sound is throttled at a shorter interval than the rest, and it got there by measurement.** Item 90 left
 *    it unthrottled because the server fires only when `speedAfterPickup` raised the ball's speed, so the one repeated
 *    case — a `recycle` ball resting on its own surviving pad — was supposed to compute the value the ball already had and
 *    fire nothing. It does not: the tick loop decays `BALL_SPEED` between touches, so each re-touch raises `11.987` to
 *    `12` and passes the condition. A Studio log (item 91) shows nineteen collections in a single rest, 14–24 ms apart,
 *    which is the buzz a player hears as a fault. `PICKUP_SOUND_MIN_INTERVAL_SECONDS` (0.3 s) collapses that to at most
 *    three starts a second. **The general lesson, which is why it is written here and not only beside the constant: a
 *    condition that rules out "nothing happened" does not rule out "the same thing happened again".**
 *  - **The coin sound is not throttled, and it is the newest row in this list.** An earn is one grant per round per player
 *    (the payout remote, fired once from `endPlaying`) or one per schedule (20 hours, 15 minutes), so there is no burst to
 *    collapse — it is the purchase sound's shape, not the elimination sound's. `playCoinSound` carries the full argument,
 *    including the two writers that deliberately do not call it.
 *
 * `lastPlayedAt` is keyed by **asset id**, and every sound that has needed a throttle since has been a data change rather
 * than a refactor: the hit sound (item 88) and the pickup sound (item 91) are two more entries, and neither shares the
 * elimination sound's slot because each is a different key. A single "when did anything last play" number would have made
 * a hit inside half a second of an elimination silent — a body leaving the belt and two others colliding in the same
 * second is an ordinary moment in this game, not an edge case.
 *
 * `os.clock()` rather than `time()`: it is monotonic and unaffected by the server's clock, and this is the same clock
 * the round service and the spawner already timestamp with. A wall clock that stepped backwards would make
 * `now - lastPlayedAt` negative and suppress a sound that should play.
 *
 * ## The `play` parameter
 *
 * Each player takes the thing that actually plays an asset id, defaulting to `playLocally`. That is the seam the specs use
 * to count plays without an audio device in the test place — the same shape `drawTimers` uses for its random source —
 * and it is why "two presses, two clicks" is an executable assertion rather than a comment.
 */

/** The one `Sound` instance per asset id, created on first use. */
const sounds = new Map<string, Sound>();

/**
 * When each sound last *started*, keyed by asset id. The map `canPlay` is asked about; nothing else writes to it.
 *
 * Three entries are ever present today — the elimination, hit and pickup ids — and the key is what keeps them apart. The
 * click, the purchase and the coin sound never write here at all, which is what "unthrottled" means in this file: not an
 * interval of zero, but no read and no write.
 */
const lastPlayedAt = new Map<string, number>();

/**
 * **The only place a `Sound` is constructed and tuned** — and it does not cache.
 *
 * ## Why this was split out of `soundFor`
 *
 * It used to be `soundFor` in full: create, tune, parent, remember. That is the right shape for a sound played through
 * `PlayLocalSound`, which **copies** the instance it is handed and leaves the original alone — one instance per asset id,
 * for the session, and nothing to go wrong.
 *
 * The round song is the first sound in this tree that is **owned**: it is started, its `Volume` is animated, its
 * `TimePosition` is moved, and it is destroyed at the end of the phase. Destroying a cached instance would leave a dead
 * entry behind for the next round, and mutating its `Volume` would change what the next `PlayLocalSound` copy starts at.
 * So the construction is its own function and the cache is a second, small decision layered on top of it. **The rule
 * "one construction site" is preserved rather than relaxed**: `soundFor` calls this, and `shared/ui/song` calls this, and
 * nothing else builds a `Sound` at all — the id → `SoundId` → tuning path exists once.
 *
 * The returned instance is parented and tuned to the `SOUND_TUNING` row, so a caller's first act is usually to zero its
 * `Volume` and ramp it back up — which is exactly what the song does.
 */
export function buildSound(assetId: string): Sound {
	const sound = new Instance("Sound");
	sound.Name = `UiSound_${assetId}`;
	sound.SoundId = soundUri(assetId);

	// **Both playback values are set here, once, at construction.** The instance is cached and reused for the session, so
	// writing them per play could not change anything and would only claim the values are allowed to vary per play — they
	// are not; they are config, and config is read where the thing is built. A play that needs different numbers is a
	// later round with a named reason, not a second writer here.
	//
	// The song reuses that: it reads this value back as its fade **target** rather than hard-coding one, so the tuning row
	// stays the single knob and the fade cannot disagree with it.
	const tuning = soundTuningFor(assetId);
	sound.Volume = tuning.volume;
	sound.PlaybackSpeed = tuning.playbackSpeed;

	// `SoundService` is the conventional parent for a non-positional sound: it is nowhere in the world, so it has no
	// rolloff to apply. The instance is created on this client, so it is this client's instance and never one the server
	// sent.
	sound.Parent = SoundService;
	return sound;
}

/** The cached `Sound` for an asset id, built on first use. The `PlayLocalSound` path's instance, and only its. */
function soundFor(assetId: string): Sound {
	const existing = sounds.get(assetId);
	if (existing !== undefined) {
		return existing;
	}

	const sound = buildSound(assetId);
	sounds.set(assetId, sound);
	return sound;
}

/**
 * Plays one sound on this client. The default player, and the only code in the tree that calls `PlayLocalSound`.
 *
 * `PlayLocalSound` copies the instance it is given, so the per-id `Sound` above only has to exist and carry the right
 * `SoundId`. It cannot fail in a way this code can observe, which is why the elimination path can stamp its timestamp
 * before calling it.
 */
function playLocally(assetId: string): void {
	SoundService.PlayLocalSound(soundFor(assetId));
}

/** What actually plays an asset id. Swapped only by specs; every production call takes the default. */
type SoundPlayer = (assetId: string) => void;

/**
 * The click, for one `GuiButton` activation — **not throttled**. See the file docblock for why: one activation is one
 * press, and a swallowed second press is a button that looks broken. No `canPlay`, no timestamp.
 */
export function playClickSound(play: SoundPlayer = playLocally): void {
	play(CLICK_SOUND_ASSET_ID);
}

/**
 * The purchase confirmation, fired from a server reply, never from the press that started the purchase — **not
 * throttled**, because `busy` and the server's cooldown already refuse a second purchase before it can reach here.
 */
export function playPurchaseSound(play: SoundPlayer = playLocally): void {
	play(PURCHASE_SOUND_ASSET_ID);
}

/**
 * Coins arrived in this player's balance — **not throttled**, because an earn is one deliberate grant rather than a stream.
 *
 * ## The two callers, and why neither can arrive in a burst
 *
 *  - `payout-controller`, on a `RoundPayout` payload. The server fires that from `RoundService.payOut`, which runs once from
 *    `endPlaying`, which itself returns immediately unless the phase is `Playing` — so it is **one grant per round per
 *    player**, not one per body or one per tick.
 *  - `reward-toast-controller`, on a `RewardToast` payload. Behind it are the daily login (a 20-hour cooldown) and the
 *    playtime stipend (15 minutes), and item 134's `playtimeBaselineAtLoad` moves a stale stamp **forward** at load rather
 *    than paying it — so the stipend is never due in the second the daily pays. That is the double *sound* the double
 *    *grant* fix also removed, and it is worth naming because two coin sounds in one frame read as one louder sound with
 *    nothing to say which event it belonged to.
 *
 * **Two earns *can* genuinely coincide, and both play.** The stipend tick does not look at the round phase, so a stipend
 * can land in the second a payout fires — roughly one round in nine hundred at these numbers. That is not the failure above:
 * two real grants are two events, and the whole point of an unthrottled player is that it does not decide for the player
 * which of their earnings to hear.
 *
 * This is the purchase sound's shape (item 83), not the elimination sound's: a grant happens once, so `canPlay` here would
 * be a third gate behind schedules that are already the gate — and on the day one of those schedules changed, a throttle
 * would *hide* the double grant instead of letting it be heard.
 *
 * ## Why it is called from the controllers rather than from a remote of its own
 *
 * The wire already carries both events: `RoundPayout` (item 132) and `RewardToast` (item 134), each a **targeted**
 * `FireClient` to the one player who earned the coins. One event, two effects — the shape item 88 used to hang the hit
 * sound on the hit-effect burst. A `CoinSound` remote would be a third channel for a fact the client has already been
 * told, and it would need its own payload and its own validation.
 *
 * ## Why it takes no `now`
 *
 * Nothing here reads the clock: there is no interval to compare against, so a `now` parameter would be a value passed and
 * discarded. `playClickSound` and `playPurchaseSound` — the other two unthrottled players — have the same signature for
 * the same reason; the throttled three take `now` because they stamp it.
 *
 * ## What deliberately does not call it
 *
 *  - **The Studio daily-login preview.** Item 135 fires the toast on every playtest and grants nothing; a coin sound there
 *    would be a sound for money that did not move. The toast payload carries `preview` for exactly this, and the controller
 *    still draws the card — the panel is what a playtest is looking at.
 *  - **`/dev setCoins`.** It is an admin verb rather than an earn, it can also *lower* a balance, and it has no client
 *    signal by design (item 65): a remote whose only job is to tell a client an admin changed its coins would be a new
 *    channel opened for a debug path. The shop's coin pill still moves, which is the visible feedback an admin needs.
 *  - **A new profile's `STARTING_COINS`.** The balance exists before the client has a HUD, and there is nothing to react to.
 */
export function playCoinSound(play: SoundPlayer = playLocally): void {
	play(COIN_SOUND_ASSET_ID);
}

/**
 * A ball gained speed from a pickup, on every client — **throttled at `PICKUP_SOUND_MIN_INTERVAL_SECONDS` (0.3 s)**.
 *
 * ## Why this one is throttled and the click is not
 *
 * Item 90 shipped this unthrottled on the argument that the server only fires when the ball's speed actually rose, so the
 * one repeated case — a `recycle` ball resting on its own surviving pad — would compute the value the ball already had
 * and fire nothing. **A Studio log falsified that, and it is worth keeping the falsification here because the argument
 * looked airtight:** `BALL_SPEED` decays between touches, so the pad raises `11.987` back to `12` on every re-touch, the
 * condition passes every time, and one rest produced nineteen collections 14–24 ms apart. Nineteen starts of one clip in
 * two tenths of a second is not nineteen pickups; it is the buzz that was reported as "a weird sound".
 *
 * A server condition and a client interval answer different questions. The condition says "something happened"; the
 * interval says "the same thing may not start again yet". Only the second one can turn a rest into one sound.
 *
 * ## Why 0.3 and not the shared half second
 *
 * The shared interval is tuned for events that arrive in bursts the player did not cause (a batch of eliminations, a
 * scrum of hits). A pickup is a reward the player was driving at, and two collections half a second apart are two real
 * events; swallowing one would make the game feel less responsive than the buzz does. `0.3` still cuts the re-touch rate
 * by a factor of fifteen, which is the whole of the fix.
 *
 * `now` is a parameter for the same reason it is on the other two throttled sounds: the boundary at exactly the interval
 * is worth an assertion, and a spec cannot wait a third of a second to make one.
 */
export function playPickupSound(now: number = os.clock(), play: SoundPlayer = playLocally): void {
	if (!canPlay(lastPlayedAt.get(PICKUP_SOUND_ASSET_ID), now, PICKUP_SOUND_MIN_INTERVAL_SECONDS)) {
		return;
	}

	lastPlayedAt.set(PICKUP_SOUND_ASSET_ID, now);
	play(PICKUP_SOUND_ASSET_ID);
}

/**
 * A body left the round after this client's ball touched it, heard **only by that client** — the one throttled path.
 *
 * The server sends one signal per elimination it attributes to this player, so a `settleEliminations` pass that took out
 * several bodies on this player's account arrives as several events in one frame. This is the only place that knows when
 * this client last started the clip, which is the rule the throttle is actually about: not "may the field eliminate
 * twice", but "may one clip restart itself".
 *
 * The timestamp is written **before** the play, not after: `playLocally` is a single call that cannot fail in a way
 * this code can observe, and stamping first means a second event in the same frame is refused rather than racing a
 * write that has not landed yet.
 *
 * `now` is a parameter for the same reason `play` is: the boundary at exactly `SOUND_MIN_INTERVAL_SECONDS` is worth an
 * assertion, and a test cannot wait half a real second to make one.
 */
export function playEliminationSound(now: number = os.clock(), play: SoundPlayer = playLocally): void {
	if (!canPlay(lastPlayedAt.get(ELIMINATION_SOUND_ASSET_ID), now)) {
		return;
	}

	lastPlayedAt.set(ELIMINATION_SOUND_ASSET_ID, now);
	play(ELIMINATION_SOUND_ASSET_ID);
}

/**
 * Two balls hit, on the client that was told about it — **throttled, and independently of the elimination sound**.
 *
 * The event is `Remotes.HitEffect`, one fire per contact the server considered worth a burst. `Touched` re-fires on
 * essentially every physics step while two bodies stay in contact, and the server's `POWER_COLLISION_COOLDOWN` gates the
 * *transfer* rather than the burst, so the events arrive in bursts — a crowded belt can deliver several in one frame from
 * several different pairs. One sound per event would be a machine gun. This is the same collapse the elimination path
 * does, with the same predicate and the same interval, because it is the same problem.
 *
 * **Independent because the key is the asset id, not "the last sound".** A hit inside half a second of an elimination is
 * a different entry in `lastPlayedAt`, so it plays — which matters, because a body being knocked off the belt and two
 * other bodies colliding in the same second is an ordinary moment. `src/shared/ui/sounds.spec.ts` asserts this rather
 * than leaving it to the map's shape.
 *
 * The timestamp is written **before** the play, for the reason the elimination sound states: `playLocally` is a single
 * call that cannot fail observably, and stamping first means a second event in the same frame is refused instead of
 * racing a write that has not landed.
 *
 * `now` and `play` are parameters for the same testing reason — the boundary at exactly `SOUND_MIN_INTERVAL_SECONDS` is
 * worth an assertion, and a spec cannot wait half a real second to make one.
 */
export function playHitSound(now: number = os.clock(), play: SoundPlayer = playLocally): void {
	if (!canPlay(lastPlayedAt.get(HIT_SOUND_ASSET_ID), now)) {
		return;
	}

	lastPlayedAt.set(HIT_SOUND_ASSET_ID, now);
	play(HIT_SOUND_ASSET_ID);
}

/**
 * Plays the click on every activation of a button.
 *
 * ## Why `Activated` and not `MouseButton1Click`
 *
 * `Activated` also fires for a gamepad or keyboard activation, which is the same gesture from the player's point of
 * view — "I pressed this". `MouseButton1Click` would leave a controller user with silent buttons.
 *
 * ## Why an inactive button is silent
 *
 * This tree disables buttons with `button.Active = false` — the fusion button while nothing is selected, the chest
 * buttons when the player cannot afford the batch, the premium buttons while a prompt is open — and `Active` is
 * documented in the typings only as *"Determines whether this UI element sinks input"*. Whether `Activated` still fires
 * on an inactive button is therefore not something the typings answer, and it differs by configuration. The check below
 * makes the intent explicit and costs one property read: a button that cannot be pressed does not sound like it was.
 *
 * ## No throttle on this path
 *
 * One activation is one press, so every activation plays — the file docblock explains why swallowing the second of two
 * quick presses is the worse failure. `playClickSound` is the one-line seam the specs assert that property against.
 *
 * ## Called once per constructed button
 *
 * There is no idempotence guard, for the same reason `attachPressFeedback` has none: every call site constructs the
 * button on the line above. A guard would need its own cleanup story — the shop rebuilds its cards on every refresh, so
 * a `Set` of buttons would grow for the whole session.
 */
export function attachClickSound(button: GuiButton): void {
	button.Activated.Connect(() => {
		if (!button.Active) {
			return;
		}

		playClickSound();
	});
}
