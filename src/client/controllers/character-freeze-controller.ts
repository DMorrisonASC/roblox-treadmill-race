import { Players, ReplicatedStorage } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYER_COMPETING_ATTRIBUTE } from "shared/attributes";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { lockControls } from "client/controls-lock";
import { cameraWantsArena } from "shared/spectate";
import { isSpectating, onSpectatingChanged } from "client/spectating";

/** How long to wait for `RoundState` before giving up and saying so; the tree's bounded-wait convention (item 13). */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * Stops the local character walking when this player is **not racing**, and gives it back when they are.
 *
 * ## The bug this fixes
 *
 * `controls-lock.ts` disables the mobile thumbstick and calls the `PlayerModule`'s `Disable()`, and neither touches a keyboard
 * character: `Humanoid.WalkSpeed` is written **nowhere in this tree**, so a player who is not competing could still walk their
 * avatar around the lobby while the arena camera watched somebody else's race. Item 208 made that state reachable by more
 * players - an eliminated competitor now gets `Competing = false` mid-round - so the freeze has to exist for anyone who is
 * watching rather than racing.
 *
 * ## Why `WalkSpeed = 0` and not a controls lock
 *
 * A controls lock hides the input path; `WalkSpeed = 0` removes the outcome. A locked character at `WalkSpeed = 16` still gets
 * shoved by physics, still slides on the belt, and still plays a *run* animation if something moves it - whereas a zeroed
 * `WalkSpeed` leaves the `Humanoid`'s state machine in `idle`, which is what makes the freeze read as standing still rather
 * than as lag. Both are applied: the lock covers touch, the speed covers everything the lock cannot reach.
 *
 * ## Why the values are captured and restored rather than written as 16 / 50
 *
 * A hard-coded restore would erase any other writer of `WalkSpeed` - a future sprint, a permanent buff, a Studio-authored
 * character with a different base speed - the first time a player watched a round. The freeze is a *pause*, so it captures what
 * the character had on the frame the freeze began and puts that back. `JumpHeight` is captured for the same reason: a character
 * that could not jump before must not be able to jump afterwards.
 *
 * ## Why two facts, and why both are watched rather than polled
 *
 * `Competing` is written by the server at spawn, at elimination and at teardown; the phase is a `StringValue` the server writes
 * on every transition. Both arrive asynchronously and neither has a readable "current" value on the first frame a client runs,
 * so each is read once at boot **and** subscribed - a client that starts mid-round must freeze immediately, not at the next
 * transition.
 *
 * The frozen state is `!competing || phase !== Playing`: the default before either attribute has arrived is *frozen*, which is
 * the safe direction. A player whose `Competing` has not replicated yet cannot walk; one that has is released on the next
 * signal.
 */
@Controller()
export class CharacterFreezeController implements OnStart {
	private phase = "";

	private competing = false;

	/** The `Humanoid`'s `WalkSpeed` when the freeze began, or `undefined` when not frozen. */
	private frozenWalkSpeed?: number;

	/** The `Humanoid`'s `JumpHeight` when the freeze began, or `undefined` when not frozen. */
	private frozenJumpHeight?: number;

	/** Gives the touch controls back. `undefined` when not frozen. See `controls-lock.ts` for why this is counted. */
	private releaseControls?: () => void;

	/** The humanoid this controller is currently posing, so a respawn is noticed rather than mis-restored. */
	private posedHumanoid?: Humanoid;

	/** Unsubscribes from the shared spectating module. */
	private releaseSpectating?: () => void;

	public onStart(): void {
		const player = Players.LocalPlayer;
		if (player === undefined) {
			return;
		}

		// **The phase, read once and then subscribed.** A bounded wait for the tree's usual reason: an unbounded `WaitForChild`
		// turns "the server never created it" into a client that yields for ever.
		const state = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (state === undefined || !state.IsA("StringValue")) {
			warn(
				`[CharacterFreeze] no ${ROUND_STATE_VALUE_NAME} after ${ROUND_STATE_WAIT_SECONDS}s - the character is never frozen for a phase, only for \`Competing\`.`,
			);
		} else {
			this.phase = state.Value;
			state.GetPropertyChangedSignal("Value").Connect(() => {
				this.phase = state.Value;
				this.sync();
			});
		}

		player.GetAttributeChangedSignal(PLAYER_COMPETING_ATTRIBUTE).Connect(() => {
			this.competing = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE) === true;
			this.sync();
		});
		this.competing = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE) === true;

		// **The third input, and the one this controller was missing entirely (item 209).** Subscribed rather than polled for the
		// same reason as the other two: it changes on a button press, not per frame. `isSpectating()` is read once here as well, so
		// a client that starts while a spectator is already watching is frozen on its first frame rather than at the next press.
		this.releaseSpectating = onSpectatingChanged(() => this.sync());

		// **A respawn replaces the `Humanoid`.** Without re-posing on `CharacterAdded`, a player who dies while frozen would come
		// back with a fresh `Humanoid` at its default speed, walk away, and leave this controller holding a restore value for a
		// humanoid that no longer exists.
		player.CharacterAdded.Connect(() => {
			this.posedHumanoid = undefined;
			this.sync();
		});

		// **The `Humanoid` is not necessarily there yet.** `CharacterAdded` fires before the character is parented in some cases,
		// so this is a deferred attempt rather than an assumption - and a failure is not fatal, because the next phase or
		// attribute change tries again.
		task.defer(() => this.sync());

		print(
			`[CharacterFreeze] mounted phase=${this.phaseName()} competing=${tostring(this.competing)} frozen=${tostring(this.wantsFrozen())}`,
		);
	}

	/**
	 * Whether the character should be held still: **exactly when the camera is not on it.**
	 *
	 * ## This used to be `!competing || phase !== "Playing"`, and that was the bug (item 209)
	 *
	 * The old condition asked "is this player competing", and the question that decides whether a character may walk is
	 * "where is the camera". They are different questions with different answers in three states:
	 *
	 * - **`Intermission`, not competing** - lobby view, camera on the character, and the old rule froze it. A player could not
	 *   walk in the lobby, which is where there is nothing else to do.
	 * - **`Playing`, eliminated, `spectating` false** - the player pressed *Stop Watching*, the camera returned to the character,
	 *   and the character stayed frozen. This is the one the session log shows: `[TreadmillCamera] restored (phase Playing)` and
	 *   no `[CharacterFreeze] thawed` line ever after it.
	 * - **`Playing`, eliminated, `spectating` true** - arena camera, character off screen, frozen. Right by both rules.
	 *
	 * So the predicate is now `cameraWantsArena` - the same function `TreadmillCameraController` decides with. One definition,
	 * two readers: the camera gets it right and the freeze cannot disagree, which is the tree's rule for every rule that two
	 * places need (`round-outcome`, `competitor-slots`, `shared/spectate`).
	 *
	 * `competing` is still an input, because a competitor's camera is the arena without anyone pressing anything.
	 */
	private wantsFrozen(): boolean {
		return cameraWantsArena(this.phase, this.competing, isSpectating());
	}

	/**
	 * Applies the current answer, idempotently.
	 *
	 * Called from both signals and from `CharacterAdded`. Every branch is written so that being called twice in a row costs one
	 * comparison - the tree's controllers are all re-entrant across a phase change, and a freeze that toggled blindly would
	 * capture its own zeroed values as the "original" on the second call and restore a character to `WalkSpeed = 0`.
	 */
	private sync(): void {
		const humanoid = this.humanoid();
		if (humanoid === undefined) {
			return;
		}

		// A new `Humanoid` (a respawn) means the captured values describe a body that no longer exists.
		if (humanoid !== this.posedHumanoid) {
			this.posedHumanoid = humanoid;
			this.frozenWalkSpeed = undefined;
			this.frozenJumpHeight = undefined;
			// **The controls lock is released with the capture, not left to `thaw` (item 209).** `lockControls` is counted, and
			// a respawn while frozen would otherwise take a second hold and drop only one on thaw - leaving the touch stick
			// disabled for the rest of the session, which is the exact failure the counter's own docblock warns about.
			this.releaseHeldControls();
		}

		if (this.wantsFrozen()) {
			this.freeze(humanoid);
			return;
		}

		this.thaw(humanoid);
	}

	/**
	 * Captures the character's own values, then zeroes them. Idempotent: a second call changes nothing.
	 *
	 * **The line prints on the transition only (item 209).** It used to print on every call, and `sync()` runs on every phase
	 * change and every attribute change - so the session log carried repeated `frozen reason=competing phase=Intermission` lines
	 * for a state that had not changed. A diagnostic that repeats is a diagnostic a reader learns to skip, which is the failure
	 * the `[Ghost]` and `[Spawner]` lines were already written to avoid: report the transition, not the state.
	 */
	private freeze(humanoid: Humanoid): void {
		const entering = this.frozenWalkSpeed === undefined;
		if (entering) {
			this.frozenWalkSpeed = humanoid.WalkSpeed;
			this.frozenJumpHeight = humanoid.JumpHeight;
			this.releaseControls = lockControls();
		}

		humanoid.WalkSpeed = 0;
		humanoid.JumpHeight = 0;

		if (entering) {
			print(
				`[CharacterFreeze] frozen reason=${this.reason()} phase=${this.phaseName()} restoreWalk=${tostring(math.round((this.frozenWalkSpeed ?? 0) * 100) / 100)} restoreJump=${tostring(math.round((this.frozenJumpHeight ?? 0) * 100) / 100)}`,
			);
		}
	}

	/** Restores exactly what was captured. A no-op when not frozen. */
	private thaw(humanoid: Humanoid): void {
		const walkSpeed = this.frozenWalkSpeed;
		const jumpHeight = this.frozenJumpHeight;
		if (walkSpeed === undefined || jumpHeight === undefined) {
			return;
		}

		humanoid.WalkSpeed = walkSpeed;
		humanoid.JumpHeight = jumpHeight;

		this.frozenWalkSpeed = undefined;
		this.frozenJumpHeight = undefined;

		this.releaseHeldControls();

		print(
			`[CharacterFreeze] thawed reason=${this.reason()} phase=${this.phaseName()} walk=${tostring(math.round(walkSpeed * 100) / 100)} jump=${tostring(math.round(jumpHeight * 100) / 100)}`,
		);
	}

	/** The local character's `Humanoid`, or `undefined` before it exists. */
	private humanoid(): Humanoid | undefined {
		const player = Players.LocalPlayer;
		if (player === undefined) {
			return undefined;
		}

		const character = player.Character;
		if (character === undefined) {
			return undefined;
		}

		const found = character.FindFirstChildOfClass("Humanoid");
		return found;
	}

	/**
	 * Gives the touch controls back if this controller is holding them. Idempotent.
	 *
	 * One helper for the two places that must release - `thaw` and a respawn - because a second copy of "release if held" is the
	 * copy that forgets to clear the field.
	 */
	private releaseHeldControls(): void {
		const release = this.releaseControls;
		if (release === undefined) {
			return;
		}

		this.releaseControls = undefined;
		release();
	}

	/**
	 * **Which fact decided the current state**, for the log lines.
	 *
	 * `spectating` is named explicitly rather than folded into `competing`, because the session log's whole confusion was not
	 * being able to tell "frozen because I am a competitor" from "frozen because I am watching" - they look identical in a line
	 * that only names one of them.
	 */
	private reason(): string {
		if (isSpectating()) {
			return "spectating";
		}

		if (this.competing) {
			return "competing";
		}

		return "phase";
	}

	/** The current phase, or `none` before `RoundState` has replicated. */
	private phaseName(): string {
		return this.phase === "" ? "none" : this.phase;
	}
}
