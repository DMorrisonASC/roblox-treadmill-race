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

/**
 * The size ladder, one entry per **distinct size**, smallest first.
 *
 * The variants that share a size (`body2`/`subtitle2`/`button` are all 14) appear once, because "one step up" that lands on
 * another name for the same number is not a step. Named below as the variant each step is read *as*, so the map from any
 * variant - including the aliases - to the next real size is explicit rather than a search through the table.
 */
const NEXT_TEXT_VARIANT: Record<TypographyVariant, TypographyVariant> = {
	overline: "caption", // 11 -> 12
	caption: "body2", // 12 -> 14
	body2: "body1", // 14 -> 16
	subtitle2: "body1", // 14 -> 16
	button: "body1", // 14 -> 16
	body1: "h6", // 16 -> 18
	subtitle1: "h6", // 16 -> 18
	h6: "h5", // 18 -> 24
	h5: "h4", // 24 -> 32
	// The top of the ladder has nowhere to go. Stated rather than left undefined so the map stays total and a caller
	// asking for the largest variant gets the largest variant instead of `nil`.
	h4: "h4",
};

/** The next variant **up** the size ladder from `variant`, or `variant` itself at the top. */
export function nextTextVariant(variant: TypographyVariant): TypographyVariant {
	return NEXT_TEXT_VARIANT[variant];
}

/**
 * The whole scale, one step larger: every variant's spec replaced by its next size up.
 *
 * ## Why this exists instead of editing the call sites
 *
 * A panel that wants its type one size larger everywhere is making **one** decision, and the way to express one decision is
 * one table. Rewriting two hundred `TYPOGRAPHY.body2` reads into `TYPOGRAPHY.body1` would spread that decision across the
 * file, where the next element added would silently keep the old size and the panel would slowly go back to two scales.
 *
 * It also keeps the **bands** in step: a caller sizing a row at `lineHeight` of its label's variant reads the same table,
 * so bumping the type bumps the space it needs. A table that changed fonts but not heights would clip every label it grew.
 *
 * **Not a mutation of `TYPOGRAPHY`.** The base scale is what the HUD, the banner and the picker read, and they are not
 * being rescaled; this returns a new table and changes nothing for anyone who keeps importing `TYPOGRAPHY`.
 */
export function typographyOneStepUp(): Typography {
	return {
		h4: TYPOGRAPHY[NEXT_TEXT_VARIANT.h4],
		h5: TYPOGRAPHY[NEXT_TEXT_VARIANT.h5],
		h6: TYPOGRAPHY[NEXT_TEXT_VARIANT.h6],
		subtitle1: TYPOGRAPHY[NEXT_TEXT_VARIANT.subtitle1],
		subtitle2: TYPOGRAPHY[NEXT_TEXT_VARIANT.subtitle2],
		body1: TYPOGRAPHY[NEXT_TEXT_VARIANT.body1],
		body2: TYPOGRAPHY[NEXT_TEXT_VARIANT.body2],
		button: TYPOGRAPHY[NEXT_TEXT_VARIANT.button],
		caption: TYPOGRAPHY[NEXT_TEXT_VARIANT.caption],
		overline: TYPOGRAPHY[NEXT_TEXT_VARIANT.overline],
	};
}
