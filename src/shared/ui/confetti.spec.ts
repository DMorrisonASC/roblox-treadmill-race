import { describe, expect, it } from "@rbxts/jest-globals";
import {
	ConfettiPiece,
	ConfettiRandom,
	createPiece,
	DEFAULT_COLORS,
	GRAVITY,
	PIECE_SIZE_MAX,
	PIECE_SIZE_MIN,
	pieceGone,
	SHAPES,
	spawnBurst,
	stepPiece,
	TRIANGLE_HEIGHT_MAX,
	TRIANGLE_HEIGHT_MIN,
	TRIANGLE_WIDTH_MAX,
	TRIANGLE_WIDTH_MIN,
	X_SCALE_DIVISOR,
	Y_SCALE_DIVISOR,
} from "./confetti";

/**
 * The confetti rules: **the module's own numbers, and the two draws that make a burst look like a burst.**
 *
 * ## Why these assertions and not the look
 *
 * Three rounds have now been spent on this effect, and the last two were diagnosed entirely from a screenshot and a log. What can be
 * asserted is the arithmetic and the random draws, and every one of them fails *silently* in a port:
 *
 * - a burst in one colour still looks like a burst, which is what the module shipped (its gradient overlay covered all six);
 * - a burst in one shape still looks like a burst, and item 168 dropped the fourth shape that the demo's size variety comes from;
 * - a size outside the module's range is a piece nobody chose — item 167's failure, one layer down;
 * - a spawn that is not across the screen is a plume where the module has a snowfall, which is the deviation this round removed;
 * - and a `pieceGone` that fires early cuts the effect off, while one that never fires leaves frames in the overlay for the session.
 */

/** A random source that walks a fixed list and repeats — deterministic, and different on every draw within a cycle. */
function sequence(values: ReadonlyArray<number>): ConfettiRandom {
	let index = 0;
	return () => {
		const value = values[index % values.size()];
		index++;
		return value;
	};
}

/** Five values that all differ, so consecutive draws land on different palette entries and different shapes. */
const WALKING_RANDOM = sequence([0, 0.5, 0.99, 0.17, 0.71]);

/**
 * A deterministic pseudo-random source, for the assertions about a **distribution**.
 *
 * **A cycling list is the wrong tool for those**, and this is not hypothetical: `createPiece` draws seven values per piece, so a
 * five-value cycle advances the phase by two each time and a fixed list can land every piece on the same shape. A mirrored run of the
 * cycling source produced twelve triangles in a row. A small LCG gives a spread that is still reproducible, so "all four shapes appear
 * in a burst of 80" can be asserted without leaning on the real `math.random`.
 *
 * The multiplier is `4891` rather than the usual `1103515245` because Luau numbers are doubles: `state * 1103515245` overflows 2^53
 * for a 31-bit state and the sequence collapses.
 */
function seeded(seed: number): ConfettiRandom {
	let state = seed;
	return () => {
		state = (state * 4891 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

const EMITTER = new Vector2(0.5, 0.4);

describe("createPiece", () => {
	it("draws its colour from the module's six", () => {
		// The brightness jitter moves every channel by up to 5%, so a palette match is only exact at brightness 1; the assertion is
		// "close to one of the six", which is what the drawn colour has to be.
		for (let index = 0; index < 24; index++) {
			const piece = createPiece(sequence([index / 24, 0.5, 0.5]), EMITTER);

			let nearest = 1;
			for (const colour of DEFAULT_COLORS) {
				nearest = math.min(
					nearest,
					math.abs(colour.R - piece.color.R) +
						math.abs(colour.G - piece.color.G) +
						math.abs(colour.B - piece.color.B),
				);
			}

			expect(nearest < 0.2).toBe(true);
		}

		expect(DEFAULT_COLORS.size()).toBe(6);
	});

	it("spawns across the whole screen when no position is given", () => {
		// **The deviation this round removes.** The module's no-`spawnPos` branch spreads pieces over the width and from a quarter of a
		// screen above to a quarter below, and the demo's look is that spread. Item 168 aimed everything at one point.
		const xs = new Array<number>();

		for (let index = 0; index < 24; index++) {
			const piece = createPiece(sequence([index / 24, 0.31, 0.77, 0.5, 0.9]));

			expect(piece.position.X >= 0 && piece.position.X <= 1).toBe(true);
			expect(piece.position.Y >= -0.25 && piece.position.Y <= 1.25).toBe(true);

			xs.push(piece.position.X);
		}

		// Stated as the property that matters: the spread is not a point on the axis the camera reads first.
		let minX = 2;
		let maxX = -1;
		for (const x of xs) {
			minX = math.min(minX, x);
			maxX = math.max(maxX, x);
		}

		expect(maxX - minX > 0.5).toBe(true);
	});

	it("keeps every piece inside the module's size ranges", () => {
		// Item 167's failure expressed as a value: the size was replaced by a constant the piece never asked for. Here a square is
		// `24..36` on both axes and a triangle is the module's two ranges — no third possibility.
		const random = seeded(20261109);
		for (let index = 0; index < 80; index++) {
			const piece = createPiece(random, EMITTER);

			if (piece.shape === "triangle") {
				expect(piece.size.X >= TRIANGLE_WIDTH_MIN && piece.size.X <= TRIANGLE_WIDTH_MAX).toBe(true);
				expect(piece.size.Y >= TRIANGLE_HEIGHT_MIN && piece.size.Y <= TRIANGLE_HEIGHT_MAX).toBe(true);
			} else {
				expect(piece.size.X >= PIECE_SIZE_MIN && piece.size.X <= PIECE_SIZE_MAX).toBe(true);
				expect(piece.size.Y >= PIECE_SIZE_MIN && piece.size.Y <= PIECE_SIZE_MAX).toBe(true);
			}
		}
	});

	it("draws a triangle that is wider than it is tall", () => {
		// The module's `Triangle` branch resizes to `28..38` by `18..28` — **a wide rectangle, not a triangle** — and that shape is where
		// the demo's size variety comes from. A piece from that branch must never be taller than it is wide.
		let checked = 0;
		for (let index = 0; index < 60; index++) {
			const piece = createPiece(sequence([0, 0.5, 0.62, 0.5, 0.2]), EMITTER);
			if (piece.shape !== "triangle") {
				continue;
			}

			checked++;
			expect(piece.size.X > piece.size.Y).toBe(true);
		}

		// The sequence above lands on the triangle entry of a four-shape table; if that ever stops being true this fails loudly rather
		// than passing on zero checks.
		expect(checked > 0).toBe(true);
	});

	it("starts every piece square-on, with a speed rather than an angle", () => {
		const piece = createPiece(WALKING_RANDOM, EMITTER);

		expect(piece.rotation).toBe(0);
		expect(piece.age).toBe(0);
	});
});

describe("spawnBurst", () => {
	it("returns the requested count, scattered rather than aimed", () => {
		const pieces = spawnBurst(80, seeded(20261109));

		expect(pieces.size()).toBe(80);

		const firstX = pieces[0].position.X;
		let differs = false;
		for (const piece of pieces) {
			if (piece.position.X !== firstX) {
				differs = true;
			}
		}

		expect(differs).toBe(true);
	});

	it("draws more than one colour from one burst", () => {
		// The module's palette was six colours and its gradient covered them, so a monochrome burst is not hypothetical — it is what
		// shipped. The spec did not test this before item 168.
		const pieces = spawnBurst(80, seeded(20261109));

		const seen = new Array<Color3>();
		for (const piece of pieces) {
			let known = false;
			for (const colour of seen) {
				if (colour.R === piece.color.R && colour.G === piece.color.G && colour.B === piece.color.B) {
					known = true;
				}
			}

			if (!known) {
				seen.push(piece.color);
			}
		}

		expect(seen.size() > 1).toBe(true);
	});

	it("draws all four of the module's shapes from one burst", () => {
		// **Four, not three.** Item 168 dropped the triangle branch and the demo's wide pieces went with it, so the count is asserted
		// against the module's table rather than against "more than one".
		const pieces = spawnBurst(80, seeded(20261109));

		const seen = new Array<string>();
		for (const piece of pieces) {
			let known = false;
			for (const shape of seen) {
				if (shape === piece.shape) {
					known = true;
				}
			}

			if (!known) {
				seen.push(piece.shape);
			}
		}

		expect(seen.size()).toBe(SHAPES.size());
		expect(SHAPES.size()).toBe(4);
	});
});

describe("stepPiece", () => {
	const dt = 1 / 60;

	function pieceAt(y: number, vy: number): ConfettiPiece {
		return {
			position: new Vector2(0.5, y),
			velocity: new Vector2(0, vy),
			rotation: 0,
			rotationSpeed: 0,
			size: new Vector2(30, 30),
			color: DEFAULT_COLORS[0],
			shape: "square",
			age: 0,
		};
	}

	it("moves linearly with no gravity", () => {
		const first = stepPiece(pieceAt(0.5, -300), dt, 0);
		const second = stepPiece(first, dt, 0);

		const firstStep = first.position.Y - 0.5;
		const secondStep = second.position.Y - first.position.Y;

		expect(math.abs(firstStep - secondStep) < 1e-9).toBe(true);
		expect(firstStep < 0).toBe(true);
	});

	it("adds a downward term that grows with age once gravity is on", () => {
		// The module's quadratic is added to the *position*, not to a velocity, so the honest assertion is that the per-step delta grows
		// from one step to the next — the term it adds is a function of `age²`.
		const first = stepPiece(pieceAt(0.5, -300), dt, GRAVITY);
		const second = stepPiece(first, dt, GRAVITY);

		expect(second.position.Y - first.position.Y > first.position.Y - 0.5).toBe(true);
	});

	it("turns a piece at its own speed, plus the wobble", () => {
		const spinning: ConfettiPiece = {
			position: new Vector2(0.5, 0.5),
			velocity: new Vector2(0, 0),
			rotation: 0,
			rotationSpeed: 300,
			size: new Vector2(30, 30),
			color: DEFAULT_COLORS[0],
			shape: "square",
			age: 0,
		};

		const turned = stepPiece(spinning, dt, 0);

		// 300 degrees per second over one sixtieth is 5 degrees, and the wobble is `sin(0) * 0.5 = 0` on the first step — so the first
		// step is the clean one to assert the speed against.
		expect(math.abs(turned.rotation - 300 * dt) < 1e-9).toBe(true);
		expect(turned.age > 0).toBe(true);
	});

	it("uses two different divisors on the two axes", () => {
		const moving: ConfettiPiece = {
			position: new Vector2(0.5, 0.5),
			velocity: new Vector2(300, 0),
			rotation: 0,
			rotationSpeed: 0,
			size: new Vector2(30, 30),
			color: DEFAULT_COLORS[0],
			shape: "square",
			age: 0,
		};

		const moved = stepPiece(moving, 1, 0).position.X - 0.5;

		expect(math.abs(moved - 300 / X_SCALE_DIVISOR) < 1e-9).toBe(true);
		// Stated as the ratio, because the two constants are literal types and a direct comparison is a type error rather than a test.
		expect(Y_SCALE_DIVISOR / X_SCALE_DIVISOR > 1).toBe(true);
	});
});

describe("pieceGone", () => {
	const base: ConfettiPiece = {
		position: new Vector2(0.5, 1),
		velocity: new Vector2(0, 0),
		rotation: 0,
		rotationSpeed: 0,
		size: new Vector2(30, 30),
		color: DEFAULT_COLORS[0],
		shape: "square",
		age: 0,
	};

	it("is false while the piece is on screen", () => {
		expect(pieceGone({ ...base, position: new Vector2(0.5, 1) })).toBe(false);
		expect(pieceGone({ ...base, position: new Vector2(0.5, 0.2) })).toBe(false);
	});

	it("is false above the top, because the module has no top cull", () => {
		// The module destroys on `newY > 1.3` and nothing else. A piece that leaves through the top is left alive, and the ceiling test
		// catches it when the accumulating quadratic brings it back — which the mirrored run says it always does.
		expect(pieceGone({ ...base, position: new Vector2(0.5, -0.4) })).toBe(false);
	});

	it("is true once the piece is past the ceiling", () => {
		// Both sides of the boundary, so an off-by-one in the comparison fails here.
		expect(pieceGone({ ...base, position: new Vector2(0.5, 1.3) })).toBe(false);
		expect(pieceGone({ ...base, position: new Vector2(0.5, 1.31) })).toBe(true);
	});
});
