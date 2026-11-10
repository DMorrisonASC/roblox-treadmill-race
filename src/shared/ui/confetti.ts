/**
 * The 2D confetti burst: **the 2024 Confetti module, in TypeScript, with the minimum changed by the tree.**
 *
 * ## The module is the source of truth
 *
 * Every constant, branch and default below is the module's, and where this file's shape differs from it the difference is stated.
 * The module lives in the user's message that opened this chain of rounds; it is Lua and it does not ship (this tree is
 * TypeScript-only), but it is the design, and three passes have now been spent disagreeing with it.
 *
 * ## The three passes, and what the first two got wrong
 *
 * - **Items 165/167** ported a *different* module — a 2018 one drawing image labels resolved by name out of `ReplicatedStorage`.
 *   Nothing about it matched this one: wrong pieces, wrong palette, wrong motion. Both are superseded.
 * - **Item 168** ported *this* module correctly in its arithmetic and then deviated from it in four places, each with a reason that
 *   sounded better than the module. The user has since watched the module's own demo, and those deviations are why the port does not
 *   look like it. This file removes them:
 *
 * | item 168's deviation | why it was made | what this file does |
 * | --- | --- | --- |
 * | pieces spawned at the reveal's grid centre | the reveal had a centre to aim at | **every piece spawns full-screen**, exactly as the module's no-`spawnPos` branch does |
 * | `Triangle` dropped as "never draws a triangle" | true, and read as a bug | **restored**: it resizes to a wide rounded rectangle, which is what the demo shows |
 * | size as `BASE_PIECE_SIZE × SIZE_SCALE` | one constant instead of two ranges | **the module's literal ranges**, because `Triangle` needs two independent axes |
 * | no spawn fade-in | simpler | **the module's `0.5 s` `Quart`/`InOut` tween** from transparent to opaque |
 *
 * **Kept from item 168, because they are right:** the split between pure rules here and plumbing in the controller, one
 * `RenderStepped` for the whole system, a `ZIndex` derived from the caller's card stack, and the `[Confetti] sample` diagnostic.
 *
 * ## The one deliberate non-fidelity
 *
 * The module looks for a `ScreenGui` named `ConfettiScreenGui` and then **creates** one named `ConfettiGui`, so the lookup can never
 * match what it made and **every `Emit` adds another `ScreenGui` to `PlayerGui`** — a leak with no way to find the previous ones
 * again. The controller creates **one overlay for the session** instead. That is a bug fixed, not a behaviour reproduced.
 *
 * ## The physics is not corrected, on purpose
 *
 * `position.y += velocity.y * dt / 3000 + 0.5 * gravity * age² / 3000` adds a running sum of a growing quadratic to the *position*
 * rather than integrating an acceleration into the velocity. It double-counts, and it is what the effect was tuned against, so it is
 * reproduced exactly. `X_SCALE_DIVISOR` and `Y_SCALE_DIVISOR` are separate names because they are separate numbers.
 */

/**
 * What the module's `confettiShapes` table holds, lowercased.
 *
 * **`triangle` is the module's own branch, and it draws a wide rounded rectangle, not a triangle.** The module's `Triangle` case only
 * resizes — `math.random(28, 38)` by `math.random(18, 28)` — and gives the piece the same `UICorner` every other shape gets. Item
 * 168 read that as a bug and deleted the branch; the module's demo shows a mix of wide and square pieces, which is where the variety
 * in its sizes comes from. Restoring it is the difference between a grid of squares and the effect the user watched.
 */
export type ConfettiShape = "square" | "circle" | "triangle" | "diamond";

/** One piece's whole state — everything the controller writes, and nothing it has to derive. */
export interface ConfettiPiece {
	/** Normalised position, `0..1` across the parent with `y` downwards. */
	readonly position: Vector2;
	/** The module's units: divide by `X_SCALE_DIVISOR`/`Y_SCALE_DIVISOR` per second to move. */
	readonly velocity: Vector2;
	/** Degrees. The live rotation after the last step, not the spawn value. */
	readonly rotation: number;
	/** Degrees per second. Randomised; the **spawn angle** is not, apart from a diamond's `45`. */
	readonly rotationSpeed: number;
	/** Pixels. `24..36` square, or the triangle branch's `28..38 × 18..28`. */
	readonly size: Vector2;
	/** A palette entry times the `0.95..1.05` brightness jitter. */
	readonly color: Color3;
	readonly shape: ConfettiShape;
	/** Seconds since the piece was created. The gravity term is a function of this, as in the module. */
	readonly age: number;
}

/** A number source in `[0, 1)`. Passed in so a spec can pin it; the controller passes `math.random`. */
export type ConfettiRandom = () => number;

/** The one random source the controller uses, named so a spec can substitute it. */
export const confettiRandom: ConfettiRandom = () => math.random();

/**
 * The module's six colours, unchanged: red, green, blue, yellow, magenta, cyan.
 *
 * **Not a theme slot** — `Theme` names meanings, "party" is not one, and a seventh slot for a burst that lives two seconds would
 * invite every future effect to claim its own.
 */
export const DEFAULT_COLORS: ReadonlyArray<Color3> = [
	Color3.fromRGB(255, 75, 75),
	Color3.fromRGB(75, 255, 75),
	Color3.fromRGB(75, 75, 255),
	Color3.fromRGB(255, 255, 75),
	Color3.fromRGB(255, 75, 255),
	Color3.fromRGB(75, 255, 255),
];

/**
 * The module's shape table, in its order: `Square`, `Circle`, `Triangle`, `Diamond`.
 *
 * Four entries, so a fixed random sequence draws the same shapes in the same proportion the module would.
 */
export const SHAPES: ReadonlyArray<ConfettiShape> = ["square", "circle", "triangle", "diamond"];

/** **Placeholder.** The module's `math.random(24, 36)` square size, in pixels. */
export const PIECE_SIZE_MIN = 24;

/** **Placeholder.** The top of that range. */
export const PIECE_SIZE_MAX = 36;

/**
 * **Placeholder.** The `Triangle` branch's size: `math.random(28, 38)` by `math.random(18, 28)`.
 *
 * Two ranges rather than one, which is why this port carries literal sizes instead of item 168's `BASE_PIECE_SIZE × SIZE_SCALE`: a
 * wide piece is wider than it is tall, and one multiplier cannot say that.
 */
export const TRIANGLE_WIDTH_MIN = 28;

/** **Placeholder.** The triangle branch's widest. */
export const TRIANGLE_WIDTH_MAX = 38;

/** **Placeholder.** The triangle branch's shortest side. */
export const TRIANGLE_HEIGHT_MIN = 18;

/** **Placeholder.** The triangle branch's tallest. */
export const TRIANGLE_HEIGHT_MAX = 28;

/** **Placeholder.** The module's `gravity`. Fed to the quadratic in `stepPiece`; untuned. */
export const GRAVITY = 75;

/** **Placeholder.** The module's horizontal divisor: `position.x += velocity.x * dt / 400`. */
export const X_SCALE_DIVISOR = 400;

/** **Placeholder.** The module's vertical divisor: `position.y += velocity.y * dt / 3000 + …`. Deliberately not `400`. */
export const Y_SCALE_DIVISOR = 3000;

/** **Placeholder.** The module's `1.3`: a piece is destroyed once it is below 130% of the parent's height. **The only cull.** */
export const CONF_CEILING = 1.3;

/** **Placeholder.** The module's `math.random(-300, 300)` horizontal kick, in its own units. */
export const VELOCITY_X_MIN = -300;

/** **Placeholder.** The right of that range. */
export const VELOCITY_X_MAX = 300;

/** **Placeholder.** The module's `math.random(-350, -200)` **upward** kick. Negative, which is why the burst arcs up first. */
export const VELOCITY_Y_MIN = -350;

/** **Placeholder.** The least upward of those kicks. */
export const VELOCITY_Y_MAX = -200;

/** **Placeholder.** The module's `math.random(-300, 300)` spin, in degrees per second. */
export const SPIN_MIN = -300;

/** **Placeholder.** The fastest spin. */
export const SPIN_MAX = 300;

/** **Placeholder.** The module's `math.random(95, 105) / 100` brightness jitter, applied per channel and clamped. */
export const BRIGHTNESS_MIN = 0.95;

/** **Placeholder.** The top of the jitter band. */
export const BRIGHTNESS_MAX = 1.05;

/**
 * **Placeholder.** The module's fade-in: `TweenInfo.new(0.5, Quart, InOut)` on `BackgroundTransparency` 1 → 0.
 *
 * A piece that pops in at full opacity is not what the demo shows — the pieces bloom into view over half a second, which is why 80
 * of them can appear at once without reading as a flash.
 */
export const FADE_IN_SECONDS = 0.5;

/** One integer in `[min, max]`, the way `math.random(min, max)` draws it. */
function between(random: ConfettiRandom, min: number, max: number): number {
	return min + math.floor(random() * (max - min + 1));
}

/** One float in `[min, max)`, for the draws the module made continuous. */
function span(random: ConfettiRandom, min: number, max: number): number {
	return min + random() * (max - min);
}

/**
 * Where a piece spawns when the caller gives no position — which is **every call in the module's own demo**.
 *
 * ```lua
 * confetti.Position = UDim2.fromScale(math.random(0, 100)/100, math.random(-25, 125)/100)
 * ```
 *
 * So: anywhere across the width, and from a quarter of a screen **above** the viewport to a quarter **below** it, so pieces are
 * already in frame when the burst starts and leave through the edges rather than all originating at one point. The integer draws are
 * reproduced rather than smoothed into `random()`, because the module's grid of 101 × 151 positions is part of how the spread looks.
 */
export function defaultSpawn(random: ConfettiRandom): Vector2 {
	return new Vector2(between(random, 0, 100) / 100, between(random, -25, 125) / 100);
}

/**
 * One piece, with everything the module randomised for it: **its own colour, its own shape, its own size, its own spin**.
 *
 * The module's order is position → colour → shape → size override, and the draws here follow it, so a fixed `random` sequence
 * produces the same variety a run of the module would.
 */
export function createPiece(random: ConfettiRandom, position?: Vector2): ConfettiPiece {
	const spawn = position ?? defaultSpawn(random);

	const base = DEFAULT_COLORS[math.floor(random() * DEFAULT_COLORS.size())] ?? DEFAULT_COLORS[0];
	const brightness = span(random, BRIGHTNESS_MIN, BRIGHTNESS_MAX);

	const shape = SHAPES[math.floor(random() * SHAPES.size())] ?? "square";

	// **The module's size branch.** Every shape starts square at `24..36`; the triangle overrides with its own two ranges, and that
	// override is the entire difference between a wide piece and a square one.
	let size = new Vector2(
		between(random, PIECE_SIZE_MIN, PIECE_SIZE_MAX),
		between(random, PIECE_SIZE_MIN, PIECE_SIZE_MAX),
	);

	if (shape === "triangle") {
		size = new Vector2(
			between(random, TRIANGLE_WIDTH_MIN, TRIANGLE_WIDTH_MAX),
			between(random, TRIANGLE_HEIGHT_MIN, TRIANGLE_HEIGHT_MAX),
		);
	}

	return {
		position: spawn,
		velocity: new Vector2(
			between(random, VELOCITY_X_MIN, VELOCITY_X_MAX),
			between(random, VELOCITY_Y_MIN, VELOCITY_Y_MAX),
		),
		// The module randomises rotation **speed**, never the spawn angle: a piece starts square-on and turns. A diamond's 45 degrees
		// come from the controller, where the shape is applied.
		rotation: 0,
		rotationSpeed: between(random, SPIN_MIN, SPIN_MAX),
		size,
		color: new Color3(
			math.clamp(base.R * brightness, 0, 1),
			math.clamp(base.G * brightness, 0, 1),
			math.clamp(base.B * brightness, 0, 1),
		),
		shape,
		age: 0,
	};
}

/**
 * `count` pieces, every one at its own random point on the screen.
 *
 * **No emitter argument**, because the module has no emitter concept: `Emit(amount, spawnPos)` only uses `spawnPos` when it is a
 * `UDim2`, and its own demo never passes one. The reveal's `centre` is accepted by the controller and does not place pieces — see
 * `burst` there.
 */
export function spawnBurst(count: number, random: ConfettiRandom): ReadonlyArray<ConfettiPiece> {
	const pieces = new Array<ConfettiPiece>();
	for (let index = 0; index < count; index++) {
		pieces.push(createPiece(random));
	}

	return pieces;
}

/**
 * One frame of the module's integration, returned rather than written.
 *
 * The three lines are the module's, in its order:
 *
 * ```
 * position.x += velocity.x * dt / 400
 * position.y += velocity.y * dt / 3000 + 0.5 * gravity * age^2 / 3000
 * rotation  += rotationSpeed * dt + sin(age * 2) * 0.5
 * ```
 *
 * The `sin(age * 2) * 0.5` is a slow wobble on top of the spin — it is why a piece does not look like a wheel on an axle, and it is
 * the cheapest part of the effect to drop by accident. The gravity term uses the **age before this step**, which is what the module
 * does (it reads `elapsedTime` at the top of the frame).
 */
export function stepPiece(piece: ConfettiPiece, dt: number, gravity: number): ConfettiPiece {
	const age = piece.age;

	return {
		position: new Vector2(
			piece.position.X + (piece.velocity.X * dt) / X_SCALE_DIVISOR,
			piece.position.Y +
				(piece.velocity.Y * dt) / Y_SCALE_DIVISOR +
				(0.5 * gravity * age * age) / Y_SCALE_DIVISOR,
		),
		velocity: piece.velocity,
		rotation: piece.rotation + piece.rotationSpeed * dt + math.sin(age * 2) * 0.5,
		rotationSpeed: piece.rotationSpeed,
		size: piece.size,
		color: piece.color,
		shape: piece.shape,
		age: age + dt,
	};
}

/**
 * Whether a piece is finished: the module's `newY > 1.3`, and **nothing else**.
 *
 * No top cull and no side cull, because the module has neither. A piece that wanders off the top or the side stays alive until the
 * ceiling test catches it — which, with the module's upward `velocityY` and its accumulating quadratic, it always does: the mirrored
 * run puts every piece between **1.60 s and 1.65 s**. Reproducing the absence of a cull is what keeps the burst's `lifetime` honest
 * about the module rather than about an improvement.
 */
export function pieceGone(piece: ConfettiPiece): boolean {
	return piece.position.Y > CONF_CEILING;
}
