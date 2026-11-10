import { describe, expect, it } from "@rbxts/jest-globals";
import { MIN_PANEL_SCALE, panelScaleFor } from "./ui-scale";

/**
 * The composition rule: **one uniform multiplier, chosen so the whole panel fits the screen, never above its design size.**
 *
 * ## Why this is worth a spec and the pixels are not
 *
 * Whether 880 pixels of store looks right is a judgement only a screenshot can make. What can be asserted is the arithmetic
 * around it, and it fails silently in four ways none of which throws: a scale of `0` on a minimised window makes every panel
 * vanish; a scale above `1` on a 4K monitor invents a second design; taking the *larger* axis looks perfect on every desktop
 * and drops the bottom off every landscape phone; and scaling the axes independently squashes the sheet and re-flows every
 * band inside it — which is the "you rearranged it" bug this round exists to prevent, arriving by arithmetic rather than by a
 * breakpoint.
 *
 * The design sizes below are the real ones: the store is 880 × 466, the picker 640 × n, a toast 240 × 52.
 */

const STORE_DESIGN = new Vector2(880, 466);
const PICKER_DESIGN = new Vector2(640, 404);
const TOAST_DESIGN = new Vector2(240, 52);

describe("panelScaleFor", () => {
	it("is exactly 1 on a desktop, so nothing on the reference machine moves", () => {
		// **The regression this round must not cause.** Every tuned pixel and every screenshot was taken on a 1920-wide screen.
		// `1920 * 0.92 = 1766` and `1080 * 0.9 = 972`, both well above the store's own size, so the answer is the design size and
		// the desktop renders byte-identically.
		expect(panelScaleFor(new Vector2(1920, 1080), STORE_DESIGN)).toBe(1);
		expect(panelScaleFor(new Vector2(2560, 1440), STORE_DESIGN)).toBe(1);
		expect(panelScaleFor(new Vector2(3840, 2160), TOAST_DESIGN)).toBe(1);
	});

	it("fits a landscape phone by the height, because that is the axis that binds", () => {
		// A 844 × 390 phone is wide and short: `844 * 0.92 / 880 = 0.88` by width but `390 * 0.9 / 466 = 0.75` by height. Taking the
		// width would draw a 774 × 410 store through a 390-pixel-tall window — cut off, which is the reported bug in one dimension.
		expect(math.abs(panelScaleFor(new Vector2(844, 390), STORE_DESIGN) - (390 * 0.9) / 466) < 1e-6).toBe(true);

		// Stated as the comparison it is, so an inverted `min` fails here even if the fraction above is retuned.
		expect(panelScaleFor(new Vector2(844, 390), STORE_DESIGN) < (844 * 0.92) / 880).toBe(true);
	});

	it("fits a portrait phone by the width", () => {
		// The same phone turned upright: `390 * 0.92 / 880 = 0.41` by width and `844 * 0.9 / 466 = 1.63` by height. The width binds,
		// which is the mirror image of the landscape case and the reason both axes have to be considered.
		expect(panelScaleFor(new Vector2(390, 844), STORE_DESIGN)).toBe(MIN_PANEL_SCALE);
	});

	it("never goes below the legibility floor, and that is a deliberate trade", () => {
		// A very narrow window computes `0.2`-ish and returns the floor instead. The panel is then **wider than the screen**, which
		// is visible and reportable; the alternative — honouring the arithmetic — produces a sheet whose 12-pixel captions render at
		// four points, which is on screen and unreadable.
		expect(panelScaleFor(new Vector2(200, 200), STORE_DESIGN)).toBe(MIN_PANEL_SCALE);
		expect(panelScaleFor(new Vector2(1, 1), STORE_DESIGN)).toBe(MIN_PANEL_SCALE);
		expect(MIN_PANEL_SCALE > 0).toBe(true);
	});

	it("scales one number for both axes, so the composition cannot squash", () => {
		// **The property that makes this a scale rather than a reflow.** A `Vector2`-valued answer would let the width and height be
		// divided by different amounts, and a sheet 880 wide and 466 tall drawn at two different factors is a different composition.
		// One number means every gap, corner, stroke and glyph keeps its relationship to every other one.
		const scale = panelScaleFor(new Vector2(844, 390), STORE_DESIGN);
		const drawnWidth = STORE_DESIGN.X * scale;
		const drawnHeight = STORE_DESIGN.Y * scale;

		// The aspect ratio of the drawn panel is the aspect ratio of the design, to the last bit the arithmetic allows.
		expect(ASpectCloseTo(drawnWidth / drawnHeight, STORE_DESIGN.X / STORE_DESIGN.Y)).toBe(true);

		// And the result fits the viewport on both axes.
		expect(drawnWidth <= 844).toBe(true);
		expect(drawnHeight <= 390).toBe(true);
	});

	it("answers the design size rather than dividing by zero when a panel has not been laid out", () => {
		// A minimised window reports `0 × 0`, and an auto-height sheet reports `Size.Y.Offset = 0` on its first frame because
		// `AutomaticSize` has not resolved. The cheap implementation divides by zero and every panel vanishes; **a zero is "not
		// saying", not "infinitely small"**.
		expect(panelScaleFor(new Vector2(0, 0), STORE_DESIGN)).toBe(1);
		expect(math.abs(panelScaleFor(new Vector2(844, 390), new Vector2(880, 0)) - (844 * 0.92) / 880) < 1e-6).toBe(
			true,
		);
		expect(panelScaleFor(new Vector2(0, 1080), new Vector2(0, 466))).toBe(1);
	});

	it("scales a small panel less than a large one on the same screen", () => {
		// The toast is 240 wide against the store's 880, so on one screen it needs a smaller multiplier to fit — and gets `1`
		// because it already fits. This is what "the panel describes itself" buys: no per-panel constant, no table to keep in step.
		expect(panelScaleFor(new Vector2(844, 390), TOAST_DESIGN)).toBe(1);
		expect(panelScaleFor(new Vector2(844, 390), STORE_DESIGN) < 1).toBe(true);
		expect(panelScaleFor(new Vector2(844, 390), PICKER_DESIGN) < 1).toBe(true);
	});
});

/** `expect` has no `toBeCloseTo` in this jest build, so a ratio comparison is stated at the precision that matters. */
function ASpectCloseTo(actual: number, expected: number): boolean {
	return math.abs(actual - expected) < 0.000001;
}
