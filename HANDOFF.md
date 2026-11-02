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
  cell per spawner. Perfect lockstep is arithmetic � identical `rate` and identical `dt` keep
  identical cells identical � not shared state. It is not a bug.
- **The cap destroys without checking position.** `enforceCap` takes `liveBalls[0]` and calls
  `destroyBall` unconditionally.
- **Nothing sets network ownership.** No `SetNetworkOwner`/`SetNetworkOwnershipAuto` in `src/`.
- **Balls are parented last**, after `Size`/`CFrame`, and nothing calls `WakeUp` or writes a
  velocity.

Already derivable from the round-1 log without this round, by arithmetic: at `Rate = 2` across four
spawners the stream emits 8 balls/s; a ball needs roughly 7 s (�1 s to settle, then 56 studs at
10 studs/s) to reach the exit edge, so sustaining the stream requires �56 balls in flight against a
cap of 50. The cap therefore always governs, and ball 1 � last sampled at local X = 17.087, still
inside a 28-stud half-width � was destroyed by the cap while riding. **The current "elimination" is
`MaxLiveBalls`, not the belt edge.** Fixing that is a later prompt, not this one.

Resolution: pending the Studio run.

## 11. Shape pool landed; belt + ball textures and the sanctioned belt bounce

Item 10's diagnostic round is superseded in part: the pooled-shape work it was surveying was
half-applied and left the tree non-compiling, and this round finished it before adding the visuals.

Landed:

- `src/shared/shape-pool.ts` � `SHAPE_POOL` (Ball 1x1x1, Cylinder 1x1x2, Block 1x3x1,
  CornerWedge 1x1x1), uniform pick, `randomSpawnRotation` (Shoemake quaternion, not Euler),
  `rotatedHalfHeight`, `poolMaxExtent`.
- `Radius` retired from derived attributes; `KillY` now derives from `poolMaxExtent()`.
  `src/shared/attributes.ts` carries the reversal in place.
- `src/shared/tuning.ts` � belt/ball texture ids and tile size, bounce impulse/chance/cooldown.
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
mesh/shape question deferred. The pool _structure_ stays � `randomSpawnRotation`,
`rotatedHalfHeight` and `poolMaxExtent` are all still load-bearing (spawn rotation, spawn
clearance, `KillY`), and re-adding a shape later is one array entry.

The survey reasoning that argued for Cylinder/Block/CornerWedge (item 10, and the shape-variety
report) is kept as history in the module docblock rather than deleted: the measurements are still
correct and will be reused when meshes land.

**New finding, not fixed:** `rotatedHalfHeight` measures the rotated _box_, so a randomly rotated
1x1x1 sphere evaluates to a half-height in `[0.5, 0.866]` instead of the true constant `0.5`.
Balls therefore spawn 0 to ~0.37 studs higher than the old unrotated spawn, varying randomly per
spawn. Safe (never intersects) but not tight, and with a singleton sphere pool it is pure noise. The
one-line fix is recorded in that function's docblock and deliberately not applied � spawn clearance
was out of scope for this round.

## 13. Diagnostic round 3: instrumented belt/ball texture creation and the scroll controller

User reported, from Studio Play, that **no `Texture` child appears on the belt** while both asset
URLs load as valid images. This round adds logging only � no fix.

Three findings before the run:

- **The belt texture path is not conditional.** `attachBeltTexture` runs unconditionally inside
  `bind` after the reuse check; the only guard is `FindFirstChild("BeltSurface")` returning an
  existing instance. Candidate 1 from the report ("behind a conditional that fails") is therefore
  ruled out by source.
- **`Texture`/`Decal.ColorMapContent` is `NotReplicated`.** Confirmed from the API reference
  ("This property is not replicated. Its interface does not cross the network boundary"). Both
  textures are configured **on the server**, so even when creation succeeds, clients � and therefore
  the rendered surface � receive the `Texture` instance with **empty content**. This is a real bug
  and it survives any fix to the creation path: the content has to be applied client-side. Not fixed
  here.
- **The scroll controller waited forever.** It used `WaitForChild("BeltSurface")` with no timeout,
  so a server-side failure produced an infinite silent yield � indistinguishably from "not replicated
  yet". Now bounded at 10 s with a `GAVE UP` warning.

Discriminator for the next run: `attachBeltTexture` runs **before** `applySpeed`, so a throw there
also suppresses the `[Treadmill] bind` line and stops the belt dragging. `texture: start` with no
`bind` = it threw at creation. No `texture: start` at all = `bind` was never reached.

Appended rather than rewriting: item 12's spheres-only constraint and item 11's texture work are
unchanged by this round; it only adds logging.

## 14. Texture invisibility: cause found � only the underlying property was written

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
still dragging. Both asset ids verified externally as **AssetTypeId 13 (Decal)** � they are images.

**Cause:** `Decal` exposes four image slots. `ColorMapContent: Content` and `ColorMap: ContentId`
are the new pair; `TextureContent: Content` and `Texture: ContentId` are the legacy pair. The code
set **only** `ColorMapContent` � the underlying API property � and the renderer in the shipped build
reads the legacy alias. Corroborated on the DevForum: Explorer matches `Texture`/`ColorMap` but not
`ColorMapContent`, i.e. the aliases are what the rest of the engine actually surfaces.

**Fix (applied, one line per texture):** set `ColorMapContent` _and_ `Texture` (legacy string) with
the same URI, for both the belt and the six ball textures. They cannot conflict � same URI � and either
slot being honoured is enough. Read-backs of all four slots plus the part's own `Transparency` /
`Material` / `TopSurface` are logged, so a transparent belt is distinguishable from an untextured one.

No other behaviour touched: bounce, drag, pool, cap and cleanup are unchanged.

## 15. Welded pole markers + equator ring on every spawned body

A sphere has no features, so a rolling ball is visually identical to a static one. Textures were the
first attempt and did not render on the curved primitive; this replaces that approach for _proving
rotation_ with ordinary geometry.

Per spawned body, three welded Parts:

- `NorthPole` / `SouthPole` � `Shape = Ball`, `Size = Vector3.one � (radius � 0.3)` (0.15 studs
  at the placeholder radius), centred on the surface so half protrudes.
- `Equator` � `Shape = Cylinder`, `Size = (0.1, radius � 2.1, radius � 2.1)`, rotated 90� about Z
  so the cylinder's X axis (documented as its axis) stands vertical, giving a horizontal band.

All three: `CanCollide = false`, `Massless = true`, `Anchored = false`, `Material = Neon`,
tagged `BallDecoration`. Welded with `WeldConstraint` (`Part0` = body, `Part1` = marker) � it has
no `C0`/`C1` because it preserves the relationship present at creation, so the offset comes from
positioning the marker first.

**Parented as children of the body**, so `Destroy()` on the body removes them. A welded sibling would
survive its body and accumulate at spawn rate.

Ordering: body is parented first, then each marker is parented, then its constraint is created � so the
constraint always sees two parts in the DataModel.

Untouched: ball size, material, `CanCollide`, `Anchored`, spawn CFrame, rate, cap, kill plane,
bounce, shape pool, textures. `TAGS` gained `ballDecoration`.

## 16. One-shot spawn on Play replaces the timed stream

Spawned bodies now come from exactly one automatic spawn per bound `BallSpawner`, at server start.
No timer, no second body. `spawnOnePerSpawner` calls the existing `spawnBall` once per spawner from
`onStart`, after every spawner is bound, with per-spawner failure containment.

**`Enabled` and `Rate` are removed**, not left derived-but-unread � this file's own rule is that a
visible-but-inert attribute is worse than none. The `attributes.ts` docblock was rewritten in place
(third position on `Enabled`: `false` ? `true` ? retired).

Why: `Rate = 2` � 4 spawners against `MaxLiveBalls = 50` was a permanent 8-body/s mosh pit in four
lanes, where body-body collisions and the 1 s bounce cooldown interrupted rolling every ~150 ms. Every
observation about rolling-vs-sliding was being made inside it. Manual `1` still spawns extra bodies
(rate-limited as before) for collision tests.

## 17. Rolling survey findings (no code changed)

- **No part-level angular damping exists.** `AngularDamping` appears only on `AnimationConstraint`;
  `MaxAngularVelocity` only on `AlignOrientation`. Nothing in `src/` touches either. Cause 3 in
  the survey is ruled out by property availability, not just by absence of code.
- **`Shape = Ball` collisions are exact**, per the API reference: "Collisions between balls, blocks,
  and wedges, and corner wedges are exact".
- **The 66 ms rolling-onset figure is correct**, but the prompt's target `? � 20 rad/s` assumes a
  _stationary_ surface. For a belt moving at `u`, no-slip means `v + ?r = u`, so the settled state
  of a sphere released from rest is `v = (2/7)u � 2.86` with `? = (u - v)/r � 14.3 rad/s` � not
  `v = u` with `? = u/r`. The correct discriminator is contact slip `u - (v + ?r)`.
- **Prior logs are consistent with COM-force, not contact torque:** `alongRight` reached �10.2 while
  the markers showed no visible rotation, i.e. `v ? u` with `? � 0`. Under contact friction the ball
  would settle at `2u/7` _with_ strong spin. Mechanism hypothesis 1 is therefore the leading cause.
- Next measurement, not yet taken: `AssemblyAngularVelocity` on a single body, plus `u - (v + ?r)`.

## 18. Belt drag mechanism replaced: moving collider on a PrismaticConstraint motor

Replaces the anchored-belt AssemblyLinearVelocity mechanism from item 3, which Studio showed producing ~0.1 studs/s� and no rotation. The belt is now CanCollide = false and hosts an invisible, Massless, unanchored slab driven along Attachment0's X axis by a motorised PrismaticConstraint; balls rest on the slab so friction acts at the contact point. **Unverified in Studio.**
## 19. Belt surface material -> Rubber; bounce gated off (BELT_BOUNCE_ENABLED = false)

Friction isolated as the single variable: slab material SmoothPlastic -> Rubber via BELT_SURFACE_MATERIAL, and the Touched bounce assist short-circuited behind BELT_BOUNCE_ENABLED = false (impulse/chance/cooldown constants and the connection kept, so flipping the boolean restores it). No CustomPhysicalProperties, no FrictionWeight, ball material untouched. **Unverified in Studio.**
## 20. Manual trigger now spawns one body from every bound spawner

Pressing `1` previously spawned from the first registered spawner only (`firstSpawner`), which with four spawners meant three lanes never got a manual body. The manual path now calls the shared `spawnOnePerSpawner("manual")` � the same implementation as the start-of-session one-shot, parameterised only so the summary log line names the trigger. `firstSpawner` deleted; the 100 ms per-player cooldown is unchanged and still gates the whole press, not per spawner. **Unverified in Studio.**