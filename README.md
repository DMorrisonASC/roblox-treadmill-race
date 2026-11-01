# roblox-treadmill-race

Two independent, observable test fixtures — a treadmill belt and a server-authoritative ball
spawner. No rounds, no elimination, no UI. This slice exists so the belt and the spawner can be
watched in isolation.

Stack: roblox-ts + Rojo + Flamework.

## Layout

| Path                                                 | What it is                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/server/services/treadmill-service.ts`           | Binds to `TreadmillBelt` parts and drags things along them                        |
| `src/server/services/ball-spawner-service.ts`        | Binds to `BallSpawner` parts, spawns/caps/culls balls, owns the spawn RemoteEvent |
| `src/client/controllers/spawn-trigger-controller.ts` | Sends a manual spawn request on key `1`                                           |
| `src/shared/`                                        | Tag names, attribute names + defaults, remote names                               |

## Scene ownership

**Every part is placed by hand in Studio. This repo creates none of them.** `default.project.json`
declares nothing under `Workspace` on purpose: Rojo resets any instance it describes to the project
file's values on each live-sync, so a project-defined belt or spawner would snap back to a hardcoded
CFrame every time you moved it. Leaving `Workspace` childless means Rojo never touches your parts.

Connect with `npm run serve` from your own place. Do **not** open `build/game.rbxlx` for playtesting —
that is a freshly composed place with no parts in it (it exists only to prove the project file
composes).

## Running it

```powershell
npm install            # .npmrc pins legacy-peer-deps, see Toolchain notes
npm run build          # compile TypeScript to Luau in out/
npm run lint           # ESLint over src/ (legacy .eslintrc, see below)
npm run serve          # rojo serve, then connect from your place in Studio
```

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
- Flamework is a compile-time transformer that keeps its own build state. If you change
  `tsconfig.json` plugins, Flamework's config, or switch TS versions, run `npm run clean` first —
  otherwise the build fails with `Flamework cannot be built in a dirty environment`.
- Flamework prints a `TypeScript version differs` warning (project TS vs the 5.5.3 bundled inside
  roblox-ts). It switches to the bundled version and continues; the build is unaffected.

## Fixtures you build in Studio

**You tag the part; the code writes the attributes.** Both systems read their attributes from the
part, and fill in any that are missing at the moment the part is bound. So a freshly tagged part
works with no Properties-panel work at all. Anything already set is left alone — override a value in
Studio and it survives re-tagging.

### Belt — any `BasePart` tagged `TreadmillBelt`

| Attribute   | Type                 | Written if absent  |
| ----------- | -------------------- | ------------------ |
| `BeltSpeed` | number, studs/second | **Placeholder** 10 |

The part must be `Anchored` with `CanCollide = true`. The vector is `CFrame.RightVector` scaled by
`BeltSpeed`, so a positive speed drags toward the part's right (+X) and a negative speed drags
toward its left. Change `BeltSpeed` at runtime and the drag updates without a rebuild. The service
does not otherwise touch the part.

### Spawner — any `BasePart` tagged `BallSpawner`

| Attribute      | Type                 | Written if absent |
| -------------- | -------------------- | ----------------- |
| `Radius`       | number, studs        | 0.5               |
| `Enabled`      | boolean              | true              |
| `Rate`         | number, balls/second | 2                 |
| `KillY`        | number, world Y      | derived           |
| `MaxLiveBalls` | number               | 50                |

Anchor it and turn `CanCollide` off — it is only a locator. Balls spawn `Radius + 0.5` studs above
the part's origin, so the part's position is where balls appear.

`Enabled` defaults to **true**: tagging a spawner is the act of asking for balls. Untick it to
silence a spawner without untagging it — the manual trigger still works either way.

`KillY` is derived rather than picked: `Workspace.FallenPartsDestroyHeight + 2 * Radius`, i.e. one
ball diameter above the engine's own floor. That keeps this service's cull strictly ahead of the
engine's so the bookkeeping is cleaned deterministically, without deleting balls early.

Balls are `Part` spheres tagged `Ball`, created on the server only, and parented to a
`SpawnedBalls` folder in `Workspace`. The spawner itself is never reskinned or moved.

`KillY` is recorded per ball at spawn; with several spawners the effective cap is the smallest
`MaxLiveBalls`. Cleanup runs every 0.5 s, and the cap is also enforced synchronously on each spawn.

### Manual trigger

Press `1` on any client. The client fires `ReplicatedStorage.Remotes.SpawnBall`; the server
rate-limits to one accepted call per player per 100 ms and spawns exactly one ball from the first
registered spawner. Input is ignored when `gameProcessedEvent` is true, so typing into chat does not
spawn balls.

## Studio-only acceptance checks

`npm run build` proves the code compiles and nothing else. These can only be confirmed by running the
place with your own parts:

1. Put any unanchored part on the belt — it should be dragged off the +X edge in a couple of
   seconds. Set `BeltSpeed = 0` and it stays put.
2. Rotate the belt 90° in Studio — the drag direction rotates with it.
3. Press `1` — exactly one ball appears, on every client.
4. Hold `1` — balls appear at no more than 10/second.
5. Tag a spawner and do nothing else — balls stream at 2/second, replicated.
6. Let balls fall past `KillY`, and raise `Rate` past `MaxLiveBalls` — old balls go first, count
   never exceeds the cap.

## Deliberately absent

No belt speed ramp, no ball randomisation, no rounds or elimination, no camera or UI, no mesh
support, no client prediction, no currency.
