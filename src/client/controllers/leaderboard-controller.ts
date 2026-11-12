import { Debris, Players, ReplicatedStorage, TweenService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { LeaderboardEntry } from "shared/leaderboard";
import { LEADERBOARD_UPDATE_REMOTE_NAME, REMOTES_FOLDER_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { getOrdinal } from "shared/ordinal";
import { FONT, SPACING, typographyOneStepUp } from "shared/ui/scale";
import { chunkyDarkTheme } from "shared/ui/theme";
import { getScreenGui } from "shared/ui/layers";
import { buildChunkyPanel } from "shared/ui/chunky-panel";
import { applyPanelScale } from "shared/ui/ui-scale";
import { addChunkyRing } from "shared/ui/chunky-chrome";
import { outlineText } from "shared/ui/text";

/** The one phase the board belongs to. A client cannot import the server's `RoundPhase`. */
const PHASE_PLAYING = "Playing";

/**
 * **Placeholder.** Rows visible before the list scrolls.
 *
 * **A viewport, not a cap.** The first version used this number to *discard* everything past the fifth racer, which hid most
 * of the field on a busy belt. Every body now gets a row; this decides only how tall the window is.
 */
const VISIBLE_ROWS = 5;

/** **Placeholder.** Height of one row, in pixels. Fixed, because a row is a layout item and nothing animates its size. */
const ROW_HEIGHT = 30;

/** **Placeholder.** Gap between rows, matched by the list layout so a slide closes its own gap. */
const ROW_GAP = SPACING.xs;

/**
 * **Placeholder.** Width of the rank column, in pixels.
 *
 * Sized for the widest ordinal the board can show (`12th` at `TOP_ROWS = 5`, so realistically two digits) in the caption size.
 * Fixed rather than automatic so the name column starts at the same x on every row - a column that shifts by one digit is the
 * thing that makes a leaderboard look untidy.
 */
const RANK_WIDTH = 28;

/** **Placeholder.** The panel's width. Wide enough for `12th`, a fifteen-character name and a three-digit distance. */
const PANEL_WIDTH = 210;

/**
 * **Placeholder.** Duration of a slide, in seconds.
 *
 * `0.3` with an out-ease, against a one-second broadcast: the motion finishes with `0.7`s of stillness, so a rank change
 * reads as a decision rather than as a shudder. Longer than the broadcast interval and two rows would still be travelling
 * when the next order arrived, which is the failure the old flip had.
 */
const SLIDE_SECONDS = 0.3;

/** **Placeholder.** How long a row takes to appear or leave. Two thirds of a slide, so a fade never outlives its own swap. */
const FADE_SECONDS = 0.2;

/** **Placeholder.** The resting transparency of a row's fill. Low enough to read as a plate, high enough to show the panel. */
const ROW_TRANSPARENCY = 0.5;

/** The panel face and the row fill, both from the chunky direction's charcoal ladder. */
const ROW_BACKGROUND = Color3.fromRGB(62, 62, 71);

/** The local player's row: a gold ring, the same cue the rest of the UI uses for "this one is yours". */
const SELF_COLOR = Color3.fromRGB(233, 185, 73);

/** Draw order for the rows and their contents, above the panel's own face. */
const ROW_Z_INDEX = 4;

/**
 * One row, split into a **layout item** and a **moving face**.
 *
 * The split is the whole animation. `UIListLayout` owns the `Position` of its children, so tweening a row that *is* a list
 * item would be overwritten by the layout on the next solve. Instead the list positions `container` - an empty frame with the
 * row's height and no visuals - and the visible `face` inside it is free to be moved for the length of one tween.
 */
interface Row {
	readonly container: Frame;
	readonly face: Frame;
	readonly rankLabel: TextLabel;
	readonly nameLabel: TextLabel;
	readonly distanceLabel: TextLabel;
	readonly ring: Frame;
}

/**
 * A distance as the column shows it: whole studs of belt between the body and the edge it spawned on.
 *
 * **No suffix.** This used to render `0st` / `15st` because it appended the ordinal unit to a distance - a number that is not a
 * rank, made to look like one. The rank now has its own column and its own formatter, and this one is a bare count read
 * against the column header implied by its neighbours.
 *
 * `math.floor` rather than a rounded tenth: the number moves at roughly `BALL_SPEED_DECAY_RATE` studs a second, so decimals
 * would change on every broadcast without telling the player anything the integer did not.
 */
function formatDistance(distance: number): string {
	return tostring(math.floor(distance));
}

/**
 * The campaign leaderboard: a chunky panel on the right of the screen, five ranks plus the local player, sliding on change.
 *
 * ## Why the rows slide instead of flipping
 *
 * The first build tweened each row's `Size.Y` to zero, swapped the order, and grew it back. It read as an accordion for a
 * concrete reason: **height is a layout property, so collapsing one row drags every row below it upward while the row itself
 * is still visible**. The eye sees the whole list contract twice a second, which is more motion than the information
 * deserves - and the row that changed rank was only one of the things moving.
 *
 * A slide moves **only the rows whose rank changed**, and it moves them *through* the space they already occupy: nothing
 * else is disturbed, and the direction of travel is the direction of the change. Up a place means up the screen. That is the
 * FLIP technique - first, last, invert, play - and it is why this file records `AbsolutePosition` before touching the
 * layout.
 *
 * ## Why the rank order is repaired rather than sorted, on the server
 *
 * See `leaderboard-service`'s `rank`: two bodies neck-and-neck cross and re-cross by hundredths of a stud, and a plain sort
 * publishes a new pair of ranks every tick. The server holds each rank until a challenger is clearly better. This file trusts
 * the order it is given - a client-side threshold would have to re-derive the previous order from its own animation state,
 * which is the one thing that is not reliable while a tween is running.
 */
@Controller()
export class LeaderboardController implements OnStart {
	private readonly theme = chunkyDarkTheme();
	private readonly type = typographyOneStepUp();
	private readonly player = Players.LocalPlayer;

	private readonly rows = new Map<string, Row>();
	/** The ids in the order currently committed to the screen. The client's record of "previous", not the rows' `LayoutOrder`. */
	private previousOrder = new Array<string>();

	private panel?: Frame;
	private list?: ScrollingFrame;
	private emptyLabel?: TextLabel;

	/**
	 * Whether a slide owns the rows right now.
	 *
	 * A broadcast arriving mid-animation is **queued, not dropped and not applied**: applying it would move rows that are
	 * already moving and produce two overlapping trajectories on one row.
	 */
	private animating = false;
	private pending?: Array<LeaderboardEntry>;
	private latest = new Array<LeaderboardEntry>();

	public onStart(): void {
		this.build();
		this.connectRemote();
		this.watchPhase();

		print(`[Leaderboard] mounted rows=${VISIBLE_ROWS} slide=${SLIDE_SECONDS}s`);
	}

	// #region construction

	private build(): void {
		const gui = getScreenGui("hudCore");

		const panel = buildChunkyPanel({
			name: "Leaderboard",
			parent: gui,
			size: new UDim2(0, PANEL_WIDTH, 0, 0),
			autoHeight: true,
			cornerRadius: SPACING.sm,
		});

		const frame = panel.frame;
		// Anchored to the right edge, under the topbar inset: a screen fraction would put a different gap under the bar on
		// every aspect ratio.
		frame.AnchorPoint = new Vector2(1, 0);
		frame.Position = new UDim2(1, -SPACING.md, 0, SPACING.lg);
		frame.Visible = false;

		// **The board scales like every other composition (item 160).** A 210-pixel board fits any phone, so this is `1` almost
		// everywhere — but it is the same rule as the store's rather than a special case, and it means a very narrow window cannot
		// leave the board hanging off the right edge with its rows clipped. Note that `AnchorPoint = (1, 0)` is unaffected by a
		// `UIScale`: the anchor is resolved against the parent before the transform, so the board stays pinned to the same corner.
		applyPanelScale(frame, "leaderboard");
		this.panel = frame;

		const padding = new Instance("UIPadding");
		padding.PaddingTop = new UDim(0, SPACING.sm);
		padding.PaddingBottom = new UDim(0, SPACING.sm);
		padding.PaddingLeft = new UDim(0, SPACING.sm);
		padding.PaddingRight = new UDim(0, SPACING.sm);
		padding.Parent = panel.surface;

		const layout = new Instance("UIListLayout");
		layout.FillDirection = Enum.FillDirection.Vertical;
		layout.SortOrder = Enum.SortOrder.LayoutOrder;
		layout.Padding = new UDim(0, SPACING.xs);
		layout.Parent = panel.surface;

		const title = new Instance("TextLabel");
		title.Name = "Title";
		title.Size = new UDim2(1, 0, 0, this.type.body1.lineHeight);
		title.BackgroundTransparency = 1;
		title.Font = Enum.Font.GothamBlack;
		title.Text = "LEADERBOARD";
		title.TextSize = this.type.body2.size;
		title.TextColor3 = this.theme.colors.textPrimary;
		title.TextXAlignment = Enum.TextXAlignment.Left;
		title.LayoutOrder = 1;
		title.ZIndex = ROW_Z_INDEX;
		title.Parent = panel.surface;
		outlineText(title);

		// **A `ScrollingFrame` with `AutomaticCanvasSize.Y`.** Every body on the belt gets a row now, so the list has to be able
		// to be taller than the window: the *box* is five rows, the *canvas* is however many rows exist, and the layout extends
		// the canvas rather than the box. The panel stays a fixed height, which is what stops a fifty-body round from pushing
		// the board off the bottom of the screen.
		const list = new Instance("ScrollingFrame");
		list.Name = "Rows";
		list.Size = new UDim2(1, 0, 0, ROW_HEIGHT * VISIBLE_ROWS + ROW_GAP * (VISIBLE_ROWS - 1));
		list.BackgroundTransparency = 1;
		list.BorderSizePixel = 0;
		list.ClipsDescendants = true;
		list.ScrollBarThickness = SPACING.xs;
		list.ScrollBarImageColor3 = this.theme.colors.border;
		list.ScrollingDirection = Enum.ScrollingDirection.Y;
		list.CanvasSize = UDim2.fromOffset(0, 0);
		list.AutomaticCanvasSize = Enum.AutomaticSize.Y;
		list.ElasticBehavior = Enum.ElasticBehavior.Never;
		list.LayoutOrder = 2;
		list.ZIndex = ROW_Z_INDEX;
		list.Parent = panel.surface;
		this.list = list;

		const listLayout = new Instance("UIListLayout");
		listLayout.FillDirection = Enum.FillDirection.Vertical;
		listLayout.SortOrder = Enum.SortOrder.LayoutOrder;
		listLayout.Padding = new UDim(0, ROW_GAP);
		listLayout.Parent = list;

		// The empty state, said once rather than as zero rows: a panel with a title and nothing under it reads as broken.
		const empty = new Instance("TextLabel");
		empty.Name = "Empty";
		empty.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		empty.BackgroundTransparency = 1;
		empty.Font = FONT;
		empty.Text = "No racers yet";
		empty.TextSize = this.type.caption.size;
		empty.TextColor3 = this.theme.colors.textSecondary;
		empty.TextXAlignment = Enum.TextXAlignment.Center;
		empty.Visible = false;
		empty.ZIndex = ROW_Z_INDEX;
		empty.Parent = list;
		this.emptyLabel = empty;
	}

	/** Connects the broadcast, tolerating a server that has not created the remote yet. */
	private connectRemote(): void {
		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, 10);
		const remote = folder?.FindFirstChild(LEADERBOARD_UPDATE_REMOTE_NAME);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(
				`[Leaderboard] no ${LEADERBOARD_UPDATE_REMOTE_NAME} in ${REMOTES_FOLDER_NAME}; the board will stay empty.`,
			);
			return;
		}

		remote.OnClientEvent.Connect((entries: unknown) => this.onUpdate(entries));
	}

	/** Shows and hides the board with the phase, and clears it on the way out. */
	private watchPhase(): void {
		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, 10);
		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[Leaderboard] no ${ROUND_STATE_VALUE_NAME}; the board will stay hidden.`);
			return;
		}

		const apply = (phase: string) => {
			const playing = phase === PHASE_PLAYING;
			const panel = this.panel;
			if (panel !== undefined) {
				panel.Visible = playing;
			}

			if (!playing) {
				// Stale rows must not survive into the next round: ids are per-round, and a new round reuses them for
				// different bodies.
				this.clearRows();
				this.previousOrder = [];
				this.latest = [];
			}
		};

		apply(value.Value);
		value.Changed.Connect(apply);
	}

	// #endregion

	// #region updates

	private onUpdate(payload: unknown): void {
		if (!typeIs(payload, "table")) {
			return;
		}

		const entries = new Array<LeaderboardEntry>();
		for (const item of payload as Array<unknown>) {
			if (!typeIs(item, "table")) {
				continue;
			}

			const record = item as {
				key?: unknown;
				userId?: unknown;
				name?: unknown;
				distance?: unknown;
				eliminated?: unknown;
			};
			if (
				!typeIs(record.key, "string") ||
				!typeIs(record.userId, "number") ||
				!typeIs(record.name, "string") ||
				!typeIs(record.distance, "number")
			) {
				continue;
			}

			entries.push({
				key: record.key,
				userId: record.userId,
				name: record.name,
				distance: record.distance,
				// **Absent is `false`, and that is the right default** (item 208): a payload from a server that predates the
				// field, or a row that simply did not carry it, describes a body still on the belt. A missing `eliminated` must
				// never strike a live racer's row through.
				eliminated: record.eliminated === true,
			});
		}

		this.latest = entries;

		if (this.animating) {
			this.pending = entries;
			return;
		}

		this.apply(entries);
	}

	private apply(entries: Array<LeaderboardEntry>): void {
		const shown = entries;
		const visible = this.panel?.Visible === true;

		// With the panel hidden there is nothing to measure, so the order is committed outright and the board appears already
		// in place.
		if (!visible) {
			this.addMissing(shown);
			this.commitOrder(shown);
			this.removeNotIn(shown);
			this.updateContent(shown);
			this.previousOrder = this.idsOf(shown);
			this.updateEmptyState(shown);
			return;
		}

		const orderChanged = this.orderChanged(shown);

		// Rows for bodies that are new to the board are created **before** positions are recorded, so they are part of the
		// slide rather than appearing on top of it.
		this.addMissing(shown);

		if (!orderChanged) {
			// **`commitOrder` runs on this path too, and that is not belt-and-braces.** A row created by `addMissing` above
			// has no `LayoutOrder` and no rank text yet - both are written by `commitOrder`. Without this call the first
			// payload after a row is born on an unchanged order would leave that row at order `0`, stacked at the top of the
			// list with an empty rank column, until something else moved.
			this.commitOrder(shown);
			this.updateContent(shown);
			this.removeNotIn(shown);
			this.previousOrder = this.idsOf(shown);
			this.updateEmptyState(shown);
			return;
		}

		this.slideTo(shown);
	}

	/**
	 * The FLIP: **F**irst, **L**ast, **I**nvert, **P**lay.
	 *
	 * 1. **First** - record every surviving row's `AbsolutePosition.Y` before anything moves.
	 * 2. **Last** - hand out the new `LayoutOrder` and force the layout to solve by reading `AbsoluteContentSize`, which is the
	 *    documented way to make a `UIListLayout` compute immediately rather than at the end of the frame.
	 * 3. **Invert** - for each row, subtract the old Y from the new one; that delta is where the row *used* to be relative to
	 *    where it now is. Place the face there, so nothing has visibly moved yet.
	 * 4. **Play** - tween each face back to `(0, 0)`, its resting offset inside its own container, and the row travels the
	 *    distance between its old rank and its new one.
	 *
	 * **The container is what the layout moves; the face is what tweens.** That split is the precondition for the whole
	 * technique: `UIListLayout` writes its children's `Position` on every solve, so a row that was itself a list item would
	 * have its tween overwritten on the next frame. The face is nobody's layout item, so its `Position` is free.
	 *
	 * Rows that did not change rank get a delta of zero and are tweened by nothing, so a swap moves exactly the rows that
	 * swapped. That is the difference from the old height tween, which moved every row below the collapse.
	 */
	private slideTo(shown: Array<LeaderboardEntry>): void {
		this.animating = true;

		// 1. First: where each row is now, as an index rather than a pixel. `LayoutOrder` is 1-based, so the index is one
		// less; a row created this tick has no order yet (`0`) and is treated as new, which is correct - it fades in rather
		// than sliding from somewhere it never was.
		const before = new Map<string, number>();
		for (const [userId, row] of this.rows) {
			before.set(userId, row.container.LayoutOrder - 1);
		}

		// 2. Last.
		this.commitOrder(shown);
		this.updateContent(shown);
		this.removeNotIn(shown);
		this.updateEmptyState(shown);
		this.previousOrder = this.idsOf(shown);

		// 3. Invert: the distance a row has to travel is its change of **pitch**, which is exactly `ROW_HEIGHT + ROW_GAP` per
		// rank - so it is derived, not measured.
		//
		// **Why the target is computed rather than read back.** Measuring `AbsolutePosition` after reassigning `LayoutOrder`
		// requires a layout solve, and `UIListLayout` solves at the end of the frame: the property read that would force it
		// (`AbsoluteContentSize`) returns a `Vector2` with no observer, which roblox-ts discards as a no-op, and a frame yield
		// would break the single-pass handler. The rows are uniform by construction - the divider lives *inside* the container
		// so it cannot change the pitch - which makes the arithmetic exact and the animation reproducible.
		const pitch = ROW_HEIGHT + ROW_GAP;
		const info = new TweenInfo(SLIDE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
		let moved = 0;
		for (let index = 0; index < shown.size(); index++) {
			const row = this.rows.get(shown[index].key);
			if (row === undefined) {
				continue;
			}

			const was = before.get(shown[index].key);
			if (was === undefined || was < 0) {
				continue;
			}

			const delta = (was - index) * pitch;
			if (delta === 0) {
				continue;
			}

			row.face.Position = UDim2.fromOffset(0, delta);
			moved++;
		}

		// 4. Play. Nothing moved (the order changed but no row is visible yet): release immediately rather than holding the
		// queue for a slide with no participants.
		if (moved === 0) {
			this.finishSlide();
			return;
		}

		for (const [, row] of this.rows) {
			const offset = row.face.Position.Y.Offset;
			if (offset === 0) {
				continue;
			}

			TweenService.Create(row.face, info, { Position: UDim2.fromOffset(0, 0) }).Play();
		}

		// One timer rather than a completion counter: every tween shares `info`, and a counter would have to survive a row
		// destroyed mid-slide.
		task.delay(SLIDE_SECONDS, () => this.finishSlide());
	}

	private finishSlide(): void {
		this.animating = false;

		const queued = this.pending;
		this.pending = undefined;
		if (queued !== undefined) {
			this.apply(queued);
		}
	}

	/** Sets every row's `LayoutOrder` from its index, pinned row last. */
	private commitOrder(shown: Array<LeaderboardEntry>): void {
		for (let index = 0; index < shown.size(); index++) {
			const row = this.rows.get(shown[index].key);
			if (row !== undefined) {
				row.container.LayoutOrder = index + 1;
				// **`index + 1`, because the array is 0-based and a place is not.** This is the single line the first build got
				// wrong: it published the index, so the leader was `0`.
				row.rankLabel.Text = getOrdinal(index + 1);
			}
		}
	}

	private orderChanged(shown: Array<LeaderboardEntry>): boolean {
		if (this.previousOrder.size() !== shown.size()) {
			return true;
		}

		for (let index = 0; index < shown.size(); index++) {
			if (this.previousOrder[index] !== shown[index].key) {
				return true;
			}
		}

		return false;
	}

	/** The keys of an order, for `previousOrder`. Keyed by body rather than by owner: not every body has an owner. */
	private idsOf(entries: Array<LeaderboardEntry>): Array<string> {
		const keys = new Array<string>();
		for (const entry of entries) {
			keys.push(entry.key);
		}
		return keys;
	}

	// #endregion

	// #region rows

	/** Builds a row for every id that does not have one, and fades it in from nothing. */
	private addMissing(shown: Array<LeaderboardEntry>): void {
		for (const entry of shown) {
			if (this.rows.has(entry.key)) {
				continue;
			}

			this.rows.set(entry.key, this.buildRow(entry));
		}
	}

	private buildRow(entry: LeaderboardEntry): Row {
		const isSelf = entry.userId > 0 && entry.userId === this.player.UserId;

		// The layout item: height and order only, never drawn.
		const container = new Instance("Frame");
		// A single legal name: the key is a dotted full path, which is not usable as an instance name, and the row
		// is addressed through the map rather than by name anyway.
		container.Name = "Row";
		container.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		container.BackgroundTransparency = 1;
		container.BorderSizePixel = 0;
		container.ZIndex = ROW_Z_INDEX;
		container.Parent = this.list;

		// The face: what a slide tweens, and what the eye reads as the row.
		const face = new Instance("Frame");
		face.Name = "Face";
		face.Size = UDim2.fromScale(1, 1);
		face.Position = UDim2.fromOffset(0, 0);
		face.BackgroundColor3 = ROW_BACKGROUND;
		face.BackgroundTransparency = 1;
		face.BorderSizePixel = 0;
		face.ZIndex = ROW_Z_INDEX;
		face.Parent = container;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(0, SPACING.xs);
		corner.Parent = face;

		// **The self marker is a ring, not a recoloured row.** A brighter fill would need a second colour per theme and would
		// compete with the names; a gold ring is the cue the rest of the UI already uses, and it is one child that can be
		// toggled without touching the row's paint.
		const ring = addChunkyRing(face, SELF_COLOR, 2);
		ring.Visible = isSelf;

		// **The place, and it is `1`-based.** Every list in this codebase is a Lua array, so an index is `0`-based - which is
		// why the first build rendered `0st` for the leader. The ordinal is derived from the row's position in the *ranked*
		// list (`index + 1`), never from a loop counter, and the formatter adds the suffix; a bare `tostring(index)` with a
		// hard-coded `st` was the other half of that bug.
		const rankLabel = new Instance("TextLabel");
		rankLabel.Name = "Rank";
		rankLabel.AnchorPoint = new Vector2(0, 0.5);
		rankLabel.Position = new UDim2(0, SPACING.xs, 0.5, 0);
		rankLabel.Size = UDim2.fromOffset(RANK_WIDTH, ROW_HEIGHT);
		rankLabel.BackgroundTransparency = 1;
		rankLabel.Font = Enum.Font.GothamBlack;
		rankLabel.TextSize = this.type.caption.size;
		rankLabel.TextColor3 = isSelf ? SELF_COLOR : this.theme.colors.textSecondary;
		rankLabel.TextXAlignment = Enum.TextXAlignment.Left;
		rankLabel.Text = "";
		rankLabel.ZIndex = ROW_Z_INDEX + 1;
		rankLabel.Parent = face;
		outlineText(rankLabel);

		const nameLabel = new Instance("TextLabel");
		nameLabel.Name = "Name";
		nameLabel.AnchorPoint = new Vector2(0, 0.5);
		nameLabel.Position = new UDim2(0, SPACING.xs + RANK_WIDTH, 0.5, 0);
		nameLabel.Size = new UDim2(1, -(RANK_WIDTH + SPACING.xl + SPACING.lg), 1, 0);
		nameLabel.BackgroundTransparency = 1;
		nameLabel.Font = isSelf ? Enum.Font.GothamBlack : FONT;
		nameLabel.TextSize = this.type.caption.size;
		nameLabel.TextColor3 = isSelf ? SELF_COLOR : this.theme.colors.textPrimary;
		nameLabel.TextXAlignment = Enum.TextXAlignment.Left;
		nameLabel.TextTruncate = Enum.TextTruncate.AtEnd;
		// **Always on, not only for an eliminated row (item 208).** Toggling `RichText` re-parses the text, so a name containing
		// `<` or `&` would visibly change at the instant the row died - and the strike-through is `<s>`, which requires it.
		nameLabel.RichText = true;
		nameLabel.Text = escapeRichText(entry.name);
		nameLabel.ZIndex = ROW_Z_INDEX + 1;
		nameLabel.Parent = face;
		outlineText(nameLabel);

		const distanceLabel = new Instance("TextLabel");
		distanceLabel.Name = "Distance";
		distanceLabel.AnchorPoint = new Vector2(1, 0.5);
		distanceLabel.Position = new UDim2(1, -SPACING.xs, 0.5, 0);
		distanceLabel.Size = new UDim2(0, SPACING.xl + SPACING.sm, 1, 0);
		distanceLabel.BackgroundTransparency = 1;
		distanceLabel.Font = FONT;
		distanceLabel.TextSize = this.type.caption.size;
		distanceLabel.TextColor3 = this.theme.colors.textSecondary;
		distanceLabel.TextXAlignment = Enum.TextXAlignment.Right;
		// **Suffixed, because the number is "ground lost", not "ground gained".** An unlabelled `14` in a leaderboard column
		// reads as a score, and a score that grows while a racer is losing is the exact confusion the ranking direction causes.
		distanceLabel.Text = formatDistance(entry.distance);
		distanceLabel.ZIndex = ROW_Z_INDEX + 1;
		distanceLabel.Parent = face;
		outlineText(distanceLabel);

		// Fade rather than pop: a row that appears fully formed is indistinguishable from one that was always there, which
		// loses the information that somebody entered.
		const fade = new TweenInfo(FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
		TweenService.Create(face, fade, { BackgroundTransparency: ROW_TRANSPARENCY }).Play();

		return { container, face, rankLabel, nameLabel, distanceLabel, ring };
	}

	/** Text and highlight only - no order, no geometry. Safe at any point in a slide. */
	private updateContent(shown: Array<LeaderboardEntry>): void {
		for (const entry of shown) {
			const row = this.rows.get(entry.key);
			if (row === undefined) {
				continue;
			}

			// **An eliminated row is struck through and coloured, every broadcast (item 208).** The style is applied here rather
			// than at row creation because a row is reused: the same row object goes from live to eliminated the moment its
			// body leaves the round, and a style written only in `buildRow` would never reach it.
			//
			// `<s>` inside a rich-text label is the only strikethrough a `TextLabel` has - there is no property for it, and a
			// `UIStroke` outlines text rather than crossing it. `RichText` is on for the name **always**, not only when
			// eliminated, because toggling it also re-parses the text and a name containing `<` or `&` would change appearance
			// at the moment the row died.
			row.nameLabel.Text = entry.eliminated ? `<s>${escapeRichText(entry.name)}</s>` : escapeRichText(entry.name);
			row.distanceLabel.Text = formatDistance(entry.distance);
			row.ring.Visible = entry.userId > 0 && entry.userId === this.player.UserId;

			// **Colour from the theme's error slot, never a literal red**, so a light theme brightens it instead of drawing
			// text that disappears into the panel. The self ring stays gold on an eliminated row: it says "this is you", not
			// "you are alive", and the two facts are independent.
			const eliminatedColor = this.theme.colors.error;
			row.nameLabel.TextColor3 = entry.eliminated
				? eliminatedColor
				: entry.userId > 0 && entry.userId === this.player.UserId
					? SELF_COLOR
					: this.theme.colors.textPrimary;
			// The rank goes with the name: a struck-through name beside an ordinary ordinal reads as a formatting accident
			// rather than as a row that is out of the race.
			row.rankLabel.TextColor3 = entry.eliminated
				? eliminatedColor
				: entry.userId > 0 && entry.userId === this.player.UserId
					? SELF_COLOR
					: this.theme.colors.textSecondary;
		}
	}

	/**
	 * Destroys the rows for bodies no longer on the board, **after a fade**.
	 *
	 * The fade is not decoration: a body that drops out of the top five and back in a second later would otherwise be a row
	 * that vanished and reappeared, which reads as a bug. The container keeps its height for the fade's duration, so nothing
	 * shifts while it goes; the next slide is what closes the gap.
	 */
	private removeNotIn(shown: Array<LeaderboardEntry>): void {
		const keep = new Set<string>();
		for (const entry of shown) {
			keep.add(entry.key);
		}

		const gone = new Array<string>();
		for (const [key] of this.rows) {
			if (!keep.has(key)) {
				gone.push(key);
			}
		}

		if (gone.size() === 0) {
			return;
		}

		const fade = new TweenInfo(FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out);
		for (const key of gone) {
			const row = this.rows.get(key);
			if (row === undefined) {
				continue;
			}

			this.rows.delete(key);
			TweenService.Create(row.face, fade, { BackgroundTransparency: 1 }).Play();
			Debris.AddItem(row.container, FADE_SECONDS);
		}
	}

	private clearRows(): void {
		for (const [, row] of this.rows) {
			row.container.Destroy();
		}
		this.rows.clear();
		this.updateEmptyState([]);
	}

	private updateEmptyState(shown: Array<LeaderboardEntry>): void {
		const empty = this.emptyLabel;
		if (empty !== undefined) {
			empty.Visible = shown.size() === 0;
		}
	}

	// #endregion
}

/**
 * Escapes the three characters `RichText` interprets, so a display name is drawn as written (item 208).
 *
 * `RichText` is on for every name label because an eliminated row needs `<s>`. That makes the label a markup parser, which
 * means a `<` in a display name is no longer a character - it opens a tag, and an unbalanced one swallows the rest of the
 * row. Roblox itself strips most of these from display names, but a *Debug#N* body name or a Studio-authored body can
 * contain anything, and the failure would be a row that silently loses its text.
 *
 * `&` first: escaping it after the other two would turn the `&` those introduced into `&amp;`.
 */
function escapeRichText(text: string): string {
	return text.gsub("&", "&amp;")[0].gsub("<", "&lt;")[0].gsub(">", "&gt;")[0];
}
