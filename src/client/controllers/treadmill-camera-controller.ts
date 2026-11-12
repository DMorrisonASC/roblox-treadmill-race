import { CollectionService, Players, ReplicatedStorage, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PLAYER_COMPETING_ATTRIBUTE } from "shared/attributes";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { cameraWantsArena } from "shared/spectate";
import { setSpectating as moduleSetSpectating } from "client/spectating";
import { TAGS } from "shared/tags";

/**
 * Points the player's camera at the arena for the whole of a round, and gives it back afterwards.
 *
 * ## The rule, in one sentence
 *
 * **Snap on `Waiting` entry, hold through `Playing` and `PostGame`, restore on `Intermission` entry** — with `Playing` and
 * `PostGame` acting as the fallback for a client that joined after `Waiting`, and a mid-round character loss restoring
 * without re-engaging until the next round.
 *
 * **Since item 193 that rule applies to players who are *in* the round, or who have asked to watch it.** A non-competitor's
 * camera used to be taken for the whole round by the phase alone; it is now theirs until they press Spectate, which is what
 * gives the button a meaningful off state. A competitor's behaviour is unchanged in every respect.
 *
 * ## Why `Waiting` is the engage phase and `Playing` is only a fallback
 *
 * `Waiting` is where the player is meant to *watch*: the picker closes onto a countdown and then the race starts, so the
 * arena has to be on screen before the green light or the first second of the round happens off-camera. `Playing` and
 * `PostGame` are still "in the round", so a client that arrives late — or whose character respawned while the round was
 * running — is snapped on its first observation of either. That is one rule with one fallback, not two mechanisms.
 *
 * ## The wipe
 *
 * The snap on `Waiting` is deliberately invisible: `RoundService.forceWaiting` hands its body to the same
 * `transitionAround` call the `Intermission` timer uses (item 186), so **every** entry into `Waiting` happens while the
 * screen is covered — timer or debug key `2`. This controller does not know or care which path it was; it reads the phase
 * value and moves the camera. `Waiting → Playing` is *not* wiped (item 49 leaves that edge uncovered, because key `3` is a
 * jump into a round rather than a transition out of one), which is exactly why `Playing` must not re-engage: it would put a
 * visible camera cut on that uncovered edge.
 *
 * ## Why it reads no debug key
 *
 * The keys are phase changes, not camera commands. `1` restores because it enters `Intermission`; `2` engages under the
 * wipe because it enters `Waiting`; `3` keeps the camera because `Playing` is already active and does not re-engage; `4`
 * changes no phase and therefore touches nothing here. Every one of those behaviours falls out of the phase rule, so a key
 * read anywhere in this file would be a second, disagreeing source of truth.
 *
 * ## What it never does
 *
 * No `LoadCharacter`, no `BreakJoints`, no health write, no `Player.CameraMode` change, no per-frame update, no tween. A
 * reset is the player's own act and costs them the round; this only reacts to it.
 */
const ROUND_STATE_WAIT_SECONDS = 10;

/**
 * **The phase set is no longer this file's.** `ARENA_CAMERA_PHASES` lives in `shared/spectate.ts` (item 193) because the
 * spectator button asks the same question — "is this a phase in which a round exists to watch" — and two sets that must stay
 * equal are two sets that eventually will not. This controller's *complement rule* is unchanged: anything outside that set
 * restores, so a phase this build has never heard of gives the player their camera back rather than stranding them in a
 * scripted camera nothing will release.
 */
@Controller()
export class TreadmillCameraController implements OnStart {
	/** The tagged part whose `CFrame` is the camera pose, once one has replicated. */
	private part: BasePart | undefined;

	/** The `RoundState` value, kept so the phase can be re-read without another `WaitForChild`. */
	private roundState: StringValue | undefined;

	/** Whether the camera is currently scripted by this controller, so a restore is never issued twice. */
	private engaged = false;

	/**
	 * Bumped on each `Waiting` entry, and printed on every engage/restore line.
	 *
	 * **It no longer gates anything (item 212).** It used to pair with a `suppressedGeneration`: a reset recorded "suppress
	 * for generation N" and the next `Waiting` bumped N, which un-suppressed the camera without a second flag to clear. That
	 * design answered "this player gave up the race by resetting" - which stopped being true once `Competing` became the thing
	 * that says whether a player is racing. A competitor who resets is still in the race, and the camera has to say so. The whole
	 * rule is now `cameraWantsArena(phase, competing, spectating)` plus "is there a character to hand back to", evaluated on
	 * every input change *and* on `CharacterAdded`, so there is no state for a generation to invalidate.
	 */
	private generation = 0;

	/**
	 * **The two facts the phase rule alone cannot answer (item 193).**
	 *
	 * `competing` is `Player:GetAttribute(Competing)`, written by `RoundService` when a body is spawned for this player and
	 * cleared when the round's bodies are. `spectating` is the local override the spectator button sets.
	 *
	 * The rule they feed is `cameraWantsArena(phase, competing, spectating)`: a competitor keeps item 186's automatic engage,
	 * and a non-competitor gets the arena only while they have asked for it. Before this round the phase decided on its own,
	 * so a player who was not in the round still had their camera taken — which left the button with no meaningful `off`
	 * state, because the camera was on before it was pressed.
	 *
	 * **Both are read, never polled.** `competing` arrives through `GetAttributeChangedSignal`, which is what makes the
	 * attribute's update timing invisible: it can replicate before or after `RoundState`, and either order re-runs `observe`.
	 */
	private competing = false;
	private spectating = false;

	private readonly connections = new Array<RBXScriptConnection>();

	public onStart(): void {
		const camera = Workspace.CurrentCamera;
		const roundState = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (roundState === undefined || !roundState.IsA("StringValue")) {
			warn(
				`[TreadmillCamera] no ${ROUND_STATE_VALUE_NAME} StringValue in ReplicatedStorage — camera stays on the player.`,
			);
			return;
		}
		this.roundState = roundState;

		this.part = this.findPart();
		if (this.part === undefined) {
			// **One line, once, and no retry loop.** The tree's rule for a missing fixture is a single warning naming the tag
			// (see `TreadmillService` and `RoundService.findZone`); a controller that polled would turn a scene mistake into a
			// log flood. The added-tag signal below is the recovery, so a part tagged after boot is picked up without a restart.
			warn(
				`[TreadmillCamera] no part tagged ${TAGS.treadmillCamera} — camera stays on the player. Tag a BasePart whose CFrame is the camera pose.`,
			);
		}

		print(
			`[TreadmillCamera] mounted part=${this.part === undefined ? "none" : this.part.GetFullName()} fov=${tostring(camera === undefined ? "none" : camera.FieldOfView)} character=${tostring(this.character() !== undefined)}`,
		);

		// **A part tagged after boot is picked up, not ignored.** The scene can arrive after this client's scripts, and a
		// Studio session that tags the part while the game is running should not need a restart to see it work.
		this.connections.push(
			CollectionService.GetInstanceAddedSignal(TAGS.treadmillCamera).Connect((instance) => {
				if (this.part !== undefined || !instance.IsA("BasePart")) {
					return;
				}

				this.part = instance;
				print(`[TreadmillCamera] attached late part=${instance.GetFullName()}`);
				this.observe();
			}),
		);

		this.connections.push(roundState.GetPropertyChangedSignal("Value").Connect(() => this.observe()));

		// **The competitor flag, read once and then watched (item 193).** Read at boot because a client can start mid-round,
		// and watched because it arrives asynchronously: the server writes it when a body is spawned, which may be before or
		// after `RoundState` changes, and the camera must react to whichever lands second. `SetAttribute` on a `Player` reaches
		// only that player, so this is a local read of a local fact.
		const player = Players.LocalPlayer;
		if (player !== undefined) {
			this.readCompeting(player);
			this.connections.push(
				player.GetAttributeChangedSignal(PLAYER_COMPETING_ATTRIBUTE).Connect(() => this.readCompeting(player)),
			);
		}

		this.watchCharacter();
		this.observe();
	}

	/**
	 * The camera, or `undefined` if this client has none yet.
	 *
	 * Re-read rather than captured: `Workspace.CurrentCamera` is replaced when the player's character spawns under some
	 * settings, and a captured reference would then be a camera nobody renders.
	 */
	private camera(): Camera | undefined {
		return Workspace.CurrentCamera;
	}

	/** The local player's current character, or `undefined` while it is loading or gone. */
	private character(): Model | undefined {
		const player = Players.LocalPlayer;
		const character = player === undefined ? undefined : player.Character;
		return character !== undefined && character.Parent !== undefined ? character : undefined;
	}

	/**
	 * Watches both halves of a respawn: the old character leaving, and the new one arriving.
	 *
	 * ## The bug this replaced (item 212)
	 *
	 * `CharacterRemoving` suppressed the arena camera for the rest of the round, on the argument that "a player who resets has
	 * lost the race". That was written when item 186 was the only camera rule, and it stopped being true when `Competing` began
	 * deciding who is racing: a competitor's ball is still on the belt after a reset, so they have not lost anything. The
	 * observable result was a player who reset mid-`Playing` sitting on the lobby camera for the rest of the round with
	 * `competing = true`, unable to get the arena back - the spectator button is not offered to a competitor, so there was no
	 * path of any kind to recover.
	 *
	 * ## The rule now
	 *
	 * **The camera follows the state, not the history.** On removal, the camera is given back only when the arena is *not*
	 * wanted - the same `cameraWantsArena(phase, competing, spectating)` every other decision reads. When the arena *is* wanted,
	 * removal does nothing at all: the camera stays scripted on the tagged part, which is where the player belongs and which does
	 * not depend on their body existing.
	 *
	 * On arrival, `observe()` runs. That is what re-engages if anything released the camera in the gap - and it is also what
	 * gives back the character camera to a player whose phase ended while they were dead. Item 186 assumed `CharacterAdded` would
	 * need a "first spawn or reset" comparison; it does not, because there is no longer any state for a reset to set.
	 *
	 * ## Why `CharacterRemoving` still exists at all
	 *
	 * Because the engine's default is to follow the character, and a player whose arena camera is no longer wanted has to be
	 * handed back *before* their body vanishes - `restore` picks the humanoid or the head as the subject, and after removal
	 * neither exists. The handler is therefore the give-back path, not a suppression path.
	 */
	private watchCharacter(): void {
		const player = Players.LocalPlayer;
		if (player === undefined) {
			return;
		}

		this.connections.push(
			player.CharacterRemoving.Connect(() => {
				const state = this.roundState;
				if (!this.engaged || state === undefined) {
					// Not scripted, so there is nothing to hand back.
					return;
				}

				// **The state decides, not the fact that a character is going away.** The arena is still wanted: leave the camera
				// where it is and let `CharacterAdded` re-assert it. This is the whole fix - the old code suppressed here
				// unconditionally and never re-engaged.
				if (cameraWantsArena(state.Value, this.competing, this.spectating)) {
					return;
				}

				this.restore("character loss", this.generation);
			}),
		);

		this.connections.push(
			player.CharacterAdded.Connect(() => {
				// **Deferred one resumption.** `CharacterAdded` fires before the new body is parented, so `character()` can still
				// return `nil` on the synchronous pass - and `isActive()` refuses to engage without one. Re-observing immediately
				// would therefore do nothing at all on some clients, which is the failure this handler exists to fix.
				task.defer(() => {
					// **Read before `observe`, because "re-engaged" means the camera was already on the arena and stayed there.**
					// A first spawn engages from nothing, and printing the reset line there would make a normal join look like a
					// recovery.
					const wasEngaged = this.engaged;

					this.observe();

					// One line per reset that keeps the arena camera, because the alternative - a silent re-engage - is
					// indistinguishable from the bug in a log.
					const part = this.part;
					const state = this.roundState;
					if (wasEngaged && this.engaged && part !== undefined && state !== undefined) {
						print(
							`[TreadmillCamera] reset-reengage part=${part.GetFullName()} phase=${state.Value} generation=${this.generation} competing=${tostring(this.competing)}`,
						);
					}
				});
			}),
		);
	}

	/** Resolves the tagged part, preferring a `BasePart` and accepting a `Model` with a `PrimaryPart`. */
	private findPart(): BasePart | undefined {
		for (const instance of CollectionService.GetTagged(TAGS.treadmillCamera)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance;
			}

			if (instance.IsA("Model") && instance.PrimaryPart !== undefined) {
				return instance.PrimaryPart;
			}
		}

		return undefined;
	}

	/**
	 * Whether the camera should be scripted right now.
	 *
	 * Three things must hold: a part exists to copy, a character exists to hand the camera back to later, **and the player wants
	 * the arena** - which is `cameraWantsArena`: a competitor always does in these phases, and a non-competitor only while they
	 * have pressed Watch Race.
	 *
	 * **There is no fourth term, and that is the item 212 fix.** A reset used to add "unless this player reset during this round",
	 * which is the same claim `Competing` makes and the server makes better: it is written at spawn, at elimination and at teardown,
	 * and it survives a respawn because it lives on the `Player` rather than on the character.
	 *
	 * **The character test is not decoration.** `CameraType = Custom` with no `Subject` leaves the camera at the origin
	 * staring at nothing, and a player with no body is not watching a race. Keeping the default camera for that case is
	 * strictly better than a scripted camera with nothing to release it to. It is also why a spectator still needs a
	 * character: the restore hands the camera back to it.
	 */
	private isActive(): boolean {
		const state = this.roundState;
		if (state === undefined || this.part === undefined || this.character() === undefined) {
			return false;
		}

		// **The whole rule, and the reason there is no suppression term beside it (item 212).** A reset used to suppress the
		// arena camera for the rest of the round, on the argument that a player who reset had lost the race. `Competing` is now
		// the flag that answers "is this player still racing" - written by the server at spawn, at elimination and at teardown -
		// so a competitor who resets mid-race is still competing and their camera belongs on the arena. A second local flag
		// saying otherwise is a second opinion about a fact the server already publishes.
		return cameraWantsArena(state.Value, this.competing, this.spectating);
	}

	/** Reads the replicated "am I in this round" flag and re-runs the rule if it changed. */
	private readCompeting(player: Player): void {
		const raw = player.GetAttribute(PLAYER_COMPETING_ATTRIBUTE);
		const competing = raw === true;

		if (competing === this.competing) {
			return;
		}

		this.competing = competing;
		print(`[TreadmillCamera] competing=${tostring(competing)} phase=${this.phaseName()}`);
		this.observe();
	}

	/**
	 * **The spectator's override**, called by `SpectateController` when the button is pressed.
	 *
	 * It sets the flag and re-runs `observe`, which is the whole implementation: pressing Spectate makes `isActive` true and
	 * engages through the ordinary path; pressing Stop spectating makes it false and **restores through the same branch a
	 * phase change uses** — `observe`'s `if (this.engaged)` call to `restore`, which is `CameraSubject` then `CameraType`.
	 * There is no second restore path here, because a second one is a second thing to get wrong: the first version of this
	 * camera shipped a hand-written restore that left the old `CameraSubject` behind.
	 *
	 * **The latch is not cleared by a phase change**, which is what makes the toggle survive one: `spectating` is only ever
	 * written here and by the button, so `Waiting → Playing → PostGame` re-evaluates the same answer. It is cleared by the
	 * spectate button when the player stops, and — the case that matters — the button clears it when this player becomes a
	 * competitor, because a racer must never be watching their own ball from a fixed pose.
	 */
	public setSpectating(on: boolean): void {
		if (this.spectating === on) {
			return;
		}

		this.spectating = on;
		// **The latch is mirrored into the shared module (item 209).** The freeze controller cannot read this controller without a
		// controller-to-controller edge for one boolean, and the camera cannot be the only owner of a fact that decides whether a
		// character may walk. `setSpectating` stays the single writer and this is the one line that publishes it.
		moduleSetSpectating(on);
		print(`[TreadmillCamera] spectating=${tostring(on)} phase=${this.phaseName()}`);
		this.observe();
	}

	/** The current phase, or `none` before `RoundState` has replicated. For log lines only. */
	private phaseName(): string {
		const state = this.roundState;
		return state === undefined ? "none" : state.Value;
	}

	/**
	 * Applies the rule to whatever the phase and the world currently say.
	 *
	 * Called on every `RoundState` change, once at boot, on a late tag, and by nothing else — there is no per-frame work here
	 * because a camera pose does not change during a round.
	 */
	private observe(): void {
		const state = this.roundState;
		const part = this.part;
		if (state === undefined || part === undefined) {
			return;
		}

		const phase = state.Value;

		// **The generation still bumps on `Waiting` entry, but only as a label on the log lines** (item 212). It used to be what
		// ended a reset suppression; that suppression is gone, because `Competing` now answers the question it was standing in for.
		if (phase === "Waiting") {
			this.generation++;
		}

		if (this.isActive()) {
			this.engage(part, phase);
			return;
		}

		// **Restore on anything else, always.** `Intermission` is the normal trigger (under the wipe item 49 wraps around
		// `PostGame → Intermission`); every other phase that is not one of the three is treated the same way rather than
		// special-cased, so a phase added later releases the camera by default instead of stranding it.
		if (this.engaged) {
			this.restore(phase === "Intermission" ? "round end" : `phase ${phase}`, this.generation);
		}
	}

	/**
	 * Takes the camera: `Scriptable` first, then the pose.
	 *
	 * **`CameraType` before `CFrame`.** Setting the pose first would be a frame of a scripted camera still following the
	 * character; the reverse order means the very first frame the engine renders under `Scriptable` is already the right
	 * pose. `CameraSubject` is cleared for the same reason — under `Scriptable` it does nothing, and leaving the old subject
	 * behind would make the restore branch's job ambiguous.
	 */
	private engage(part: BasePart, phase: string): void {
		const camera = this.camera();
		if (camera === undefined) {
			return;
		}

		camera.CameraType = Enum.CameraType.Scriptable;
		camera.CFrame = part.CFrame;

		if (!this.engaged) {
			this.engaged = true;
			print(`[TreadmillCamera] active part=${part.GetFullName()} phase=${phase} generation=${this.generation}`);
		}
	}

	/**
	 * Gives the camera back: `CameraSubject` first, then `Custom`.
	 *
	 * ## Why the subject comes first
	 *
	 * `CameraType = Custom` with no subject falls back to the camera's current `CFrame` and does not follow the character;
	 * setting the subject first means the engine has something to attach to on the very frame the type changes. The subject
	 * is the humanoid when there is one, else the head — a character with no humanoid is still a body worth following, and
	 * the head is always there.
	 *
	 * ## Why `Custom` and not the player's saved type
	 *
	 * `Custom` is the default a player starts with, and this controller only ever took the camera from `Custom`-like
	 * behaviour. Reading back whatever type the player had chosen would need a snapshot per round and would restore a
	 * *scriptable* type if the player was already in one, which is the one state that leaves the camera with no follow at all.
	 *
	 * ## No new character yet
	 *
	 * `CharacterRemoving` fires before the replacement exists, so the restore runs with `character()` still returning the old
	 * body (it is being removed, not yet gone) or nothing at all. Either way the type goes back to `Custom` with whatever
	 * subject is available; the engine follows the new body when it appears. **`Scriptable` is deliberately not held** —
	 * holding it would leave the player staring at the arena with no way back.
	 */
	private restore(reason: string, generation: number): void {
		const camera = this.camera();
		if (camera === undefined) {
			return;
		}

		const character = this.character();
		const humanoid = character === undefined ? undefined : character.FindFirstChildWhichIsA("Humanoid");
		const head = character === undefined ? undefined : character.FindFirstChild("Head");

		// `Humanoid` wins because it is what a follow camera actually tracks; `Head` is the fallback for a body mid-load.
		const subject =
			humanoid !== undefined ? humanoid : head !== undefined && head.IsA("BasePart") ? head : undefined;

		camera.CameraSubject = subject;
		camera.CameraType = Enum.CameraType.Custom;
		this.engaged = false;

		// **One shape, and `character=` on it (item 212).** The two shapes existed because the character-loss path printed a
		// suppression number the others did not have; the suppression is gone, so the field is now `generation` on every line and a
		// reader can compare two restores directly. `character=` stays: a restore with no subject is the one case where the camera
		// goes to `Custom` with nothing to follow, and that is invisible from the reason alone.
		print(
			`[TreadmillCamera] restored (${reason}) to=Custom character=${tostring(character !== undefined)} generation=${generation}`,
		);
	}
}
