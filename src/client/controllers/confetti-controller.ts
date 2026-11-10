import { Controller, OnStart } from "@flamework/core";
import { RunService, TweenService } from "@rbxts/services";
import { getScreenGui } from "shared/ui/layers";
import {
	ConfettiPiece,
	confettiRandom,
	FADE_IN_SECONDS,
	GRAVITY,
	pieceGone,
	spawnBurst,
	stepPiece,
} from "shared/ui/confetti";

/**
 * Draws the confetti burst: **`Frame` pieces in one overlay, moved by one `RenderStepped`.**
 *
 * ## Why the overlay is the controller's, and not the reveal's frame
 *
 * The previous port parented its pieces into the reveal's own overlay frame so that `Destroy()` would take them — which works, and
 * which puts a piece's lifetime under the reveal's. The cost is a race: the reveal's `close` destroys that frame while this
 * controller may still be holding a reference to a piece inside it, and every close path (`ok`, `open-again`, `phase`, `teardown`)
 * has to be correct about it.
 *
 * So the overlay is **one `Frame` the controller owns**, sitting in the `reveal` layer's `ScreenGui` (item 39's find-or-create, so
 * no second `ScreenGui` for the same rank) and created once in `onStart`. It outlives any single reveal, which means:
 *
 * - **a burst never races a close** — the reveal destroys only its own frame, and this one is not inside it;
 * - **`Open Again` cannot create a second overlay** — the module in the user's message had exactly that bug, looking for
 *   `ConfettiScreenGui` and creating `ConfettiGui`, so every call added another `ScreenGui` to `PlayerGui`;
 * - **a burst still falling when the player presses `OK` keeps falling**, which is right: it was already drawn, and cutting it off
 *   would be the reveal deciding what a burst it no longer owns looks like.
 *
 * ## Why one `RenderStepped` and not one per piece
 *
 * The module connected a `RenderStepped` per piece — 250 connections for its default emission. Every VFX controller in this tree
 * (`hitEffect`, `motionBlur`, `markerSpin`) uses **one** connection for the whole system, and at 24 pieces the difference is not
 * academic: a per-piece connection is a closure, a capture and a scheduler entry each, and a disconnect storm when they all end.
 *
 * ## What is deliberately absent
 *
 * **No sound** (the module's horn asset and its unbounded `repeat task.wait() until bonusSound.IsLoaded` are both
 * gone — the user dropped the audio, and the wait had nothing left to guard). **No gradient overlay** (it covered the six-colour
 * palette; see `shared/ui/confetti.ts`). **No image labels, no `ReplicatedStorage` lookup, no preload call** — the whole point of
 * this module is that there is no asset for anybody to delete.
 */

/** The overlay frame's name in the Explorer, so a burst is obvious in `PlayerGui`. */
const OVERLAY_NAME = "ConfettiOverlay";

/** One live piece: the frame on screen and the state that moves it. */
interface LivePiece {
	readonly frame: Frame;
	piece: ConfettiPiece;
	readonly burstId: number;
}

/**
 * The live controller, for the caller that needs it. Same shape as `getRevealController`, for the same reason: no controller in this
 * tree injects another, and this is read at burst time rather than at boot so the two `onStart`s cannot race.
 */
let active: ConfettiController | undefined;

/** Records the live controller. A named setter rather than `active = this`, which `no-this-alias` refuses — and prefers. */
function registerConfetti(controller: ConfettiController): void {
	active = controller;
}

/** The confetti, if it started. `undefined` before `onStart` and in a harness that never ignited. */
export function getConfettiController(): ConfettiController | undefined {
	return active;
}

@Controller()
export class ConfettiController implements OnStart {
	/** The one overlay. Its existence is the "the module's second `ScreenGui`" bug, fixed. */
	private overlay?: Frame;

	private readonly live = new Array<LivePiece>();

	/** The one loop, connected on the first burst and disconnected when the last piece is gone. */
	private connection?: RBXScriptConnection;

	private burstStartedAt = 0;
	private burstId = 0;

	public onStart(): void {
		registerConfetti(this);

		const gui = getScreenGui("reveal");

		const overlay = new Instance("Frame");
		overlay.Name = OVERLAY_NAME;
		overlay.Size = UDim2.fromScale(1, 1);
		overlay.BackgroundTransparency = 1;
		overlay.BorderSizePixel = 0;
		// Non-interactive: a full-screen `Frame` that swallowed touches would eat the reveal's `OK` button underneath it. A `Frame`
		// with `Active = false` passes them through, and the pieces themselves are not controls either.
		overlay.Active = false;
		// Above every card, because `burst` is told the card stack's top and asks for one more. See `burst`.
		overlay.ZIndex = 2;
		overlay.Parent = gui;
		this.overlay = overlay;

		print(`[Confetti] mounted overlay=${overlay.GetFullName()} colours=6 zIndex=per-burst`);

		// **The only teardown this controller gets.** Flamework v5.9.3 has no `OnStop` (item 31), so the overlay is taken with the
		// game rather than left to be collected — the tree's answer for a controller-owned instance.
		game.Destroying.Connect(() => {
			const target = this.overlay;
			this.overlay = undefined;
			if (target !== undefined) {
				target.Destroy();
			}
		});
	}

	/**
	 * Fires one burst of `count` pieces, scattered across the whole screen.
	 *
	 * ## `position` is accepted and **does not place anything**
	 *
	 * The module has no emitter concept. Its `Emit(amount, spawnPos)` only uses `spawnPos` when it is a `UDim2`, and every call in its
	 * own demo omits it — so every piece spawns at `math.random(0, 100)/100, math.random(-25, 125)/100`, across the width and from a
	 * quarter of a screen above to a quarter below. Item 168 aimed the whole burst at the reveal's grid centre, which is why the
	 * effect did not look like the demo: 204 pieces from one point read as a plume, not as confetti falling everywhere.
	 *
	 * The parameter stays because the reveal's call site is not this round's business, and because a future caller may want the
	 * position for something. It is **read into the log line and nowhere else**, which is said here rather than left for a reader to
	 * wonder about. If a centred burst is ever wanted, it is a second method (`burstAt`), not a flag on this one — the module's
	 * default has to be the default.
	 *
	 * `zIndex` is the caller's, and required. The module hard-coded `20`, a number with no relationship to what was on screen; the
	 * reveal passes one more than the highest `ZIndex` its cards actually reached (that is `7`, so pieces draw at `8`), so the
	 * confetti is never behind the card it is celebrating.
	 */
	public burst(parent: GuiObject, position: Vector2, count: number, zIndex: number): void {
		const overlay = this.overlay;
		if (overlay === undefined || count <= 0) {
			return;
		}

		this.burstId += 1;
		const burstId = this.burstId;
		const startedAt = os.clock();

		for (const piece of spawnBurst(count, confettiRandom)) {
			const frame = this.buildPiece(piece, zIndex);
			frame.Parent = overlay;
			this.live.push({ frame, piece, burstId });
		}

		print(`[Confetti] burst parent=${parent.GetFullName()} count=${count} position=${position.X},${position.Y}`);

		// **One line per burst that answers "did it actually draw anything".** Item 167's lesson: a burst that fired, a count and a
		// clean lifetime are all compatible with nobody seeing anything, because none of them says whether a piece had a non-zero
		// rect. `task.defer` waits one resume so the layout has resolved `AbsoluteSize`.
		task.defer(() => {
			for (const entry of this.live) {
				if (entry.burstId !== burstId) {
					continue;
				}

				const frame = entry.frame;
				print(
					`[Confetti] sample absolute=${frame.AbsolutePosition.X},${frame.AbsolutePosition.Y} size=${frame.AbsoluteSize.X},${frame.AbsoluteSize.Y} visible=${frame.Visible} zIndex=${frame.ZIndex} parent=${tostring(frame.Parent !== undefined)}`,
				);
				break;
			}
		});

		this.burstStartedAt = startedAt;

		if (this.connection === undefined) {
			this.connection = RunService.RenderStepped.Connect((dt) => {
				this.step(dt);
			});
		}
	}

	/**
	 * One piece's `Frame`: its colour, its shape, its own width and height, and the module's fade-in.
	 *
	 * **A `UICorner` only for the circle.** The module created one for every shape and left it at the default radius, which is a
	 * `UICorner` that does nothing; here a square is a square because it has no corner at all, and a diamond is a square turned `45`
	 * degrees at spawn with no corner either. The `triangle` is the module's own branch — a **wide rectangle**, not a triangle — and it
	 * is the source of the size variety in the demo.
	 */
	private buildPiece(piece: ConfettiPiece, zIndex: number): Frame {
		const frame = new Instance("Frame");
		frame.Name = `Confetti_${piece.shape}`;
		frame.AnchorPoint = new Vector2(0.5, 0.5);
		frame.Size = UDim2.fromOffset(piece.size.X, piece.size.Y);
		frame.Position = UDim2.fromScale(piece.position.X, piece.position.Y);
		frame.BackgroundColor3 = piece.color;
		// **The module's fade-in.** It creates every piece fully transparent and tweens to opaque over `0.5 s` with `Quart`/`InOut`, and
		// that is why 80 pieces appearing in one frame do not read as a flash — they bloom. A piece that pops in at full opacity is not
		// what the demo shows.
		frame.BackgroundTransparency = 1;
		frame.BorderSizePixel = 0;
		frame.ZIndex = zIndex;
		// The diamond's spawn angle. The spin then runs from here, so a diamond stays a diamond about its own centre.
		frame.Rotation = piece.shape === "diamond" ? 45 : 0;

		if (piece.shape === "circle") {
			const corner = new Instance("UICorner");
			corner.CornerRadius = new UDim(1, 0);
			corner.Parent = frame;
		}

		TweenService.Create(frame, new TweenInfo(FADE_IN_SECONDS, Enum.EasingStyle.Quart, Enum.EasingDirection.InOut), {
			BackgroundTransparency: 0,
		}).Play();

		return frame;
	}

	/**
	 * One frame for every live piece: step, write, cull.
	 *
	 * `Position` is written in `Scale`, which is the space the pieces move in — no viewport read, no scale factor, and the burst is
	 * therefore the same shape on a phone and on a monitor.
	 */
	private step(dt: number): void {
		for (let index = this.live.size() - 1; index >= 0; index--) {
			const entry = this.live[index];

			// The overlay was destroyed under us — the game is closing, or a future caller destroyed it. Nothing left to draw.
			if (entry.frame.Parent === undefined) {
				this.live.remove(index);
				continue;
			}

			const moved = stepPiece(entry.piece, dt, GRAVITY);
			entry.piece = moved;

			entry.frame.Position = UDim2.fromScale(moved.position.X, moved.position.Y);
			entry.frame.Rotation = moved.rotation;

			if (pieceGone(moved)) {
				entry.frame.Destroy();
				this.live.remove(index);
			}
		}

		if (this.live.size() === 0) {
			this.stopLoop();
		}
	}

	/** Disconnects the loop and writes the one line that says the burst is over. **One per burst, not per piece.** */
	private stopLoop(): void {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}

		this.connection = undefined;
		connection.Disconnect();

		print(`[Confetti] burst done count=0 lifetime=${string.format("%.2f", os.clock() - this.burstStartedAt)}s`);
	}
}
