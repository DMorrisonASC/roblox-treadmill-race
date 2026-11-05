import { ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { DECOY_OUTLINE_REMOTE_NAME, REMOTES_FOLDER_NAME, ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { getTheme } from "shared/ui/theme";

/**
 * Puts a red outline on the owner's own decoy — and on nobody else's.
 *
 * ## Why this is per-viewer, and why it is a request rather than a signal
 *
 * A `decoy_ball`'s twin is deliberately indistinguishable from a real body: same badge, same textures, same markers
 * (item 77). Its owner is the one person who cannot tell which of two identical balls they control, and everyone else is
 * the one group that must never be told. **That asymmetry cannot be shipped in an attribute** — an attribute on the body
 * replicates to every client — so the owner asks the server, which answers one caller at a time.
 *
 * A `RemoteFunction` and not an `RemoteEvent`: the answer is a fact about the world *now*, so a player who joins mid-round
 * gets it immediately instead of having missed the event that carried it. `nil` is also a meaningful answer, and only a
 * request/response channel can carry one.
 *
 * ## When it asks
 *
 * **On entry to `Playing`, once.** Not on mount (the round may be anywhere), not on a loop. A player who joins during
 * `Playing` reads the phase in `onStart` and asks immediately — their mount *is* their entry, which is why that case needs
 * no special handling.
 *
 * **Every entry is a fresh ask**, because the previous twin was destroyed with every other body at the phase change. The
 * `generation` counter is what makes "asked for this `Playing`" distinguishable from "asked for the last one": it is bumped
 * on *every* phase transition including `Playing → Playing`, so a late answer from a superseded `Playing` is discarded by
 * its generation rather than being applied to a body that no longer exists.
 *
 * ## What it never does
 *
 * It never highlights the real body — only the instance the server named. A spectator creates no `Highlight` at all,
 * because the server returned `nil`: the client cannot outline a body it was never told about, which is what makes the
 * deception hold for everyone except the owner.
 */
const ROUND_STATE_WAIT_SECONDS = 10;

/** How long to wait for the remote before giving up loudly, matching `RoundStateController`'s bounded wait. */
const REMOTE_WAIT_SECONDS = 10;

/**
 * **Placeholder.** How solid the red fill is on the outlined twin.
 *
 * `0.65` is a tint rather than a coat of paint: at `0` the twin becomes a red blob and stops looking like the ball it is
 * meant to be, and above `0.8` the tint is invisible against a ball whose own colour is already red. The **outline** is
 * what carries the signal at `0` transparency; the fill is there to make it readable when the twin is a pale colour.
 */
const DECOY_OUTLINE_FILL_TRANSPARENCY = 0.65;

@Controller()
export class DecoyOutlineController implements OnStart {
	/** Bumped on every phase transition, so a superseded answer cannot be applied. */
	private generation = 0;

	/** The outline this controller owns, and the body it was put on. Cleared together. */
	private highlight?: Highlight;
	private highlightedBody?: BasePart;

	public onStart(): void {
		const state = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (state === undefined || !state.IsA("StringValue")) {
			warn(`[Decoy] gave up waiting for ${ROUND_STATE_VALUE_NAME} — no outline is possible without a phase.`);
			return;
		}

		const remotes = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, REMOTE_WAIT_SECONDS);
		const remote =
			remotes !== undefined ? remotes.WaitForChild(DECOY_OUTLINE_REMOTE_NAME, REMOTE_WAIT_SECONDS) : undefined;
		if (remote === undefined || !remote.IsA("RemoteFunction")) {
			warn(
				`[Decoy] gave up waiting for ${DECOY_OUTLINE_REMOTE_NAME} — no outline is possible without the remote.`,
			);
			return;
		}

		// The current phase, read once: this covers a client that started mid-`Playing`, and the subscription below covers
		// everything after. A controller that only subscribed would sit silent until the next transition, which is the case
		// a late-joining player actually experiences.
		this.onPhaseChanged(state.Value, remote);

		state.Changed.Connect((phase) => this.onPhaseChanged(phase, remote));
	}

	/**
	 * One transition: drop the old outline, then ask again if the new phase is `Playing`.
	 *
	 * The clear happens before the ask and unconditionally, because a generation that is still holding a `Highlight` into
	 * `PostGame` is the failure mode that matters — an outline drawing on a body that is no longer anybody's twin.
	 */
	private onPhaseChanged(phase: string, remote: RemoteFunction): void {
		this.generation++;
		const generation = this.generation;

		this.clearHighlight();

		if (phase !== "Playing") {
			return;
		}

		// Spawned rather than invoked inline: `InvokeServer` yields, and a `Changed` handler that yields holds the signal's
		// coroutine open across a phase change it should have reacted to immediately.
		task.spawn(() => this.requestOutline(remote, generation));
	}

	/**
	 * Asks the server and applies the answer, if the answer still belongs to the current `Playing`.
	 *
	 * The generation is re-checked **after** the invoke returns, because the call yields: a round that ends while the
	 * request is in flight must not be given an outline by a reply that arrives afterwards.
	 */
	private requestOutline(remote: RemoteFunction, generation: number): void {
		// `InvokeServer` is declared to return `ReturnType<T>` for the remote's callback type, which defaults to `any`; the
		// assertion narrows it to `unknown` so the checks below are real narrowing rather than assertions on a value the
		// compiler has given up on.
		const answer = remote.InvokeServer() as unknown;

		if (generation !== this.generation) {
			return;
		}

		if (answer === undefined || !typeIs(answer, "Instance") || !answer.IsA("BasePart")) {
			// A refusal is normal for most players — no decoy ball, no body, or the round ended while asking — and the
			// server has already logged the reason. Printing here as well would put a line on every client for a fact that
			// belongs to one.
			return;
		}

		this.applyHighlight(answer);
	}

	/** Puts the outline on the body the server named, and keeps hold of it so the next transition can take it off. */
	private applyHighlight(body: BasePart): void {
		const colors = getTheme().colors;

		const highlight = new Instance("Highlight");
		highlight.Name = "DecoyOutline";
		highlight.Adornee = body;
		highlight.FillColor = colors.error;
		highlight.FillTransparency = DECOY_OUTLINE_FILL_TRANSPARENCY;
		highlight.OutlineColor = colors.error;
		highlight.OutlineTransparency = 0;
		// `Occluded`, not `AlwaysOnTop`: the belt is in plain view, so the outline only needs to be visible when the twin is,
		// and drawing through the arena wall would put a red ring on a body the player cannot see — which reads as a bug and
		// leaks the twin's position through geometry the player has no line of sight to.
		highlight.DepthMode = Enum.HighlightDepthMode.Occluded;
		highlight.Parent = body;

		this.highlight = highlight;
		this.highlightedBody = body;

		// **The outline dies with the body.** A twin can be culled by the kill plane or the cap mid-round, and a `Highlight`
		// parented to a destroyed part goes with it — but the controller's own reference would then point at a dead instance,
		// and clearing a dead outline at the phase change would do nothing while a later one re-used the field.
		body.Destroying.Connect(() => {
			if (this.highlightedBody === body) {
				this.clearHighlight();
			}
		});

		print(`[Decoy] outline granted body=${body.GetFullName()}`);
	}

	private clearHighlight(): void {
		if (this.highlight !== undefined) {
			this.highlight.Destroy();
		}

		this.highlight = undefined;
		this.highlightedBody = undefined;
	}
}
