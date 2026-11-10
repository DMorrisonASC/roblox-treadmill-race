import { Controller, OnStart } from "@flamework/core";
import { Players, TweenService, Workspace } from "@rbxts/services";
import { PLAYER_COINS_ATTRIBUTE } from "shared/attributes";
import { ballName, rarityLabel } from "shared/ball-name";
import { canAffordChests, chestBatchCost, Rarity, rarityOfBall } from "shared/economy.config";
import { getScreenGui } from "shared/ui/layers";
import { addChunkyRing, applyChunkyChrome, dimChunkyChrome, shadowOf } from "shared/ui/chunky-chrome";
import { FONT, SPACING, typographyOneStepUp } from "shared/ui/scale";
import { outlineText } from "shared/ui/text";
import { chunkyDarkTheme, Theme } from "shared/ui/theme";
import { panelScaleFor } from "shared/ui/ui-scale";
import { lockControls } from "client/controls-lock";
import { getConfettiController } from "client/controllers/confetti-controller";
import { attachClickSound } from "shared/ui/sounds";
import { attachPressFeedback } from "shared/ui/press";

/**
 * The chest's card-flip reveal: what the player sees when an `Open N` lands.
 *
 * ## What the animation is
 *
 * **A celebration of a fact, not a gamble.** The balls on the cards are the balls the server granted, in the order it granted
 * them — nothing here rolls, shuffles, prices or weights anything. The reply is the truth and this overlay is a presentation of
 * it, which is why the module reads `ballIds` and never touches `RARITY_WEIGHTS`, `BALL_POOL` or `chestOdds()`: a second
 * probability table computed at reveal time would be a second opinion about a number the server already decided (item 51's
 * rule — derive, do not duplicate).
 *
 * That constraint is what makes the sequence honest. When a card is still facedown it is **not** still undecided; it is a fact
 * being unwrapped. Every id is known before the first card moves, and `[Reveal] open … ids=…` prints all of them up front so a
 * report about "the reveal showed the wrong item" can be answered by comparing two lines of the same session.
 *
 * ## The three beats
 *
 * ```
 * Drop   every card starts at the screen centre, scale 0, and flies out to its grid cell
 * Tease  the grid holds, facedown, each card wearing its rarity ring — the colour-coded aura
 * Flip   each card turns over, in order, and shows its name and tier
 * ```
 *
 * ## Why the flip is `Size.X` and not `Rotation`
 *
 * **`GuiObject`'s `Rotation` property is a 2D spin, not a 3D axis.** Setting it turns the card like a page on a table: the text
 * goes sideways and the far edge shows the *same face*, mirrored — it never shows the back of anything. A `Frame` also has no
 * `CFrame` (that is a `BasePart` property), so there is no third thing to reach for.
 *
 * What actually reads as a card turning over is the width collapsing to nothing and coming back, with the face swapped at the
 * instant it is zero pixels wide — the moment nobody can see which face is which. That is what this controller does: `Size.X`
 * tweens to `0` over `FLIP_HALF_SECONDS`, the back face is hidden and the front shown, then `Size.X` tweens back to full. The
 * whole animation is 2D and always was; the brain supplies the third axis.
 *
 * **A `UIScale` cannot do this**, which is the other half of the argument: `UIScale` scales both axes together, so shrinking it
 * to zero shrinks the *height* as well and reads as a collapse, not a turn. The flip needs one axis, and `Size` is the only
 * property that offers one.
 *
 * ## Why the drop is a `UIScale` and the flip is `Size`
 *
 * They are different mechanisms because they must not fight over the same property. The drop is a pop from nothing — uniform,
 * both axes, and the splash already does exactly that (item 73), so it is a `UIScale` on the card's container. The flip needs
 * `Size.X` alone. If the drop also moved `Size`, the two would have to be sequenced through one property and the flip would
 * start from whatever the drop left behind; with a `UIScale` for one and `Size` for the other, the card's `Size` is *always*
 * its resting size and the flip is always the same tween.
 *
 * ## One card or ten is the same sequence
 *
 * The coin chest's `Open 1` and `Open 10` both answer with an array of ids, so there is no separate one-card path: a one-ball
 * reply is a one-cell grid whose only cell is the centre, and the sequence runs identically. Ten cards add stagger, not steps.
 */

/** The sheet's type scale, one step larger than the game scale, matching the store's own `PANEL_TYPE`. */
const PANEL_TYPE = typographyOneStepUp();

/** **Placeholder.** A card's width in pixels, matching the store's prize cards. */
const CARD_WIDTH = 200;

/** **Placeholder.** A card's height in pixels — art block, name line, tier line, inner padding and the chrome's depth. */
const CARD_HEIGHT = 260;

/** **Placeholder.** Height of the tinted art block inside a card. */
const CARD_ART = 150;

/** **Placeholder.** Diameter of the solid ball silhouette inside the art block. */
const BALL_SWATCH = 88;

/** **Placeholder.** Thickness of the rarity ring, in pixels. Item 118: this is a stroke on its own frame, not a second `UIStroke`. */
const RING_THICKNESS = 3;

/** **Placeholder.** The gap between two cards, both axes. */
const CARD_GAP = SPACING.sm;

/** **Placeholder.** How long one card takes to fly from the centre to its cell. */
const DROP_SECONDS = 0.35;

/** **Placeholder.** The delay between two cards starting their drop. */
const DROP_STAGGER_SECONDS = 0.06;

/** **Placeholder.** How long the finished grid holds facedown before the first flip. */
const TEASE_SECONDS = 0.45;

/** **Placeholder.** Half a flip: one `Size.X` tween, so a whole flip is twice this. */
const FLIP_HALF_SECONDS = 0.12;

/** **Placeholder.** The delay between two cards starting their flip. */
const FLIP_STAGGER_SECONDS = 0.08;

/**
 * **Placeholder.** How many confetti pieces the completed reveal throws, in one burst.
 *
 * **`80`.** The module's own default is `250` — `if typeof(amount) ~= "number" then amount = 250 end` — and the demo the user watched
 * shows roughly **60–80** large flat pieces, so `80` is the closest match to the effect they pointed at. `250` would be more faithful
 * to the module's *default argument* and less faithful to its *demo*; the demo is the target, and both numbers are named here so the
 * next reader can move this one number in either direction knowingly.
 *
 * The tree carried `204` before this: a number typed while the effect was drawing nothing at all, which is neither.
 */
const BURST_COUNT = 80;

/** **Placeholder.** The overlay's dim, as the user asked for it. */
const DIM_TRANSPARENCY = 0.5;

/** **Placeholder.** Footer button width, matching the store's chest buttons. */
const BUTTON_WIDTH = 170;

/** **Placeholder.** Footer button height: two lines of type plus the chrome's depth. */
const BUTTON_HEIGHT = 56;

/**
 * **Placeholder.** The strip at the bottom of the overlay the cards may not use — the footer's height plus a gap above it.
 *
 * One number rather than two, because the grid's box and the footer's position have to agree: the grid shrinks by this much and the
 * footer centres in what it gave up.
 */
const FOOTER_BAND = BUTTON_HEIGHT + SPACING.lg;

/**
 * **Placeholder.** The strip at the top of the overlay the cards may not use: the Roblox topbar plus a margin.
 *
 * The reveal layer is `ScreenInsets.None`, so its gui starts at the *physical* top of the screen and the topbar is drawn over it —
 * the cards have to be told to start below it, which is what this is. `64` clears the desktop topbar (`36`) with a margin and the
 * taller phone topbar as well; the grid is top-aligned against this value by its anchor, not centred against the leftover space, so
 * this is the top edge of the first row of cards rather than an inset to be halved.
 */
const GRID_TOP_INSET = 72;

/**
 * **Placeholder.** How much `Intermission` must remain for an `Open N` to be allowed to start a reveal.
 *
 * Derived rather than guessed: the ten-card sequence is `revealSeconds(10)` — about 2.3 s with the values above — and the rest of
 * the six is the player reading the last card and pressing `OK`. A reveal that begins inside this window would be cut by the
 * transition wipe at `TRANSITION_DISPLAY_ORDER`, which is exactly the case this check exists to avoid — so it is a refusal at the
 * button, with a status line, rather than a silent no-op.
 */
export const REVEAL_MIN_REMAINING_SECONDS = 6;

/** The overlay's whole lifetime, for a reply carrying `count` cards. Used for the log line and for tuning the gate above. */
export function revealSeconds(count: number): number {
	const cards = math.max(1, count);
	return (
		(cards - 1) * DROP_STAGGER_SECONDS +
		DROP_SECONDS +
		TEASE_SECONDS +
		(cards - 1) * FLIP_STAGGER_SECONDS +
		FLIP_HALF_SECONDS * 2
	);
}

const DROP_TWEEN = new TweenInfo(DROP_SECONDS, Enum.EasingStyle.Back, Enum.EasingDirection.Out);
const FLIP_CLOSE_TWEEN = new TweenInfo(FLIP_HALF_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.In);
const FLIP_OPEN_TWEEN = new TweenInfo(FLIP_HALF_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);

/**
 * Why a reveal ended. Every close path names itself, because "the cards vanished" is answered by this word and nothing else
 * in the log.
 */
type RevealCloseReason = "ok" | "open-again" | "phase" | "teardown";

/** What a caller must supply. The ids come from the server's reply and are never recomputed here. */
export interface RevealOptions {
	/** The ball ids the reply carried, in the order it carried them. */
	readonly ballIds: Array<string>;
	/** How many the player asked for, for the log line and the `Open Again` price. */
	readonly count: number;
	/**
	 * Re-fires the same `Open N`. **The shop owns the remote and its guard**, so this is a callback rather than a remote here:
	 * a second firing path would be a second place for the `busy` guard and the policy gate to be got wrong.
	 *
	 * A refused re-fire calls nothing back, and the reveal stays open exactly as it was — the footer re-dims itself from the
	 * coin attribute, so "you cannot afford another" is visible on the button the player is pressing.
	 */
	readonly onOpenAgain: () => void;
}

/** One card, as the sequence needs to hold it. */
interface RevealCard {
	/** The container that moves, scales and gets its width tweened. */
	readonly root: Frame;
	/** The drop's `UIScale` — a different object from the card's `Size`, see the module docblock. */
	readonly dropScale: UIScale;
	/** Always facedown at first, then always faceup. */
	readonly back: Frame;
	readonly front: Frame;
	readonly ballId: string;
	readonly rarity: Rarity;
	/** The target `Position` in the grid, so the drop has somewhere to go. */
	readonly target: UDim2;
}

/**
 * The live controller, for the one caller that needs it.
 *
 * ## Why a module local and not `@Dependency`
 *
 * No controller in this tree injects another — the client talks to the server through remotes and reads shared values, and the
 * one cross-controller fact it needs (the phase) is read from `ReplicatedStorage` by whoever wants it. Introducing Flamework's
 * DI for a single edge would make this the only controller with a constructor, and `flamework.build` would have to carry the
 * singleton flip for it. A module local set in `onStart` is the smaller lie, and it is read lazily at press time so the boot
 * order between this controller and the shop cannot matter.
 */
let active: RevealController | undefined;

/**
 * Records the live controller. Called from `onStart` and from nowhere else.
 *
 * A named setter rather than `active = this` inside the class: `@typescript-eslint/no-this-alias` refuses the direct assignment,
 * and the rule is right — an alias and a registration are different intentions, and only one of them is what this is.
 */
function registerReveal(controller: RevealController): void {
	active = controller;
}

/** The reveal, if it has started. `undefined` before `onStart` and in a test harness that never ignited. */
export function getRevealController(): RevealController | undefined {
	return active;
}

@Controller()
export class RevealController implements OnStart {
	private readonly theme: Theme = chunkyDarkTheme();

	/** The dim, while a reveal is up. Its existence *is* the "one overlay at a time" state. */
	private dim?: Frame;

	/**
	 * The grid host, while a reveal is up.
	 *
	 * Held for one reason: the confetti's emitter is the grid's centre, and the only honest way to find that is to read the host's
	 * live `AbsolutePosition`/`AbsoluteSize` at the moment the last card flips — recomputing it from the fit scale would be a second
	 * copy of `buildGrid`'s arithmetic, free to disagree with it.
	 */
	private grid?: Frame;

	/**
	 * The highest `ZIndex` any card reached, so the confetti can be put one above it.
	 *
	 * **Read from the cards as they are built, not hard-coded.** `applyChunkyChrome` puts the face at its `zIndex + 1`,
	 * `addChunkyRing` puts the ring above that, and this file's own card content sits above both — a number this file cannot know by
	 * arithmetic alone, and one that moves the moment a card gains a layer.
	 */
	private cardTopZIndex = 0;

	/**
	 * Which cards throw confetti, 1-based — computed at open from the card count and printed at open, so the schedule in the log and the
	 * bursts in the log are the same array rather than two copies of a rule (item 170).
	 */
	private confettiAt = new Array<number>();

	/**
	 * The cards that have already fired, so one card cannot fire twice.
	 *
	 * Cleared on every open — including the `Open Again` rebuild — which is what makes a re-opened reveal fire its schedule from card 1
	 * again. A set that survived would silence the first burst of the next open, and the symptom would be "the second open has no
	 * confetti at all".
	 */
	private readonly confettiFired = new Set<number>();

	private readonly cards = new Array<RevealCard>();

	/**
	 * Bumped on every open and every close, and every deferred step checks it before acting.
	 *
	 * `task.delay` cannot be cancelled, and the sequence has up to twenty of them queued (ten drops, ten flips) plus a `Completed`
	 * on every flip tween. Without a token, a reveal closed at `OK` would still be having its cards tweened a second later by the
	 * callbacks of a frame that no longer exists — the failure that makes a `Destroy()`d instance throw inside a `TweenService`
	 * callback rather than at the point of the bug.
	 */
	private generation = 0;

	/** The footer's `Open Again`, so the affordability refresh can restyle it without a second lookup. */
	private againButton?: TextButton;

	/** The footer's price line: the price, or `have/price` when it is unaffordable (item 66's pattern). */
	private againPriceLabel?: TextLabel;

	/** The ball count the current reveal represents, so `Open Again` re-fires the same one. */
	private count = 1;

	/** Re-fires the opener. Replaced on every `show`, because `Open Again` is always "the same `Open N`". */
	private reopen: (() => void) | undefined;

	/** The movement lock's release, while a reveal is up. Counted with the store's own hold — see `controls-lock.ts`. */
	private controlsRelease?: () => void;

	public onStart(): void {
		registerReveal(this);
		Players.LocalPlayer.GetAttributeChangedSignal(PLAYER_COINS_ATTRIBUTE).Connect(() => {
			this.refreshAgainButton();
		});
	}

	/** Whether a reveal is up. The shop asks this before firing a remote, so one overlay really is one remote. */
	public isOpen(): boolean {
		return this.dim !== undefined;
	}

	/**
	 * Shows the reveal for a reply.
	 *
	 * **Called while one is already up**, it closes the old one first and opens the new one from the new ids. That is not a
	 * second overlay — it is `Open Again` succeeding, which the shop can only reach through this overlay's own footer, so the
	 * close reason is always `open-again`. A second *button press* cannot get here: the shop refuses to fire while `isOpen()`.
	 */
	public show(options: RevealOptions): void {
		const ids = options.ballIds;
		if (ids.size() === 0) {
			print("[Reveal] refused reason=empty-reply");
			return;
		}

		if (this.dim !== undefined) {
			// **The hold is kept across a replace.** This is `Open Again` landing: the old overlay is torn down and the new one built in
			// the same call, so releasing the movement lock and immediately taking it again would hand the thumbstick back for one
			// frame — visible as a flash of the touch controls in the middle of the celebration.
			this.close("open-again", true);
		}

		this.count = options.count;
		this.reopen = options.onOpenAgain;
		// Reset before the cards are built: it is a maximum over this reveal's cards, and carrying the previous reveal's value into a
		// smaller one would put the confetti one layer too high for no reason.
		this.cardTopZIndex = 0;
		// **A new reveal gets a new schedule and an empty fired-set.** The rebuild after `Open Again` goes through here, which is what
		// makes the second open throw its confetti from card 1 rather than none at all.
		this.confettiAt = this.confettiCards(ids.size());
		this.confettiFired.clear();

		const gui = getScreenGui("reveal");
		const viewport = this.viewport();

		const dim = new Instance("Frame");
		dim.Name = "RevealOverlay";
		dim.Size = UDim2.fromScale(1, 1);
		dim.BackgroundColor3 = new Color3(0, 0, 0);
		dim.BackgroundTransparency = DIM_TRANSPARENCY;
		dim.BorderSizePixel = 0;
		// Non-interactive itself: the cards are the only things in here a touch can land on, and the `OK` button is above them.
		// (There is no `ScreenGui.Modal` in this tree's typings — item 161 found it on `GuiButton`, where it means a cursor-lock
		// rule, so movement is taken away by `lockControls`, not by this frame.)
		dim.Active = false;
		dim.ZIndex = 1;
		dim.Parent = gui;
		this.dim = dim;

		this.controlsRelease = lockControls();
		this.generation += 1;
		const generation = this.generation;

		this.buildGrid(dim, ids, viewport);
		this.buildFooter(dim);

		print(`[Reveal] open chest=coin count=${options.count} ids=${ids.join(",")}`);
		// **The schedule, printed once so a report can read it against the `[Confetti] burst` lines.** It is the same array that decides
		// the bursts, not a second statement of the rule — `at=1` for one card, `at=1,6` for ten, and `at=` for a reply that somehow
		// carried no cards (which `show` refuses before it gets here, so that branch is a guard rather than a path).
		print(`[Reveal] confetti schedule cards=${ids.size()} at=${this.confettiAt.join(",")}`);

		this.runSequence(generation);
	}

	/** Closes on the `OK` button. */
	public closeOnOk(): void {
		this.close("ok");
	}

	/**
	 * Closes because the phase left `Intermission`.
	 *
	 * The reveal cannot block that change — the phase is server-side and the wipe is already on its way — so this is the clean
	 * exit for the case the `Intermission` gate could not prevent: the frame is destroyed, the movement lock released, and the
	 * player sees the wipe do its job.
	 */
	public closeForPhase(): void {
		if (this.dim === undefined) {
			return;
		}

		this.close("phase");
	}

	/**
	 * Tears the overlay down. **The only place any of it is undone**, so `OK`, `Open Again`, a phase change and a teardown cannot
	 * drift apart.
	 *
	 * `keepLock` exists for exactly one caller: `show` replacing an open reveal in the same call, which is about to take the same
	 * hold again and must not blink the movement lock in between.
	 */
	private close(reason: RevealCloseReason, keepLock = false): void {
		const dim = this.dim;
		if (dim === undefined) {
			return;
		}

		this.dim = undefined;
		this.grid = undefined;
		this.generation += 1;
		this.cards.clear();
		this.againButton = undefined;
		this.againPriceLabel = undefined;
		this.reopen = undefined;
		// The schedule dies with the reveal: a `task.delay` that survives the close checks the generation *and* finds an empty schedule,
		// so a torn-down reveal cannot fire a burst whatever order those two arrivals take.
		this.confettiAt = new Array<number>();
		this.confettiFired.clear();

		// **This is also the confetti's teardown.** Any burst fired into this frame is a child of it, so `Destroy()` takes the clones
		// with it — and the confetti controller's own `Destroying` hook drops its books in the same instant rather than a frame later.
		dim.Destroy();

		if (!keepLock) {
			const release = this.controlsRelease;
			this.controlsRelease = undefined;
			if (release !== undefined) {
				release();
			}
		}

		print(`[Reveal] close reason=${reason}`);
	}

	// #region the grid

	/**
	 * Builds every card inside the overlay.
	 *
	 * The grid is decided **now**, from the viewport, and not at boot: a rotate during a reveal is a real case, and reading the
	 * orientation once at startup would put a portrait grid on a landscape screen for the rest of the session. The reveal is short
	 * enough that a mid-reveal rotate is a shrug — the cards stay where they were laid out — which is why this reads the viewport
	 * here and not through a `ViewportSize` subscription.
	 */
	private buildGrid(dim: Frame, ids: Array<string>, viewport: Vector2): void {
		const columns = gridColumns(ids.size(), viewport);
		const rows = gridRows(ids.size(), viewport);
		const extent = gridExtent(columns, rows);

		// What the grid is allowed to occupy: the screen, less the strip the topbar sits in and the strip the footer sits in. The fit
		// scale is measured against this rather than against the whole viewport, so "the cards, the topbar and the footer" is what has
		// to fit — ten cards on a phone shrink because the buttons are below them, not in spite of it.
		const available = new Vector2(viewport.X, math.max(1, viewport.Y - GRID_TOP_INSET - FOOTER_BAND));

		const host = new Instance("Frame");
		host.Name = "Grid";
		// **The host is exactly the grid's own box, and it is anchored where it must not move.** Both halves of that matter:
		//
		// - **Its `Size` is the grid's extent, not the screen's.** The cards position themselves at a share of this frame, so a host
		//   the size of the screen would put the first row in the middle of it. Sized to the grid, `0.5` *is* the grid's centre.
		// - **`AnchorPoint` is `(0.5, 0)`, and that is the fix for the first Studio run.** `UIScale` shrinks a frame about its
		//   `AnchorPoint`, not about its centre: a host anchored at `(0, 0)` keeps its top-left corner nailed to the overlay's
		//   top-left and pulls every centred child up and to the left by `(1 - scale) / 2` of the box. That is exactly what the first
		//   run showed — a correct `5 x 2` grid sitting off the top-left corner of the screen. Anchored horizontally at `0.5` the
		//   centre is pinned instead, so the shrink happens inward from both sides; anchored at `0` vertically the top edge stays put,
		//   which is what "top middle" means.
		host.AnchorPoint = new Vector2(0.5, 0);
		host.Position = new UDim2(0.5, 0, 0, GRID_TOP_INSET);
		host.Size = UDim2.fromOffset(extent.X, extent.Y);
		host.BackgroundTransparency = 1;
		host.BorderSizePixel = 0;
		host.ZIndex = 2;
		host.Parent = dim;
		this.grid = host;

		// One `UIScale` for the whole grid, and it is a different object from the per-card drop `UIScale` — the same argument as the
		// module docblock: one property, one owner. This one is the accepted mobile answer (`panelScaleFor`, item 160), reused rather
		// than reinvented, so ten 200-pixel cards on a phone shrink instead of running off the screen — and because a `UIScale`
		// multiplies type and stroke as well as size, the labels shrink with the cards rather than clipping out of them.
		const fit = new Instance("UIScale");
		fit.Scale = panelScaleFor(available, extent);
		fit.Parent = host;

		const stepX = CARD_WIDTH + CARD_GAP;
		const stepY = CARD_HEIGHT + CARD_GAP;
		const originX = -((columns - 1) / 2) * stepX;
		const originY = -((rows - 1) / 2) * stepY;

		for (let index = 0; index < ids.size(); index++) {
			const column = index % columns;
			const row = math.floor(index / columns);
			const target = new UDim2(0.5, originX + column * stepX, 0.5, originY + row * stepY);
			this.cards.push(this.buildCard(host, ids[index], target));
		}
	}

	/** One card: a container that moves and turns, a chunky face, and the two faces the flip swaps. */
	private buildCard(host: Frame, ballId: string, target: UDim2): RevealCard {
		const rarity = rarityOfBall(ballId) ?? "common";
		const tint = this.theme.colors.rarity[rarity];

		// The container is the thing the sequence animates. It carries the drop's `UIScale` and its own `Size` — the flip owns the
		// second and nothing else may write it.
		const root = new Instance("Frame");
		root.Name = `Card_${ballId}`;
		root.AnchorPoint = new Vector2(0.5, 0.5);
		root.Position = UDim2.fromScale(0.5, 0.5);
		root.Size = UDim2.fromOffset(CARD_WIDTH, CARD_HEIGHT);
		root.BackgroundTransparency = 1;
		root.BorderSizePixel = 0;
		root.ZIndex = 3;
		root.Parent = host;

		const dropScale = new Instance("UIScale");
		dropScale.Scale = 0;
		dropScale.Parent = root;

		// A `TextButton` because `applyChunkyChrome` decorates a `GuiButton`, and inactive because a card has nothing to press in this
		// round — the flip is automatic. `Active = false` means no `Activated` and no hover cursor, while the chrome still draws.
		const button = new Instance("TextButton");
		button.Name = "Face";
		button.Size = UDim2.fromScale(1, 1);
		button.BackgroundTransparency = 1;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Active = false;
		button.Text = "";
		button.ZIndex = 3;
		button.Parent = root;

		const chrome = applyChunkyChrome(button, {
			color: this.theme.paint.card.color,
			shadowColor: shadowOf(this.theme.paint.card.color),
			zIndex: 3,
			corner: SPACING.xs,
		});

		// Item 118: the ring is its own transparent frame with its own stroke. A second `UIStroke` on the chromed face would be
		// silently outranked by the chunky outline already on it.
		addChunkyRing(chrome.face, tint, RING_THICKNESS);

		const back = this.buildFace(chrome.face, ballId, rarity, false);
		const front = this.buildFace(chrome.face, ballId, rarity, true);

		return { root, dropScale, back, front, ballId, rarity, target };
	}

	/**
	 * One side of a card. Both sides carry the same tinted art block, because the tint is the rarity and the rarity is the point of
	 * the hold; only the front adds the name and the tier.
	 *
	 * **No probability anywhere.** The reply does not carry one, and deriving it here would be a second probability table
	 * disagreeing with the server's roll (item 51).
	 */
	private buildFace(parent: Frame, ballId: string, rarity: Rarity, revealed: boolean): Frame {
		const tint = this.theme.colors.rarity[rarity];
		const z = parent.ZIndex;

		const face = new Instance("Frame");
		face.Name = revealed ? "Front" : "Back";
		face.Size = UDim2.fromScale(1, 1);
		face.BackgroundTransparency = 1;
		face.BorderSizePixel = 0;
		face.ZIndex = z;
		face.Visible = !revealed;
		face.Parent = parent;

		const art = new Instance("Frame");
		art.Name = "Art";
		art.AnchorPoint = new Vector2(0.5, 0);
		art.Position = new UDim2(0.5, 0, 0, SPACING.sm);
		art.Size = new UDim2(1, -SPACING.sm * 2, 0, CARD_ART);
		art.BackgroundColor3 = tint;
		// The revealed side is denser: the dim behind the overlay washes everything 50%, so the face a player is meant to read needs
		// more tint than the one they are only meant to notice.
		art.BackgroundTransparency = revealed ? 0.72 : 0.84;
		art.BorderSizePixel = 0;
		art.ZIndex = z + 1;
		art.Parent = face;

		const artCorner = new Instance("UICorner");
		artCorner.CornerRadius = new UDim(0, SPACING.sm);
		artCorner.Parent = art;

		const ball = new Instance("Frame");
		ball.Name = "Ball";
		ball.AnchorPoint = new Vector2(0.5, 0.5);
		ball.Position = UDim2.fromScale(0.5, 0.5);
		ball.Size = UDim2.fromOffset(BALL_SWATCH, BALL_SWATCH);
		ball.BackgroundColor3 = tint;
		ball.BorderSizePixel = 0;
		ball.ZIndex = z + 2;
		ball.Parent = art;

		const ballCorner = new Instance("UICorner");
		ballCorner.CornerRadius = new UDim(1, 0);
		ballCorner.Parent = ball;

		if (!revealed) {
			// The facedown card says nothing. Its rarity is the ring around the whole card, which is the aura the user described — the
			// colour is a tease, not a label, because ten cards each carrying their own name would give the whole set away at once.
			return face;
		}

		const name = new Instance("TextLabel");
		name.Name = "Name";
		name.AnchorPoint = new Vector2(0, 1);
		name.Position = new UDim2(0, 0, 1, -PANEL_TYPE.caption.lineHeight * 2 - SPACING.xs);
		name.Size = new UDim2(1, 0, 0, PANEL_TYPE.h6.lineHeight);
		name.BackgroundTransparency = 1;
		name.Font = FONT;
		name.TextSize = PANEL_TYPE.h6.size;
		name.TextColor3 = this.theme.colors.textPrimary;
		name.TextXAlignment = Enum.TextXAlignment.Center;
		name.TextYAlignment = Enum.TextYAlignment.Center;
		name.TextTruncate = Enum.TextTruncate.AtEnd;
		name.Text = ballName(ballId);
		name.ZIndex = z + 3;
		name.Parent = face;

		// The card's highest layer, recorded as it is built so the confetti can be one above it. See `cardTopZIndex`.
		this.cardTopZIndex = math.max(this.cardTopZIndex, name.ZIndex);

		const sizeConstraint = new Instance("UITextSizeConstraint");
		sizeConstraint.MaxTextSize = PANEL_TYPE.h6.size;
		sizeConstraint.Parent = name;

		outlineText(name);

		const tier = new Instance("TextLabel");
		tier.Name = "Tier";
		tier.AnchorPoint = new Vector2(0, 1);
		tier.Position = UDim2.fromScale(0, 1);
		tier.Size = new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight);
		tier.BackgroundTransparency = 1;
		tier.Font = FONT;
		tier.TextSize = PANEL_TYPE.caption.size;
		// The rarity's own colour, so the label agrees with the ring around it rather than being a second opinion about the tier.
		tier.TextColor3 = tint;
		tier.TextXAlignment = Enum.TextXAlignment.Center;
		tier.TextYAlignment = Enum.TextYAlignment.Center;
		tier.Text = rarityLabel(rarity);
		tier.ZIndex = z + 3;
		tier.Parent = face;

		const tierConstraint = new Instance("UITextSizeConstraint");
		tierConstraint.MaxTextSize = PANEL_TYPE.caption.size;
		tierConstraint.Parent = tier;

		outlineText(tier);

		return face;
	}

	// #endregion

	// #region the sequence

	/**
	 * Drop, tease, flip — every step deferred, every step guarded by the generation token.
	 *
	 * **The tease is one beat for the whole grid, not one per card.** Each card holding for its own `TEASE_SECONDS` after landing
	 * would start the first flip while the last card was still flying in, and the sequence would read as two overlapping animations
	 * rather than three beats. So the hold is measured from the moment the *last* card lands.
	 */
	private runSequence(generation: number): void {
		for (let index = 0; index < this.cards.size(); index++) {
			const card = this.cards[index];
			task.delay(index * DROP_STAGGER_SECONDS, () => {
				if (generation !== this.generation) {
					return;
				}

				TweenService.Create(card.root, DROP_TWEEN, { Position: card.target }).Play();
				TweenService.Create(card.dropScale, DROP_TWEEN, { Scale: 1 }).Play();
			});
		}

		const teaseStart = (this.cards.size() - 1) * DROP_STAGGER_SECONDS + DROP_SECONDS;

		for (let index = 0; index < this.cards.size(); index++) {
			const card = this.cards[index];
			task.delay(teaseStart + TEASE_SECONDS + index * FLIP_STAGGER_SECONDS, () => {
				if (generation !== this.generation) {
					return;
				}

				this.flip(generation, card, index);
			});
		}
	}

	/** One card's turn: collapse, swap faces, expand. See the module docblock for why this is `Size.X` and not `Rotation`. */
	private flip(generation: number, card: RevealCard, index: number): void {
		// **The confetti rides the flip's start, not the sequence's end (item 170).** This is the first line of the flip — before the
		// closing tween is created, so it is the instant the card begins to turn rather than the instant it finishes. `flip` is called
		// from the staggered `task.delay` above, which is the only "a card has started" event the sequence has: there is no per-card
		// signal to hook, the stagger *is* the schedule.
		//
		// The index is 1-based here because the schedule and its log line are written for a reader — `at=1,6` — and the internal `index`
		// is 0-based. One conversion, at the only place it is needed.
		this.fireConfetti(index + 1);

		const closing = TweenService.Create(card.root, FLIP_CLOSE_TWEEN, { Size: UDim2.fromOffset(0, CARD_HEIGHT) });

		closing.Completed.Connect(() => {
			if (generation !== this.generation) {
				return;
			}

			// The instant the card is zero pixels wide: nobody can see which face is which, so this is the only correct moment to swap.
			card.back.Visible = false;
			card.front.Visible = true;

			print(`[Reveal] flip card=${index + 1} id=${card.ballId} rarity=${card.rarity}`);

			TweenService.Create(card.root, FLIP_OPEN_TWEEN, {
				Size: UDim2.fromOffset(CARD_WIDTH, CARD_HEIGHT),
			}).Play();
		});

		closing.Play();
	}

	/**
	 * The card numbers a reveal throws confetti at — **the two bursts of `Open 10`, and the one of `Open 1`.** 1-based.
	 *
	 * The rule is `1`, then the **first card of the second half**: `math.floor(count / 2) + 1`. For ten that is `6`, so the two bursts
	 * bracket the ten flips into two halves of five; `math.ceil(count / 2)` would give `5`, which is the *last* card of the first half
	 * and starts the second burst before the first one has finished reading. For one card the second entry does not exist.
	 *
	 * It lives here, and is printed at open, so the schedule and the bursts cannot disagree: the same array decides both.
	 */
	private confettiCards(count: number): Array<number> {
		if (count <= 0) {
			return new Array<number>();
		}

		if (count === 1) {
			return [1];
		}

		return [1, math.floor(count / 2) + 1];
	}

	/**
	 * Fires the burst for a card starting its flip, if that card is on the schedule and has not fired already.
	 *
	 * ## Why the burst is here and not at the end of the sequence
	 *
	 * It used to fire from the last card's expand `Completed` (item 165): every id shown, every card the right way up, then a
	 * celebration. The effect of that was a reveal that finished and *then* threw confetti at the player — an epilogue, arriving after
	 * the moment it was celebrating. Fired at a flip's start instead, the confetti is the flourish *of* the turn: it is already in the
	 * air as the first card shows its face, and the second burst carries the second half.
	 *
	 * ## The two guards
	 *
	 * - **`confettiFired`** is a per-reveal set of card numbers. `flip` is reached from a `task.delay` per card, and a second call for
	 *   the same index — a restart, a re-entered sequence — would otherwise throw a second burst for one card. The set is cleared when
	 *   a reveal opens, which is also what makes `Open Again` correct: the rebuilt reveal starts at card 1 with an empty set.
	 * - **the generation check** is the same one every deferred step uses: `close` bumps it, so a reveal torn down between the
	 *   stagger's delay and its flip cannot fire a burst at all.
	 *
	 * The `dim`/`grid`/`confetti` presence test stays, because "no confetti" has three causes and only one of them is in the other
	 * file — a torn-down reveal, or a confetti controller that never booted.
	 */
	private fireConfetti(cardNumber: number): void {
		if (!this.confettiAt.includes(cardNumber) || this.confettiFired.has(cardNumber)) {
			return;
		}

		const dim = this.dim;
		const grid = this.grid;
		const confetti = getConfettiController();

		if (dim === undefined || grid === undefined || confetti === undefined) {
			print(
				`[Reveal] confetti skipped card=${cardNumber} dim=${dim !== undefined} grid=${grid !== undefined} confetti=${confetti !== undefined}`,
			);
			return;
		}

		this.confettiFired.add(cardNumber);

		// The grid's centre in the overlay's own pixels. **The confetti no longer uses it to place anything** — item 169 made the spawn
		// full-screen, as the module's is — but it is passed anyway: it is what the burst's log line prints, and a report reading
		// `[Confetti] burst … position=…` should see the reveal's centre rather than a zero.
		const centre = grid.AbsolutePosition.add(grid.AbsoluteSize.mul(0.5)).sub(dim.AbsolutePosition);

		confetti.burst(dim, centre, BURST_COUNT, this.cardTopZIndex + 1);
	}

	// #endregion

	// #region the footer

	/**
	 * `OK` and `Open Again`, side by side under the grid.
	 *
	 * `Open Again` is the same `Open N` the shot came from, so it re-fires through the shop's own path — the same remote, the same
	 * `busy` guard, the same balance check. Anything else would be a second way to spend coins.
	 */
	private buildFooter(dim: Frame): void {
		const footer = new Instance("Frame");
		footer.Name = "Footer";
		// Centred in the band the grid gave up — see `FOOTER_BAND`. Anchored at its own centre so the two buttons' `UIListLayout` does
		// not need to know the band's height.
		footer.AnchorPoint = new Vector2(0.5, 0.5);
		footer.Position = new UDim2(0.5, 0, 1, -FOOTER_BAND / 2);
		footer.Size = UDim2.fromOffset(BUTTON_WIDTH * 2 + SPACING.md, BUTTON_HEIGHT);
		footer.BackgroundTransparency = 1;
		footer.BorderSizePixel = 0;
		footer.ZIndex = 20;
		footer.Parent = dim;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Horizontal;
		layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		layout.VerticalAlignment = Enum.VerticalAlignment.Center;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.md);
		layout.Parent = footer;

		const ok = this.buildFooterButton(footer, "Ok", "OK", 1, false);
		ok.Activated.Connect(() => this.closeOnOk());

		const again = this.buildFooterButton(footer, "Again", "Open Again", 2, true);
		this.againButton = again;
		again.Activated.Connect(() => this.pressAgain());

		this.refreshAgainButton();
	}

	private buildFooterButton(
		parent: Frame,
		name: string,
		action: string,
		order: number,
		wantsPrice: boolean,
	): TextButton {
		const button = new Instance("TextButton");
		button.Name = name;
		button.Size = UDim2.fromOffset(BUTTON_WIDTH, BUTTON_HEIGHT);
		button.BackgroundTransparency = 1;
		button.BorderSizePixel = 0;
		button.AutoButtonColor = false;
		button.Text = "";
		button.LayoutOrder = order;
		button.ZIndex = 20;
		button.Parent = parent;

		const chrome = applyChunkyChrome(button, {
			color: this.theme.colors.accent,
			shadowColor: shadowOf(this.theme.colors.accent),
			zIndex: 20,
		});

		attachPressFeedback(button);
		attachClickSound(button);

		const stack = new Instance("UIListLayout");
		stack.FillDirection = Enum.FillDirection.Vertical;
		stack.HorizontalAlignment = Enum.HorizontalAlignment.Center;
		stack.VerticalAlignment = Enum.VerticalAlignment.Center;
		stack.SortOrder = Enum.SortOrder.LayoutOrder;
		stack.Padding = new UDim(0, 0);
		stack.Parent = chrome.face;

		const top = new Instance("TextLabel");
		top.Name = "Action";
		top.Size = new UDim2(1, 0, 0, PANEL_TYPE.body1.lineHeight);
		top.BackgroundTransparency = 1;
		top.Font = FONT;
		top.TextSize = PANEL_TYPE.body1.size;
		top.TextColor3 = this.theme.colors.onAccent;
		top.TextXAlignment = Enum.TextXAlignment.Center;
		top.TextYAlignment = Enum.TextYAlignment.Center;
		top.Text = action;
		top.ZIndex = 22;
		top.Parent = chrome.face;

		outlineText(top);

		if (wantsPrice) {
			const price = new Instance("TextLabel");
			price.Name = "Price";
			price.Size = new UDim2(1, 0, 0, PANEL_TYPE.caption.lineHeight);
			price.BackgroundTransparency = 1;
			price.Font = FONT;
			price.TextSize = PANEL_TYPE.caption.size;
			price.TextColor3 = this.theme.colors.onAccent;
			price.TextXAlignment = Enum.TextXAlignment.Center;
			price.TextYAlignment = Enum.TextYAlignment.Center;
			price.Text = tostring(chestBatchCost(this.count));
			price.ZIndex = 22;
			price.Parent = chrome.face;

			outlineText(price);

			this.againPriceLabel = price;
		}

		return button;
	}

	/**
	 * `Open Again`, or nothing at all.
	 *
	 * **A disabled press plays nothing and logs nothing** — the button is `Active = false` in that state, so `Activated` never fires
	 * and there is no code path here that could fire a remote a player cannot pay for. That is item 66's rule, moved onto this
	 * footer: the reason is on the control (`have/price`), and the control is not pressable.
	 */
	private pressAgain(): void {
		const reopen = this.reopen;
		if (reopen === undefined) {
			return;
		}

		reopen();
	}

	/**
	 * Restyles the footer from the balance attribute.
	 *
	 * Subscribed rather than polled, and re-run on every `show`, because the balance changes *under* an open reveal: the chest that
	 * opened it just spent the coins, so the first frame of the footer must already show the reduced balance rather than the one
	 * that was true a moment ago.
	 */
	private refreshAgainButton(): void {
		const button = this.againButton;
		if (button === undefined) {
			return;
		}

		const price = chestBatchCost(this.count);
		const coins = this.coins();
		const known = coins !== undefined;
		const affordable = known && canAffordChests(coins, this.count);
		const enabled = affordable;

		button.Active = enabled;
		dimChunkyChrome(button, !enabled);

		const label = this.againPriceLabel;
		if (label !== undefined) {
			// Item 66's `have/price`, so "why is this dim" is answered by the button itself: `480/1000`.
			label.Text = affordable || !known ? tostring(price) : `${coins}/${price}`;
		}
	}

	/** The local balance, or `undefined` while it is unknown — loading, read-only, or never published. */
	private coins(): number | undefined {
		const coins = Players.LocalPlayer.GetAttribute(PLAYER_COINS_ATTRIBUTE);
		return typeIs(coins, "number") ? coins : undefined;
	}

	// #endregion

	// #region geometry

	/** The viewport the grid is laid out against, read at open time (not at boot), so a rotate is picked up by the next reveal. */
	private viewport(): Vector2 {
		const camera = Workspace.CurrentCamera;
		if (camera !== undefined && camera.ViewportSize.X > 0 && camera.ViewportSize.Y > 0) {
			return camera.ViewportSize;
		}

		const gui = getScreenGui("reveal");
		return new Vector2(gui.AbsoluteSize.X, gui.AbsoluteSize.Y);
	}

	// #endregion
}

/**
 * How many cards sit side by side.
 *
 * Landscape is the wide arrangement — **two rows of many columns** — and a portrait phone gets two columns and however many rows
 * that needs. One card is one cell either way. Verified against `ViewportSize` at open time; see `RevealController.viewport`.
 */
function gridColumns(count: number, viewport: Vector2): number {
	if (count <= 1) {
		return 1;
	}

	const landscape = viewport.X >= viewport.Y;
	return landscape ? math.ceil(count / 2) : math.min(2, count);
}

/** The rows implied by `gridColumns` — kept a separate function so the two cannot disagree. */
function gridRows(count: number, viewport: Vector2): number {
	if (count <= 1) {
		return 1;
	}

	return math.ceil(count / gridColumns(count, viewport));
}

/** The grid's own pixel size, which is what `panelScaleFor` shrinks to fit. */
function gridExtent(columns: number, rows: number): Vector2 {
	return new Vector2(
		columns * CARD_WIDTH + math.max(0, columns - 1) * CARD_GAP,
		rows * CARD_HEIGHT + math.max(0, rows - 1) * CARD_GAP,
	);
}
