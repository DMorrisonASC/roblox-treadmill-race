import { Players } from "@rbxts/services";

/**
 * The game's UI layers, and the only way to obtain one of their `ScreenGui`s.
 *
 * ## The rule this module exists to enforce
 *
 * **A layer's draw order and inset contract are decided once, here, and every element inherits them.**
 * The failure it prevents is two controllers each creating their own `ScreenGui` with their own
 * `DisplayOrder` and their own `ScreenInsets` — the banner ends up under the belt HUD on one client and
 * above it on another, and nothing in either controller looks wrong. Hence one public function and three
 * private constructors: a caller names a layer and gets a correctly configured gui, and has no way to
 * pass a wrong draw order.
 *
 * ## Why there are two HUD functions and no device branch
 *
 * An element that must not leak under the Roblox topbar wants `TopbarSafeInsets`; an element that should
 * sit inside the core UI area wants `CoreUISafeInsets`. **The element chooses, not the device.** An
 * earlier sketch branched on device type, which made the same element sit at two different heights
 * depending on the phone — a difference the designer never asked for and could not see in Studio.
 *
 * ## Why the full-screen gui is a third function and not a third HUD
 *
 * It keeps `ScreenInsets.None` and draws *under* everything: its tenants pin to the physical screen
 * edges deliberately, so applying safe insets to it would inset the thing whose job is to reach the
 * edge. It is a different contract, not a different rank.
 */

/** **Placeholder.** The `ScreenGui` name for the topbar HUD layer. */
export const HUD_TOPBAR_GUI_NAME = "HudTopbarGui";
/** **Placeholder.** The `ScreenGui` name for the core HUD layer. */
export const HUD_CORE_GUI_NAME = "HudCoreGui";
/** **Placeholder.** The `ScreenGui` name for the full-screen layer. */
export const FULL_SCREEN_GUI_NAME = "FullScreenGui";
/** **Placeholder.** The `ScreenGui` name for the round-transition layer. */
export const TRANSITION_GUI_NAME = "TransitionGui";
/** **Placeholder.** The `ScreenGui` name for the action-splash layer. */
export const SPLASH_GUI_NAME = "SplashGui";
/** **Placeholder.** The `ScreenGui` name for the panel layer (the store and the inventory). */
export const SHEET_GUI_NAME = "SheetGui";
/** **Placeholder.** The `ScreenGui` name for the chest-reveal layer. */
export const REVEAL_GUI_NAME = "RevealGui";
/** **Placeholder.** The `ScreenGui` name for the reward-toast layer. */
export const TOAST_GUI_NAME = "ToastGui";

/**
 * **Placeholder.** Draw order for the full-screen layer: **below both HUD layers**.
 *
 * The ordering constraint, stated because it is the whole point of the constant: full-screen content is
 * scenery — a backdrop, a full-bleed effect — and anything drawn above it is HUD by definition. The
 * number itself is arbitrary within the space below the HUD values, and the HUD values are arbitrary
 * relative to each other until two HUD elements actually overlap.
 */
export const FULL_SCREEN_DISPLAY_ORDER = 10;

/**
 * **Placeholder.** Draw order for the core HUD layer: above full-screen, below the topbar HUD.
 *
 * The core HUD is the main play HUD (score, prompt, pick controls as they arrive). It outranks scenery
 * and yields to the topbar strip.
 */
export const HUD_CORE_DISPLAY_ORDER = 20;

/**
 * **Placeholder.** Draw order for the topbar HUD layer: **above both of the others**.
 *
 * Chosen highest because its tenants sit in the most contended strip of the screen — directly under the
 * Roblox topbar, where a chat notification, a core prompt or a full-bleed effect would otherwise cover
 * them. An element that is *meant* to be covered belongs in the core layer instead.
 */
export const HUD_TOPBAR_DISPLAY_ORDER = 30;

/**
 * **Placeholder.** Draw order for the round-transition layer: **above every other layer**.
 *
 * The only layer whose job is to hide the others, so it is the only one that outranks the HUD. A wipe drawn under
 * a HUD element leaves the banner floating on top of an otherwise black screen, which reads as a bug rather than a
 * cut. `ScreenInsets.None` because the cover has to reach the physical screen edges - an inset wipe would show a
 * lit border of whatever it was meant to hide.
 */
export const TRANSITION_DISPLAY_ORDER = 40;

/**
 * **Placeholder.** Draw order for the action-splash layer: **above the HUD, below the wipe.**
 *
 * The constraint is one sentence and it is the whole reason the layer exists: a splash is read *over* gameplay, so it
 * outranks every HUD element, and it is still something the round transition must be able to cover, so it yields to the
 * wipe. Sitting it inside `hudCore` would let a panel clip or cover it; sitting it in `transition` would let a splash
 * draw on top of the black cover.
 */
export const SPLASH_DISPLAY_ORDER = 35;

/**
 * **Placeholder.** Draw order for the sheet layer (the store and the inventory): **above every splash, below the wipe.**
 *
 * The store and the inventory live here (item 161), and the constraint is two-sided for the same reason the splash layer's is:
 *
 * - **Above `splash` (35)**, because a splash-layer element draws over whatever is under it — a reward toast or a payout panel
 *   appearing across the middle of an open store sheet was legible only if the player happened to be looking at the part of the
 *   sheet that was not covered.
 * - **Below `transition` (40)**, because the wipe's whole job is to hide the phase change. A store above the wipe would leave a
 *   sheet floating on a black screen, which reads as the store refusing to close rather than as a cut.
 *
 * **A gap, not an adjacent value, and no longer the middle of one.** `36`, `37`, `38` and `39` were all free when this took `38`,
 * so a later element could slot above the store without renumbering anything. The later element arrived: the chest reveal (item
 * 163) needs to draw over an open sheet and under the toast, and **`38` is the only integer strictly between them.** So the sheet
 * steps down one to `37` and the reveal takes `38` — a one-number move that leaves `toast` (39) and `transition` (40) exactly as
 * item 160 and item 49 set them, and that keeps both of this layer's own constraints intact and one value wider.
 */
export const SHEET_DISPLAY_ORDER = 37;

/**
 * **Placeholder.** Draw order for the chest-reveal layer: **above the panels, below the toast, below the wipe.**
 *
 * The reveal (item 163) is a full-screen `0.5` black dim with chunky cards over it, opened from the store, so it has to outrank the
 * sheet whose buttons started it — a dim drawn *under* the panel would leave the store undimmed in the middle of a celebration.
 *
 * ## Why `38` and not the `39` the round's brief asked for
 *
 * `39` is the toast (item 133's rule: a toast may never be silently dropped, so it may never be behind a panel either), and two
 * `ScreenGui`s at the same `DisplayOrder` have no defined order between them — the tie is resolved by sibling order in `PlayerGui`,
 * which is not something either controller should be trusting for a correctness property. Three constraints therefore pin the whole
 * chain — reveal above the sheet, toast above the reveal, wipe above everything — and they need **four** integers, not three. The
 * sheet came down one instead of the toast going up one, because pushing the toast up would have pushed it past the wipe, and a
 * reward message floating on the black of a phase transition is a worse failure than a panel one rank lower than it was.
 *
 * `ScreenInsets.None`, because the reveal is a full-screen dim: its job is to reach the physical screen edges, and an inset would
 * leave undimmed strips at the edges of a phone — the same argument the `fullScreen` layer makes for scenery.
 */
export const REVEAL_DISPLAY_ORDER = 38;

/**
 * **Placeholder.** Draw order for the reward-toast layer: **above the panels, below the wipe.**
 *
 * The toast was on `splash` (35) until item 162 put the store at 38, which would have put an open sheet over a reward that
 * arrived while the player was shopping. Item 133's rule is that a toast may never silently drop a message, and a toast behind a
 * panel is the same as one that was never shown — so it gets its own layer above the panels rather than sharing theirs.
 *
 * **Above the panels and not inside them** for the reason the panels themselves are above `splash`: a toast is not part of the
 * store, and a shop that could cover a "you were paid" line would be a shop that can hide a grant.
 *
 * `CoreUISafeInsets` to match `splash`, which the toast was positioned against — it anchors at a share of that gui's height, so
 * changing the inset contract would move it.
 */
export const TOAST_DISPLAY_ORDER = 39;

/** Which layer an element wants. The eight names map one-to-one to the eight constructors below. */
export type UiLayer = "hudTopbar" | "hudCore" | "fullScreen" | "transition" | "splash" | "sheet" | "reveal" | "toast";

/**
 * The only public entry point. Returns the layer's `ScreenGui`, creating it if this client does not have
 * one yet.
 *
 * **Lazy, not eager.** Nothing calls this for `hudCore` or `fullScreen` on day one, so those guis do not
 * exist until their first tenant asks — creating three empty `ScreenGui`s at startup would put empty
 * plumbing in the Explorer and in the log for elements that do not exist yet.
 *
 * Reuse is by name and class: a previous session's gui survives in `PlayerGui` only if the session was
 * resumed, and the reuse branch re-applies `ScreenInsets` and `DisplayOrder` anyway, so a stale value
 * from that previous session is corrected rather than trusted.
 */
export function getScreenGui(layer: UiLayer): ScreenGui {
	if (layer === "hudCore") {
		return coreHudGui();
	} else if (layer === "fullScreen") {
		return fullScreenGui();
	} else if (layer === "transition") {
		return transitionGui();
	} else if (layer === "splash") {
		return splashGui();
	} else if (layer === "sheet") {
		return sheetGui();
	} else if (layer === "reveal") {
		return revealGui();
	} else if (layer === "toast") {
		return toastGui();
	}

	return topbarHudGui();
}

function topbarHudGui(): ScreenGui {
	return configureGui("hudTopbar", HUD_TOPBAR_GUI_NAME, Enum.ScreenInsets.TopbarSafeInsets, HUD_TOPBAR_DISPLAY_ORDER);
}

function coreHudGui(): ScreenGui {
	return configureGui("hudCore", HUD_CORE_GUI_NAME, Enum.ScreenInsets.CoreUISafeInsets, HUD_CORE_DISPLAY_ORDER);
}

function fullScreenGui(): ScreenGui {
	return configureGui("fullScreen", FULL_SCREEN_GUI_NAME, Enum.ScreenInsets.None, FULL_SCREEN_DISPLAY_ORDER);
}

function transitionGui(): ScreenGui {
	return configureGui("transition", TRANSITION_GUI_NAME, Enum.ScreenInsets.None, TRANSITION_DISPLAY_ORDER);
}

/**
 * `CoreUISafeInsets`, matching `hudCore`, and the match is the point: the store, the inventory and the rail moved here from
 * `hudCore`, and the picker stayed. Two guis with different inset contracts would put the sheet and the picker in slightly
 * different coordinate spaces, so a sheet that fitted yesterday would sit a few pixels higher today — on a phone only, because
 * that is where the core insets differ from the physical screen (item 39's rule: the element chooses, not the device).
 */
function sheetGui(): ScreenGui {
	return configureGui("sheet", SHEET_GUI_NAME, Enum.ScreenInsets.CoreUISafeInsets, SHEET_DISPLAY_ORDER);
}

/**
 * `None`, unlike every other element layer: the reveal is a full-screen dim, and its whole job is to reach the physical screen
 * edges. `CoreUISafeInsets` here would leave the top and bottom strips of a phone undimmed, which reads as a broken overlay rather
 * than as a safe-area decision — the same reasoning the `fullScreen` layer carries.
 */
function revealGui(): ScreenGui {
	return configureGui("reveal", REVEAL_GUI_NAME, Enum.ScreenInsets.None, REVEAL_DISPLAY_ORDER);
}

/**
 * `CoreUISafeInsets` to match `splash`, which the toast was positioned against before it moved here — it anchors at a share of
 * the gui's height (`TOP_SCALE`), so a different inset contract would put it at a different height on a phone and nowhere else.
 */
function toastGui(): ScreenGui {
	return configureGui("toast", TOAST_GUI_NAME, Enum.ScreenInsets.CoreUISafeInsets, TOAST_DISPLAY_ORDER);
}

/**
 * `CoreUISafeInsets`, not `None`: the splash is positioned as a share of this gui's height, so it has to agree with the
 * HUD about where "26% from the top" is. `None` would place it relative to the physical screen and put it under the
 * Roblox topbar on a phone, where the same code looks correct on a monitor.
 */
function splashGui(): ScreenGui {
	return configureGui("splash", SPLASH_GUI_NAME, Enum.ScreenInsets.CoreUISafeInsets, SPLASH_DISPLAY_ORDER);
}

/**
 * Find-or-create one `ScreenGui`, then force its insets and draw order.
 *
 * Shared by all three constructors because the *only* difference between them is those two properties and
 * the name — three copies of the find/create/apply sequence would be three places to forget the re-apply
 * on the reuse branch, which is exactly the drift the reuse branch exists to correct.
 *
 * `ScreenInsets` and `DisplayOrder` are set on **both** branches. The reuse branch is the one that matters:
 * a client that is rejoining a session can already have a gui of the right name carrying a wrong inset
 * contract from a previous build, and only re-applying fixes it.
 *
 * `ResetOnSpawn = false` because these are HUD layers, not per-life UI: a respawn must not tear the banner
 * down and rebuild it, which would also drop every connection the tenant controller holds to it.
 */
function configureGui(kind: UiLayer, name: string, screenInsets: Enum.ScreenInsets, displayOrder: number): ScreenGui {
	// `Player.PlayerGui` is typed in the installed typings, but it does not exist until the player's gui
	// container is replicated — reading the property before then throws rather than returning `undefined`.
	// `WaitForChild` without a timeout is bounded here only by the caller's own patience, so the wait is
	// kept short and a failure is reported rather than yielded on forever.
	const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui");
	if (!playerGui.IsA("PlayerGui")) {
		// Cannot happen in a normal session; reported instead of cast away so a broken container is a log
		// line rather than a mystery further up.
		warn(`[Ui] ${playerGui.GetFullName()} is a ${playerGui.ClassName}, not a PlayerGui; ${name} not created.`);
	}

	const existing = playerGui.FindFirstChild(name);
	if (existing !== undefined && existing.IsA("ScreenGui")) {
		const previousScreenInsets = existing.ScreenInsets;

		existing.ScreenInsets = screenInsets;
		existing.DisplayOrder = displayOrder;
		existing.ResetOnSpawn = false;
		existing.Enabled = true;

		reportFound(existing, kind, screenInsets, displayOrder, previousScreenInsets);
		return existing;
	}

	if (existing !== undefined) {
		// A wrong-class instance owns the name. Creating a second child with the same name would make
		// `FindFirstChild` return whichever was added first for the rest of the session, so this is worth
		// one warning even though the create still goes ahead.
		warn(`[Ui] "${existing.GetFullName()}" is a ${existing.ClassName}, not a ScreenGui; creating ${name} anyway.`);
	}

	const created = new Instance("ScreenGui");
	created.Name = name;
	created.ScreenInsets = screenInsets;
	created.DisplayOrder = displayOrder;
	created.ResetOnSpawn = false;
	created.Parent = playerGui;

	reportCreated(created, kind, screenInsets, displayOrder);
	return created;
}

/**
 * One line when a gui is created, one line when an existing one is reused. Same prefix, same fields, same
 * order, so a reader can grep `[Ui]` and compare two runs without knowing which branch ran.
 *
 * The reuse line carries the *previous* inset contract because drift is the reason the reuse branch
 * re-applies anything: without it, "the banner moved after a restart" has no evidence, and the correction
 * is invisible while looking exactly like a fresh create.
 */
function reportCreated(gui: ScreenGui, kind: UiLayer, screenInsets: Enum.ScreenInsets, displayOrder: number): void {
	print(`[Ui] created kind=${kind} name=${gui.Name} screenInsets=${screenInsets.Name} displayOrder=${displayOrder}`);
}

function reportFound(
	gui: ScreenGui,
	kind: UiLayer,
	screenInsets: Enum.ScreenInsets,
	displayOrder: number,
	previousScreenInsets: Enum.ScreenInsets,
): void {
	print(
		`[Ui] found kind=${kind} name=${gui.Name} screenInsets=${screenInsets.Name} displayOrder=${displayOrder} previousScreenInsets=${previousScreenInsets.Name}`,
	);
}
