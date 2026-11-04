import { Players, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import Fusion from "@rbxts/fusion-3.0";
import { TRANSITION_CONFIG, TRANSITION_CELL_DELAYS } from "shared/config/transition.config";
import { ROUND_TRANSITION_ATTRIBUTE } from "shared/constants";
import { getScreenGui } from "shared/ui/layers";

/** One cover cell: an instance plus the numbers that decide its size on a given frame. */
interface GridCell {
	readonly frame: Frame;
	/** Its slot in the wave, `0` at the centre and `1` at the far corner. */
	readonly wave: number;
	/** The cell's full size in pixels, recomputed when the viewport resizes. */
	size: Vector2;
	/** Its top-left corner in pixels, likewise. */
	origin: Vector2;
}

/**
 * Plays the round-transition wipe when the server asks for one.
 *
 * ## The cue, and why it is an attribute rather than a remote
 *
 * The server bumps `ROUND_TRANSITION_ATTRIBUTE` on each player; this controller watches its own copy. An
 * attribute replicates once and is readable at any moment, so a client that joins mid-wipe reads a value and
 * does nothing, where a `RemoteEvent` would have been missed entirely or replayed. It also keeps the trigger
 * per-player without a roster on the server side: "cover this client" is one property write.
 *
 * **The seed is load-bearing.** `lastSeen` is set from the current attribute value *before* the connection is
 * made, so mounting into an ongoing wipe does not replay it. Without that, every client would fire a wipe on
 * join, on respawn and on any script reload — a wipe on every state change *after this client mounted* is the
 * intended behaviour.
 *
 * ## The shape of the animation
 *
 * Cells are laid out once as a `ROWS x COLS` grid and never re-created between plays; a play only re-sizes them.
 * Each cell's stage is a pure function of elapsed time — `delay`, then `GROW_SECONDS` growing, then held, then
 * `REVEAL_SECONDS` shrinking — so the whole wipe is one number advancing, with no per-cell state to get out of
 * step. The grid is parented only while a wipe is running and destroyed at the end, so a client that never sees a
 * transition holds no UI at all.
 *
 * ## Why `RenderStepped` and not a tween
 *
 * The cover has to be exact: the server changes the phase on a clock the client cannot observe, so the client's
 * only job is to be fully closed as early as possible and stay closed. A `Tween` per cell (240 of them) would be
 * 240 independent clocks, and a single frame of disagreement is a visible slit in the curtain. One loop over an
 * elapsed number cannot disagree with itself.
 */
@Controller()
export class RoundTransitionController implements OnStart {
	/** The attribute value this client last acted on. Seeded before subscribing; see the class comment. */
	private lastSeen = 0;

	/** Whether a wipe is mid-play. A second bump while playing is ignored rather than queued. */
	private playing = false;

	public onStart(): void {
		if (!TRANSITION_CONFIG.ENABLED) {
			return;
		}

		const player = Players.LocalPlayer;
		const initial = player.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);
		this.lastSeen = typeIs(initial, "number") ? initial : 0;

		player.GetAttributeChangedSignal(ROUND_TRANSITION_ATTRIBUTE).Connect(() => {
			const raw = player.GetAttribute(ROUND_TRANSITION_ATTRIBUTE);
			const current = typeIs(raw, "number") ? raw : 0;
			if (current === this.lastSeen) {
				return;
			}

			this.lastSeen = current;

			// A wipe already running is left alone: the server never asks for two at once, and restarting would
			// cut the first one short while the phase change it was hiding has already happened.
			if (this.playing) {
				return;
			}

			this.play();
		});
	}

	/** One whole wipe: cover, hold, reveal, cleanup. */
	private play(): void {
		const gui = getScreenGui("transition");
		this.playing = true;

		// A throwaway scope, so every instance this play creates has one owner and one cleanup. `doCleanup` on it
		// destroys the frames and the connection together.
		const scope = Fusion.scoped(Fusion);

		const container = Fusion.New(
			scope,
			"Frame",
		)({
			Name: "TransitionGrid",
			Size: UDim2.fromScale(1, 1),
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			ZIndex: 1,
			Parent: gui,
		});

		const cells = this.buildCells(scope, container);
		const layout = () => this.layout(cells, container);
		layout();

		const viewportConnection = container
			.GetPropertyChangedSignal("AbsoluteSize")
			.Connect(() => this.layout(cells, container));

		const startedAt = os.clock();
		const total =
			TRANSITION_CONFIG.DELAY_PER_CELL +
			TRANSITION_CONFIG.GROW_SECONDS +
			TRANSITION_CONFIG.HOLD_SECONDS +
			TRANSITION_CONFIG.REVEAL_SECONDS +
			TRANSITION_CONFIG.DELAY_PER_CELL;

		const connection = RunService.RenderStepped.Connect(() => {
			const elapsed = os.clock() - startedAt;
			this.applyFrame(cells, elapsed);

			if (elapsed >= total) {
				connection.Disconnect();
				viewportConnection.Disconnect();
				container.Destroy();
				Fusion.doCleanup(scope);
				this.playing = false;
			}
		});
	}

	/** Creates one invisible frame per grid cell. Nothing is sized here; `layout` does that. */
	private buildCells(scope: Fusion.Scope<unknown>, container: Frame): Array<GridCell> {
		const cells = new Array<GridCell>();

		for (let row = 0; row < TRANSITION_CONFIG.ROWS; row++) {
			for (let col = 0; col < TRANSITION_CONFIG.COLS; col++) {
				const index = row * TRANSITION_CONFIG.COLS + col;
				const frame = Fusion.New(
					scope,
					"Frame",
				)({
					Name: `Cell_${row}_${col}`,
					BackgroundColor3: TRANSITION_CONFIG.COLOR,
					BackgroundTransparency: 0,
					BorderSizePixel: 0,
					Size: UDim2.fromOffset(0, 0),
					Position: UDim2.fromOffset(0, 0),
					ZIndex: 1,
					Parent: container,
				});

				cells.push({
					frame,
					wave: TRANSITION_CELL_DELAYS[index] ?? 0,
					size: Vector2.zero,
					origin: Vector2.zero,
				});
			}
		}

		return cells;
	}

	/**
	 * Recomputes each cell's full size and corner for the current viewport.
	 *
	 * The grid covers the whole screen including the area under the topbar — that is why the layer is
	 * `ScreenInsets.None` — so the cell size is the screen divided by the grid, rounded up by a pixel so rounding
	 * can only ever overlap neighbours, never leave a hairline gap between them. A gap is the failure that shows
	 * the game through the curtain.
	 */
	private layout(cells: Array<GridCell>, container: Frame): void {
		const screen = container.AbsoluteSize;
		const cellSize = new Vector2(
			math.ceil(screen.X / TRANSITION_CONFIG.COLS),
			math.ceil(screen.Y / TRANSITION_CONFIG.ROWS),
		);

		let index = 0;
		for (let row = 0; row < TRANSITION_CONFIG.ROWS; row++) {
			for (let col = 0; col < TRANSITION_CONFIG.COLS; col++) {
				const cell = cells[index];
				index++;
				if (cell === undefined) {
					continue;
				}

				cell.size = cellSize;
				cell.origin = new Vector2(col * cellSize.X, row * cellSize.Y);
			}
		}

		this.applyFrame(cells, 0);
	}

	/**
	 * Sizes every cell for a given elapsed time.
	 *
	 * Four windows, in order, and each cell enters each one after its own wave delay:
	 * `grow` (0 → full), `hold` (full), `reveal` (full → 0). Sizing from the cell's centre means a growing cell
	 * expands outward from where it will sit, so the cover reads as a grid opening up rather than tiles sliding
	 * into place.
	 */
	private applyFrame(cells: Array<GridCell>, elapsed: number): void {
		const growEnd = TRANSITION_CONFIG.GROW_SECONDS;
		const holdEnd = growEnd + TRANSITION_CONFIG.HOLD_SECONDS;

		for (const cell of cells) {
			// Reversed reveal: the corners start shrinking first, so the opening runs inward.
			const wave = TRANSITION_CONFIG.REVEAL_REVERSES_WAVE ? 1 - cell.wave : cell.wave;
			const delay = cell.wave * TRANSITION_CONFIG.DELAY_PER_CELL;
			const sinceStart = elapsed - delay;

			let scale: number;
			if (elapsed <= 0) {
				scale = 0;
			} else if (sinceStart <= 0) {
				scale = 0;
			} else if (sinceStart < growEnd) {
				scale = sinceStart / growEnd;
			} else {
				// Past the cover: hold, then shrink on the reveal's own delay.
				const sinceHoldEnd = elapsed - (holdEnd + wave * TRANSITION_CONFIG.DELAY_PER_CELL);
				if (sinceHoldEnd <= 0) {
					scale = 1;
				} else if (sinceHoldEnd >= TRANSITION_CONFIG.REVEAL_SECONDS) {
					scale = 0;
				} else {
					scale = 1 - sinceHoldEnd / TRANSITION_CONFIG.REVEAL_SECONDS;
				}
			}

			const width = cell.size.X * scale;
			const height = cell.size.Y * scale;
			cell.frame.Size = UDim2.fromOffset(width, height);
			cell.frame.Position = UDim2.fromOffset(
				cell.origin.X + (cell.size.X - width) / 2,
				cell.origin.Y + (cell.size.Y - height) / 2,
			);
			cell.frame.Visible = scale > 0;
		}
	}
}
