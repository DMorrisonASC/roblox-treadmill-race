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
