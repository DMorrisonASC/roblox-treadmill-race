import { describe, expect, it } from "@rbxts/jest-globals";
import {
	CLICK_SOUND_ASSET_ID,
	COIN_SOUND_ASSET_ID,
	ELIMINATION_SOUND_ASSET_ID,
	HIT_SOUND_ASSET_ID,
	PICKUP_SOUND_ASSET_ID,
	PICKUP_SOUND_MIN_INTERVAL_SECONDS,
	PURCHASE_SOUND_ASSET_ID,
	SOUND_MIN_INTERVAL_SECONDS,
} from "../sounds.config";
import {
	playClickSound,
	playCoinSound,
	playEliminationSound,
	playHitSound,
	playPickupSound,
	playPurchaseSound,
} from "./sounds";

/**
 * Which of the six sounds is throttled, asserted rather than described.
 *
 * ## Why the player is a parameter
 *
 * `playLocally` calls `SoundService.PlayLocalSound`, and there is no way in this runtime to hear whether two calls made
 * two sounds — the asset may not even load in the test place. So each `play*Sound` takes the thing that plays an asset
 * id, defaulting to the real one, and these tests pass a recorder. What is proved is the *policy*: how many plays a
 * sequence of calls produces and which id each one carries. That is exactly the property the round changed, and the
 * property a future "helpful" re-throttle would break.
 *
 * ## Why this is the only file that touches the throttled timestamps
 *
 * `lastPlayedAt` is module state, so the counts below depend on this being the only spec that calls
 * `playEliminationSound`, `playHitSound` or `playPickupSound`, and on the calls within it being in ascending time order.
 * Both hold today. Each throttle is exercised from its own time base — the elimination cases run from 1000, the hit cases
 * from 2000, the independence case from 3000, the pickup cases from 4000 — so no block can be made to pass or fail by the
 * one before it having moved a timestamp.
 */
describe("ui sounds", () => {
	it("plays the click on every call, not once per interval", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// Two presses inside one `SOUND_MIN_INTERVAL_SECONDS` window: both must play. A throttle here is the bug this
		// round removed — a second deliberate press answered with silence.
		playClickSound(record);
		playClickSound(record);

		expect(played.size()).toBe(2);
		expect(played[0]).toBe(CLICK_SOUND_ASSET_ID);
		expect(played[1]).toBe(CLICK_SOUND_ASSET_ID);
	});

	it("plays the purchase confirmation on every call", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// A grant is already gated by `busy` and the server's cooldown, so this path must not add a third rule. Two
		// grants in a row — which the gates make rare rather than impossible — are two confirmations.
		playPurchaseSound(record);
		playPurchaseSound(record);

		expect(played.size()).toBe(2);
		expect(played[0]).toBe(PURCHASE_SOUND_ASSET_ID);
		expect(played[1]).toBe(PURCHASE_SOUND_ASSET_ID);
	});

	it("plays the coin sound on every earn, including two in a row", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// Criterion 7, and the property that separates this sound from the elimination, hit and pickup ones: an earn is a
		// grant that happens once (a round payout, a daily login, a 15-minute stipend), never in a loop, so there is nothing
		// to collapse. Two earns in quick succession — a payout landing in the same second as a stipend, which the schedules
		// make rare rather than impossible — are two events and must be two sounds.
		//
		// Asserted through the same recorder the throttled sounds use, which is also what proves the call reaches the player
		// with the *coin* id rather than a neighbour's: a copy-paste of `playPurchaseSound`'s body would fail here.
		playCoinSound(record);
		playCoinSound(record);

		expect(played.size()).toBe(2);
		expect(played[0]).toBe(COIN_SOUND_ASSET_ID);
		expect(played[1]).toBe(COIN_SOUND_ASSET_ID);
	});

	it("does not put the coin sound in a throttled slot", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// **The regression this exists for is a "helpful" re-throttle.** The coin sound shares its volume row with the pickup
		// and nothing else; giving it an interval later would be invisible in a build and inaudible in a log, and it would
		// swallow the second of two genuine earns. Played eleven times at one fixed instant, an unthrottled player plays
		// eleven times — a throttled one would play once.
		for (let index = 0; index < 11; index++) {
			playCoinSound(record);
		}

		expect(played.size()).toBe(11);
		for (const assetId of played) {
			expect(assetId).toBe(COIN_SOUND_ASSET_ID);
		}

		// And the coin sound never writes `lastPlayedAt`, so it cannot occupy a throttled sound's slot: an elimination
		// immediately afterwards plays on its own schedule.
		//
		// **`999`, deliberately below the elimination block's `1000`.** This spec runs in file order against module state, so a
		// probe at a *later* time would stamp the elimination slot ahead of the block below and make its first call refuse —
		// a test that breaks a neighbour rather than testing anything. Starting under that block's base keeps the two
		// independent, which is the property the file docblock promises.
		playEliminationSound(999, record);
		expect(played.size()).toBe(12);
		expect(played[11]).toBe(ELIMINATION_SOUND_ASSET_ID);
	});

	it("plays the pickup sound once per interval, and again at the boundary", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// **Item 90 shipped this as "two calls, two plays" — this case replaces it, and the reason is a measured bug.** A
		// `recycle` ball resting on its surviving pad re-touches it every 14–24 ms and re-raises its decayed speed on every
		// one, so the server fires per touch and one rest produced nineteen starts. The pickup therefore has its own,
		// shorter interval, and the property worth asserting is the collapse rather than the absence of one.
		playPickupSound(4000, record);
		playPickupSound(4000.01, record);
		playPickupSound(4000.2, record);

		expect(played.size()).toBe(1);
		expect(played[0]).toBe(PICKUP_SOUND_ASSET_ID);

		// Exactly its own interval later, not the shared half second: 0.3 s is the constant this path reads, and a fifth
		// of a second later is still inside it.
		playPickupSound(4000 + PICKUP_SOUND_MIN_INTERVAL_SECONDS, record);
		expect(played.size()).toBe(2);
		expect(played[1]).toBe(PICKUP_SOUND_ASSET_ID);

		// And it is a rate, not a one-shot: the next re-touch inside the window is refused again.
		playPickupSound(4000.35, record);
		expect(played.size()).toBe(2);
	});

	it("keeps the pickup interval shorter than the shared one", () => {
		// Pinned because the whole justification is that a pickup is a reward the player was driving at, and the shared
		// half second would swallow a genuine second collection. A tuning edit that made them equal would pass every other
		// assertion here.
		expect(PICKUP_SOUND_MIN_INTERVAL_SECONDS).toBe(0.3);
		expect(PICKUP_SOUND_MIN_INTERVAL_SECONDS < SOUND_MIN_INTERVAL_SECONDS).toBe(true);
	});

	it("still collapses a burst of eliminations into one start", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// Four bodies leaving in one tick arrive as four calls in one frame. The first plays; the three that follow
		// inside the interval do not.
		playEliminationSound(1000, record);
		playEliminationSound(1000.01, record);
		playEliminationSound(1000.2, record);
		playEliminationSound(1000.4, record);

		expect(played.size()).toBe(1);
		expect(played[0]).toBe(ELIMINATION_SOUND_ASSET_ID);
		expect(SOUND_MIN_INTERVAL_SECONDS).toBe(0.5);

		// Exactly at the interval, the next elimination is audible again — the boundary is `>=`, which is what
		// `sounds.config.spec.ts` pins on the predicate and this pins through the map.
		playEliminationSound(1000.5, record);
		expect(played.size()).toBe(2);

		// And a later burst is one sound again, so the throttle is a rate and not a one-shot.
		playEliminationSound(1000.6, record);
		expect(played.size()).toBe(2);
	});

	it("collapses a burst of hits into one start, and allows the next at the interval", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// Criterion 4, first half: `Touched` re-fires while two bodies stay in contact and the server's cooldown guards
		// the transfer rather than the burst, so two hits in one frame is an ordinary delivery — and one sound.
		playHitSound(2000, record);
		playHitSound(2000.01, record);

		expect(played.size()).toBe(1);
		expect(played[0]).toBe(HIT_SOUND_ASSET_ID);

		// Second half: exactly one interval later the next hit is audible, because the boundary is `>=`. Pinned through
		// the map here as well as on the predicate in `sounds.config.spec.ts`, which is what proves the write happens.
		playHitSound(2000 + SOUND_MIN_INTERVAL_SECONDS, record);
		expect(played.size()).toBe(2);
		expect(played[1]).toBe(HIT_SOUND_ASSET_ID);

		// A crowded frame right after that is one sound again.
		playHitSound(2000.51, record);
		playHitSound(2000.52, record);
		expect(played.size()).toBe(2);
	});

	it("plays a hit even when an elimination sound just played", () => {
		const played = new Array<string>();
		const record = (assetId: string) => played.push(assetId);

		// **The property the hit sound's independence rests on: the map is keyed by asset id, so the two throttles are
		// separate slots.** A body knocked off the belt and two other bodies colliding in the same second is an ordinary
		// moment; if `lastPlayedAt` were keyed by "the last sound that played", the hit below would be swallowed and no
		// build, lint or passing test would show it.
		playEliminationSound(3000, record);
		playHitSound(3000.01, record);

		expect(played.size()).toBe(2);
		expect(played[0]).toBe(ELIMINATION_SOUND_ASSET_ID);
		expect(played[1]).toBe(HIT_SOUND_ASSET_ID);

		// And the other direction: a hit inside its **own** window is still refused (3000.2 is 0.19 s after the last hit),
		// while an elimination at exactly one interval from its own start plays. Two slots, two rules, no interference —
		// which is also what proves the throttle did not simply stop working.
		playHitSound(3000.2, record);
		playEliminationSound(3000 + SOUND_MIN_INTERVAL_SECONDS, record);

		expect(played.size()).toBe(3);
		expect(played[2]).toBe(ELIMINATION_SOUND_ASSET_ID);
	});
});
