import { defineConfig } from "@isentinel/jest-roblox";

/**
 * `npm test` — the suite as a command, not as a command-bar snippet.
 *
 * ## Why this replaced the in-Studio runner
 *
 * The previous arrangement required a person to open Studio, set the command bar to `Server`, and require a module by
 * hand. That is a test suite nobody runs, and one that reports nothing a machine can read. `@isentinel/jest-roblox`
 * builds the place, launches Studio headless, drives its installed plugin, reads the result and quits — so the same
 * assertions run from `cmd` and exit non-zero on failure.
 *
 * ## Why `studio-cli` and not `studio`
 *
 * `"studio-cli"` launches **its own** Studio via `--task RunScript` and quits it, so an already-open Studio window is
 * irrelevant — **you do not need to close Studio before `npm test`.** `"studio"` attaches to a running instance and
 * would. Since the whole point is a command a machine (or a person in a hurry) can run, the isolated backend is the
 * right default. Pass `--headed` when a run needs watching.
 *
 * ## Why `projects` is under `test:` and not at the top level
 *
 * `Config` has no `projects` key; it lives in `SharedTestConfig`, which is reached through `test:`. Each entry is a
 * DataModel path string or an inline project. The inline form is used here because it pins the two mounts explicitly
 * rather than relying on discovery order:
 *
 * - `out/shared` is mounted at **`ReplicatedStorage.TS`** by `default.project.json`, so the two specs that live in
 *   `src/shared` compile to `out/shared/*.spec.luau` and land there.
 * - `out/server` is mounted at **`ServerScriptService.TS`**, so `src/server/services/economy-service.spec.ts` lands at
 *   `ServerScriptService.TS.services.economy-service.spec`.
 *
 * `outDir` is the **compiled** directory, not `src` — roblox-ts emitters must point at what Luau actually sees.
 *
 * ## The place file
 *
 * `build/game.rbxlx` is a Rojo build of this project and is generated, not committed (`build/` is in `.gitignore`).
 * **It must be rebuilt after any source change**, because the spec modules have to be inside the place the runner
 * launches:
 *
 * ```
 * npm run build && npm run build:place && npm test
 * ```
 *
 * ## Timeout
 *
 * `timeout` is the budget for Roblox to run the script, not for the Studio launch. The platform default is 300000 ms;
 * 60000 ms is plenty for this suite and fails faster when something is genuinely stuck. Raise it if the place grows a
 * slow setup step.
 */
export default defineConfig({
	backend: "studio-cli",
	placeFile: "build/game.rbxlx",
	// Where the Jest runtime actually is. Discovery walks `ReplicatedStorage` for an instance *named* `Jest`, and
	// none of the packages this tree installs is named that — `@rbxts/jest` is a one-line re-export of
	// `@rbxts-js/jest`, and Rojo mounts both as lowercase folders. Naming the module explicitly is the difference
	// between "the runner found Jest" and a boot that fails before a single test is collected.
	jestPath: "ReplicatedStorage/rbxts_include/node_modules/@rbxts-js/Jest",
	test: {
		projects: [
			{
				test: {
					displayName: "shared",
					include: ["src/shared/**/*.spec.ts"],
					outDir: "out/shared",
				},
			},
			{
				test: {
					displayName: "server",
					include: ["src/server/**/*.spec.ts"],
					outDir: "out/server",
				},
			},
		],
	},
	timeout: 60000,
});
