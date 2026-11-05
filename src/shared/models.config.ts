/**
 * The model table: which mesh, if any, a ball id is drawn with — keyed by the same ball ids `BALL_POOL` and
 * `powers.config.ts` use.
 *
 * ## Why this exists when every value is `undefined`
 *
 * Because the alternative is that the model swap happens in `spawnBall` with nothing to cross-check it against. A ball id
 * can already be added to `BALL_POOL` and forgotten in `powers.config.ts` with no failure anywhere; forgetting it here
 * would be the same omission and, unlike a missing power, a missing model is *invisible* — the body still spawns, still
 * races, and simply looks like every other ball. A table whose entries all resolve turns "this ball has no model" from a
 * thing somebody notices in a Studio session into a thing the suite refuses to accept.
 *
 * **Nothing reads this.** It is deliberately not wired into `BallSpawnerService.spawnBall`: a table that nothing reads is
 * a declaration, and wiring it now would invent a model-loading system in a round that is not about one. The swap is a
 * later round's job, and this file is where it starts.
 *
 * ## Why it is not part of `shape-pool.ts`
 *
 * Item 12's pool describes a **shape** — `Part.Shape`, `Part.Size` — and every ball currently draws the same sphere. A
 * model is a property of a ball *id*, not of a silhouette: two ids can share a shape and differ in mesh, and the sphere
 * pool has no key to hang one on. Wiring the two together would re-couple exactly what item 12 separated.
 *
 * ## Why an interface and not `string | undefined`
 *
 * A single `assetId` field is already not the whole story: a mesh needs a size or a scale, often an attachment point, and
 * a loader needs to know whether it replaces the `Part` or hangs a `SpecialMesh` inside it. As an interface those arrive
 * as new fields and every entry, every accessor and every caller keeps compiling. As a bare string they would arrive as a
 * second table (`BALL_MODEL_SCALES`, `BALL_MODEL_OFFSETS`) keyed by the same ids — which is the drift `powers.config.ts`
 * exists to prevent, one file over.
 */

/**
 * What a ball is drawn with.
 *
 * **Every field is `**Placeholder.**` and every field is optional**, so "no model yet" needs no sentinel: an entry whose
 * `model` is `undefined` is a ball that draws its `Part` sphere, which is what all ten do today.
 */
export interface BallModel {
	/** **Placeholder.** The mesh asset, as `rbxassetid://<id>`. Absent means the `Part` sphere is the model. */
	readonly assetId?: string;
}

/** One ball id's model, or `undefined` for a ball that is still just its sphere. */
export interface BallModelEntry {
	readonly ballId: string;
	readonly model: BallModel | undefined;
}

/**
 * **The table.** Ten entries, one per `BALL_POOL` id, every model `undefined`.
 *
 * Order matches `BALL_POOL` and `POWERS` so the three files can be read side by side; nothing depends on it.
 *
 * **Every value is `undefined` today, and that is the shipped state of the feature, not an oversight.** The table's job in
 * this round is to be *complete* — one entry per ball, no entry for a ball that does not exist — so the cross-validation
 * test in `src/shared/ball-tables.spec.ts` has something to iterate and the next round has somewhere to write.
 */
export const BALL_MODELS: ReadonlyArray<BallModelEntry> = [
	{ ballId: "bully_ball", model: undefined },
	{ ballId: "bouncy_ball", model: undefined },
	{ ballId: "ghost_ball", model: undefined },
	{ ballId: "heavy_ball", model: undefined },
	{ ballId: "decoy_ball", model: undefined },
	{ ballId: "magnet_ball", model: undefined },
	{ ballId: "rocket_ball", model: undefined },
	{ ballId: "recycle_ball", model: undefined },
	{ ballId: "eclipse_ball", model: undefined },
	{ ballId: "sprinter_ball", model: undefined },
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
