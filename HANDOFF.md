# Handoff

Numbered items in the order they landed. Append only; do not rewrite history. When a later item
resolves an earlier one, the earlier item gets a one-line pointer instead of an edit.

---

## 1. Repo stood up from the stock roblox-ts template

The repo was not empty when this started — it was the generated template (`rbxtsc` 3.0.0, Rojo 7.7.1
via Aftman, `src/{server,shared,client}`, `npm run build`). Missing: any Flamework wiring. Added
`@flamework/core`, the transformer plugin in `tsconfig.json`, `@flamework` in `typeRoots`, and the
`@flamework` scope mapped into the Rojo tree. The last one fails at _runtime_, not build time, if
forgotten.

## 2. Tags are the only coupling between scene and code

`TreadmillBelt`, `BallSpawner`, `Ball`. Both services bind through `CollectionService`, so no instance
paths appear in TypeScript.

## 3. Belt drag: first mechanism, superseded

This item described dragging balls with `AssemblyLinearVelocity` on the anchored belt. Studio refuted it (~0.1 studs/s², no rotation), it was replaced twice, and **the current belt is described in item 18**. No `AssemblyLinearVelocity` conveyor exists in the tree.

## 4. Balls are server-only and tagged at birth

Manual spawn goes through `ReplicatedStorage.Remotes.SpawnBall`, rate-limited 100 ms per player, one
ball per accepted call. The manual path never reads `Enabled`.

## 5. Stream loop could die silently and never restart

Found by source read after a "duplicating the spawner killed the stream" report. One shared
coroutine, no `pcall`, and `streamActive` was only cleared on a _clean_ exit — so an error left the
flag stuck true and `startStream` refused to restart forever. Fixed with per-spawner `xpcall`, a
whole-tick `xpcall`, a liveness (`coroutine.status`) guard instead of the flag, and a sampled tick
log. See item 8 for what the log then showed.

## 6. Rojo must not describe anything under `Workspace`

A `Workspace.TestFixtures` node pointing at `assets/TestFixtures.model.json` reset hand-placed parts
to hardcoded CFrames on every live-sync — the parts "kept moving back". File and node removed;
`Workspace` is childless, so `$ignoreUnknownInstances` defaults to true and Studio edits survive.
Parts are the designer's.

Related: `default.project.json` must stay strict JSON. Rojo accepts comments, roblox-ts's
`RojoResolver` uses `JSON.parse` and aborts the build.

## 7. Attributes are derived by code, not set by hand

Reversed the earlier stance (which had argued that services must never write attributes because it
makes state unanswerable from the place file). The cost of that stance was a tagged part doing
nothing until five values were typed by hand, which is indistinguishable from broken code. Now
`ensureDerivedAttributes` fills only _absent_ attributes at bind, so tagging is sufficient and
hand-set values are never overwritten. `Enabled` defaults to **true** for the same reason. `KillY` is
derived as `Workspace.FallenPartsDestroyHeight + 2 * Radius` instead of a picked `-50`.

## 8. The duplicate-spawner report, confirmed at runtime (see item 50)

Items 5 and 7 both plausibly explain "zero balls from the stream, manual fine" — a dead loop (5), and
`Enabled` being absent and read as `false` (7). The current bind log distinguishes them: it prints
`derived=...` plus every attribute, and the tick log prints `spawned N` per spawner once a second.
A third possibility remains untested and is _not_ addressed by code: two spawners at the same CFrame
with the same `Rate` emit balls at identical positions on the same tick, and overlapping collision
bodies get ejected — which looks like "no balls" with no error at all. If the tick log says
`spawned 1` while `live` climbs and nothing rests on the belt, separate the spawners in Studio.

**→ Confirmed at runtime — item 50.** The bind log now shows four ids resolving to the same
`GetFullName()`, and `bindSpawner` returns early on an instance it already holds, so the scene carries four
*distinct* spawner parts wearing one name (which is what `spawnerIds` exists for). The separation this item
asks for is a Studio edit, not a code change.

## 9. Not done, by design

No rounds, elimination, survivor tracking or win condition. No UI/Fusion/big-ui in use — the packages
are installed because the working-game dependency list requires them, and nothing imports them. No
ball randomisation, no belt ramp, no mesh support, no client prediction.

## 10. Diagnostic round 2: ownership, lane occupancy, spawner phase, cap destruction, collisions

Second instrumented round, run because round 1 (see the docblock in `ball-spawner-service.ts`)
established that some balls ride at `BeltSpeed` and some slide backward off the `-RightVector`
edge, but could not say why. This round added, temporarily and behind the same
TEMPORARY INSTRUMENTATION docblock:

- `owner=server|PlayerName auto=bool` on the spawn, first-motion, and leave lines.
- `occupants=N nearest=#id` at spawn: count of other `Ball`-tagged parts within
  `2 * Radius + OCCUPANCY_MARGIN_STUDS` of the spawn point.
- `due=N acc=<frac>` per spawner plus `elapsed=` on the sampled tick line, to separate shared
  accumulators from independent ones.
- `cap destroy` lines: position, local offset, `aboveSurface`, `insideFootprint`, velocity.
- `touches=N` at first motion, from a `Touched` connection dropped once the count is reported.

Answered from source before the run, so the logs are confirmation rather than discovery:

- **The spawners do not share an accumulator.** `pendingSpawns` is a `Map<BasePart, number>`, one
  cell per spawner. Perfect lockstep is arithmetic — identical `rate` and identical `dt` keep
  identical cells identical — not shared state. It is not a bug.
- **The cap destroys without checking position.** `enforceCap` takes `liveBalls[0]` and calls
  `destroyBall` unconditionally.
- **Nothing sets network ownership.** No `SetNetworkOwner`/`SetNetworkOwnershipAuto` in `src/`.
- **Balls are parented last**, after `Size`/`CFrame`, and nothing calls `WakeUp` or writes a
  velocity.

Already derivable from the round-1 log without this round, by arithmetic: at `Rate = 2` across four
spawners the stream emits 8 balls/s; a ball needs roughly 7 s (≈1 s to settle, then 56 studs at
10 studs/s) to reach the exit edge, so sustaining the stream requires ≈56 balls in flight against a
cap of 50. The cap therefore always governs, and ball 1 — last sampled at local X = 17.087, still
inside a 28-stud half-width — was destroyed by the cap while riding. **The current "elimination" is
`MaxLiveBalls`, not the belt edge.** Fixing that is a later prompt, not this one.

Resolution: pending the Studio run.

## 11. Shape pool landed; belt + ball textures and the sanctioned belt bounce

Item 10's diagnostic round is superseded in part: the pooled-shape work it was surveying was
half-applied and left the tree non-compiling, and this round finished it before adding the visuals.

Landed:

- `src/shared/shape-pool.ts` — `SHAPE_POOL` (Ball 1x1x1, Cylinder 1x1x2, Block 1x3x1,
  CornerWedge 1x1x1), uniform pick, `randomSpawnRotation` (Shoemake quaternion, not Euler),
  `rotatedHalfHeight`, `poolMaxExtent`.
- `Radius` retired from derived attributes; `KillY` now derives from `poolMaxExtent()`.
  `src/shared/attributes.ts` carries the reversal in place.
- `src/shared/tuning.ts` — belt/ball texture ids and tile size, bounce impulse/chance/cooldown.
- `TreadmillService` creates one `Texture` on the belt's `Top` face at bind, removes it at
  unbind, and connects `Touched` for the vertical-only bounce with an age-pruned cooldown map.
- `BeltScrollController` (client) scrolls `OffsetStudsU` at `BeltSpeed`, wrapped modulo the
  tile size.

**Superseding note on item 10's cap finding.** The cap-elimination problem is still there and still
deferred; one-object-per-round makes it moot, so nothing in this round touches it.

**Open, Studio-only:** whether `rbxassetid://6691394` and `rbxassetid://12971963723` resolve to
usable images at all, whether a `Texture` on a primitive sphere's six faces reads as a painted
ball rather than as six patches, and whether `BELT_TEXTURE_SCROLL_SIGN = -1` scrolls with the balls
or against them. The sign is one constant precisely so it can be flipped without touching logic.

## 12. Shape pool restricted to spheres only

Reversal of item 11's pool. The spawner now spawns `Part` spheres and nothing else; `SHAPE_POOL`
in `src/shared/shape-pool.ts` holds a single `Ball` entry.

Why: item 11 landed a four-entry pool because a prompt's Context asserted spheres when the tree
already had a half-finished pool. The designer's actual instruction was and is spheres only, with the
mesh/shape question deferred. The pool _structure_ stays — `randomSpawnRotation`,
`rotatedHalfHeight` and `poolMaxExtent` are all still load-bearing (spawn rotation, spawn
clearance, `KillY`), and re-adding a shape later is one array entry.

The survey reasoning that argued for Cylinder/Block/CornerWedge (item 10, and the shape-variety
report) is kept as history in the module docblock rather than deleted: the measurements are still
correct and will be reused when meshes land.

**New finding, not fixed:** `rotatedHalfHeight` measures the rotated _box_, so a randomly rotated
1x1x1 sphere evaluates to a half-height in `[0.5, 0.866]` instead of the true constant `0.5`.
Balls therefore spawn 0 to ~0.37 studs higher than the old unrotated spawn, varying randomly per
spawn. Safe (never intersects) but not tight, and with a singleton sphere pool it is pure noise. The
one-line fix is recorded in that function's docblock and deliberately not applied — spawn clearance
was out of scope for this round.

## 13. Diagnostic round 3: instrumented belt/ball texture creation and the scroll controller

User reported, from Studio Play, that **no `Texture` child appears on the belt** while both asset
URLs load as valid images. This round adds logging only — no fix.

Three findings before the run:

- **The belt texture path is not conditional.** `attachBeltTexture` runs unconditionally inside
  `bind` after the reuse check; the only guard is `FindFirstChild("BeltSurface")` returning an
  existing instance. Candidate 1 from the report ("behind a conditional that fails") is therefore
  ruled out by source.
- **`Texture`/`Decal.ColorMapContent` is `NotReplicated`.** Confirmed from the API reference
  ("This property is not replicated. Its interface does not cross the network boundary"). Both
  textures are configured **on the server**, so even when creation succeeds, clients — and therefore
  the rendered surface — receive the `Texture` instance with **empty content**. This is a real bug
  and it survives any fix to the creation path: the content has to be applied client-side. Not fixed
  here.
- **The scroll controller waited forever.** It used `WaitForChild("BeltSurface")` with no timeout,
  so a server-side failure produced an infinite silent yield — indistinguishably from "not replicated
  yet". Now bounded at 10 s with a `GAVE UP` warning.

Discriminator for the next run: `attachBeltTexture` runs **before** `applySpeed`, so a throw there
also suppresses the `[Treadmill] bind` line and stops the belt dragging. `texture: start` with no
`bind` = it threw at creation. No `texture: start` at all = `bind` was never reached.

Appended rather than rewriting: item 12's spheres-only constraint and item 11's texture work are
unchanged by this round; it only adds logging.

## 14. Texture invisibility: cause found — only the underlying property was written

The round-13 log settled it. Creation succeeds completely:

```
[Treadmill] texture: start belt="Workspace.Part" ... existingChild=false
[Treadmill] texture: created ClassName=Texture name=BeltSurface parentBefore=none
[Treadmill] texture: properties applied Face=Top uri=rbxassetid://6691394
[Treadmill] texture: parented to "Workspace.Part" isChildOfBelt=true childrenOfBelt=1
[Treadmill] bind "Workspace.Part" ... appliedVelocity=(10, 0, 0)
[BeltScroll] found Workspace.Part.BeltSurface ... uri=rbxassetid://6691394 face=Top tileU=4   (Client)
```

So: instance exists, replicates, content set on both sides, correct face, correct tile size, belt
still dragging. Both asset ids verified externally as **AssetTypeId 13 (Decal)** — they are images.

**Cause:** `Decal` exposes four image slots. `ColorMapContent: Content` and `ColorMap: ContentId`
are the new pair; `TextureContent: Content` and `Texture: ContentId` are the legacy pair. The code
set **only** `ColorMapContent` — the underlying API property — and the renderer in the shipped build
reads the legacy alias. Corroborated on the DevForum: Explorer matches `Texture`/`ColorMap` but not
`ColorMapContent`, i.e. the aliases are what the rest of the engine actually surfaces.

**Fix (applied, one line per texture):** set `ColorMapContent` _and_ `Texture` (legacy string) with
the same URI, for both the belt and the six ball textures. They cannot conflict — same URI — and either
slot being honoured is enough. Read-backs of all four slots plus the part's own `Transparency` /
`Material` / `TopSurface` are logged, so a transparent belt is distinguishable from an untextured one.

No other behaviour touched: bounce, drag, pool, cap and cleanup are unchanged.

## 15. Welded pole markers + equator ring on every spawned body

A sphere has no features, so a rolling ball is visually identical to a static one. Textures were the
first attempt and did not render on the curved primitive; this replaces that approach for _proving
rotation_ with ordinary geometry.

Per spawned body, three welded Parts:

- `NorthPole` / `SouthPole` — `Shape = Ball`, `Size = Vector3.one × (radius × 0.3)` (0.15 studs
  at the placeholder radius), centred on the surface so half protrudes.
- `Equator` — `Shape = Cylinder`, `Size = (0.1, radius × 2.1, radius × 2.1)`, rotated 90° about Z
  so the cylinder's X axis (documented as its axis) stands vertical, giving a horizontal band.

All three: `CanCollide = false`, `Massless = true`, `Anchored = false`, `Material = Neon`,
tagged `BallDecoration`. Welded with `WeldConstraint` (`Part0` = body, `Part1` = marker) — it has
no `C0`/`C1` because it preserves the relationship present at creation, so the offset comes from
positioning the marker first.

**Parented as children of the body**, so `Destroy()` on the body removes them. A welded sibling would
survive its body and accumulate at spawn rate.

Ordering: body is parented first, then each marker is parented, then its constraint is created — so the
constraint always sees two parts in the DataModel.

Untouched: ball size, material, `CanCollide`, `Anchored`, spawn CFrame, rate, cap, kill plane,
bounce, shape pool, textures. `TAGS` gained `ballDecoration`.

## 16. One-shot spawn on Play replaces the timed stream

Spawned bodies now come from exactly one automatic spawn per bound `BallSpawner`, at server start.
No timer, no second body. `spawnOnePerSpawner` calls the existing `spawnBall` once per spawner from
`onStart`, after every spawner is bound, with per-spawner failure containment.

**`Enabled` and `Rate` are removed**, not left derived-but-unread — this file's own rule is that a
visible-but-inert attribute is worse than none. The `attributes.ts` docblock was rewritten in place
(third position on `Enabled`: `false` — `true` — retired).

Why: `Rate = 2` — 4 spawners against `MaxLiveBalls = 50` was a permanent 8-body/s mosh pit in four
lanes, where body-body collisions and the 1 s bounce cooldown interrupted rolling every ~150 ms. Every
observation about rolling-vs-sliding was being made inside it. Manual `1` still spawns extra bodies
(rate-limited as before) for collision tests.

## 17. Rolling survey findings (no code changed)

- **No part-level angular damping exists.** `AngularDamping` appears only on `AnimationConstraint`;
  `MaxAngularVelocity` only on `AlignOrientation`. Nothing in `src/` touches either. Cause 3 in
  the survey is ruled out by property availability, not just by absence of code.
- **`Shape = Ball` collisions are exact**, per the API reference: "Collisions between balls, blocks,
  and wedges, and corner wedges are exact".
- **The 66 ms rolling-onset figure is correct**, but the prompt's target `≈ 20 rad/s` assumes a
  _stationary_ surface. For a belt moving at `u`, no-slip means `v + ωr = u`, so the settled state
  of a sphere released from rest is `v = (2/7)u ≈ 2.86` with `ω = (u - v)/r ≈ 14.3 rad/s` — not
  `v = u` with `ω = u/r`. The correct discriminator is contact slip `u - (v + ωr)`.
- **Prior logs are consistent with COM-force, not contact torque:** the along-belt component reached ≈10.2 while
  the markers showed no visible rotation, i.e. `v ≈ u` with `ω ≈ 0`. Under contact friction the ball
  would settle at `2u/7` _with_ strong spin. Mechanism hypothesis 1 is therefore the leading cause.
- Next measurement, not yet taken: `AssemblyAngularVelocity` on a single body, plus `u - (v + ωr)`.

## 18. Belt as a reference number: `BALL_SPEED` / `BELT_SPEED` / `RELATIVE_SPEED`

**This replaces every earlier belt mechanism** — the anchored-velocity conveyor (item 3), and the invisible motorised slab that followed it. There is no moving surface, no constraint, no per-belt `Heartbeat`, no teleport reset and no pinned network owner. Under the belt sits one **static, anchored, frictionless floor** (`CustomPhysicalProperties`, friction 0) whose only job is to be something gravity can settle a ball against.

`BELT_SPEED` (the belt's `BeltSpeed` attribute, 10) is a **reference number**. Each ball carries `BALL_SPEED` as an attribute, seeded at `BALL_SPEED_START` (10) and decayed toward `BALL_SPEED_MIN` (0) at `BALL_SPEED_DECAY_RATE` (0.3 studs/s²) every tick by `BallSpawnerService.stepBallSpeeds`. Each tick the ball's velocity along the belt is set to `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`, with gravity and sideways drift preserved. Zero is stationary, negative loses ground toward the exit, positive gains it back toward the spawn end. Decay runs toward zero, not a terminal value, so every ride is finite.

**The ramp is a visual effect only.** `RoundService` still ramps 0 → 10 on `Playing` entry, but that value is published as `BELT_VISUAL_SPEED` (`BeltSpeedActual`) and read by `BeltScrollController` alone; `stepBallSpeeds` reads `getReferenceBeltSpeed()`, so `RELATIVE_SPEED` is exactly `0` on the first `Playing` tick. They were one number for one round, and that made every ball drift forward for the first three seconds of every round with no pickup involved. `[Treadmill] bind` prints both.

Pickups raise `BALL_SPEED` to `BOOST_TARGET_BALL_SPEED` (12) — above the reference, which is what flips `RELATIVE_SPEED` positive; see item 42. **Unverified in Studio.**

## 19. Belt surface material: no longer applicable

This item set the movable slab's material to Rubber to raise friction. There is no movable slab and no friction any more (item 18) — the floor is friction 0 by design, so the surface cannot fight the velocity model. The bounce assist stays gated off behind `BELT_BOUNCE_ENABLED = false`.

## 20. Manual trigger now spawns one body from every bound spawner

Pressing `1` previously spawned from the first registered spawner only (`firstSpawner`), which with four spawners meant three lanes never got a manual body. The manual path now calls the shared `spawnOnePerSpawner("manual")` — the same implementation as the start-of-session one-shot, parameterised only so the summary log line names the trigger. `firstSpawner` deleted; the 100 ms per-player cooldown is unchanged and still gates the whole press, not per spawner. **Unverified in Studio.**
## 21. Backspin on ball-ball collision

Each spawned ball connects a `Touched` handler; when the other part is tagged `Ball` it adds `BALL_BACKSPIN_IMPULSE` rad/s about `belt.RightVector:Cross(yAxis)` (= `+Z` on a `+X` belt — the sign that puts the contact point ahead of the belt and reverses friction). Per-ball 0.25 s cooldown; impulse applied to self only, so the symmetric `Touched` pair gives each ball exactly one impulse per collision. No spawn-time spin. One log line per impulse reports `slip = v + w*r - u` so a single run settles the sign. **Impulse is 60 rad/s, not the 15 first suggested — 15 only slows the ball (6.4 -> 4.3), it cannot reverse it; see the derivation in `tuning.ts`. Unverified in Studio.**
## 22. Backspin fixed: converge to a target slip instead of adding a fixed impulse

Studio log for item 21 showed the additive `60 rad/s` impulse was wrong in two ways: it **accumulated without bound** (428 impulses across 20 balls, `omega*r` climbing 30 -> 56.6, because a ball resting against another re-fires `Touched` indefinitely and the 0.25 s cooldown only spaces repeats out), and **a single impulse was already ~8.6 studs/s** of reverse (`dv = -slip/3.5` for a sphere, `slip = 30`). 14 of 18 balls were thrown off the back edge, most within 0.6 s. Replaced with `BALL_BACKSPIN_TARGET_SLIP = 15`: the handler computes current slip and adds only the deficit, so repeat contacts are no-ops. Predicted `dv = -15/3.5 = -4.3` studs/s, landing a ball at equilibrium (`v = 2.86`) at roughly `-1.4` backward. Log line now reports `slip before -> after` and `predictedDv`. **Unverified in Studio.**
## 23. Wall assist: convergent forward boost on `TreadmillWall`-tagged parts

Sentinel line for item 23. Per-wall `Touched` connection in `TreadmillService` (2 connections for 2 walls, vs one per ball), filtered to `HasTag(TAGS.ball)` so ball-ball backspin is untouched. Impulse is `min(WALL_ASSIST_IMPULSE, WALL_ASSIST_TARGET_SPEED - v)` along the nearest bound belt's `+RightVector` — **convergent, so sustained wall contact cannot compound** (unlike item 21's additive backspin). Target 8 studs/s is below `BeltSpeed = 10` so a wall cannot drive a ball past the belt. Cooldown 1.5 s is a rate control, not the safety bound. Cooldown map keyed by ball, age-pruned (no destroy hook needed). **Unverified in Studio; walls must be tagged `TreadmillWall` by hand.**
## 24. Wall assist is now a sustained `VectorForce`, not a velocity impulse

`WALL_ASSIST_IMPULSE` and `WALL_ASSIST_COOLDOWN_SECONDS` deleted; `applyWallAssist` replaced by `startWallPush`/`stopWallPush`. A `VectorForce` (`RelativeTo = World`, `ApplyAtCenterOfMass = true`, `Force = mass x WALL_ASSIST_ACCELERATION` along the belt's `+RightVector`) is created on `Touched` and destroyed on `TouchedEnded`; the per-ball map lookup makes repeat `Touched` idempotent, so no cooldown is needed. `WALL_ASSIST_ACCELERATION = 5` studs/s². `WALL_ASSIST_TARGET_SPEED = 8` was **reinstated** (the prompt deleted it) because constant force has no ceiling: 10 s of contact is 50 studs/s and a full-belt ride exits at 23.7. The target check runs in the `Touched` handler, which already re-fires during contact, so no `Heartbeat` poll. **Unverified in Studio.**
## 25. Wall assist reverted to `applyBackspin`'s pattern: convergent velocity delta, no force

The `VectorForce` mechanism from item 24 produced no observable acceleration in Studio, so it is deleted entirely — `startWallPush`/`stopWallPush`, the `Touched`/`TouchEnded` connections on wall parts, `wallForces`, the attachment, and `WALL_ASSIST_ACCELERATION`; `TreadmillService` no longer binds `TreadmillWall` at all. Replaced by `attachWallAssist`/`applyWallAssist` in `ball-spawner-service.ts`, a near-copy of the working `applyBackspin`: one `Touched` per ball, `HasTag(TAGS.treadmillWall)` filter, `nearestBeltTo` for the belt (the same per-event lookup backspin uses), then `delta = min(WALL_ASSIST_IMPULSE, WALL_ASSIST_TARGET_SPEED - v)` along `+RightVector`. No cooldown, no timestamp, no force — the convergence check is the gate. `WALL_ASSIST_IMPULSE = 1` added; `WALL_ASSIST_TARGET_SPEED = 8` kept. **Unverified in Studio.**
## 26. RoundService: four-phase machine, belt ramp, positional elimination

New `src/server/services/round-service.ts` (`Idle → Countdown → Running → Ended → Idle`) plus `StartRoundController` on key `2`. Balls now exist only inside a round: the spawner's automatic one-shot at server start is **removed**, and `1` is gated on `Running`. The two surfaces future powers use are `onTick(cb): () => void` (1 Hz, `Running` only) and `getElapsedSeconds()` (frozen during `Ended`). Elimination is **positional only** — `EliminationZone` bounding box with each axis shrunk by the body radius, checked on the 1 Hz tick; `TreadmillWall` is never consulted and no wall `Touched` signal is involved. `Instance.Destroying` on every tracked body is what lets the end condition notice deaths the round did not cause (cap, `KillY`). Belt is stopped outside `Running` and ramps linearly on a **separate Heartbeat** connection, via a new `TreadmillService.setBeltSpeed(n)` override. `SHAPE_POOL` gained an unread `power?: string` seam. **Unverified in Studio.**
## 27. Backspin gated on effective belt speed

`applyBackspin` now returns before any slip calculation unless `TreadmillService.getEffectiveBeltSpeed() >= BALL_BACKSPIN_MIN_BELT_SPEED` (new constant, `5`, absolute not relative to `BeltSpeed`; the 3 s ramp crosses 5 at 1.5 s into `Running`). The gate reads the **ramped** value via a new narrow public accessor, not `getBeltSpeed()` — the latter returns the designer's attribute, which is `10` for the whole round and would leave the gate permanently open. Belt speed alone was chosen over belt speed plus `RoundService.getPhase() === "Running"`: the round writes `setBeltSpeed(0)` outside `Running`, so the speed test implies the phase test, rejects the ramp as well, and avoids a `BallSpawnerService` -> `RoundService` require cycle. Rejected calls are silent; skip is not an error. `BallSpawnerService` now injects `TreadmillService` for that one read. Slip, target, `AssemblyAngularVelocity` write and the `Touched` connection are unchanged; the slip still measures `u` from the attribute, so spin is under-applied while the belt sits between 5 and 10. **Unverified in Studio.**

## 28. Inspiration — the trend this models

Recorded so the numbers in this file have a stated source instead of looking like arbitrary tuning.
Everything built here is a simulation of one specific thing: produce and household objects dumped
onto a fast treadmill to see which one survives.

> **The "Fruit Treadmill Game" is a viral social media trend where various fruits, vegetables, and
> household items are placed onto a high-speed moving treadmill belt to "race" or battle for
> survival.**
>
> Core Mechanics
>
> - **Setup:** A treadmill is set to a high speed (often up to 12 mph) while a creator places
>   multiple produce items on the belt simultaneously.
> - **Elimination:** Items bounce, roll, collide, and get thrown off the back of the machine. Heavy
>   items like watermelons or pineapples frequently crush smaller items or explode upon impact.
> - **Objective:** The last item remaining on the treadmill belt wins the round.

What maps onto it, and what is deliberately absent:

- **Setup** is `BallSpawner` plus `RoundService.start()` — one body per bound spawner, dropped at
  `Countdown` entry so every racer lands on a stationary belt at the same instant, which is the
  trend's "place them all on at once" beat.
- **Elimination** is the belt doing its own work plus the positional `EliminationZone` test. Nothing
  in the code throws a body off the back; the belt carries it past the edge and the zone notices.
  That is why `TreadmillWall` is a barrier and never a boundary — the wall is the trend's guard
  rails, which also do not eliminate.
- **Objective** is `[Round] ended: winner=...` — last one standing. The co-winners outcome on the
  60 s timeout is the one deliberate divergence: a real belt never stops, but a round has to.
- **Not modelled:** crushing, shattering, and mass differences between object types. `SHAPE_POOL`
  has a single `Ball` entry, so every racer is identical and the variety has to come from the scene
  and from collisions rather than from the objects. The "watermelon crushes the grape" mechanic is
  the obvious next slice.
- **Speed note:** if 1 stud is ~0.28 m, `BeltSpeed = 10` is ~2.8 m/s, ~6.3 mph — about half the
  12 mph in the source. Raise `BeltSpeed` if fidelity to the trend matters more than the current
  measured ~5.1 s traverse. The conversion is an assumption, not a Roblox constant.

This item records no code change and needs no Studio run; it is the source concept the other items
implement.

## 29. Marker spin decoupled from the body: anchored markers, client-drawn rotation

`BallSpawnerService.createMarker` no longer creates the `WeldConstraint`. Each marker is `Anchored = true` at its spawn pose and carries three `Vector3` attributes (`MarkerLocalPosition`, `MarkerLocalRight`, `MarkerLocalUp` — `ball.CFrame:ToObjectSpace(spawnCue)`), because with no weld a client cannot recover the local offset: the marker stays at spawn while the body moves, so `body.CFrame:Inverse() * marker.CFrame` is only correct in the spawn frame. Anchoring is the mechanism that was chosen over a client-side weld destroy because a client write to the `CFrame` of a *simulated* part is overwritten by the solver, while a client write to an anchored part whose `CFrame` the server never touches again is uncontended. New `MarkerSpinController` (`src/client/controllers/marker-spin-controller.ts`) draws all three markers per body on `RenderStepped` from smoothed `CFrame`-delta velocity — **not `AssemblyLinearVelocity`, which the installed typings tag `NotReplicated`** — at `APPARENT_SPIN_GAIN = 2` × `v/r`, clamped to `APPARENT_SPIN_MAX_RAD_PER_SEC = 30`, deadband `APPARENT_SPIN_MIN_SPEED = 0.1`, smoothing `APPARENT_SPIN_SMOOTHING_SECONDS = 0.15`. Axis is `yAxis:Cross(vhat)`, verified as *forward* rolling (for `+X` travel it is `-Z`), which is the negation of `applyBackspin`'s `RightVector:Cross(yAxis)`; `APPARENT_SPIN_SIGN = 1` exists so the direction is one edit to reverse. The drawn rate is a display choice, not physics: a sliding body now renders as rolling, so `[Spawner] spin-probe` prints `|omega|`, `omegaR`, `BALL_SPEED`, `u` and `contactSlip = u - (BALL_SPEED + omega*r)` once per body at 2 s to preserve the rolling-versus-sliding diagnostic. Ball textures are still applied (six per body, `attachBallTexture` unchanged) and item 14/15 disagree about whether they render; if they do, they will rotate at the physical rate underneath markers drawn faster, and the call — not the property — is what would have to go. **Unverified in Studio.**

## 30. Marker spin round 2: dual velocity source, tag rescan, and a read-back probe

The first marker-spin build produced no visible movement. The Studio log showed `[MarkerSpin] controller started ... found=0` and then **nothing** — no warn, no state line, no error — so it could not distinguish "tracking never happened" from "writes are being reverted" from "the spin rate is zero". Four changes, all diagnostic-first. (1) Discovery is now repaired by a 0.5 s `CollectionService.GetTagged` rescan plus a `Set` of tracked markers, because the first build relied solely on `GetInstanceAddedSignal` for an instance that arrives from the server *already tagged*, and a missed event had no second chance. (2) The velocity sample now reads **both** `AssemblyLinearVelocity` and the `CFrame` delta and takes the larger magnitude: the typings' `NotReplicated` tag governs property replication, not the physics stream, so for a client-owned body (the log reports `owner=<player>`) the property is the client's own simulation and is the smoother source, while the delta is quantised to the physics step and reads exactly zero on a frame where no step landed. (3) A capped `[MarkerSpin] state` line, once a second for twelve seconds, reports `bodies`/`tracked`/`markers`/`source`/`speed`/`omega`/`angle`/`bodyPos`/`markerPos`/`writeError` — the last of which is `|intended - actual|` read back after the write, the single number that separates "the client cannot pose a server-owned anchored part" from "the pose is fine and the rate is the problem". (4) A one-shot `warn` when that error exceeds 0.05, stating the conclusion rather than leaving it to be inferred. **Unverified in Studio.**

## 31. Marker-spin discovery: already working; the instrumentation was the fault

The prompt's premise was that the controller never discovers markers after startup. **Source and the run's own log say otherwise.** The controller has had `CollectionService.GetInstanceAddedSignal(TAGS.ballDecoration)` since item 29, and the 20:16 run shows `[MarkerSpin] track marker="Workspace.SpawnedBalls.Ball.SouthPole" body="Workspace.SpawnedBalls.Ball"` three times at `20:16:21.165`, i.e. **33 ms after** the round logged `Idle -> Countdown` at `20:16:21.132` — discovery happens in the same frame the bodies are parented. What was actually broken was my logging: the once-a-second `state` line spent all twelve of its lines between 20:14:35 and 20:14:46 reporting `bodies=0 tracked=0 tagged=0`, while the first ball did not exist until 20:16:21, so the run that discovered every marker correctly printed nothing about them. The `found=0` at startup is likewise correct and expected — the client has received no scene yet (the belt controller reports the same, 1.9 s before the belt itself replicates).

Changes: the line is now `[MarkerSpin] discovered <path> body=<path> bodyTaggedBall=<bool> localPos=<v>` and prints **before** the parent guard, so a wrong tag is visible as `bodyTaggedBall=false` rather than as silence; a 30-frame `boot f=N` trace starts at the first *usable* marker and reports `|v|`, `source`, `speed`, `omegaVisual`, `angle`, `bodyPos`, `markerPos` and `writeError`; the empty-state line prints once instead of once a second; the state budget is no longer spent while no body is tracked; `MARKER_SPIN_DISCOVERY_TIMEOUT_SECONDS = 10` measured from the **first ball**, not from `onStart` (the gap was 108 s, so an `onStart` clock would report a failure that had not happened), and a single `GAVE UP` line names the count seen. Teardown: **Flamework v5.9.3 has no `OnStop`** — verified in `flamework.d.ts`, which exports only `OnInit`/`OnStart`/`OnTick`/`OnPhysics`/`OnRender` — so every connection is collected and dropped on `game.Destroying`, which is belt-and-braces because a Studio stop destroys the client DataModel anyway. Tuning untouched. **Unverified in Studio.**

## 32. Marker spin model replaced: scaled physical spin plus an offset

The velocity-driven model is gone. The rate is now `omega = min(APPARENT_SPIN_MAX_RAD_PER_SEC, SPIN_RATE_OFFSET + APPARENT_SPIN_GAIN x |AssemblyAngularVelocity|)` with `SPIN_RATE_OFFSET = 8` and `APPARENT_SPIN_GAIN = 3`, both Placeholder. It was replaced **because the probe proved physical spin is zero**: `|omega| = 0`, `omegaAlong = 0`, `contactSlip = 10` on every body, so a rate proportional to spin (old model: proportional to translation, which was also ~0) had nothing to show. The offset is the term that makes a parked or sliding ball's markers turn. `APPARENT_SPIN_MIN_SPEED` (the 0.1 deadband) is **deleted** — nothing else read it, and the noise it guarded against is no longer in the rate path. `APPARENT_SPIN_MAX_RAD_PER_SEC` is **kept at 30, against the round's suggested 60**: 60 rad/s is ~9.5 rev/s, past the ~5 rev/s aliasing point where three markers read as turning backwards, so raising it would trade under-drawing for apparent reversal. Axis resolution is three-deep and documented: physical spin above `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC = 0.05` uses `AssemblyAngularVelocity.Unit`; otherwise travel above `SPIN_FALLBACK_MIN_SPEED = 0.5` uses `yAxis:Cross(vhat)` (forward rolling, the negation of `applyBackspin`'s `RightVector:Cross(yAxis)`); otherwise the belt's own `yAxis:Cross(belt.RightVector)` via a cached tag lookup, with `(0,0,-1)` as the last resort for a client that has not received the belt yet. `APPARENT_SPIN_SIGN` multiplies all three so a ball crossing from sliding to rolling does not reverse. Added: one `[MarkerSpin] owner` line per body at first draw (`GetNetworkOwner`, `ThreadSafety: Safe` per typings) so a future round can tell a non-owning client's stale `AssemblyAngularVelocity` from a model bug without new instrumentation; `boot f=` and `state` lines now carry `omegaPhysical`, `axis=<physical|travel|belt>` and `r=`. Also added a re-orthonormalisation of the accumulated spin every 300 frames, because the offset term makes the rotation multiply **every** frame — ~288,000 times in a ten-minute session — and a drifted basis moves markers off the sphere's surface, which would read as a new bug rather than as float error. **Unverified in Studio.**

## 33. Marker spin model 3: three branches, deadband at 0.5, offset deleted

**Supersedes the rate model of items 29–32 without editing them.** Item 32's formula
(`SPIN_RATE_OFFSET + APPARENT_SPIN_GAIN x |AssemblyAngularVelocity|`, offset `8`, gain `3`) is no
longer in the tree: the offset is deleted and both gain names now mean different things. Items 29–31
remain accurate about discovery, the anchored markers, the local-offset attributes and the log lines —
only their description of the rate is stale, and only this item should be read for it.

Rate is now a branch chain, in this order: **physical** `min(30, APPARENT_SPIN_GAIN_OMEGA x |omegaPhysical|)` above `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC = 0.05`; **velocity** `min(30, APPARENT_SPIN_GAIN x |v| / radius)` above `SPIN_DEADBAND_SPEED = 0.5`; **deadband** `0`. `SPIN_RATE_OFFSET` is **deleted, not zeroed** — nothing else read it, and this file's rule is that an inert constant is worse than none; `SPIN_DEADBAND_SPEED` takes its place and its docblock records the reversal (a parked ball must not spin). `APPARENT_SPIN_GAIN` is re-purposed to `|v| / radius` at `4`; the new `APPARENT_SPIN_GAIN_OMEGA = 3` multiplies `|omega|` in the physical branch, kept separate because the units differ (`rad/s` per `rad/s` vs `rad/s` per `(studs/s)/stud`). `APPARENT_SPIN_MAX_RAD_PER_SEC` stays `30`. The physical branch is **first** so a genuinely rolling body is never drawn from its translation, and so the model becomes physical with no code change once the belt imparts spin; today it always falls through, since every probe reports `|omega| = 0`. `omega = 0` is provably inert rather than approximately so: `CFrame.fromAxisAngle(axis, 0)` is the identity and `angle += 0 * dt` adds nothing, so a parked ball's pose is preserved bit-for-bit. Logs gained `rateSource=<physical|velocity|deadband>` alongside the existing `axis=<physical|travel|belt>`. Discontinuity worth knowing: at the threshold the rate steps `0 -> 4` rad/s (~0.64 rev/s) because the branch is hard, so no-jump is true of the *speed* crossing (smoothed over 0.15 s), not of the rate. **Unverified in Studio.**


## 34. Round machine renamed to a game loop; timers, broadcast, and `2` as a debug advance

**Supersedes the phase names and the `start()` API of item 26, and the belt-gate prose of items 27 and 33 where they name a phase.** No alias survives: `Idle`/`Countdown`/`Running`/`Ended` are gone from `src/` except in three sentences that *record the rename itself* (round-service's class docblock, `advance-phase-controller`'s "previously" note, and `PLAYING_CAP_SECONDS`'s "renamed from" note) — none of those is a live state.

The loop is now autonomous rather than keypress-driven: `Intermission` (30 s, `INTERMISSION_SECONDS`) ? `Waiting` (15 s, `WAITING_SECONDS`) ? `Playing` (cap 60 s, `PLAYING_CAP_SECONDS`) ? `PostGame` (5 s, `POST_GAME_SECONDS`) ? `Intermission`. `COUNTDOWN_SECONDS` (3) became `WAITING_SECONDS` (15), `ROUND_DURATION_SECONDS` (60) became `PLAYING_CAP_SECONDS` (60, value preserved), `END_HOLD_SECONDS` (5) became `POST_GAME_SECONDS` (5). Bodies still spawn at `Waiting` entry and the belt is still zero outside `Playing`; the `Playing` end condition is **unchanged from item 26** — no survivors / one survivor when more than one started / cap expired with co-winners.

**Intermission does not advance with zero players.** It checks `Players.GetPlayers().size() === 0` at expiry and re-arms the same duration, logging `Intermission timer restarted ? no players connected`, so an hour-empty server is still in `Intermission` on the first join rather than arriving into someone else's `PostGame`.

**Broadcast:** `ReplicatedStorage.RoundState`, a `StringValue` written by `publishPhase()` immediately after each transition's log line. Chosen over a transition-only remote because a client that starts between two transitions would never learn the current phase — a replicated value is a *state*, so one read after `onStart` is always correct. `RoundStateController` logs `[RoundState] initial=<phase>` and `[RoundState] <phase>` per change, so "the server changed phase" and "clients saw it" are distinguishable in one log.

**`2` is now a debug advance, not a start.** `StartRoundController` + the `StartRound` remote are **deleted** (file, class, remote name) and replaced by `AdvancePhaseController` + `AdvancePhase`; `RoundService.start()` became `advancePhase(reason)`, which forces the next transition unconditionally and logs `debug-advance` on the transition line. Leaving `Playing` early goes through the same `endPlaying()` as a natural end, so a skipped round and a finished round leave identical state. `1` is untouched and still gated on the spawner's `roundActive`, not on `Playing`.

Also repaired three `U+FFFD` replacement characters in `tuning.ts` (em dashes lost by an earlier heredoc write) — the same defect class as the item-28 handoff repair. **`flamework.build` is merged, not rewritten**, so deleting a controller leaves its registration behind pointing at a module that no longer exists; a clean rebuild (`rm out` + delete `flamework.build`) was required and is worth remembering for any future file rename. **Unverified in Studio.**


## 35. Owners on every body, last-standing winner, debug keys 1/2/3

**Supersedes item 34's `2` = "advance to next phase" and its `AdvancePhase` remote.** Keys are now `1` -> force `Waiting`, `2` -> force `Playing` (refused while already `Playing`), `3` -> spawn four competitors during `Playing`. `AdvancePhaseController` and `SpawnTriggerController` are **deleted**, replaced by one `DebugKeysController` firing `DebugWaiting` / `DebugPlaying` / `DebugSpawn` (three remotes, no arguments, per-action pattern). `RoundService.advancePhase` became `forceWaiting` / `forcePlaying` / `debugSpawnCompetitors`.

**Every body carries an owner.** `BallSpawnerService.spawnBall(spawner, owner)` writes `OwnerUserId` (number, negative for synthetic) and `OwnerDisplayName` on the body **before `Parent`**, so a body never exists ownerless even for a frame. `spawnForRound(count)` became `spawnForRound(owners: BallOwner[])` ? owners rather than a count, so a failed spawn cannot shift every later owner onto the wrong body. A body with no `OwnerUserId` is an **orphan**: not counted, not a candidate, cannot win.

**`Waiting` entry spawns one competitor, not four.** Its owner is the first connected player, or `Debug#N` when nobody is connected ? which is what makes the fully automated loop produce a winner. One body per *player* is a later round; everyone but the first player is a spectator.

**Winner rule** (`checkEndCondition`, reading `getCompetitors()` = tracked bodies with an owner): zero competitors -> `winner=none`; one competitor with `initialLiveCount > 1` -> last standing; cap expired -> furthest along the belt's `+RightVector` (falling back to world `+X`), ties to the lower `OwnerUserId`. **At the cap a single-competitor round also ends** ? item 34's rule required `live > 1`, which left a solo round running forever. `initialLiveCount` is **set**, never incremented, at `Playing` entry and after each `3` spawn. Winner is published to `ReplicatedStorage.WinnerName` (matching `RoundState`), cleared on `PostGame -> Intermission`, and printed in the transition line as `winner=<name> owner=<id>`.

**`1` from `Playing`/`PostGame` is a reset**: `clearAllBodies()` enumerates `TAGS.ball` (not the live set), then the synthetic counter and `initialLiveCount` reset, so the next `Debug#1` cannot collide with a ghost still on the belt.

**The 21:20 ghost is root-caused, not patched.** `enterIntermission` did destroy its bodies; the survivor was created by the spawner's manual `1` remote, which `RoundService` never tracked, so no teardown ever saw it. The manual spawn path (`SpawnBall` remote, `handleManualSpawn`, `spawnOnePerSpawner`, the per-player cooldown) is **deleted**, leaving one creation path, and teardown now enumerates by tag regardless. `enforceCap` behaviour unchanged; its existing line gained `owner=<id>(<name>)`. Elimination logs `[Round] eliminated <path>, owner=<id>(<name>), live=<n>`. **Unverified in Studio.**


## 36. Spawn-then-enter: `1` and `2` both clear and respawn one competitor per player

**Supersedes item 35's spawn site.** `enterWaiting` no longer spawns anything and `enterPlaying` no longer writes `initialLiveCount`; both simply move the machine. All spawning moved to the caller via the new `spawnRoundCompetitors(reason)`, and `enterPlaying(reason)` now returns `boolean` as a pure guard.

`forceWaiting` (`1`) and `forcePlaying` (`2`) both do: `clearAllBodies` -> `resetSyntheticCounter` -> `initialLiveCount = 0` -> `spawnRoundCompetitors` -> enter. `forcePlaying` refuses while already `Playing` before clearing, and if the spawn returns 0 it logs `debug key 2: no competitors spawned, staying in <phase>` and changes nothing — entering `Playing` with nothing to race was the 21:42 failure (`Playing -> PostGame (elapsed=1.02, no competitors)`).

`spawnRoundCompetitors`: reads `Players.GetPlayers()` **after** the clear, refuses at 0 with `spawn refused — no players connected` (the `Debug#1` fallback is **gone**), caps at `getBoundSpawnerCount()` with one `spawn capped: wanted N, spawners=4, spawned 4` line, spawns lane `i` for player `i`, logs `spawn lane=<i> owner=<name>(<id>) body=<path>` per body, sets `initialLiveCount` to what was actually spawned, and returns the count.

**Spawner gained a lane array.** `spawnerLanes: BasePart[]` maintained beside the `Set` (pushed on bind, removed by index on unbind) plus `spawnInLane(laneIndex, owner)`; `spawnForRound` and `getBoundSpawnerCount` now read the array. Reason: `Set` iteration order over instance keys is not a language guarantee, and lane-to-spawner mapping is logged, so it has to be stated rather than incidental.

**`enterPlaying` callers, and what `false` means for each:** `forcePlaying` (line 220) — spawned immediately before, so `false` is an **assertion failure**, logged as `ASSERTION FAILED: spawned N, enterPlaying refused` and the bodies are deliberately left on the belt for visibility; `scheduleWaitingTimeout` (line 499) — spawned nothing, so `false` is a **legitimate refusal**, logged as `refused Playing — no competitors` then `Waiting timer re-armed`, which re-arms once per `WAITING_SECONDS`.

The `Intermission` timer also spawns before entering now (a player who left between its own zero-player check and the spawn re-arms `Intermission` rather than landing in an empty `Waiting`). `3` is unchanged: still four `Debug#N` during `Playing`, still refused elsewhere. Mid-round zero competitors still ends the round via `checkEndCondition`. Teardown unchanged. **Unverified in Studio.**


## 37. `PLAYING_CAP_SECONDS` deleted; `Playing` can run forever, with a 60 s idle warning

**Supersedes item 36's end condition.** The cap branch is **deleted**, not zeroed or raised, and the constant is gone from `tuning.ts` including its docblock. Its only observed effect was to end rounds an elimination was about to end anyway: the 22:03 run logged `cap expired: <path>, winner=Debug#25` while the player's ball was still travelling. **A time limit that invents a result is worse than no time limit.**

`checkEndCondition()` now has exactly two branches: zero competitors -> `winner=none`; one competitor with `initialLiveCount > 1` -> last standing. **`elapsed` was removed from its signature** — it existed only for the cap comparison — and the two call sites (`startTickLoop`, `evaluateAfterLoss`) were updated. The duration is still logged: `endPlaying` reads `frozenElapsed`, which is the same clock the cap read from, so removing the cap did not remove the timer.

**Accepted consequence, named in the source:** a competitor that never crosses the `EliminationZone` keeps the round alive indefinitely. That is manual-intervention territory in Studio, not something this round papers over.

**New `ROUND_IDLE_WARN_SECONDS = 60`** (Placeholder) drives a once-per-round line from the 1 Hz `Playing` tick: `[Round] no elimination in 60s (live=<n>, furthest=<path>(<id>))`. It prints, sets a flag, and changes nothing else — no transition, no winner, no end. The clock (`lastProgressAt`) resets on **every** elimination and on every external body loss, so the line reports 60 s of nothing happening rather than 60 s of wall time; the flag resets at `Playing` entry. `furthestAlong` survives as the helper for this line, keeping the same lower-`OwnerUserId` tiebreak so the reported name is the one the cap would have named. **Unverified in Studio.**


## 38. `2` in `Playing` restarts the competitors instead of being refused; `PostGame` gained the refusal it never had

**Supersedes item 36's `forcePlaying` refusal branch.** Pressing `2` while `Playing` now does the same clear / reset counter / spawn as `2` from anywhere else and stays in `Playing`: `[Round] cleared N ball(s) (debug key 2 restart)`, one `[Round] spawn lane=...` line per competitor, then `[Round] Playing ? Playing (debug key 2, restart, competitors=N)`.

**`enterPlaying` is deliberately NOT called on this path.** It would restart the belt ramp, re-run `warnIfNoZone` and the tick loop, and reset `runningStartedAt` — which is the round's elapsed clock. The user asked for the *competitors* to start over, not the round, so `elapsed=` keeps counting through a restart. The `generation` counter is also untouched: bumping it would retire the running 1 Hz tick and leave a round that nothing eliminates or ends.

**Fields reset on restart:** `initialLiveCount` (then set by `spawnRoundCompetitors`), the synthetic `Debug#N` counter, `lastProgressAt` and `idleWarned` (a fresh competitor set means a fresh idle window — otherwise a restart 50 s into a quiet round would inherit the old clock and blame the new competitors). **Fields left alone:** `runningStartedAt`, `frozenElapsed`, `generation`, `warnedNoZone`, `roundState`, `winnerName` (empty during `Playing` by construction: it is written only in `endPlaying` and cleared in `enterIntermission`).

**One behaviour changed that the prompt called "unchanged":** `forcePlaying` had **no `PostGame` branch at all** — pressing `2` in `PostGame` cleared the displayed winner and entered a fresh `Playing`. It now refuses with `[Round] debug-advance refused ? PostGame is clearing`, which is what the prompt's rationale asked for but not what the code did. `1` remains the way out of `PostGame`.

`1`, `3`'s gate, the `Waiting -> Playing` timer, `enterWaiting`, `checkEndCondition`, the winner rule and the broadcasts are untouched. **Unverified in Studio.**


## 39. UI layer infrastructure and the round-phase banner

New `src/shared/ui-layers.ts`, `src/shared/ui-theme.ts`, `src/client/controllers/phase-banner-controller.ts` — the first UI in the tree.

**Layers.** `getScreenGui(layer)` is the only public surface; the three constructors (`topbarHudGui`, `coreHudGui`, `fullScreenGui`) are private so a caller cannot pass its own draw order. Display orders: full-screen `10`, core HUD `20`, topbar HUD `30` — full-screen draws under both HUDs by construction. **The element chooses its inset contract, not the device:** `TopbarSafeInsets` (topbar HUD), `CoreUISafeInsets` (core HUD), `None` (full-screen, which draws under the HUD and whose tenants pin to the physical edges). Verified in the installed typings, `Enum.ScreenInsets` has exactly `None`, `DeviceSafeInsets`, `CoreUISafeInsets`, `TopbarSafeInsets`; no fallback was needed. Gui creation is **lazy** — only `hudTopbar` exists on day one, because the other two layers have no tenant yet and an empty `ScreenGui` per layer would be plumbing in the Explorer and the log for nothing.

**Diagnostics.** One `[Ui]` format for both branches, same fields in the same order:
`[Ui] created kind=hudTopbar name=HudTopbarGui screenInsets=TopbarSafeInsets displayOrder=30`
`[Ui] found kind=hudTopbar name=HudTopbarGui screenInsets=TopbarSafeInsets displayOrder=30 previousScreenInsets=CoreUISafeInsets`
Both branches re-apply `ScreenInsets` / `DisplayOrder` / `ResetOnSpawn`; the found line carries the previous insets because drift is the reason that branch exists.

**Theme.** `ui-theme.ts` exports `BANNER_TEXT_SIZE` (24), `BANNER_TEXT_COLOR`, `BANNER_PADDING` (8) and — a fourth value the three-export plan did not predict — `BANNER_FONT` (`Enum.Font.GothamBold`), because a font hard-coded in the controller is the same defect as a hard-coded `TextSize`. The type-scale / spacing / paint split is **deferred and named as deferred**: three modules for four values with one consumer is structure without a reader.

**Banner.** `[PhaseBanner] mounted gui=HudTopbarGui displayOrder=30 visible=true absolutePosition=... absoluteSize=... text="..."`, printed one resumption after parenting because `AbsoluteSize` is `(0, 0)` until the layout pass runs. Text rules: the phase name; `PostGame — <winner>` or `PostGame — no winner`; anything else `Unknown` plus one `[PhaseBanner] unknown RoundState value="<raw>"` per distinct bad value (a `Set`, so a wrong phase cannot print on every transition). Both `StringValue`s are resolved with a bounded 10 s wait; `ValueBase.Changed` is typed `(value?: unknown)`, so the handler reads `.Value` rather than the payload. Padding is `UIPadding` on the frame itself, not a nested padded frame. No `RenderStepped`, no timer, no animation. A `round-state-controller` already logs `[RoundState] initial=` / `[RoundState] <phase>`; the banner is the first *rendering* tenant. **Unverified in Studio.**

## 40. UI theme infrastructure (contract, brand, palette, scale, directions) and the banner as its first tenant

**Supersedes item 39's flat files.** `src/shared/ui-layers.ts` and `src/shared/ui-theme.ts` are **deleted**; the layer module moved to `src/shared/ui/layers.ts` unchanged in behaviour, and the theme is now a folder: `src/shared/ui/theme/{contract,brand,palette,scale,base,dark,index}.ts`. Item 39's four `BANNER_*` constants are gone — the banner reads the theme and nothing else.

**The design doc is not in the repo.** There is no `# How I want UI built` file: the tree contains only `HANDOFF.md` and `README.md`. The design lives in the prompt that produced this item, so this section is the repo's only record of it. A future reader looking for "the UI doc" will not find one on disk.

**Contract (`contract.ts`).** `Theme { colors, paint, spacing, typography }`. `Colors` is 11 job-named `Color3` slots: `textPrimary`, `textSecondary`, `textDisabled`, `accent`, `onAccent`, `success`, `warning`, `error`, `border`, `shadow`, `specialRobux`. `Spacing` is `xs`–`xl`. `Typography` is six variants (`heading1`–`heading3`, `body1`, `body2`, `caption`), each `{ size, lineHeight }` — **no font in the variant**, because the font is one decision for the whole game.

**Surface metrics: option (b), compound `paint`, chosen.** `paint.surface / panel / card / trough` are each `{ color, transparency }`, so a surface cannot be copied without its transparency and a panel is one decision rather than two. `Theme` has **no `metrics` bag**: `panelTransparency` rides on the surface it decorates, and the two shape metrics with no colour to ride with — `cornerRadius`, `strokeThickness` — stay in `RAW` with **no reader** (the banner draws no `UICorner` and no `UIStroke`). A `Theme` slot for zero readers is the same mistake as a viewport module for zero readers.

**`specialRobux` is a domain slot, not a component slot.** `#3E9C35`, reserved for Robux-purchase UI, the same category of thing as `warning` or `error` — several elements may read it, so it must not be named after any one of them. It is explicitly *not* a precedent for `shopTileBackground`: the tile asks for `card`.

**Brand (`brand.ts`).** `BASE` = the five brand colours plus white, black and `robux` — real values, not placeholders. `TINTS` = **25 `**Placeholder.**` values**: four each for teal/red/orange/yellow (20), six for brown (`brownDarkest`, `brownDarker`, `brownDark`, `brownLight`, `brownLighter`, `brownLightest` — the surface family needs four ascending values, and the extra two keep the ascent continuous), plus `inkDim`, `inkDisabled`, `border`. Written out as hex, no `lighten()`: a tint is a designed value, not a procedural scale. Open questions reported to the designer rather than silently decided: whether `inkDim`/`inkDisabled` are tints of white (as written) or of brown, and whether `border` is a black tint (as written) or a very dark brown.

**Palette (`palette.ts`).** `RAW` maps design names to `BASE`/`TINTS`: `void`/`raised`/`band`/`trough` = `brownDarkest`/`brownDarker`/`brownDark`/full-strength brown, ascending. One `SURFACE_TRANSPARENCY = 0.15` (**Placeholder.**) shared by all four. Semantic mapping is the user's assignment, reproduced not re-derived: **orange `accent`, white `onAccent`, teal `success`, yellow `warning`, red `error`.** `fontFamily = Enum.Font.GothamMedium` (**Placeholder.**; item 39 used `GothamBold`). Nothing outside `src/shared/ui/theme/` imports `RAW`, `BASE` or `TINTS` — verified by a case-sensitive grep over `src/`.

**Scale (`scale.ts`).** `SPACING = {4, 8, 12, 16, 24}`, `TYPOGRAPHY` = 32/24/18/16/14/12 with line heights 40/30/22/20/18/16. Both `**Placeholder.**`. Rule: *typography and spacing never fork per theme — if a panel looks different it is painted differently, not typeset differently.*

**Base (`base.ts`).** `baseTheme()` returns a **fresh object every call**, including fresh `spacing` and fresh per-variant `typography` objects — returning the shared `SPACING`/`TYPOGRAPHY` constants would give every direction the same mutable objects. Neutral grey, deliberately: an element rendering grey is an element that never mounted a direction, which is a defect with a name.

**Direction (`dark.ts`).** `darkTheme()` starts from `baseTheme()` and passes `spacing`/`typography` through **by construction**, so forking them means deleting a line commented as deliberate. Every colour line names the brand colour it reads and why.

**Mount (`index.ts`).** `Direction = "dark"`; `DIRECTIONS: Record<Direction, () => Theme>` is exhaustive by type, so a direction that exists as a name but not as an adapter does not compile. `mountTheme()` is idempotent and logs `[Theme] mounted direction="dark" colors=11 spacing=5 typography=6`; a second call with a *different* direction warns instead of winning quietly. `getActiveTheme()` **mounts lazily on first read** — an explicit boot step is an ordering assumption Flamework does not guarantee, and the read is the only thing guaranteed to happen before a consumer builds anything. `getFont()` is the only accessor for `RAW.fontFamily`.

**big-ui push is a stub with a named trade-off.** `@rbxts/big-ui@^1.1.3` is installed and unused; the UI doc's step 4 ("push the theme into the UI library's global table", "merge the one font into every variant") has no receiver, so the banner reads `getActiveTheme()` directly — which is what `big-ui.Text` does internally, same contract, deferred boundary. The named cost: a big-ui component added before that line exists renders in big-ui's default theme with nothing warning you. `@rbxts/fusion-3.0@^0.1.0` is likewise installed and unused; two `StringValue`s and one `TextLabel` need a `Changed` handler, not a reactive system.

**Layers (`src/shared/ui/layers.ts`).** Unchanged from item 39: `getScreenGui(layer)` is the only public surface, three private constructors, display orders `fullScreen 10` / `hudCore 20` / `hudTopbar 30`, `[Ui] created|found ...` with the found line carrying `previousScreenInsets`. **The element chooses its inset contract, not the device** — the two HUD functions exist so that nothing branches on device type, and no `deviceSentence`/`edgeAnchoredInsets` was reintroduced.

**Verified, correcting the prompt's assumptions.** `Enum.ScreenInsets` in the installed typings has exactly `None`, `DeviceSafeInsets`, `CoreUISafeInsets`, `TopbarSafeInsets` — all three named members exist. **`Player.PlayerGui` is typed** (`PlayerGui: PlayerGui`), so the sketch's "untyped, needs a cast" comment is wrong and no cast is used. `Players.LocalPlayer` is non-optional. `ValueBase.Changed` is `(value?: unknown)`, so handlers read `.Value`.

**Banner (`phase-banner-controller.ts`).** Reads every colour, size and spacing value from `getActiveTheme()` / `getFont()`: the panel is `theme.paint.panel.color` at `theme.paint.panel.transparency`, padding is `theme.spacing.sm` on all four sides, the label is `theme.typography.heading3.size` in `theme.colors.textPrimary`. No literal `Color3`, `TextSize` or `Enum.Font` in the file. Mount line:
`[PhaseBanner] mounted pos=<v2> size=<v2> parent=HudTopbarGui drawOrder=30 visible=true text="<current>" panel=<Color3>`
— `panel` is included because the likely failure is a *pairing* (white on white, or a panel still neutral grey because the theme never mounted). Deferred one resumption so `AbsoluteSize` is not `(0, 0)`. Text rules unchanged: phase name; `PostGame — <winner>` / `PostGame — no winner`; anything else `Unknown` plus one `[PhaseBanner] unknown RoundState value="<raw>"` per **distinct** bad value. Both `StringValue`s resolved with a bounded 10 s wait *before* the build (the build needs both current values; building blank and re-writing would be a visible blank frame).

**Cascade test — planned, runnable only in Studio.** Three probes, each one edit in `brand.ts`/`brand.ts`'s tints, no code change: (1) `BASE.orange` → magenta must **not** change the banner (orange is `accent`, and the banner reads no accent); (2) `TINTS.brownDarker` → magenta must turn the **panel** (it is `RAW.raised` → `paint.panel`); (3) `BASE.white` → magenta must turn the **text** (`RAW.ink` → `colors.textPrimary`). If any probe needs a code edit, the cascade is broken.

**Unverified in Studio.** No Studio session was run against this item: the label geometry, the topbar inset offset, `GothamMedium` as a rendered placeholder, and the three cascade probes are all unconfirmed. `npm run build`, `npm run lint` and `prettier --check` are green.

## 41. big-ui and Fusion in the tree for the first time: theme push, `Text` component, `Computed` banner

**Supersedes item 40's theme folder and item 39's flat files.** Deleted: `src/shared/ui/theme/` (all seven modules), `src/shared/ui/theme.ts` as it existed then, and the raw-instance banner. The tree is now three files under `src/shared/ui/`: `layers.ts` (unchanged), `theme.ts`, `scale.ts`, plus `big-ui-theme.ts`.

**Packages, verified from `package.json` and the installed packages.** `@rbxts/big-ui@1.1.3` (`main: out/init.luau`, `types: out/index.d.ts`) and `@rbxts/fusion-3.0@0.1.0` (`main: src/init.luau`, `typings: src/index.d.ts`; its runtime `Fusion.version` is `0.3.0`). Both are now imported for the first time — big-ui in `big-ui-theme.ts` (`configureTheme`) and `phase-banner-controller.ts` (`Text`), Fusion in the controller (`scoped`, `Value`, `Computed`, `Hydrate`, `New`, `OnChange`, `Children`, `peek`).

**big-ui's theme API — the doc's step-4 assumption, verified.** `out/ui/theme.d.ts` exports `Palette`, `Transparency`, `Shape`, `Spacing`, `Typography`, `ZIndex` as **mutable tables**, plus `configureTheme(overrides: ThemeOverrides)`, which *deep-merges* into those live tables; `theme.luau`'s header says components read live values at render time, so it must be called before mounting UI. So section 6a step 4 is **correct for this library**, via a merge entry point rather than direct assignment. `ThemeOverrides` has `palette`, `transparency`, `shape`, `typography`, `zIndex` — **no `spacing`**, because big-ui's spacing is a function (`Spacing(n) = n * 8`), not a table: big-ui's spacing is not themable, which is why the app keeps its own `SPACING` for app-owned layout.

**`pushBigUiTheme(theme)` (`src/shared/ui/big-ui-theme.ts`)** — called once from `getTheme()` immediately after construction, idempotent, logs `[BigUi] theme pushed direction="hudDark" paletteGroups=8 transparency=3 typography=10`. It maps `primary ← accent/onAccent`, `secondary ← success`, `success/warning/error ←` the same-named slots, `text.{primary,secondary,disabled}`, `background.default ← paint.surface`, `background.paper ← paint.panel`, `common.black ← border`, `common.white ← onAccent`. **`info` is not overridden**: the app's 11 slots have no info colour, and inventing one would be the "colour means whatever this file says" defect — big-ui's default blue survives, and that is a gap in the *app's* palette, reported not papered over.

**The font goes through `typography`, so there is no `sweepFont`.** `TypographySpec` is `{ size, font, lineHeight }`, so a font *is* something the library accepts per variant. The push loops the app's `TYPOGRAPHY`, whose key type **is** big-ui's `TypographyVariant` union, so "a variant you forget silently keeps the library default" is a compile error here rather than a silent default. The doc's "things the library will not take, get a sweep" case does not arise, so no sweep was written (a sweep that is never called is worse than none).

**Two behaviour defaults the push has to correct.** (1) big-ui draws primary text at `Transparency.textPrimary = 0.13` — 87% opaque — so the push sets all three text transparencies to `0`; the app's colours are already the designed final values. (2) `Typography` defaults are the library's (h4 34px, h6 20px GothamBold, …), so the push overwrites all ten with the app's sizes and one font.

**`src/shared/ui/scale.ts` survives, keyed by big-ui's vocabulary.** `Font`, `SPACING`, `FONT`, `TYPOGRAPHY: Record<TypographyVariant, TextSpec>`, and `TextVariant = keyof Typography`. Not `Record<string, …>`: a string-keyed record collapses `keyof` to `string`, which is the "variant you cannot enumerate" the doc warns about. The app's design names map onto big-ui's nearest names (32→`h4`, 24→`h5`, 18→`h6`, 16→`subtitle1`/`body1`, 14→`subtitle2`/`body2`, 12→`caption`); the other four big-ui variants get app-owned values too, so no component renders in the library's default face.

**The banner is built by big-ui and updated by Fusion, with no update code in the controller.**

```
RoundState.Value ──OnChange──▶ Fusion Value ──┐
                                             ├─ Computed(bannerText) ─▶ big-ui Text
WinnerName.Value ──OnChange─▶ Fusion Value ──┘
```

`big-ui.Text(scope, props)` takes `variant: TypographyVariant` and `text: Fusion.UsedAs<string>`, so rule 6 is enforced by big-ui's own type (**zero `TextSize` in `src/`**) and the `Computed` is bound straight into the label's `Text` property by Fusion's own observer. **Honest caveat:** `Fusion.OnChange("Value")` *is* a `GetPropertyChangedSignal("Value")` connection under the reactive surface (`fusion-3.0/src/Instances/OnChange.luau`); the app writes no `Changed.Connect`, Fusion owns and scopes the connection. This Fusion version (0.1.0 / core 0.3.0) has no primitive that subscribes to a `StringValue` on its own, so `OnChange` feeding a `Value` **is** the simplest supported pattern.

**`Hydrate` ownership caveat.** `Fusion.Hydrate(scope, target)` inserts the target instance into the scope as something it owns, so `Fusion.doCleanup(scope)` would `Destroy()` `RoundState` and `WinnerName`. Nothing calls cleanup on this scope and nothing should; the one-line replacement if that ever changes is `table.insert(scope, value.GetPropertyChangedSignal("Value"):Connect(...))`, which is what `OnChange` does internally minus the ownership.

**The container is Fusion `New("Frame")`, not a big-ui component — and that is a finding about the library.** big-ui 1.1.3 has **no** plain container primitive (its `index.d.ts` offers `Card` as the nearest thing). `Card` unconditionally adds a `UICorner`, adds a `UIStroke` unless `elevation: 0`, wraps children in a vertical `UIListLayout`, and **drops `AutomaticSize` the moment a `size` is passed** — so it cannot produce an auto-sized, auto-width, centred chip, and it forces two decorations the banner's spec forbids. Consequence for the doc: step 4's "push the theme and the library paints" is only half true here — big-ui paints the components it owns (`Text`, `Card`, `Button`…), and app-owned layout is painted from the same `Theme` object the push reads. One source, two painters.

**big-ui's `Text` needs one property re-applied.** Its default is a full-width, fixed-height bar (`Size = UDim2.new(1,0,0,lineHeight)`, `AutomaticSize = Y`), and passing `size` sets `AutomaticSize = None`. The banner passes `size = UDim2.fromOffset(0, 0)` and then `Hydrate`s `AutomaticSize = XY` onto the returned `TextLabel`, so the chip shrink-wraps and stays centred. Only that one property is overridden; font, size, colour and alignment all come from big-ui + the pushed theme.

**Log formats.** `[Theme] mounted direction="hudDark" paint=4 colors=11` → `[BigUi] theme pushed direction="hudDark" paletteGroups=8 transparency=3 typography=10` → `[PhaseBanner] mounted pos=<v2> size=<v2> parent=HudTopbarGui drawOrder=30 visible=true text="<current>" panel=<Color3>` (deferred one resumption so `AbsoluteSize` is not `(0,0)`). Counts are derived from the objects, not hard-coded. `[Ui]` lines unchanged from item 39 (created/found, `previousScreenInsets` on found). Unknown phase: one `[PhaseBanner] unknown RoundState value="<raw>"` per **distinct** bad value, printed from inside `bannerText`.

**Banner display rules unchanged.** Phase name alone for `Intermission`/`Waiting`/`Playing`; `PostGame — <winner>` or `PostGame — no winner`; anything else `Unknown`. Bounded 10 s wait for both `StringValue`s (item 13's discipline), resolved before the build.

**Layers unchanged.** `getScreenGui(layer)` is still the only public surface, three private constructors, display orders `fullScreen 10` / `hudCore 20` / `hudTopbar 30`, and **the element chooses its inset contract, not the device** — Fusion owns components *inside* a screen gui, not the gui itself.

**Palette.** `BASE` = the five brand colours plus white/black/`robux` (real). `TINTS` = 25 `**Placeholder.**` values: four each for teal/red/orange/yellow, six for brown (the four-surface family needs four ascending values plus two more for a continuous ascent), `inkDim`, `inkDisabled`, `border`. Written out as hex, no `lighten()` — a tint is a designed value, not a procedural scale. Accent/success mapping unchanged: orange accent, white onAccent, teal success, yellow warning, red error.

**Unverified in Studio.** No Studio session was run against this item: whether the banner renders at the top centre under the topbar, whether the `Computed` → `Text` binding actually repaints on a phase change, the three cascade probes, and the reuse branch's `[Ui] found` are all unconfirmed. `npm run build`, `npm run lint` and `prettier --check` are green; the emitted Lua was inspected for the Fusion and big-ui call shapes.

## 42. Pickups, and the belt as a reference number: `BALL_SPEED` / `BELT_SPEED` / `RELATIVE_SPEED`

**The belt is a reference number, not a surface** (item 18). Nothing in the world pushes a ball: its along-belt motion is `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`, written from its own attribute every tick. The floor under the belt is static, anchored and frictionless, and exists only so gravity has something to settle a ball against.

**The model.** `BELT_SPEED` (`DEFAULT_BELT_SPEED`, 10) is a **reference number**, not a surface. Each ball carries `BALL_SPEED` as an attribute: seeded at `BALL_SPEED_START` (10) at spawn, decayed toward `BALL_SPEED_MIN` (0) at `BALL_SPEED_DECAY_RATE` (0.3 studs/s²) every tick, and each tick `BallSpawnerService.stepBallSpeeds` sets the ball's velocity along the belt to `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`, leaving gravity and sideways drift untouched. Zero is stationary, negative is losing ground toward the exit, positive is gaining it back toward the spawn end. Decay is toward **zero**, not a terminal value: a terminal value is an equilibrium a ball could hold forever, and a race with an immortal ball is not a race.

**Pickups (`src/server/services/pickup-service.ts`, `TAGS.pickup = "Pickup"`).** A touch writes `BALL_SPEED = BOOST_TARGET_BALL_SPEED` (12) on the ball — the attribute, not a velocity, because velocity is rewritten from the attribute on the next tick and a velocity write would look like it did nothing. **The boost target moved above belt speed, reversing its earlier meaning:** under the physical model a boost *below* the belt was the durable choice because the surface kept pulling the ball along; under this model nothing pulls anything, and 12 is the only value that flips `RELATIVE_SPEED` positive, i.e. back toward the spawn end and away from elimination. A boost of 8 here would push the ball toward the exit faster.

**Cluster: 3 triangles, not 5.** At five across a 10-stud span the centres were 2.5 studs apart and the parts 1.5 wide, so a 1-stud ball could straddle two and collect both in the same millisecond (13:14 log: `BALL_SPEED 3.276 -> 8` then `6.559 -> 8`). Three centres 5 studs apart cannot be spanned by one ball. `PICKUP_COUNT = MAX_CONCURRENT_PICKUPS = 3`; `PICKUP_CLUSTER_LOCAL_X = -15` (first third), 15 s top-up fills empty slots only. Shape is `Enum.PartType.Wedge` sized `(2, 1, 2)` — `Enum.PartType.Triangle` does not exist in the installed typings, and the earlier `SpecialMesh(Prism)` version at 0.1 studs thick was invisible in Studio.

**Phase handling.** `PickupService` subscribes to `ReplicatedStorage.RoundState` (`GetPropertyChangedSignal("Value")`): `Playing` spawns and starts the top-up loop, **every other phase** stops the loop and clears `Workspace.SpawnedPickups`. `setRoundActive(false)` sets `BALL_SPEED = 0` on every live ball and `stepBallSpeeds` returns immediately unless a round is active, so nothing writes velocity outside `Playing`.

**Two numbers, split: `BELT_SPEED` (reference) and `BELT_VISUAL_SPEED` (effect).** `BELT_SPEED` is the belt's `BeltSpeed` attribute — a constant, read through `TreadmillService.getReferenceBeltSpeed()`, and the **only** thing `stepBallSpeeds` subtracts. `BELT_VISUAL_SPEED` is the ramped scroll rate, published to each belt's `BeltSpeedActual` attribute by `setBeltSpeed`, and read by `BeltScrollController` **only**. The wire name stayed `BeltSpeedActual`; only the symbol is new (`BELT_VISUAL_SPEED_ATTRIBUTE`).

They were one number for one round, and that was the bug: while the ramp ran, `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED` read `+10`, `+6`, `+2`, so **every ball drifted forward at the start of every round with no triangle involved** — the one thing only a pickup is supposed to cause. A value that ramps is a value the physics model did not consent to; the reference is the comparison, the visual is the effect. `RELATIVE_SPEED` is exactly `0` on the first `Playing` tick because `BALL_SPEED_START = 10` and `BELT_SPEED = 10`, and it only leaves zero when decay or a pickup moves `BALL_SPEED`.

The belt's `[Treadmill] bind` line now prints both, so the split is observable in one line: `BELT_SPEED=<reference> BELT_VISUAL_SPEED=<ramped>`. `getEffectiveBeltSpeed()` still reports the ramp and has exactly one reader: the backspin gate, where "is the belt physically carrying anything" is what it was written for. **Invariant worth knowing:** `RELATIVE_SPEED = 0` at tick one holds while the belt's `BeltSpeed` attribute equals `DEFAULT_BELT_SPEED` (10). A designer who sets the attribute to 12 gets `-2` at tick one, because `BALL_SPEED_START` is the constant, not the attribute.

**Unverified in Studio.** Whether the ball drifts, whether a boost flips it forward, whether a boosted ball can leave through the *front* face of the `EliminationZone` (the code is face-agnostic; whether the zone covers that face is scene data), and the ride time at `BALL_SPEED_DECAY_RATE = 0.3` are unconfirmed. `npm run build`, `npm run lint` and `prettier --check` are green. **The number to doubt first is the decay rate:** drift is `RATE * t`, so at 0.3 the ball spends 33 s of headroom and covers the 51 studs from spawn to exit in roughly 18 s; if the ride is too long, raise it.


## 43. Drift sign flipped and spin gain doubled (supersedes item 42's velocity sign)

**The velocity write is negated.** `BallSpawnerService.stepBallSpeeds` now writes
`right.mul(-relative)` where `relative = BALL_SPEED - BELT_SPEED`, instead of `right.mul(relative)`.
`RightVector` is `+X`, and in this model `+X` is the **back** edge (local `+28`) while `-X` is the **front** (local `-28`, where the ball spawns). A positive `RELATIVE_SPEED` means faster than the belt and must gain ground toward the front, i.e. `-RightVector`. The sign is the model's, not the world's.

**What the wrong sign did, measured:** the 14:08 log shows the ball leaving `local X = -23` and crossing `-25.78` and `-28.10`, exiting at `left belt side=-RightVector` after 11.3 s ? it fell off the edge it spawned beside, 5 studs away, instead of crossing the 51 studs to the far edge. With the negation it drifts `+X` and traverses the belt.

**Spin gain doubled, `APPARENT_SPIN_GAIN` 4 ? 8.** The reference-speed model made the ball slow: it spends most of a ride at 0.1?2 studs/s of `RELATIVE_SPEED`, where the old gain drew `1.6?12 rad/s` ? the low end reading as stationary. At 8 the same drift draws `8?24 rad/s`. The clamp is now reached at `|v| = 1.9` studs/s, so a boosted ball (`+2`) sits at the ceiling by design. `SPIN_RATE_OFFSET` does not exist; the offset stays zero so a stationary ball does not spin.

**Nothing else reads `RELATIVE_SPEED`.** Grepped: the only consumer is the velocity write; the sample log line prints it read-only, and the pickup writes `BALL_SPEED` (an attribute), not a velocity, so neither needs a sign change.

**Unverified in Studio.** Whether the ball now exits at `+RightVector`, the ride time under the corrected sign, and whether the doubled spin reads as faster without aliasing. `npm run build`, `npm run lint` and `prettier --check` are green.


## 44. Marker spin driven by `BALL_SPEED`, not world velocity

**The rate input changed from `|AssemblyLinearVelocity|` to the ball's `BALL_SPEED` attribute.** Under the reference-speed model a ball's world velocity is `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`, so at spawn it is exactly **zero** and during a normal ride it is a small negative number. Driving the markers from `|v|` therefore drew a ball that visually sat still with no rotation, then a ball rotating slowly *backwards* as it lost ground ? as if it were sliding on a stationary floor. That is the same class of bug item 43 fixed for the drift sign, one layer up.

The ball is rolling on a surface moving at `BELT_SPEED`; relative to that surface its speed is `BALL_SPEED`. That is what the markers show. The rate is now `min(APPARENT_SPIN_MAX_RAD_PER_SEC, APPARENT_SPIN_GAIN x BALL_SPEED / radius)`, always **positive**, so the markers always turn forward and there is no backward case at all. `BALL_SPEED` cannot be `NaN` (every writer is `math.max(0, ...)` or a constant) and a missing attribute reads `0`, which lands in the deadband and holds the markers still.

**`APPARENT_SPIN_GAIN` 8 ? 1.5.** With the input at `|v|` a large gain was needed to make a 0.1?2 studs/s drift visible; once the input became `BALL_SPEED` (10 at spawn) that same gain pinned the markers at the clamp for the entire ride ? the crossing sat at `BALL_SPEED = 1.875`, i.e. 27 s in, while a ride lasts ~18 s. At `1.5` spawn draws exactly `30 rad/s` (at the ceiling) and the end of a ride draws `1.5 x 4.6 / 0.5 = 13.8 rad/s`, less than half ? so the decay is visible in the marker rate, which is the point of the change.

**Log fields.** `speed=` became `BALL_SPEED=`, and the velocity-source field is now `velocitySource=` (it still reports `velocity`/`delta` because the world velocity is still what picks the **axis**). `rateSource` values are now `physical` / `attribute` / `deadband` ? no `velocity` value survives. `|v|` is still printed, because a disagreement between it and `BALL_SPEED` is how this bug would show up again.

**Unverified in Studio.** Whether the markers read as fast at spawn and slower at the end, whether a pickup visibly speeds them up, and whether the clamp still avoids aliasing at 30 rad/s. `npm run build`, `npm run lint` and `prettier --check` are green.

**Follow-up in the same round ? the attribute branch was unreachable.** The first version of item 44 used `if (physicalSpin > SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC) ... else if (ballSpeed ...)`, and the 14:30 log shows the physical branch winning within a second: a ball resting on the floor accumulates solver residual (`omegaPhysical` climbing 0.001 ? 0.09), which crosses the 0.05 threshold, so every line read `rateSource=physical omegaVisual=0.2` and the new input was never consulted. The markers looked identical to before the change. The two candidates are now computed and **the larger wins** (`attributeRate >= physicalRate && attributeRate > 0` ? `attribute`), which needs no new threshold: solver noise is slow so it loses, and genuine rotation is fast so it still wins. `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC` keeps its original job ? deciding when `AssemblyAngularVelocity` is meaningful enough to be an **axis**.

**Second follow-up ? the markers were drawn along the wrong axis, so they turned with the belt instead of against it.** `APPARENT_SPIN_SIGN` is now `-1`. The old justification ("`yAxis:Cross(direction)` is forward rolling for a ball travelling `+X`") is correct for a *rolling* ball, and wrong for this one: under the reference-speed model the ball is carried on a surface moving at `BELT_SPEED` and slides slowly toward the exit, so its contact point is dragged the way the surface moves and its top turns **against** belt travel. Drawing the forward-rolling axis made the markers turn with the belt while the ball crawled the other way ? the "spinning backwards" report.

The **travel axis is also gone**. It was derived from `state.velocity`, which is ~0.05 studs/s for most of a ride (below `SPIN_FALLBACK_MIN_SPEED`, so the branch rarely fired) and, on a boost, reverses and would have flipped the markers while the rate ? now from `BALL_SPEED`, always positive ? stayed the same. The axis is now a constant function of the belt (`beltSpinAxis()`, `yAxis:Cross(RightVector)`) except when the body has genuine spin above `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC`, where its own rotation is the truer answer.

**Third follow-up ? the rate and the axis are now each a single source, so the markers cannot reverse.** The 14:39 log shows the cause of the mid-ride flip: `omegaPhysical` climbs `0.394 -> 7.296` and tracks `2 x |v|`, i.e. the bodies really are rolling in world space, and once that crossed `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC` the **physical branch won the rate and the physical axis won the direction** - so the markers reversed while `BALL_SPEED` was still climbing. Both competitors are gone:

- **Rate:** `min(MAX, APPARENT_SPIN_GAIN x BALL_SPEED / radius)` above `SPIN_DEADBAND_SPEED`, else `0`. `rateSource` is `attribute` or `deadband`, nothing else.
- **Axis:** `beltSpinAxis()` always - a constant for a given belt. `axisSource` is `belt`, nothing else.

`omegaPhysical` is still printed as a diagnostic and decides nothing. `APPARENT_SPIN_GAIN_OMEGA` and `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC` are no longer imported by the controller (both constants remain in `tuning.ts`). The requirement this satisfies is the user's: **the ball never renders a backwards spin** - one direction for its whole life, rate set by the attribute, axis set by the belt.

## 45. Pickups: random X, lane Z from the bound spawner parts, count = spawner count

**The fixed cluster is gone.** `PICKUP_CLUSTER_LOCAL_X`, `PICKUP_Z_EDGE_INSET`, `PICKUP_COUNT` and `MAX_CONCURRENT_PICKUPS` are deleted; `spawnCluster`/`slotPositions`/`slotOccupied` are replaced by `spawnPickups` + `positionFor`. New `PICKUP_X_MIN = -18`, `PICKUP_X_MAX = 23` (both `**Placeholder.**`).

**Count is the scene's, not a constant.** `maxPickups()` is `BallSpawnerService.getBoundSpawners().size()` ? a **new accessor returning the parts**, not just a count, because the pickup needs their positions. The old fixed `3` meant a scene with four spawners placed three pickups and one lane could never hold anything; a fifth spawner added in Studio would have changed nothing. `getBoundSpawners()` returns a fresh array filtered to parts still parented, so the reader calls `Position` at spawn time and a spawner moved in Studio moves its lane.

**`Z` comes from the spawner part; `X` is random.** `localZ = belt.CFrame.PointToObjectSpace(spawner.Position).Z`, and `localX = PICKUP_X_MIN + math.random() * (PICKUP_X_MAX - PICKUP_X_MIN)` (float). `-18` sits 5 studs in front of the ball's spawn at local `-23`, so a pickup can never be behind every ball for its whole life; `+23` stops well short of the exit at `+28` so a pickup is reached before the ball has committed to leaving. Both are inside `-28 .. +28`, so a triangle is always on the surface. `Y` is unchanged: the **floor's** top face (`belt.Size.Y / 2 + BELT_SURFACE_THICKNESS + PICKUP_SIZE.Y / 2`), not the belt's, because the floor is what a ball rests on.

**No overlap check, and none needed.** Z is per-lane, so two pickups in different lanes cannot overlap; a top-up additionally excludes lanes that already hold a pickup, which keeps the deficit in an empty lane rather than stacking two in one.

**Top-up spawns only the deficit** (`spawners.size() - live`), so the untouched pickups keep the position they were created at ? verified: the old code already skipped occupied slots, and the new one is count-based for the same reason. Interval unchanged at 15 s.

**Log line** is now `[Pickup] spawned reason=<Playing entry|top-up> count=<n> live=<total> positions=<x>,<z>|<x>,<z>|...`; `firstPos`, `localX` and `worldX` are gone. `[Pickup] collected by <ball> BALL_SPEED <before> -> <after> live=<n>` is unchanged.

**Unverified in Studio.** Whether two consecutive rounds produce different X values, whether every lane gets a pickup, and whether a top-up adds one rather than a full set. `npm run build`, `npm run lint` and `prettier --check` are green.

## 46. `BALL_SPEED` seeded at `Playing` entry, so a round never starts at zero

**The zero was real and it came from the pause, not from spawn.** `spawnBall` already writes `BALL_SPEED_START` (10) before `Parent`; `setRoundActive(false)` then zeroes every live ball so a stopped round reads as stopped. `1` spawns into `Waiting` ? `forceWaiting` clears, spawns, then enters `Waiting` ? so the ball was spawned at 10 and zeroed a moment later, and `enterPlaying` never restored it. The 15:04 log shows the result: `BALL_SPEED=0 BELT_SPEED=10 RELATIVE_SPEED=-10`, a ball thrown backwards at the full belt speed from tick one, with the markers correct at `0 rad/s` because the attribute really was zero.

**Fix: the `active` branch of `setRoundActive` now seeds every live ball to `BALL_SPEED_START`** and logs `[Spawner] round start: N ball(s) at BALL_SPEED=10`. It runs inside the hook `enterPlaying` already calls, before the first `stepBallSpeeds` tick, so the first `RELATIVE_SPEED` the model computes is `10 - 10 = 0` ? the neutral start the model is specified to have.

**Every writer of the attribute, for the record:**
- `spawnBall` ? `BALL_SPEED_START` (unchanged, before `Parent`).
- `stepBallSpeeds` ? the decayed value each tick.
- `setRoundActive(true)` ? `BALL_SPEED_START` on every live ball (**new**).
- `setRoundActive(false)` ? `BALL_SPEED_MIN` on every live ball.
- `PickupService.onPickupTouched` ? `BOOST_TARGET_BALL_SPEED`.

**No spawn-phase gate was hiding the bug.** `spawnBall` sets the constant unconditionally, so a ball spawned by `3` during `Playing` was already correct; only the `Waiting` path was broken. A ball cannot be spawned in `Intermission` or `PostGame` ? the only creation paths are `spawnRoundCompetitors` (called from `forceWaiting`, `forcePlaying` and the intermission timer) and the `3` debug remote, which refuses outside `Playing`.

**One misleading field left alone:** the `[Ball:N] first motion` line prints `BALL_SPEED=` from `velocity.Dot(RightVector)`, not from the attribute, so it reads `0` on the spawn frame even when the attribute is 10. Renaming it would change a log line's shape, which this round was told not to do; it is reported here instead.

**Unverified in Studio.** Whether the first `Playing` sample now reads `BALL_SPEED=10 RELATIVE_SPEED=0` for a `1`-spawned ball, and whether the `[Spawner] round start` line prints once per `Playing` entry. `npm run build`, `npm run lint` and `prettier --check` are green.

## 47. Decorative lateral weave across the belt

**Balls no longer travel in a straight line.** A per-tick lateral term drifts each ball across the belt and reverses it at a bound, so a ball has visible sideways motion of its own. It is **decoration, not physics** ? there is no lateral force, contact or friction, and there is nothing for one to come from, because the belt is a reference number rather than a surface (item 18). The term is written into the velocity exactly like the along-belt one.

**Constants (`tuning.ts`, all `**Placeholder.**`).** `Z_DRIFT_SPEED = 0.5` studs/s ? `LATERAL_BOUND = 4` (belt-local Z from the centreline; the belt is 12 wide, so ?4 leaves 1.5 studs of margin) ? `LATERAL_BOUND_MIN = 1.5` (see below).

**State lives in a `Map<BasePart, {direction, bound}>` on `BallSpawnerService`**, not in attributes: it is a tick-local detail with no consumer outside the loop, and attribute writes would replicate it for nothing. Seeded at spawn next to the `BALL_SPEED` attribute and deleted in the same block as `ballKillY`, so its size tracks the live set like every other per-ball map in the file.

**`bound` is signed and always matches `direction`** (`bound = direction * magnitude`), which makes the reversal test one comparison ? `localZ * direction >= math.abs(bound)`. A bound of the opposite sign would read as already-passed on the first tick and flip every frame.

**The bound magnitude is drawn from `LATERAL_BOUND_MIN .. LATERAL_BOUND`**, not from `-BOUND .. +BOUND`. That is the answer to "does a near-zero bound jitter": yes it would, a ball reversing at 0.02 studs flips almost every tick and vibrates in place, so the magnitude has a floor and only the sign is random. An asymmetric weave (`+3.2` to `-1.6`) also reads better than a symmetric one.

**The axis is `RightVector:Cross(UpVector)`, not `LookVector`.** A `CFrame`'s `LookVector` is its **-Z** axis, so using it would weave toward local -Z while every `localZ` in the log and in `PointToObjectSpace` uses +Z ? the two would need negating against each other forever.

**The tick loop now writes three terms** and skips the old two-term write:
```
velocity.sub(right.mul(along)).add(right.mul(-relative)).add(lateral)
```
`Y` is never touched, so gravity and the floor still behave; `BALL_SPEED` is never touched, so decay and boosts are unaffected.

**`TreadmillService.getBeltFrame()`** is new, read once per tick, so the loop has the frame `localZ` is measured in without a per-ball belt search.

**Log.** The ball sample line gains `localZ=<n> lateralDir=<-1|1|none>`; nothing else changed shape.

**Unverified in Studio.** Whether `localZ` visibly changes and reverses, whether the ball stays inside ?4, and whether the X drift and the fall are unchanged. `npm run build`, `npm run lint` and `prettier --check` are green.

## 48. Each ball draws its own starting speed, so a round is not a stampede

**Why the round was ending the instant `3` was pressed twice.** Every ball ran one curve: `BALL_SPEED` decayed from the same `BALL_SPEED_START` at the same `BALL_SPEED_DECAY_RATE`, and the only per-ball randomness was the lateral weave, which does not change *when* a ball reaches the exit. The 16:21 log shows the result ? `Playing` at 16:21:34, sixteen balls spawned by 16:21:53, then fifteen eliminations between 16:22:11.975 and 16:22:14.006 and `Playing ? PostGame (last standing ... winner=Debug#13)`. PostGame was correct behaviour; the race was a tie, so adding competitors only made the tie visible. Ownership tracking was never involved ? every elimination named its `-N(Debug#N)` owner.

**`BALL_SPEED_START_JITTER = 1`** (`**Placeholder.**`): each ball draws `BALL_SPEED_START + (math.random() * 2 - 1) * JITTER`, i.e. a start in `9 .. 11`, so the field begins with `RELATIVE_SPEED` spread across `-1 .. +1` instead of every ball at exactly `0`. At `BALL_SPEED_DECAY_RATE = 0.3` that is roughly a 7 s spread in exit time.

**The draw is kept, not re-rolled.** `startSpeeds: Map<BasePart, number>` holds each ball's value, because `setRoundActive(true)` restores every live ball at `Playing` entry ? re-drawing there would hand a ball a different start from the one it was born with, so a ball spawned into `Waiting` would still be unpredictable, just later. Cleared with `ballKillY` and `lateral` in the destroy path.

**Cost, stated:** `RELATIVE_SPEED` is no longer exactly `0` on the first `Playing` tick for every ball ? only the ball that drew `10` gets a neutral start. That was a requirement of item 46 and is deliberately traded here, because "every ball starts identical" and "the race is not a tie" cannot both hold.

**Also fixed, same edit:** the lateral weave state was being seeded inside `setRoundActive` (a mis-targeted insert from item 47) instead of in `spawnBall`. It is now seeded at spawn, which is where every other per-ball value is decided; the `Playing`-entry loop only restores the speed.

**Log.** `[Spawner] round start: N ball(s) at BALL_SPEED=10+-1`. Ball sample lines show the drawn value per ball, so the spread is readable directly.

**Unverified in Studio.** Whether the eliminations now string out over several seconds rather than two, and whether the winner is the ball that actually rode best. `npm run build`, `npm run lint` and `prettier --check` are green.

## 49. Round-transition wipe: server-timed, client-drawn, timer held

**There was no transition in this tree.** A previous round stopped because the reference file was never attached; the other agent's brief named the values, so the effect is now built from that brief rather than ported file-for-file.

**Client ? `src/client/controllers/round-transition-controller.ts`.** A `ROWS x COLS` grid of `Frame`s covers the screen: cells grow from their own centre in a wave ordered by distance from the grid's middle, hold, then shrink back in the reverse wave. One `RenderStepped` loop advances a single elapsed number and every cell's size is a pure function of it, so 240 cells cannot disagree about where they are. The grid is created per play in a throwaway `Fusion.scoped` scope and destroyed with `Fusion.doCleanup` at the end, so a client that never sees a transition holds no UI.

**The cue is a per-player attribute.** The server bumps `ROUND_TRANSITION_ATTRIBUTE` (`"RoundTransitionCount"`) on every player; the controller watches its own copy. `lastSeen` is seeded from the attribute **before** subscribing, so a client mounting mid-wipe does not replay it ? the difference between "a wipe on every state change" and "a wipe on every state change after this client mounted".

**Server ? `RoundService.transitionAround(from, label, cb)`.** `task.spawn`s the sequence so the caller returns immediately: bump every player, wait `coverSeconds() + TRANSITION_NETWORK_STEP`, run `cb()` (the phase change happens in the dark), wait `holdSeconds() + openSeconds()`. Logs `[Transition] covering (A ? B)` and `[Transition] uncovered (B)`. Gated on the same `TRANSITION_CONFIG.ENABLED` the client reads; when false it calls `cb()` synchronously with no bump and no hold, which is the pre-transition behaviour exactly.

**Two call sites, no others:** the intermission timer's `Intermission ? Waiting`, and the `PostGame` hold's `PostGame ? Intermission`. `Waiting ? Playing` and `Playing ? PostGame` stay unwrapped.

**The timer does not run under the wipe.** `transitionAround` sets `pendingTimerHold = holdSeconds() + openSeconds()` *before* the phase entry runs; `scheduleWaitingTimeout` and `startIntermissionTimer` each read and clear it with `consumeTimerHold()` and add it to their **first** wait only. So a phase entered behind a wipe starts its full duration when the screen clears; the phase's own length is unchanged. The re-arm paths deliberately do not add it again.

**A new `transition` UI layer** (`src/shared/ui/layers.ts`): `TRANSITION_GUI_NAME = "TransitionGui"`, `TRANSITION_DISPLAY_ORDER = 40`, `ScreenInsets.None`. Above `hudTopbar` (30) because it is the only layer whose job is to hide the others ? a wipe under the HUD leaves the banner floating on black. `None` because the cover must reach the physical screen edges, including under the topbar.

**Config ? `src/shared/config/transition.config.ts`.** `ENABLED = true`, `ROWS = 12`, `COLS = 20`, `DELAY_PER_CELL = 0.015`, `GROW_SECONDS = 0.5`, `HOLD_SECONDS = 2`, `REVEAL_SECONDS = 0.5`, `REVEAL_REVERSES_WAVE = true`, `COLOR = rgb(10, 12, 24)`. Derived: `coverSeconds() = 0.515`, `holdSeconds() = 2`, `openSeconds() = 0.515`. The server reads these functions rather than its own copies, so the two clocks cannot drift ? if they did, the timer would run underneath the wipe, which is the failure the feature exists to prevent. `TRANSITION_NETWORK_STEP = 0.1` in `src/shared/constants.ts` is the only timing the server owns.

**Fusion differences from the reference:** the installed `@rbxts/fusion-3.0@0.1.0` has `scoped`, `New`, `doCleanup` and `Children`, but **no `OnRender`** ? the loop is `RunService.RenderStepped`. There is no `logDebug`, so the wipe logs via the round service's `[Transition]` lines and the client logs nothing.

**Unverified in Studio.** Whether the wipe appears on both wrapped transitions, whether the timer is visibly full after it opens, whether the HUD is correctly hidden beneath it, and whether a mid-wipe join stays silent. `npm run build`, `npm run lint` and `prettier --check` are green; Flamework registered the controller.

## 50. Shop and inventory panels: a second, light theme direction, rebuilt to the reference's presentation

**Placeholder content throughout.** Three dummy tiles, an empty inventory, no currency, no remote, no server state. This is the presentation layer only.

**The second direction, `surfaceOpaqueTheme()` in `src/shared/ui/theme.ts`.** Same `Theme` interface as `getTheme()`, a light palette: opaque paper surfaces, dark ink, one restrained blue accent. **The unit of the split is reason, not preference** — the dark HUD is for looking *past* (a phase name you glance at while watching the belt), the panels are for looking *at* (a player stops, reads, chooses). A translucent brown sheet over a moving scene is the wrong surface for reading. It is a sibling function, not a `theme("light")` parameter: a registry would let the wrong element ask for the wrong direction, and a third direction is a third function. `getTheme()` is untouched.

**The palette (all `**Placeholder.**`, all opaque).** `panel #F4F1EA`, `card #FFFFFF`, `surface #ECE8DF`, `trough #DDD8CE`; `textPrimary #1C1B18`, `textSecondary #55514A`, `textDisabled #8E8A80`; `accent #2F5E8C`, `onAccent #FFFFFF`; `success #2E7D32`, `warning #B8781B`, `error #B33A3A`; `border #C9C4B8`, `shadow #000000`; `specialRobux` inherits the dark direction's Robux green. `SPACING` and `TYPOGRAPHY` are **not** forked — the light `Theme` has neither field.

**Five builders, four exported functions and one motion helper, in `src/shared/ui/`.**

- `panel.ts` — `Panel({theme,parent,size}) -> {frame, surface}`, plus `PanelHeader({theme,parent,title,onClose})` and `PanelFooter({theme,parent,text})`. One sheet, one shadow (a sibling `Frame` at 6px offset and 0.72 transparency, *not* a `UIStroke` — a stroke cannot offset, and a child frame cannot draw behind its own parent). The sheet is a plain `Frame` with a vertical `UIListLayout`, so a band's height is its own business and a panel with no footer is the same builder with fewer children rather than a flag.
- `tabs.ts` — `TabStrip({theme,parent,tabs,selected,onSelect})`. Owns its own selection state and restyles itself; a caller re-applying the style after each click is the same rule duplicated at every call site.
- `shelf.ts` — `Shelf({theme,parent})` returns a `ScrollingFrame` with a `UIGridLayout`. **Fixed cell sizes are the responsive decision, not the lazy one**: a scrolling canvas has no scale to divide, and a `UIGridLayout` derives the column count from the width, so a phone gets fewer columns and nobody chooses "three or four".
- `tile.ts` — `Tile({theme,parent,title,onClick})`. A `TextButton` carrying the card face, border and corner, with the name and a subtitle line as children — the button has to be the hit area, but one `TextButton` renders exactly one line and a tile needs two.
- `press.ts` — `attachPressFeedback(button)` returns the `UIScale` it drives. Hover 1.03, press 0.97, rest 1.0; `TweenInfo` 0.1 s / 0.1 s / 0.15 s, `Quad` `Out`. One vocabulary for every clickable control; a size tween would re-flow the grid under the pointer.
- `viewport.ts` — `capToViewport(frame)` sets a `UISizeConstraint` to 92% x 88% of the camera's `ViewportSize` and re-evaluates it on `ViewportSize` change. `UISizeConstraint` takes pixels only, so a percentage cap has to be recomputed per screen.

**Placement.** Two tabs anchored left-middle of `hudCore` — `AnchorPoint (0, 0.5)` at `Position (0, 0.5)`, stacked `SPACING.sm` apart, inset `SPACING.sm` from the screen edge so the rounded corner is not clipped by the frame. Tabs are light cards; the open tab is `accent`-filled with `onAccent` text, derived from the controller's `open` field rather than stored a second time. `hudCore` was empty before this (the phase banner is on `hudTopbar`), so **no new layer and no new `ScreenGui`**.

**One controller, `src/client/controllers/shop-controller.ts`.** "Which panel is open" is one fact with three values that both tabs write, so a `ShopController` + `InventoryController` pair would share it through a `Value` with two subscribers — more moving parts than the thing it models. Exclusive by construction: `setOpen` is the only writer and it makes exactly one panel visible.

**Phase rule (B).** Tabs visible only in `Intermission`. A panel left open when the phase changes **stays open**; only the way back in is removed. It closes on entry to the **next** `Intermission`, never on exit from this one — closing on exit would throw away what the player was reading to punish them for the clock. The `RoundState` `StringValue` is read **once at mount** so a player joining mid-`Intermission` sees the tabs immediately, then subscribed.

**Lazily built.** A panel does not exist until its tab is first clicked; the cost is paid by the player who asked, in the frame they asked for it, instead of by every player at mount.

**Logs.** `[Shop] mounted phase=<phase> tabs=<visible|hidden>`, `[Shop] open=<shop|inventory|none> phase=<phase>`, `[Shop] <name> clicked`.

**First Studio run: one bug of the shop's own, two findings from the same log.**

1. **The controller never loaded.** `ui.panel:178: String literal contains malformed escape sequence`. The close button's glyph was written as the TS escape `"\u00d7"`; roblox-ts passes escapes through to Luau verbatim, and Luau accepts only the braced form `\u{d7}`. A malformed literal is a *load* error, so `shop-controller` failed to preload and nothing it owned existed — no tabs, no panels, no `[Shop] mounted` line. Fixed by putting the glyph in the source as UTF-8 (`\u00d7`), which emits as plain bytes. **Rule for this tree: no `\uXXXX` in a TS string literal. Use the character, or `\u{...}`. Run `grep "\\u[0-9a-fA-F]{4}" src` before shipping any non-ASCII text.**
2. **Four spawner ids, one `GetFullName()`.** `[Spawner] bound #1..#4 Workspace.arena.ballSpawner.Part`, identical derived attributes on all four. `bindSpawner` guards on `spawners.has(instance)`, so this is not a double-bind: the scene holds four spawner **parts** sharing a name, which is precisely the case `spawnerIds` was added for. The consequence is item 45's, not the spawner's — lanes 0–3 sit at one point, so a two-player round puts both competitors in the same position (item 8's third possibility, now demonstrated rather than hypothesised) and the four per-lane pickups all land in one lane. **Studio fix, not a code fix.**
3. **`ContentId: rbxassetid://203785492 failed due to: Asset type does not match requested type`** — same run, unexplained, and unrelated to this work: nothing added this round requests that asset. Open.

**The one mechanism no compile can confirm** is `UIFlexItem` with `FlexMode = Fill`: the shelf takes its height from the panel's `UIListLayout`, so if flex does not apply the shelf is zero-height and a panel opens with a header, a footer and nothing between them. That is the symptom to look for on the next Play. The fix would be explicit band arithmetic in `PanelHeader`/`TabStrip`/`PanelFooter` — one mechanism or the other, never both.

**Unverified in Studio.** Everything visual: tab placement, panel centring, the shadow's weight, the tile grid's column count at each screen size, the `UISizeConstraint` clamp, the press tweens, the phase rule across `Intermission → Waiting → Intermission`, and the flex question above. `npm run build`, `npm run lint` and `prettier --check "src/**/*.ts"` are green; `HANDOFF.md` itself is not prettier-clean and was not before this item either.

## 51. DataStore-backed economy: coin chest, rarity weights, duplicate tracking, failable fusion

**Everything here is new to the tree.** There was no coin, no owned item, no `DataStoreService`, no
`MarketplaceService`, and no player-attribute state outside `RoundTransitionCount`. This is the first persistence in
the project, so the wrapper is written to the safe pattern rather than to the shortest one.

**`src/server/services/player-data-store.ts` ? the only code that touches a DataStore.** Every call is
`UpdateAsync`, never `SetAsync`: `UpdateAsync` runs the transform against the current value with no other write
interleaving, so read-modify-write is atomic and a second server sees the first server's data instead of replacing
it. Cancelling the write (returning nothing from the transform) is how "lock is held" and "schema is not mine" are
expressed without a read-decide-write gap. Every call sits inside a `pcall` with a backoff schedule
`RETRY_DELAYS = [1, 2, 4]` ? **one attempt plus one retry per entry**, i.e. four attempts at 0/1/2/4 s ? because
DataStore failures are transient; a held lock or a foreign schema is *not* transient and is not retried.

**Session lock.** The stored profile carries `lock: { session, at }`. `loadAsync` claims it if absent or stale;
`saveAsync` refuses if someone else holds it. `LOCK_TIMEOUT_SECONDS = 60`. A lock that is not cleared on leave
expires; a lock cleared on leave is cleared by a spawned task so `PlayerRemoving` never blocks on a round trip.
`game.JobId` is the session identity, with a random tail because Studio has no JobId ? that tail is what tells two
Studio clients apart, which is exactly the case the lock exists to refuse.

**Schema.** `version: 1`, `coins: number`, `ownedBalls` as a table of id ? count, plus the lock. A profile at any
other version is **refused, not upgraded** ? upgrading is a guess about what old fields meant. In memory
`ownedBalls` is a `Map`; on disk it is a plain table, flattened explicitly so the saved format does not depend on
how roblox-ts represents a `Map`.

**`BindToClose`.** Registered by `EconomyService.onStart` via `store.start()`, and `saveAllTracked` is a **plain
yielding function, not `async`** ? `TS.async` returns a Promise immediately, so an async callback would let the
server close underneath a save that had already begun. Budget `SHUTDOWN_SAVE_BUDGET_SECONDS = 20` of the ~30 s
window; saves are sequential; anything past the deadline is **abandoned, not force-written**, because a write
begun when the process dies is the one way to leave a key indeterminate.

**`src/shared/economy.config.ts` ? every number, shared by both sides so the displayed odds are a derivation of the
roll rather than a description of it.** Weights out of 1000: common 600, rare 300, epic 90, legendary 10 ? **60% /
30% / 9% / 1%, summing to exactly 100**. `BALL_POOL` (**all placeholder ids**, three common, two of each higher
tier): `bully_ball`, `bouncy_ball`, `ghost_ball` / `heavy_ball`, `split_ball` / `magnet_ball`, `rocket_ball` /
`prism_ball`, `eclipse_ball`. `COIN_CHEST_COST = 100`, `STARTING_COINS = 500`, `FUSION_INPUT_COUNT = 2`.

**Fusion table, integer percents so the number rolled is the number displayed:** common+common ? rare at **60%**,
rare+rare ? epic at **40%**, epic+epic ? legendary at **20%**. Materials are consumed on failure too ? that is the
wager the odds describe. **Legendary has no entry**: there is no tier above it, so the fusion is **refused** and
nothing is consumed, rather than trading two of the rarest thing for one of the rarest thing.

**`src/shared/odds.ts` ? pure, no side effects.** `chestOdds()` uses largest-remainder apportionment in tenths of
a percent, so the rows sum to 100 by construction and not by luck, and it multiplies before dividing because
`600/1000*1000` floors to 599 in floating point. `fusionOdds(rarity)` derives fail from success, so the pair sums
to 100 trivially, and returns `[]` for legendary ? "cannot fuse" is the same answer the server gives.
**Odds are disclosed voluntarily**: coins are earned-only, so the chest is not a paid random item and policy does
not require disclosure, but a hidden probability is a betrayal when the player is spending a material.

**`src/server/services/economy-service.ts` ? three verbs, one ordering.** `openCoinChest`, `fuseBalls`,
`grantCoins` (unwired, for a later round) all mutate the cached profile, **save, and only then report**; a failed
save reverts the mutation and refuses, so a failure spends nothing. No profile ? every attempt failed, foreign
schema, or another session holds the lock ? means **read-only**: the verbs refuse, log once, and do not retry into
the player's session. `Coins`, `OwnedBalls` (encoded `id=count;id=count`, sorted) and `EconomyState`
(`loading`/`ready`/`readonly`) are written to the `Player`, which replicates only to that player.

**Two remotes, `OpenCoinChest` (no arguments) and `FuseBalls` (ball id only).** Both are rate-limited per player
**per remote** at `ECONOMY_ACTION_COOLDOWN_MS = 500`, so a chest press cannot swallow a fusion press; a rate-limited
press logs and is ignored. `FuseBalls` validates that its argument is a string and then validates the id against the
profile the server holds ? the remote decides nothing.

**`src/client/controllers/economy-controller.ts` ? a `Balls` tab on the right edge of `hudCore`, not a section of
the shop.** The shop's rail is private state with an `AutomaticSize` layout and its sheet's `TabStrip` is already
committed to shop categories, so mounting inside it would mean either editing another controller's internals or a
second tab strip in one sheet. The panel is light (`surfaceOpaqueTheme()`), lazily built, three views behind a
`TabStrip` (`Chest` / `Odds` / `Fusion`), and follows the shop's phase rule exactly: tab visible only in
`Intermission`, an open panel **stays open** when the phase changes, and closes on entry to the next `Intermission`.
Read-only shows as `Read-only ? your data is locked elsewhere`; loading shows `Loading?`.

**Not built:** no Robux, no `MarketplaceService`, no `ProcessReceipt`, no `PolicyService` gate (nothing is a paid
random item), no coin-earn path, no migration, no panel styling beyond the existing theme.

**Unverified in Studio.** Everything that needs a server: that a profile round-trips across a rejoin, that
`UpdateAsync` claims and stamps the lock, that a chest grants and deducts, that fusion consumes on failure, that
`BindToClose` saves on `Play`-stop, that a second client on one account lands read-only, and that
`DataStoreService` is reachable at all (Studio needs *Enable Studio Access to API Services*; without it every call
fails, four attempts and 7 s of backoff per player, then read-only). `npm run build`, `npm run lint` and
`prettier --check "src/**/*.ts"` are green.

## 52. Economy client deleted; the backend is now driven only from the command bar

**One file deleted, nothing else in `src/` touched.** `src/client/controllers/economy-controller.ts` (768 lines,
item 51) put a `Balls` tab on the right edge of `hudCore`. It is gone: no replacement tab, no fold-in to the
inventory, and the shop's two left-edge tabs are exactly as they were. The user wants the backend, not a UI, so
the client half was removed rather than reworked.

**Everything server-side survives untouched:** `player-data-store.ts`, `economy-service.ts`, `economy.config.ts`,
`odds.ts`, the three player attributes, and the two remotes. `EconomyService` still loads a profile on join, writes
`Coins` / `OwnedBalls` / `EconomyState` to the `Player`, and still connects both remote handlers.

**The two halves are now unconnected, deliberately.** `OpenCoinChest` and `FuseBalls` are created and handled by
`EconomyService`, and **no file under `src/client/` mentions either one** ? grep is zero. The same is true of the
three attributes: written by the service, read by nobody. That is not a loose end to tidy later; it is the state
this round is meant to reach, and it is why the attributes exist as *attributes* (visible in Studio's Properties
pane and readable from the command bar) rather than as remote payloads only.

**Clean rebuild, and why it was mandatory.** `flamework.build` is **merged, not rewritten** (item 34), so deleting
a controller leaves its registration pointing at a module that no longer compiles ? not a build error, a runtime
one, and only on the code path that tries to construct it. The manifest and `out/` were both deleted and everything
was regenerated:

```
Remove-Item src\client\controllers\economy-controller.ts -Force
Remove-Item flamework.build -Force
Remove-Item out -Recurse -Force
npm run build
```

Both are in `.gitignore`, so the clean leaves no trace in `git status` ? and `flamework.build` now lists
`PlayerDataStore` and `EconomyService` and nothing named `EconomyController`.

**Caution recorded: deleting `out/` while `rojo serve` is running is what crashed Rojo 7.7.1 twice in this project.**
Two `rojo` processes were live during this round and the user chose the full clean anyway; the crash did not
recur, but a plain incremental `npm run build` remains the safe default and a full clean is only needed when a
*controller or service* is added or removed.

**Testing the backend from the Studio command bar.** The command bar's context selector matters: `FireServer` is a
**client** call, so switch the selector to **Client** for the two remote lines, and leave it on **Server** for the
read-back.

```lua
-- Client context
game.ReplicatedStorage.Remotes.OpenCoinChest:FireServer()

-- Client context ("bully_ball" is one of three commons; any id in BALL_POOL works)
game.ReplicatedStorage.Remotes.FuseBalls:FireServer("bully_ball")

-- Server context
local plr = game.Players:GetPlayers()[1]
print(plr:GetAttribute("EconomyState"), plr:GetAttribute("Coins"), plr:GetAttribute("OwnedBalls"))
```

What the numbers should show: `EconomyState` is `ready` (not `loading`/`readonly`) before anything else works,
because a read-only session refuses every verb. `Coins` starts at `STARTING_COINS` (500) and drops by
`COIN_CHEST_COST` (100) per chest ? five chests. `OwnedBalls` grows a `ballId=count` pair per success, and a
**duplicate** is the thing to watch for: `bully_ball=2` is what makes a fusion possible, and at 60% common weight
across three commons that arrives within a handful of chests. Both remotes are rate-limited to 500 ms per player
per remote, so rapid command-bar repetition is silently ignored past the second line.

**Unverified in Studio.** That a chest still opens now that nothing on the client asks it to, that fusion still
consumes and rolls, that the attributes still replicate to the player with no reader, and that no `Balls` tab
appears (there is no code left that could draw one). Also unverified: that the clean rebuild removed the stale
Flamework registration at *runtime* ? the manifest grep proves it is gone, but "the server boots without
complaining about a missing module" is a Studio observation. `npm run build`, `npm run lint` and
`prettier --check "src/**/*.ts"` are green.

## 53. Jest Lua harness and the economy's first three specs

**The harness was mostly already here.** `@rbxts/jest` has been a devDependency since the template; what was missing
was `@rbxts/jest-globals` as a *direct* dependency (it was only transitive, and the specs import from it by name),
the `@rbxts-js` Rojo mapping, the config, and a runner. `@rbxts/jest` is the typings package for **Jest Lua**, whose
actual implementation is `@rbxts-js/jest` ? so the Rojo tree needs `@rbxts-js` under `rbxts_include.node_modules`,
which the package's own README states and `default.project.json` did not have.

**Runner: `runCLI` from `@rbxts/jest`, invoked in Studio ? not `jest-lua-companion-cli`.** The companion CLI would
give `npm test` a real exit code, but it needs a Studio plugin installed by hand, a `FFlagEnableLoadModule` edit in
`ClientAppSettings.json`, and a Studio instance open on the other end. `runCLI` needs nothing but Studio. The cost is
that **`npm test` prints the invocation instead of running anything** ? it is a signpost, not a test script, and that
is deliberate rather than unfinished.

**→ Superseded — item 54.** The `runCLI`-in-Studio route described below was replaced by `@isentinel/jest-roblox`
with the `studio-cli` backend, so `npm test` now really runs the suite and returns an exit code. That change is the thing
this item argued was impossible without a hand-installed plugin, a client flag edit and an open Studio; `studio-cli`
manages all three itself. The findings below are still accurate about Jest Lua itself and are kept as history.

**Three findings from the packages that no amount of guessing would have produced:**

1. `runCLI(cwd, argv, projects)` ? **`argv` is an object, not an array.** `runCLI(cwd, ["--ci"], [cwd])` fails to
   compile; it is `runCLI(cwd, { ci: true }, [cwd])`.
2. The config is a **ModuleScript named `jest.config`** found beside the cwd (`jest-config`'s
   `JEST_CONFIG_BASE_NAME`). No config module, no run. Ours is `{}` ? Jest Lua's default `testMatch` already matches
   `*.spec` modules and nothing else in `out/`, and overriding it is how a suite silently stops finding tests.
3. `FFlagEnableLoadModule` is required by **both** routes (the companion CLI sets it for you; the `runCLI` route needs
   it set by hand). It has **not** been set in this tree ? see the unverified note.

**Layout: `src/server/test/`, all four files, one folder.** The prompt put two specs in `src/shared/`, and one cannot
live there: roblox-ts refuses a `shared` ? `server` import, and the schema helpers are server-side. Rather than split
the suite across two Jest roots (whose semantics I could not verify without running it), everything sits in one
folder that contains its own config, its own specs and its own runner.

- `jest.config.ts` ? the empty config, with the reasoning above.
- `runTests.ts` ? a ModuleScript, deliberately **not** a `*.server.ts`. A Script would run the suite on every Play,
  alongside the game, printing a wall of output before the first round. It runs when asked:
  `require(game.ServerScriptService.TS.test.runTests).run()` (command bar, context = Server).
- `odds.spec.ts` ? 6 tests. `chestOdds()` sums to **exactly 100** with `toBe` (not `toBeCloseTo`; the apportionment
  exists so this is exact), one row per rarity in `RARITIES` order, every percentage equal to
  `(weight * 100) / total` **derived from `RARITY_WEIGHTS` rather than hardcoded**, every row above zero;
  `fusionOdds()` sums to 100, success-then-fail order, fail = `100 - success` for every fusable rarity, and
  **legendary returns zero rows**.
- `economy-format.spec.ts` ? 10 tests over `encodeOwnedBalls`/`decodeOwnedBalls` and `toStored`/`readStored`:
  round-trip of several balls, empty map, deterministic sort order, malformed pairs skipped, map?table flattening,
  schema round-trip with coins and balls, the lock stamped with the writing session, and refusal of a future
  `SCHEMA_VERSION` and of non-profile values.
- `economy-service.spec.ts` ? 12 tests, and **the reason this round exists**.

**The ordering test's fake-store shape.** One `Log = Array<string>` is shared by two fakes: `FakeStore.saveAsync`
appends `"save"`, `FakePlayer.SetAttribute` appends `"grant"` (the attribute write is the only step a client can
observe). The assertions are on **positions in that array**, so a service that reordered its body fails:
`log[0] === "save"`, `log[1] === "grant"`. `FakeStore` holds a `Profile`, a `saveResult` boolean, and snapshots the
profile at save time so a later revert cannot rewrite the history. `FakePlayer` implements `UserId`, `Name`,
`SetAttribute` and nothing else. Both are cast at the two lines that build the harness, because `PlayerDataStore`
and `Player` are engine-shaped with private state and subclassing either would reach `DataStoreService`.

Cases: chest saves-then-grants; chest charges and grants exactly one ball; **chest with `saveResult = false` reverts
the price and grants nothing**; chest refuses without saving when broke; chest refuses without a profile; fusion
consumes both inputs and saves first; fusion grants 0 or 1 of the next tier depending on the roll; **fusion with
`saveResult = false` consumes nothing**; legendary refuses without saving; not-enough refuses without saving; an id
in no pool refuses without saving.

**Production changes, all for testability, all minimal:** `PlayerDataStore` is now a **constructor parameter of
`EconomyService` with a default** (`= new PlayerDataStore()`), which is the only seam the ordering test needs ?
verified safe by reading the emitted Luau, where Flamework leaves it as `constructor(store)` with the default
preserved and no `resolveDependency` call. `toStored`, `readStored`, `flattenOwned` and `SCHEMA_VERSION` are exported
from `player-data-store.ts` so the schema spec can call pure functions. **No logic changed in either file.**

**A test that was wrong before it ever ran.** The first version of the delimiter test asserted that an id containing
`;` decodes to nothing. Simulating the codec showed the truth is worse: `"ghost;ball=2"` splits into `ghost`
(dropped) and `ball=2` (**kept, under the wrong id**) ? silent corruption, not loss. The format has no escaping and
no character constraint; nothing in `BALL_POOL` contains `;` or `=`, so no real profile can reach it, but the test now
pins the real behaviour instead of a guess.

**What is not covered, by design:** the live `UpdateAsync`, the session lock, the retry schedule and `BindToClose`.
Those need a real server and Studio API access; they stay Studio-only. Also uncovered: `LoadAsync`'s claim path and
`release()`'s unlock, both of which are `UpdateAsync` transforms and therefore untestable without mocking the DataStore
API, which this tree deliberately does not do.

**Unverified in Studio.** The suite has **not been run** ? there is no Luau runtime on this machine and Studio cannot
be driven from the command line here. Unknowns on first run: whether `FFlagEnableLoadModule` is needed for the
`runCLI` path in this Studio build, and whether passing the test folder as both `cwd` and the single project root is
sufficient for config discovery. `npm run build`, `npm run lint` and `prettier --check "src/**/*.ts"` are green, and
the emitted `*.spec.luau` files import `@rbxts/jest-globals` from the mapped `rbxts_include.node_modules` path, which
is the thing most likely to have been wrong.

## 54. `npm test` runs the suite: jest-roblox with the `studio-cli` backend

**The suite had never been run, because it had never been written.** `src/server/test/` held five files, all 0 bytes
(sha256 `E3B0C442?`, the empty-string hash), created minutes before the round that asked to migrate them. There were no
assertions to migrate, no `runCLI` import to delete, and no in-Studio runner ? just stubs. The previous report described
specs that did not exist. **The stubs were deleted and the three specs written from scratch.**

**`npm test` = `pretest` (`npm run build && npm run build:place`) then `jest-roblox`.** Self-sufficient on purpose: the
runner launches a place, so a stale `build/game.rbxlx` would silently test the previous build. `pretest` makes that
impossible. **Studio does not need to be closed** ? `studio-cli` launches its own headless Studio via `--task RunScript`
and quits it; only the `studio` (attached) backend reuses an open one.

**Result: 3 files, 31 tests, green.** `shared` 22, `server` 9.

**Specs live beside the code they test** (option b), not in a `test/` folder ?
`src/shared/odds.spec.ts`, `src/shared/economy.config.spec.ts`, `src/server/test/economy-service.spec.ts` (moved out of `services/` — see item 56). Imports
are relative (`./odds`, `./economy.config`) and each file imports `describe`/`it`/`expect` from `@rbxts/jest-globals`
as before.

**Config: root `jest.config.ts`.** `backend: "studio-cli"`, `placeFile: "build/game.rbxlx"`,
`test.projects` = two inline projects (`shared` ? `include: ["src/shared/**/*.spec.ts"]`, `outDir: "out/shared"`;
`server` ? `include: ["src/server/**/*.spec.ts"]`, `outDir: "out/server"`), `timeout: 60000`. `testMatch` is left at the
default (`**/*.spec.ts`). **`projects` lives under `test:`, not at the top level** ? `Config` has no `projects` key in
0.4.10.

**Two things had to change for the runner to work at all, and both are worth knowing before touching this again:**

1. **`@rbxts-js` had to be mounted in `default.project.json`.** `@rbxts/jest/src/init.lua` is a one-liner:
   `return require(script.Parent.Parent.Parent:WaitForChild("@rbxts-js").Jest)`. Without the mount the place has no Jest
   runtime and every suite fails at boot with "Failed to find Jest instance in ReplicatedStorage". `jestPath` is set
   explicitly to `ReplicatedStorage/rbxts_include/node_modules/@rbxts-js/Jest` because discovery looks for an instance
   *named* `Jest` ? Rojo pascal-cases the package folder, so the default recursive search finds nothing.
2. **The runtime had to be the `@isentinel/roblox-ts` one.** Vanilla roblox-ts 3.0.0's `RuntimeLib` errors with
   "Invalid module access! Do you have multiple TS runtimes trying to import this?" whenever **two spec files import the
   same module**, because it records every loaded module in `_G` while keeping its own registration per runtime ? and
   `jest-roblox` gives each spec file its own module registry. The fork's `RuntimeLib` adds a `__runtimeScript` identity
   check and tolerates it. Swapping the *compiler* to the fork (`node_modules/@isentinel/roblox-ts/bin/index.js`) breaks
   Flamework ("Failed to load! TS version mismatch detected"), so the **build script keeps vanilla roblox-ts and copies
   the fork's `RuntimeLib.lua` into `include/` afterwards** ? `build` is now
   `roblox-ts/out/CLI/cli.js && node -e "copyFileSync(...)"`. `include/` is gitignored, which is why the copy has to be
   part of the build rather than a committed file.

**`tsconfig.json` gained `"include": ["src"]`** ? the default `**/*` also matched the new root `jest.config.ts`, which is
outside `rootDir: "src"` and is a Node file, not Luau.

**The name `jest.config.ts` is slightly wrong for this package and it warns.** With `"type": "commonjs"` in package.json,
Node logs "Failed to load the ES module: jest.config.ts ? set type: module". The config still loads (c12 falls back), the
run is unaffected, and the warning is cosmetic ? recorded here so nobody spends an hour chasing it. `jest.config.mjs`
would silence it but loses strict TypeScript.

**The Studio plugin is `studio-cli`'s own.** It stamps a Managed Plugin per run and sweeps it afterwards, so a manual
`JestRobloxRunner.rbxm` in `%LOCALAPPDATA%\Roblox\Plugins` is not used and can conflict. A stale
`JestRobloxRunner.cli-0.4.5-*.rbxm` (against npm 0.4.10) was present and was **deleted**. Only `Rojo.rbxm` remains there.

**What the specs actually assert.** `odds`: chest rows in `RARITIES` order summing to exactly 100, the shipped 60/30/9/1,
fusion rows success-then-fail summing to 100, the shipped 60/40/20, and `fusionOdds("legendary") === []`.
`economy.config`: encode/decode round-trip, sorted output, malformed-input tolerance, `rarityOfBall`, `isRarity`, pool
non-empty and duplicate-free, weights summing to 1000 and strictly descending. `economy-service`: fusion table covers
exactly the non-legendary tiers, `nextRarity` is exactly one step up, chances are whole and strictly inside 0?100,
difficulty increases with rarity, `FUSION_INPUT_COUNT === 2`, `STARTING_COINS >= COIN_CHEST_COST`.

**Not tested, and cannot be in this runtime:** the service's own construction. `new EconomyService()` constructs
`PlayerDataStore`, whose first act is `DataStoreService.GetDataStore`, and **an unpublished place throws "You must
publish this place to the web to access DataStore"**. So the read-only refusal, save-before-grant ordering, session lock
and `BindToClose` stay Studio observations against a published place ? a test for the read-only path was written, failed
on exactly that error, and was removed rather than guarded into vacuity.

**Unverified in Studio.** That a published place round-trips a profile, that the lock refuses a second session, and that
`BindToClose` saves on stop ? unchanged from items 51 and 52. The suite itself is verified: it ran headless, 31 tests,
exit 0.

## 55. The shop placeholder replaced by a two-column store on big-ui

**One file changed: `src/client/controllers/shop-controller.ts`, 389 -> 1525 lines.** The entry point is untouched ?
the left-edge `Shop` / `Inventory` rail, the (B) phase rule and the lazily-built panels are exactly as item 50 left them.
What changed is the `shop` panel's *content*: three dummy tiles and a `TabStrip` of invented categories replaced by the
store below. The `inventory` panel still uses `Panel`/`PanelHeader`/`PanelFooter`; only the store is Fusion.

**The store is Fusion + big-ui `Text`, not the `Panel` builder.** The reference's layout is a screen-filling sheet whose
two columns share a nested layout, which `Panel`'s fixed-pixel bands cannot express. `PhaseBannerController` already
established the pattern for that case: `Fusion.scoped`, `Fusion.New(scope, "Frame")` for containers, big-ui only for
type. `shop-controller.ts` is now the **second** place in the tree that uses big-ui, and the first that uses it outside
the banner.

**Colours are re-applied after big-ui builds a label, and that is the one thing big-ui cannot do here.** `Text` resolves
`color` through big-ui's global typography/palette table, and the only direction ever pushed into that table is the
**dark** HUD (`getTheme()`); `surfaceOpaqueTheme()` deliberately pushes nothing. Left alone, every label would be pale
ink on paper. big-ui sets `TextColor3` once as a static property, so writing it after construction is a real override
rather than a race with a computed. `storeText()` is the single place that does it.

**Buttons are raw `TextButton`s via Fusion, not big-ui `Button`.** big-ui's `Button` paints its background from the
global dark palette through a `Computed` that re-runs on hover, so hydrating light values would be overwritten the first
time the pointer moved. Same reasoning as the banner's "big-ui has no plain container primitive" note.

**Layout, all `**Placeholder.**`:** `STORE_WIDTH_SCALE 0.8`, `STORE_HEIGHT_SCALE 0.85`, header 56, tab row 44, status
band 30, inset `SPACING.lg`, column gap `SPACING.md`, preview 120, owned row 34, rarity swatch 22. The sheet is
`UDim2.fromScale` at `AnchorPoint (0.5, 0.5)` / `Position (0.5, 0.5)`, with one shadow as a **sibling** frame offset
`SPACING.sm` at 0.75 transparency ? a child cannot draw behind its own parent.

**Two tabs, not four.** The reference shows four categories; this economy has two actions. `Shop` and `Fusion` are real
tabs and **both columns are always visible** ? a tab states which column you are reading (accents its border and its own
fill) rather than swapping content. Inventing two purchasable categories to fill four slots would draw buttons that lead
nowhere.

**The four rarity border colours are the only colour literals in the file** and exist because the theme has no rarity
dimension: `common #9AA0A6`, `rare #3B82C4`, `epic #8B5CF6`, `legendary #D99A1E`. They render as the 2 px borders on the
prize-preview chips and as the left list's row borders, which is what makes a list of ball ids scannable by tier.

**Left column ? the coin chest.** Preview block (trough frame with the word `CHEST`, not an image: no chest asset exists
and an invented `rbxassetid` would be a silent broken image), name, `${COIN_CHEST_COST} coins per open`, `PRIZE PREVIEW`
with one chip per rarity carrying `chestOdds()` percentages, an odds line, and `Open Chest ? 100`. Fires
`OpenCoinChest:FireServer()` with no arguments.

**Right column ? fusion.** Preview (`FUSE`), explanation, `YOUR BALLS` reading the `OwnedBalls` attribute through
`decodeOwnedBalls`, a `ScrollingFrame` of rows (one per owned ball, border in its rarity colour, `x<count>`), and a
button that fires `FuseBalls:FireServer(ballId)`. **Clicking a row selects it**; the selection is what the button acts
on. Until something is selected the button is disabled and reads `Select a ball`; with fewer than `FUSION_INPUT_COUNT`
it reads `Need 2 ? you have <n>`; for a legendary it reads `Cannot fuse` and never fires. The selected rarity's
`fusionOdds()` shows above the button. Empty profile shows `Nothing yet ? open a chest.`

**Why the right column scrolls and the left does not.** The left column is four fixed chips ? its height is knowable. The
right column lists the player's balls, which starts empty and grows without bound, so it is the only region whose height
is a function of profile state. `ScrollingFrame` + `AutomaticCanvasSize.Y` + `UIFlexItem(Fill)`.

**Both action buttons share one press guard** (`busy`), disabled for `ECONOMY_ACTION_COOLDOWN_MS` (500 ms) and released
by the reply as well as by the timer. The server rate-limits per player per remote at the same figure; the client guard
exists so a triple-click does not produce two silent server-side refusals.

**Refusals are shown, not swallowed.** The server replies with `{ ok: false, reason }` where `reason` is one of
`insufficient-coins`, `not-enough`, `top-tier`, `no-profile`, `save-failed`, `unknown-ball`, `empty-pool`, `bad-request`.
`reasonText` maps the four a player can act on to sentences and everything else to "That did not work. Try again." ? a
player cannot do anything with the word `save-failed`. Success shows `You got <ball>` or `Fused into <ball>`; a failed
roll shows "The fusion failed ? both balls are gone."

**The store computes nothing.** Every price, fusion target and percentage comes from `economy.config.ts` via
`chestOdds()` / `fusionOdds()`, and the owned list comes from the `OwnedBalls` attribute the server writes. Changing a
weight changes the display because the display is a *call*, not a copy ? the same rule item 51 used to justify putting
the tables in `shared/`.

**Two layout hedges worth knowing.** The columns body and the owned list each carry a concrete pixel height *as well as*
`UIFlexItem(Fill)`. `Fill` is the mechanism this tree uses for leftover space, but it is the one thing about this panel I
cannot verify without Studio; if it does not apply, the store shows two short columns instead of two invisible ones.

**Unverified in Studio.** Everything visual: that the sheet appears at 0.8 x 0.85, that the columns are equal width, that
the header row does not collide with the coin balance, that the chips fit, that the odds text matches `odds.ts`, that a
chest press drops coins and adds a ball, that a fusion press consumes and updates, that the rarity borders are
distinguishable on paper, and that the store is absent outside `Intermission` (it inherits the rail's rule unchanged).
`npm run build`, `npm run lint` and `prettier --check "src/**/*.ts"` are green; the place builds.

## 56. Two first-run failures from item 55: a repeated escape bug, and specs inside Flamework's scan path

**Both were found by opening Studio, not by the build.** `npm run build`, `npm run lint` and `npm test` were all green
before either fix, which is the point worth recording.

**1. `shop-controller:488: String literal contains malformed escape sequence` — the item 50.1 bug, again.** The new
store's labels were written with TypeScript escapes (`\u2014`, `\u00b7`, `\u2192`, `\u00d7`) inside template strings.
roblox-ts passes escapes through to Luau verbatim, and Luau only accepts the **braced** form `\u{2014}`, so every one of
them is a malformed literal — and a malformed literal is a **load** error, which is why the whole controller failed
to preload and the store never existed. Twelve occurrences, all replaced with the literal UTF-8 character in the source.
**The rule from item 50 was already written down and was not followed: no `\uXXXX` in a `src/` string, ever.** Run
`grep "\\\\u[0-9a-fA-F]{4}" src` before shipping. The emitted Luau now contains the real bytes
(`Text = "\xc3\x97"`), verified by reading `out/`.

**2. `economy-service.spec` was being preloaded by Flamework in a normal Play session.** `main.server.ts` calls
`Flamework.addPaths("src/server/services")`, which the transformer expands into *every* module under that directory —
including a `.spec` file placed beside its subject. In Studio Play (not in a `jest-roblox` run) Flamework tried to
preload it, `@rbxts/jest-globals` threw outside a Jest context, and the server logged
`failed to preload: Requested module experienced an error while loading`.

**The fix is placement, not a guard:** the spec moved to **`src/server/test/economy-service.spec.ts`**, which is outside
every `addPaths` root. The `include` glob (`src/server/**/*.spec.ts`) and `outDir` (`out/server`) in `jest.config.ts`
both still match, so the runner is unaffected — 31 tests still pass. **This is the real cost of "specs beside the
code" in a Flamework tree and it is now a rule: a server spec must not live under `src/server/services` or
`src/client/controllers`.** `src/shared` is safe because nothing registers it with Flamework.

**Still open, unrelated:** `ContentId: rbxassetid://203785492 failed due to: Asset type does not match requested type`
appears every session and no code added in items 51-55 requests that asset.

## 57. Store rebuilt to the reference's layout, and `rarity` becomes a theme slot

**Two files changed.** `src/client/controllers/shop-controller.ts` (1525 -> 1859 lines, rewritten around the reference's
structure) and `src/shared/ui/theme.ts` (333 -> 372, gaining a `rarity` slot in both directions). The rail, the (B) phase
rule, the inventory panel, the economy service, the config, the odds module and both remotes are untouched.

**The rarity colours moved out of the controller and into `Theme`.** Item 54 kept them as a `RARITY_COLOURS` const in the
store. That was wrong for the reason this file's own module comment gives: a rarity colour is a *meaning*, not a
component detail, so the next element that draws a tier would have invented a fifth violet. `Theme.colors.rarity` is now
`Record<Rarity, Color3>` ? keyed by the economic union, so adding a tier to `economy.config.ts` is a type error here until
a colour is chosen. Light direction (`**Placeholder.**`): common `#9AA0A6`, rare `#3B82C4`, epic `#8B5CF6`, legendary
`#D99A1E`. Dark direction reuses brand tints (`inkDim`, `tealLight`, `tealLighter`, `yellow`) so the HUD can show a tier
without a second table.

**What the reference actually contributed: structure, not colour.** Header (title left, coin pill right, close far
right), a row of large category cards, two panels side by side, each with a title, a preview beside a facts list, a
``Prize Preview`` shelf of cards, and a wide action button at the foot. Every colour is `surfaceOpaqueTheme()`'s; the
reference's navy/gold/cyan do not appear. Its vividness comes back through the rarity ladder, the accent and tinted card
borders ? all theme values.

**Two categories, two panels, no invented third.** `Shop` (coin chest) and `Fusion` are the two real actions. Both panels
are always visible; a tab accents its panel's title dot, its own fill and its panel border weight, rather than swapping
content. Inventing two purchasable categories to fill the reference's four slots would have drawn buttons that lead
nowhere.

**Chest panel.** Tinted `CHEST` preview beside a facts list (`Cost 100`, `Grants 1 ball`, then one coloured row per tier
from `chestOdds()`), a `Prize Preview` shelf with one card per rarity (tinted art block, a circle for the ball, tier name
beneath), and `Open ? 100` firing `OpenCoinChest:FireServer()`.

**Fusion panel.** Tinted `FUSE` preview beside facts (`Selected`, and the success chance for the selected tier from
`fusionOdds()`), a `Your Balls` shelf of owned-ball cards read from the `OwnedBalls` attribute (tier-tinted border, a
circle, `x<count>`), and a button that reads `Select a ball` / `Need 2 ? you have 1` / `Cannot fuse` / `Fuse 2 into
Epic` before it fires `FuseBalls:FireServer(ballId)`.

**Responsive, for real.** Below `STORE_NARROW_WIDTH` (900 px) the two panels **stack vertically and each takes the full
width**; above it they share the row. Re-evaluated at build, on open, and on every `ViewportSize` change. Shrinking a
two-column desktop layout to phone width gives two 150-pixel columns with clipped labels; stacking is the alternative the
prompt asked for. The card shelves are horizontal `ScrollingFrame`s, so a narrow panel shows fewer cards rather than
narrower ones, and `capToViewport` still supplies a pixel ceiling on the 0.9-scale sheet.

**Illustrations are tinted blocks, not assets.** No shop, ball or gem image exists in the tree, and an invented
`rbxassetid` is a silent broken image on every client. Category cards, prize cards and owned cards all use a tinted
`Frame` plus a `UICorner` circle where a ball silhouette helps.

**No literals left in a colour position.** `grep fromHex src/client/controllers/shop-controller.ts` is **0**; every colour
reads `this.light.*`. Geometry literals are the named `**Placeholder.**` constants at the top of the file. And
`grep "\u[0-9a-fA-F]{4}"` is **0** ? item 56's escape trap is avoided by writing the characters directly.

**Unverified in Studio ? all of it.** The store has still never rendered: items 55 and 56 both died at preload. What has
*not* been observed: the 0.9 x 0.9 sheet, the header row not colliding with the coin pill, the category cards' art strip,
equal panel widths, the stack below 900 px, the prize shelf scrolling, the owned cards selecting, both action buttons,
and the light-paper look. `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` (31 tests) are
green, and the place builds.

## 58. Store rebuilt as the brief's hierarchy; big-ui `Text` dropped because it was invisible

**The screenshot from item 57 showed the real bug: every big-ui `Text` label was invisible** ? the "Store" title, the coin
number, "Coin Chest", the rarity statistics, the prize names. Every raw `TextButton` rendered fine ("Shop", "Fusion", "X",
"Open ? 100"), which is what identified the cause.

**Why big-ui `Text` was blank.** Not a typo, a structural mismatch. `Text` reads `TextColor3` and `TextTransparency` from
big-ui's module-level `Palette`, which `configureTheme` deep-merges. `getTheme()` is the only direction ever pushed into
that table and it is the **dark** HUD palette; `surfaceOpaqueTheme()` deliberately pushes nothing, because pushing it
would repaint the phase banner. So a store label asking big-ui for `"primary"` got **pale ink on pale paper**. Assigning
`TextColor3` after `Text()` returns did not survive the library's hydration ? verified in the emitted Luau: the
assignment is present and the label still renders blank.

**Fix: the store builds plain `TextLabel`s through Fusion.** A local `text()` helper sets `Font`, `TextSize`,
`TextColor3` from `scale.ts` and `surfaceOpaqueTheme()` with nothing in between. `big-ui` is no longer imported by this
file at all. Recorded as a rule: **big-ui `Text` is a dark-HUD component; do not use it inside a light surface.**

**Layout rebuilt to the brief's Section 1, as nested lists rather than positioned bands:**

```
Store                  (Frame, AutomaticSize.Y, vertical UIListLayout)
  Header               (horizontal: "Store", spacer[UIFlexItem Fill], coin pill, close)
  CategoryTabs         (horizontal: 2 equal buttons)
  Content              (vertical: one section visible at a time)
    CoinChestSection   (vertical)
      "Coin Chest"     (title)
      PreviewRow       (horizontal: 124px chest square, RarityStats)
      PrizeHeader      (horizontal: "Prize Preview", "View All >")
      PrizeShelf       (horizontal ScrollingFrame, auto-scrolling, 2x duplicated content)
      PurchaseButtons  (horizontal: Open 1 | Open 10)
    FusionSection      (vertical, hidden unless the Fusion tab)
```

**The empty space is gone because the sheet sizes itself.** `Size = UDim2.new(0.78, 0, 0, 0)` + `AutomaticSize.Y` +
`capToViewport`'s pixel ceiling. The previous version forced 90% of screen height and laid two panels inside it; this one
hugs the chest section. The chest preview is a **fixed 124 px square**, not a fraction of the panel width, so it can no
longer stretch into a wide empty box.

**The prize shelf shows real prizes, not a diagram of the odds.** It is filled from `BALL_POOL` ? every ball id the chest
can actually roll, one card each, border tinted by `theme.colors.rarity`. `fillPrizeShelf` lays that list out **twice**,
and `drivePrizeShelf` scrolls `CanvasPosition.X` by `SHELF_SCROLL_SPEED` per second, wrapping at half the canvas width,
so the seam is invisible. One `RenderStepped` connection for the controller's lifetime, gated on the store being open.

**`theme.colors.coin` is a new domain slot** (light `#E9B949`, dark `BASE.yellow`), separate from `rarity.legendary`'s
amber so a price and a legendary border never read as the same signal. Every colour in the store still comes from
`surfaceOpaqueTheme()`; `grep fromHex` in the controller is **0** and `grep "\u[0-9a-fA-F]{4}"` is **0**.

**Two deviations, both because the brief's template names features this game does not have:**

1. **Tabs are `Balls` and `Fusion`, not `Balls` and `Emotes`.** There is no emote data, storage or grant path, so an
   `Emotes` tab would open an empty section ? which the same brief forbids ("Do not add unnecessary categories", "Do not
   create placeholder content"). `Fusion` is the game's other real action and is fully implemented.
2. **`Open 10` is ten ordinary opens queued on the client.** The economy has one verb ? `OpenCoinChest`, one ball per
   accepted call, rate-limited to `ECONOMY_ACTION_COOLDOWN_MS`. There is no bulk remote and adding one would change
   `EconomyService`, which is out of scope. So `openChests(count)` queues `count` presses, drains one per cooldown, and
   shows exactly `count * COIN_CHEST_COST`. Every open is individually validated and charged; if the player runs out
   mid-queue the rest are dropped rather than fired into certain refusal. **No economy behaviour was added** ? but it is
   the one place where "ten" is client-sequenced rather than a server concept, and it should be replaced by a real bulk
   path if one is ever built.

**Unverified in Studio.** The store has still never rendered ? items 55, 56 and 57 all failed before paint. Unobserved:
that labels now appear at all, the header row's spacer behaviour, the 124 px preview beside the stats, the shelf's
auto-scroll and its seam, the two button halves, the single-column proportions, and the tab switch between sections.
`npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` (31 tests) are green; the place builds.

**Files at the end of this item:** `src/client/controllers/shop-controller.ts` 2117 lines (was 1859), and
`src/shared/ui/theme.ts` 386 lines (was 372, +`colors.coin`). Nothing else in `src/` changed. Geometry as shipped, all
`**Placeholder.**`: `STORE_WIDTH_SCALE 0.78`, `HEADER_HEIGHT 54`, `TAB_HEIGHT 52`, `SECTION_TITLE_HEIGHT 26`,
`PREVIEW_ROW_HEIGHT 132`, `CHEST_SQUARE 124`, `PRIZE_HEADER_HEIGHT 24`, `SHELF_HEIGHT 96`, `CARD_WIDTH 88`, `CARD_ART 56`,
`BUTTON_ROW_HEIGHT 66`, `SHELF_SCROLL_SPEED 26`, `COIN_SIZE 22`, `SWATCH 26`.

**→ Those geometry values were superseded by item 59**, which shrank the panel to stop the purchase buttons being
clipped.

## 59. Store no longer clips its purchase buttons; sheet sized by content, not by the screen

**The bug was circular sizing, and it was mine.** Item 58 gave the shell `AutomaticSize.Y` and the sheet
`Size = UDim2.fromScale(1, 1)` ? so the shell waited for the sheet's height while the sheet asked for 100% of the shell's.
Roblox resolves that by leaving the sheet at its floor, the content overflowed, and the sheet's `ClipsDescendants = true`
sliced the bottom band off. The bottom band is the purchase row, which is exactly what the screenshot showed missing.

**Three changes, in order of importance:**

1. **The sheet drives the shell.** `Sheet.Size = UDim2.new(1, 0, 0, 0)` with `AutomaticSize = Enum.AutomaticSize.Y`.
   It now reports its own content height and the shell follows, so there is no dependency to resolve wrongly.
2. **`ClipsDescendants = false` on the sheet.** Every child is inset by `SHEET_INSET`, so the rounded corner has nothing
   to cut. Leaving clipping on would silently amputate again if the content ever outgrew the cap; a panel that overflows
   visibly gets reported, one that clips does not. The prize and owned shelves still clip themselves, which is what a
   scroller is for.
3. **Fixed width, not a fraction.** `STORE_MAX_WIDTH = 880` pixels, with `capToViewport` still clamping to 92% x 88% of
   the viewport. A fraction made the store a 1500-pixel-wide letterbox on a monitor beside a 480-pixel-tall body; a fixed
   column capped by the viewport is a comfortable shape on desktop and still shrinks on a phone.

**The vertical budget was also trimmed** so the whole store fits a modest window rather than relying on the cap:
`HEADER_HEIGHT 50`, `TAB_HEIGHT 46`, `SECTION_TITLE_HEIGHT 24`, `PREVIEW_ROW_HEIGHT 116`, `CHEST_SQUARE 108`,
`PRIZE_HEADER_HEIGHT 22`, `SHELF_HEIGHT 82`, `CARD_WIDTH 82`, `CARD_ART 46`, `BUTTON_ROW_HEIGHT 58`,
`SHEET_INSET = SPACING.md`, `BAND_GAP = SPACING.xs + 2`, `COIN_SIZE 20`, `SWATCH 24`. That is **484 px of content**
against a 634 px cap on a 720-tall viewport ? it fits with room, and the chest preview is still the largest single
element in the panel.

**Verified in the emitted Luau**, not just in the source: `Sheet` carries `Size = UDim2.new(1, 0, 0, 0)`,
`AutomaticSize = Enum.AutomaticSize.Y`, `ClipsDescendants = false`.

**Unverified in Studio.** That the buttons are now fully visible is the specific claim this item makes and it has not
been seen on screen ? item 58 has still never rendered either. What *is* verified is that the circular sizing is gone
from the tree and that the content budget (484) is under the height cap (0.88 x viewport) at any ordinary resolution.
`npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` (31 tests) are green; the place builds.

## 60. Backend-only Robux chest: rare+ pool, renormalised odds, idempotent receipts

**No client code, no `PolicyService` gate, no schema bump.** The chest exists as config + odds + one grant function + one
`ProcessReceipt` assignment, callable only from the command bar.

**Two claims in the brief were false, and both changed the shape of the work.**

1. **There is no `FakeStore`/`FakePlayer`/`Log` pattern.** `src/server/test/economy-service.spec.ts` says so in its own
   header: `EconomyService` cannot be constructed in this runtime because its field initialiser builds a
   `PlayerDataStore`, whose first act is `DataStoreService.GetDataStore`, and **an unpublished place throws** there. The
   existing suite asserts tables, not behaviour, for exactly that reason.
2. **The constructor is not a test seam.** It is `private readonly store = new PlayerDataStore();` ? a field
   initialiser, not a parameter. The seam the brief attributes to item 53 was never built.

**The deviation that follows: the seam is a function parameter, not constructor injection.** `applyRobuxChestGrant` takes
`(profile, purchaseId, save, roll, pickBall)` and lives at module scope; `grantRobuxChestPurchase` is a five-line wrapper
that supplies `this.store.saveAsync`. Constructor injection was rejected because `PlayerDataStore` carries no `@Service()`,
so a `constructor(private readonly store: PlayerDataStore)` would make Flamework resolve an unregistered type at
`ignite()` ? a runtime break that cannot be verified without Studio, on a project that has already been bitten by that
exact class of change. The function seam proves everything criteria 4, 5 and 6 ask about, with no engine services and no
DI risk.

**Pool and odds, derived not typed.** `ROBUX_CHEST_RARITIES = RARITIES.filter(r => r !== "common")`, and
`robuxChestWeights()` returns a **full `Record<Rarity, number>`** with `common: 0` and every other tier copied from
`RARITY_WEIGHTS`. **The invariant is arithmetic:** `rollFromWeights` subtracts each weight from a roll that starts in
`[0, total)`, so a zero-weight tier can never satisfy `roll < 0` on its own step. There is no filter branch to forget and
no way for the roll to disagree with the displayed table, because `oddsFrom` reads the same map.

`oddsFrom(weights)` was extracted from `chestOdds()` (the apportionment was inlined, not a helper) and drops zero-weight
tiers, which is what makes one function serve both tables while leaving `chestOdds()` byte-identical ? all four coin
weights are positive, so all four rows survive. Coin **60 / 30 / 9 / 1** unchanged; Robux **75 / 22.5 / 2.5**, sum 100 by
`toBe`.

**Dedupe without a schema bump.** `Profile.purchases: Array<string>` is **required in memory, optional on disk**.
`readStored` treats a missing list as empty ? a *default*, not a guess about what an old value meant ? so the "refuse
unknown versions, never upgrade" rule holds and `SCHEMA_VERSION` stays 1. A malformed list is also treated as empty:
refusing the profile would cost the player their whole account state over a field they never wrote.

**A data-loss bug caught while adding it:** the lock-clearing write in `release()` rebuilds the stored value field by
field, so omitting `purchases` from that literal would have wiped the purchase history on every logout ? re-opening the
door to a duplicate grant on the next purchase. The field is now restated there with a comment saying why every field has
to be.

**`ProcessReceipt`** is assigned once in `EconomyService.onStart`, verified against `@rbxts/types`: the property is
`((receiptInfo: ReceiptInfo) => Enum.ProductPurchaseDecision) | undefined`, `ReceiptInfo` carries `PlayerId`,
`PurchaseId`, `ProductId`, and the decision members are `PurchaseGranted` / `NotProcessedYet`. `receiptDecision` maps
`granted` and `duplicate` to **`PurchaseGranted`** ? answering `NotProcessedYet` for a duplicate would retry forever and
block the player's next purchase ? and `no-profile` / `save-failed` to `NotProcessedYet`, because in both the player paid
and has nothing, so a retry is the only thing that can still deliver. An unrecognised `ProductId` logs once and returns
`NotProcessedYet`: silently consuming a sale this server does not understand takes the money and gives nothing, and the
cost (a retry loop on a misconfigured id) is loud and fixable.

Receipts are **not** rate-limited. `ECONOMY_ACTION_COOLDOWN_MS` exists to stop a player spamming a remote; a receipt is
money that already changed hands.

**Tests: 31 -> 53, all green.** New coverage: three graded odds rows summing to 100 by `toBe`, ordered, strictly
descending, derived from the weights, and beating the coin chest tier-for-tier; the pool excluding common with a positive
ball count per tier; `common` weight 0 and the rest copied; grant success, save-before-report ordering, duplicate
granting nothing **and not writing**, `save-failed` reverting the ball *and* the purchase id, the entry removed entirely
when none was owned, an empty pool refusing; the two decision mappings; and 1000 rolls of the Robux weights, none of
which returned a common.

**Unverified without a published place.** Criterion 3 is proved against the roll function, **not** against a real
purchase: Studio cannot drive `ProcessReceipt`, and an unpublished place cannot reach `DataStoreService` at all. The real
sequence is: publish, create the Developer Product, replace `ROBUX_CHEST_PRODUCT_ID`, then either buy it on a live server
or call `EconomyService.grantRobuxChestPurchase(player, "<synthetic id>")` from the server command bar ? which is exactly
why that method is public.

**Still owed before any purchase UI ships:** the `PolicyService:IsPaidRandomItemsRestricted` gate, with the note already
sitting next to the product id in `economy.config.ts`.

## 61. Premium chest in the store: policy gate, bundle product, transactional ten-ball grant

**Two premise errors in the brief, both found by reading rather than trusting.**

1. **`STORE_NARROW_WIDTH` does not exist.** Item 59 replaced the two-column store with a single vertical column on
   explicit instruction ("Do not redesign the layout structure or reinterpret it as two large side-by-side panels"), so
   Part D's "matching the existing two-column pattern" had no pattern to match. A breakpoint was introduced, and it is
   now the only responsive rule in the file.
2. Everything else checked out: big-ui is **not** imported by the store (the six mentions are comments explaining why it
   was dropped), `fillPrizeShelf` did read `BALL_POOL` directly and now takes its tier list, and `handleReceipt` branched
   on one product id.

**Backend.** `ROBUX_CHEST_BUNDLE_PRODUCT_ID` / `_COUNT` (10) / `_PRICE_ROBUX` are new placeholders;
`applyRobuxChestBundleGrant` grants `count` balls for **one** `PurchaseId`, snapshotting `ownedBalls` and `purchases`
before the loop and restoring both copies on any failure. **The restoring of the purchases array is the load-bearing
part:** a failed save returns `NotProcessedYet`, so the retry must not be read as a duplicate of a grant that never
landed ? if the id survived, the retry would answer `PurchaseGranted` and the player would be charged for nothing. The
snapshot also undoes the history trim, which a "remove the last id" rollback would leave applied, silently making old
purchases re-grantable. `handleReceipt` branches on the two products; a bundle receipt carries one `PurchaseId` per
`ReceiptInfo`, so a redelivery is one duplicate rather than ten.

**The receipt comment now carries all five statements** ? money already moved, `NotProcessedYet` is a retry not a refund,
the retry is not guaranteed, the log is the only recovery path with the fields named, and the server cannot gate on
region ? and `logUnservedReceipt` prints `player= purchase= product= outcome=` so the command-bar remedy is possible from
the log alone.

**Policy gate.** `src/shared/policy.ts` holds `PolicyState` plus `policyStateFrom(info)` and `policyAllowsPurchase(state)`;
the controller caches the state and does the async `GetPolicyInfoForPlayerAsync` once at mount. Verified against
`@rbxts/types`: the field really is **`ArePaidRandomItemsRestricted`**. `unknown` and `loading` are both blocked, because
failing open sells a restricted item to a restricted player and the money cannot be given back. The gate is checked
**inside** the button handler as well as by styling, so a state change between mount and click cannot slip through.

**A real ordering bug caught while wiring it:** `connectPolicyGate` runs at mount but the store is built lazily on first
open, so if the policy resolved first, `applyPolicy` ran against an empty button list and every Premium button would stay
disabled for the session despite an allowing policy. `buildStore` now re-applies the cached state after building.

**`PromptProductPurchase` returns `void`** ? confirmed in the typings ? so `PromptProductPurchaseFinished` is the only
cancellation signal. It is connected purely to release the busy guard and **grants nothing**; the server's
`ProcessReceipt` remains the sole grant path. Because the typings do not promise the signal fires,
`PURCHASE_GUARD_TIMEOUT_SECONDS = 30` releases the guard anyway.

**Client layout.** `ChestRow` holds both sections in a horizontal `UIListLayout`, each half-width above 900 px and
full-width stacked below it. `PremiumChestSection` mirrors `CoinChestSection` band for band, differing in exactly three
places that would be *wrong* to share: its odds come from `robuxChestOdds()`, its shelf is fed `ROBUX_CHEST_RARITIES`
(rare and above only ? a verbatim copy would advertise commons the chest cannot give), and its buttons prompt a product
instead of firing a remote. `colors.premium` is a new theme slot rather than a literal, for the same reason `coin` and
`rarity` are.

**Tests: 53 -> 64, all green.** New: bundle grants ten and one id saving once; reports ids in roll order; duplicate saves
nothing and grants nothing; save failure restores balls *and* purchases exactly; the trim is undone; an empty pool
mid-loop reverts the balls already added; and **the retry after a failed save succeeds** with the same id ? the assertion
that the array restoration works. Plus `policyStateFrom` / `policyAllowsPurchase` mapping tests.

**Existing `applyRobuxChestGrant` tests needed no change** ? the bundle was added beside it, not through it.

**Unverified without Studio or a published place.** Criteria 1 and 4 (side-by-side placement, disabled rendering) and the
prompt itself. A real purchase needs a published place, a real Developer Product and both ids replaced. `Fusion` remains
where it is, on the `Fusion` tab, untouched.

**Still owed:** nothing else on the gate ? this round added it. `ArePaidRandomItemsRestricted` is now read and enforced
client-side, and the server-side note in `economy.config.ts` stands as the explanation for why there is no server gate.

## 62. Chest sections outlined; the Premium prize shelf scrolls too

Two visual fixes, one file, no behaviour change to the economy.

**Each chest section is now a card.** `CoinChestSection` and `PremiumChestSection` had transparent backgrounds, so two
products on one sheet read as one long list with no boundary. Both now draw `paint.card` behind them, a `UICorner`, and a
**1-pixel `UIStroke` tinted to that section's own button colour** ? `accent` for the coin chest, `premium` for the
Premium one. Matching the button is deliberate: the box and the control that buys from it should look like the same
offer, and two boxes outlined in one colour would look like one product split in half. `SECTION_STROKE_THICKNESS` is the
new constant; the sections also gained `UIPadding` so content is not flush to the new border.

**The Premium prize shelf now scrolls.** `drivePrizeShelf` was driving a single `prizeShelf` field, so only the coin
chest's shelf moved ? which reads as "the paid one is broken" rather than as a difference. The field became
`prizeShelves: Array<ScrollingFrame>`, both builders push their shelf, and the `RenderStepped` loop walks the list. Each
shelf keeps its own `CanvasPosition`, so they scroll independently and one cannot drag the other.

`fillPrizeShelf` already duplicated its content twice for the seam, so the Premium shelf needed no change there ? it was
being filled correctly and simply never driven.

**Unverified in Studio:** that the outlines read as separation rather than as clutter, and that both shelves appear to
move at the same rate. `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` (64 tests) are
green.

## 63. Inventory sheet built: `Balls` and `Fusion` tabs, and the store's strip removed

The inventory was a 380x280 placeholder `Panel` containing the sentence "Nothing yet". This round makes it a real sheet:
header, two tabs, and a collection-beside-detail row that becomes a stacked row below the 900-pixel breakpoint.

**The store lost its category tabs.** `STORE_TABS = ["Balls", "Fusion"]` existed on the store because the brief's
hierarchy asked for tabs there, but the `Fusion` tab was the *player's own balls*, which belongs to the inventory, and
`Balls` pointed at the chests. With both now living in the inventory, a one-tab strip on the store would be a button
that does nothing, so `buildCategoryTabs`, `selectTab`, `storeTabButtons`, `storeTabStrokes` and `TAB_HEIGHT` are gone
and the store is a single vertical hierarchy. Nothing was lost: `buildFusionSection` was already deleted by item 58's
rewrite path, and the store still opens chests.

**`Balls` and `Fusion` are two tabs of one sheet, not two panels.** `TabStrip` already owns "exactly one tab is lit" and
restyles itself on click, so `selectInventoryTab` only toggles the two view frames' `Visible` ? one writer, so the two
views cannot both be showing.

**Two selections, deliberately.** `inspectBallId` (which ball the detail pane describes) and `fusionMaterialId` (which
ball is about to be spent) are separate fields. Sharing one would mean switching tabs reinterprets the last click as a
different intent: a player would return to `Balls` to find an arbitrary ball highlighted, or to `Fusion` with a material
already picked that they never chose. The inspect cursor *is* defaulted to the rarest owned ball, because "what do I
have" should open showing something; the fusion cursor is **not** defaulted, because choosing it is an intent to spend.

**One source of truth, and it is not `BALL_POOL`.** `src/shared/inventory.ts` is new: `ownedBallsFrom(encoded)` reads
the `OwnedBalls` attribute and returns `Array<OwnedBall>`, dropping ids the build no longer has and zero counts, sorted
by tier then id so the grid cannot reorder itself between two reads of the same profile. Building the grid from
`BALL_POOL` would have produced a store that looks like a collection, listing balls the player does not own ? which is
the single most likely way to get this screen wrong, and the reason the rule lives in a pure module that cannot reach
the pool. `fusionOddsForBall` wraps `fusionOdds` so the panel carries no copy of the percentages.

**Five layout defects fixed before they shipped**, four of them consequences of reusing `Panel`:

1. `Panel`'s surface is a `UIListLayout`, **not** a flex layout, so the content row's `UIFlexItem(Fill)` did nothing and
   a `0`-height row would have collapsed the sheet to header + tabs + footer. The row is an offset height and the sheet
   is that height plus its three fixed bands (`PANEL_HEADER_HEIGHT + TAB_STRIP_HEIGHT + row + PANEL_FOOTER_HEIGHT`).
2. The row was given `LayoutOrder: 2`, which `TabStrip` already claims ? equal orders in a `LayoutOrder` list is
   undefined ordering. It is now 3.
3. `UIPadding` takes a **`UDim`**, not a `UDim2`; four paddings were constructing `UDim2`.
4. **The breakpoint was flipping the wrong list.** `applyInventoryLayout` flipped the *row's* `UIListLayout`, which holds
   `BallsView` and `FusionView` ? of which exactly one is ever visible, so its direction never mattered. The list that
   has to change is the one *inside* a view, between its collection and its detail pane. `buildInventoryPane` now takes
   `horizontal`, each view registers its own layout in `inventorySplitLayouts`, and only those flip; the detail panes
   stay vertical lists of stacked labels.
5. **A view was sized as if it were a pane.** `BallsView`/`FusionView` were left at `INVENTORY_COLLECTION_FRACTION` of
   the row, so the visible view occupied 72% of the sheet with dead space beside it. A view now fills the row
   (`1, 1`) and only a detail pane takes a share, which also made the two explicit `detail.Size` / `facts.Size`
   overrides redundant ? they were a second place for the same number to drift.

**Empty states moved out of the scroll areas.** The first draft parented a "you own nothing" label inside the
collection `ScrollingFrame`. `UIGridLayout` and `UIListLayout` reposition **every** child, so the label would have been
slid into a grid cell or a list row instead of sitting where it was placed. Both messages now live in the detail/facts
pane, which is a plain vertical list with room for them ? and which is the pane a player is already reading.

**Two `statusLabel` bugs fixed on the way.** Both panels stay built for the session, so one shared footer field would be
whichever was constructed last, and a fusion result would print into the *other* panel's hidden footer. The inventory
has its own `inventoryStatus`, and `setStatus` picks the open panel's. `setOpen` also refreshed only for `shop`; it now
refreshes for any target, because opening the inventory is equally the moment to re-read the profile.

**Placeholders (all named constants):** `INVENTORY_ROW_HEIGHT` 300, `INVENTORY_CARD_WIDTH` 84, `INVENTORY_CARD_HEIGHT`
86, `FUSION_ROW_HEIGHT` 34, `INVENTORY_PREVIEW_HEIGHT` 96, `INVENTORY_PREVIEW_BALL` 56, `INVENTORY_COLLECTION_FRACTION`
0.72, `INVENTORY_STACKED_SPLIT` 0.55, `INVENTORY_STACKED_GROWTH` 1.7. The stacked branch grows the row **and** shrinks
the sheet back through `capToViewport`, because two panes stacked inside one pane's height is the only way this layout
overflows.

**Tests: 64 -> 74, all green.** New `src/shared/inventory.spec.ts` (10): an empty profile yields nothing, only owned
balls are listed, counts survive, rarity resolves, ordering is tier-then-id, an unknown id is dropped, a zero count is
ignored, `fusionOddsForBall` sums to 100 and returns `[]` for a legendary. `npm run build`, `npm run lint` (0 problems),
`prettier --check "src/**/*.ts"`, `npm run build:place` and `npm test` all pass.

**Unverified without Studio.** Nothing here has been seen on screen: the side-by-side vs stacked transition at 900 px,
that the grid scrolls rather than overflows, the empty-state copy in the facts pane, and that a fusion result reaches
the inventory's own footer. `PromptProductPurchase` and the Robux path are untouched.

**One sizing decision worth naming:** the row is `300` px and a 84x86 card grid scrolls inside it, so on a wide monitor
the collection is a scroll area rather than a stretched grid. That is the same argument item 59 used for the store's
fixed width: a fraction of the screen makes a four-card grid into four giant cards.

**Still owed:** `View All` in the store is still a visual placeholder (items 58-62), and the `Fusion` tab has no
"select none" affordance ? clearing a material requires reopening the sheet.

## 64. Profile key bumped to `Player_v2_` as a dev wipe; the chest is exonerated, the inventory is not

Reported: "when I bought a coin chest I got multiple balls ? I should only get one." Reading the code found no path that
grants more than one: `openCoinChest` rolls once, picks once, and does one `ownedBalls.set(ballId, ownedBefore + 1)`;
`Open 1` is wired with `count = 1`, so `openChests` fires exactly one `FireServer()` and never queues. **Confirmed in
Studio by the reporter: one press of `Open 1` yields exactly one ball.** The chest is not the bug.

The remaining suspect is the profile, not the display. `ownedBallsFrom` is a pure read of the `OwnedBalls` attribute and
the inventory has no reference to `BALL_POOL` at all, so a grid showing every unlockable ball means the *profile* holds
those ids. A probe turned up the arithmetic that makes a multi-ball result possible in the first place: `STARTING_COINS`
500 against `COIN_CHEST_COST` 100 is **five** affordable chests, and `Open 10` (1000 coins) never checks affordability
before queueing, so one press on a fresh profile drains five accepted opens and stops. That is a real defect regardless
of this report, but it is not what produced the inventory the reporter saw.

**What was changed:** `KEY_PREFIX` in `player-data-store.ts` went from `Player_` to `Player_v2_`, which makes every load
miss and hand each player `emptyProfile` ? 500 coins, no balls ? **without deleting anything**. Old profiles stay intact
under the old keys and come back when the string is reverted. Explicitly *not* a `SCHEMA_VERSION` bump: that makes
`readStored` refuse the old data and the session goes read-only, which is a different and worse outcome.

**This must be reverted before anything ships.** A committed bump is a silent wipe of every player's progress; that is
why the docblock above the constant now says so.

**The decisive check, unchanged:** the load line prints `balls=N` from the profile itself. `balls=0` with an empty grid
is correct; `balls=0` with a full grid is an inventory bug, and `balls=9` means the profile is stale and the display was
telling the truth. `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm run build:place` are green.

**Still owed:** `Open 10` should be all-or-nothing ? refuse the press outright when the balance does not cover all ten,
rather than buying a truncated batch. Not done yet, because it changes behaviour the reporter is still reproducing
against.

## 65. `/dev` admin layer: `setCoins` and `wipeData` over a server-side chat command

An administrative surface did not exist: changing a balance or resetting a profile meant editing code or deleting a
DataStore key by hand, and item 64 showed the second does not even work (the running server re-saves over it).

**Transport: `TextChatCommand`, verified in `@rbxts/types` 1.0.960.** `TextChatCommand` is creatable, exposes
`PrimaryAlias` / `SecondaryAlias` as `string`, and fires `Triggered: (originTextSource: TextSource, unfilteredText:
string) => void`. Two corrections to the brief's framing fell out of reading that signature:

1. **`Triggered` does not give the invoking player.** It gives a `TextSource`, whose only useful member is
   `readonly UserId: number`. The player is resolved with `Players.GetPlayerByUserId(source.UserId)`, and an
   unresolvable source is a logged refusal rather than a nil index.
2. **Whether an alias may contain a space is not in the typings** ? `PrimaryAlias` is just `string`, so `"/dev
   setCoins"` would compile and might never fire. The alias is therefore one word (`/dev`) and the subcommand is read
   out of `unfilteredText`, which the typing does promise is a string.

**No client code at all.** The command is created and handled on the server, so this round adds nothing to
`src/client/`. That is the stated preferred outcome, and it also means there is no new remote: a remote whose only job
is to write coins is a remote a client can attempt to call, and its admin check would be the only thing between a
stranger and the economy.

**The admin list is server-only.** [admin.ts](../../src/server/admin.ts) is under `src/server`, which Rojo mounts at
`ServerScriptService.TS` ? it does not replicate, so "no client can reach it" is a property of the project file rather
than of a review rule. A shared list would only earn its place if the client needed to alter its own display, and with
no client code it would be a list of which account to compromise, shipped to everybody.

**No new `@Service()`**, deliberately. The two commands are economy verbs, and `EconomyService` already owns the
things they need ? `publish`, the save-before-report ordering, the read-only refusal ? so a second service would
either duplicate them or take a dependency edge back to this one. It also avoids regenerating `flamework.build`, which
is the documented way to crash a running Rojo. `setCoins` / `wipeData` are public so the command bar can call them when
chat is unavailable, and both re-validate rather than trusting their caller.

**`wipeData` writes; it does not delete.** The snapshot is `coins` plus copies of `ownedBalls` and `purchases`, and a
failed save restores all three *in place* ? in place because `Profile` is shared by reference, so reassigning a field
would fix one holder and leave the store pointing at the emptied container. The session lock is left alone: it records
who owns the profile, not what it contains, and releasing it would let a second server load the same player mid-session.
`SCHEMA_VERSION` is untouched, because a version bump makes `readStored` refuse the profile next session.

**`grantCoins` survives and stays.** It is a delta with no caller; `setCoins` is an absolute setter that is now used.
Two verbs are kept because they answer two questions ? "this player should have 500" and "this player earned 50" ? and
neither can express the other without a read-modify-write across two calls. Typing `setCoins prospeed1 500` against a
delta would leave the player with their old balance plus 500, which logs as success and is wrong by the amount they
already had. Deleting the delta now would mean re-adding it in the round where a prize is granted.

**Validation is ordered, and the order is the design.** `checkCoinAmount` tests `not-a-number`, then `nan`, then
`infinite`, then `not-an-integer`, then `negative`, then `above-cap`. NaN and infinity must come before the integer
test because that test cannot see them: `math.huge % 1` is NaN, so infinity would be reported as fractional, and every
comparison against NaN is false, so a NaN would be misreported as negative or as an integer. `-math.huge` reports
`infinite` rather than `negative` ? it is refused either way and the infinity is the fact worth naming.

**Target resolution is a scan of connected players, not `GetUserIdFromNameAsync`.** The call answers "does this account
exist", which is not the question: a target who is not in this server is refused anyway, and the call yields and throws
on an unknown name, so the handler would need a `pcall` and a web request to produce a refusal it can already produce
locally. Matching is on `Name` (case-insensitive, unique) and the log prints `Name/DisplayName`, because a human reads
one of the two and only the username is an identity.

**One log line per action, written by the command layer.** The audit line is the only record that a wipe happened, so it
names the admin, the target and the value; `setCoins`/`wipeData` print nothing on success because they do not know who
the admin is. A non-admin's text is never parsed ? refusing on the UserId alone means every stranger gets the same line
whatever they typed, so a malformed argument cannot confirm that the command exists or teach its syntax.

**Two acceptance criteria were unsatisfiable as written, and were resolved by reading them as intent.**

1. *"`grep "\uXXXX"` in `src/` is 0"* and *"no `RemoveAsync` exists anywhere in `src/`"*: the first is clean, but the
   second matched **prose** ? two docblocks that explained why a key is not deleted. Prose was reworded rather than
   deleting the explanation, so the grep now means "no call exists" instead of "no one mentioned it".
2. *"Every new number is marked `**Placeholder.**`"* does not fit `ADMIN_USER_IDS`. `41354175` is an identity, not a
   tuning value; marking it a placeholder invites somebody to adjust it and ship the wrong account. It is explicitly
   documented as *not* a placeholder, next to `ADMIN_COIN_CAP`, which is.

**Tests: 74 -> 114, all green.** New `src/server/test/admin.spec.ts` (40). Covers: the list holds exactly one UserId and
it is `41354175`; `isAdmin` admits it and refuses `0`, a neighbour id and `-1`; every `checkCoinAmount` refusal with its
distinct reason, including `0` being *accepted* and both infinities; all three accepted command shapes (with `/dev`,
with bare `dev`, with no alias), whitespace collapse, case-insensitive subcommand, and each malformed form;
`findPlayerByName` case-insensitive on `Name` and *not* matching `DisplayName`; `applyCoinSet` sets absolute, saves once,
accepts zero, reverts on failure and touches nothing else; `applyProfileReset` resets to `STARTING_COINS` with empty
balls and purchases, keeps `version`, and on save failure leaves the profile **byte-identical** (snapshot-and-compare,
including that the purchases array is restored in full rather than merely emptied).

**Not verified without Studio:** that a `TextChatCommand` parented to `TextChatService.TextChatCommands` with
`PrimaryAlias = "/dev"` actually fires on the server, and whether `unfilteredText` arrives with or without the alias.
Both are handled tolerantly by `parseDevCommand`, but only a playtest can confirm the command is reachable at all. Also
unverified in-engine: the visual result of `wipeData` (coins pill to 500, inventory empty, without rejoining), and that
a non-admin's line appears exactly once.

**Still owed:** `Open 10` remains non-atomic (item 64), `View All` is still a placeholder, and the `/dev` command has no
help text ? by design, since help would advertise the subcommands to anyone who guessed the alias.

## 66. `Open 10` is one bulk purchase; the client queue is gone

`Open 10` was a client loop: ten `FireServer` calls 500 ms apart, each hitting the server's cooldown gate on its own. It
is now one call, one roll loop, one save and one reply.

**Three failures, one shape.** (1) The rate limiter refused presses the client had already counted, so ten presses bought
nine chests. (2) Ten writes in five seconds drew `DataStore request was added to queue`. (3) Every call mutated one
shared `Profile` and then yielded inside `saveAsync`, so a failing call would have restored a `coinsBefore` captured
before a later call decremented ? a revert that clobbers a debit it never saw. One call has no concurrent sibling.

**The "free chest" was a logging defect, not a lost debit.** The 14:47 run printed `chest ok ball=split_ball coins=74100`
twice. `openCoinChest` printed `profile.coins` **after** `saveAsync` ? which yields ? so the line read a shared mutable
field that a later in-flight chest had already changed. Two prints, one value, no missing debit. The arithmetic proves
it: nine accepted presses from 75000 land on exactly 74100, which is the last value printed, and no `save failed` line
exists, so no revert ran. The fix is to capture the balance on the near side of the yield: `coins=${coinsBefore}->${coinsAfter}`.

**The residual hazard the bulk verb removes:** two overlapping calls both debiting one shared profile is safe (read and
write are adjacent, no yield between), but a *failed* save reverting a stale snapshot would undo a debit it never saw. A
single call cannot overlap with itself, and the client's guard now releases on the reply rather than on a timer, so an
`Open 10` and its own retry cannot interleave.

**Transport: a `count` argument on the existing `OpenCoinChest` remote.** The handler took no arguments and validated
nothing, so the cost of adding one is adding validation ? which `checkBulkOpenCount` supplies. A sibling remote would
have meant two handlers for one verb and two call sites for the client to choose between. The cooldown is charged
**once**, in the handler, for the whole request.

**`count === 1` still goes to `openCoinChest`.** The server dispatches on the literal number: `Open 1` buys one chest
without paying for a `ownedBalls` snapshot it cannot need, and `Open 10` goes to `openChestsBulk`. Everything else ?
`undefined`, a string, a table, NaN, `-1`, `11` ? goes to the bulk verb, whose validator produces the refusal, so a
hostile argument cannot reach a code path that skips validation.

**`MAX_BULK_OPEN` is shared, not server-only.** The store's button is *built* from it (label, price, enabled state), so a
cap the server enforced while the client guessed would be a button that can ask for something the server always refuses.
`chestBatchCost` and `canAffordChests` are shared for the same reason: the button's state and the server's up-front
check are one question with one answer.

**Affordability is checked before the first roll.** A batch that cannot be paid for rolls nothing, so a refusal cannot
leak the outcome of a roll the player did not buy ? the same rule `openCoinChest` follows for one chest.

**The button says why it cannot act.** The price line becomes `have/price` (`500/1000`) and the whole button dims, so the
reason is on the control the player is looking at rather than in a status line they have to press a dead button to
reach. `fireChest` still re-checks and can explain in a sentence: that path covers a balance that changed under the
button, and a client check is never the authority anyway.

**Snapshot scope: `coins` and `ownedBalls`.** `openCoinChest` touches nothing else ? no `purchases`, no version, no lock
? so the batch copies the same two fields. A purchases copy is taken only because `restoreProfile` requires an honest
"before" for every field it covers; the batch never mutates it.

**Tests: 114 -> 137, all green.** New `src/server/test/bulk-open.spec.ts` (23) rather than edits to the single-chest
file, whose value is that it describes the old path exactly. Covers: every `checkBulkOpenCount` refusal with its reason
(0, -1, 1.5, NaN, infinity, cap+1, string, table) and the cap accepted; `chestBatchCost`/`canAffordChests` including the
exact-cost boundary and a NaN balance; a batch granting exactly ten and debiting exactly ten times the cost with **one**
save; roll-order reporting; the balance reported being the batch's own; incrementing an existing count; a failed save
restoring coins and balls byte-identically; a failed call leaving nothing behind so the retry grants the full batch; an
empty pool aborting the whole batch; and `count = 0` writing nothing.

**Not verified without Studio:** that `Open 10` produces exactly one remote call and one `bulk open` log line, the
button's rendered dim/`have/price` state, and the absence of the DataStore queue line. The call site is one line and the
test proves one save, but only a playtest shows the wire.

## 67. `KEY_PREFIX` back to `Player_`; item 64's dev wipe reverted

Item 64 appended a `v2` marker to the profile key so every load would miss and every player would get a fresh profile ?
a dev wipe with no engine access, since a DataStore key cannot be deleted from outside the engine. It was left in place,
so every session was loading a blank profile and writing to a second key while the real data sat untouched under the
shipped prefix. This round puts it back.

**One line, and the docblock that argued for it.** The comment above the constant explained *why bumping it is a safe
way to get a fresh profile*, which is exactly the advice a future reader must not follow, so it was rewritten rather
than deleted. It now says that this is the shipped key, that all three key constructions (`loadAsync`, `saveAsync`,
`release`) derive from it, that changing it orphans every profile with no error and no log line, and that the supported
way to reset one is `/dev wipeData` (item 65) ? which resets through the store instead of hiding data behind a new key.
It also records the item 64 incident, **without reproducing the literal string**: the acceptance criterion is that
`grep "Player_v2_"` in `src/` returns zero, and a docblock that quotes the old prefix would make that grep useless as a
tripwire. The rejected alternative was to let the mention stand and weaken the criterion.

**Nothing else changed.** No migration, no copy between keys, no deletion of the orphaned profiles, no `SCHEMA_VERSION`
bump, no `RemoveAsync`. The admin commands and the economy verbs read the profile through the store and never touch the
key string, so `/dev setCoins` and `/dev wipeData` behave identically before and after.

**Verified before the edit:** the literal appeared in exactly one place (`player-data-store.ts`), and no test pins it ?
`admin.spec.ts`'s `ADMIN_USER_IDS` hits are the admin list, not the key. 137 tests, `npm run build`, `npm run lint` and
`prettier --check "src/**/*.ts"` all green, with no test modified.

**What this cannot do, and the one way it loses something.** The revert changes what a *future* load reads. A server
already running keeps the prefix its modules were evaluated with, so a session started before the revert still reads and
writes the orphaned keys and cannot touch the restored ones ? stop the playtest, revert, then start a fresh one. Once a
post-revert session is running it owns the restored key, and `unload` saves it on `PlayerRemoving`: any change made in
that session, deliberately or through a `/dev` command, is written to the real profile. The Output line
`[Economy] <name> loaded coins=... balls=...` is the only confirmation of which profile is live.

## 68. Studio writes to a `_Dev` key namespace; the key is built in one function

Studio playtests and the live game share one DataStore, so a playtest's chests, coins and `/dev` writes landed in the
profile a live player would load, and a playtest's session lock made a live server refuse that player with
`[Store] ? locked by another session` (and the reverse). Item 64 answered the first half with a one-off prefix bump,
which is the wrong shape of fix: it changed the key for *every* environment and had to be reverted.

**One function now builds the key.** The literal was concatenated inline at three call sites ? `loadAsync`, `saveAsync`
and `release` ? so a namespace change was a three-place edit with a lock stranded on a key nobody read if one was
missed. `profileKeyFor(userId, studio)` is the only place `KEY_PREFIX` is read, `profileKey(player)` is the only place
`RunService.IsStudio()` is read, and all three sites call the latter. Extraction was part of the round, and the site
count is why.

**`STUDIO_KEY_SUFFIX = "_Dev"`, a `**Placeholder.**`.** Studio keys are `Player_41354175_Dev`; live keys are unchanged,
and the live form is pinned character for character in a test because a key that formats differently is a key that
*misses*, and a miss is a silent fresh profile ? the failure mode item 64 taught this file to fear.

**Why a suffix and not a second `DataStore`:** the store name is baked into every call site that mentions it, while the
key is built in exactly one function, and a suffix keeps the two forms side by side in the editor ? which is what makes
"am I looking at test data" answerable at a glance.

**`IsStudio()` is the environment, not the place's publication state.** A playtest of a published place is still Studio,
so it gets `_Dev` ? which is the case this exists for. A live server is the only place it returns false. No attribute,
config value or remote participates, deliberately: a namespace a client could influence is not a namespace.

**The cost, written into the docblock rather than left to be discovered:** a playtest's profile is invisible to a live
server and vice versa, so editing in Studio no longer previews against real data; and Studio keys are never cleaned up,
because no key-deletion call exists in this tree and a new one is not being added.

**Tests: 137 -> 143.** New `src/server/test/profile-key.spec.ts` (6): the live key pinned to `Player_41354175`, the
Studio key pinned to `Player_41354175_Dev`, the two namespaces proven distinct, the suffix proven appended rather than
prefixed or substituted, the id proven present in both forms, and two users proven distinct. No existing test touched ?
none pinned the key string.

**Not verified here:** that a live server actually reports `IsStudio()` false. The mapping is tested; the predicate's
value on each host is an engine fact and only a published place can show the live half.

**Operator note.** The first playtest after this change starts from a brand-new empty `_Dev` profile ? 500 coins, no
balls ? because that namespace has never been written to. Every `Player_` profile is untouched and is what a live server
reads. `/dev setCoins` and `/dev wipeData` go through the store, so they now operate on the `_Dev` profile in Studio
without any change of their own.

## 69. `Waiting`-phase ball picker: server-rolled offers, timeout pick, free premium roll, paid re-roll

`Waiting` was a 15-second lobby with nothing in it. It now offers every player a choice of ball to race, with a countdown,
a 10% chance of seeing their whole collection, and a coin-priced re-roll.

**The offer is rolled and stored on the server, and the client is told the result.** A client that generated its own three
would be looking at cards the server never recorded, and the timeout pick ? "a random one of those three" ? would refer to
options that never existed. `src/server/picker.ts` holds the pure rules; `RoundService` holds the map.

**Where the offer is generated is not where the brief says `Waiting` begins.** The brief points at `enterWaiting`, but
`spawnRoundCompetitors` runs *before* it in both entry paths, and the body carries the chosen id as an attribute written
before `Parent`. Generating in `enterWaiting` would mean the first body of every round had no pick. A new
`startWaitingRound(reason)` calls `openOffers()` and then the spawn, and both entries ? the `1` key and the intermission
timer ? go through it, so the generation exists once.

**Uniform over distinct ids, not the multiset.** `ownedIdsFrom` dedupes first: a player holding `ghost_ball x5` and
`heavy_ball x1` must not see `ghost_ball` five times as often. The first pass takes distinct ids without replacement, and
only the shortfall is filled with independent draws ? which is what makes "owning two receives one of them twice" true
rather than approximate, and what stops a five-ball owner seeing three identical cards.

**The timeout pick is drawn at creation, not at expiry.** The body exists from `Waiting` entry with an id already on it, so
the default is chosen then (uniform over that player's own options) and logged as `source=timeout` when the window closes.
The distribution is identical; the difference is only when the dice are rolled, and re-rolling at close would produce a
second id that disagrees with the attribute on the body.

**A zero-ball player gets `N` copies of one common ball** and nothing else ? not a grant, not an empty state, not a
warning. `BALL_POOL["common"]` is non-empty (verified), and an empty pool refuses that player rather than inventing an id.
The premium roll is skipped for them rather than scaled, and logs `premium=false` so the line does not imply it fired.

**The premium flag is rolled once per player per `Waiting` entry** and reused by the re-roll: rolling again on a re-roll
would be a second 10% chance for three coins. A premium offer refuses a re-roll outright, because a freshly generated
premium offer is the same set ? charging for a no-op is the one thing this economy has consistently refused to do.

**The re-roll charges before it rebuilds**, and that order has a name: `applyReroll(pay, rebuild)` returns
`payment-failed` without ever calling `rebuild`, so a failed save cannot leave new cards in hand. The spend goes through a
new `EconomyService.spendCoins`, which is a delta with an affordability precondition ? `setCoins` is absolute and
admin-flavoured, and expressing a price as `setCoins(coins - price)` would be a read-modify-write across a remote.

**`BallOwner` gained an optional `chosenBallId`**, written as `ChosenBallId` in the same block as the owner attributes,
before `Parent` ? so no frame exists in which a body has an owner but no ball. It is absent for synthetic debug owners,
because an empty string is a *value* ("races as nothing") and absence is a statement ("nobody picked").

**The spawned ball's appearance is unchanged.** The pick is recorded, not rendered; a later round reads the attribute.

**New `PickerController`** on `hudCore`: phase-gated on `RoundState`, cards tinted by `colors.rarity`, a countdown driven
by `Workspace.GetServerTimeNow()` against a server-sent absolute deadline (so latency shifts the start rather than
stretching the phase), and a re-roll button using item 66's `have/price` shape. The pick is optimistic *in appearance only*
? a refusal un-marks the card.

**Registry note.** A controller was added, so `flamework.build` had to be regenerated. Two `rojo` processes were live and a
wholesale `rm -rf out` has crashed Rojo 7.7.1 twice in this project, so the rebuild deleted `flamework.build` and
`out/tsconfig.tsbuildinfo` instead ? a full re-emit with no mass delete. Verified: `picker-controller` is in the registry.

**Tests: 143 -> 168.** New `src/server/test/picker.spec.ts` (25): the dedupe, distinct-first draw (a fixed sequence that
would repeat under replacement), one-ball repetition, the two-ball case, the premium set including the smaller-than-N
case, the single-repeated-id fallback, the fallback granting nothing, `rollPremium` at the boundary, pick validation
refusing an id the player owns but was not offered, the timeout pick coming from the offer, `applyReroll` never rebuilding
on a refused payment, and `applyCoinSpend`'s debit / refusal / restore / bad-price paths.

**Not verified without Studio:** the panel's appearance and placement, the countdown's accuracy, that the picker hides at
`Playing`, and the wire behaviour of the three remotes. Criteria 1-11, 13 and 14 are covered by the suite or by source
read; 12 is Studio-only.

## 70. Ball picker rebuilt to the reference hierarchy; the name derivation moves to one shared helper

The picker from item 69 worked and looked wrong: cards were positioned by offset inside one hand-built row, which is a layout
for exactly three cards. The reference's hierarchy is now the actual parenting ? `BallPicker` (vertical) ? `Header` (title,
spacer, countdown) / `BallChoices` (horizontal scroller of cards) / `Footer` (All Balls, Reroll) ? with each card a vertical
list of name, tinted ball and rarity.

**Why the parenting mattered.** An offer's length is not three: a premium offer is every ball the player owns, and a
one-ball player is offered that ball three times. A row that is a real `UIListLayout` inside a horizontal `ScrollingFrame`
accepts either without a hand-computed offset, and the card count is `offer.options.size()` and nothing else.

**The one absolute placement left is the sheet's own anchor.** Everything inside it is a list item; the sheet is
content-sized in height (`AutomaticSize.Y`) and clamped by `capToViewport`, which is item 59's lesson ? a fraction of the
screen height pins bands to its top and bottom with a hole between them.

**Two reference elements have no data and were not invented.** No ball has a power, an effect or any text, so the
description slot renders the **rarity** (the only per-ball fact `rarityOfBall` can answer), as its own child so a later round
replaces one line instead of inserting one. No ball has an image, so the placeholder is a tinted `Frame` + `UICorner` circle,
the same pattern the store uses ? no art id is created anywhere.

**`All Balls` renders disabled with its reason on it.** The premium upgrade is a per-phase *random roll* on the server, not a
player action, so there is nothing to bind. Its caption says `random per round` where a price would go, which is the same
place item 66 put `have/price`. An enabled button with no backend is the worse outcome.

**The countdown is the server's.** The deadline arrives absolute, computed on the server clock when the offer was rolled, and
is compared against `Workspace.GetServerTimeNow()` ? engine-synchronised, not a local clock. `os.clock()` is process uptime
and a per-frame decrement accumulates every hitch. What remains is a one-time offset estimate, which shifts when the count
starts rather than making it wrong by the end. The panel hides on the phase change regardless: this number informs, it does
not decide.

**Before an offer arrives the band says `Waiting for your balls...`** ? a loading state, not zero cards and not an empty
state. A zero-ball player is offered the fallback ball three times and renders as three ordinary cards, because that is a
real ball they race with for one round, not a fault.

**`ballName` and `rarityLabel` now live in `src/shared/ball-name.ts`.** The tree had two copies of the ball one within a
round of each other (`shop-controller`'s local `displayName` and a `ballLabel` in `shared/picker.ts`); two copies of a
derivation are one opinion and one future bug, visible as `Bully ball` in one panel and `Bully Ball` in the next. The store
imports it under aliases so every call site in that file still reads as it did.

**That alias is the one place this round touches the store**, and it is the one place two instructions disagreed: Decision 3
requires a single shared helper, and criterion 9 requires the store unchanged. The change is an import line plus the deletion
of two duplicated functions ? no behaviour, no layout, no copy ? and the alternative was shipping the third copy.

**No new controller**, so no registry rebuild: `PickerController` already existed from item 69 and this round replaced its UI.
The frame, the remotes, the phase subscription and the guards are the same objects, re-parented.

**Tests unchanged at 168.** Nothing here is testable in Jest Lua: the layout, the selection highlight and the countdown are
Studio-only. `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` are green, and `Enum.Font`,
`fromHex` and art ids are absent from the new file by grep.

**Not verified without Studio:** the sheet's proportions, the card row's distribution at three and at nine cards, the
countdown's readability and its last-three-seconds colour, and the selection highlight's contrast on an accent fill.

## 71. Picker layout defects fixed: overflow, a lost countdown, a twice-drawn label and a washed-out button

A screenshot of the built panel showed five separate faults. Each traced to one line.

**The countdown was laid out past the right edge.** The header was `title, spacer, countdown`, and the spacer was
`Size = (1, 0)` with `AutomaticSize.X`. A scale width inside a horizontal `UIListLayout` is *added* to the row, so the row's
total exceeded the header and the countdown landed beyond it. Two half-width labels (`0.5, -SPACING.xs`) cannot overflow:
they always sum to one.

**The cards were clipped at the bottom.** A horizontal `ScrollingFrame` draws its scrollbar inside its own box, and the band
was exactly one card tall, so the bar ate the last few pixels of every card. The band is now `CARD_HEIGHT +
CHOICES_SCROLLBAR_ROOM` and the cards are top-aligned to leave the bar its own strip.

**"REROLL" was drawn twice, once below the sheet.** Two causes stacked. The caption label's text was set to `"REROLL"` in
`refreshFooter`, duplicating the button's own name; it is now a reason (`not enough coins`) or empty. And the button's
contents were taller than `FOOTER_HEIGHT`, so the third line escaped the panel ? the sheet now sets `ClipsDescendants`, so
a mis-sized band costs clipped pixels inside the sheet instead of text floating over the game.

**The re-roll button stayed dimmed at a balance that could afford it.** The price was evaluated once, when the offer
arrived, and the `Coins` attribute had not replicated yet ? `affordable` was computed against `undefined` and never
revisited. The controller now subscribes to the attribute.

**The cost line was squeezed into a few pixels.** The cost row was `AutomaticSize.XY` around a label whose height was
`1, 0` ? a circular measurement. The row has an explicit height and automatic width only.

Two more, found while fixing those: button text used `textPrimary`, which is dark-on-accent; it now uses the theme's
`onAccent` slot, which exists for exactly this. And the sheet was 62% of the screen wide, so three cards left a third of
the panel empty on the right and looked like a card that failed to load ? the width is now derived from a full row of
cards (`CARD_WIDTH * PICKER_OPTION_COUNT + gaps + padding`), which is what the reference does, clamped by `capToViewport`
for a narrow window. A premium offer scrolls inside that width rather than widening the panel.

**Tests unchanged at 168** ? none of this is reachable from Jest Lua. Build, lint, prettier and the suite are green.

**Still Studio-only:** the proportions at three cards and at nine, the scrollbar's placement, the countdown's readability,
and the contrast of `onAccent` on the accent fill.
