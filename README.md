# roblox-treadmill-race

A round-based elimination race. Every player picks one ball from a pool of ten, one body per player
spawns on a treadmill belt, every ball's speed decays toward the exit edge, a pickup and a per-ball
power intervene, and the last body still on the belt wins. A coin economy (chests, fusion, one Robux
chest), a ball picker, a store and an inventory sheet sit around it.

Stack: roblox-ts + Rojo + Flamework. Fusion 3 is imported by three controllers — the phase banner,
the round-transition wipe and the store — and big-ui by the banner's `Text` component plus the theme
push. Everything else is a hand-built `Instance` tree; neither library is a framework to build on, so
read *Toolchain notes* before reaching for one.

**The load-bearing mechanic is the `BALL_SPEED` reference-speed model, whose docblock sits above
`BALL_SPEED_DECAY_RATE` in [`src/shared/tuning.ts`](src/shared/tuning.ts). Read it before believing
anything else here about movement.** The belt is not a physical surface. If any document in this
repo describes it as one, that document is describing a previous version of the game.

## Layout

| Path | What it is |
| ---- | ---------- |
| `src/server/services/` | Six services: `treadmill`, `ball-spawner`, `pickup`, `round`, `economy`, `player-data-store` |
| `src/client/controllers/` | Ten controllers: belt scroll, marker spin, round state, transition wipe, phase banner, picker, store + inventory, debug keys, elimination splash, decoy outline |
| `src/server/powers/` | The ten powers — pure rules plus one instance-level wrapper, deliberately a module rather than a service |
| `src/server/{round-outcome,debug-balls,decoy-outline,elimination-signal,picker,admin}.ts` | Plain modules with specs beside the code; no Flamework, so a spec can import them |
| `src/shared/` | Tag names, attribute names + defaults, remote names, gameplay constants, the economy / powers / models configs and the UI theme |

## Scene ownership

**The scene fixtures are placed by hand in Studio.** `default.project.json` declares nothing under
`Workspace` on purpose: Rojo resets any instance it describes to the project file's values on each
live-sync, so a project-defined belt or spawner would snap back to a hardcoded CFrame every time you
moved it. Leaving `Workspace` childless means Rojo never touches your parts.

Four things are hand-placed and tagged: a `TreadmillBelt`, a `BallSpawner` per lane, optional
`TreadmillWall` parts, and an `EliminationZone` around the playable area. Everything else on the belt
is created by code and destroyed with the round: the ball bodies, their welded markers, one
frictionless floor just above each belt's top face, the pickup triangles, and the `decoy` twin. Do not
place those by hand — no service would look for them.

Connect with `npm run serve` from your own place. Do **not** open `build/game.rbxlx` for playtesting —
that is a freshly composed place with no parts in it (it exists only to prove the project file
composes).

## Running it

```powershell
npm install            # .npmrc pins legacy-peer-deps, see Toolchain notes
npm run build          # compile TypeScript to Luau in out/
npm run lint           # ESLint over src/ (legacy .eslintrc, see below)
npm run serve          # rojo serve, then connect from your place in Studio
npm test               # pretest builds the place, then jest-roblox runs the suite
npm run build:place    # compose build/game.rbxlx, proving the Rojo tree resolves
```

`npm test` is self-sufficient: its `pretest` step rebuilds TypeScript *and* the place file, because the
runner launches a place and a stale `build/game.rbxlx` would silently test the previous build. The
`studio-cli` backend starts its own headless Studio and quits it, so an open Studio does not need
closing; a normal run is about ninety seconds.

### Toolchain notes

- **Do not put comments in `default.project.json`.** Rojo accepts JSONC, but roblox-ts reads the
  same file with a strict `JSON.parse` and aborts before compiling. Rationale for the project
  layout belongs in this README, not in that file.
- `build`/`watch` invoke `node node_modules/roblox-ts/out/CLI/cli.js` rather than `rbxtsc`. That is
  not cosmetic: `@isentinel/roblox-ts` also installs an `rbxtsc` bin, so the `.bin` shim now points
  at the fork. Calling the local `roblox-ts` CLI by path pins the compiler the code is written
  against. This is also why `roblox-ts` stays a devDependency.
- `lint` sets `ESLINT_USE_FLAT_CONFIG=false` because the repo's config is `.eslintrc`, and `jiti` is
  what lets ESLint load a TypeScript-aware legacy config. ESLint 10 removed eslintrc support
  entirely, so `eslint` is pinned to `^9`; moving to 10 means migrating to `eslint.config.js`.
- `.npmrc` sets `legacy-peer-deps=true`. `@isentinel/jest-roblox` declares an optional peer on
  `typescript >=7`, while `@typescript-eslint` requires `<6.1`; no single TypeScript version
  satisfies both, so strict peer resolution cannot succeed.
- Flamework is a compile-time transformer that keeps its own build state, and `flamework.build` is
  **merged, not rewritten** — so adding or deleting a service or controller leaves a stale
  registration unless the manifest is regenerated. Delete `flamework.build` and
  `out/tsconfig.tsbuildinfo`, then rebuild. Avoid `npm run clean` (and never delete `out/`) while a
  `rojo serve` is running: that has crashed Rojo 7.7.1 twice in this project, and an incremental
  build is enough for every other change.
- Flamework prints a `TypeScript version differs` warning (project TS vs the 5.5.3 bundled inside
  roblox-ts). It switches to the bundled version and continues; the build is unaffected.

## Fixtures you build in Studio

**You tag the part; the code writes the attributes.** Both fixtures read their attributes from the
part, and fill in any that are missing at the moment the part is bound. So a freshly tagged part
works with no Properties-panel work at all. Anything already set is left alone — override a value in
Studio and it survives re-tagging.

### Belt — any `BasePart` tagged `TreadmillBelt`

| Attribute         | Type                 | Written if absent       |
| ----------------- | -------------------- | ----------------------- |
| `BeltSpeed`       | number, studs/second | **Placeholder** 10      |
| `BeltSpeedActual` | number, studs/second | by the round, each frame |

The part must be `Anchored` with `CanCollide = true`. **`BeltSpeed` is a reference number, not a
surface velocity, and nothing is dragged along it.** Each ball sets its own along-belt velocity from
its `BALL_SPEED` attribute every frame as `BALL_SPEED - BeltSpeed`: zero holds station, below zero
loses ground toward the exit, above zero gains it back. A positive `BeltSpeed` aims that comparison
along the part's right (+X), a negative one reverses it, so rotating the belt rotates the race and
flipping the sign flips the direction — no rebuild needed.

`BeltSpeedActual` is the **visual** rate: `RoundService` ramps it from 0 to `BeltSpeed` over
`BELT_RAMP_SECONDS`, and only `BeltScrollController` reads it. The two numbers were one for one
round, and that made every ball drift forward during the ramp with no pickup involved; the reference
is therefore constant and only the effect ramps.

The one piece of real geometry the belt owns is a static, anchored, friction-0 floor the service
creates just above the belt's top face — one per belt, removed on unbind. It exists so gravity has
something to settle a ball against, and because it cannot move it cannot fight the model.

### Spawner — any `BasePart` tagged `BallSpawner`

| Attribute      | Type            | Written if absent |
| -------------- | --------------- | ----------------- |
| `KillY`        | number, world Y | derived           |
| `MaxLiveBalls` | number          | 50                |

Anchor it and turn `CanCollide` off — it is only a locator. A lane's pickups are placed at the
spawner's own local `Z`, so the part's position is both where bodies appear and where its lane runs.

`Radius`, `Enabled` and `Rate` are **retired and ignored**, not merely unread: shape and size come
from [`src/shared/shape-pool.ts`](src/shared/shape-pool.ts), and there is no timer left for a rate to
describe. A spawner carrying any of them keeps the value — nothing deletes a designer's data — and
the bind log says once that it does nothing.

`KillY` is derived rather than picked: `Workspace.FallenPartsDestroyHeight + poolMaxExtent()`, one
body-size above the engine's own floor. That keeps this service's cull strictly ahead of the
engine's so the bookkeeping is cleaned deterministically, without deleting balls early.

Bodies are `Part` spheres tagged `Ball`, created on the server only, and parented to a
`SpawnedBalls` folder in `Workspace`. The spawner itself is never reskinned or moved. A body's centre
spawns one *rotated* half-height plus 0.5 studs above the part's origin, so its lowest point starts
0.5 studs clear and a spawn can never land inside the belt.

`KillY` is recorded per ball at spawn; with several spawners the effective cap is the smallest
`MaxLiveBalls`, because the count it describes is global. Cleanup runs every 0.5 s, and the cap is
also enforced synchronously on each spawn.

## The game loop and the debug keys

Four phases in order: `Intermission` (30 s) → `Waiting` (15 s, the ball picker) → `Playing` →
`PostGame` (5 s) → `Intermission`. `Playing` has **no time limit**: it ends when one competitor is
left, and that competitor is the winner. A solo session therefore finishes about a second in, with
that player named — the rule as stated, not a fault. A competitor is eliminated by its centre leaving
the `EliminationZone`, by falling past its `KillY`, or by the cap destroying it; a whole-belt teardown
is not an elimination and notifies nobody.

Four debug keys drive it, one per phase, in phase order:

| Key | Effect |
| --- | ------ |
| `1` | Force `Intermission` from any phase: belt ramp stops, simulation stops, every body is cleared, the timer re-arms |
| `2` | Force `Waiting`: clears, then spawns one owned competitor per player and opens the picker |
| `3` | Force `Playing`. From `Playing` it restarts the competitors in place without restarting the round clock; from `PostGame` it refuses while the result is being cleared |
| `4` | Spawn one competitor per bound spawner, each with a **different** ball, refused outside `Playing` |

The client never decides a phase: every refusal is the server's, logged with the phase that caused
it, so a key that "did nothing" says why in one line rather than looking broken. Input is ignored
when `gameProcessedEvent` is true, so typing a digit into chat does not drive the machine.

The old `SpawnBall` remote and the manual spawn key are **gone**. Bodies are created by the round —
one per player at `Waiting`, plus whatever the debug keys draw — so `4` is the way to put a second
body on the belt for a collision test, and there is no longer a rate limit to hold down.

## Store, picker and inventory

The UI is hand-built `Instance`s across five screen layers with fixed draw orders
([`src/shared/ui/layers.ts`](src/shared/ui/layers.ts)). Fusion drives three controllers — the store,
the round-transition wipe and the phase banner — and big-ui supplies the banner's `Text` component
plus the theme tokens; there is no component library underneath the rest.

- **Picker** (`Waiting`): three offered balls, rolled on the server and stored there so the timeout
  pick refers to cards that really existed. A 10% chance upgrades the offer to the player's whole
  collection; a re-roll costs 3 coins, and a premium offer refuses one because a fresh premium roll is
  the same set.
- **Store and inventory** (rail tabs, visible only during `Intermission`): a coin chest at 100 coins,
  openable up to ten at a time in one save; one Robux chest whose pool is rare and above, behind a
  `PolicyService` gate; and an inventory with `Balls` and `Fusion` tabs. Fusion takes two balls and
  spends both, win or lose, and every chance shown is derived from the roll rather than written next
  to it.
- **Profiles** are DataStore-backed behind a per-player session lock: every verb saves *before* it
  reports, a failed save spends nothing, and a profile that cannot be loaded — or is locked by
  another session — goes read-only rather than retrying into it.
- **`/dev` admin** is a server-side chat command, `/dev setCoins <player> <amount>` or
  `/dev wipeData <player>`, and it is the only way to grant coins today.

## Ball powers

Every ball races with **exactly one power, fixed**. The table is [`src/shared/powers.config.ts`](src/shared/powers.config.ts) —
one entry per ball id, naming the power and its kind — and the rules are [`src/server/powers/`](src/server/powers/index.ts).

A body's power is written to a `Power` attribute at spawn, derived from the `ChosenBallId` the picker wrote, and rewritten
when the player's pick changes during `Waiting`. Everything else follows from that one attribute: the badge, the collision
group, the aura registration and the collision handler.

**The constraint that shapes all of it:** a ball's velocity is rewritten from its `BALL_SPEED` attribute every tick, so a
power is either a delta to that number, a direct write from a collision handler (safe because nothing writes between
ticks), or a change to the body the model cannot overwrite. A force, or a velocity written by a power, is erased within one
frame. `BALL_SPEED_MAX` in [`src/shared/tuning.ts`](src/shared/tuning.ts) is a safety net against a bully chain
accumulating without bound; it sits above every designed value and never binds in normal play.

| ball | power | kind | what it does |
| --- | --- | --- | --- |
| `bully_ball` | `bully` | collision | takes a share of the other ball's `BALL_SPEED` and keeps all of it |
| `bouncy_ball` | `bouncy` | passive | hops on the belt; the only power that never touches `BALL_SPEED` |
| `ghost_ball` | `ghost` | world | collides with walls and the belt, but not with other balls |
| `heavy_ball` | `heavy` | collision | drains more than it keeps, and loses half of what anyone else would |
| `decoy_ball` | `decoy` | world | spawns an identical twin that cannot win the round |
| `magnet_ball` | `magnet` | aura | balls near it decay faster |
| `rocket_ball` | `rocket` | timed | once per round, at a random moment, its speed snaps to a fixed boost |
| `recycle_ball` | `recycle` | pickup | takes a pickup's boost and **leaves the pickup in play** for the next taker |
| `eclipse_ball` | `eclipse` | timed | for a window, every opponent's decay is multiplied |
| `sprinter_ball` | `sprinter` | event | a pickup boosts it further than the standard value |

**Every ball destroys the pickup on first touch, except `recycle`, which is the one deliberate exception.** Consumption is
the default because a pad that survives a collection re-fires `Touched` on the ball resting on it, the boost is re-applied
every frame, and the ball can never decay off the belt — a Studio run showed one ball held for 71 seconds that way.
`recycle`'s pad is the resource the power is about, so it stays; the reason that is safe is not a guard but arithmetic:
`BALL_SPEED` is raised to the boost once and a second collection computes the same value, so the ball still decays on
schedule. `sprinter`'s higher boost is the only other difference between the pickup kinds.

### What each power is for

The table says what a power does; this says when to want it. Rarity is **not** an ordering — a common ball is the wrong
pick less often than a legendary one in the situations they are built for, and that is the point. Nothing below quotes a
magnitude: those live in the config, and a designer tuning them should read the config.

**`bully`** — *does* move speed from whatever it touches to itself, keeping all of it.
*Right pick* when the belt will be crowded, because the power only fires on contact and a crowded field is many contacts.
*Wrong pick* in a lane of its own, where nothing is ever touched and the ball is plain for the whole ride.

**`bouncy`** — *does* hop off the belt surface. It is the only power that changes nothing about `BALL_SPEED`.
*Right pick* — none today: being airborne costs nothing and gains nothing in this model, so the hop is character rather
than advantage. This is the mechanic as built, not a verdict on what the ball should be.
*Wrong pick* when you are racing to win, for the same reason.

**`ghost`** — *does* make the body intangible to other balls; walls and the belt still stop it.
*Right pick* in a field that can only hurt you, because it removes the one interaction that transfers speed away from you.
*Wrong pick* when you are the one doing the taking, since a ghost cannot collide with anything it would want to drain.

**`heavy`** — *does* drain more than it keeps, and halves what anyone else drains off it.
*Right pick* wherever contact happens, because it wins the exchange from both sides — it takes more and loses less.
*Wrong pick* in an empty lane, where the power never fires and its only remaining property is that it rides like any ball.

**`decoy`** — *does* put a second body on the belt that looks, moves and collides like the first but can never win.
*Right pick* in a busy field, where an extra identical body is one more thing for everyone else to react to.
*Wrong pick* in a small one, where the twin is obvious and the only effect is that a `MaxLiveBalls` slot is gone.

**`magnet`** — *does* make every ball near it decay faster.
*Right pick* alongside the field, because the aura is a radius and its whole value is having somebody inside it.
*Wrong pick* out in front, where nothing is within reach and it races as a plain ball.

**`rocket`** — *does* snap its speed to a fixed boost once, at a moment drawn at random after the green light.
*Right pick* in a round that lasts, because one large gift is worth more than a steady trickle and the moment has to arrive
before the race is decided.
*Wrong pick* in a short round, where the snap can land after the result is settled.

**`recycle`** — *does* take the standard pickup boost and leave the pad in the world, reusable by the next ball through it.
*Right pick* in a field where pads are contested, because a pad that survives is worth more to the field than to you — and
in a round that runs long, since one pad can be taken repeatedly instead of once.
*Wrong pick* in a lane you expect to cross alone, where keeping the pad alive denies nobody and hands the same boost you
just took to whoever follows.

**`eclipse`** — *does* multiply every opponent's decay for a window that opens partway through the round.
*Right pick* in a big field, because the effect applies to every opponent and its worth scales with how many there are.
*Wrong pick* in a field of one, where the window costs the field almost nothing and the ball spends its round as a plain
one.

**`sprinter`** — *does* take a larger boost from the same pickup.
*Right pick* in a lane whose pads you expect to reach, since the power is only ever a bigger version of something you have
to touch.
*Wrong pick* in a lane whose pads you will not reach, where it never fires at all.

### Collision groups — read this before debugging a collision

Every ball is moved into the **`CompetitorBall`** collision group, and a `ghost` ball into **`GhostBall`**. Balls are
therefore **no longer in `Default`**, which is a change to the scene's collision graph: belt, walls, the moving slab and
players stay in `Default` and still collide with both groups; `GhostBall` does not collide with `CompetitorBall` or with
itself. The groups are registered once, on the first spawn, by `src/server/powers/index.ts`.

### The power badge

Every body that carries a power also carries a `PowerBadge` `BillboardGui` naming it in uppercase. It is created on the
server, parented to the body (so `Destroy()` on the ball removes it), fixed-size, `AlwaysOnTop`, and floats
`POWER_BADGE_OFFSET_STUDS` above the ball's radius.

**A `decoy` twin carries all four of these too** — the `Power` attribute, the badge, the six face textures and the three
markers — because a decoy that looked different would be identifiable at a glance and the power would deceive nobody. It
still has **no owner attributes**, and that absence is what makes it an orphan rather than a competitor. The attribute and
the badge are applied through `presentPower`, never `setPower`: `setPower` also fills the aura registries and connects a
`Touched` handler, so a decoy made with it would project a real `magnet` or `eclipse` aura from a body the winner rule
cannot see. The decoy's `Power` attribute is a label; every mechanic that reads one either has no state for the decoy or is
cosmetic.

### The owner's outline

A `decoy` twin is indistinguishable from a real body to everyone — that is the power. Its **owner** is the one person who
cannot tell which of two identical balls they control, so they get a red `Highlight` on the twin and nobody else does.

That asymmetry cannot be an attribute: an attribute on the body replicates to every client, which would announce the twin
to the whole server. So the client invokes `ReplicatedStorage.Remotes.DecoyOutline` — the only `RemoteFunction` in this
tree — on entry to `Playing`, and the server answers **that caller only**, returning the twin's body or `nil`. A spectator
receives `nil`, creates no `Highlight`, and keeps seeing two identical balls.

The server answers from `BallSpawnerService.decoyFor(body)`, a server-side parent → twin map. An `Instance` attribute *can*
hold a reference, but reading one back yields an `InstanceHandle` rather than a `BasePart`, the handle reads `nil` once the
body it points at is destroyed, and the link would replicate to every client — so the map is the shape that answers the
question without any of that. An `OwnerUserId` on the twin is forbidden outright: it is the field `getCompetitors()` filters
on, so it would make the twin a competitor. Every request is logged with its reason (`wrong-phase`, `no-body`, `no-decoy`,
`not-owner`), because a client's `nil` cannot say which of four things happened. The outline is destroyed when the phase
leaves `Playing` and re-requested on the next entry — the previous twin was destroyed with every other body, so a cached
answer would point at nothing.

### The debug spawn (`4`)

`4` during `Playing` spawns one competitor per bound spawner, each with a synthetic `Debug#N` owner — and now each racing a
**different** ball. The four ids are drawn uniformly from `BALL_POOL` and are distinct within one press
([`src/server/debug-balls.ts`](src/server/debug-balls.ts)), so a single keypress exercises four powers at once. The draw is
made in `debugSpawnCompetitors` and nowhere else: `spawnBall`'s treatment of a missing `ChosenBallId` is unchanged, because
a fallback there would hand a power to the `decoy` twin, and a decoy that could project a live aura would freeze the field
from a body the winner rule cannot see.

One line names what you got, so a Studio run can be repeated rather than guessed at:

```
[Round] debug spawn: 4 competitors (Debug#1..Debug#4) balls=rocket_ball,magnet_ball,ghost_ball,sprinter_ball, live=5
```

The ids stream from `ChosenBallId` through `setPower`, so the badge, the collision group and the `Touched` connection all
follow automatically — nothing else had to be wired.

**`3` draws too.** `3` forces `Playing`, which is the one path into the round that skips `Waiting` — and `Waiting` is where
the picker writes a pick. Those competitors therefore had no ball id and arrived as powerless bodies. They now get drawn
ids using the same one-draw-of-`count` rule, and each is named by the existing per-body `[Picker] spawn … ball=…` line; a
`3` press does **not** print a `debug spawn:` line, because that line belongs to `4`.

### The model table

[`src/shared/models.config.ts`](src/shared/models.config.ts) maps every ball id to a model, and **every value is
`undefined` today**. Nothing reads it. It exists so a ball id added to `BALL_POOL` without a model fails the suite instead
of quietly drawing the same sphere as every other ball — see
[`src/shared/ball-tables.spec.ts`](src/shared/ball-tables.spec.ts), which cross-checks the pool, the powers and the models
in one pass.

## Studio-only acceptance checks

`npm run build` proves the code compiles and nothing else. These can only be confirmed by running the
place with your own parts:

1. Tag a belt and press `3` — the surface texture starts scrolling and reaches full speed over
   `BELT_RAMP_SECONDS`, while the ball holds station: the ramp is visual and the model's reference
   speed does not move.
2. Rotate the belt 90° in Studio — the drift direction rotates with it. Set `BeltSpeed = 0` and every
   ball rides forward instead, because nothing is subtracted from its `BALL_SPEED`.
3. Press `2` — one competitor per player appears in a lane and the picker opens with a countdown.
   Let the countdown expire and every player races their timeout pick.
4. Press `3` with one player — `PostGame` names that player a second later. One competitor left is
   the winner, whether the round started with one or with five.
5. Press `4` — one body per bound spawner appears, each with a different power badge, and a single
   `debug spawn:` line names every id it drew.
6. Let a body's centre leave the `EliminationZone`, and separately let one fall past `KillY` — the
   body goes, its owner sees the elimination splash, and the count never exceeds the smallest
   `MaxLiveBalls`. Raise the count past that cap and the oldest body is destroyed first.
7. Spawn a `decoy_ball` — a second ball appears beside it that you cannot tell from the first: same badge, same
   texture, same markers. The decoy still cannot win the round.
8. Spawn a `ghost_ball` and a `bully_ball` — they pass through each other; both still hit the walls.
9. Spawn a `bully_ball` and a `heavy_ball` and let them touch — the heavy ball ends up faster than the
   bully, and the pair's total speed falls.
10. Watch a `rocket_ball` — its badge reads `ROCKET` and its speed jumps once, at a different moment each
    round.
11. Cross a pickup with **any** ball — the triangle disappears, the log says `consumed=yes`, and no second
    `collected` line appears for the same ball.
12. Cross one with a `recycle_ball` instead — the triangle is **still there**, the log says `consumed=no`, and a
    second ball through it gets the same boost.

## Deliberately absent

No mesh or model support — every `model` in [`src/shared/models.config.ts`](src/shared/models.config.ts)
is `undefined`, and a test fails if a ball id has no entry, so the swap fails the suite rather than
drawing the same sphere. No client prediction: the server owns the velocity and every client sees the
result a round trip later. Audio is five UI sounds and nothing else — a button press, a granted purchase, a ball leaving
the belt, a ball-ball hit, and a pickup that actually raised a ball's speed (`src/shared/sounds.config.ts`) — with no
music, no ambience and nothing positional. The elimination sound is heard only by the player whose ball landed the last
touch on the body that left (or by nobody, if nothing touched it), because the sound means *you* put that body out. The
hit sound plays on every hit burst the client is told about. Three of them are throttled and with separate slots, so a
hit right after an elimination is still heard: the elimination and the hit at one start per half second, and the pickup at
one per 0.3 s — because a `recycle` ball resting on its surviving pad re-touches it every few milliseconds and re-raises
its decayed speed each time, which without an interval is a buzz rather than a sound. A click and a grant play every time.
Volume and pitch are per sound in `SOUND_TUNING` next to the ids — the hit is deliberately the quietest and the pickup sits
just above it — and they are applied when each `Sound` is built, not per play. No camera work.
**The only VFX are three:** the power badge, the decoy owner's outline, and
a ball-ball hit burst — one clone of the Studio asset `ReplicatedStorage.hitEffect`, built on each client at the contact
midpoint and destroyed by `Debris`. No trail or world aura for any power, because a `magnet` or `eclipse` aura is a
radius in a server-side registry and draws nothing — and no periodic `ghost` toggle. No in-round coin
earn path: coins start at 500, are spent by a chest or the picker's re-roll, and are granted only
through `/dev`.
