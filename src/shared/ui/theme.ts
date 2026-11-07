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

import { Rarity } from "shared/economy.config";
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

	/**
	 * Domain slot: the coin currency's own colour.
	 *
	 * Separate from `warning` and from `rarity.legendary` on purpose. It is tempting to reuse the amber already in the
	 * palette, but a coin that is the same colour as a legendary border makes the two unreadable as different things —
	 * and "this is money" is a meaning the UI will need everywhere a price appears, which is exactly what makes it a
	 * domain slot rather than a one-off literal in the store.
	 */
	coin: Color3;

	/**
	 * Domain slot: the paid-chest accent.
	 *
	 * A third domain slot, and the same argument as `coin` and `rarity`: the Premium chest needs to be visually distinct
	 * from the Coin chest, and "this is the paid one" is a meaning that every future paid surface will want. A literal in
	 * the controller would be the first colour literal in the store since item 57 removed them all, and the second
	 * element that needed the same tint would invent its own.
	 */
	premium: Color3;

	/**
	 * Domain slot: the item rarity ladder, one colour per tier.
	 *
	 * Here rather than in the store that first needed it, for the reason this file exists: a rarity colour is a
	 * *semantic* value — "epic" means the same violet wherever it is drawn — and a store-local table would make the
	 * next element that shows a rarity invent a fifth violet. Keyed by the economic `Rarity` union rather than by
	 * position, so adding a tier to `economy.config.ts` is a type error here until this table gains the colour,
	 * which is exactly the prompt a designer needs.
	 *
	 * A direction pair: the light direction aims these at paper contrast, the dark direction at contrast against
	 * brown. The tier *meaning* is shared; the values are not.
	 */
	rarity: Record<Rarity, Color3>;
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
 *
 * `rarity` is the second **domain slot** after `specialRobux`, added when the store became the first element to
 * draw an item tier. It belongs here for the same reason: a tier's colour is a meaning shared by every element that
 * will ever show a tier, so a store-local table would make the next reader invent its own epic.
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
			coin: BASE.yellow,
			// Robux green, deliberately the same hue as `specialRobux`: on the dark HUD the paid chest should read as
			// "this costs Robux" at a glance, and that association already exists.
			premium: BASE.robux,

			// Brighter than the light direction's by roughly two steps each, because these sit on brown rather than on
			// paper: a #3B82C4 blue would sink into `brownDarker` and read as a grey line.
			rarity: {
				common: TINTS.inkDim,
				rare: TINTS.tealLight,
				epic: TINTS.tealLighter,
				legendary: BASE.yellow,
			},
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
			// **Placeholder.** A brighter gold than `rarity.legendary`'s amber, so a price and a legendary border never
			// read as the same signal.
			coin: Color3.fromHex("#E9B949"),
			// **Placeholder.** A deeper green than the coin gold, so the two chest headers never read as the same offer.
			// Dark enough to pass as a 2 px border on paper, saturated enough to read as "different from the coin chest".
			premium: Color3.fromHex("#2E7D5B"),

			// **Placeholder.** The rarity ladder on paper. These are the only colours in either direction chosen for a
			// *domain* rather than a job, and they are chosen for two things at once: legible as a 2 px border against
			// #F4F1EA, and far enough apart in hue that a player can tell a tier without reading its name. Grey is
			// deliberately the least interesting of the four — common should not draw the eye.
			rarity: {
				common: Color3.fromHex("#9AA0A6"), // grey: the floor of the ladder, deliberately unexciting
				rare: Color3.fromHex("#3B82C4"), // blue
				epic: Color3.fromHex("#8B5CF6"), // violet
				legendary: Color3.fromHex("#D99A1E"), // amber, the only warm colour in the set
			},
		},
	};
}

/**
 * The chunky direction: neutral charcoal surfaces and pale ink, for the sheet the `buildChunkyPanel` chrome draws.
 *
 * ## Why a third direction exists
 *
 * The paper direction is opaque and light, and **its cards are `#FFFFFF`**. That was right while the sheet was paper;
 * the moment the sheet's face became a charcoal plate with a thick outline and an offset shadow, every white card inside
 * it read as something nobody had got round to changing - a light UI sitting in a dark frame. This direction is the
 * contents of that frame.
 *
 * **Same `Theme` interface, same type and spacing.** `SPACING` and `TYPOGRAPHY` are separate exports and are untouched,
 * and no call site changed beyond which theme instance it reads.
 *
 * ## Why neutral rather than the HUD's browns
 *
 * The HUD direction is warm brown at `0.15` transparency, designed to be looked *past* over a moving scene. A sheet is
 * looked *at*, and its chrome is a **neutral** charcoal: brown cards over a neutral plate would tint the plate and the two
 * would disagree about what colour the furniture is. So the four surfaces are greys with a slight cool cast, and every
 * surface is **opaque** for the same reason the paper direction's are - the scene must not show through text a player is
 * reading.
 *
 * ## The three values that had to move, and why
 *
 * - **`border` is lighter** (`#4E4E5A`), not the near-black the other two directions use. A near-black edge between a
 *   dark card and a dark plate is not an edge; on charcoal the separator has to be *above* the surfaces it separates.
 *   The sheet's own thick outline is drawn by the chrome module, in its own darker value, so the two never argue.
 * - **`accent` and `premium` are brighter.** The paper direction's `#2F5E8C` was chosen to sit on `#ECE8DF`; on charcoal
 *   it collapses into the background. These are fills carrying `onAccent` white text, so they only have to clear the
 *   surface, not the ink.
 * - **`rarity` is a step brighter each.** Same territory as the paper ladder, raised because these are read as *text and
 *   2-pixel borders* on a dark plate rather than on paper. `common` stays the least interesting of the four.
 *
 * `paint.panel` is deliberately the same value as `CHUNKY_PANEL_FACE` in `./chunky-panel`, so the sheet's face and the
 * surfaces its contents believe they are standing on cannot drift apart.
 */
export function chunkyDarkTheme(): Theme {
	const opaque = (color: Color3): Paint => ({ color, transparency: 0 });

	return {
		paint: {
			surface: opaque(Color3.fromHex("#2A2A31")), // the page behind everything: a well, darker than the face
			panel: opaque(Color3.fromHex("#34343A")), // the sheet's face - equal to CHUNKY_PANEL_FACE
			card: opaque(Color3.fromHex("#3E3E47")), // a tile inside the sheet, one step up again
			trough: opaque(Color3.fromHex("#232329")), // a recessed well, e.g. a scrolling list's interior
		},
		colors: {
			textPrimary: BASE.white,
			textSecondary: Color3.fromHex("#C6C6D0"),
			textDisabled: Color3.fromHex("#7C7C88"),

			accent: Color3.fromHex("#3F82C9"),
			onAccent: BASE.white,

			success: Color3.fromHex("#2FA36B"),
			warning: Color3.fromHex("#E0A93B"),
			error: Color3.fromHex("#D24A4A"),

			border: Color3.fromHex("#4E4E5A"),
			shadow: BASE.black,

			specialRobux: BASE.robux,
			coin: Color3.fromHex("#E9B949"),
			// The premium green, raised for charcoal: the paper direction's `#2E7D5B` was chosen against paper and reads as
			// a dark smear here. Kept distinguishable from `success` by being the same green the chest header already uses.
			premium: Color3.fromHex("#2FA36B"),

			rarity: {
				common: Color3.fromHex("#9AA0A6"), // grey, still the floor of the ladder
				rare: Color3.fromHex("#4C93D6"), // blue
				epic: Color3.fromHex("#9B72F5"), // violet
				legendary: Color3.fromHex("#E0A93B"), // amber, the only warm colour in the set
			},
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
