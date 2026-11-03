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

Rate is now a branch chain, in this order: **physical** `min(30, APPARENT_SPIN_GAIN_OMEGA x |omegaPhysical|)` above `SPIN_AXIS_SOURCE_MIN_RAD_PER_SEC = 0.05`; **velocity** `min(30, APPARENT_SPIN_GAIN x |v| / radius)` above `SPIN_DEADBAND_SPEED = 0.5`; **deadband** `0`. `SPIN_RATE_OFFSET` is **deleted, not zeroed** — nothing else read it, and this file's rule is that an inert constant is worse than none; `SPIN_DEADBAND_SPEED` takes its place and its docblock records the reversal (a parked ball must not spin). `APPARENT_SPIN_GAIN` is re-purposed to `|v| / radius` at `4`; the new `APPARENT_SPIN_GAIN_OMEGA = 3` multiplies `|omega|` in the physical branch, kept separate because the units differ (`rad/s` per `rad/s` vs `rad/s` per `(studs/s)/stud`). `APPARENT_SPIN_MAX_RAD_PER_SEC` stays `30`. The physical branch is **first** so a genuinely rolling body is never drawn from its translation, and so the model becomes physical with no code change once the belt imparts spin; today it always falls through, since every probe reports `|omega| = 0`. `omega = 0` is provably inert rather than approximately so: `CFrame.fromAxisAngle(axis, 0)` is the identity and `angle += 0 * dt` adds nothing, so a parked ball's pose is preserved bit-for-bit. Logs gained `rateSource=<physical|velocity|deadband>` alongside the existing `axis=<physical|travel|belt>`. Discontinuity worth knowing: at the threshold the rate steps `0 -> 4` rad/s (~0.64 rev/s) because the branch is hard, so no-jump is true of the *speed* crossing (smoothed over 0.15 s), not of the rate. **Unverified in Studio.**
