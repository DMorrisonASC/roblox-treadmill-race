/**
 * The first real write into big-ui's theme.
 *
 * ## What big-ui actually provides (verified from `node_modules/@rbxts/big-ui@1.1.3`)
 *
 * `out/ui/theme.d.ts` exports `Palette`, `Transparency`, `Shape`, `Spacing`, `Typography`, `ZIndex` as
 * **mutable tables**, plus `configureTheme(overrides: ThemeOverrides): void`, which deep-merges user values
 * into those live tables. `out/ui/theme.luau`'s own header says: *"The exported objects … are mutable.
 * Consumers override them at startup by calling `configureTheme(...)`. Components read live values at render
 * time, so configureTheme should be called before mounting UI."*
 *
 * So the UI doc's step-4 assumption — "push the direction into the UI library's global theme table" — is
 * **correct for this library**, with one refinement: the table is not assigned directly, it is configured
 * through one entry point. That is strictly better than the doc assumed, because `configureTheme` merges
 * rather than replaces, so a partial override leaves the library's other defaults intact.
 *
 * ## What the doc's assumption gets wrong
 *
 * Step 4 implies the push makes the library paint *everything*. It does not, and this library cannot: it has
 * no plain container component (see `BigUi` in `HANDOFF.md` — `Card` is the nearest, and it forces a
 * `UICorner`, an optional `UIStroke`, a `UIListLayout` and a full-width default size). Components big-ui
 * *does* own (`Text`, `Card`, `Button`, …) read the theme table, so they recolour from the push; app-owned
 * layout is painted from the same `Theme` object the push reads. One source, two painters.
 *
 * ## Why the font goes through `typography` and not a sweep
 *
 * big-ui's `TypographySpec` is `{ size, font, lineHeight }`, so a font is a thing the library *does* accept,
 * per variant, through the theme table. A `sweepFont` walk over the finished subtree would therefore be
 * redundant — the doc's "things the library will not take, get a sweep" case does not arise. Note the
 * consequence the doc's step 4 warns about: a variant left out of the override silently keeps the library's
 * default font. That is impossible here because the loop below iterates the app's `TYPOGRAPHY`, whose key
 * type *is* big-ui's `TypographyVariant` union — a variant big-ui adds is a compile error in `scale.ts`.
 */

import { configureTheme } from "@rbxts/big-ui";
import type { PaletteOverride, TransparencyDef, TypographyOverride } from "@rbxts/big-ui";
import { FONT, TYPOGRAPHY } from "./scale";
import type { Theme } from "./theme";

/**
 * Text transparencies, all zero.
 *
 * big-ui draws primary text at `Transparency.textPrimary = 0.13` by default — i.e. **87% opaque**, which is a
 * deliberate Material-UI inheritance (`theme.luau` explains it) and exactly wrong for this palette: the app's
 * `textPrimary`/`textSecondary`/`textDisabled` are already the final designed colours, and fading them a
 * second time makes the rendered colour differ from the one in the cascade test.
 */
const TEXT_TRANSPARENCY: Partial<TransparencyDef> = {
	textPrimary: 0,
	textSecondary: 0,
	textDisabled: 0,
};

let pushed = false;

function countFields(record: object): number {
	let count = 0;
	for (const [, value] of pairs(record)) {
		if (value !== undefined) {
			count++;
		}
	}
	return count;
}

/**
 * Push the app's theme into big-ui's live tables. Idempotent: the second call is a no-op.
 *
 * Called once from `getTheme()` immediately after construction, so the log order is `[Theme] mounted` →
 * `[BigUi] theme pushed` → the first big-ui component's construction.
 *
 * ## The mapping, and the one gap
 *
 * - `primary` ← `accent` / `onAccent` — big-ui's "primary" is the call-to-action group, which is the app's
 *   accent by definition.
 * - `secondary` ← `success` — the app has no second accent, so the group big-ui gives to secondary carries the
 *   teal. A future second CTA would need a real decision here rather than inheriting this one.
 * - `success` / `warning` / `error` ← the same-named slots, one for one.
 * - **`info` is not overridden.** The app's 11 slots have no info colour — there is nothing to map, and
 *   inventing one here would be the "colour that means whatever this file says" defect. big-ui's default blue
 *   therefore survives, and any element drawing `info` will look like the library, not the game. That is a gap
 *   in the app's palette, reported as such.
 * - `text.{primary,secondary,disabled}` ← the app's three text slots.
 * - `background.default` ← `paint.surface`, `background.paper` ← `paint.panel` — the two surfaces big-ui's own
 *   components reach for. `paint.card` and `paint.trough` have no big-ui counterpart; they are app-owned.
 * - `common.black` ← `border` (big-ui draws its card strokes from `common.black` + `Transparency.divider`),
 *   `common.white` ← `onAccent`.
 */
export function pushBigUiTheme(theme: Theme): void {
	if (pushed) {
		return;
	}
	pushed = true;

	const typography: TypographyOverride = {};
	let variants = 0;
	for (const [variant, spec] of pairs(TYPOGRAPHY)) {
		typography[variant] = { size: spec.size, lineHeight: spec.lineHeight, font: FONT };
		variants++;
	}

	const palette: PaletteOverride = {
		primary: { main: theme.colors.accent, contrast: theme.colors.onAccent },
		secondary: { main: theme.colors.success, contrast: theme.colors.onAccent },
		success: { main: theme.colors.success, contrast: theme.colors.onAccent },
		warning: { main: theme.colors.warning, contrast: theme.colors.onAccent },
		error: { main: theme.colors.error, contrast: theme.colors.onAccent },
		text: {
			primary: theme.colors.textPrimary,
			secondary: theme.colors.textSecondary,
			disabled: theme.colors.textDisabled,
		},
		background: { default: theme.paint.surface.color, paper: theme.paint.panel.color },
		common: { black: theme.colors.border, white: theme.colors.onAccent },
	};

	configureTheme({ palette, transparency: TEXT_TRANSPARENCY, typography });

	print(
		`[BigUi] theme pushed direction="hudDark" paletteGroups=${countFields(palette)} transparency=${countFields(TEXT_TRANSPARENCY)} typography=${variants}`,
	);
}
