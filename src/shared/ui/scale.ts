/**
 * The type scale and spacing scale, and the one font.
 *
 * ## Rule 6, verbatim
 *
 * *Type is chosen from a closed set of variants. An element asks for `heading3`; it does not ask for 18px.*
 * The ban is on sizes decided at the call site, because a literal `TextSize = 18` in one element cannot be
 * changed by the design and cannot be compared with the 18 in the next element — two elements that were
 * meant to match slowly diverge and nothing fails.
 *
 * ## Why `Typography` is keyed by **big-ui's** variant names
 *
 * `@rbxts/big-ui@1.1.3` owns the variant vocabulary: its `Text` component takes `variant: TypographyVariant`
 * and reads `Typography[variant].size / .font / .lineHeight` out of its own theme table (`Text.d.ts`,
 * `Text.luau`). So a variant name here that big-ui does not know would be a name no component can ask for.
 * Keying this table by `Record<TypographyVariant, TextSpec>` means **adding a variant to big-ui is a
 * compile error here**, which is the doc's step 4 warning ("a type is not enumerable — a variant you forget
 * silently keeps the library default") made structural: there is no way to forget one, because the push in
 * `big-ui-theme.ts` iterates this table and this table must cover big-ui's union.
 *
 * The app's design names (`heading1`–`heading3`, `body1`, `body2`, `caption`) map onto big-ui's names in
 * the object below; the extra four (`subtitle1`, `subtitle2`, `button`, `overline`) have no app consumer yet
 * but still get real values, so a future component that asks for `button` does not get the library's default
 * font in the middle of a themed game.
 *
 * `keyof Typography` is `TypographyVariant` — the union is derived from the table, never written twice.
 */

import { TypographyVariant } from "@rbxts/big-ui";

/**
 * Spacing steps in pixels.
 *
 * A closed ladder rather than a number per consumer: `sm` at the banner and `sm` at the next element must be
 * the same number, or the layout drifts element by element with nothing to compare against.
 *
 * **Note the collision with big-ui's own spacing.** big-ui exports `Spacing(multiplier: number): number`
 * (`multiplier * 8`) and uses it internally for its components' padding and gaps. That is a *function*, not
 * a table, and `ThemeOverrides` has no `spacing` field — so big-ui's spacing is **not themable** and cannot
 * be pushed. The two scales therefore coexist: big-ui's for big-ui's internals, this one for app-owned
 * layout. They agree today because `SPACING.sm` (8) is `Spacing(1)`.
 */
export interface Spacing {
	xs: number;
	sm: number;
	md: number;
	lg: number;
	xl: number;
}

/** One variant's numbers. **No font** — the font is one decision for the whole game, exported separately. */
export interface TextSpec {
	size: number;
	lineHeight: number;
}

/**
 * The closed variant set, keyed by big-ui's own union.
 *
 * Not `Record<string, TextSpec>`: a string-keyed record makes `keyof` collapse to `string`, which is exactly
 * the "variant you cannot enumerate" the doc warns about.
 */
export type Typography = Record<TypographyVariant, TextSpec>;

/** The derived union. Adding a key to `TYPOGRAPHY` adds a member here; nothing restates the list. */
export type TextVariant = keyof Typography;

/**
 * **Placeholder.** The game's one font.
 *
 * It lives beside the scale rather than inside `Typography` because it is not a per-variant decision: the
 * doc's step 4 makes the font one choice for the whole game, and a font per variant is how a UI ends up
 * with three typefaces nobody chose. `pushBigUiTheme` merges this font into **every** variant, so no
 * big-ui component can render in the library's default face.
 */
export const FONT = Enum.Font.GothamMedium;

/** **Placeholder.** The spacing ladder, in pixels. */
export const SPACING: Spacing = {
	xs: 4,
	sm: 8,
	md: 12,
	lg: 16,
	xl: 24,
};

/**
 * **Placeholder.** Sizes and line heights for every big-ui variant.
 *
 * The first six keep the app's design scale (32/24/18/16/14/12) on big-ui's nearest names; the last four are
 * big-ui's own defaults carried across so the whole table has app-owned values.
 *
 * Line heights are a bit over 1.2× the size rather than the engine default, because big-ui's `Text` derives
 * its default height from `spec.lineHeight` — a line height that does not match its size is how an
 * auto-sized label ends up with lopsided padding that looks like a bug in the panel around it.
 */
export const TYPOGRAPHY: Typography = {
	h4: { size: 32, lineHeight: 40 },
	h5: { size: 24, lineHeight: 30 },
	h6: { size: 18, lineHeight: 22 },
	subtitle1: { size: 16, lineHeight: 20 },
	subtitle2: { size: 14, lineHeight: 18 },
	body1: { size: 16, lineHeight: 20 },
	body2: { size: 14, lineHeight: 18 },
	button: { size: 14, lineHeight: 18 },
	caption: { size: 12, lineHeight: 16 },
	overline: { size: 11, lineHeight: 14 },
};
