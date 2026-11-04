/**
 * The theme: the brand's colours resolved into job-named slots.
 *
 * ## The design rule this file exists to serve
 *
 * *Colours are named by the job they do, not by where they come from and not by who uses them.*
 * `shopTileBackground` is the bug this file prevents: the moment a slot is named after one element, the
 * second element that needs the same colour either duplicates the value (two places to change when the
 * palette moves) or reaches into the shop's slot (a colour that now means two things). The tile asks for
 * `card`; the theme decides which colour a card is today and which one it is after the palette changes.
 *
 * `specialRobux` is a **domain slot**, not a component slot — the same category of thing as `warning` or
 * `error`. It names a meaning ("this UI is about buying with Robux") that several elements may need (shop
 * tile, purchase button, price label), which is exactly why it must not be named after any one of them. It is
 * not a precedent for `shopTileBackground`: a domain slot survives every element that reads it, a component
 * slot dies with its component.
 */

import { pushBigUiTheme } from "./big-ui-theme";

/**
 * The brand's base colours, exactly as supplied. **Not placeholders.**
 *
 * `teal`, `brown`, `red`, `orange`, `yellow` are the five brand colours; `white`/`black` are the two
 * neutrals; `robux` is the special domain colour (`rgb(62, 156, 53)`), named after a thing rather than a hue
 * because that is what it is for.
 */
export const BASE = {
	teal: Color3.fromHex("#00A0B0"),
	brown: Color3.fromHex("#6A4A3C"),
	red: Color3.fromHex("#CC333F"),
	orange: Color3.fromHex("#EB6841"),
	yellow: Color3.fromHex("#EDC951"),
	white: Color3.fromRGB(255, 255, 255),
	black: Color3.fromRGB(0, 0, 0),
	robux: Color3.fromRGB(62, 156, 53),
} as const;

/**
 * Tints of every brand colour, plus the two ink tints and the border.
 *
 * **Designed values, not computed — doc rule 5.** There is no `lighten()` or `lerp()` here, on purpose. A
 * computed tint is a value nobody designed and nobody can hand off: two people comparing screenshots cannot
 * name the colour, and the shade survives refactors that nobody intended to change the look. Rule 5 makes the
 * same argument about device differences ("a device difference is a type size, not a scale factor"); the same
 * reasoning applies to colour.
 *
 * **Every value here is `**Placeholder.**`** — the designer has not supplied tints yet. Replacing the set is
 * one line per colour and nothing else in the tree moves.
 *
 * Counts: four per brand colour for teal/red/orange/yellow; six for brown, because the surface family needs
 * four *ascending* values and the two extra steps keep the ascent continuous instead of jumping; plus the two
 * ink tints and the border.
 */
export const TINTS = {
	// Teal — #00A0B0.
	tealDarker: Color3.fromHex("#007A86"), // **Placeholder.**
	tealDark: Color3.fromHex("#008C9A"), // **Placeholder.**
	tealLight: Color3.fromHex("#1FB4C2"), // **Placeholder.**
	tealLighter: Color3.fromHex("#3EC6D2"), // **Placeholder.**

	// Brown — #6A4A3C. The surface family, ascending from darkest to lightest.
	brownDarkest: Color3.fromHex("#2B1E18"), // **Placeholder.**
	brownDarker: Color3.fromHex("#453028"), // **Placeholder.**
	brownDark: Color3.fromHex("#583D31"), // **Placeholder.**
	brownLight: Color3.fromHex("#7D5A4A"), // **Placeholder.**
	brownLighter: Color3.fromHex("#8F6A58"), // **Placeholder.**
	brownLightest: Color3.fromHex("#A17C68"), // **Placeholder.**

	// Red — #CC333F.
	redDarker: Color3.fromHex("#A32630"), // **Placeholder.**
	redDark: Color3.fromHex("#B82C38"), // **Placeholder.**
	redLight: Color3.fromHex("#D9525D"), // **Placeholder.**
	redLighter: Color3.fromHex("#E4707A"), // **Placeholder.**

	// Orange — #EB6841.
	orangeDarker: Color3.fromHex("#C24E2B"), // **Placeholder.**
	orangeDark: Color3.fromHex("#D65B35"), // **Placeholder.**
	orangeLight: Color3.fromHex("#EF8867"), // **Placeholder.**
	orangeLighter: Color3.fromHex("#F3A385"), // **Placeholder.**

	// Yellow — #EDC951.
	yellowDarker: Color3.fromHex("#C7A63C"), // **Placeholder.**
	yellowDark: Color3.fromHex("#DAB749"), // **Placeholder.**
	yellowLight: Color3.fromHex("#F1D574"), // **Placeholder.**
	yellowLighter: Color3.fromHex("#F5E098"), // **Placeholder.**

	// Ink — the white base turned down twice.
	inkDim: Color3.fromHex("#D8D8D8"), // **Placeholder.**
	inkDisabled: Color3.fromHex("#8A8A8A"), // **Placeholder.**

	// Chrome — near-black, so a border reads as an edge rather than as a colour of its own.
	border: Color3.fromHex("#1A1A1A"), // **Placeholder.**
} as const;

/**
 * One painted surface: a colour and the transparency it is painted at.
 *
 * Always paired. A `Color3` alone cannot express "the panel colour, as panels are drawn", and the two halves
 * living in different places is how a fully opaque `card` at the `surface` transparency — a real-looking bug
 * no type catches — becomes possible.
 */
export interface Paint {
	color: Color3;
	transparency: number;
}

/**
 * Job-named colour slots, each a single `Color3`. See the module comment for the naming rule.
 *
 * The text family is three slots rather than one plus alpha, because dim text and disabled text are different
 * reasons for being quiet — a disabled label and a caption both read as "less important" today and must not
 * be tied together if the designer separates them tomorrow.
 */
export interface Colors {
	textPrimary: Color3;
	textSecondary: Color3;
	textDisabled: Color3;

	/** The one call-to-action colour. There is deliberately no second accent: two CTAs is no CTA. */
	accent: Color3;
	/** Readable on `accent`. A separate slot because "the colour that contrasts with the accent" moves with it. */
	onAccent: Color3;

	success: Color3;
	warning: Color3;
	error: Color3;

	/** The edge of a surface. */
	border: Color3;
	/** The drop colour under a surface. */
	shadow: Color3;

	/** Domain slot: Robux-purchase UI only. See the module comment. */
	specialRobux: Color3;
}

/**
 * The whole theme.
 *
 * ## What is deliberately **not** here
 *
 * - **No `spacing`, no `typography`, no `font`.** They are exported separately from `scale.ts` and, in the
 *   case of type, pushed into big-ui's own theme table. Putting them on `Theme` would make a direction able
 *   to typeset itself differently, which is the thing the scale exists to prevent — if a panel looks
 *   different it is painted differently, not typeset differently.
 * - **No `cornerRadius`, no `strokeThickness`, no `metrics` bag.** No element has a reader for either: the
 *   banner draws no `UICorner` and no `UIStroke`, and big-ui's own shape values (`Shape.radius`,
 *   `Shape.radiusLarge`) are the library's business and are not overridden. A slot with no reader is a slot
 *   whose value gets guessed at; the deferral is named here so the next element knows where to add it.
 * - **No `paint.text`/`card` naming by element.** The four surfaces are depth levels, not component slots.
 */
export interface Theme {
	paint: {
		surface: Paint;
		panel: Paint;
		card: Paint;
		trough: Paint;
	};
	colors: Colors;
}

/** **Placeholder.** The transparency every surface is painted at, until a surface needs its own. */
const SURFACE_TRANSPARENCY = 0.15;

function surface(color: Color3): Paint {
	return { color, transparency: SURFACE_TRANSPARENCY };
}

/** Counts a record's keys without assuming the count, so a log line cannot go stale when a slot is added. */
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
 * The dark HUD direction. Internal: callers ask `getTheme()`.
 *
 * ## Four distinct surface levels
 *
 * The doc's step 3 requires a dark direction to have four *different* surface values. One brown with four
 * transparencies would collapse the depth ordering into a single hue and every layer would read as the same
 * plane — which is why `TINTS` spends three of its six brown steps on the dark end and this function assigns
 * one tint per level, ascending: full-strength brown is `trough` (a recessed well, the lightest), and the
 * three steps below it are `card`, `panel`, `surface`.
 *
 * ## The mapping
 *
 * `accent` is orange, `success` is teal, `warning` is yellow, `error` is red, `onAccent` is white. That is
 * the user's assignment, reproduced rather than re-derived. Teal reads positive and cannot be confused with
 * red or yellow; orange is the only brand colour with both the chroma and the lightness to read as "press
 * me" against four browns.
 */
function hudDarkTheme(): Theme {
	return {
		paint: {
			surface: surface(TINTS.brownDarkest), // the backdrop everything sits on
			panel: surface(TINTS.brownDarker), // a floating container, one step up
			card: surface(TINTS.brownDark), // a tile inside a panel, one step up again
			trough: surface(BASE.brown), // full-strength brown — a recessed well, the lightest of the four
		},
		colors: {
			// Text — white on warm brown.
			textPrimary: BASE.white,
			textSecondary: TINTS.inkDim,
			textDisabled: TINTS.inkDisabled,

			accent: BASE.orange,
			onAccent: BASE.white,

			success: BASE.teal,
			warning: BASE.yellow,
			error: BASE.red,

			border: TINTS.border,
			shadow: BASE.black,

			specialRobux: BASE.robux,
		},
	};
}

/**
 * The light, opaque direction: paper surfaces and dark ink, for panels a player stops to read.
 *
 * ## Why a second direction exists at all
 *
 * The dark HUD is for **looking past** - a banner, a phase name, a value you glance at while watching the belt.
 * The shop and the inventory are for **looking at**: a player stops, reads, chooses. A translucent brown panel
 * over a moving scene is the wrong surface for that, because the scene keeps moving behind the text and the eye
 * has to work to separate them. So the panels are opaque paper: four light surfaces, dark ink, one restrained
 * accent. The same `Theme` interface, a different palette.
 *
 * **Nothing about type or spacing changes.** `SPACING` and `TYPOGRAPHY` are separate exports and this function
 * returns a `Theme` that has neither field - the doc's rule 6, and the reason the interface was shaped that way.
 * A panel that needed a different type size would be a different design, not a different direction.
 *
 * ## Every surface is fully opaque
 *
 * `transparency: 0` on all four, not a light colour at the HUD's `0.15`. The whole point of the light direction
 * is that the scene does not show through; a light panel at 85% opacity would be neither readable nor clearly
 * paper. That is why this file has two constructors rather than one palette with a tint parameter - the
 * transparency is part of the decision, not a global setting.
 *
 * ## Why this is a sibling of `getTheme()`, not a parameter on it
 *
 * `theme("light")` would mean every element could ask for any direction, and the first element that did would be
 * a panel that renders dark because its controller forgot which mode it was in. **Two functions, two directions,
 * chosen at the call site by the element that knows what it is** - rule 8's "builders, not a framework" applied
 * to themes. A third direction is a third function, and a registry would be the framework rule 8 warns against.
 *
 * ## Why it is not cached and not pushed
 *
 * `getTheme()` caches because it pushes its result into big-ui's global theme table, so every reader must get the
 * *same* object. This direction pushes nothing - big-ui's table stays dark, since the library's components are
 * HUD elements - so there is no identity to preserve and a fresh object per call is the safer default. It also
 * means a consumer that mutates its copy cannot affect the next caller.
 */
export function surfaceOpaqueTheme(): Theme {
	const opaque = (color: Color3): Paint => ({ color, transparency: 0 });

	return {
		paint: {
			surface: opaque(Color3.fromHex("#ECE8DF")), // the page behind everything
			panel: opaque(Color3.fromHex("#F4F1EA")), // the panel a player reads
			card: opaque(Color3.fromHex("#FFFFFF")), // a tile inside the panel: the brightest thing on screen
			trough: opaque(Color3.fromHex("#DDD8CE")), // a recessed well, e.g. a text field's interior
		},
		colors: {
			textPrimary: Color3.fromHex("#1C1B18"),
			textSecondary: Color3.fromHex("#55514A"),
			textDisabled: Color3.fromHex("#8E8A80"),

			// A muted blue rather than the brand orange: on paper, orange reads as a warning label, and a shop's
			// call to action has to read as "press me" without looking like an error.
			accent: Color3.fromHex("#2F5E8C"),
			onAccent: Color3.fromHex("#FFFFFF"),

			// Semantic slots keep their meaning but are darkened for legibility on a light surface - the brand
			// yellow in particular is unreadable as text on paper.
			success: Color3.fromHex("#2E7D32"),
			warning: Color3.fromHex("#B8781B"),
			error: Color3.fromHex("#B33A3A"),

			border: Color3.fromHex("#C9C4B8"),
			shadow: Color3.fromHex("#000000"),

			specialRobux: BASE.robux,
		},
	};
}

let cachedTheme: Theme | undefined;

/**
 * The theme, constructed once and cached.
 *
 * ## Why the mount is here and not in a boot controller
 *
 * This is the first thing any element reads, and a read that constructs is the only ordering that cannot be
 * wrong: an explicit boot step works only if it happens to run before every consumer, which Flamework does
 * not promise. The cost is that the `[Theme] mounted` line appears at the first element's start rather than
 * at boot, which is the correct place to learn it from.
 *
 * ## Why the push lives here
 *
 * The UI doc's step 4 says the direction is pushed into the UI library's global theme table *at mount*. This
 * is that moment: `pushBigUiTheme` is called once, immediately after construction, so the log order is
 * `[Theme] mounted` → `[BigUi] theme pushed` → the first component's construction — which is what proves the
 * push happened at mount rather than lazily on first component use.
 *
 * The push cannot live in `big-ui-theme.ts` alone because something has to call it, and it cannot live in the
 * banner controller because the controller is one consumer of a game-wide decision.
 */
export function getTheme(): Theme {
	if (cachedTheme !== undefined) {
		return cachedTheme;
	}

	const theme = hudDarkTheme();
	cachedTheme = theme;

	print(`[Theme] mounted direction="hudDark" paint=${countFields(theme.paint)} colors=${countFields(theme.colors)}`);

	pushBigUiTheme(theme);

	return theme;
}
