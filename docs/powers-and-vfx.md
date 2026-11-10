# Powers and VFX — the current state

> **Read this before any other file in this repo.** It describes what the ten ball powers and the client-side effects *are
> today*, verified against the source on 2026-11-09 (`642580b`). `HANDOFF.md` is the design log: ~170 items, append-only, and
> several of its entries are snapshots of a shape that has since changed. This document is the current shape; the log is only
> useful when you want to know *why* something is the way it is.

---

## 1. Orientation

This is a **treadmill race**. Each player races one ball along a belt; the last ball still on the belt wins. A ball's motion is
not physics — it is a **single reference number**, `BALL_SPEED`, held as an attribute on the body, and
[`BallSpawnerService.stepBallSpeeds`](../src/server/services/ball-spawner-service.ts) rewrites the ball's velocity from it **every
tick**:

```
RELATIVE_SPEED = BALL_SPEED - BELT_SPEED        // along the belt's RightVector
```

`BALL_SPEED_START` equals `DEFAULT_BELT_SPEED`, so the race starts at exactly zero relative speed and only decay and pickups move
it. `BALL_SPEED_DECAY_RATE = 0.1` per second, so **one point of `BALL_SPEED` is about ten seconds of ride** — every transfer
magnitude in [`powers.config.ts`](../src/shared/powers.config.ts) is chosen against that exchange rate. Pop chances are
probabilities, not ride-time values. `BALL_SPEED_MIN = 0`,
`BALL_SPEED_MAX = 20` (a safety net, not a balance guard), `BOOST_TARGET_BALL_SPEED = 12`.

**The rule that must not be broken:** `stepBallSpeeds` is the only writer of the **along-belt** component of
`AssemblyLinearVelocity`, and within a tick it is the only writer of `BALL_SPEED`. Everything else is one of:

1. a **delta to `BALL_SPEED`** returned from `tickDelta` and applied by that loop (a rocket's snap, an eclipse/magnet victim's
   extra decay);
2. a **direct write to `BALL_SPEED`** from a collision handler — safe only because nothing writes between two ticks;
3. a change to **the body itself** the model cannot overwrite (collision group, decoy twin, badge, texture).

The model replaces X and the decorative sway sets Z; neither axis can carry a durable **velocity** written by a collision
handler. Y remains outside `BALL_SPEED` and is preserved by the tick loop, so ball contacts set Y directly for the upward
pop. Lateral motion is different: a contact leaves an **impulse** in `server/lateral-shove.ts`, and `stepBallSpeeds`
projects it onto `across`, adds it to the sway's rate and decays it. The sway therefore keeps its single writer, and a
shove is not a velocity racing the tick. The engine's own lateral separation alone is invisible — one physics step, then
the sway replaces it.

Read `tuning.ts`'s `BALL_SPEED_*` block and `stepBallSpeeds`' docblock before changing anything here.

---

## 2. The ten balls

The table is [`src/shared/powers.config.ts`](../src/shared/powers.config.ts) → `POWERS`. One ball, one power, one `kind`
(`POWER_KINDS`: `passive | aura | collision | pickup | timed | world | event`). `kind` is not decoration: it says which hook the
power answers, and the tick loop, the collision handler and `PickupService` use it to decide whether a body is worth connecting.

| ball id | power | kind | what it does | rule owned by |
| --- | --- | --- | --- | --- |
| `bully_ball` | `bully` | collision | on touch, moves `BALL_SPEED` from the other ball to itself, keeping **all** of it | `powers/index.ts` → `transferAmounts` |
| `bouncy_ball` | `bouncy` | passive | hops on the belt; the `BELT_BOUNCE_*` constants, for this ball only | `ball-spawner-service.ts` (spawn site) |
| `ghost_ball` | `ghost` | world | cannot collide with other balls; walls still collide | `powers/index.ts` → `collisionGroupFor` |
| `heavy_ball` | `heavy` | collision | the same transfer, asymmetric: keeps less than it drains, loses less than anyone else | `powers/index.ts` → `transferAmounts` |
| `decoy_ball` | `decoy` | world | spawns one ownerless twin beside itself, indistinguishable and unable to win | `ball-spawner-service.ts` → `spawnDecoy`, `powers/index.ts` → `spawnsDecoy` |
| `magnet_ball` | `magnet` | aura | opponents within `MAGNET_RADIUS` decay faster | `powers/index.ts` → `tickDelta` |
| `rocket_ball` | `rocket` | timed | once per round, at a random moment, `BALL_SPEED` snaps to `ROCKET_TARGET_SPEED` | `powers/index.ts` → `drawTimers`/`tickDelta` |
| `recycle_ball` | `recycle` | pickup | takes the pickup's boost and **leaves the pickup in play** | `powers/index.ts` → `pickupDecision` |
| `eclipse_ball` | `eclipse` | timed | for a window, every opponent's decay is multiplied | `powers/index.ts` → `drawTimers`/`tickDelta` |
| `sprinter_ball` | `sprinter` | event | a pickup boosts it further than the standard value | `powers/index.ts` → `pickupDecision` |

**Rarity is not an ordering.** The pool is ordered by rarity, so this table reads like a tier list and is not one: the designer's
rule, quoted in `powers.config.ts`, is *"some less rare balls are better in certain situations, and that is the point."* Do not
re-derive a power's worth from its row.

`powerForBallId(ballId)` returns `undefined` for an unknown id **on purpose** — a profile from an older build must produce a body
with **no** `Power` attribute rather than a guessed power.

---

## 3. The per-power rules — read this before you change X

Everything is in [`src/server/powers/index.ts`](../src/server/powers/index.ts), a **module, not a `@Service()`** (a Flamework
service cannot be constructed in the Jest runtime, so every rule here would be unassertable). Pure decisions over plain tables;
one thin imperative wrapper that touches instances.

### `bully` / `heavy` — `transferAmounts`

- **State:** a per-ball `lastCollisionAt` cooldown (`POWER_COLLISION_COOLDOWN = 0.25`) and one `Touched` connection per body.
- **The number:** a **share of what the victim has left**, not a flat steal: `bully` 0.1 keep 1.0, `heavy` 0.15 keep 0.6, incoming
  drains on a heavy ball × `HEAVY_RESIST` (0.5), one contact capped at `MAX_STEAL_PER_CONTACT` (2).
- **What breaks if edited wrong:** make the steal flat and the exchange stops converging — a wedged pair trades the same amount
  forever. Remove the cooldown and `Touched` re-fires ~60×/s, so a pair resolves in a fraction of a second. The share being
  geometric is *why* the cooldown is a limiter rather than the only safeguard.
- Floor and ceiling are applied **inside** `transferAmounts`; the caller writes the two results and clamps nothing.

### `ghost` — a collision group, not a toggle

- **State:** the body's `CollisionGroup` (`collisionGroupFor`), plus the pair table in `ensureCollisionGroups`.
- **What breaks if edited wrong:** see §4. A group is a *pair* of names, so "disable this group against `Default`" also stops the
  ball hitting the belt and walls. Ghost needs its own group; ordinary balls need one too, because a pair is symmetric.
- **Deliberately absent:** the periodic `ghost` toggle the design note calls for. A ghost is permanently intangible to other balls.

### `magnet` / `eclipse` — auras over a registry

- **State:** `magnetBalls` / `eclipseBalls`, module-level sets of bodies, filled by `setPower` and cleared by `forgetBall`.
- **Rule:** `tickDelta` asks "is *any* opponent's aura in range/open" — **auras do not stack**, so a second magnet is worth exactly
  as much as the first. The eclipser is exempt from its own window because the aura list never contains the ball itself.
- **What breaks if edited wrong:** register an aura for a body you did not `setPower` (a decoy — see below) and it emits a real aura
  the field feels but `getCompetitors()` cannot see.

### `decoy` — `presentPower` vs `setPower`

- **State:** the twin is a real body created by `BallSpawnerService.spawnDecoy` at `DECOY_OFFSET_STUDS` (2.5), **presented** with
  the power but never made live.
- **What breaks if edited wrong:** use `setPower` for the twin and it registers an aura and a `Touched` connection — a decoy that
  really does eclipse the field or really does steal speed. `presentPower` gives the attribute, the collision group and the badge
  (what a viewer sees); `setPower` adds the registry entry and the connection (what the simulation acts on).
- The twin also cannot win: it carries no owner attribute, and `getCompetitors()` filters on owners.

### `rocket` — one snap, once

- **State:** `PowerTimers.rocketAt` drawn at `Playing` entry, `rocketFired` written back by the loop.
- **What breaks if edited wrong:** don't write `rocketFired` back and the snap re-fires every frame, pinning the ball at the target
  — a one-shot event becomes a permanent buff. The delta is `target - current` (not an addition) so two rocket balls arrive at the
  same speed.

### `eclipse` — a window, computed from the victim's tick

- **State:** `eclipseAt`/`eclipseUntil` in the same timers table; `windowOpen(timers, elapsed)` is the reader.
- **What breaks if edited wrong:** apply the multiplier to the eclipser's own tick. The tick function only ever speaks for the ball
  it was handed, so the extra decay is applied to the *victim's* tick by looking up the other bodies' auras.

### `recycle` — the one pickup exception

See §5. The rule is one branch in `pickupDecision`; the safety is `speedAfterPickup`'s idempotence, not a guard.

### `sprinter` — a bigger pickup number

One branch in `pickupDecision`: `SPRINTER_BOOST_SPEED` (16) instead of `BOOST_TARGET_BALL_SPEED` (12).

### `bouncy` — the only power that never touches `BALL_SPEED`

Its hop is the `BELT_BOUNCE_*` constants applied at that ball's spawn; `BELT_BOUNCE_ENABLED` is `false` globally, so the
behaviour is opt-in per ball. Nothing in `tickDelta` knows about it.

### The hit burst — `onBallCollision` → `maybeBurst`

- **State:** `contactEffects` (last burst time per body, plus a monotone id to order a pair) and the last-touch map the elimination
  sound reads.
- **Every body connects, not just the colliding powers** (item 111): the last-touch record needs a touch for *every* pair, because
  the body knocked off the belt is usually not the colliding one. The *transfer* is still gated by `isColliding` (bully/heavy).
- Two gates on the visual only: `HIT_EFFECT_MIN_ROUND_AGE_SECONDS` (2 s, the spawn pile-up) and `HIT_EFFECT_COOLDOWN_SECONDS`
  (0.5 s). Item 110 explains why a speed threshold cannot substitute for the age gate.

### The contact pop — `onBallCollision` → `maybePop`

- One lower-serial body rolls once for the pair; a successful roll sets the Y velocity of both bodies to
  `BALL_COLLISION_POP_UPWARD_SPEED`, preserving each body's X and Z. It does not write `BALL_SPEED`.
- The contact chance defaults to `DEFAULT_COLLISION_POP_CHANCE`; a contact involving `heavy` uses half, even when both bodies
  are heavy. Missing/unknown powers use the default. Current decoy spawns are only made by the `decoy` power, so those twins
  use the default; any future decoy carrying `heavy` would use the half chance.
- The pop shares the burst's round-age and per-body cooldown gates. It is attempted only when both bodies' absolute Y velocity
  is below the pop target, so it does not replace a fast engine bounce. A separate pop clock would allow pops while bursts are
  suppressed.

### The contact shove — `onBallCollision` → `maybeShove`

- On every gated contact (**not** chance-gated, unlike the pop), the lower-serial body records one horizontal impulse of
  `BALL_COLLISION_SHOVE_SPEED` on each body, opposite directions, along the contact normal. `stepBallSpeeds` projects it
  onto the belt's `across`, adds it to the sway's lateral rate and decays it by `BALL_COLLISION_SHOVE_DECAY_SECONDS`. At
  `5` and `0.3` that is roughly **1.5 studs** of sideways movement per hit, settling back as the sway's position
  correction pulls the ball to its wave.
- It uses the burst's round-age and cooldown gates, and the same lower-serial election, so one `Touched` pair shoves once.
  Impulses accumulate up to one impulse's speed, so a pile refreshes the shove rather than multiplying it.
- The along-belt part of the normal is dropped by the writer, so a dead-on rear-end contact barely shoves sideways — that
  contact is covered by the pop and the burst instead. The shove direction is the contact normal, so it is not a random
  flick, and it needs no belt frame in `powers`.

### The shared physical profile

- One `PhysicalProperties` is built at module scope in `BallSpawnerService` — density `0.7`, friction `0.05`, elasticity
  `0.95` — and assigned to every spawned ball **and** every decoy. The three-argument constructor leaves
  `FrictionWeight`/`ElasticityWeight` at the engine default, which is what the Roblox docs' own `CustomPhysicalProperties`
  sample writes as `1`.
- `heavy` is **not** denser. Separation is symmetric by decision: `heavy`'s identity is the transfer arithmetic and the half
  pop chance, not a mass advantage.
- The engine does not use one part's elasticity — the pair value is the weighted average of the two. Ball-ball is therefore
  exactly `0.95` (equal bodies cancel the weights), and ball-floor is `(0.95 + BELT_SURFACE_ELASTICITY) / 2`. The floor is
  `0.35` so that pair stays at `0.65`, the value item 173 shipped; raising the ball alone would have raised every landing.
- The floor's friction stays `0`: it is what keeps `BALL_SPEED` the only along-belt force.

### The badge

- **Not a client controller.** `updateBadge` in `powers/index.ts` builds a `BillboardGui` named `PowerBadge` and parents it to the
  ball, on the **server**. It is the only thing this module puts in the world that is not a body. `powerLabel` uppercases the id;
  `powerLabelFits` asserts the width so a new power whose name overflows fails the spec rather than truncating in Studio.

---

## 4. The collision groups

Two groups, and **every ball is in one of them — balls are no longer in `Default`**:

| group | value | who |
| --- | --- | --- |
| `BALL_GROUP` | `CompetitorBall` | every ball, including plain ones |
| `GHOST_GROUP` | `GhostBall` | `ghost_ball` |

| pair | collides | why |
| --- | --- | --- |
| `CompetitorBall` / `Default` | yes | belt, walls, slab, players stay solid |
| `GhostBall` / `Default` | yes | a ghost still hits walls |
| `CompetitorBall` / `CompetitorBall` | yes | every other ball keeps colliding |
| `GhostBall` / `CompetitorBall` | **no** | the power |
| `GhostBall` / `GhostBall` | **no** | two ghosts pass through each other |

**The cost, stated because it will confuse you in Studio:** a ball's `CollisionGroup` property no longer reads `Default`. A
collision you are debugging may be governed by a pair table that lives in code. `ensureCollisionGroups` runs from the first
`setPower`, not at module load (the Jest runtime has no `PhysicsService`), and it is `pcall`-guarded so a group a designer created
by hand does not error.

**To undo it:** set `collisionGroupFor` to return `Default` for everything, delete the five `CollisionGroupSetCollidable` calls,
and accept that `ghost` then has no mechanism.

---

## 5. The pickup

`PickupService.onPickupTouched` → `pickupDecision(powerOf(other))` → `speedAfterPickup(before, decision.boost)`.

- **`consume` is `true` for every ball except `recycle`.** Consumption is the default because a surviving pad re-fires `Touched`
  on the ball resting on it and the boost is re-applied every frame — a Studio run held one ball on the belt for 71 seconds that
  way.
- **`recycle`'s pad survives**, because the pad is the resource the power is about. It is safe **by arithmetic, not by a guard**:
  `speedAfterPickup` is `math.max(current, boost)`, so a second collection computes the same value and writes nothing, and the
  ball keeps decaying on the tick loop.
- **Do not add an "already used" state to make the recycle pad safe.** There is nothing to protect. If you find yourself wanting
  one, the bug is somewhere else.
- Consumption was **universal** from item 76 and re-reversed for `recycle` at item 80. If you read an earlier item that says
  every ball consumes, it is a snapshot.
- `sprinter` takes `SPRINTER_BOOST_SPEED`; everyone else `BOOST_TARGET_BALL_SPEED`.

---

## 6. The VFX inventory

**Nothing is a `LocalScript`.** Every effect is a client `@Controller()`; the 3D ones clone a Studio asset found by
**recursive name** under `ReplicatedStorage`, the 2D ones are built in code.

| effect | trigger | controller | asset | where it lives | lifecycle |
| --- | --- | --- | --- | --- | --- |
| ball-ball hit burst | `Remotes.HitEffect` (server, per contact) | `hit-effect-controller` | `assets.vfx.hitEffect` (a `BasePart` with emitters) | `Workspace.HitEffects` folder | `Debris` at `LIFETIME_SECONDS + 0.15` |
| wind trail (`windBoost`) | `Boosted` attribute change | `wind-boost-controller` | `assets.vfx.windBoost` | clone parented **to the ball** | disabled/destroyed when the attribute goes false |
| tail wind (`tailWind`) | `TailWind` attribute change | `tail-wind-controller` | `assets.vfx.tailWind` | clone parented to the ball | same |
| arena motion blur | phase `Playing` | `motion-blur-controller` | `assets.vfx.motionBlur` | `Workspace` folder, placed at the `EliminationZone` | one clone for the phase; emitter `Rate` ramped 0 → authored → 0 |
| ball phantom (texture spin) | every frame per ball | `ball-render-controller` | none — a `Part` + copies of the ball's six face textures | parented to the ball, named `BALL_PHANTOM_NAME` | follows the ball; normalises its basis every 300 frames |
| pickup sprite + ring | phase / pickup spawn | `pickup-sprite-controller` | `pickupSprite` instance **or** `PICKUP_SPRITE_ASSET_ID` | a `BillboardGui` per pad, built per client | destroyed with the pad |
| elimination splash | `Remotes.EliminationSound` | `elimination-splash-controller` | none — `TextLabel` in code | `splash` layer (35) | pops, holds, fades, `Destroy()` after ~0.95 s |
| decoy owner's outline | `Remotes.DecoyOutline` | `decoy-outline-controller` | none — a `Highlight` | on the named body, for its owner only | one per client, moved to the named body |
| chest reveal + confetti | `OpenCoinChest` reply | `reveal-controller`, `confetti-controller` | none — `Frame`s and `TextLabel`s | `reveal` layer (38) | frame destroyed on every close path; confetti pieces die at the ceiling |

**The power badge is not in this table on purpose:** it is built in `src/server/powers/index.ts` and parented to the ball. A fresh
agent looking for its controller will not find one.

### Per-effect traps

- **hit burst** — the asset is resolved **once at boot** by recursive name; a missing asset warns and disables the effect for the
  session. The burst is gated on two numbers (round age, per-body cooldown) that suppress the *visual* only: the transfer still
  runs. The contact pop shares those gates but is a Y-only physics response, not a `BALL_SPEED` transfer. Do not "fix" the
  burst gates by adding a speed threshold — item 110 records why that cannot work.
- **the two trails** — driven by server-written booleans `Boosted` and `TailWind`, and **mutually exclusive at the source**:
  `stepBallSpeeds` writes `Boosted` first and feeds it into `writeTailWind`, so no client can observe both true in one frame. If
  you write either attribute from anywhere else, that guarantee is gone. Both use `vfx-scale.ts`
  (`effectScaleFor` / `scaleEffect`) so their size follows the ball's size — the motion blur and the confetti deliberately do
  **not**, because neither is attached to a ball.
- **motion blur** — one clone for the whole arena, at the `EliminationZone`, alive only in `Playing`; reads
  [`shared/motion-blur.ts`](../src/shared/motion-blur.ts) for its ramp maths. Its `Rate` ramp is a tween on emitters, so it is the
  only effect that is "on" without being triggered.
- **ball phantom** — the ball's own part is invisible and the phantom draws; the six face textures have to be copied and hidden
  separately, because a `Decal`/`Texture` renders on an invisible part. Spin comes from
  [`shared/apparent-spin.ts`](../src/shared/apparent-spin.ts) so the phantom and `marker-spin-controller` cannot disagree.
- **pickup sprite** — the image comes from either a `pickupSprite` instance or `PICKUP_SPRITE_ASSET_ID`; both produce one
  `ContentId` for one `ImageLabel.Image`. The ring is an `ImageLabel` on the same `BillboardGui`, not a `ParticleEmitter`.
- **elimination splash** — fires from the same remote as the elimination sound; `LIFETIME_SECONDS` is the sum of its four phases
  and is the only thing that destroys it.
- **confetti** — the pieces are `Frame`s created in code (no asset). One overlay for the session in the `reveal` layer; spawned
  **across the whole screen** by `defaultSpawn`, moved in `Scale` by one `RenderStepped`, destroyed at `CONF_CEILING = 1.3`. It
  fires twice per reveal — at the first card's flip and at the first card of the second half.

---

## 7. The layers

[`src/shared/ui/layers.ts`](../src/shared/ui/layers.ts) is the only way to obtain a `ScreenGui`. It names a rank, not a device:

| layer | order | insets | tenants |
| --- | --- | --- | --- |
| `fullScreen` | 10 | `None` | scenery that must reach the screen edge |
| `hudCore` | 20 | `CoreUISafeInsets` | the leaderboard, the picker |
| `hudTopbar` | 30 | `TopbarSafeInsets` | the phase banner |
| `splash` | 35 | `CoreUISafeInsets` | the elimination splash, the payout panel, the countdown |
| `sheet` | 37 | `CoreUISafeInsets` | the store, the inventory, the rail |
| `reveal` | 38 | `None` | the chest reveal and its confetti overlay |
| `toast` | 39 | `CoreUISafeInsets` | the reward toast |
| `transition` | 40 | `None` | the round wipe — covers everything, always |

**"The total order" means no two layers share a number.** Two `ScreenGui`s at one `DisplayOrder` are ordered by sibling position
in `PlayerGui`, which is not a correctness property; three constraints (reveal above the sheet, toast above the reveal, wipe above
everything) need four integers, which is why the sheet sits at 37.

**The 3D effects do not use this table.** They live in `Workspace` (parented to a ball, or to a folder under `Workspace`), so
there is no `DisplayOrder` and no `ScreenInsets` involved. Only the 2D overlays are in a `ScreenGui`.

Within one `ScreenGui`, `ZIndexBehavior` is the default `Sibling`: a child's `ZIndex` competes only with its siblings, and a
subtree draws as a unit. That is why a reveal card's content reaches `ZIndex` 7 and the confetti, a sibling of the grid host,
takes 8.

---

## 8. Deliberately absent, and still absent

Read from source, not from the README's older list. **Do not offer to add these** — each was rejected or deferred on purpose:

- **No mesh or model support.** Every `model` in [`models.config.ts`](../src/shared/models.config.ts) is `undefined`; the ten
  balls draw `Part` spheres. A spec fails if a ball id has no entry, so the swap fails a suite rather than drawing a sphere.
- **No client prediction.** The server owns the velocity; a client sees the result a round trip later.
- **No world auras.** `magnet` and `eclipse` are radii in a server-side registry and draw nothing.
- **No periodic `ghost` toggle.** Recorded as the intended nerf; not built.
- **No wall assist.** Deleted at item 94 after item 93 proved it inert and backwards. A wall is ordinary scene geometry.
- **No VFX built server-side**, except the badge.
- **No 3D particles on UI**, and no `ParticleEmitter` for the confetti.
- **No audio beyond six one-shot UI sounds + one round song + two lobby songs**
  ([`sounds.config.ts`](../src/shared/sounds.config.ts)): click, purchase, coin, hit, elimination, pickup. No ambience, nothing
  positional, and **no sound on the confetti** (the module had one; it was dropped).
- **No camera work.**

---

## 9. Open items a fresh agent will hit

Deferred decisions, each with the item that deferred it:

1. **The premium chest's `PurchaseGranted` carries no payload.** `EconomyService.notifyGranted` fires the remote with **no
   arguments**, so the client cannot know what a Premium purchase granted and the reveal is coin-only. The fix is three server
   edits — make `applyRobuxChestGrant` return the granted id, have `notifyGranted(player, ballIds)` send `{ ok, ballIds }`, and
   read it in `shop-controller`'s `PurchaseGranted` handler (item 163).
2. **The premium chest's buttons and receipt path are unchanged and untested in Studio** (items 60, 163).
3. **The sway's pitch was flagged at items 152–153 and never re-verified.** `SWAY_FREQUENCY_HZ = 0.1` with
   `SWAY_FREQUENCY_JITTER = 0.3` gives each ball its own period; whether the field *sounds* right is a playtest question, and the
   one report that triggered the change was a report about phase, not about pitch.
4. **`BELT_BOUNCE_ENABLED` is `false`.** The `bouncy` power is the only thing that uses the constants today; a designer asking
   "why does nothing bounce" is asking about this flag.
5. **The `decoy` twin holds a `MaxLiveBalls` slot** and cannot win. That is deliberate, and it is the reason "wrong pick in a small
   field" is the decoy's real cost.
6. **`HANDOFF` items whose quoted numbers are snapshots** — see §10 before trusting any number you read in the log.

---

## 10. Doc currency

Verified against source on **2026-11-09**, at commit **`642580b`** (`642580be9047cc7a03bf6703d8f25cfe95ff0e92`).

**Items whose quoted numbers are stale** — the history is a snapshot, not a current fact. Do not edit the bodies; read them as
"what was true then":

| item | says | actually today |
| --- | --- | --- |
| 163 | the reveal's `BURST_COUNT` is `24` | `80` (item 169) |
| 165 / 167 | confetti is image-label clones from `assets.ui.confetti`, `BURST_COUNT = 24`, 9–18 px pieces, gravity 1200 | replaced entirely by items 168/169: `Frame` pieces, no asset, `24..36` px, gravity 75, full-screen spawn |
| 168 | `BURST_COUNT` is `204`, spawn is the grid centre, three shapes, no fade | item 169: `80`, full-screen spawn, four shapes, fade-in |
| 169 | the mirrored lifetime is 0.77–1.92 s with 40/200 passing above the top | current, re-verified this round |

**Items that describe a shape the code no longer has, and which now carry a pointer** — see the note at the top of each: 9, 16,
26, 35, 74, 76, 77, 95, 100, 104, 109, 110, 124, 125. The pointer is a one-line addition under the heading; the body is left as
written.

**Where this briefing and the log disagree, this briefing is the current state** and the log is the reason.
