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

## 3. Belt uses `AssemblyLinearVelocity` on the anchored part

Verified: `AssemblyLinearVelocity` is tagged NotReplicated in the installed typings; the conveyor
behaviour is documented on the deprecated `BasePart.Velocity` page, which names
`AssemblyLinearVelocity` as its replacement. A `LinearVelocity` constraint cannot drag an arbitrary
loose ball because it needs an `Attachment` — it was never a viable fallback. Axis is
`+RightVector`; negative `BeltSpeed` reverses.

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

## 8. Open: the duplicate-spawner report is not yet confirmed at runtime

Items 5 and 7 both plausibly explain "zero balls from the stream, manual fine" — a dead loop (5), and
`Enabled` being absent and read as `false` (7). The current bind log distinguishes them: it prints
`derived=...` plus every attribute, and the tick log prints `spawned N` per spawner once a second.
A third possibility remains untested and is _not_ addressed by code: two spawners at the same CFrame
with the same `Rate` emit balls at identical positions on the same tick, and overlapping collision
bodies get ejected — which looks like "no balls" with no error at all. If the tick log says
`spawned 1` while `live` climbs and nothing rests on the belt, separate the spawners in Studio.

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
- **Prior logs are consistent with COM-force, not contact torque:** `alongRight` reached ≈10.2 while
  the markers showed no visible rotation, i.e. `v ≈ u` with `ω ≈ 0`. Under contact friction the ball
  would settle at `2u/7` _with_ strong spin. Mechanism hypothesis 1 is therefore the leading cause.
- Next measurement, not yet taken: `AssemblyAngularVelocity` on a single body, plus `u - (v + ωr)`.

## 18. Belt drag mechanism replaced: moving collider on a PrismaticConstraint motor

Replaces the anchored-belt AssemblyLinearVelocity mechanism from item 3, which Studio showed producing ~0.1 studs/s² and no rotation. The belt is now CanCollide = false and hosts an invisible, Massless, unanchored slab driven along Attachment0's X axis by a motorised PrismaticConstraint; balls rest on the slab so friction acts at the contact point. **Unverified in Studio.**
## 19. Belt surface material -> Rubber; bounce gated off (BELT_BOUNCE_ENABLED = false)

Friction isolated as the single variable: slab material SmoothPlastic -> Rubber via BELT_SURFACE_MATERIAL, and the Touched bounce assist short-circuited behind BELT_BOUNCE_ENABLED = false (impulse/chance/cooldown constants and the connection kept, so flipping the boolean restores it). No CustomPhysicalProperties, no FrictionWeight, ball material untouched. **Unverified in Studio.**
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

`BallSpawnerService.createMarker` no longer creates the `WeldConstraint`. Each marker is `Anchored = true` at its spawn pose and carries three `Vector3` attributes (`MarkerLocalPosition`, `MarkerLocalRight`, `MarkerLocalUp` — `ball.CFrame:ToObjectSpace(spawnCue)`), because with no weld a client cannot recover the local offset: the marker stays at spawn while the body moves, so `body.CFrame:Inverse() * marker.CFrame` is only correct in the spawn frame. Anchoring is the mechanism that was chosen over a client-side weld destroy because a client write to the `CFrame` of a *simulated* part is overwritten by the solver, while a client write to an anchored part whose `CFrame` the server never touches again is uncontended. New `MarkerSpinController` (`src/client/controllers/marker-spin-controller.ts`) draws all three markers per body on `RenderStepped` from smoothed `CFrame`-delta velocity — **not `AssemblyLinearVelocity`, which the installed typings tag `NotReplicated`** — at `APPARENT_SPIN_GAIN = 2` × `v/r`, clamped to `APPARENT_SPIN_MAX_RAD_PER_SEC = 30`, deadband `APPARENT_SPIN_MIN_SPEED = 0.1`, smoothing `APPARENT_SPIN_SMOOTHING_SECONDS = 0.15`. Axis is `yAxis:Cross(vhat)`, verified as *forward* rolling (for `+X` travel it is `-Z`), which is the negation of `applyBackspin`'s `RightVector:Cross(yAxis)`; `APPARENT_SPIN_SIGN = 1` exists so the direction is one edit to reverse. The drawn rate is a display choice, not physics: a sliding body now renders as rolling, so `[Spawner] spin-probe` prints `|omega|`, `omegaR`, `alongRight`, `u` and `contactSlip = u - (alongRight + omega*r)` once per body at 2 s to preserve the rolling-versus-sliding diagnostic. Ball textures are still applied (six per body, `attachBallTexture` unchanged) and item 14/15 disagree about whether they render; if they do, they will rotate at the physical rate underneath markers drawn faster, and the call — not the property — is what would have to go. **Unverified in Studio.**

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
