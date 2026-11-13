import { CollectionService, Players } from "@rbxts/services";
import { OnStart, Service } from "@flamework/core";
import { TAGS } from "shared/tags";
import {
	TRAMPOLINE_BOUNCE_VELOCITY,
	TRAMPOLINE_COOLDOWN_SECONDS,
	TRAMPOLINE_LAUNCH_FORCE,
	TRAMPOLINE_LAUNCH_SECONDS,
} from "shared/tuning";
import { canBounce } from "server/trampoline";

/**
 * **The lobby trampoline: any `Trampoline`-tagged part bounces a player character that touches it.**
 *
 * ## What this is
 *
 * One `CollectionService` bind, one `Touched` handler, one launch constraint, one per-player contact guard. A designer places a
 * part in the lobby, tags it `Trampoline`, and it becomes a spring. **Nothing here creates, styles or destroys the part** - its
 * `Size`, `Anchored`, `CanCollide`, `Material`, `Color` and `Transparency` are the designer's, and this service writes none of
 * them. That is the `tags.ts` contract: a tag is the only coupling between the scene and the code.
 *
 * **Any `BasePart` is accepted, `MeshPart` included.** Every collection point tests `IsA("BasePart")`, and `MeshPart` reaches
 * that through `MeshPart -> TriangleMeshPart -> BasePart` in the installed typings - so a `Part`, a `MeshPart`, a
 * `WedgePart` or a `UnionOperation` all bind the same way, and a designer can swap the mesh without telling the code. The
 * two properties that decide whether it fires are theirs: **`CanTouch` must be on** (the default) and **`CanCollide` decides
 * whether the character stands on it or falls through** - a non-collidable `MeshPart` with `CanTouch` on is a trigger-shaped
 * trampoline, which is a legitimate choice, not a bug.
 *
 * ## What this is not
 *
 * - **Not a visual and not a sound.** The part is the visual. No `Transparency` write, no `Sound` instance, no particles, no
 *   remote, no attribute.
 * - **Not gated on the phase, and that is not an omission.** A character can only walk onto the part while
 *   `CharacterFreezeController` has it unfrozen - which is `!cameraWantsArena(phase, competing, spectating)`, the lobby view.
 *   A competitor in `Waiting`/`Playing` is frozen at `WalkSpeed = 0` with the controls locked, so they cannot reach it. Adding
 *   a phase check here would be a second copy of a rule the freeze already decides, and the two would eventually disagree.
 * - **Not a ball bounce.** A ball is a `Ball`-tagged `Part` whose parent is a `Folder`, not a character `Model`, so the humanoid
 *   lookup below returns `undefined` and the handler returns. Balls keep bouncing off each other through `onBallCollision`.
 *
 * ## Why the launch is a constraint and not a velocity write (items 229 and 231)
 *
 * The first build wrote `root.AssemblyLinearVelocity = (x, 100, z)` and then `ChangeState(Freefall)`. **A playtest showed the
 * handler firing with `Y` always negative** - `at Y=-18`, `-29`, `-40` - so the character was falling on every recorded bounce
 * and never once left the ground.
 *
 * The second build borrowed the humanoid's own jump (`JumpPower`, a derived `JumpHeight`, `ChangeState(Jumping)`) and wrote the
 * velocity after it. That worked *sometimes*: a playtest reported **a short bounce followed by a higher one**, with the
 * deferred check reading `y=85 state=Freefall floor=Air` on one bounce and `y=4 state=Running floor=SmoothPlastic` on the next
 * - the same handler, the same pad, still standing on it at the check.
 *
 * **That is two writers on one velocity with an ordering that is not deterministic.** The humanoid controller rewrites the
 * root assembly's velocity every step - as a floor correction for a character in contact with a part, and as the jump's own
 * velocity for one it believes is jumping. This handler's write lands somewhere inside that step, so on some frames it is the
 * last word and on others it is overwritten a fraction of a step later. It is item 24's rule (*a force on a body whose velocity
 * another writer rewrites does nothing*) with the controller as the overwriter - and the humanoid's jump API did not help,
 * because it is the same controller writing the same property.
 *
 * So the launch is **a `LinearVelocity` constraint, enabled for `TRAMPOLINE_LAUNCH_SECONDS` and then destroyed**:
 *
 * ```
 * Attachment on the root
 * LinearVelocity: World space, Vector mode, target (0, TRAMPOLINE_BOUNCE_VELOCITY, 0)
 *                 force limited per axis, Y only, TRAMPOLINE_LAUNCH_FORCE
 * ```
 *
 * A constraint is solved *after* the controller has written, so there is one writer that wins every frame instead of two that
 * race. **Y-only force is what keeps it a launch rather than a freeze** - with the force limit off, a `LinearVelocity` also
 * enforces its target on `X` and `Z`, which is zero, and a character launched mid-stride would stop dead horizontally. The
 * attachment and the constraint are both destroyed a few steps later, so nothing keeps pushing once the character is ballistic,
 * and **the humanoid's settings are never touched** - `JumpPower` and `JumpHeight` are the player's own jump, and this service
 * no longer borrows them.
 *
 * ## Why the cooldown is keyed by `Player`
 *
 * The bounce is a per-player fact, and `PlayerRemoving` is already a connected signal in this tree (items 159, 220) so the
 * cleanup follows an existing pattern. A `UserId` key would need nothing extra either, but the value being read at the call
 * site is the `Player` that `GetPlayerFromCharacter` just returned - keying on what you have is one less map lookup in the
 * hot path, and the map never outlives its player.
 */
@Service()
export class TrampolineService implements OnStart {
	private readonly parts = new Set<BasePart>();
	private readonly lastBouncedAt = new Map<Player, number>();
	private readonly connections = new Map<BasePart, RBXScriptConnection>();

	public onStart(): void {
		let tagged = 0;

		for (const instance of CollectionService.GetTagged(TAGS.trampoline)) {
			tagged++;
			this.bindTagged(instance);
		}

		CollectionService.GetInstanceAddedSignal(TAGS.trampoline).Connect((instance) => this.bindTagged(instance));

		// **The removal signal is the unbind.** A part the designer deletes or un-tags stops bouncing; its `Touched` connection
		// would otherwise keep firing into a part that is no longer a trampoline.
		CollectionService.GetInstanceRemovedSignal(TAGS.trampoline).Connect((instance) => {
			if (instance.IsA("BasePart")) {
				this.unbind(instance);
			}
		});

		// **One entry per player, cleared when they leave.** Without this the map would grow by one entry per visitor for the
		// life of the server - the same leak items 159 and 220 closed for the round and the spawner.
		Players.PlayerRemoving.Connect((player) => this.lastBouncedAt.delete(player));

		// **One mount line, always, including when it bound nothing** (item 228). The first build printed only `bound #N`, so a
		// session with no tagged part produced *no line at all* - and "the tag is missing in Studio", "the tag is on a Model
		// instead of the part" and "this service never loaded" were three different causes with one identical symptom: silence.
		// A mount line with `parts=0` turns that into a fact a run can state, which is the same lesson as `[Spawner] steer`
		// (item 223) and the `[Steer]` boot line.
		const count = this.parts.size();
		if (count === 0) {
			warn(
				`[Trampoline] mounted parts=0 tagged=${tagged} — nothing to bounce. Tag a BasePart (Part or MeshPart) "${TAGS.trampoline}" in Studio; the tag goes on the part, not on a Model containing it.`,
			);
			return;
		}

		print(`[Trampoline] mounted parts=${count} tagged=${tagged}`);
	}

	/**
	 * Binds a tagged instance, or says why it cannot be bound.
	 *
	 * **The `IsA` test is what a wrong tag target fails**, and it fails silently without this branch: `CollectionService` returns
	 * whatever carries the tag, so a designer who tags a `Model` gets a tagged `Model` whose `IsA("BasePart")` is false, no bind,
	 * no `Touched`, and - before item 228 - no line either.
	 */
	private bindTagged(instance: Instance): void {
		if (instance.IsA("BasePart")) {
			this.bind(instance);
			return;
		}

		warn(
			`[Trampoline] tagged instance is not a BasePart: ${instance.ClassName} "${instance.GetFullName()}" — put the tag on the part itself`,
		);
	}

	/** Idempotent: the added-signal can fire for a part that is already bound, and a second `Touched` handler would double every bounce. */
	private bind(part: BasePart): void {
		if (this.parts.has(part)) {
			return;
		}

		this.parts.add(part);
		this.connections.set(
			part,
			part.Touched.Connect((other) => this.onTouched(part, other)),
		);

		print(`[Trampoline] bound #${this.parts.size()} ${part.GetFullName()}`);
	}

	private unbind(part: BasePart): void {
		const connection = this.connections.get(part);
		if (connection !== undefined) {
			connection.Disconnect();
			this.connections.delete(part);
		}

		this.parts.delete(part);
	}

	/**
	 * Bounces the character that touched the pad, if this player is allowed to bounce.
	 *
	 * **The humanoid is looked up on the touching part's parent rather than on the touching part itself.** A character `Model`
	 * holds the `Humanoid` as a sibling of `HumanoidRootPart` and of every limb, so a hand or a foot touching the pad fires this
	 * too - and a player who lands on a trampoline with a hand should bounce like one who lands with their feet. The alternative,
	 * a name check on `HumanoidRootPart`, would only fire for the torso and would miss the R6 rigs whose root part is named
	 * differently.
	 *
	 * Everything else is a rejection: no humanoid parent means a scene part or a ball, and no `Player` means a character that is
	 * not a player's (an NPC or a Studio dummy).
	 */
	private onTouched(part: BasePart, other: BasePart): void {
		const character = other.Parent;
		if (character === undefined) {
			return;
		}

		const humanoid = character.FindFirstChildWhichIsA("Humanoid");
		if (humanoid === undefined) {
			return;
		}

		const player = Players.GetPlayerFromCharacter(character);
		if (player === undefined) {
			return;
		}

		if (!canBounce(this.lastBouncedAt.get(player), os.clock(), TRAMPOLINE_COOLDOWN_SECONDS)) {
			// Silent on purpose: a character standing on the pad re-touches it every physics step, so a line per refusal would be
			// sixty lines a second for as long as they stand there.
			return;
		}

		const root = humanoid.RootPart;
		if (root === undefined) {
			return;
		}

		const current = root.AssemblyLinearVelocity;

		this.launch(root);
		this.lastBouncedAt.set(player, os.clock());

		print(
			`[Trampoline] bounced ${player.Name} at Y=${math.round(current.Y)} → ${TRAMPOLINE_BOUNCE_VELOCITY} pad=${part.GetFullName()}`,
		);

		// **One deferred check, because "the handler ran" and "the character left the ground" are different facts and the first
		// two builds could not tell them apart** (item 229). `y` is the root's vertical velocity a fifth of a second later: the
		// servo is gone by then and gravity has been pulling unopposed for `0.14 s`, so anything above about `90` means the
		// launch took. `state` and `floor` name what the rig is doing if it did not - `Running` on a solid `floor` is the
		// grounded controller winning, `Freefall` with a low `y` is something else damping it.
		task.delay(0.2, () => {
			const checkedRoot = humanoid.RootPart;
			if (checkedRoot === undefined || humanoid.Parent === undefined) {
				return;
			}

			print(
				`[Trampoline] launch ${player.Name} y=${math.round(checkedRoot.AssemblyLinearVelocity.Y)} state=${humanoid.GetState().Name} floor=${humanoid.FloorMaterial.Name}`,
			);
		});
	}

	/**
	 * **Pushes the character up with a constraint, not with a velocity write** (item 231).
	 *
	 * A `LinearVelocity` is solved after the humanoid controller has written the root's velocity for the step, so its target is
	 * the last word on `Y` for as long as it exists - which is the whole difference between this and a write the controller
	 * overwrites half the time. `TRAMPOLINE_LAUNCH_SECONDS` is how long it exists: long enough to survive a dropped physics
	 * step, short enough that the character is ballistic well before the apex.
	 *
	 * **`PerAxis` with force on `Y` only.** With the force limit off, the constraint would also drive `X` and `Z` to the zero
	 * in its target vector, stopping a character dead horizontally in the middle of a run. Per-axis Y-only force leaves the
	 * player's own horizontal motion entirely alone, and `TRAMPOLINE_LAUNCH_FORCE` is chosen so the velocity is restored within
	 * a single step even after the controller has zeroed it.
	 *
	 * **Both instances are created per launch and destroyed with it.** Nothing is parented to the character that outlives the
	 * bounce, so the player's rig is exactly as it was a fifth of a second later - the same reason this service writes none of
	 * the pad's properties.
	 */
	private launch(root: BasePart): void {
		const attachment = new Instance("Attachment");
		attachment.Parent = root;

		const servo = new Instance("LinearVelocity");
		servo.Attachment0 = attachment;
		servo.RelativeTo = Enum.ActuatorRelativeTo.World;
		servo.VelocityConstraintMode = Enum.VelocityConstraintMode.Vector;
		servo.VectorVelocity = new Vector3(0, TRAMPOLINE_BOUNCE_VELOCITY, 0);
		servo.ForceLimitsEnabled = true;
		servo.ForceLimitMode = Enum.ForceLimitMode.PerAxis;
		servo.MaxAxesForce = new Vector3(0, TRAMPOLINE_LAUNCH_FORCE, 0);
		servo.Parent = root;

		task.delay(TRAMPOLINE_LAUNCH_SECONDS, () => {
			servo.Destroy();
			attachment.Destroy();
		});
	}
}
