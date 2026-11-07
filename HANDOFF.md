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

## 72. One competitor wins immediately; the `initialLiveCount` guard and the field are gone

`checkEndCondition` refused to name a winner unless the round had once had more than one competitor, so a solo session
finished `PostGame - no winner`. That is now the wrong answer: **one competitor left is the winner**, whether the round
started with one or with five. The rule lives in `src/server/round-outcome.ts` as `decideRoundOutcome(owners)` so it can be
asserted without an engine; `RoundService.checkEndCondition` became the dispatch.

**The field is deleted, not kept.** With the guard gone, nothing read `initialLiveCount` - its four resets, two writes and
its `initial=` field in the debug-spawn log were all that remained. An inert field is what this project removes, so the
declaration, the writes and the log column are gone; the debug-spawn docblock that argued for setting rather than
incrementing is replaced by a paragraph saying why no bookkeeping is needed now.

**`no survivors` is now reachable only from zero.** Two bodies destroyed in one cleanup pass: the spawner's pass destroys a
batch in a loop, each `Destroying` fires synchronously, and `evaluateAfterLoss` defers, so the whole batch lands before the
check runs and the count is genuinely zero. A body destroyed without going through elimination is the other route.

**The ordering, per spawn site (Decision 1).** All five satisfy "the count is current before any check can observe the new
body", and for one reason rather than five: **every spawn path - `spawnRoundCompetitors` (used by `forceWaiting`, the
`Waiting` timer and the intermission timer), both `forcePlaying` branches, and `debugSpawnCompetitors` - completes without
yielding**, and the only asynchronous check is `evaluateAfterLoss`'s `task.defer`, which runs after the current callback
finishes. `spawnRoundCompetitors` and `forcePlaying` track each body immediately after `spawnInLane`; the debug path spawns
in bulk and tracks in a second loop, which is equally safe because nothing can interleave a synchronous loop.
`forceWaiting` is the strongest case: it is synchronous end to end, so by the time any defer runs the phase is already
`Waiting` and `evaluateAfterLoss` returns on its phase guard.

**The mechanism chosen is "spawns are synchronous within one resumption"** (Decision 3), not a pending-spawn flag and not a
count updated at decision time. Rejected: a flag is state that has to be cleared on every failure path, and a count moved
before the body exists can be right while the body is missing - the failure mode the round's own orphan rule exists to
prevent. **The case it does not cover:** a `3` press whose remote callback runs in a *later* resumption than the deferred
check. The round has legitimately ended by then, `debugSpawnCompetitors` refuses outside `Playing`, and the press starts
nothing. That is correct behaviour rather than a gap, but it is the boundary.

**A solo round now ends at the first check.** `enterPlaying` does not evaluate the condition; the tick does, after
`TICK_INTERVAL_SECONDS` (1 s). So a session with one player finishes about a second into `Playing`, with that player named
- the rule as stated, and the visible change from `PostGame - no winner` to `PostGame - <name>`. **This is the round's most
consequential behaviour and the report names the alternative:** if a solo competitor is meant to *race* and win at the
exit, that needs a finish-line signal this tree does not have, and criterion 7's "zero competitors is `no survivors`"
would have to be revisited, because a competitor leaving is exactly what takes the count to zero.

**Tests: 168 -> 177.** New `src/server/test/round-outcome.spec.ts` (9): two and five competitors continue; a two-round's
survivor is named; a solo competitor is named with no memory of how many started (criterion 3); a synthetic `Debug#N` owner
counts identically; an empty list is `no-survivors` and names nobody; the input list is not mutated; and a repeated call is
stable, which matters because the check runs on a tick *and* after every loss.

**Not verified without Studio, in order:** (1) the `1`/`3` press landing in the same frame as a loss - the ordering argument
above is a source read, and a playtest is the only place to see it; (2) that a solo round ends at `elapsed=1.0`; (3) that
the banner reads `PostGame - <name>` and clears at `PostGame -> Intermission`.

## 73. Debug keys in phase order, and an arcade elimination splash on its own layer

**Keys: `1` Intermission, `2` Waiting, `3` Playing, `4` spawn four.** They were `1` Waiting, `2` Playing, `3` spawn, so the
lobby - and therefore the picker - was reachable only by waiting out a thirty-second `Intermission`. Every docblock and log
that named the old bindings was corrected at the same time, and the corrected text says what the old binding was, because a
reader holding an older log will otherwise watch `1` jump to the lobby and conclude the key broke. The startup line is now
`keys: 1=Intermission 2=Waiting 3=Playing 4=spawn`.

**`1` needed a new verb.** `enterIntermission` had exactly one caller: the `PostGame` hold's timed transition, which routes
through `endPlaying` first and therefore awards a winner and holds for five seconds. `forceIntermission` does the three
things a jump needs - stop the belt ramp, stop the simulation, reset the synthetic counter - and then calls
`enterIntermission`, which does the teardown and re-arms the timer from `++generation`. It is deliberately **not** routed
through `endPlaying`, which exists to decide a result, and deliberately **not** wrapped in `transitionAround`: the wipe
covers changes the player did not ask for.

**Remote names.** `DebugIntermission` is new; `DebugWaiting` / `DebugPlaying` / `DebugSpawn` already matched their actions and
were kept. All four are created at runtime by `createDebugRemotes`, not declared in the project file, so a rename leaves
nothing behind in a fresh DataModel. `ADVANCE_PHASE_REMOTE_NAME = "AdvancePhase"` was still declared from before item 35 and
referenced nowhere - deleted, since an unhandled name is exactly the stale remote the brief asks about.

**The elimination signal is a remote, not an attribute.** An attribute is *state*: it persists, it needs clearing at the next
round, and a client returning mid-`PostGame` would need a "have I already seen this value" baseline to avoid replaying it. A
remote is an *event* - fired once, to one player, at the moment it happens - and a rejoining player simply never receives one,
which is the required behaviour rather than something the client has to rule out. `Elimination` is server-to-client only, with
no `OnServerEvent` connection, and carries no arguments: the word is the controller's.

**Who is told is a pure rule** (`src/server/elimination-signal.ts`): `teardown` tells nobody (the phase changed; everyone was
removed at once), no owner tells nobody, `userId <= 0` tells nobody (`Debug#N`), and everything else tells that player. Two
call sites - `settleEliminations` (`left-belt`) and `handleExternalDestruction` (`culled`, i.e. `KillY` and the cap) - so
"the cap is an elimination but a teardown is not" has one definition. **Owner read before the destroy**, because a destroyed
instance reports its defaults and `userId 0` would fail the `<= 0` test and tell nobody silently.

**The splash lives on a new `splash` layer at display order 35**, between `hudTopbar` (30) and `transition` (40): it draws
over gameplay, so it outranks the HUD, and the wipe must still be able to cover it. `CoreUISafeInsets`, because its position
is a share of the layer and has to agree with the HUD about where 26% from the top is.

**Animation, exactly as specified:** `UIScale` 0 -> 1.15 (`0.15 s`, `Back`/`Out`) -> 1.0 (`0.1 s`, `Quad`/`Out`), hold
`0.5 s`, then `TextTransparency` and the stroke's `Transparency` to 1 over `0.2 s` (`Quad`/`In`). `LIFETIME_SECONDS` is the
sum of the four, and the frame is **destroyed** at the end rather than hidden - one frame per elimination, kept invisible, is
a leak that only shows after a long session. The scale is on the frame so the glyphs never re-typeset.

**Theme direction: `getTheme()` (HUD), not `surfaceOpaqueTheme()`.** The splash draws over the world, and the reference's
legibility is a light glyph on a near-black `Contextual` outline - a pair that survives both a pale arena and a dark one. The
light direction's dark ink would need a light outline against a dark sky, which inverts the look.

**Tests: 177 -> 185.** New `src/server/test/elimination-signal.spec.ts` (8): left-belt and culled notify the owner; teardown
notifies nobody; synthetic ids (negative) and a zero id notify nobody; an ownerless body notifies nobody; the cause table is
exhaustive (exactly two of three notify). `src/server/test/round-outcome.spec.ts` from item 72 is unmodified.

**Registry.** A controller was added, so `flamework.build` was regenerated (cache files only, no mass delete - two rojo
processes are live). `elimination-splash-controller` is confirmed in the registry.

**Not verified without Studio:** the splash's appearance and readability over the arena, the 26%-from-top position, the pop
timing, `1` leaving zero bodies on the belt with the timer counting from the forced entry, and that a `4` press during a
one-competitor round cannot save it from the immediate-win rule (item 72).

## 74. Ball powers: ten kinds, one table, a module rather than a service, and a badge

**The picker was a choice with no consequence.** Nine ball ids behaved identically and `SHAPE_POOL`'s `power?: string` was
read by nothing. This round gives each ball one power, fixed, and deletes the dead seam: a body's power comes from
`ChosenBallId` through `powers.config.ts`, because the pool describes a *shape* and two balls of the same shape race as
different powers. An unread field is a trap for the next reader who sets it.

**The table is `src/shared/powers.config.ts`, keyed by ball id.** `bully`, `bouncy`, `ghost`, `heavy`, `split`, `magnet`,
`rocket`, `prism`, `eclipse`, `sprinter`, one `kind` each out of seven, and every magnitude a named `**Placeholder.**`
constant with the arithmetic in its docblock. `sprinter_ball` is a new **common**, so the pool is ten. **The chest odds did
not move**: `RARITY_WEIGHTS` is per *tier*, so a fourth common changes the chance of each individual common (60% / 4 = 15%
each) and leaves the tier table at 60/30/9/1. The brief predicted the odds helper's arithmetic would move; it does not,
because adding a ball to a tier is not adding weight to a tier.

**`src/server/powers/` is a module, not a `@Service()`** - and that is why it can be tested. A Flamework service is
constructed by `Flamework.ignite()` against a DataModel, so ten powers living inside one would be ten rules no spec could
assert. `round-outcome.ts` is the precedent: pure rules over plain tables (`powerTickDelta`, `transferAmounts`,
`pickupDecision`, `drawTimers`, `windowOpen`, `collisionGroupFor`, `spawnsDecoy`) and a thin imperative wrapper that reads
attributes and poses instances. **36 tests**, none of which needs a `BasePart`.

**The one-writer rule survived.** `stepBallSpeeds` is still the only writer of `BALL_SPEED` inside a tick: `tickDelta`
returns a *delta*, the loop adds it to the decayed value, clamps to `[BALL_SPEED_MIN, BALL_SPEED_MAX]` and writes once.
Collision powers write directly, which is safe only because nothing else writes between two ticks - a force there would be
erased before it moved anything, which is the mistake this whole design exists to avoid.

**`BALL_SPEED_MAX = 20` is new and exists for exactly one mechanic.** A bully chain has no natural bound; item 22's log
climbed 30 -> 56.6 across 428 impulses. Every other writer is a designed value (pickup 12, sprinter 16, rocket 18), so the
ceiling sits above all of them and binds only on accumulation.

**Four decisions worth recording.**

- **Collision groups.** A group is a *pair* of names, so disabling a ghost group against `Default` would also stop a ghost
  hitting walls and the belt. Hence two groups: every ball moves to `CompetitorBall`, a ghost to `GhostBall`, and the pairs
  `GhostBall`/`CompetitorBall` and `GhostBall`/`GhostBall` are the only ones disabled. Registered once on the first spawn,
  behind a flag *and* a `pcall` (a group a designer made by hand would otherwise throw). **The cost: balls are no longer in
  `Default`**, which a designer debugging a collision will notice.
- **Auras are a registry, not an O(N^2) scan.** `magnetBalls` and `eclipseBalls` are sets maintained by `setPower` and
  `forgetBall`, so a victim's tick scans the auras that exist rather than the whole field: two distance checks per ball per
  frame with two magnets, against 2500 per tick and 150 000 per second for a full-field scan of a feature that is usually
  absent.
- **`bouncy` overrides the global bounce gate** rather than moving it per-ball. `BELT_BOUNCE_ENABLED = false` exists to
  keep a *this-round experiment* quiet; `bouncy` is a shipped property of one ball, and a gate that suppressed it would make
  the power invisible. The handler now pays one attribute read per ball contact while the gate is off, and nothing more.
- **Only colliding powers get a `Touched` connection.** The brief asked for one per ball filtered inside the handler; a
  tenth of the per-contact work for identical behaviour, and this file already pays two handlers per ball.

**Two defects the wiring exposed.**
`ChosenBallId` is written **twice** - once at spawn from the offer's timeout pick, once when the player picks - so a
`Power` derived only at spawn would leave a body carrying the player's chosen ball id and racing the timeout pick's power.
`RoundService.applyChosenBall` now calls `setPower`, which rewrites the attribute, the badge, the collision group and the
connection.
`onRoundActive` initially called `forgetBall`, which disconnects the `Touched` connection: a bully or heavy ball would have
entered `Playing` unable to collide for the whole round. State is per-round, the connection is per-body, and the two are now
cleared separately.

**Also fixed, found at the site the brief sent me to:** `destroyBall` cleared `ballKillY` but not `lateral` or
`startSpeeds`, so both maps grew by one entry per cap and kill-plane destruction for a session - `pruneDestroyedBalls`
never sees a body that was removed from `liveBalls` first. Two lines, in the block `forgetBall` had to be placed in.

**A pickup is no longer always consumed.** `prism` is the only power whose decision is `consume: true`, so every other ball
leaves the triangle in the world - which is what "and consumes the pickup" as an *effect* implies. **This is a real change
to the belt's economy and it is flagged in the report:** a pad that is never removed can be re-taken by any ball that drifts
back over it, and a ball oscillating around a pad never eliminates. `pickupDecision` is the single line to reverse.

**Badge.** `BillboardGui` has **no `AutomaticSize`** - verified in `@rbxts/types`: it extends `LayerCollector` extends
`GuiBase2d`, and `AutomaticSize` is declared on `GuiObject`. So the badge is sized from `POWER_BADGE_WIDTH` with
`fromOffset`, `TextScaled = false`, `AlwaysOnTop`, `StudsOffset` (camera-relative, so it stays above on screen), and
`powerLabelFits` asserts every label fits so a longer power name fails the suite rather than truncating in Studio. It is
created on the server, parented to the body, and is **outside the `getScreenGui(layer)` convention** - that governs screen
layers, and a world-space primitive has no display order.

**Tests: 185 -> 221.** New `src/server/test/powers.spec.ts` (36): the rocket window and its once-only snap, magnet radius
and non-stacking, eclipse windows and cross-eclipse, bully conservation, heavy asymmetry and resistance, geometric
convergence, both bounds, the three pickup decisions, the two group names, the decoy predicate, the table's one-to-one
mapping, label casing and width, that the table covers every `POWER_IDS` entry and every ball in `BALL_POOL`, and that `BALL_SPEED_MAX` clears every designed value. No existing test changed.

**Not verified without Studio:** the badge's appearance, its apparent size at distance and `MaxDistance`, whether
`PhysicsService` honours the two groups on a real place, the felt effect of every magnitude, that a decoy appears beside its
parent without a launch, and that a body destroyed mid-round really loses its state entry (a source read here, because it
needs an instance).

## 75. The debug spawn draws four distinct balls; a models table and the cross-validation test

**A Studio session could only see one power at a time, and only by editing code.** `nextDebugOwner` returned an owner with
no `chosenBallId`, so every `Debug#N` body took the "no ball id, no power" path through `spawnBall` and arrived powerless.
`4` now gives each body a different id, and everything else follows from the id: the `Power` attribute, the badge, the
collision group and the `Touched` connection are all `setPower` calls that already existed. **Nothing was wired twice** - the
only new write is `chosenBallId` on the owner.

**The draw is `src/server/debug-balls.ts`, a module and not a method.** `RoundService` cannot be constructed in Jest (its
dependencies reach `DataStoreService`), so a draw inside it could only be a source read; `round-outcome.ts` is the
precedent. `pickDistinctBallIds(count, random)` takes the random source as a parameter, which is what makes the two
properties that matter testable: distinct ids within one press, and termination for any count. It is a **partial
Fisher-Yates** - each pick is removed from a working deck - so `count <= 10` is distinct by construction and there is no
retry loop to be stuck in. When the deck empties it refills, so `count > 10` returns ten distinct ids followed by repeats
rather than hanging: **that case cannot fire today** (five lanes, ten ids) and exists so the function is total.

**Distinct per press, not against the live field.** A live-field check would refuse the button because somebody else's ball
was on the belt - a rule about the scene rather than about the pool - and with ten ids against four bodies it would refuse
for no reason most of the time.

**The log line was extended, not duplicated.** `balls=<a>,<b>,<c>,<d>` goes on the existing `debug spawn:` line, read back
off the **bodies** (`GetAttribute` on each returned part) rather than out of `owners`, so a spawn that failed cannot leave
the log naming an id with nothing behind it.

**`spawnBall`'s fallback is deliberately untouched.** A missing `ChosenBallId` still means "no ball id, no power". Moving
the draw into that fallback would give the `split` decoy a power - the decoy carries no owner attributes and goes through the
same `spawnBall` - and a decoy with `eclipse` would freeze the field from a body `getCompetitors()` cannot see. The random
pick lives in `debugSpawnCompetitors` and nowhere else.

**`src/shared/models.config.ts` is new and nothing reads it.** One entry per ball id, every `model` `undefined`, an
interface (`{ assetId?: string }`) rather than `string | undefined` because the swap needs more than one field - a mesh has a
size, often an attachment, and a loader needs to know whether it replaces the `Part` or hangs a `SpecialMesh` inside it - and
as a bare string those would arrive as a second table keyed by the same ids, which is the drift `powers.config.ts` exists to
prevent one file over. Deliberately **not** part of `shape-pool.ts`: the pool describes a silhouette, a model belongs to an
id, and item 12 separated the two on purpose.

**The cross-validation test is the point of the round.** `src/shared/ball-tables.spec.ts` iterates `BALL_POOL` **once** and
asserts the pool lookup (`rarityOfBall`), the power lookup and the model lookup all resolve; a second test asserts no model
entry names a ball outside the pool, no duplicate keys, and that the table's size equals the pool's. The existing mapping
test in `powers.spec.ts` was **widened, not duplicated**: it gained the third direction (no `POWERS` row naming a ball the
pool does not have), and kept `POWER_IDS` reachability. **Today `POWER_IDS` had an orphan check in one direction only** -
every declared power was reachable, but a `POWERS` row could name a ball that does not exist.

**Tests: 221 -> 232.** New `src/server/test/debug-balls.spec.ts` (9): exact counts, distinctness across 40 seeds x every
count, distinctness under a source pinned at `0` (the worst case for a rejecting draw), the whole pool, repeats past the
pool with a distinct first pass, pool membership, `0`/negative/fractional counts, and a source that returns `1`. New
`src/shared/ball-tables.spec.ts` (2). The widened mapping test is unchanged in count. **No existing test was otherwise
modified.**

**No controller, no service** - `src/server/debug-balls.ts` sits outside `Flamework.addPaths("src/server/services")` and is
a plain module, so no registry rebuild.

**Not verified without Studio:** that a `4` press really puts four distinct balls with four visible badges on the belt, that
each behaves as its power says, and whether four powers at once are legible or turn a round into noise. The log line is the
instrument for the first of those.

## 76. Every ball consumes its pickup; the debug `3` press draws a ball

**A pickup that survives its collection is a ball that cannot die.** `pickupDecision` returned `consume: false` for every
ball except `prism`, so the triangle stayed under the ball that took it, `Touched` re-fired while the ball rested on it, and
`BALL_SPEED` was reset to the boost value every frame. The run showed one ball held on the belt for 71 seconds and a round
that never ended. `prism` consuming was never a distinct effect - it was the absence of this defect on one ball.

**The fix is one return value, not one branch.** `pickupDecision` now returns `consume: true` unconditionally, and the only
branch left is `sprinter`'s boost value. The service was already correct on both counts: it destroys on `consume`, and it
applies `decision.boost` rather than re-reading the constant (checked, not assumed - `if (before < decision.boost)`), so
`prism` and `sprinter` were both reaching the ball with the right number. The `consumed=` field in the log is the **decision
result**, not a post-attempt observation, so it becomes `yes` on every collection with no logging change.

**`speedAfterPickup(current, boost)` is new and is the idempotence rule.** The old site was
`if (before < decision.boost) set(decision.boost)` - true, but only readable. As `math.max(current, boost)` the rule is
named, testable, and asserts the property that matters: applying the same boost twice is applying it once. That property is
**separate from the consume rule** and the test says so - with every ball consuming, a second touch cannot happen, so a test
written against the service would pass trivially.

**The `3` press was spawning powerless bodies.** `forcePlaying` is the one path into `Playing` that skips `Waiting`, and
`Waiting` is where the picker writes a pick - so `chosenBallIdFor(player)` answered `undefined` and `spawnBall` took its
"no ball id, no power" route: no `Power` attribute, no badge, no collision group. The `power=none` collection lines in the
run were that body.

**`spawnRoundCompetitors(reason, drawBallIds = false)`** - an optional parameter rather than a change to what the function
does. A real round passes nothing, keeps `chosenBallIdFor(player)`, and races the ball on the player's screen; `forcePlaying`
passes `true` on both of its paths (the fresh entry and the `Playing → Playing` restart). **Defaulting it on was rejected:**
a real round with a missing offer would then race a random ball instead of the pick, which is the failure the picker exists
to prevent.

**One draw of `count`, indexed by lane - not one draw per owner.** The brief recommended per-owner; the count is exact at
this point (`min(players, lanes)`) and is known before the loop, so a single draw ties nothing together that is not already
tied. The decisive argument is distinctness: `pickDistinctBallIds(1)` four times can return the same id twice, so a `3`
press with several players could hand out two bullies while a `4` press never does. One draw of `count` makes the two debug
paths agree, and the `pickDistinctBallIds` deck guarantees distinct ids within the press.

**The `3` press still prints no `debug spawn:` line - reported, not fixed.** That line belongs to `debugSpawnCompetitors`
(key `4`). What a `3` press does print, now that the ids exist, is the existing per-body `[Picker] spawn player=… ball=…`
line and the `[Round] spawn lane=… owner=… body=…` line, so the ids are on the record without a second summary line.

**Tests: 232 -> 233.** The four `pickupDecision` tests were **widened**, not duplicated: `consume` is asserted `true` for
all ten powers, an empty power and a non-power string; `sprinter`'s boost is asserted against `SPRINTER_BOOST_SPEED` with
every other power at the standard value; and a new `speedAfterPickup` block asserts raising, not lowering, and the
one-touch/two-touches identity across every power. Everything else in the suite is untouched.

**Stale prose left deliberately:** `powers.config.ts`'s `effect` string for `prism` still reads "takes the pickup's boost
and consumes the pickup". It is not false, but it no longer distinguishes prism from any other ball, and the brief forbade
touching that file. The README's powers table and acceptance checks were corrected instead.

**Not verified without Studio:** that a Studio run shows `consumed=yes` with no repeated `collected` line for one ball, and
that a `3` press puts powered, badged bodies on the belt.

## 77. The `split` decoy is now indistinguishable from its parent

**"There's an empty ball still?" - it was the decoy, and it was nearly empty.** Item 74 shipped a decoy with no `Power`
attribute, no badge, **no face textures and no markers** - checked against `spawnDecoy`, which called none of the four
attach helpers. The Studio run proves which body it was: `[Round] debug spawn: ... balls=split_ball,eclipse_ball,...` gave
one decoy, the five competitors produced `[Ball:1]`-`[Ball:5]`, `[MarkerSpin] bodies=5` counted only bodies *with*
markers, and `[Round] cleared 6 ball(s)` counted every tagged body - six against five competitors.

**So `split` deceived nobody.** A bare sphere beside four textured, badged ones is identifiable across the arena; the
power's only real effect was to hold a `MaxLiveBalls` slot. A decoy that looks different is not a decoy.

**The fix is a split of `setPower` into two functions.**
`presentPower(ball, power, radius)` writes the `Power` attribute, sets the collision group and attaches the badge - the
three things `setPower` does that a viewer can perceive. `setPower` is now `presentPower` plus the two things the
simulation acts on: the aura registry entry and the `Touched` connection. **The decoy calls `presentPower` and never
`setPower`**, which is the whole point: a decoy in `magnetBalls` or `eclipseBalls` would project a real aura, and an
`eclipse` decoy would freeze the field from a body `getCompetitors()` cannot see.

**`spawnDecoy` now also calls `attachBallTexture` (before `Parent`, so the textures arrive as one tree) and
`attachBallMarkers` (after `Parent`, because the poles and ring need a real `CFrame` frame).** It still writes **no**
`ChosenBallId` - that is a label for "the ball a player picked", no player picked this body, and the only readers either
filter on an owner or would be a log line that then lies.

**The decoy is visually live and mechanically inert.** `powerOf(decoy)` now returns its parent's power, so `tickDelta`
finds no state for it (nothing calls `onRoundActive` for a decoy) and the aura registries never gain it; `bouncy` hops and
a `sprinter` decoy takes the bigger pickup boost, both cosmetic. It still has no owner attributes, so it still cannot win,
hold a round open, or be reported as anybody's elimination.

**Cost accepted:** a decoy consumes one slot of `BALL_TEXTURE_LOG_LIMIT`, which is instrumentation for the parent's spawn
path. It is logged and no longer distinguishable there, which is the correct behaviour for a decoy.

**Item 74's criterion 8 is superseded, deliberately.** It asserted "every body carrying a power has exactly one
`PowerBadge`; a decoy has none". The invariant that survives is the one worth having: **every body carrying a `Power`
attribute has exactly one badge** - and a decoy now carries the attribute, so it carries the badge. Item 74's history is
left as written; this item is the reversal.

**Tests: 233, unchanged.** No test asserted the decoy's appearance, and the change is entirely in `spawnDecoy` plus a
refactor of `setPower` that leaves every exported rule identical. `npm run build` / `lint` / `prettier` / `test` green.

**Not verified without Studio:** that the decoy is genuinely indistinguishable at a distance, that its markers spin with
it, and that a `split` ball's twin now reads as a second competitor on sight rather than as a bug.

## 78. `split_ball` becomes `decoy_ball`, `split` becomes `decoy`, and the powers get a real README section

**The ball and the power were both a decoy, and `split` described an effect the ball no longer has.** Since item 77 the body
spawned beside a `split_ball` is visually identical and mechanically inert, so the name promised a split into two competing
bodies and delivered a twin that cannot win. `decoy_ball` / `decoy` says what it is.

**Every id-bearing site moved; nothing else did.** `BALL_POOL`, `models.config.ts`, `POWER_IDS`, the `POWERS` row and its
`effect` string, `spawnsDecoy`'s comparison, the prose that named the old ids in `attributes.ts`, `debug-balls.ts` and
`ball-spawner-service.ts`, and four assertions in `economy-service.spec.ts`. **`spawnsDecoy` and `spawnDecoy` keep their
names**: the thing spawned is still a decoy in plain English, and `decoy` spawning a `spawnDecoyedBody` would read as a
tautology rather than as a clarification.

**The migration is a read-time table, and the version stays at 1.** `ownedBallsFrom` drops any id `BALL_POOL` does not know,
so a rename without a mapping would leave every existing count in the profile and **invisible** - not listed, not offered by
the picker, and not logged anywhere. `BALL_ID_RENAMES` in `player-data-store.ts` is an `old -> new` pair list applied inside
`readStored`'s `ownedBalls` loop, and the count is *added* rather than assigned so a profile holding both ids keeps both
grants. A `SCHEMA_VERSION` bump was rejected because `readStored` refuses any other version and a refusal puts the session in
`readonly` - no coins, no balls, no chest, no round - which is the outcome item 64 produced by accident. A rename is not a
schema change: same field, same shape, exact mapping.

**The README's powers section was restructured.** It had a paragraph *inside* the table, between the `prism` and `eclipse`
rows, which is the defect: a table that is not a table. Now: a three-paragraph preamble (one fixed power per ball; the
`Power` attribute from `ChosenBallId`; the constraint that velocity is rewritten every tick), one unbroken ten-row table,
the pickup-consumption paragraph **below** the table where it belongs, and ten prose blocks naming what each power does,
when it is the right pick and when it is the wrong one. Prose states intention only - no magnitudes, no rarity ordering.

**Two of those blocks report a finding rather than a design.** `prism` and `bouncy` have no right pick today: consumption
became universal in item 76, which left `prism` with no difference from a ball with no pickup power at all, and `bouncy`'s
hop changes nothing about `BALL_SPEED`. Both are written as "none today" instead of inventing a situational claim.

**Tests: 233 -> 239.** New `src/server/test/store-migration.spec.ts` (6): the old id loads as the new one with its count
intact and no duplicate key; the migrated id resolves against the pool; other ids are untouched; an old and a new id are
summed rather than overwritten; `SCHEMA_VERSION` is still 1 and a current-version profile loads; any other version is still
refused. Four `economy-service.spec.ts` assertions changed id, and one `powers.spec.ts` describe/it pair renamed - those are
the only modified tests.

**Criterion "grep `split_ball` in `src/` = 0" is unsatisfiable and was not met.** The retired id has to be written down
somewhere for the loader to recognise it, and criterion 2 requires a test that stores `split_ball`. There are exactly
**five** occurrences in `src/`, all of them the mechanism: two in `player-data-store.ts` (the docblock and the table row) and
three in the migration spec. Everywhere else in the tree - and all of `README.md` - is zero.

**Not verified without Studio:** that a real profile written before this build loads with its `split_ball` count appearing as
`decoy_ball` in the inventory and the picker. The spec proves `readStored` translates it; the belt proves the wires.

## 79. The owner sees a red outline on their own decoy twin, and nobody else does

**The twin is indistinguishable to everyone, which is the power and the problem.** Item 77 made a `decoy` twin look
identical to its parent — same badge, textures, markers — so its owner cannot tell which of two identical balls they
control and has to wait for one to behave differently. Everyone else must keep seeing two identical balls, or the power
deceives nobody. That is **per-viewer information**, and it cannot be an attribute: an attribute on the body replicates to
every client, which would announce the twin to the whole server.

**So the client asks and the server answers.** `ReplicatedStorage.Remotes.DecoyOutline` is **the first `RemoteFunction` in
this tree** — every other channel is a `RemoteEvent` or a replicated value, because every other fact is the same for all
viewers. A request/response rather than an event because the answer is a fact about the world *now*: a player who joins
mid-`Playing` needs it immediately and has missed every event that could have carried it, and `nil` is a meaningful answer
that only a request/response channel can carry. `InvokeServer()` takes no arguments, so no client can name a body.

**The server answers from a map, not an attribute.** `BallSpawnerService.decoysByParent` is a server-only parent -> twin
map behind `decoyFor(body)`. There is no attribute type that holds an `Instance`, and an `OwnerUserId` on the twin was
rejected because that is the field `getCompetitors()` filters on - writing it would make the twin a competitor and change
the winner rule. The map is cleared from **both** death paths by `forgetDecoy`, whichever side of the link died: a parent's
death leaves the twin on the belt (it is deliberately not a child of the parent), so both directions have to be handled.

**The decision is a module.** `src/server/decoy-outline.ts` exists because "I asked and got `nil`" is the same symptom for
four different causes and the only place that distinction can live is the server's log. Four reasons, each reachable and
each logged: `wrong-phase`, `no-body`, `no-decoy`, `not-owner`. `not-owner` is a guard rather than a client condition — a
twin must never carry `OwnerUserId`, and if one ever does and it is not the caller's, outlining it would hand one player
information about another's ball. Ordering is phase, body, decoy, ownership, so a request outside `Playing` does not send a
reader looking at the spawn path.

**The client asks once per `Playing`, never on mount and never in a loop.** A player who joins mid-round reads the phase in
`onStart` and asks immediately — their mount *is* their entry, so that case needs no special handling. A `generation`
counter is bumped on **every** transition, including `Playing → Playing`, and re-checked *after* `InvokeServer` returns
because the invoke yields: a reply that arrives after the round ended must not put an outline on a body that is no longer
anybody's twin. Leaving `Playing` destroys the `Highlight` unconditionally, and the twin's own `Destroying` signal clears it
too, so a cull mid-round cannot leave the controller holding a dead instance.

**The visual:** `FillColor` and `OutlineColor` both `theme.colors.error`, `OutlineTransparency = 0`,
`FillTransparency = 0.65` (**Placeholder**) so it reads as a tint rather than a coat of paint, and `DepthMode = Occluded`
rather than `AlwaysOnTop` so it does not draw through the arena wall — a red ring on a body the player cannot see reads as
a bug and leaks the twin's position through geometry. Parented to the twin, so `Destroy()` on the body takes it.

**Registry.** A controller was added, so `flamework.build` and `out/tsconfig.tsbuildinfo` were removed and the build was
re-run — no mass delete, because two Rojo processes may be live. `decoy-outline-controller` confirmed in the registry.

**Tests: 239 -> 247.** New `src/server/test/decoy-outline.spec.ts` (8): granted for the owner in `Playing`; `wrong-phase`
for each other phase; `no-body` for no body; `no-body` for a body that is not the caller's; `no-decoy` for a ball with no
twin; `not-owner` for a twin carrying somebody else's id; the four failures as a conjunction; and phase reported first when
everything is wrong. No existing test changed.

**Not verified without Studio:** the outline rendering at all, whether `0.65` reads as a tint against a red-and-white ball,
whether `Occluded` hides it exactly when it should, and that a spectator genuinely sees two plain balls. The handler's
refusal path is proven by the log line, not by the picture.

## 80. `prism_ball` becomes `recycle_ball` and its pickup survives the collection; `onBallCollision` gets a phase gate

**A prism is a shape, not a mechanic, and the mechanic it named had been deleted a round earlier.** Item 76 made every ball
consume the pickup, which left `prism` with no effect of its own - the README even recorded it as "none today, a finding
rather than a design". This round gives it one: `recycle_ball` / `recycle` takes the standard boost and **leaves the pad in
the world**, so the pad is the resource and the power is keeping it in play for whoever follows.

**The rename follows the `split_ball` round exactly.** `BALL_POOL`, `models.config.ts`, `POWER_IDS`, the `POWERS` row and
its `effect` string, the region title in `powers.config.ts`, the prose in `powers/index.ts`, four `economy-service.spec.ts`
fixtures, two in `economy.config.spec.ts`, three in `inventory.spec.ts`, and the migration table. **A migration row, not a
`SCHEMA_VERSION` bump**: `readStored` refuses any other version and a refusal is `readonly` - no coins, no balls, no chest,
no round - which is item 64's accident. The mapping is exact, so it is a second row in `BALL_ID_RENAMES`.

**`pickupDecision` has exactly one new branch and it is `consume: false` for `recycle` only.** Every other power, and a body
with no power, still destroys the pad. The exception is safe by *arithmetic* rather than by a guard: `speedAfterPickup` is
`math.max(current, boost)`, so a ball parked on a surviving pad is raised once and every later collection computes the same
value and writes nothing - it still decays off the belt on schedule. **No "already used" state was added**, because that
would be a guard the value rule already makes unnecessary.

**The service was already correct: it destroys the triangle only when `decision.consume` is true.** Verified before
touching anything - `onPickupTouched` has an `if (decision.consume) { remove; Destroy } else { reconnect }` branch since item
76, and that `else` was written then as "unreachable today, kept deliberately" for a future power that wanted to leave a pad
in the world. This is that power; the branch went live with no change to it.

**`onBallCollision` gained a phase gate it never had.** The item-80 survey proved the handler ran its transfer machinery
during `PostGame`, made harmless only by the fact that `setRoundActive(false)` zeroes every ball's `BALL_SPEED` and the drain
is proportional (`0.1 x 0 = 0`) - an accident of the arithmetic, not a rule, and a flat drain would have written speed back
onto frozen bodies. The gate is `powersActive`, a module flag fed by the **existing** `setRoundActive` signal that
`BallSpawnerService` has used since item 22 to gate `stepBallSpeeds`. Importing `RoundService` was rejected because it closes
`RoundService` -> `BallSpawnerService` -> `powers` -> `RoundService`, the cycle item 22 already refused once; reading the
`RoundState` `StringValue` was rejected as a second source of truth for a fact the spawner is told, plus a `FindFirstChild`
on a collision handler. No cooldown is stamped outside `Playing`, so the first contact of the next round is never damped.

**The pad teardown needed no change, and was verified rather than assumed.** `PickupService.onPhaseChanged` clears every
pickup on any phase that is not `Playing`, so a surviving recycle pad cannot outlive the round. That also means the brief's
stated reason for the gate - "a ball parked at `PostGame` with a live pad keeps collecting forever" - is not reachable for
*pickups*; the gate is there for transfers.

**Tests: 247 -> 252.** Two migration cases (`prism_ball=2` alone, and `split_ball` + `prism_ball` + `bully_ball` in one
profile); `pickupDecision` widened to assert `recycle` is the only non-consuming power while every other power, the empty
case and a non-power string still consume, plus `recycle` taking the standard boost; `speedAfterPickup` widened with the
reusability case (the same boost applied twice to a recycle ball leaves one value); and a two-case phase-gate block that
drives `setRoundActive(false)` and a counting fake body to prove `onBallCollision` returns **before** it reads anything, then
flips the flag to prove the handler still reaches its tag test. Every test naming the old id was updated: four in
`economy-service.spec.ts`, two in `economy.config.spec.ts`, three in `inventory.spec.ts`.

**Criterion "grep `prism` in `src/` = 0" was not met and is not achievable.** `prism_ball` is now zero outside the migration
row and its two tests. The word `prism` also survives in **six comment lines** about `Enum.MeshType.Prism` - the mesh type
the pickup triangle was *not* built from (items 25 and 76 settled on `PartType.Wedge`) - in `pickup-service.ts` and
`tuning.ts`. Those describe a geometry enum, not a ball, and rewriting them would lose the checkable reference. `README.md`
is at zero.

**Not verified without Studio:** that the triangle is still standing after a recycle ball passes over it, that
`consumed=no` prints and the next ball through it gets the boost, and that the gate stops a `PostGame` transfer (the log
would need a bully wedged on a victim at the phase change).

## 81. Documentation pass: the README corrected to the round-based game, and the missing pointers in this log named

**The README still described the two-fixture slice of items 11-25**, and every section that predated the round machine was wrong in at least one sentence. This round changed no source, no config and no generated file: it read the tree, ran the build, and corrected the documents to what the code does. `npm run build` exits 0 — the only output is Flamework's `TypeScript version differs` notice — and `git status --short` carries the same 27 paths as the baseline taken at the start of the session, so items 74-80's uncommitted work is untouched.

**Seven drifted claims in `README.md`, corrected in place.**

- *Intro.* Said "Two independent, observable test fixtures — a treadmill belt and a server-authoritative ball spawner. No rounds, no elimination, no UI." Rounds arrived at item 26 and UI at item 39. It now describes the round-based race and the economy, and points at `tuning.ts`'s model docblock before saying anything about movement.
- *Layout.* Named `src/client/controllers/spawn-trigger-controller.ts`, deleted at item 35, and described `treadmill-service` as a service that "drags things along" the belt — the mechanism item 18 replaced. The table now lists the six services, the ten controllers, the powers module and the plain modules that exist so a spec can import them.
- *Belt fixture.* Said the vector is `CFrame.RightVector` scaled by `BeltSpeed`, so "a positive speed drags toward the part's right". There is no drag: `BeltSpeed` is the reference number `BALL_SPEED` is subtracted from. Rewritten, with the `BeltSpeed`/`BeltSpeedActual` split and the frictionless floor this service creates — which also made the next sentence false, "Every part is placed by hand in Studio. This repo creates none of them", now scoped to the four hand-placed fixtures.
- *Spawner fixture.* Listed `Radius`, `Enabled` and `Rate` as derived attributes (retired at items 11 and 16) and gave `KillY` as `FallenPartsDestroyHeight + 2 * Radius`, which is `+ poolMaxExtent()`. The table is now `KillY` and `MaxLiveBalls` only, and spawn height is "one rotated half-height plus 0.5 studs", because `rotatedHalfHeight` is what the code reads.
- *"Manual trigger".* Described pressing `1`, the `SpawnBall` remote and its 100 ms per-player limit. The remote, its handler and the limit were deleted at item 35, and the keys became `1`-`4` at item 73. Replaced by a game-loop section: the four phases and their durations, the winner rule including the solo case item 72 made deliberate, and a key table that names what each key does *and* refuses.
- *Acceptance checks 1-6.* Tested belt drag, a 2/second stream, and `Rate` against `MaxLiveBalls`; none of those three mechanisms survives. Replaced with six checks over the phase keys, the solo win, the `4` draw and both cull paths. Checks 7-12 were already correct and are unchanged.
- *"Deliberately absent".* Listed the belt ramp, ball randomisation, rounds, elimination, UI and currency as absent — all six exist. Rewritten to what is actually absent (models, prediction, audio, particles, an in-round coin path). Its "no VFX" sentence lost the word *tint*: the decoy owner's `Highlight` is one.

**Three parts were added rather than corrected.** A game-loop and key section, because the old README had nowhere to say what the game is — the "manual trigger" paragraph is where the loop now sits; a store/picker/inventory section, because the economy has been in the tree since item 51 and the README never mentioned it; and `npm test` in *Running it*, with the note that `pretest` rebuilds the place because a stale `build/game.rbxlx` would silently test the previous build.

**The toolchain bullet about Flamework was itself a hazard.** It said to run `npm run clean` when the manifest goes stale, which is the command item 52 records crashing Rojo 7.7.1 twice while `rojo serve` was live. It now says to delete `flamework.build` and `out/tsconfig.tsbuildinfo`, and names the crash.

**One correction to my own first draft, recorded because it is the same defect.** The new intro said Fusion was imported by exactly one controller — the brief said so, and I wrote it before checking. `grep` says three: `phase-banner`, `round-transition` and `shop`, and item 55 had already recorded the store as a second Fusion user. The sentence was rewritten in place. Repeating a claim without checking it is the thing this item is about.

**`TAGS.md` was not created, deliberately.** `src/shared/tags.ts`, `attributes.ts` and `remotes.ts` already *are* the register, and every constant in them carries the prose explaining what writes it and what breaks when it is missed. A fourth copy would be the copy that drifts — the failure `powers.config.ts` exists to prevent one file over. The count is **seven**: `TreadmillBelt`, `BallSpawner`, `Ball`, `BallDecoration`, `TreadmillWall`, `EliminationZone`, `Pickup`. The three that matter to the load-bearing mechanic are `TreadmillBelt` (the reference number and the frame), `Ball` (the attribute's carrier, and the tag both the cleanup pass and the teardown enumerate) and `BallDecoration` (welded to a ball and deliberately *not* tagged `Ball`, or the cull would count every marker as a live body).

**Superseded items that never received the one-line pointer this file's preamble promises.** The preamble asks for a pointer when a later item resolves an earlier one; four items still read as current when they are not. This session may only append, so they are recorded here rather than patched:

- **Item 9** ("Not done, by design") says there are no rounds, elimination, survivor tracking, win condition, UI or powers. Items 26, 39 and 74 supply all of them. It reads as a statement of scope rather than as a snapshot, which is what makes it quotable out of context.
- **Item 16** says bodies come from "exactly one automatic spawn per bound `BallSpawner`, at server start" and that "manual `1` still spawns extra bodies (rate-limited as before)". Item 26 deleted the automatic spawn; item 35 deleted the manual path and the remote.
- **Item 26** names `StartRoundController` on key `2`. That controller was deleted at item 35 and the key is now `3`.
- **Item 35**'s key map (`1` → force `Waiting`, `2` → force `Playing`, `3` → spawn four) was replaced at item 73 by `1` → `Intermission`, `2` → `Waiting`, `3` → `Playing`, `4` → spawn.

**Four source docblocks argue for decisions the code has stopped making.** Reported, not fixed — this session touches no `src/`:

- `src/shared/attributes.ts`, the `Enabled`/`Rate` block: "the spawner now spawns **exactly one body per bound `BallSpawner`, once, at server start**, and never again." Bodies are created by `spawnRoundCompetitors` inside a round since item 26; the same file's header says it twice more.
- `src/shared/tags.ts`, `treadmillWall`: points at `TreadmillService.applyWallAssist`. Item 25 moved the assist to `BallSpawnerService.attachWallAssist`/`applyWallAssist`, and `TreadmillService` no longer binds the tag at all.
- `src/client/controllers/debug-keys-controller.ts`, the `3` bullet: "refused while already `Playing`, because the alternative — restart the round — would destroy every competitor for one stray keypress." `forcePlaying` restarts the competitors in that phase, and `round-service.ts`'s own comment calls the branch "debug key 3 restart"; only `PostGame` is refused.
- `src/server/services/treadmill-service.ts` still opens with "Drags anything resting on a `TreadmillBelt` part across its surface", keeps its `TEMPORARY INSTRUMENTATION` block, and its mechanism block still says `RoundService` "ramps it from 0 at `Playing` entry" for `BELT_SPEED` — the split item 18 made means only `BeltSpeedActual` ramps.

**Not verified in any of this:** nothing above is a runtime observation. The README's new acceptance checks are instructions for the next Studio run, not results; the claims they encode come from source reads and from the items that produced the code.

## 82. Three UI sounds — elimination, granted purchase, any button — with a per-sound throttle

**The game had no audio; it now has three clips and one rule.** `src/shared/sounds.config.ts` holds the three bare asset ids, `soundUri` (the one place `rbxassetid://` is written), `SOUND_MIN_INTERVAL_SECONDS = 0.5` and `canPlay(lastPlayedAt, now)`. `src/shared/ui/sounds.ts` plays them and owns the timestamps. Nothing else was tuned: no volume, no pitch, no loops, no music, no effect chain.

**Bare ids because that is what an asset page shows.** `Sound.SoundId` is a `ContentId` (`type ContentId = string;` in `roblox.d.ts`), the engine reads the scheme and a bare number loads nothing — silently. The ids stay bare and `soundUri` adds the scheme once. `canPlay` is pure, takes two numbers and reads no clock, so its boundary is testable with literals: `undefined` is always playable, a gap of exactly `SOUND_MIN_INTERVAL_SECONDS` is playable, anything less is not.

**A remote to every client, not a `Sound` on the server.** The server creates `Remotes.EliminationSound` beside `Remotes.Elimination` and fires `FireAllClients()` from exactly two places: in `settleEliminations`, beside `notifyEliminated(owner, "left-belt")`, and in `handleExternalDestruction`, beside `notifyEliminated(owner, "culled")`. Those are the splash's two call sites, so "a ball was eliminated" still has one definition; the splash and the sound are two signals from the same two places because they have different audiences — the splash is one player's result, the sound is the field's event. Firing the splash remote to everyone instead would splash every player whenever anybody's ball went out.

**Rejected: one `Sound` parented to `SoundService`, played by the server and throttled against a server timestamp.** It is one line per site and it would work. But the rule this round was given is "this sound may not restart itself within half a second", and only the client knows when *it* started playing; a server timestamp is a proxy for that at best, and it leaves the phase rule on one side of the wire with nothing on the other. The chosen path costs one remote and one client listener, and buys one `canPlay` shared by all three sounds on the side that plays them.

**The gate is `this.phase !== "Playing"`, not `powersActive`.** The powers flag carries the same boolean one indirection away (`BallSpawnerService` → `server/powers`), and reading it back in the service that sets it would be asking another module for a fact it was just told. The gate is not redundant with the bookkeeping: both call sites only run in `Playing` today — `settleEliminations` from the tick, `handleExternalDestruction` because `clearAllBodies` forgets each body before destroying it — but that is the order things happen to run in, not a rule.

**One signal per elimination.** Four bodies leaving in one `settleEliminations` pass fire four remotes and each client plays one sound; the client's `canPlay` is the only coalescer. Coalescing server-side would be a second throttle on the wrong side of the wire, and it would not help the case that actually stutters — four eliminations spread over two ticks 200 ms apart are a burst whichever way the first four are collapsed.

**Synthetic `Debug#N` bodies are included, deliberately.** The sound asks "did a body leave the belt", not "did yours", so it is fired without consulting the owner. A `decoy` twin therefore clicks when it leaves too, which is the same answer to the same question.

**The click is attached where the buttons are built — twelve construction sites, all wired.** `shared/ui/panel.ts:188` (the sheet's close), `shared/ui/tabs.ts:101` (one per tab), `shared/ui/tile.ts:62` (the tile builder, currently unused), and in the controllers: `shop-controller.ts` `681` (rail tab), `1012` (store close), `1459` (premium), `1904` (`Open N`), `2196` (ball card), `2286` (fusion row), `3050` (Fuse); `picker-controller.ts` `302` (card) and `786` (footer — `All Balls` and `Reroll`).

**The helper lives in `shared/ui/sounds.ts`, not under `src/client/`, and that is a deliberate deviation from the brief.** Three of the twelve sites are in shared builders, and the helper has to be reachable from the code that *creates* the button or those three stay silent — the tab strip and the sheet's close being exactly the two the brief predicted would be missed. `attachPressFeedback` already lives in this folder and is called from the same three builders for the same reason; this is that pattern, not a new one. Nothing under `src/server/` imports `shared/ui/`, and `PlayLocalSound` is documented as *"Plays a copy of a `Sound` locally, such that it will only be heard by the client calling this method"*, so the placement cannot put audio on the server.

**`Activated`, and silent when inactive.** `Activated` also fires for a gamepad or keyboard activation, which `MouseButton1Click` would not. The helper returns early when `button.Active` is false: this tree disables with `Active = false` (the Fuse button with nothing selected, the chest buttons when unaffordable, the premium buttons while a prompt is open), and the typings document `Active` only as *"Determines whether this UI element sinks input"* — which does not answer whether `Activated` still fires. The check states the intent instead of relying on an answer the typings do not give.

**The purchase sound needed a reply that did not exist.** The coin chest and the fusion verb already answer with their outcome (`ChestResult.ok`; `FusionResult.ok` plus `outcome`), but the **Robux chest answers nothing**: its grant runs inside `ProcessReceipt`, server to server, and the client deliberately ignores `PromptProductPurchaseFinished` because a client cannot be trusted about whether a purchase happened. So `Remotes.PurchaseGranted` is new, fired to the buyer only, from exactly the four places where the outcome is known to be a grant: the chest handler's `reply.ok`, the fusion handler's `ok && outcome === "success"`, and the `granted` branches of `grantRobuxChestPurchase` and `grantRobuxBundlePurchase`. `duplicate`, `save-failed` and `no-profile` reach none of them — criterion 4 written as one condition rather than four.

**The reroll is not a purchase.** It spends three coins on a new offer, grants no ball, and its success is already legible as the cards changing. Playing a purchase noise there would make the sound mean "coins were spent", which is not what it is for.

**Ordering is a consequence, not a delay.** The click fires on `Activated`, in the frame of the press; the purchase sound fires when the reply or the receipt arrives, at least one server round trip later. There is no timer and no ordering code — the two sounds are on opposite sides of the wire by construction.

**One map, one clock.** `lastPlayedAt` is a `Map<string, number>` keyed by asset id in `shared/ui/sounds.ts`, written **before** `PlayLocalSound` so a second caller in the same frame is refused rather than racing the write. One `Sound` per id is created on first use and reused; a `Sound` per press would leak an instance per click. `os.clock()` rather than `time()`, because a wall clock that stepped backwards would make the gap negative and suppress a sound that should play — and it is the clock the round service and the spawner already timestamp with.

**Tests: 252 → 257.** New `src/shared/sounds.config.spec.ts` (5): the prefix on two ids; the three ids bare and distinct; never-played allowed; the boundary at 0.499 / 0.5 / 1.0; and `SOUND_MIN_INTERVAL_SECONDS === 0.5` pinned so the boundary cases cannot pass against a constant that moved. The distinctness test goes through a `Set` of `string` because comparing two literal types with `!==` is a compile error (TS2367) — the first draft was exactly that, and the compiler caught it before the suite did.

**No controller was added**, so `flamework.build` did not change: it still lists the same ten controllers. `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` are green.

**Not verified without Studio:** that any of the three ids resolve to audio this account can hear; that a press and the purchase it starts read as two sounds rather than one; that four eliminations in one tick sound like one rather than a stutter; and the felt length of half a second. Also unverified: whether `Activated` fires on a button with `Active = false` (the check makes the answer moot, which is why it was not chased further), and that `PlayLocalSound` is audible for a `Sound` the client created and parented to `SoundService`.

**→ Corrected by item 83.** The throttle is narrowed to the elimination sound; the click and the purchase confirmation are deliberately unthrottled, because each of those is one player action rather than a burst.

## 83. The throttle narrows to the elimination sound; the click and the purchase play every time

**Item 82 put all three sounds behind one throttle, and that was wrong for two of them.** A click is one press; swallowing the second of two quick presses is a button that stops answering. A purchase confirmation is one grant, and a grant is already refused twice before it can happen — the client's `busy` flag and `EconomyService`'s `ECONOMY_ACTION_COOLDOWN_MS` — so a throttle there can never fire. Only the elimination sound is a burst, because `settleEliminations` destroys a batch in one loop, and that is the one path that keeps `canPlay`.

**`playThrottled` is deleted, not kept with one caller.** Its body was five lines and its only remaining caller was `playEliminationSound`; a named private function for one site means reading two functions to understand one path. The reusable half — `canPlay` from `sounds.config.ts` and the timestamp map — is untouched, so a future throttled sound re-derives three lines rather than reviving an abstraction that had already been cut back to one user.

**`lastPlayedAt` stays a keyed map with one entry.** One entry is not a leak, the key is the vocabulary `canPlay`'s per-sound rule is written in, and the next sound that wants a throttle becomes a data change instead of a refactor back from a bare number.

**The three players now share one seam: `play(assetId)`, defaulting to `playLocally`.** `playLocally` is the only code in the tree that calls `SoundService.PlayLocalSound`. `playClickSound` and `playPurchaseSound` are one line each with no `canPlay`, no timestamp and no map lookup; `playEliminationSound(now, play)` takes the clock as well, because its boundary at exactly `SOUND_MIN_INTERVAL_SECONDS` deserves an assertion and a test cannot wait half a real second to make one. This is the same shape `drawTimers` uses for its random source, and it is why "two presses, two clicks" is executable rather than reviewable.

**Where the assertion lives.** `attachClickSound` cannot be exercised in this runtime: `GuiButton.Activated` is an engine signal with no `Fire`, so a spec cannot press a button. What *can* be asserted is the function the handler delegates to, so the click path is tested through `playClickSound` and the helper itself is a source read (`button.Activated` → `Active` check → `playClickSound()`). The purchase path needed no compromise: the spec calls `playPurchaseSound` twice and counts two plays.

**Tests: 257 → 260.** New `src/shared/ui/sounds.spec.ts` (3): two clicks are two plays and carry the click id; two purchases are two plays and carry the purchase id; a four-event elimination burst in one frame is one play, a fifth at exactly the interval is a second, and the event after it is collapsed again. The `canPlay` cases in `sounds.config.spec.ts` are **unchanged** — the predicate did not move. `SOUND_MIN_INTERVAL_SECONDS` is unchanged.

**Grep evidence for "one caller".** `playThrottled` no longer exists anywhere. `canPlay` has exactly one production call site, `sounds.ts`'s `playEliminationSound`; the only other references are the predicate's own definition, the config spec and comments. `lastPlayedAt` is written only by `playEliminationSound`, below the `canPlay` guard. All twelve `attachClickSound` call sites from item 82 still call the helper — none reaches past it to the player.

**One deviation from the brief, declared.** It asked for `attachClickSound` to call `SoundService.PlayLocalSound` directly. It calls `playClickSound()` instead, one hop away, for two reasons: the two-play property is then testable (§tests above) instead of only reviewable, and the three `play*Sound` names stay symmetric — the asymmetry belongs in the bodies, where one of them throttles, not in the surface. `playClickSound` therefore keeps its export with a single caller; the alternative, inlining it into the handler, would have made the round's central property unassertable.

**Comment changes.** `shared/ui/sounds.ts`'s docblock now argues the split rather than the old "one throttle for three": elimination is a loop, a click is one press, a grant is gated twice. `sounds.config.ts` gained one paragraph saying that only the elimination sound uses the predicate today, so the two files cannot disagree about who the rules are for. `README.md`'s "no audio" line said the sounds were "throttled per sound to one start per half second"; it now says only the elimination sound is throttled.

**Not verified without Studio:** that a rapid double press now clicks twice, since `Activated` cannot be fired in the test place; that the click and the purchase remain legible as separate sounds; and that the felt half second on eliminations still reads as one stutter-free sound rather than as a missed elimination.

## 84. A ball-ball hit burst, cloned on the client from the Studio asset

**The effect is one clone of `ReplicatedStorage.hitEffect` per hit, built on each client at the midpoint the server names.** The server fires `Remotes.HitEffect` with a single `Vector3` from `onBallCollision`; the client builds a one-hit carrier, clones the asset into it, switches every emitter to explicit-emit, `Emit`s a fixed count and hands the carrier to `Debris`. Nothing is created on the server and nothing is attached to a ball.

**Four findings came before the code, and two of them shape it.**

- **`ReplicatedStorage.hitEffect` cannot be verified from this checkout, and the round did not pretend otherwise.** It is a Studio instance; `default.project.json` declares nothing under `ReplicatedStorage` but the TS mounts, `build/game.rbxlx` is composed from that tree, and `grep hitEffect` over the whole tree (including `HANDOFF.md`) is zero. The presence of the asset is the user's word, not this repo's evidence. Everything that depends on it is written to fail loudly: one `warn` naming the path at boot, no listener at all if it is absent, and a second `warn` if the asset exists but contains no emitter.
- **`onBallCollision` is not the field's ball-ball event — it is the *transfer* handler, and it is connected only for `bully` and `heavy`.** `setPower` connects `Touched` inside `if (isColliding(power))`, so plain-vs-plain, ghost-vs-ghost, magnet-vs-rocket and every other pair touch without ever reaching this code. The burst therefore covers **only contacts involving a colliding power**, which is roughly a third of the pairs a `4` press produces. Covering the field needs a connection on every body — one line moved out of the `isColliding` block, with the handler's own `!isColliding(state.power)` early return still guarding the transfer — and that is a change this round did not make, because the brief put the trigger here and forbade a second handler. **This is the round's headline finding**, and the log line below is its measurement.
- **The fire has to sit after the `amounts` check, not immediately after the cooldown check.** The cooldown is stamped *only* when a transfer happens (`state.lastCollisionAt = now` below the `drain <= 0 || gain <= 0` return), so a contact with nothing to transfer never consumes it. A fire above that check would therefore emit on **every** `Touched` re-fire of a pair resting at `BALL_SPEED_MIN` — and `Touched` re-fires on essentially every physics step while bodies stay in contact, which is the exact stutter the shared cooldown exists to prevent. The brief's order was `cooldown -> fire -> transfer`; the actual order is `cooldown -> transfer-is-possible -> stamp + fire -> transfer`, and the difference is the difference between a burst and a machine gun.
- **`EmitCount` is not in the installed typings at all** — not deprecated, absent. `ParticleEmitter` declares `Emit(this: ParticleEmitter, particleCount?: number): void` and nothing else that emits, so `Emit` is not merely "the supported call", it is the only one. `EmitCount` also does not exist as a *property* in these typings, so the brief's "verify it is deprecated" has no answer beyond its absence.

**A bully↔heavy contact fires twice, and that is reported rather than hidden.** `Touched` fires on both parts, so both handlers run; each has its own per-ball cooldown, each passes, and each computes the same midpoint in the same frame. The result is two identical bursts at one point — which reads as a denser burst rather than as two events, because the particles are additive — but it is a double, not a dedupe. A dedupe would be a second clock keyed on the pair, which is exactly the "not a second cooldown" the brief refused.

**The trigger, in order.** `powersActive` → `other` carries the `Ball` tag → this body has state and a colliding power → `POWER_COLLISION_COOLDOWN` (shared, not a new constant) → the transfer has somewhere to go. The burst is fired after the fifth and shares the fourth. The handler's docblock now lists that ladder and states the coverage cost in the same paragraph.

**The wire is round-service's, the fire is the powers module's.** `RoundService.createHitEffectRemote` creates `Remotes.HitEffect` beside the elimination pair and calls `setHitEffectRemote(remote)`; the powers module holds the reference in a module-level `let`, fed the same way `setRoundActive` feeds `powersActive`. The alternative — a `FindFirstChild` in a handler that runs per contact — is the lookup item 22 refused for the phase gate, and creating the remote at `require` time would run DataModel code in the Jest runtime, the wall item 74 hit with `PhysicsService`.

**The client is a controller, not a module.** A module only runs when something imports it and nothing has a reason to import a listener; `@Controller` is the boot hook this tree already uses for exactly this job (`EliminationSplashController` resolves a remote and renders what arrives). The cost is one generated line: `flamework.build` and `out/tsconfig.tsbuildinfo` were deleted and rebuilt, and the registry now lists **eleven** controllers with `HitEffectController` among them.

**The carrier and the clone.** One `Part` at the midpoint — `Anchored`, `CanCollide = false`, `CanTouch = false`, `CanQuery = false`, `Transparency = 1`, `CastShadow = false`, `Massless = true`, `Size = (0.1, 0.1, 0.1)` (**Placeholder**) — parented to a client-created `Workspace.SpawnedHitEffects` folder, **never to a ball**: the midpoint of two bodies is on neither. Every `BasePart` in the clone gets the same seven properties, **including the clone's own root**, because the asset is hand-made and a default `CanCollide = true` part at the contact point would push the two balls that just hit each other. No weld: both parts are already at the point and both are anchored.

**Order inside the burst, and why it is that order.** The carrier and the clone are built **outside** the DataModel, every part is made inert, every emitter is switched to `Rate = 0` + `Enabled = false` + `FacingCamera` + the `Size` sequence + `LockedToPart`, and only then is the tree parented in one step and `Emit` called. An asset authored with a non-zero `Rate` would otherwise have been streaming from the moment the clone entered the world — a stream with a burst on top of it.

The `Size` sequence is written as two explicit `NumberSequenceKeypoint`s with envelope `0` rather than `new NumberSequence(0.5, 3.22)`: the two-argument constructor produces the same sequence, but it hides the envelope, and a non-zero envelope would give each particle a random size *range* instead of a size.

**Emit count: 30 per emitter** (**Placeholder**). Per emitter rather than per burst, because the asset may carry more than one and a shared count would thin out as emitters are added. Thirty against a 0.5 → 3.22 stud ramp fills the contact point while the particles are small and opens into a visible spread as they grow; a dozen would read as stray dots at the small end.

**Cleanup is `Debris` alone**, at `LIFETIME_SECONDS (0.5, the user's value) + CLEANUP_BUFFER_SECONDS (0.15, **Placeholder**)`. A second path — a `task.delay` that calls `Destroy` — would be a second owner of one lifetime, and the two would disagree the first time either was edited. `Debris.AddItem(this: Debris, item: Instance, lifetime?: number): void` is the documented answer and survives the instance being re-parented before its clock runs out.

**Log line.** `[Powers] hit: ball=<path> other=<path> midpoint=(x, y, z)`, one per fire, countable against `[Ball] backspin:` from the spawner for the same contacts. **The counts will not match**, and that mismatch is the visible size of the coverage finding above.

**Tests: 260, unchanged.** Nothing here is assertable in Jest Lua without a DataModel: the client controller needs `ReplicatedStorage` and a `RemoteEvent`, and the server fire needs two bodies with `Position` and `GetFullName`. Existing tests did not change, and `powers.spec.ts` keeps passing for a structural reason worth recording — the fake bodies never reach the new code, because `broadcastHit` returns at `hitEffectRemote === undefined` *before* it reads `Position`. The acceptance criteria for Parts A–D are therefore source reads, as the brief anticipated.

**Docs.** `README.md`'s "no VFX beyond the badge and the outline" sentence now names the third effect; the powers module's own "What is deliberately absent — no VFX" paragraph says what is still true (nothing is *built* here; the burst is fired as a position and built by each client). `HIT_EFFECTS_FOLDER_NAME` joined `PICKUPS_FOLDER_NAME` in `tuning.ts`.

**Not verified without Studio, in order of what to check first:** that `ReplicatedStorage.hitEffect` exists and what its hierarchy actually is — the whole round is written against the user's description of it, and the boot warning is the only thing that will say otherwise; that a cloned `Attachment` + `ParticleEmitter` tree under a locally-created part renders at all; that the burst reads at 0.5 → 3.22 studs with 30 particles rather than as a smudge; that the midpoint looks like the contact (it is exact only for two spheres meeting at their surfaces); and whether a bully↔heavy double burst is visible as double density.

## 85. The hit-effect lookup descends through folders

**Item 84's boot resolution only looked at `ReplicatedStorage`'s direct children, so an asset named `hitEffect` inside a folder was invisible and every hit was silent.** It waited for a direct child with `WaitForChild(EFFECT_ASSET_NAME, RESOLVE_TIMEOUT_SECONDS)` — not, as the round's brief assumed, `FindFirstChild("hitEffect")`; the one-argument form of either call has the same blind spot, which is why the symptom was indistinguishable. The fix is the recursive flag: `ReplicatedStorage.FindFirstChild(EFFECT_ASSET_NAME, true)`.

**No wait on the asset any more, and that is deliberate.** The asset is authored in the place, so it is present when the client's scripts start; `WaitForChild` is for instances a server script creates at runtime, which is why the `Remotes` folder and its remote below still have one. The constant's docblock now says what it is still waiting for, since it no longer waits for the asset.

**Three log lines changed, one refusals split, and that is the whole of the round.** The success line is `[HitEffect] mounted on <GetFullName()> (<ClassName>)` — a recursive search can return an instance the reader did not mean only if a second instance of that name exists, and the path is how that is noticed rather than inferred; the emitter count is deliberately not in it, because a count of zero already has its own branch. "Not found" and "found but not a `BasePart`" are now **separate messages**: the first says `ReplicatedStorage` was searched recursively for an instance named `hitEffect` and none was found, and keeps the sentence describing what the asset should be; the second names the instance, its class and the expected class. One message for both — the old one, which read "no BasePart named …" for either cause — sent a reader nowhere in particular. The zero-emitter warning names the **found instance** rather than the name that was searched for, because at that point the search succeeded and the path is what says which clone failed.

**The `BasePart` check was already before the assignment, and stays there.** The resolved reference is stored only after both refusals, so an instance that fails either check can never become `this.asset`.

**Scope.** One file, `src/client/controllers/hit-effect-controller.ts`; nothing under `src/server/` was touched, no controller was added or removed, and the manifest was **not** deleted this round — though `npm run build` rewrote `flamework.build` by itself, which is worth knowing for anyone who expects it to be inert. The name is written **once** (`EFFECT_ASSET_NAME`), so no new constant was needed and none was added; `tuning.ts` is unchanged this round.

**No Studio run in this round.** Whether the recursive search finds the asset, and whether it finds the *intended* instance, are answered by the next boot log: `mounted on <path> (<class>)` or one of the two refusals.

## 86. The hit burst was emitted at the template's position, not at the hit

**The Studio log from item 85 proves both halves of the wiring and none of the drawing.** It shows `[HitEffect] mounted on ReplicatedStorage.assets.vfx.hitEffect (Part)` — so the recursive lookup found the asset, in a folder, on the first frame — and it shows `[Powers] hit: ball=… other=… midpoint=(108.627, 1.599, 140.43)` on the server. The remote was connected, the event was sent, and nothing appeared. That puts the fault between the two, in the client's own burst path, and there were two candidates.

**Candidate 1, and almost certainly the cause: the clone was never positioned.** `Instance:Clone()` copies the template's `CFrame`; **parenting does not re-base it** — a part's world position is not a function of its parent — and `makeInert` anchors every part in the clone. The carrier sat at the midpoint and the clone stayed wherever the effect was authored inside `ReplicatedStorage`, usually the origin. The particles were emitted thirty-odd times, correctly configured, a hundred-odd studs from the arena. The fix is one line before the clone is parented: `clone.CFrame = carrier.CFrame`.

**Candidate 2, removed rather than diagnosed: `Enabled = false` before `Emit`.** The typings give `Emit`'s docblock as one sentence — "Emits a given number of particles" — and say nothing about whether a disabled emitter still emits, so the previous code was betting on an undocumented behaviour. The one-shot recipe does not need the bet: `Rate = 0` alone means nothing streams, and an emitter left `Enabled = true` makes `Emit` unambiguously legal. Both properties are now set explicitly rather than inherited from the asset.

**One diagnostic added, because "I see no effect" could not be split into its two halves from the client side.** `[HitEffect] burst at <position> emitters=<n>`, one line per burst, printed after `Emit`. The server's `[Powers] hit:` proves the event was sent; this proves it arrived, where the carrier was placed, and that emitters were found. If both lines print and the screen is still empty, the fault is in the asset — an emitter with no texture, or a lifetime of zero — and not in this file.

**Unchanged and worth restating from item 84:** the server fires only for contacts involving a `bully` or `heavy` body, which is why the run above logged **one** hit across a five-body round. Mashing two balls together will often draw nothing at all, and that is the coverage finding, not this bug.

**Not verified in this round:** which candidate it was. Both produce an identical symptom, either alone would be enough, and the fix removes both — so the next Studio run answers it by drawing a burst at the contact, and the new line says where.
## 87. The elimination sound is played to the attacker, not to the field

**Item 82 chose a broadcast and item 83 narrowed only the throttle, so every client heard every elimination.** The requested rule is narrower: the sound is the attacker's cue, so it plays only to the client whose ball landed the last touch on the body that left — and to nobody when nothing touched that body. That needs two things the tree did not have: a per-body record of who touched it last, and a wire that can address one client.

**The record could not exist without item 84's coverage fix, and the reason is direction, not cost.** `setPower` connected `Touched` only inside `if (isColliding(power))`, so `bully` and `heavy` bodies had a handler and nothing else did. `Touched` fires on *both* parts of a contact, but `onBallCollision(ball, other)` reads as "*other* touched *ball*": the record is written for the body whose connection fired. A plain body knocked off the belt by a bully would therefore have had no entry at all, which is precisely the body the sound is about. So the connection is now made for **every** body, and `isColliding` moved from the connection site into the handler where it already had a gate. The transfer is unchanged for every non-colliding power — the early return is above it.

**The record is `lastTouchedBy: Map<BasePart, BasePart>`, keyed by the touched body and valued by the toucher's body, not its user id.** The key is the question the elimination asks ("who hit *this* body, last?"), so the read is one lookup. The value is a `BasePart` because `OwnerUserId` on that part is the only source of truth for who owns a body — copying the id at write time would create a second place for the orphan rule, the synthetic-owner rule and the spawn path to disagree. **The brief's "one entry per pair" is wrong on the map and right on the outcome:** a bully↔heavy contact runs both handlers and writes **two** entries, one in each direction, because "who touched A last" and "who touched B last" are separate facts that go stale at different times — A may die and B survive. Which is also why the entry cannot be pair-keyed: a body touched by three others still has exactly one last toucher.

**The finding that reshaped the round: `BallSpawnerService.destroyBall` called `forgetBall(ball)` *before* `ball.Destroy()`.** `handleExternalDestruction` runs from inside that `Destroy()`, so the natural "clean up, then destroy" order would have erased the toucher before the cull could ask for it — every `KillY` and cap elimination silent, with nothing in the log to say why. The call now sits after `Destroy()`, with a comment at both ends of the dependency (the spawner block and the round's read). Nothing else in that block depends on the order: the maps it clears are keyed on the body itself, and the destroy handler reads none of them.

**Deletion runs in both directions, in `forgetBall`.** The key is dropped, and then any entry whose value is the dying body is collected and dropped too — collected first rather than deleted mid-iteration. That is not theory: the ball that knocks a body off the belt is often destroyed in the same pass, and a surviving body must not keep pointing at a corpse. `lastToucherOf` also refuses a toucher whose `Parent` is gone, which covers the ordering where the attacker died first.

**A decoy can neither be a record nor clear one.** `spawnDecoy` writes no `OwnerUserId` (verified: the only write of `OWNER_USER_ID_ATTRIBUTE` in the spawner is `spawnBall`), and `forgetDecoy` touches only `decoysByParent` — it never calls the powers module's `forgetBall`. One helper, `shouldRecordTouch(touchedOwner, toucherOwner)`, states both halves of the skip, so the write and the read cannot drift about what an orphan is.

**The rule is pure, and it reuses the owner test that already existed.** `shouldPlayEliminationSound(owner, toucherOwner)` in the new `src/server/elimination-sound.ts` — numbers in, boolean out, assertable in the Jest runtime. `elimination-signal.ts`'s `userId <= 0` became an exported `isRealOwner`, used by `splashTargetUserId` as well, so "synthetic is not a player" is stated once. The rule is `true` only when both ids are positive and equal; a missing toucher is `false`, which is the correct answer for a body that left the belt untouched.

**The wire is a targeted `FireClient`, as the brief recommended.** The elimination happens at a known moment on the server and the answer is already computed there; a `RemoteFunction` would have the client polling for a fact the server knew first. `Remotes.EliminationSound` stays a `RemoteEvent`, is never fired with `FireAllClients`, and is not fired at all when the rule says no — a client that receives nothing does not need a "there was an elimination but not yours" event. The client handler is untouched: it plays on receipt, with item 83's throttle, and consults nothing.

**The two fire sites became one helper, `playEliminationSound(owner, toucher)`.** The *read* stays at each site, because it has to happen before that site's destroy and the destroy is different in each: `settleEliminations` destroys the body itself, while `handleExternalDestruction` runs inside the spawner's `Destroy()`. So each site reads `readOwner(ball)` and `lastToucherOf(ball)` into locals, then calls the one method that applies the rule, resolves the player and fires. Two call sites, one rule, and the phase gate (`this.phase !== "Playing"`) is kept where it was.

**One deviation from the brief, declared.** It proposed reading the map at both sites but *clearing the entry in `destroyBall` before the cull fires*, "so a culled body cannot have a stale toucher". That would have made every cull silent by construction, which contradicts the same brief's criterion 5 ("plays no sound ... unless the map holds a toucher") and the feature itself: a body pushed into the kill plane was pushed by somebody. The entry is therefore read first and cleared after, on every death path, which is the same guarantee against staleness — the record still cannot survive the body — without throwing away the answer.

**Round end clears the map, and says how many it dropped.** `setRoundActive(false)` now empties `lastTouchedBy` (it previously only set the flag) and prints `[Powers] last-touch records cleared: <n>` when the count is non-zero — one line per round, and the number a missing deletion would make climb.

**The client and the splash are untouched.** The receiving handler plays on every event it receives; the splash arrives on `Remotes.Elimination`, a separate remote, and its recipients are item 73's. `README.md`'s audio paragraph, `remotes.ts`'s docblock, `sounds.ts`'s elimination note and the splash controller's comment now say "one player" where they said "every player"; those four comments were the only other edits.

**Prompt corrections.** (1) `setPower` takes `power: string`, so the "bodies with no power (`power === undefined`)" case is `""`, and `onRoundActive` creates no state for it — which is why the record has to sit above the state gate rather than beside the fire. (2) "one entry per pair" is two, as above. (3) Item 86's closing claim that "the server fires only for contacts involving a `bully` or `heavy` body" is now true of the *burst* only: every body is connected, so the handler runs far more often, but `broadcastHit` is still behind the colliding-power gate and the effect's coverage is unchanged.

**Tests: 271 across 19 files, up from 260.** Eleven new ones in `src/server/test/elimination-sound.spec.ts`, all pure-rule. No existing test changed behaviour; `powers.spec.ts` got a comment on `countingBody` because its fake returns `HasTag` false and therefore returns before the new record — a fake that answered `true` would now need `GetAttribute`, and that is worth knowing before someone edits it.

**Studio-only, and not observed here:** that a player whose ball knocked another out hears the sound once, and that a player whose ball did not hears nothing. Everything else in this item is a source read. The evidence will be `[Round] elimination sound → <name> (toucherUserId=<id>)` on the server, absent when the rule says no.
## 88. A ball-ball hit makes a sound, on the same event as the burst

**The hit effect had a picture and no sound.** `Remotes.HitEffect` fires one event per contact the server considered worth a burst, and the client's handler did exactly one thing with it: `this.burst(position)`. The round adds the sound to that same callback — one event, two effects — and nothing on the wire moved.

**The fourth id is bare, like the other three, and it is the only one that is not a placeholder.** `HIT_SOUND_ASSET_ID = "140025518477459"` sits beside `ELIMINATION_SOUND_ASSET_ID`, `PURCHASE_SOUND_ASSET_ID` and `CLICK_SOUND_ASSET_ID` with no `**Placeholder.**` marker: the other three were invented to give their paths something to play, and this one is the user's own upload, so it is written down as given. `soundUri` is still the one place `rbxassetid://` is written, and the spec pins the pair (`id` and `uri`) so a lost digit fails the suite rather than the client.

**It is throttled, and on the same predicate and interval as the elimination sound.** `Touched` re-fires on essentially every physics step while two bodies stay in contact, the server's `POWER_COLLISION_COOLDOWN` guards the *transfer* rather than the burst, and the burst is deliberately allowed on every transfer — so the events arrive in bursts by construction, and a crowded belt delivers several in one frame from several different pairs. One sound per event is a machine gun. `playHitSound` is `playEliminationSound` with a different id: `canPlay(lastPlayedAt.get(HIT_SOUND_ASSET_ID), now)`, the timestamp written **before** the play, then `play(HIT_SOUND_ASSET_ID)`. No new interval constant — `SOUND_MIN_INTERVAL_SECONDS` is shared because the rule is one rule.

**The independence the round rests on is the map's key, and it was verified rather than assumed.** `lastPlayedAt` is a `Map<string, number>` keyed by **asset id**, and the ids are distinct literals (a spec asserts that), so the hit and the elimination sound occupy different slots: a hit inside half a second of an elimination still plays. Had the map been keyed by "the last sound", a body leaving the belt and two others colliding in the same second — an ordinary moment — would have gone silent with no build, lint or test to show it. `sounds.spec.ts` now asserts both directions of that, because it is the one property a passing build cannot demonstrate.

**The client call sits below the burst, in the same callback, and the order is named.** `this.burst(position); playHitSound(os.clock());` — the order is cosmetic (`burst` neither throws nor plays anything, and the sound depends on nothing it does), and it is written down so a later reader knows it was decided: the burst is what the event is *for*, and the sound is that same fact rendered a second time. **No client-side phase gate:** the server fires only from `onBallCollision`, which is behind `powersActive`, and asking the client for the phase would be asking a module for a fact the server already applied before it sent anything.

**Tests: 274 across 19 files, up from 271.** Two new cases in `src/shared/ui/sounds.spec.ts` — a burst of hits collapsing to one start with the next allowed exactly at the interval, and a hit playing immediately after an elimination sound — and one in `src/shared/sounds.config.spec.ts` pinning the real id and its uri. The "three ids bare and distinct" case there is now "four ids", which is the only existing assertion the round touched. Each throttle is exercised from its own time base (1000, 2000, 3000) so no block can be made to pass by the one before it.

**Prompt corrections.** (1) The constants are named `*_ASSET_ID`, not `*_SOUND_ID`; the new one follows the file rather than the brief. (2) `playLocally` is **not** exported — it is a private function beside `soundFor`, and the `SoundPlayer` type is what the specs swap. (3) `playEliminationSound`'s `now` has a **default** (`os.clock()`); "same shape as `playEliminationSound`" and "`playHitSound(now: number, ...)`" cannot both hold, and the file's shape won — the call site still passes `os.clock()` explicitly. (4) `sounds.spec.ts` does exist and already held the three item-83 cases, so this round added to it rather than creating it. (5) The flagged risk did not materialise: the map is keyed by asset id, not by sound kind.

**Studio-only, and not observed here:** that a hit is audible at all, that it reads as one sound under a scrum rather than a rattle, and that its volume sits under the elimination sound. Everything else is a source read or a suite assertion.
## 89. Playback values per sound, and the rule for what lives in the repo

**A freshly created `Sound` plays at the engine's defaults, and nothing in the tree named them.** Item 88's hit sound arrived at `Volume = 1` beside an elimination sound at `Volume = 1`, and a designer who wanted the hit quieter had no place to reach that was not the play path. `sounds.config.ts` now holds `SOUND_TUNING: Record<string, SoundTuning>` — `volume` and `playbackSpeed` per asset id — and `soundTuningFor(assetId)` is the only way anything reads it. `soundFor` applies both **at construction**, which is the only place a `Sound` is built and therefore the only place they can be applied once: the instance is cached and reused for the session, so a per-play write could not change either value and would only suggest that it might.

**The hit sound is `volume: 0.6, playbackSpeed: 1`, marked `**Placeholder.**`, and the other three are written out at `1`/`1`.** The rows are explicit rather than omitted even though both readings produce the same numbers: a written row says the value was considered, and an absent one is indistinguishable from a row nobody remembered — which is how a fifth sound gets forgotten. The numbers are a starting point to judge in Studio, not a mix.

**The lookup cannot silence a fifth sound.** `soundTuningFor` answers `DEFAULT_SOUND_TUNING` (`1`/`1`) for any id it does not know rather than throwing or returning `nil`: an unknown id must behave exactly as it did before the record existed. Losing a row is otherwise the quietest possible failure — the asset looks broken and nothing says why.

**The keys are the id constants, not literals.** `SOUND_TUNING` is built with computed keys (`[ELIMINATION_SOUND_ASSET_ID]: …`), so an id change cannot leave a row pointing at a number nothing plays — but the spec still walks every row with `pairs()` and asserts each key is one of the four ids, and that there are exactly four rows. That catches a hand-added literal key and a missing row, which computed keys alone cannot.

**Item 88's flagged property is unchanged: the record is keyed by asset id, like `lastPlayedAt`.** A kind key would put the hit and the elimination sound in one slot, and the round that quietened one would silently quieten the other.

**The convention is now written down in `sounds.config.ts`'s module docblock, in three paragraphs plus the argument for them.** *A value that is one string, or a small closed set of numbers, lives in this repository* — the four ids and these two playback values, and `tuning.ts`'s belt and ball numbers for the same reason: an edit in one place, and nothing in Studio can drift from what the code believes it points at. *A value that is a tree, with no way to preview it from code, stays in Studio* — `ReplicatedStorage.assets.vfx.hitEffect` is the counter-example: a `Part` carrying an `Attachment` and one or more `ParticleEmitter`s is dozens of properties, and writing them out in TypeScript is guessing at a design nobody can see until it runs; the code sets what the round actually decided (the size ramp) and leaves the rest to the asset. *The rule is not "VFX is a pack and audio is not"* — a pack of a hundred sounds would still want its ids here, because each is a single value, while a `SoundGroup` with effects under it is a tree and belongs in Studio; the dividing line is the shape of the value, not the kind of asset. The failure each side avoids is named: a name lookup into Studio is a runtime dependency on an edit somebody else can make (item 84 spent two rounds on a `FindFirstChild` that silently found nothing), and a tree rebuilt in code has no designer preview, so every literal in it is a guess.

**The knob and the lookup live in the config, the applying lives in the player.** No other file in `src/` writes `Volume` or `PlaybackSpeed` — grepped, and the only three matches for either word anywhere were unrelated: a physics comment in `ball-spawner-service.ts` and its "`playbackSpeed` clamp" note about ball speed. So `soundFor` is the single writer, and the click, purchase and elimination sounds keep playing at the engine defaults because their rows are the defaults.

**Tests: 278 across 19 files, up from 274.** Four new in `src/shared/sounds.config.spec.ts` — the hit values and that they are quieter than the default, the other three equal to the default, an unknown id answering the default table itself (not a copy of it), and every row keyed by one of the four ids with exactly four rows. The `ALL_IDS` list those share is now module-level; the existing "four ids bare and distinct" case reads it instead of its own array, which is the only existing assertion the round touched. `sounds.spec.ts` gained nothing: the `SoundPlayer` seam is `(assetId: string) => void` and both `soundFor` and `playLocally` are private, so no spec can reach a built `Sound` without widening the seam — the prompt said not to, and the config assertion covers the value.

**Prompt corrections.** (1) It offered "whether the other three sounds get explicit entries", but criterion 1 required them written at `1`/`1` — the criterion decided what the decision was asking about; they are explicit, for the reason above. (2) It suggested `Readonly<Record<…>>`; the tree uses `Record<…>` plainly (`rollFromWeights`, `ownedBalls`) and no `Readonly<T>` anywhere, so the local idiom won. (3) Nothing else was wrong: `soundFor` is where the `Sound` is constructed and configured, `soundUri` is still the only place the scheme is written, and no code wrote either property before this round.

**Studio-only, and not observed here:** whether 0.6 is the right level for the hit, whether it reads as quieter than the elimination sound under a scrum, and whether `PlaybackSpeed = 1` leaves the clip at its authored pitch. Everything else is a source read or a suite assertion.
## 90. A pickup that raises a ball's speed is announced, and only then

**There was no sound on a collection.** `PickupService.onPickupTouched` computed `before` from the ball's `BALL_SPEED` and `after` from `speedAfterPickup(before, decision.boost)`, wrote the attribute when the two differed, and printed `[Pickup] collected …`. Item 90 puts a `Remotes.PickupSound` broadcast inside that same write guard, so the sound and the speed change are one decision rather than two that are supposed to agree.

**The condition is the existing one, not a second one.** The guard is `after !== before`, and `speedAfterPickup` is `math.max`, so the value can move in one direction only — "changed" and "got faster" are the same test. Firing inside the guard is therefore the only placement that cannot drift: a fire above the write, or beside the `[Pickup] collected` line with its own `if`, would play on every `Touched` and this is the one sound with no client throttle to survive that. **One site, one condition**, and the `else` branch (recycle re-arm) fires nothing.

**A stale comment was corrected while placing it.** The service's `else` branch said "**Unreachable today, kept deliberately.** Every decision consumes" and the paragraph above it said "every power destroys the pad". Both were wrong: `pickupDecision` returns `consume: false` for `recycle` and `true` for everything else, so the branch is live and the recycle re-touch is the exact case the fire condition exists to silence. The two comments now say what the code does, because a reader deciding whether the fire is safe needs the recycle case to be real rather than hypothetical.

**The brief's fire position was "beside the log line"; the fire is inside the guard instead.** The log line is outside the guard — it prints for every collection, consumed or not — so "beside it" would have meant writing the condition a second time. Same feature, one fewer place to disagree.

**The remote is created by `PickupService`, not handed over by `RoundService` — the one deliberate deviation from the brief.** Verified first: `RoundService` does own the `Remotes` folder (`createHitEffectRemote` find-or-creates it), so the brief's assumption was right. But `PickupService` is a standalone `@Service()` that nothing injects, and its own docblock argues the direction: "the dependency points one way: `RoundService` does not import this service… a future change to the phase machine cannot forget to call a pickup hook because there is no call to forget". A `setPickupSoundRemote` hand-over would have to inject `PickupService` into `RoundService` and reverse exactly that. The precedent for the alternative is `EconomyService`, which creates `OpenCoinChest` and `FuseBalls` in the same folder itself, under the docblock "`ReplicatedStorage.Remotes` is created by whichever service starts first, so neither owns the folder". So `PickupService` find-or-creates the folder and creates `PickupSound` in `onStart`, before the `RoundState` wait, so no service start order is load-bearing; the handler reads a cached field, never a `FindFirstChild`.

**The fire carries nothing, and the client handler takes nothing.** The sound is non-positional and identical for every collection, so a `Vector3` would be an argument the client ignores — the hit effect carries one because it *draws*. The client is a new `PickupSoundController` (`src/client/controllers/pickup-sound-controller.ts`): resolve the folder and the remote, connect, `playPickupSound()`, warn if either is missing, and print `[PickupSound] listening on PickupSound` so a Studio run can tell "not wired" from "nothing boosted". It is new rather than folded into `HitEffectController` because that controller's whole docblock is an argument about particle carriers, and a reader looking for the pickup sound would not open a file named for the hit effect; `EliminationSplashController` is the precedent for a controller that owns an audio remote.

**The Flamework registry was rebuilt for it, deliberately and only.** `flamework.build` and `out/tsconfig.tsbuildinfo` were deleted — not `out/`, per item 52's warning about `rm -rf out` under a live `rojo serve` — and `npm run build` regenerated them. `flamework.build` now lists `client/controllers/pickup-sound-controller@PickupSoundController` beside the other eleven.

**`playPickupSound` is `playClickSound`'s shape exactly**, and the asymmetry is the point: it takes no `now` and touches neither `canPlay` nor `lastPlayedAt`, because it is one event per ball per pad. The file docblock's unthrottled families gain a fifth bullet saying so, and `sounds.config.ts`'s copy of the id carries the same argument — that is where a reader adding a sixth sound will be looking. There is nothing to reconcile with the click and the purchase: all three are one-liners that call `play(<id>)`.

**No pure predicate was extracted for `after > before`.** It does not need one: the fire shares the write's condition, so a new function would duplicate `speedAfterPickup`'s comparison. The two outcomes are already pinned through the pure function — `speedAfterPickup(4, boost)` raises and `speedAfterPickup(boost, boost)` does not (`powers.spec.ts`, "raises a slower ball to the boost and leaves a faster one alone") — and the fire's *position* is a source read of `onPickupTouched`.

**The fifth tuning row, which is the round's quietest failure mode, is asserted.** `[PICKUP_SOUND_ASSET_ID]: { volume: 0.8, playbackSpeed: 1 }`, `**Placeholder.**`, and a spec case names it, because a `Record<string, …>` silently answers `1`/`1` for an id it does not know — the sound would play, look right, and never use the numbers. The id itself is bare (`"111254855668531"`) and pinned with its `rbxassetid://` form, like the hit id.

**The known residual, stated rather than guarded.** A recycle pad survives, and the ball's speed decays off the boost, so a ball parked on one can legitimately be re-raised more than once over a long rest — each of those is a real `after > before` and will play the sound. The brief's framing ("the no-op re-touch is already silent") is true of the *repeating `Touched` while the ball is at or above the boost*, not of the whole rest; a throttle would have hidden that rather than fixed it, and the round deliberately has none.

**Tests: 281 across 19 files, up from 278.** Two new in `sounds.config.spec.ts` (the pickup id's uri; the pickup tuning row, with its distinct volume) and one in `sounds.spec.ts` (`playPickupSound` twice, two plays — the case that fails the day somebody adds a `canPlay` "for consistency"). `jest-roblox` has no `.not`, so the "not a shared row" claim is asserted through the two volumes rather than by negating an equality. Existing assertions touched: the "four ids bare and distinct" case is now "five ids", and "leaves the other three sounds at the engine's defaults" became "leaves the click, purchase and elimination at the engine's defaults" over an explicit `DEFAULT_TUNED_IDS` list, because the pickup row is no longer a default.

**Prompt corrections.** (1) The remote is not handed over by `RoundService` (see above). (2) The fire is not "beside the log line"; it is inside the write guard, because the log line is outside it. (3) The `consume: false` branch is **not** unreachable — the service said it was and the service was wrong; `pickupDecision` returns it for `recycle`. (4) "Only criteria 1–3 and 7 are assertable" undercounts: the tuning row and the unthrottled property are both assertable and both are asserted.

**Studio-only, and not observed here:** that a collection is audible, that its volume sits between the hit and the elimination sound, and that a ball resting on a recycle pad does not produce a rattle. The log evidence is `[PickupSound] listening on PickupSound` once at boot, and one `[Pickup] collected …` per sound heard.
## 91. The pickup sound is throttled after all, because a measurement beat an argument

**The reported symptom was "a weird sound" on pickups, and the Studio log explains it exactly.** Of 27 `[Pickup] collected` lines, **19 are `recycle` re-touches**, and the gaps between them are `19, 22, 24, 20, 20, 19, 14, 20, 19` ms in one rest and `17, 52, 19, 18, 19, 20, 23` in another. Every one reads `BALL_SPEED 11.987 -> 12 consumed=no`. Item 90's fire condition was passing on every single re-touch, so the client started one clip roughly fifty times a second. That is the buzz.

**Item 90's argument was wrong in a way worth recording, because it looked airtight.** The claim was that the server's "the speed actually rose" condition already removes the repeated case: a `recycle` ball parked on its surviving pad should compute the value it already has and fire nothing. The premise fails because `BALL_SPEED` decays *between* touches — the pad sees `11.987`, raises it to `12`, and the next touch twenty milliseconds later sees `11.98` and does it again. **A condition that rules out "nothing happened" does not rule out "the same thing happened again"; only an interval can.** The same sentence is now in `sounds.config.ts` and `shared/ui/sounds.ts`, because it is the mistake a future round will make again.

**`canPlay` gained an optional third parameter rather than growing a second predicate or a lookup.** `canPlay(lastPlayedAt, now, minIntervalSeconds = SOUND_MIN_INTERVAL_SECONDS)` — every existing caller and every existing assertion is unchanged, there is still one comparison, and the boundary stays testable with literals. The alternatives: a per-sound interval map read inside the predicate would put an asset id into a function that takes numbers and no state; a second predicate would be a second boundary to keep in step.

**`PICKUP_SOUND_MIN_INTERVAL_SECONDS = 0.3`, `**Placeholder.**`, shorter than the shared half second on purpose.** A pickup is a reward the player was driving at, and two genuine collections half a second apart are two events; the shared interval is tuned for bursts the player did not cause. 0.3 s cuts the re-touch rate by a factor of fifteen — 50 starts a second to at most three — which is the whole fix, and it is still fast enough that two real collections read as two sounds. `playPickupSound(now = os.clock(), play = playLocally)` now has the same shape as the elimination and hit players, with its own interval passed to the shared predicate.

**The server is unchanged, deliberately.** `PickupService` still fires inside the `after !== before` guard, because the ball really is being re-boosted and the log is honest about it; the sound's job is to be a *sound*, and collapsing repeats is the client's, exactly as it is for a batch of eliminations and a scrum of hits. The cost is wire traffic — one `FireAllClients` per re-touch, ~50/s per resting recycle ball — which is noted here as the follow-up if it ever matters: a per-body server-side interval would remove it, and would be a different change with a different owner.

**A mechanic defect is visible in the same log and is out of scope.** Those 19 re-raises hold a ball's `BALL_SPEED` at `12` for as long as it rests, which is the "ball held on the belt indefinitely" behaviour item 80's `consume` rule was meant to prevent — the recycle pad survives by design, and the `math.max` idempotence only protects a ball that is already at the boost. That is a gameplay question (should a recycle ball be re-boosted on every contact?) and not a sound one; it is recorded here rather than fixed, because changing it would be a different round with its own balance argument.

**The documentation that said otherwise was rewritten, not appended to.** `PICKUP_SOUND_ASSET_ID`'s docblock said "**Not throttled**" and gave the false reason; the module docblock's throttle section said "Two of the five sounds"; the `sounds.ts` file docblock carried an "is not throttled, because the server only sends it for a real boost" bullet; `remotes.ts` said "no client-side throttle is needed"; and `pickup-sound-controller.ts` said "No phase gate, and no throttle". All five now say what the code does and why the previous reading was falsified, because a corrected constant beside five confident wrong comments is worse than no comments at all.

**Tests: 283 across 19 files, up from 281.** `sounds.spec.ts`: the item-90 "plays on every call" case is **replaced** by "plays once per interval, and again at the boundary" — three calls in a frame, one play; exactly 0.3 s later, a second; a further call inside the window refused — plus "keeps the pickup interval shorter than the shared one", which is the property the whole justification rests on. `sounds.config.spec.ts`: "uses the interval it is given, and the shared one by default", asserting the same two numbers answer differently at 0.3 and at the default. The pickup cases run from a 4000 time base, so no block can be made to pass by the one before it.

**Prompt-adjacent corrections, since this round was a bug report rather than a spec.** The user's guess ("could the ball be touching it multiple times?") was right, and the cause is *not* a ball touching several pads: it is one ball on **one** surviving `recycle` pad, re-raised every physics step. "Sometimes" is the signature of that — it only happens after a `recycle` column has been collected.

**Studio-only, and not observed here:** that 0.3 s turns the buzz into discrete sounds rather than a slower buzz, and whether three starts a second is the right density for a rest (a longer interval would be one held tone; the value is a `**Placeholder.**` for that judgement).

**A note for the next round, since it is the same shape:** the fire still happens per re-touch on the wire. If the traffic is ever a concern, gate the *fire* with a per-body timestamp in `PickupService` — but do it as its own change, because the sound is fixed without it and this round's evidence is about audio, not about bandwidth.
## 92. Backspin is deleted, because the surface it was written for has been gone since item 18

**Nothing in this tree had read the spin since item 18 replaced the moving surface with a reference number.** `stepBallSpeeds` writes every ball's velocity from the `BALL_SPEED` attribute each tick, the floor under the belt is static and friction `0`, and no file anywhere reads a ball's `AssemblyAngularVelocity` to decide anything. The mechanism kept running anyway: `attachBackspin` gave every spawned ball a second `Touched` connection, and `applyBackspin` computed `slip = v + ω·r − u`, added angular velocity to close the gap to `BALL_BACKSPIN_TARGET_SLIP = 15`, and the engine's friction response turned that into `predictedDv = −slip / 3.5 ≈ −4.286` studs/s — on **both** bodies of **every** ball-ball contact, against a `BALL_SPEED` decay of `0.3/s`. That is the first of the two symptoms: contacts were costing a ball roughly fourteen seconds of decay worth of speed. The second is that the spin was invisible — item 44 had already replaced the markers' rate with `min(APPARENT_SPIN_MAX_RAD_PER_SEC, APPARENT_SPIN_GAIN × BALL_SPEED / radius)`, so the `ω` backspin produced was drawn from nothing and read as nothing.

**Deleted, in full.** The `applyBackspin` and `attachBackspin` pair and their whole two-thousand-word docblock; the four constants `BALL_BACKSPIN_ENABLED`, `BALL_BACKSPIN_TARGET_SLIP`, `BALL_BACKSPIN_COOLDOWN` and `BALL_BACKSPIN_MIN_BELT_SPEED` with their docblocks (including item 22's convergence derivation and the impulse history) — they had no reader outside the handler, so they were deleted rather than zeroed; the `backspinConnections` and `lastBackspinAt` maps and `releaseBackspin`, with its two call sites in `destroyBall` and `pruneDestroyedBalls`; the `attachBackspin` call in `spawnBall`; and the `[Ball] backspin:` line, the round's only per-contact velocity diagnostic.

**One consequence beyond the brief, taken because the alternative was dead API:** `TreadmillService.getEffectiveBeltSpeed` had exactly one caller — the backspin gate — and it is deleted too. `getReferenceBeltSpeed`'s docblock used to argue against it by name; it now argues against the *ramped value*, which is the fact the contrast is about. `beltSpeedOverride` survives, because `readSpeed(part)` still uses it to drive the constraint and the texture scroll.

**Seven comments were rewritten rather than left standing, and none of them was a hedge.** The wall assist's docblock said it was "a copy of `attachBackspin`/`applyBackspin` above, deliberately" and pointed at a handler that no longer exists; `powers/index.ts` described `[Powers] hit:` as countable against the deleted line; `PICKUP`-era and marker-era comments referred to the deleted axis by function name; `powers.config.ts` justified `POWER_COLLISION_COOLDOWN` "for the reason `BALL_BACKSPIN_COOLDOWN` is not optional". Each now states the fact without the dead reference. **`grep -ri backspin src/` is zero** — including comments, which was the round's own acceptance criterion — so the record of what was deleted lives here rather than as a trail of "used to be backspin" notes in the source.

**What did not move, verified by diff rather than by intent.** `onBallCollision` is unchanged (comment-only diff in `powers/index.ts`); `broadcastHit` and `Remotes.HitEffect` unchanged; the burst in `hit-effect-controller.ts` unchanged; `stepBallSpeeds` and the reference-speed region unchanged; the powers' `collisionConnections` map unchanged — backspin never shared a connection with any of them, it held its own map in the spawner, so the deletion needed no split. `marker-spin-controller` is comment-only: `omegaPhysical` still prints, and the physical-spin branch of its rate model is untouched (and now permanently unreachable, since nothing writes `AssemblyAngularVelocity`).

**No test referenced it.** `grep backspin src/server/test` was empty before the change, so the suite is 283 passing before and after; there was no assertion about the double-fire to keep or repair.

**The two log lines that remain, and why.** `[Spawner] spin-probe` survives with both its `omega` fields: it is temporary instrumentation for the markers, and a probe that computed `contactSlip` from a constant would stop being able to notice the day something starts spinning a body again. Its docblock now says plainly that `omega` is structurally zero and `contactSlip` reduces to `u − ballSpeed`. `[Powers] hit:` survives untouched.

**What a ball-ball contact is now.** The engine's own collision response, plus whatever the powers do — `bully`/`heavy` still transfer `BALL_SPEED`, `ghost` still passes through. There is no replacement penalty, deliberately: if contacts should still *feel* like hits, that is a named round with a `bully`/`heavy`-only effect, which is the shape the powers already model rather than a global velocity tax on every pair.

**Studio-only, and not observed here:** that two balls now separate by the engine's response alone, and that the ride no longer loses ~4.3 studs/s per contact. The evidence is negative — no `[Ball] backspin:` line, and `[Spawner] spin-probe` reporting `|omega| = 0` for every body — plus whatever the next playtest says about how long a round lasts now. The other half of "the balls die too quickly" is the `MaxLiveBalls` cap, which this round deliberately does not touch.
## 93. Which axis is which, stated once — and the wall assist turns out to do nothing

**The reference answer. Read this before writing a direction comment.** Every other note in this file is local; this is the one that says which way the world points.

**Along-belt is world X. Lateral is world Z. Up is Y.** The belt's `RightVector` is world `+X`, and for a belt whose long axis is X that is the **long** axis — not the lateral one. That is the naming trap: `RightVector` sounds lateral, and a reader who believes it writes a ball that moves across the belt. Every direction comment in `src/` now says "along-belt"/"lateral", and the full statement lives at `BallSpawnerService.stepBallSpeeds`.

**Toward the front is `-X` (boost). Toward the back is `+X` (decay, and elimination).** `stepBallSpeeds` writes the ball's along-belt velocity as `right.mul(-relative)` where `relative = BALL_SPEED - BELT_SPEED`, so a positive relative (a pickup) becomes motion toward `-X` and a negative one (decay) becomes motion toward `+X`. The sign is the model's, not the world's, and getting it wrong is a bug the tree already had once: with `+relative` a decaying ball exited at the edge it spawned beside.

**Two frames, and every number now says which.** `PointToObjectSpace` against the belt — the frame behind every `local=` log field, every footprint test and every pickup lane — has its origin at the belt's **geometric centre**, so code-frame X runs `-28 .. +28` and Z runs `-6 .. +6` for this scene's 56x1x12 belt. The **user frame** measures from the front edge and one side edge: `user-X = code-X + 28` (the belt runs `0 .. 56`, and **reaching the back is elimination**) and `user-Z = code-Z + 6` (the belt runs `0 .. 12`). **The two offsets are 28 on X and 6 on Z**, and they are in the README, in `stepBallSpeeds`, in the `[Ball] cap destroy` log comment and in the treadmill bind comment. A ball spawns at code-frame X `-23` (user-X `5`) and is eliminated at code-frame X `+28` (user-X `56`).

**The user's model, element by element.** The belt is a graph in quads 1 and 4 — **holds**, but only in the user frame: in the code frame the belt straddles Z `-6 .. +6`, and quad membership is a statement about the sign of Z, which is only "quads 1 and 4" once the origin is the front-left corner. X ≥ 0 only — **holds in the user frame** (`0 .. 56`), and the code frame deliberately includes negatives because it is centred. X = 0 is the front edge and X increases toward the back, so reaching the back is elimination — **holds**. Z = 0 is the centreline in the user frame, spanning 0..12 there and -6..+6 in code — **holds, with the offset**. Positive Z on the viewer's right (quad 1) and negative on the left (quad 4) from the front looking toward the back — **holds**; it is a convention rather than something the engine enforces, but it is the convention every comment now uses. Y is height — **holds**. Boost toward `-X`, decay toward `+X` — **holds**, and it is the axis fact the round was asked to settle.

**Two things the brief had wrong.** The **lateral bound is `LATERAL_BOUND = 2`**, not 4 — so a ball weaves between code-frame Z `-2 .. +2`, i.e. user-Z `4 .. 8`, never near an edge. And the boundary arithmetic in `LATERAL_BOUND`'s own docblock said "`4` leaves 1.5 studs", describing a value the constant had already stopped being; `Z_DRIFT_SPEED`'s docblock said "`0.5` studs/s … 9 studs of travel" for a constant of **`0.05`** (real answer: `0.9` studs). Both were wrong before this round and are corrected. The belt's literal size, origin and `RightVector` are **not in this repo** — the place geometry lives in Studio, and `[Treadmill] bound …` prints `size=`, `origin=` and `rightVector=` on every bind. The numbers above are the codebase's own record of a Studio scene, corroborated by every comment that quotes them and by the code measuring extents as `belt.Size / 2` rather than hard-coding 28 or 6.

**The functional finding, and it is bigger than the comments: `applyWallAssist` is inert, and its sign is backwards.** It writes `AssemblyLinearVelocity` along `+RightVector` (= `+X` = **toward the back**), while `stepBallSpeeds` owns that component and rewrites it from `-relative` on every `Heartbeat`. So the nudge is replaced before a second tick passes and can never accumulate toward `WALL_ASSIST_TARGET_SPEED`; the most it achieves is a sub-frame displacement. Worse, `+X` is the *losing* direction under the reference model, so even the direction is wrong for something called an "assist". Its convergence check reads `AssemblyLinearVelocity · RightVector`, which the model sets to `BELT_SPEED - BALL_SPEED` — a measure of how far the ball has decayed, not of how fast it moved. **Nothing about the wall assist was changed**, per the brief: fixing it means deciding whether walls should shove balls at all, which is a gameplay round. The comments now say plainly that it does nothing, so nobody reads its presence as evidence that walls work. The rule it broke is already written in `onBallCollision`: "a force or an `AssemblyLinearVelocity` written here would be gone in the same frame, which is the one mistake this whole design exists to avoid repeating."

**A documentation bug found while surveying: the model's docblock was attached to the wrong function.** The two-thousand-word "the belt is a reference number" explanation — the one a reader needs to understand `stepBallSpeeds` — sat immediately above `newWeave`, with `stepBallSpeeds` following it without a docblock of its own. It has been moved onto `stepBallSpeeds` and rewritten in the new vocabulary; `newWeave` keeps its own.

**Comments changed, by file.** `ball-spawner-service.ts` — the moved and rewritten `stepBallSpeeds` docblock (axis, naming trap, both frames, the three cases, and the note that this loop is the only writer of the along-belt component), the `-relative` inline comment, the weave's axis comment, `applyWallAssist`'s two docblocks, and the frame note above the `local=` log. `tuning.ts` — `WALL_ASSIST_ENABLED`, `WALL_ASSIST_IMPULSE`, `WALL_ASSIST_TARGET_SPEED`, `Z_DRIFT_SPEED`, `LATERAL_BOUND`, `LATERAL_BOUND_MIN`, `PICKUP_X_MIN`. `attributes.ts` — `BELT_SPEED_ATTRIBUTE`, `BALL_SPEED_ATTRIBUTE`. `powers/index.ts` — a new "the transfer moves a number, not a direction" paragraph in `onBallCollision`. `treadmill-service.ts` — the Axis convention section, `getBeltRightVector`, and the bind block. `pickup-service.ts` — the `PICKUP_X_*` docblock and the lane comment. **Nothing was deleted outright except three sentences that argued for mechanisms that no longer exist:** the treadmill's "the prompt suggested `-RightVector`…" paragraph (a reply to a brief nobody can see), the same file's "the moving slab is the collision surface" and "the constraint axis is not recomputed" (there is no moving slab and no constraint), and `WALL_ASSIST_TARGET_SPEED`'s "reaches 8 in 0.8 s" arithmetic (the assist cannot reach any target at all, and the rates it quoted were hypothetical).

**No behaviour changed.** `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` and `npm test` are green at 283 tests, and every touched `.ts` file was compared with its committed version after stripping comments: the code is identical. **Not verifiable without Studio:** the belt's literal `size=`, `origin=` and `rightVector=` — the bind log prints them, and if they differ from 56x1x12 / centre-origin / `+X` then the numbers in these comments need the same one-line correction in one place (`stepBallSpeeds`) and a follow-through everywhere they were copied.
## 94. The wall assist is deleted — item 93 proved it inert and backwards

**Item 93 measured the assist and found it did nothing, in the wrong direction.** `applyWallAssist` wrote `AssemblyLinearVelocity` along `+RightVector` (`+X`, toward the back, toward elimination) and `stepBallSpeeds` replaced that component from `-relative` on every `Heartbeat`, so the nudge never survived a tick and could never approach `WALL_ASSIST_TARGET_SPEED`. Its gate read `AssemblyLinearVelocity · RightVector`, which under the reference-speed model is `BELT_SPEED - BALL_SPEED` — how far a ball has decayed, not how hard a wall pushed it. It had not worked since item 18 retired the moving surface, and item 25 recorded two rewrites that tried to make it work.

**Deleted.** `attachWallAssist`, `applyWallAssist`, `releaseWallAssist`, the `wallAssistConnections` map, the call in `spawnBall`, and the two `releaseWallAssist` calls in `destroyBall` and `pruneDestroyedBalls`; the `WALL_ASSIST_ENABLED`, `WALL_ASSIST_IMPULSE` and `WALL_ASSIST_TARGET_SPEED` constants with their docblocks — deleted, not zeroed, since the handler was their only reader; and `TAGS.treadmillWall` from `shared/tags.ts`, which had no reader left. There was never a `[Wall]` log line to remove and no wall counter existed.

**Walls still block balls.** The deletion removes an inert mechanic, not a collision: a wall is an ordinary scene part and balls stay in collision groups that collide with `Default` (item 74, verified in `powers/index.ts`'s group table — `BALL_GROUP`/`Default` yes, `GHOST_GROUP`/`Default` yes). One consequence worth stating for a designer: **a wall left tagged `TreadmillWall` in Studio now carries a label nothing reads** — harmless, but removable, and a wall does not need a tag to be a wall. The README said otherwise and now says this.

**No replacement is built.** If walls should shove balls, the mechanism is a write to the `BALL_SPEED` attribute — the same lever `onBallCollision` uses for transfers — and it would need a sign that moves a ball toward the front. That is a named gameplay round; this one deletes and stops.

**Item 93's work survived intact**: the naming-trap paragraph, the two-frame notes, the axis vocabulary in `README.md` and the `-relative` inline comment are all unchanged except for one word-list in the naming trap (`applyWallAssist` removed from "where this tree uses `RightVector` along-belt") and one clause in the same docblock ("which is the whole reason the wall assist cannot reach its own target" became the general rule that the loop is the only writer, so the attribute is the only lever another module has). Both edits were required by the deletion, not by a disagreement with item 93.

**Item 93's "reported, not fixed" is now fixed.** Item 93 deliberately left the assist alone and wrote that nobody should read its presence as evidence that walls work. This item removes the thing that needed the warning, so item 93's sentence about the handler still being there is history rather than current state — the HANDOFF entry for 93 is left as written, because it records what that round found and chose.

**Verified by audit, not by diff.** Every touched `.ts` file was compared against `HEAD` after stripping block and line comments: `treadmill-service.ts`, `round-service.ts`, `attributes.ts` and `powers/index.ts` have **0 changed code lines**; `tuning.ts` differs by exactly the three deleted constants; `tags.ts` by exactly the deleted tag; `ball-spawner-service.ts` by exactly the 34 wall-assist lines and nothing else. `stepBallSpeeds`, `onBallCollision`, `broadcastHit`, the burst, the collision groups and `TreadmillService`'s bind are untouched.

**Build, lint, prettier and tests green at 283 tests**, `grep -ri "wallassist\|WALL_ASSIST\|TreadmillWall" src/` is zero, and `flamework.build` is unchanged (no controller or service added or removed). **Studio-only:** that a wall part still stops a ball with no tag on it — which is the one behaviour claim this round makes without a source read behind it, and it rests on the collision-group table rather than on a run.
## 95. The wind trail is driven by a `Boosted` attribute, and the spawn draw is now one-sided

**A `Boosted` boolean now rides on every ball, and a client controller renders it as a persistent `windBoost` clone welded to the body.** The attribute is written by `BallSpawnerService.writeBoosted`, called from `stepBallSpeeds` — the one place that reads `BALL_SPEED` after every contributor (decay, a power's delta, the clamp) has landed — and also from the round-end loop that zeroes `BALL_SPEED`, because the loop that normally settles it stops the moment the round does. **One `SetAttribute(BOOSTED_ATTRIBUTE, …)` in the tree, two callers.**

**Two thresholds, not one.** `true` at `BALL_SPEED >= BELT_SPEED`, `false` below `BELT_SPEED - BOOST_HYSTERESIS` (0.5, `**Placeholder.**`), unchanged in the band. A single threshold would flip the flag on consecutive frames as a ball decayed *through* the reference — at `0.1` studs/s that band is a fifth of a second wide, long enough to strobe the effect. The write happens **only when the value changes**: the attribute replicates, and re-asserting the same boolean sixty times a second per ball is traffic carrying no information. It is written in the same tick as the velocity, so a client reading both in one frame cannot see them disagree.

**The spawn draw is now one-sided: `BALL_SPEED_START + math.random() * 2 * BALL_SPEED_START_JITTER`, i.e. `10 .. 12`.** It used to be `10 +- 1`, so half the field launched *below* the reference and would never be at the speed the effect represents — a boosted effect that could never play for half the players. The spread is unchanged (2 studs/s); only its sign moved. The round-start log line changed with it (`+0..2` instead of `+-1`), and `BALL_SPEED_START_JITTER`'s docblock now says why the spread is positive.

**The controller is new and is deliberately not `HitEffectController`.** Same recursive lookup by name, same two refusals, same one boot line naming what was found (`[WindBoost] mounted on <GetFullName()> (<ClassName>)`) — and then a completely different lifecycle: a hit is clone → emit → `Debris`, a boost is clone while `true` → destroy on `false` or on the ball's `Destroying`. There is no carrier part and no timer. The clone is **welded** (`WeldConstraint`, parented to the clone), made inert (`Anchored = false`, `Massless = true`, `CanCollide`/`CanQuery`/`CanTouch` off, `Transparency = 1`), and **parented to the ball**, so `Destroy()` on the body takes the trail and the weld with it and no map ever has to be swept on a schedule. Discovery is `GetTagged(TAGS.ball)` at boot plus `GetInstanceAddedSignal`, with the immediate attribute read that a mid-round body needs.

**The scaling helper is one ratio and five properties.** `ratio = (ball.Size.X / 2) / BASE_BALL_RADIUS * WIND_BOOST_SCALE_MULTIPLIER`; scaled are `ParticleEmitter.Size` (**rebuilt as a `NumberSequence`** — every keypoint's `Value` and `Envelope` multiplied, `Time` untouched), `ParticleEmitter.Speed` (`NumberRange`), `ParticleEmitter.Acceleration` (`Vector3`), `Attachment.Position` (`Vector3`) and the clone root's `Size`. **Not scaled**: `Rate`, `Lifetime`, `Color`, `Transparency`, `LightEmission`, `Rotation`, `RotSpeed`, `SpreadAngle`, `EmissionDirection`, `Drag` — design and time, not distance; scaling `Rate` would make the trail denser purely because the ball grew, which is a different effect rather than a larger one. `BASE_BALL_RADIUS` (0.5) and the multiplier (1) live beside the asset name in the controller, matching `HitEffectController`'s local asset constants: they are assumptions about *this asset*, not numbers about the belt or the ball.

**A retune landed between rounds and a test caught it.** `BALL_SPEED_DECAY_RATE` is `0.1` in the working tree (the file was written at 00:23, after this round's prompt was written), while the prompt, `tuning.ts`'s own docblock, both `powers.config.ts` exchange paragraphs and the pinned assertion in `powers.spec.ts` all still said `0.3`. The suite therefore failed before any of this round's work. **The designer's number was not reverted** — `0.1` triples every ride, which is what "the balls die too quickly" was about — so the assertion now reads `0.1` with a comment saying which way the dependency runs, and the three doc sites were corrected (`1 / 0.1 = 10 s` per point, `~100 s` of headroom, magnet `0.2/s` halving `100 → 50`). If `0.1` was a slip rather than a decision, the assertion is the failure that will say so.

**New controller, so the manifest was regenerated.** `flamework.build` and `out/tsconfig.tsbuildinfo` were deleted (not `out/`, per item 52) and `npm run build` recreated them; the registry lists **thirteen** controllers including `client/controllers/wind-boost-controller@WindBoostController`.

**Tests: 283, unchanged** apart from the retuned decay assertion. No test asserted the old jitter draw. `npm run build`, `npm run lint`, `prettier --check "src/**/*.ts"` green; `grep "\\uXXXX" src` zero.

**Studio-only, and not observed here:** that `ReplicatedStorage.assets.vfx.windBoost` exists and is a `BasePart` at the root — the asset is the user's, the boot line is the evidence, and the lookup is recursive by name so a different path still works; that the clone's particles follow a welded, unanchored, massless part as intended; and that `ratio = 1` at `Size = 1` leaves the effect at its authored size. Everything else — the attribute, the hysteresis, the draw, the transitions, the scaling arithmetic — is a source read.
## 96. The wind trail follows the ball by `CFrame`, not by a weld — the sky was item 86 again

**Reported: "the `windBoost` is just flying everywhere in the sky".** The boot line in the same log proves the lookup was fine — `[WindBoost] mounted on ReplicatedStorage.assets.vfx.windBoost (Part)` — and the trail existed, so the fault was in how it was attached.

**The cause is item 86's bug in a new mechanism.** `Instance:Clone()` copies the template's `CFrame`, and the asset is authored inside `ReplicatedStorage` rather than at the arena. Parenting does not re-base a part, and — this is the part that made it look dramatic instead of static — **a `WeldConstraint` does not snap two parts together; it preserves the offset they already have.** So the weld locked in "however far `ReplicatedStorage.assets.vfx.windBoost` is from the ball" and then faithfully dragged the effect around the sky at that offset as the ball moved. The hit burst failed the same way in item 86 and was fixed by assigning `clone.CFrame = carrier.CFrame`; this round is the same fix applied to a moving target.

**What replaced the weld.** The clone is `Anchored = true`, its `CFrame` is assigned to the ball's on the frame it is created (so the first frame the player sees is already correct rather than corrected a frame later), and **one** `RenderStepped` connection copies every live ball's `CFrame` onto its trail. That is `syncTrails`, and it is deliberately one loop for the whole system rather than a connection per ball: at `Playing` entry every ball is boosted, so a per-ball design would create and destroy fifty listeners per round as balls crossed the threshold, and would leak one for any ball that died without a `false`. The arithmetic is a map iteration per frame, which is the order `marker-spin-controller` already pays for the markers.

**There is a second reason not to weld here, and it is worth recording for the next effect.** The ball is pinned server-owned, so on a client it is a replicated body rather than a locally simulated one. A client-created unanchored part welded to it depends on physics behaviour this code cannot inspect — it may follow, it may lag, it may be ignored. An anchored part whose transform is *assigned* has no such dependency, and "inert picture" is exactly what a VFX clone should be: `CanCollide`, `CanQuery` and `CanTouch` off, `Transparency = 1` on the root because the pack's `Part` is a carrier for the `Attachment` and the particles are the effect.

**Unchanged from item 95**: the recursive lookup, the two refusals, the boot line, the `Boosted` attribute and its hysteresis, the one-sided spawn draw, the scaling ratio, the destroy-and-re-clone transitions, and the `Destroying` teardown (the clone is a child of the ball, so it goes with it). No server file, no manifest change, no new controller — this round is one file.

**Build, lint, prettier and tests green at 283.** **Studio-only:** that the trail now sits on the ball and follows it, that its authored `Attachment.Position` reads as the intended offset from the ball's centre once scaled, and that a replicated ball at ~20 Hz does not make the trail visibly step (it cannot be smoother than the ball it copies — a future round that wants interpolation would be smoothing the *ball*, not this).
## 97. The trail took the ball's rotation, so it tumbled — orientation now comes from the asset

**Reported: "it is spinning everywhere. The effect should be parallel to the ground. When cloned, is it following the orientation I put in Studio?"** The answer is yes, `Clone()` copies the template's **whole** CFrame — position *and* rotation — and that is precisely what went wrong in item 96's fix: `clone.CFrame = ball.CFrame` replaced both halves, so the effect inherited the **ball's** orientation instead of the authored one. A ball is spawned with a random tumble (`randomSpawnRotation` in `spawnBall`, which builds its basis from `CFrame.fromMatrix`) and then rolls as it travels, so its rotation is a different accident on every body and every frame. The trail dutifully followed it.

**The fix is one composition and one captured field.** `assetRotation = found.CFrame.Rotation` is captured **once at boot**, beside the resolution, and `frameFor(ball)` returns `new CFrame(ball.Position) * assetRotation` — the ball's **position**, the asset's **rotation**. `attach` uses it for the initial CFrame (so the first frame is already correct) and `syncTrails` uses it per frame. `CFrame.new(position) * rotation` composes the authored basis onto a translation-only frame, so the exact rotation matrix the designer built — including any roll — survives untouched; there is no look-vector arithmetic to get wrong.

**Why not copy the ball's `CFrame` and pre-multiply by a correcting rotation.** That would be the same answer expressed as "undo the ball's rotation, then apply mine", which needs an inverse per frame and reads as though the ball's orientation mattered. It does not: position is the only thing the effect takes from the body.

**Why not a weld with `C0`/`C1` offsets.** Because the underlying problem is that a weld *preserves* whatever transform the two parts happened to have (item 96), and encoding the correction in `C0` would put the authored rotation somewhere a designer cannot see it. An explicit assignment keeps the whole rule in one function.

**Unchanged**: the recursive lookup and boot line, the `Boosted` attribute and its hysteresis, the one-sided spawn draw, the scaling ratio, the destroy-and-re-clone transitions, `Destroying` teardown, and the single `RenderStepped` loop. One file, no server change, no manifest change.

**Build, lint, prettier, tests green at 283**; emitted Luau checked (`CFrame.new(ball.Position) * self.assetRotation`).

**Studio-only:** that the effect now reads as parallel to the ground on every ball. The remaining open question is design rather than code — whether the authored orientation is the one you want for a ball travelling along X, and whether the effect should sit at the ball's centre or offset by its `Attachment.Position` (it does the latter: the attachment's local offset is applied inside the clone).
## 98. The ball's visible skin is a client-side phantom that rolls about the belt's axis

**Reported symptom: the ball's surface tumbles.** The engine integrates contact torque into `CFrame.Rotation`, and that direction is not the model's — so a ball riding a belt reads as being knocked around rather than as rolling along it. Nothing in the tree reads a ball's own rotation (`windBoost` takes a position and an authored rotation, `hitEffect` a midpoint, `PowerBadge` a position), which is what makes its orientation safe to replace purely visually.

**What was built.** `BallRenderController` gives every `Ball`-tagged body a **phantom**: a `Part` with `Shape = Ball`, the body's size/colour/material and **clones of its six face `Texture`s**, parented *to the ball*, `Anchored`, non-colliding, non-querying, non-touching. `LocalTransparencyModifier = 1` on the real ball hides it on that client only — the property is `NotReplicated`, so the server and every other client are untouched. The phantom is rolled on `RenderStepped` about `apparentSpinAxis` at `apparentSpinRate(BALL_SPEED, r)` and posed at `new CFrame(ball.Position) * spin`: **position from the body, rotation from the roll, `ball.CFrame.Rotation` never read.**

**The server was not touched, and that is a deliberate departure from the brief.** The prompt asked for `AssemblyAngularVelocity = Vector3.zero` in `stepBallSpeeds`, justified as making the server body "provably frozen". **It would not freeze it.** Zeroing the angular velocity between physics steps does not reset the orientation already accumulated, and torque applied during the next step is integrated before the next `Heartbeat` runs — so the body would keep rotating, at reduced rate, while paying a physics write per body per tick. Item 92 deleted the last such write and the tree has argued twice that a velocity write from outside `stepBallSpeeds` is the mistake this design exists to avoid. Hiding the body achieves the whole goal for free. If a frozen server body is ever wanted for its own sake it is one line, and the reason it is not there is now recorded rather than forgotten.

**One rotation, two consumers.** The markers and the skin must turn together, so `marker-spin-controller` now poses its markers **inside the phantom's frame** (`spunBody = phantom.CFrame`) instead of accumulating an angle of its own; the accumulation survives only as the fallback for a client where no phantom exists, and the rate/axis formula moved to a pure module — `src/shared/apparent-spin.ts` (`apparentSpinRate`, `apparentSpinAxis`) — read by both files so the two cannot disagree. The file's diagnostics gain `rateSource=phantom` / `axisSource=phantom`, so a log says which path posed the markers. `APPARENT_SPIN_GAIN` and `APPARENT_SPIN_MAX_RAD_PER_SEC` are no longer imported there: the formula lives in one place now.

**Discovery, twice.** `GetTagged(TAGS.ball)` at boot plus `GetInstanceAddedSignal`, which is the pair `marker-spin-controller` uses and the reason a mid-round joiner sees balls rather than unrendered ones (item 30's fix, repeated here). Destroyed bodies are dropped by the tag-removal signal and by a deferred sweep in the frame loop, because a destruction path that raises no signal would otherwise leave an entry growing at spawn rate.

**Directory of new and changed files**: `src/shared/apparent-spin.ts` + `.spec.ts` (new, 8 assertions), `src/client/controllers/ball-render-controller.ts` (new), `src/client/controllers/marker-spin-controller.ts` (phantom lookup, guarded spin, `spunBody`), `src/shared/tuning.ts` (`BALL_PHANTOM_NAME`). `flamework.build` and `out/tsconfig.tsbuildinfo` were deleted and regenerated; the registry now lists **14** controllers including `ball-render-controller@BallRenderController`. Tests **289 across 20 files** (283 + 6), build/lint/prettier green, `\uXXXX` zero, and no `AssemblyAngularVelocity` write anywhere in `src/`.

**Not decided here, and worth a second look in Studio:** the draw rate is `BALL_SPEED` (never `RELATIVE_SPEED`), so the roll is always forward at a rate that decays - there is no direction flip at the belt threshold and no backward roll on a boosting ball. That is the behaviour item 44 settled for the markers, and this round inherits it rather than re-litigating it. **Latency:** the phantom copies a replicated position, so it is one replication interval behind - `BALL_SPEED = 12` over a 50 ms round trip is about 0.6 studs - and no extrapolation was added, because extrapolating `AssemblyLinearVelocity` on the client would overshoot every collision the server resolves.
## 99. The square was the physical ball's textures, still drawing on an invisible part

**Reported: "a strange square on the texture of the ball".** Cause: `LocalTransparencyModifier = 1` hides a **`BasePart`**, not its children — and **a `Decal`/`Texture` renders on a fully transparent part**. That is long-standing engine behaviour and it is what makes the "invisible part carrying a visible image" trick work; it also meant the ball's own six face textures went on drawing at the ball's *physical* pose, unrolled, underneath a phantom that was rolling correctly. One face of that texture, at a physics orientation, reads as a stray square on the ball.

**The fix is the same property one level down.** `Texture extends Decal`, and `Decal.LocalTransparencyModifier` is the documented local-only multiplier, so `copyTextures` now sets `1` on each source `Texture` as it clones it, while the clone keeps `0`. Both writes are client-side, so the server's ball is untouched and each client hides its own copy — the same rule the part-level property already followed. The docblock says why the second hide is not redundant, because a reader who sees `LocalTransparencyModifier = 1` on the part will assume the job is done.

**One latent difference closed in the same edit.** A fresh `Part` is `Studs`/`Inlet` while every spawned body is set to `Smooth` on both faces, so the phantom was the only ball-shaped thing in the arena carrying a surface treatment the ball does not have. On a `Ball` that draws nothing, so it was not this bug — but on a future non-sphere pool entry it would be a visible patch of studs, and the phantom is meant to be a copy of the part it stands in for rather than of a default `Part`. `TopSurface`/`BottomSurface` are now copied when the source is a `Part` (they are declared on `Part`, not `BasePart`).

**Unchanged:** the phantom's construction, textures, roll, hide-the-ball rule (part *and* textures), the marker integration, the pure `apparent-spin` formula, the server, and the manifest — this round is one file and two small additions inside it. Build, lint, prettier and tests green at 289.

**Studio-only:** that the square is gone. If a square survives, the next candidate is not another texture: the two remaining parts of this picture are the phantom's own cloned `Texture`s (which would then be the *only* thing drawing, so a square there would be an asset/tiling question) and the equatorial ring marker, which is deliberately larger than the ball (`MARKER_RING_OVERSIZE`). Worth naming both in the next report rather than guessing again.
## 100. A `TailWind` trail for a ball in regular motion, and two corrections to the brief

**The state.** `TailWind` is a per-ball boolean written by `BallSpawnerService.writeTailWind`, called from `stepBallSpeeds` on the same tick as `Boosted` and **fed the `Boosted` value that write just settled** rather than reading the attribute back:

```ts
const relative = advanced - beltSpeed;
const boosted = this.writeBoosted(ball, advanced, beltSpeed);
this.writeTailWind(ball, relative, advanced, boosted);
```

so the condition is `relative < 0 && speed > SPIN_DEADBAND_SPEED && boosted === false`. `writeBoosted` now returns its settled value (previously `void`) precisely so the second write has no window in which the two can disagree, and no second attribute read per ball per tick. **Both are also settled in the round-end loop** — `stepBallSpeeds` stops when the round does, so a ball frozen with `TailWind = true` would otherwise carry its trail through `PostGame`, the same defect item 98 fixed for `Boosted`.

**`SPIN_DEADBAND_SPEED` is `tuning.ts`'s (0.5), imported rather than restated**, so "visibly rolling" means one thing in the tree — the same threshold `apparentSpinRate` returns 0 at. **No hysteresis**, and the reasoning is now recorded rather than assumed: every term is monotone between events (`BALL_SPEED` only decays; `Boosted` already carries `BOOST_HYSTERESIS`, so the handover from `windBoost` to `tailWind` happens once at `9.5`); a pickup or rocket is an event, not a boundary flicker.

**The controller** is `src/client/controllers/tail-wind-controller.ts`: recursive `FindFirstChild("tailWind", true)`, the two refusals and the mounted line, `GetTagged` + added/removed signals, `GetAttributeChangedSignal(TAIL_WIND_ATTRIBUTE)` plus an immediate read, one `RenderStepped` loop, destroy-and-re-clone on the transition, teardown on `Destroying`. **It contains no reference to `Boosted` in code** — the four matches are prose explaining why the rule is not there.

**Two corrections to the brief.** (1) It asked for the clone to be **welded** to the ball. `windBoost` does not weld — item 96 removed that because a `WeldConstraint` *preserves* the offset two parts already have, which put the effect in the sky and dragged it around at the asset's distance from the ball. `tailWind` therefore uses the same anchored-plus-per-frame-`CFrame` shape, and a weld here would have reproduced item 96 exactly. (2) It asked for `TAIL_WIND_SCALE_MULTIPLIER` **in `tuning.ts` beside `WIND_BOOST_SCALE_MULTIPLIER`** — but that constant is local to `wind-boost-controller.ts` (and is `0.1`, not `1.0`). The two multipliers are the same kind of per-asset knob, so splitting them across files would be worse than leaving both local; `TAIL_WIND_SCALE_MULTIPLIER = 1` sits in the new controller, and the one number the brief was right to call shared — `BASE_BALL_RADIUS` — **moved to `tuning.ts` and is now exported**, imported by both effect controllers instead of being declared twice.

**No client-side precedence.** The two effects are mutually exclusive at the source; the server is the only place that knows both facts in one tick, and a client re-check would be a second owner of the rule. That is stated in both controllers' docblocks.

**The scaling helper is a deliberate copy** (eleven lines) rather than a shared module, per the brief's own instruction: two files whose only other shared number is `BASE_BALL_RADIUS` do not yet justify a module, and the docblock says a third effect is the trigger.

**Manifest regenerated** (`flamework.build` + `out/tsconfig.tsbuildinfo` deleted, not `out/`); the registry now lists **15** controllers including `tail-wind-controller@TailWindController`. Build, lint, prettier and tests green at 289; `\uXXXX` zero; no `AssemblyAngularVelocity` anywhere.

**Studio-only, and not observed here:** that a `tailWind` asset exists under `ReplicatedStorage` and is a `BasePart` at the root — the recursive lookup plus the mounted line answer that in the first run, and a missing asset is a refusal in the log rather than a silent nothing; and that the trail reads as "rolling toward the exit" rather than as a second boost. If the effect should instead point along the direction of travel, that is an asset-orientation decision and one change in `frameFor`, not a second mechanism.
## 101. The giant effect was a copied scale constant that had drifted tenfold

**Reported: "there are one or more giant effect(s); scale it just like `windBoost`".** Cause, found by comparing the two controllers: `windBoost` carried `WIND_BOOST_SCALE_MULTIPLIER = 0.1` and `tailWind` carried `TAIL_WIND_SCALE_MULTIPLIER = 1`. Same arithmetic, same ball, **ten times the size** — and both files looked correct in isolation, which is exactly what a copied constant produces. The `0.1` was a Studio judgement made on `windBoost` after item 100 and never propagated.

**Fixed structurally rather than by editing the number**, because editing the number would leave the same trap one round away. New `src/shared/vfx-scale.ts` owns both halves:

- `effectScaleFor(ball)` → `(ball.Size.X / 2 / BASE_BALL_RADIUS) * VFX_SCALE_MULTIPLIER`, the only place a clone's scale is decided;
- `scaleEffect(root, ratio)`, the five-distance-property implementation (the `NumberSequence` rebuild, `NumberRange`, `Vector3`s), moved verbatim out of the two controllers;
- `VFX_SCALE_MULTIPLIER = 0.1` (**Placeholder.**) in `tuning.ts`, beside `BASE_BALL_RADIUS` — **one number, not one per effect**.

Both controllers now call `scaleEffect(clone, effectScaleFor(ball))` and their local copies, local multipliers and local helper functions are gone. `BASE_BALL_RADIUS` was already shared; the multiplier is now too, so "the same size as `windBoost`" is a structural fact rather than two constants that happen to agree today. **A future effect that genuinely wants a different size should pass a deliberate multiplier at its own call site and say why** — not fork the module.

**Both boot lines now print the scale**, `[WindBoost] mounted on … scale=0.1 (shared, see shared/vfx-scale.ts)`, and the same for `[TailWind]`. That is the cheapest possible answer to "is it actually the same size": one Studio run compares two numbers in the log instead of another round of guessing. It also makes a future drift visible at boot rather than on screen.

**`hitEffect` is deliberately untouched** — it is a one-shot burst at a contact midpoint with its own authored size ramp (`PARTICLE_SIZE_START/END`), not a per-ball trail, and its own scaling was never part of this pack-scale question. If that effect reads large too, it is a separate judgement about a different asset.

**Build, lint, prettier and tests green at 289**; `\uXXXX` zero; no `AssemblyAngularVelocity`; no manifest change (no controller added or removed — `vfx-scale.ts` is a shared module, not a service or controller).

**Studio-only:** that `0.1` is right for `tailWind`'s asset as well as `windBoost`'s. The two assets are authored independently and one multiplier assumes they were built to a similar size; if the tail-wind asset is intrinsically larger, the honest fix is to redraw or re-export it, or to pass a deliberate per-effect factor with a comment — not to reintroduce a second global.