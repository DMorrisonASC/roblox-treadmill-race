/**
 * The ball -> power table: one power per ball id, fixed — and the only place a power's numbers are written down.
 *
 * ## Why this is shared and not server-only
 *
 * The server acts on every entry; the client prints one. A badge that floats above a ball names the power, and a future
 * store row will want the same word — so the label and the magnitudes live where both sides can reach them. A second copy
 * of "how much does a bully steal" would let the badge describe a rule the server is not running, which is the same
 * class of lie `economy.config.ts` exists to prevent.
 *
 * ## The constraint every power below is written against
 *
 * `BallSpawnerService.stepBallSpeeds` rewrites the along-belt component from `BALL_SPEED`, sets the decorative lateral Z,
 * and leaves Y to gravity. The `BALL_SPEED` model does not read contact friction or mass; the physics solver does. Anything
 * written to X or Z by a power is overwritten within one frame, while the contact pop explicitly changes only Y. A power is
 * therefore one of:
 *
 * 1. a **delta to `BALL_SPEED`** returned to the tick loop, which stays the single writer per tick;
 * 2. a **direct write to `BALL_SPEED`** from a collision handler, which is safe only because nothing writes between two
 *    ticks — a force applied here would be gone before it did anything;
 * 3. a **Y-only contact pop**, outside the scalar speed model and overwritten by neither its X rewrite nor the Z sway;
 * 4. a change to the **body itself** (physical properties, a collision group, a spawned decoy, a badge) that the model cannot
 *    overwrite.
 *
 * ## The exchange rate the magnitudes are chosen against
 *
 * `BALL_SPEED` decays at `BALL_SPEED_DECAY_RATE` = 2 per second, so **one point of `BALL_SPEED` is about half a second of
 * ride**. Transfer magnitudes below are reported against that: "steals 1.0" means "steals giving up ten seconds"; pop
 * chances are probabilities, not ride-time values.
 *
 * ## Design notes — recorded, not enforced
 *
 * The designer's rules, quoted, so a later round does not have to guess whether a stacking power was an oversight:
 *
 * > A ball cannot be both faster and teleporting. Advantage of *kind* should not stack — a ball that wins on speed and
 * > also on position has no situation where it is the wrong pick.
 *
 * > Rarity is not an ordering. Some less rare balls are better in certain situations, and that is the point.
 *
 * > Balance is the designer's to tune. The agent reports magnitudes; it does not cap them.
 *
 * Nothing in this file enforces any of that. `BALL_SPEED_MAX` in `tuning.ts` is a safety net against unbounded
 * accumulation, not a balance guard. It does **not** sit above every value a power asks for: `ROCKET_TARGET_SPEED` is
 * `130` against a maximum of `100`, so a rocket snap is clamped to `100` (item 204). That is the clamp working, not a
 * bug - but a reader tuning a power needs to know the ceiling is live.
 *
 * Every number here is **Placeholder.** — the shape is the point, the numbers are not.
 */

import { BOOST_TARGET_BALL_SPEED } from "shared/tuning";

/** The seven hooks the rest of the system provides. A `kind` is which hook a power answers, and nothing else. */
export const POWER_KINDS = ["passive", "aura", "collision", "pickup", "timed", "world", "event"] as const;

export type PowerKind = (typeof POWER_KINDS)[number];

/** The ten powers. A `Power` attribute on a body carries one of these strings. */
export const POWER_IDS = [
	"bully",
	"bouncy",
	"ghost",
	"heavy",
	"decoy",
	"magnet",
	"rocket",
	"recycle",
	"eclipse",
	"sprinter",
] as const;

export type PowerId = (typeof POWER_IDS)[number];

// #region bully / heavy — the transfer pair

/**
 * **Placeholder.** The share of the victim's speed a `bully` takes on one contact, above `BALL_SPEED_MIN`.
 *
 * ## Why a share and not a flat number
 *
 * A flat steal does not converge: 1.0 per contact takes 1.0 off a ball at 10, 9 and 8 alike, so a wedged pair would
 * trade the same amount forever and the losing ball would reach the floor in a straight line. A share of what is left
 * is geometric — 1.0, then 0.9, then 0.81 — so the exchange **converges on its own** and a third contact necessarily
 * moves strictly less than the first. That is the property the tests assert, and it is a property of the arithmetic
 * rather than of a cooldown.
 *
 * Arithmetic: 0.1 of a full-speed ball (10) is 1.0, which at 3.3 s per point is about 3.3 seconds of ride handed over
 * per contact. At the 0.25 s collision cooldown that is a devastating exchange if two balls stay wedged, which is why
 * the cooldown exists and is not optional.
 */
export const BULLY_STEAL_SHARE = 0.1;

/** **Placeholder.** The share a `heavy` ball takes. Larger than `BULLY_STEAL_SHARE`: a heavy ball takes a bigger bite. */
export const HEAVY_STEAL_SHARE = 0.15;

/**
 * **Placeholder.** The share of what it drained that a `bully` keeps for itself.
 *
 * One, so `bully` is a pure transfer: the victim loses exactly what the attacker gains, and the field's total
 * `BALL_SPEED` is conserved. See `HEAVY_KEEP_SHARE` for the opposite.
 */
export const BULLY_KEEP_SHARE = 1;

/**
 * **Placeholder.** The share of what it drained that a `heavy` ball keeps.
 *
 * **Below one on purpose.** This is the asymmetry the table describes: a heavy ball drains 0.9 and keeps 0.6, so the
 * collision destroys 0.3 rather than moving it. `bully` conserves; `heavy` erodes. That is a difference of *kind* — one
 * wins an exchange, the other shortens everyone's ride — rather than the same power with a bigger number.
 */
export const HEAVY_KEEP_SHARE = 0.6;

/**
 * **Placeholder.** The multiplier on any drain aimed at a `heavy` ball.
 *
 * The other half of "it loses less than the other loses". Without this, a heavy ball's advantage only exists when it is
 * the attacker, so a bully that reached it first would take a full bite and the name would mean nothing defensively.
 * At 0.5 a heavy ball loses half of what anyone else would lose to the same contact.
 */
export const HEAVY_RESIST = 0.5;

/**
 * **Placeholder.** The most one contact may move, in studs/second.
 *
 * A ceiling on a single exchange rather than on a ball's speed: at `HEAVY_STEAL_SHARE` a 10-speed victim yields 1.5,
 * and the share alone would let a fast ball (a post-pickup 12, a rocket's 18) yield 2.7 in one touch. Two seconds of
 * ride is already a large swing; the cap keeps one unlucky contact from deciding a round outright.
 */
export const MAX_STEAL_PER_CONTACT = 2;

/**
 * **Placeholder.** Minimum seconds between two transfer impulses involving the same ball.
 *
 * **Not optional.** `Touched` re-fires on essentially every physics step while two balls rest against each other, so
 * without a cooldown the transfer runs at ~60/s and two touching balls resolve in a fraction of a second — the round
 * would be decided by which pair happened to meet. (The deleted ball-ball handler used the same argument for the same
 * interval; item 92 removed that handler and this one stayed, because a transfer is still a transfer.)
 */
export const POWER_COLLISION_COOLDOWN = 0.25;

/**
 * **Placeholder.** Seconds of a body's round that must pass before a contact may draw a hit burst.
 *
 * ## What it suppresses, measured from the log (item 110)
 *
 * A round's first seconds are a **spawn pile-up**. Bodies spawn at the same along-belt position, two studs apart across
 * the belt and sometimes onto an occupied lane (`occupants=2 nearest=#2`), so they spawn interpenetrating; physics
 * separates them and `Touched` re-fires on essentially every step until they settle. The observed result was a burst
 * every 100-200 ms for the first ~2.5 s, all of them at the spawn end, and roughly one a second afterwards.
 *
 * **It gates the burst, not the game.** The transfer below it still runs, at the same cooldown, so a bully spawning next
 * to its victim loses nothing; what is suppressed is the visual of a collision nobody drove into. That asymmetry is the
 * whole point - a threshold on speed was tried first and cannot work: `BALL_SPEED` spawns at `10..12` against a belt of
 * `10`, so a fresh body already carries up to 2 studs/s of world speed, which is the same number a genuine slow contact
 * produces.
 *
 * `2` is the pile's own settling time. Larger values start dropping real hits at the front of a round; smaller ones let
 * the last of the pile through. Measured against `POWER_COLLISION_COOLDOWN = 0.25`, it removes up to eight bursts a
 * second per colliding pair for the first two seconds.
 */
export const HIT_EFFECT_MIN_ROUND_AGE_SECONDS = 2;

/**
 * **Placeholder.** Minimum seconds between two hit bursts involving the same ball.
 *
 * **Separate from `POWER_COLLISION_COOLDOWN`, deliberately.** That constant gates a *speed transfer* and is `0.25`; this one
 * gates a *picture* and is slower, because since item 111 every contact draws a burst rather than only a `bully` or `heavy`
 * one. On a belt holding thirty bodies in contact, a shared clock would put the burst rate at the transfer rate and the
 * screen would strobe; at `0.5` a single body can contribute at most two bursts a second however many neighbours it has,
 * and a pair can still light up twice a second.
 *
 * It is stamped by whichever body of the pair fires (the lower `serial`), so the pair's rate is the rate of that one
 * clock. A collision that draws nothing is one where the firing body had burst recently - not one that "was not fast
 * enough", which is the reading this constant exists to make obvious.
 */
export const HIT_EFFECT_COOLDOWN_SECONDS = 0.5;

/**
 * **Placeholder.** Chance that an eligible ball-ball contact triggers an upward pop.
 *
 * A contact uses the lower of its two per-power chances, so a `heavy` body halves the chance whether it is the caller or
 * the other body. Two `heavy` bodies still use the half chance, not a quarter chance. Missing or unknown powers use this
 * default.
 */
export const DEFAULT_COLLISION_POP_CHANCE = 0.5;

/** Per-power pop chance overrides; `heavy` pops at exactly half the default chance. */
export const COLLISION_POP_CHANCE_BY_POWER: Readonly<Partial<Record<string, number>>> = {
	heavy: DEFAULT_COLLISION_POP_CHANCE / 2,
};

// #endregion

// #region magnet / eclipse — the decay multipliers

/**
 * **Placeholder.** The radius of a `magnet` ball's aura, in studs.
 *
 * Arithmetic: a ball is 1 stud across and the belt is ~56 studs long, so 6 studs is roughly five ball diameters — near
 * enough that the victim can see whose aura it is in, far enough that a magnet has to be driven alongside its victims
 * rather than waiting at one point. A radius measured in belt-lengths would make the aura a field-wide effect, which is
 * what `eclipse` is for.
 */
export const MAGNET_RADIUS = 6;

/**
 * **Placeholder.** The multiplier applied to a victim's decay while it is inside a `magnet` aura.
 *
 * Two, so a magnet's neighbour loses speed twice as fast — 0.2 per second instead of 0.1, halving its ride from ~100 s
 * to ~50 s while it stays close. Stacking is deliberately not defined: the aura is a flag ("in at least one"), not a
 * sum, because a sum makes magnet balls multiplicative with each other and the second magnet would be worth more than
 * the first.
 */
export const MAGNET_DECAY_MULTIPLIER = 2;

/**
 * **Placeholder.** The multiplier applied to every opponent's decay while an `eclipse` window is open.
 *
 * Three, and applied to every opponent regardless of distance — this is the field-wide counterpart to `magnet`, and its
 * cost is that it has no counterplay other than outlasting it. Four seconds at 3x costs a neighbour 3.6 `BALL_SPEED`
 * (about 12 seconds of ride) if the window catches it at full speed.
 */
export const ECLIPSE_DECAY_MULTIPLIER = 3;

/** **Placeholder.** Seconds after `Playing` entry at which an `eclipse` window opens. */
export const ECLIPSE_START_DELAY = 6;

/**
 * **Placeholder.** How long an `eclipse` window stays open, in seconds.
 *
 * A window rather than a permanent effect because a permanent 3x decay on the whole field would make the eclipse ball's
 * *presence* the outcome; a window is an event the other players can be seen to survive.
 */
export const ECLIPSE_WINDOW_SECONDS = 4;

// #endregion

// #region rocket / sprinter / recycle — the two that raise a speed, and the one that keeps a pad in play

/**
 * **Placeholder.** The `BALL_SPEED` a `rocket` ball snaps to when its trigger fires, in studs/second.
 *
 * It is a *snap*, not an addition: a delta would depend on what the ball happened to be at, so two rocket balls would get
 * different boosts, and the whole point of a once-per-round event is that its value is known.
 *
 * **This docblock used to say "above `BOOST_TARGET_BALL_SPEED` (12) and below `BALL_SPEED_MAX` (20). At 18 ...".** Every
 * number in that sentence is now wrong: `BOOST_TARGET_BALL_SPEED` is `80`, so this is `130`, and `BALL_SPEED_MAX` is
 * `100`. **The snap is therefore clamped** - `stepBallSpeeds` applies `math.clamp(..., BALL_SPEED_MIN, BALL_SPEED_MAX)`
 * after every contributor has spoken, which is the rule this file's header promises for deltas. A rocket ball reaches
 * `100`, not `130`; the surplus is discarded and cannot accumulate. Corrected in item 204; the value is the designer's and
 * is **not** retuned here.
 */
export const ROCKET_TARGET_SPEED = BOOST_TARGET_BALL_SPEED + 50;

/**
 * **Placeholder.** How far along the belt a `rocket` fires, as a fraction of the belt's length measured from the spawn
 * edge.
 *
 * `0.8` - four fifths of the way down the belt. The trigger used to be a random moment in `[3, 10]` seconds, which made two
 * rocket balls fire at different *times* and therefore at different *places*: one snapped in the middle of the field, one at
 * the edge, and neither event was legible as a position. Keyed on position instead, the snap happens where a viewer can see
 * it - a ball visibly closing on the exit and then shooting away from it - and two rockets fire at the same place, which is
 * the observable a `Playing` round actually has.
 *
 * ## Why a fraction of the length and not a distance
 *
 * The belt is a scene part and its length is a scene fact: `333` studs today, and nothing in `tuning.ts` owns that number.
 * A stud threshold would silently mean a different fraction the first time the belt was resized in Studio, and the bug
 * would read as "the rocket fires at the wrong time" rather than as "the belt moved".
 */
export const ROCKET_TRIGGER_PROGRESS = 0.8;

/**
 * **Placeholder.** The `BALL_SPEED` a `sprinter` ball's pickup sets, in studs/second.
 *
 * `BOOST_TARGET_BALL_SPEED + 20` = `100` today, which **equals `BALL_SPEED_MAX`**: the sprinter is the fastest a body can
 * legally be, and the clamp is exactly the value it asks for rather than a lower ceiling. It is also the body that wears
 * the afterimage, because it is the only power that spends the round above `BELT_SPEED` - see
 * `SPRINTER_AFTERIMAGE_ATTRIBUTE`.
 *
 * **This docblock used to say "above `BOOST_TARGET_BALL_SPEED` (12) by four points ... below `ROCKET_TARGET_SPEED` (18)".**
 * The arithmetic has been retuned twice since; the *ordering* it describes is still the design intent and still not true of
 * the numbers (`ROCKET_TARGET_SPEED` is `130` before the clamp). Corrected in item 204.
 */
export const SPRINTER_BOOST_SPEED = BOOST_TARGET_BALL_SPEED + 20;

// #endregion

// #region badge

/**
 * **Placeholder.** Width of the floating power badge, in pixels.
 *
 * **`BillboardGui` has no `AutomaticSize`.** Verified against `@rbxts/types`: `BillboardGui` extends `LayerCollector`
 * extends `GuiBase2d`, not `GuiObject`, and `AutomaticSize` is declared on `GuiObject`. So the container cannot size
 * itself to its child, and a badge sized to the longest label has to be sized by hand.
 *
 * Arithmetic: the longest label is `SPRINTER`, eight glyphs at `POWER_BADGE_TEXT_SIZE` 14 in a bold grotesque is about
 * 8 x 9 = 72 px; 96 leaves room for the widest glyph and for the stroke. Too narrow and `TextTruncate` silently eats the
 * last letter, which is the failure mode the width exists to prevent.
 */
export const POWER_BADGE_WIDTH = 96;

/** **Placeholder.** Height of the badge, in pixels. One line of `POWER_BADGE_TEXT_SIZE` plus a little air. */
export const POWER_BADGE_HEIGHT = 20;

/**
 * **Placeholder.** Badge text size, in pixels.
 *
 * **Fixed, with `TextScaled = false`,** because the badge is a world-space primitive: its `Size` is `fromOffset`, so a
 * scaled text would change apparent size with distance along with the frame. A fixed size keeps the glyphs the same
 * fraction of the badge at every range, so the frame is what shrinks.
 */
export const POWER_BADGE_TEXT_SIZE = 14;

/**
 * **Placeholder.** How far above the ball's surface the badge floats, in studs, measured from the ball's centre.
 *
 * Added to the ball's radius rather than replacing it, so a badge never sits inside the body it labels.
 */
export const POWER_BADGE_OFFSET_STUDS = 14;

/**
 * **Placeholder.** The distance past which a badge stops drawing, in studs.
 *
 * `BillboardGui.MaxDistance` defaults to infinity, which would draw a badge for every ball on the belt from anywhere in
 * the place. The arena is now **336 x 173 studs** — a diagonal of about `377` — and the camera has to sit well back to frame
 * 20-stud balls, so a ball at the far end is several hundred studs away.
 *
 * **`120` was tuned for a 56-stud belt and is the reason the names "spawn then disappear" (item 185).** A badge appeared
 * while its ball was near the camera at spawn and was culled the moment the ball rode past the cutoff — so the label
 * existed, replicated, and was simply not drawn. `600` covers the diagonal from a camera parked outside the arena at either
 * end, with margin for a chase camera that trails a fast ball.
 *
 * The cost of a large value is draw calls, not correctness: a badge is one `BillboardGui` with one `TextLabel`, and the
 * round is capped at eight bodies, so this cannot become a field-wide flock of labels.
 */
export const POWER_BADGE_MAX_DISTANCE = 600;

/** The badge's instance name, so "does this body have exactly one badge" is a name lookup rather than a walk. */
export const POWER_BADGE_NAME = "PowerBadge";

// #endregion

/**
 * One ball design's power.
 *
 * A ball has exactly one power and a power belongs to exactly one ball; the table below is therefore keyed by ball id and
 * both directions are a linear walk over ten entries. `kind` is not decoration — it says which hook the power answers,
 * and the tick loop, the collision handler and `PickupService` use it to decide whether a body is worth connecting at
 * all.
 */
export interface PowerDefinition {
	/** The `BALL_POOL` id this power belongs to. */
	readonly ballId: string;
	readonly powerId: PowerId;
	readonly kind: PowerKind;
	/**
	 * **What this ball does, in player-facing prose - at most three sentences.**
	 *
	 * Rendered in the inventory's detail pane when a ball is selected (`shop-controller.ts`, item 230), through
	 * `describeBallPower`. It spent its first several rounds declared and unread, which is why two of the strings drifted out of
	 * date without anything failing: the `rocket` line still described a random trigger after item 203 made it a position, and the
	 * `recycle` line read like a bigger boost rather than a surviving pad. **A string nothing renders is a string nothing
	 * corrects** - so the pane is what keeps these honest, and `effect` is the only description table in the tree.
	 *
	 * The three rules the text follows, all from this module's own header:
	 *
	 * - **Player-facing.** No constant names, no study sizes, no timings a player cannot act on.
	 * - **At most three sentences.** The pane has one column and a fixed height; the spec fails a longer string.
	 * - **Non-comparative.** Rarity is not an ordering (see the module header), so no line may read as "better than" another
	 *   ball's power. Describing what a ball does is not the same as ranking it.
	 */
	readonly effect: string;
}

/**
 * **The table.** Ten ball ids, ten powers, one kind each.
 *
 * Order is irrelevant — `powerForBallId` walks it — but it is kept in `BALL_POOL` rarity order so a reader can compare the
 * two files side by side.
 */
export const POWERS: ReadonlyArray<PowerDefinition> = [
	{
		ballId: "bully_ball",
		powerId: "bully",
		kind: "collision",
		effect: "Takes speed from any ball it touches and keeps all of it. The harder the contact, the more it steals.",
	},
	{
		ballId: "bouncy_ball",
		powerId: "bouncy",
		kind: "passive",
		effect: "Hops along the belt instead of rolling flat. It is the only ball whose power changes nothing about how fast it travels.",
	},
	{
		ballId: "ghost_ball",
		powerId: "ghost",
		kind: "world",
		effect: "Passes straight through other balls for part of every cycle, then turns solid again. Walls and the belt always stop it.",
	},
	{
		ballId: "heavy_ball",
		powerId: "heavy",
		kind: "collision",
		effect: "Keeps less of the speed it drains than a bully does, but loses less than anyone. Hard to slow down and hard to escape.",
	},
	{
		ballId: "decoy_ball",
		powerId: "decoy",
		kind: "world",
		effect: "Spawns an identical twin a few seconds after it launches. The twin looks and moves like the real ball but cannot win the round.",
	},
	{
		ballId: "magnet_ball",
		powerId: "magnet",
		kind: "aura",
		effect: "Makes nearby balls lose speed faster. The pull only reaches balls close to it.",
	},
	{
		ballId: "rocket_ball",
		powerId: "rocket",
		kind: "timed",
		effect: "Near the exit its speed snaps to a large boost, once per round. A last-second save from elimination.",
	},
	{
		ballId: "recycle_ball",
		powerId: "recycle",
		kind: "pickup",
		effect: "Takes a pickup boost and leaves the pad where it is. Any ball that follows gets the same boost.",
	},
	{
		ballId: "eclipse_ball",
		powerId: "eclipse",
		kind: "timed",
		effect: "Partway through the round, every opponent loses speed faster for a few seconds. The effect reaches further when more balls are near.",
	},
	{
		ballId: "sprinter_ball",
		powerId: "sprinter",
		kind: "event",
		effect: "A pickup gives it a bigger boost than any other ball. Every pad is worth more to it.",
	},
];

/**
 * The power a ball id races with, or `undefined` if the id is not in the table.
 *
 * `undefined` is a real answer and must stay one: a profile written by an older build can name a ball this build does not
 * know, and a body spawned for such an id must carry **no** `Power` attribute rather than a guessed power. A guessed
 * power would be a player racing with a rule they did not choose.
 */
export function powerForBallId(ballId: string): PowerId | undefined {
	for (const definition of POWERS) {
		if (definition.ballId === ballId) {
			return definition.powerId;
		}
	}

	return undefined;
}

/** The definition for a power id, or `undefined` for a string that is not a power. */
export function definitionForPower(powerId: string): PowerDefinition | undefined {
	for (const definition of POWERS) {
		if (definition.powerId === powerId) {
			return definition;
		}
	}

	return undefined;
}

/**
/**
 * **What this ball does, as one string for a player to read.**
 *
 * The accessor the inventory's detail pane calls: ball id in, prose out. Built from `powerForBallId` and `definitionForPower`
 * rather than walking `POWERS` a third time, so there is one lookup path and the two exported walks stay the only ones.
 *
 * **`""` for a ball id the table does not have**, and that is the answer rather than an error: a body with no
 * `ChosenBallId`, a profile id written by an older build, and a ball added to `BALL_POOL` before its `POWERS` row all land
 * here. The caller renders an empty label - which `AutomaticSize.Y` collapses to zero height - because a missing description
 * must not become a broken row or a crash. `undefined` would push that decision onto every caller; an empty string is the
 * same fact already expressed in the type the caller needs.
 */
export function describeBallPower(ballId: string): string {
	const powerId = powerForBallId(ballId);
	if (powerId === undefined) {
		return "";
	}

	const definition = definitionForPower(powerId);
	return definition === undefined ? "" : definition.effect;
}

/** The word the badge shows for a power: **uppercase, derived from the id.**
 *
 * ## Why uppercase, and why there is no second form
 *
 * The badge is a caption, and every caption in this tree is uppercase (`REROLL`). One casing, produced by one function,
 * so a later store row or results line cannot render `Bully` beside a badge that says `BULLY` — two spellings of one
 * power read as two powers. If a future surface genuinely needs sentence case it can lower this string; that is a
 * display decision at the call site, not a second export here.
 *
 * Derived rather than typed into a map so it cannot go stale when a power is renamed: the only way to change the word is
 * to change the id, which changes the attribute and the table with it.
 */
export function powerLabel(powerId: string): string {
	return string.upper(powerId);
}

/** **Placeholder.** Width of one uppercase glyph at `POWER_BADGE_TEXT_SIZE`, in pixels. */
export const POWER_BADGE_GLYPH_WIDTH = 9;

/**
 * Whether a label fits `POWER_BADGE_WIDTH`.
 *
 * Exported so the width constant is *asserted* rather than trusted: `POWER_BADGE_WIDTH` exists because a
 * `BillboardGui` cannot size itself to its child, and the failure mode of getting it wrong is `TextTruncate` silently
 * eating the last letter of `SPRINTER`. A test walks `POWERS` and calls this, so adding a power whose name does not fit
 * fails the suite instead of failing in Studio. The arithmetic is deliberately crude — a glyph-width estimate — because
 * the real metric is a font, and no font is available on the server.
 */
export function powerLabelFits(powerId: string): boolean {
	return powerLabel(powerId).size() * POWER_BADGE_GLYPH_WIDTH <= POWER_BADGE_WIDTH;
}
