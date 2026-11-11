import { Debris, ReplicatedStorage, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { HIT_EFFECT_REMOTE_NAME, REMOTES_FOLDER_NAME } from "shared/remotes";
import { HIT_EFFECTS_FOLDER_NAME } from "shared/tuning";
import { playHitSound } from "shared/ui/sounds";
import { HIT_EFFECT_ASSET_NAME, HIT_EFFECT_SCALE_MULTIPLIER } from "shared/config/hitEffect.config";
import { effectScaleForRadius } from "shared/vfx-scale";

/**
 * **The Studio asset's name in `ReplicatedStorage`, and the whole of the contract with it.** A `Part` containing an
 * `Attachment` containing one or more `ParticleEmitter`s. This file never creates it, never substitutes it and never
 * names an asset id: if the instance is missing, the round is misconfigured and says so.
 */
// **Both halves of "what is this effect" now live in its config file** (item 177): the name the Studio asset is authored
// under, and the one scale number a designer changes. The controller keeps the behaviour.
const EFFECT_ASSET_NAME = HIT_EFFECT_ASSET_NAME;

/**
 * **Placeholder.** How long to wait for the `Remotes` folder and the hit-effect remote before giving up and saying so.
 *
 * The remotes are created by `RoundService` at runtime, so a wait is the only correct answer for them. The **asset** is
 * not: it is authored in the place, so it arrives with the rest of `ReplicatedStorage` before this script runs, and it is
 * looked up rather than waited for.
 */
const RESOLVE_TIMEOUT_SECONDS = 10;

/**
 * **Placeholder.** Particles emitted by **each** emitter per hit.
 *
 * Per emitter, not per burst: the asset is hand-made and may carry more than one, and a count shared between them would
 * thin out as emitters are added. 30 is chosen against the size ramp below — the particles start at 0.5 studs and grow to
 * 3.22, so a dozen would read as a few stray dots at the small end while 30 fills the contact point before the ramp opens
 * it out. The user's sequence, not this number, is what makes the burst the right *shape*.
 */
const EMIT_COUNT = 30;

/**
 * The particle lifetime the effect was built around, in seconds — **the user's value, not a placeholder.**
 *
 * It is the number the cleanup is measured from, and it is deliberately not read back off the emitter: a `Sound` clip and
 * a particle both report their length, but the delay has to be one number in one place, and the asset's `Lifetime` is
 * what the burst was tuned to. If a future round changes the emitter's lifetime, this constant changes with it.
 */
const LIFETIME_SECONDS = 0.5;

/** **Placeholder.** Extra time before the carrier is destroyed, so the last particle dies before its parent does. */
const CLEANUP_BUFFER_SECONDS = 0.15;

/**
 * **Placeholder.** The carrier's size, in studs. The carrier is invisible geometry that exists to be a `CFrame` and a
 * parent, so its size only has to be small. `0.1` is a tenth of a ball radius: it cannot intersect anything a player can
 * see, and it is still large enough that the engine never treats it as a degenerate part.
 */
const CARRIER_SIZE = new Vector3(0.1, 0.1, 0.1);

/**
 * The size ramp the effect's owner specified: 0.5 studs at birth, 3.22 at death, envelope 0 on both keypoints.
 *
 * Written as explicit keypoints rather than `new NumberSequence(0.5, 3.22)` — the two-argument constructor produces the
 * same sequence, but it hides the fact that the envelope is zero, and a non-zero envelope would give each particle a
 * random size *range* instead of a size. The explicit form is the same length and says what it means.
 */
const PARTICLE_SIZE_START = 0.5;
const PARTICLE_SIZE_END = 3.22;

/**
 * The ball-ball hit burst: one clone of the Studio effect per hit, built on each client at the point the server reports.
 *
 * ## Why a controller and not a module
 *
 * A module runs when something imports it, and nothing has a reason to import this one — it is a listener, not a library.
 * A `@Controller` is constructed once at boot by Flamework, which is exactly the lifetime this needs, and it is the same
 * shape `EliminationSplashController` uses for the same kind of job: resolve a remote, subscribe, render what arrives.
 * The cost is one line in `flamework.build`, which is generated.
 *
 * ## Why the clone is made here and not on the server
 *
 * A burst is a hierarchy — a part, an attachment, one or more emitters — and cloning it on the server would replicate
 * every instance of every burst to every player. The elimination sound made the same move in item 82 for one `Sound`;
 * the argument is stronger for a tree. Each client builds its own copy at the point the server names, from an asset it
 * already has.
 *
 * ## What this does not decide
 *
 * **It does not decide that a hit happened, and it has no fallback for "maybe".** The remote is the only trigger: no
 * `Touched` listener here, no distance check, no client-side pairing of bodies. A client that decided for itself would
 * draw bursts for contacts the server never saw, which is a different game on every screen.
 *
 * ## The rules the carrier and the clone obey
 *
 * The carrier is **never parented to a ball** — the midpoint of two bodies is not on either of them, and a part welded
 * into a ball would follow a body that the effect does not belong to. It is anchored, so no weld is needed and no
 * constraint has to be cleaned up.
 *
 * Every `BasePart` in the clone gets the same treatment, **including the clone's own root**: the asset is hand-made and
 * its parts were not built with this rule in mind, so a default `CanCollide = true` part at the midpoint would collide
 * with the two balls that just hit each other and change the physics the effect is decorating.
 *
 * ## Why `Debris` and not a hidden part
 *
 * One carrier per hit, kept invisible, is a leak that only shows after a long session — and the belt can produce hits
 * continuously. `Debris.AddItem` destroys it at `LIFETIME_SECONDS + CLEANUP_BUFFER_SECONDS`, and that is the only cleanup
 * path: a second one (a `task.delay` that calls `Destroy`) would be a second owner of the same lifetime, and the two
 * would disagree the first time one was edited. `Debris` is also the documented answer — the service exists for exactly
 * this and survives the instance being re-parented before its clock runs out.
 */
@Controller()
export class HitEffectController implements OnStart {
	/** Resolved once at boot and held — the asset is read **once**, never per hit. */
	private asset?: BasePart;

	public onStart(): void {
		// **Recursive, and by name.** `FindFirstChild(name, true)` walks every descendant of `ReplicatedStorage`, folders
		// included. The one-argument form — which is what this used to be, via `WaitForChild` — looks at **direct
		// children only**, so an asset sitting inside a folder was invisible, the controller warned once and connected
		// nothing, and no burst was ever drawn.
		//
		// The flag is the whole fix. Two alternatives were rejected: `FindFirstChildOfClass("BasePart")` returns the first
		// part of *any* name, which is a different bug wearing the same shape; a hand-written `GetDescendants()` walk is a
		// loop plus a name filter doing what one engine call already does.
		//
		// **No wait any more, deliberately.** The asset is authored in the place, so it is present when the client's
		// scripts start; only a server-created instance needs `WaitForChild`, which is why the `Remotes` resolution below
		// still has one.
		const found = ReplicatedStorage.FindFirstChild(EFFECT_ASSET_NAME, true);

		if (found === undefined) {
			// **Two refusals, two messages.** "Not found" sends the reader to the Explorer to build the asset; "found, but
			// the wrong class" sends them to its class. One message for both — which is what this used to be — sent them
			// nowhere. Neither branch stores anything, so a reference that failed a check can never become the resolved
			// asset.
			warn(
				`[HitEffect] searched ReplicatedStorage recursively for an instance named "${EFFECT_ASSET_NAME}" and found none — hits will draw nothing this session. The effect is a Studio asset: a BasePart containing an Attachment containing one or more ParticleEmitters.`,
			);
			return;
		}

		if (!found.IsA("BasePart")) {
			warn(
				`[HitEffect] found ${found.GetFullName()} but it is a ${found.ClassName}, not a BasePart — hits will draw nothing this session.`,
			);
			return;
		}

		this.asset = found;

		const folder = ReplicatedStorage.WaitForChild(REMOTES_FOLDER_NAME, RESOLVE_TIMEOUT_SECONDS);
		if (folder === undefined) {
			warn(`[HitEffect] no ${REMOTES_FOLDER_NAME} folder — hits will draw nothing.`);
			return;
		}

		const remote = folder.WaitForChild(HIT_EFFECT_REMOTE_NAME, RESOLVE_TIMEOUT_SECONDS);
		if (remote === undefined || !remote.IsA("RemoteEvent")) {
			warn(`[HitEffect] no ${HIT_EFFECT_REMOTE_NAME} remote — hits will draw nothing.`);
			return;
		}

		// **One event, two effects, on the same callback: the burst first, the sound second.** The order is cosmetic —
		// `burst` neither throws nor plays anything, and the sound does not depend on it — and it is written down so a
		// later reader knows it was a decision rather than the order the lines happened to land in: the burst is what the
		// event is *for*, and the sound is that same fact rendered a second time. **No client-side phase gate:** the server
		// fires only from `onBallCollision`, which is behind `powersActive`, so this client plays what it is told. Asking
		// the phase here would be asking a module for a fact the server already applied before it sent anything.
		// **Two fields, and the second is optional at the type level because an older server will not send it.** `radius`
		// arrives as `nil` from a server built before item 176, which `burst` reads as "no size reported" and draws at the
		// asset's authored size. That is the same picture those clients had before, so a mixed deploy degrades to the old
		// behaviour rather than to nothing.
		remote.OnClientEvent.Connect((position: unknown, radius: unknown) => {
			this.burst(position, radius);
			playHitSound(os.clock());
		});

		// **The full path and the class, so a Studio run proves *which* instance was picked.** A recursive search can match
		// something that is not the asset the reader meant only if a second instance of that name exists — this line is
		// how that is noticed instead of inferred. The emitter count is deliberately not here: it is not known until the
		// clone is made, and a count of zero already has its own branch in `burst`.
		print(`[HitEffect] mounted on ${found.GetFullName()} (${found.ClassName})`);
	}

	/**
	 * One burst at one point.
	 *
	 * The order is not incidental:
	 *
	 *  1. build the carrier and the clone **outside** the DataModel,
	 *  2. make every part inert and switch every emitter to explicit-emit only,
	 *  3. parent the tree in one step,
	 *  4. `Emit` each emitter once,
	 *  5. hand the carrier to `Debris`.
	 *
	 * Steps 1–2 happen before step 3 so that no frame exists in which a cloned emitter is enabled and streaming on its
	 * own: an asset authored with `Enabled = true` and a non-zero `Rate` would otherwise have already started spitting
	 * particles before this code could turn it off, and the burst would be a stream with a burst on top.
	 */
	private burst(position: unknown, radius: unknown): void {
		const asset = this.asset;
		if (asset === undefined) {
			return;
		}

		// A server that sends anything else is a bug on the server, and the client's job is to refuse it rather than to
		// crash inside `new CFrame(...)`.
		if (!typeIs(position, "Vector3")) {
			warn(`[HitEffect] ignored a hit whose position was a ${typeOf(position)}, not a Vector3.`);
			return;
		}

		const carrier = new Instance("Part");
		carrier.Name = "HitEffect";
		makeInert(carrier);
		carrier.Size = CARRIER_SIZE;
		carrier.CFrame = new CFrame(position);

		const clone = asset.Clone();
		clone.Name = "Burst";
		makeInert(clone);

		// **The clone is placed at the contact and at the identity rotation, and both halves are deliberate.** This one line
		// is the difference between a burst at the hit and a burst wherever the effect was authored in `ReplicatedStorage` —
		// the template's own position, usually the origin, a hundred-odd studs from the arena. Cloning copies `CFrame`; it
		// does not re-base it onto the new parent, and `makeInert` anchors it, so nothing else would ever move it.
		//
		// **The rotation half used to be described as "the asset's own `CFrame` kept", and that was wrong** (found in item
		// 178 while asking whether this effect could take a heading offset). `carrier.CFrame` is `new CFrame(position)`, whose
		// rotation is identity, so this assignment **discards** the asset root's rotation: the burst is drawn axis-aligned,
		// not at the authored rotation and not belt-ward. That is why it has no heading offset — a number measured "from
		// belt-ward" would be measuring from a direction this frame never took. What a designer still controls here is
		// everything *inside* the asset: child parts, attachment offsets and each emitter's `EmissionDirection` survive the
		// clone, so those are what to rotate in Studio. Making the burst belt-ward is a composition change, not a tuner.
		clone.CFrame = carrier.CFrame;

		for (const descendant of clone.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				makeInert(descendant);
			}
		}

		// **What this number scales: the particles, not the tree (item 179).** Item 176 uniformly scaled the whole clone with
		// `scaleEffect`, which multiplies the root's `Size`, every `Attachment.Position`, every emitter's `Speed` and its
		// `Acceleration` — and then the loop below *replaced* each emitter's `Size` with the fixed `PARTICLE_SIZE_*` ramp. So
		// the one property that decides whether a burst is visible at all was the only one never scaled, while the offsets and
		// speeds that position and launch it were multiplied by the ball ratio.
		//
		// On a 20-stud ball at the old `0.1` that was a ratio of `2` and mostly harmless-looking; at the `100` a designer would
		// reach for to fix an invisible burst it is a ratio of `2000`, which throws the emitter attachment hundreds of studs
		// from the contact and launches its particles at thousands of studs per second for their 0.5-second life. The Studio
		// log showed `radius=10 scale=2000` and no visible burst: the emitter fired, off screen.
		//
		// So the multiplier now scales **the particle ramp**, which is the distance a burst actually reads by. Everything else
		// stays as authored: attachment offsets, ejection speed and acceleration are the effect's design and are authored
		// against a contact point that `clone.CFrame` already places correctly. A missing or non-positive `radius` (an older
		// server, or a body whose `Size` had not replicated) yields `1`, so the burst draws exactly as authored.
		const particleScale = typeIs(radius, "number") ? effectScaleForRadius(radius, HIT_EFFECT_SCALE_MULTIPLIER) : 1;

		const emitters = new Array<ParticleEmitter>();
		for (const descendant of clone.GetDescendants()) {
			if (!descendant.IsA("ParticleEmitter")) {
				continue;
			}

			// The authored ramp, multiplied by the ball ratio — the same shape, proportionally bigger. `NumberSequence` is
			// immutable in the typings, so this rebuilds it; the keypoint times stay `0` and `1` because time is not a
			// distance. Note `ParticleEmitter.Size` is clamped by the engine (100 studs), so a multiplier above `100 / 3.22`
			// saturates the death keypoint rather than growing further.
			descendant.Size = new NumberSequence([
				new NumberSequenceKeypoint(0, PARTICLE_SIZE_START * particleScale, 0),
				new NumberSequenceKeypoint(1, PARTICLE_SIZE_END * particleScale, 0),
			]);
			descendant.Orientation = Enum.ParticleOrientation.FacingCamera;
			// **`Rate = 0`, and `Enabled` left true.** Rate alone is what stops the emitter streaming on its own: an
			// emitter with zero rate emits nothing until `Emit` asks it to. The previous version also forced
			// `Enabled = false` before calling `Emit`, and the typings do not say whether a disabled emitter still emits
			// (`Emit`'s docblock is one sentence: "Emits a given number of particles"). A one-shot burst does not need the
			// flag, so it is set to true explicitly rather than inherited from the asset: `Emit` is then unambiguously
			// legal, and rate `0` still means nothing streams.
			descendant.Rate = 0;
			descendant.Enabled = true;
			// Belt-and-braces on an anchored carrier: locked particles do not trail behind a moving ancestor, and the one
			// line costs nothing if the carrier never moves.
			descendant.LockedToPart = true;
			emitters.push(descendant);
		}

		if (emitters.size() === 0) {
			// The Studio asset is wrong — it has no emitter to fire. Nothing was parented, so nothing has to be cleaned up
			// beyond the carrier this call made. The warning names the **found instance**, not the name that was searched
			// for: by this point the search succeeded, and a reader who is told "hitEffect has no emitter" while looking at
			// one of two instances of that name needs the path to know which one was cloned.
			warn(
				`[HitEffect] ${asset.GetFullName()} contains no ParticleEmitter — no burst was drawn. Check the Studio asset's hierarchy.`,
			);
			carrier.Destroy();
			return;
		}

		clone.Parent = carrier;
		carrier.Parent = this.effectsFolder();

		for (const emitter of emitters) {
			emitter.Emit(EMIT_COUNT);
		}

		// One line per burst, because "I see no effect" cannot be diagnosed from the client otherwise: the server's
		// `[Powers] hit:` line proves the event was sent, and this one proves it arrived, where the carrier was placed and
		// how many emitters were fired. If both print and the screen is still empty, the fault is in the asset (an emitter
		// with no texture, or a lifetime of zero) rather than in this file.
		print(
			`[HitEffect] burst at ${tostring(position)} emitters=${emitters.size()} radius=${tostring(radius)} scale=${tostring(particleScale)} particle=${tostring(PARTICLE_SIZE_START * particleScale)}..${tostring(PARTICLE_SIZE_END * particleScale)}`,
		);

		Debris.AddItem(carrier, LIFETIME_SECONDS + CLEANUP_BUFFER_SECONDS);
	}

	/**
	 * `Workspace.SpawnedHitEffects`, created on demand.
	 *
	 * A folder rather than `Workspace` itself for the reason `SpawnedPickups` exists: a burst among the arena's parts is
	 * indistinguishable from scene geometry in the Explorer, and the one debugging session that matters is exactly when
	 * somebody is looking there. The folder is never cleared and does not need to be — every member destroys itself, so it
	 * is an empty folder between hits rather than a growing one.
	 *
	 * Created locally by each client, so it is that client's folder; nothing about it replicates.
	 */
	private effectsFolder(): Folder {
		const existing = Workspace.FindFirstChild(HIT_EFFECTS_FOLDER_NAME);
		if (existing !== undefined && existing.IsA("Folder")) {
			return existing;
		}

		const folder = new Instance("Folder");
		folder.Name = HIT_EFFECTS_FOLDER_NAME;
		folder.Parent = Workspace;
		return folder;
	}
}

/**
 * Makes one part incapable of affecting anything: no collision, no touch events, no raycast, no pixels, no shadow.
 *
 * Shared by the carrier and by every part in the clone because they need the same seven properties and a second copy of
 * this list is the copy that forgets one. `Anchored` is in the list even though the brief only names the visual and
 * physical four: an unanchored clone part would fall out of the burst while the emitter is locked to it, which drags the
 * whole effect downward.
 */
function makeInert(part: BasePart): void {
	part.Anchored = true;
	part.CanCollide = false;
	part.CanTouch = false;
	part.CanQuery = false;
	part.Transparency = 1;
	part.CastShadow = false;
	part.Massless = true;
}
