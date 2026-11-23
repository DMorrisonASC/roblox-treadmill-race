/**
 * The model table: which template, if any, a ball id is drawn with — keyed by the same ball ids `BALL_POOL` and
 * `powers.config.ts` use.
 *
 * ## Why this exists at all
 *
 * Because the alternative is that the model swap happens in `spawnBall` with nothing to cross-check it against. A ball id
 * can already be added to `BALL_POOL` and forgotten in `powers.config.ts` with no failure anywhere; forgetting it here
 * would be the same omission and, unlike a missing power, a missing model is *invisible* — the body still spawns, still
 * races, and simply looks like every other ball. A table whose entries all resolve turns "this ball has no model" from a
 * thing somebody notices in a Studio session into a thing the suite refuses to accept.
 *
 * ## The naming asymmetry, and why it is not a mistake to "fix"
 *
 * **A ball id is `snake_case`; its template is `camelCase`.** `bully_ball` races as the template `bullyBall`. The two
 * vocabularies are separated on purpose and neither is going to be normalised:
 *
 * - **The ball id is data.** It is persisted in player profiles (`OwnedBalls`, `ChosenBallId`), written into attributes,
 *   sent over remotes and compared in string equality across the client and the server. `BALL_ID_RENAMES` in
 *   `economy.config.ts` exists precisely because renaming one costs a profile migration, so the ids are as close to
 *   immutable as anything in this tree gets.
 * - **The template name is an Instance name in `ServerStorage`.** It is authored by hand in Studio, it appears in the
 *   Explorer, and Roblox's own convention for instance names is `camelCase` — the same convention this tree already uses
 *   for every other child it names (`BallPhantom`, `BeltSurface`, `NorthPole`).
 *
 * So a `snake_case` id pointing at a `camelCase` name is the join between a data key and an art asset, and a reader who
 * "normalises" either side breaks something real: renaming the id orphans every profile that owns the ball, and renaming
 * the template silently un-draws every ball of that kind (the spawner warns, the game carries on, and the art is simply
 * missing). **Change this table if a template is renamed; never change a ball id to match one.**
 *
 * ## Why the lookup is a string and the template is an instance
 *
 * This file is **shared** — it compiles into `ReplicatedStorage.TS`, so a client can read it. The templates are
 * `BasePart`s in **`ServerStorage`**, which does not replicate at all. That split is expressed by what this file is allowed
 * to contain: **names, never instances.** A `Record<string, BasePart>` here would be a client-side read of a container the
 * client does not have, which returns `nil` quietly on every device — the exact failure mode a config is supposed to make
 * impossible. The instance lookup lives in `BallSpawnerService` (`attachBallModel`), on the server, at spawn, and this
 * module stays a pure table of strings that both sides can import without touching a container.
 *
 * ## Why it is not part of `shape-pool.ts`
 *
 * Item 12's pool describes a **shape** — `Part.Shape`, `Part.Size` — and every ball currently draws the same sphere. A
 * model is a property of a ball *id*, not of a silhouette: two ids can share a shape and differ in mesh, and the sphere
 * pool has no key to hang one on. Wiring the two together would re-couple exactly what item 12 separated.
 *
 * ## Why an interface and not `string | undefined`
 *
 * A single name is already not the whole story: a template needs a size or a scale, often an attachment point, and a
 * loader needs to know whether it replaces the `Part` or hangs a `SpecialMesh` inside it. As an interface those arrive as
 * new fields and every entry, every accessor and every caller keeps compiling. As a bare string they would arrive as a
 * second table (`BALL_MODEL_SCALES`, `BALL_MODEL_OFFSETS`) keyed by the same ids — which is the drift
 * `powers.config.ts` exists to prevent, one file over.
 */

/**
 * Where the templates live, as a child of `ServerStorage`.
 *
 * **Not a `Placeholder.`** — this is a contract with the scene, not a tuned number: somebody has to author the folder with
 * exactly this name for the feature to draw anything. The spawner looks the folder up **once, at boot**, and warns loudly
 * naming the path and the names it expected if it is absent, because the alternative (silently drawing spheres) is
 * indistinguishable from a round that did not ship.
 *
 * It lives here rather than in the spawner because it is part of what this table *means*: these names are children of that
 * folder, and a reader holding one without the other has half the picture.
 */
export const BALL_MODEL_FOLDER_NAME = "BallModels";

/**
 * What a ball is drawn with.
 *
 * **Every field is optional and every field is `**Placeholder.**`**, so a model can grow a size override or an attachment
 * without a type change — and so "no model yet" needs no sentinel: an entry whose `model` is `undefined` is a ball that
 * draws its `Part` sphere.
 */
export interface BallModel {
	/**
	 * The template's name inside `ServerStorage.BallModels` — the `camelCase` form of the ball id.
	 *
	 * **Not a `Placeholder.`**: it is an authored Instance name, and the spec asserts it is the camelCase of the id it
	 * belongs to, so a typo fails the suite rather than quietly drawing a sphere.
	 */
	readonly templateName: string;
}

/** One ball id's model, or `undefined` for a ball that is still just its sphere. */
export interface BallModelEntry {
	readonly ballId: string;
	readonly model: BallModel | undefined;
}

/**
 * **The table.** Ten entries, one per `BALL_POOL` id, each naming its `camelCase` template.
 *
 * Order matches `BALL_POOL` and `POWERS` so the three files can be read side by side; nothing depends on it.
 *
 * **Every value is a name today, and the table's job is to be *complete*** — one entry per ball, no entry for a ball that
 * does not exist — so the cross-validation test in `src/shared/ball-tables.spec.ts` has something to iterate. That test is
 * what makes a missing model loud: it asserts every pool id resolves to a template name, so an id added to `BALL_POOL` and
 * forgotten here fails the suite rather than shipping a ball that looks like every other ball.
 *
 * **`undefined` is still a legal value** and is kept deliberately: "described, but unmodelled" is a real state for a ball
 * added to the pool before its art exists, and it is a different fact from "not described at all" (a mistake). The
 * accessor below collapses both to `undefined`, because at spawn they mean the same thing — draw the sphere — and the spec
 * is what keeps them distinguishable.
 */
export const BALL_MODELS: ReadonlyArray<BallModelEntry> = [
	{ ballId: "bully_ball", model: { templateName: "bullyBall" } },
	{ ballId: "bouncy_ball", model: { templateName: "bouncyBall" } },
	{ ballId: "ghost_ball", model: { templateName: "ghostBall" } },
	{ ballId: "heavy_ball", model: { templateName: "heavyBall" } },
	{ ballId: "decoy_ball", model: { templateName: "decoyBall" } },
	{ ballId: "magnet_ball", model: { templateName: "magnetBall" } },
	{ ballId: "rocket_ball", model: { templateName: "rocketBall" } },
	{ ballId: "recycle_ball", model: { templateName: "recycleBall" } },
	{ ballId: "eclipse_ball", model: { templateName: "eclipseBall" } },
	{ ballId: "sprinter_ball", model: { templateName: "sprinterBall" } },
];

/**
 * The table entry for a ball id, or `undefined` for an id the table does not describe.
 *
 * `undefined` is a real answer and has to stay distinguishable from "described, but unmodelled": the first is a ball
 * somebody forgot to add, the second is an ordinary ball. Callers read `.model` from the entry for the second question.
 */
export function modelEntryForBallId(ballId: string): BallModelEntry | undefined {
	for (const entry of BALL_MODELS) {
		if (entry.ballId === ballId) {
			return entry;
		}
	}

	return undefined;
}

/**
 * The name of the template a ball id is drawn with, or `undefined` for a ball that draws its sphere.
 *
 * **Two states answer `undefined`, and that is intentional.** An id the table does not describe and an id whose entry has
 * no model both mean "spawn the ordinary body" to the spawner, which is the only caller — and a spawn path that had to
 * distinguish them would be answering a question the suite already answers: `ball-tables.spec.ts` asserts every pool id
 * resolves to a name, so the only way to reach this function with an unaddressed id is a body whose chosen id is not in
 * the pool at all.
 *
 * **`undefined` rather than a default template**, for `colorForBall`'s reason: a function that answered "the first
 * template" or "the placeholder mesh" would make a missing entry indistinguishable from a working one, and the failure
 * would be a ball wearing somebody else's art instead of a ball that honestly has none.
 */
export function modelTemplateNameFor(ballId: string): string | undefined {
	const entry = modelEntryForBallId(ballId);

	return entry === undefined || entry.model === undefined ? undefined : entry.model.templateName;
}
