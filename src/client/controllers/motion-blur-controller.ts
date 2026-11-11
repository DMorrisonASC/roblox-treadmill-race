import { CollectionService, ReplicatedStorage, TweenService, Workspace } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import {
	generationOwnsFadeOut,
	MOTION_BLUR_FADE_SECONDS,
	MOTION_BLUR_SCALE,
	motionBlurActionFor,
	motionBlurCloneFrame,
	motionBlurDepthStuds,
} from "shared/motion-blur";
import { ROUND_STATE_VALUE_NAME } from "shared/remotes";
import { TAGS } from "shared/tags";
import { MOTION_BLUR_FOLDER_NAME } from "shared/tuning";
import { scaleEffect } from "shared/vfx-scale";

/**
 * **The Studio asset's name in `ReplicatedStorage`, and the whole of the contract with it.** A `BasePart` carrying one or more
 * `ParticleEmitter`s, exactly like `hitEffect`, `windBoost` and `tailWind` beside it. This file never creates the asset, never
 * substitutes it and never names an asset id: if the instance is missing, the arena is misconfigured and says so once.
 */
const EFFECT_ASSET_NAME = "motionBlur";

/** **Placeholder.** How long to wait for `RoundState` before giving up and saying so. */
const ROUND_STATE_WAIT_SECONDS = 10;

/** One live clone, and everything needed to end it. */
interface BlurRecord {
	/** The cloned tree's root. Named `MotionBlur` in the Explorer. */
	readonly clone: BasePart;
	/** Every emitter found in the clone, in discovery order — the same order as `authoredRates`. */
	readonly emitters: Array<ParticleEmitter>;
	/**
	 * Each emitter's **authored** `Rate`, read from the template copy before anything wrote to it.
	 *
	 * Indexed in parallel with `emitters` because a `Map` keyed by emitter would be a second way to ask the same question, and
	 * the fade tweens are built by walking the array once.
	 */
	readonly authoredRates: Array<number>;
	/**
	 * The generation this clone belongs to. **Bumped only on `Playing` entry**, so it survives the whole life of one round
	 * including its fade-out — which is what makes it the right number for the stale-timer guard.
	 */
	readonly generation: number;
	/** `os.clock()` at clone time, so the destroy line can say how long the effect lived. */
	readonly bornAt: number;
}

/**
 * The arena-wide `motionBlur`: **one clone of the Studio asset, sitting at the `EliminationZone`, alive only during `Playing`.**
 *
 * ## What it is, and what it deliberately is not
 *
 * `Playing` entry clones `ReplicatedStorage…motionBlur` once, positions it at the elimination zone's `CFrame`, enables its
 * emitters and ramps every `Rate` from 0 to whatever the designer authored over `MOTION_BLUR_FADE_SECONDS`. Leaving `Playing`
 * ramps the same rates back to 0 and destroys the tree when they reach it.
 *
 * It is **not** the per-ball trail this tree already has twice. `windBoost` and `tailWind` are driven by `Boosted` /
 * `TailWind` booleans written by `BallSpawnerService`, attached per body, and torn down when the body dies. There is no
 * `MotionBlur` attribute, no server write, and no `forgetBall`-shaped hook here, because the trigger is a **phase** and the
 * phase is already replicated. Copying the attribute mechanism would add a server-side writer for a fact the server already
 * publishes, and a per-body clone for an effect that has no body.
 *
 * ## Why the effect is rebuilt every round rather than toggled
 *
 * A persistent clone with `Enabled` flipped would still need a per-round `Rate` tween and a per-round generation, so it saves
 * nothing but one `Destroy()` — and it costs the invariant that "the arena effect exists only while a round does". It would
 * also carry a stale `CFrame` if the zone were moved between rounds, which is precisely what a Studio session is for. The
 * per-round clone is the `hitEffect` shape (item 84) at a larger scale, and the destroy is the whole cleanup.
 *
 * ## Why the fade is `Rate` and not `Enabled`
 *
 * `Enabled = false` at the start of a fade would drop every live particle on the frame it flipped — a cut, not a fade. `Rate`
 * stops *new* particles while the existing ones live out their `Lifetime`, which is what a fade looks like for a streaming
 * emitter. The `Enabled` flag is therefore only ever used as an off-world guard (so nothing streams before the tree is in the
 * world) and is set once to `true`; the ramp does the rest.
 *
 * ## What this controller does not decide
 *
 * **When a round begins.** It reads `ReplicatedStorage.RoundState`, the same replicated value every other HUD-ish controller
 * reads, and it does not ask `RoundService` anything — a client cannot. It also does not decide *where* the zone is: it asks
 * `CollectionService` for the tag, which is the same question `RoundService.findZone` asks on the server, so a client and the
 * server can never disagree about which part bounds the play area.
 */
@Controller()
export class MotionBlurController implements OnStart {
	/** Resolved once at boot and held — the asset is read **once**, never per round. */
	private asset?: BasePart;

	/**
	 * The template's **authored rotation**, captured once at boot.
	 *
	 * ## Why the asset's rotation wins over the zone's (item 142)
	 *
	 * Item 141 composed the clone's `CFrame` out of the zone alone, so the zone's orientation replaced the asset's — and the
	 * symptom was item 97's, one object class over: the user rotated the asset in Studio, and the effect rendered at the wrong
	 * angle because the controller overwrote it. A **fixture** gives a stable *position*; it has no opinion about which way an
	 * author drew a particle emitter. Only the asset knows that, and it says so with its `CFrame`.
	 *
	 * The other half of item 141's reasoning was sound and is preserved: the position is the zone's, taken from
	 * `motionBlurAnchor`'s front face, so moving or resizing the fixture moves the effect with it.
	 *
	 * Captured **once**, like `windBoost`'s (`assetRotation` in that controller, item 97) and for the same reason: the asset is
	 * authored in the place and does not change between rounds, so a per-clone read would be a second source that could disagree
	 * with the boot line reporting it.
	 *
	 * Read **after** both refusals below, never before: a non-`BasePart` that happens to have a `CFrame` would otherwise set this
	 * field for a controller that can never build a clone, and the refusal would look like a success in one log field.
	 */
	private assetRotation = CFrame.identity;

	/** The clone currently in the world, if any. At most one. */
	private current?: BlurRecord;

	/**
	 * A monotone counter, bumped on every `Playing` entry and **never** on a fade-out.
	 *
	 * A fade-out is not instant: `Rate` ramps to 0 over `MOTION_BLUR_FADE_SECONDS` and only then destroys the tree, and the
	 * phase can come all the way back round inside that window (a debug key does it in one press). The pending callback
	 * therefore carries the generation it was scheduled under and refuses to act if the counter has moved — see
	 * `generationOwnsFadeOut` for the sequence it protects and why the test is equality.
	 */
	private generation = 0;

	/**
	 * Whether the missing-zone warning has been printed this session.
	 *
	 * **Once per session, not once per phase entry** — the `hitEffect` precedent for a missing remote, and for the same
	 * reason: a warning that repeats every fifteen seconds is a warning a reader learns to scroll past. The **lookup** still
	 * runs on every `Playing` entry, so tagging the zone mid-session starts working on the next round without a rejoin; only
	 * the message is throttled.
	 */
	private warnedNoZone = false;

	public onStart(): void {
		// **Recursive, and by name** — item 85's fix, which `windBoost`, `tailWind` and `hitEffect` all carry. The
		// one-argument form looks at direct children only, so an asset inside a folder (`assets/vfx/…`) is invisible to it and
		// the controller warns once and connects nothing. No wait: the asset is authored in the place, so it is present when
		// the client's scripts start, unlike `RoundState` below, which the server creates at runtime.
		const found = ReplicatedStorage.FindFirstChild(EFFECT_ASSET_NAME, true);

		if (found === undefined) {
			warn(
				`[MotionBlur] searched ReplicatedStorage recursively for an instance named "${EFFECT_ASSET_NAME}" and found none — the arena will have no motion blur this session. The effect is a Studio asset: a BasePart containing one or more ParticleEmitters.`,
			);
			return;
		}

		if (!found.IsA("BasePart")) {
			// Two refusals, two messages: "not found" sends the reader to the Explorer to build the asset, "found but the wrong
			// class" sends them to its class. Neither branch stores anything, so a failed check can never become `this.asset`.
			warn(
				`[MotionBlur] found ${found.GetFullName()} but it is a ${found.ClassName}, not a BasePart — the arena will have no motion blur this session.`,
			);
			return;
		}

		this.asset = found;

		// **After both refusals, and that ordering is the point.** A `Model` has a `CFrame`; assigning this before the `IsA`
		// check would leave a rotation captured for a controller that returns on the next line, and the boot line that never
		// prints would be the only clue. Here the two statements are one fact: "this is the asset, and this is how it is turned".
		this.assetRotation = found.CFrame.Rotation;

		const value = ReplicatedStorage.WaitForChild(ROUND_STATE_VALUE_NAME, ROUND_STATE_WAIT_SECONDS);
		if (value === undefined || !value.IsA("StringValue")) {
			warn(`[MotionBlur] no ${ROUND_STATE_VALUE_NAME} — the arena will have no motion blur this session.`);
			return;
		}

		// **The boot line is where the tuning is proved to be read, not guessed.** The emitter count and the authored rates come
		// from the asset, so a reader comparing this line with the Explorer sees the same numbers; `scale` and `fade` are printed
		// because they are this file's two decisions and nothing else in the session reports them.
		//
		// **`assetRotation=` last, and printed in degrees in the engine's own order.** `ToOrientation()` returns the angles in
		// *radians*, applied in Z, X, Y order — the typings say so in as many words — and `math.deg` converts them to the numbers
		// a `Part`'s `Orientation` box shows in Studio. That is the whole purpose of the field: a reader looking at "the effect is
		// the wrong way round" compares this triple against the Properties pane without a rebuild. It comes from
		// `this.assetRotation` rather than from `found.CFrame` so the line reports what was **captured**, which is what the clone
		// will actually use.
		const rates = new Array<string>();
		for (const descendant of found.GetDescendants()) {
			if (descendant.IsA("ParticleEmitter")) {
				rates.push(tostring(descendant.Rate));
			}
		}

		print(
			`[MotionBlur] mounted on ${found.GetFullName()} (${found.ClassName}) emitters=${rates.size()} rates=${rates.join(",")} scale=${MOTION_BLUR_SCALE} fade=${MOTION_BLUR_FADE_SECONDS}s assetRotation=${describeOrientation(this.assetRotation)}`,
		);

		// **Immediate read, then subscribe** — item 39's pattern, the same one `round-state-controller`,
		// `leaderboard-controller` and `round-song-controller` use. A client can join mid-round, and a controller that only
		// subscribed would sit with no effect until the next transition, which is a whole round of silence for the player who
		// joined during it. The read is deliberately **not** deferred a frame: a `Sound` or a particle tree has no dependency on
		// a layout pass, unlike the UI that defers for `AbsoluteSize`.
		this.apply(value.Value);

		// `GetPropertyChangedSignal` rather than `Changed`: the latter also fires for `Parent`, `Name` and anything else a
		// replicated value can have, and this handler clones a tree and starts tweens — too expensive to run for a property that
		// is not the phase.
		value.GetPropertyChangedSignal("Value").Connect(() => {
			this.apply(value.Value);
		});
	}

	/** One dispatch for every phase, so the whole policy is visible in one place. */
	private apply(phase: string): void {
		const action = motionBlurActionFor(phase, this.current !== undefined);

		if (action === "show") {
			this.show();
		} else if (action === "hide") {
			this.hide();
		}
	}

	/**
	 * Builds one clone at the zone and fades it in.
	 *
	 * **A restart destroys before it creates.** `Playing → Playing` (debug key 3, item 38) means the competitors were rebuilt,
	 * so the overlay is rebuilt too: the copy is not resumed, its `Rate` starts again at 0, and there is never a frame with two
	 * blur trees in the world. No fade-out on that path — a crossfade between two identical arena effects is motion for its own
	 * sake, and the old one belongs to a round that no longer exists.
	 */
	private show(): void {
		const asset = this.asset;
		if (asset === undefined) {
			return;
		}

		this.generation++;
		const generation = this.generation;

		const previous = this.current;
		if (previous !== undefined) {
			this.current = undefined;
			// **"(restart)" covers two paths, and they are the same event from the effect's point of view.** `Playing → Playing`
			// (debug key 3) replaces one round with another inside the phase; `PostGame → Playing` in under
			// `MOTION_BLUR_FADE_SECONDS` catches the previous clone while it is still fading out. Either way the old tree belongs to
			// a round that is over, so it goes now rather than at the end of a fade nobody is watching, and the pending
			// `hide` callback is left to be refused by its generation guard.
			print(`[MotionBlur] destroy early (restart) generation=${previous.generation}`);
			previous.clone.Destroy();
		}

		// **The zone is looked up per entry, not cached at boot.** `RoundService.findZone` is itself a live tag scan every
		// second rather than a remembered part, so a cached client reference would be a second resolution path and would go
		// stale the moment somebody re-tags the boundary in Studio — the one session where this matters. It is also cheap: one
		// walk of a tag list that holds one instance.
		const zone = this.findZone();
		if (zone === undefined) {
			if (!this.warnedNoZone) {
				this.warnedNoZone = true;
				warn(
					`[MotionBlur] no part is tagged ${TAGS.eliminationZone} — the arena will have no motion blur until one is. The effect is positioned at that zone, so without it there is nowhere to draw.`,
				);
			}
			return;
		}

		const record = this.cloneMotionBlur(asset, zone, generation);
		if (record === undefined) {
			return;
		}

		this.current = record;

		// **`Enabled` last, and the ramp begins from an explicit zero.** Off-world the emitters were switched off and their
		// rate set to 0 (see `cloneMotionBlur`), so between `Parent` and this line the tree can draw nothing. Enabling before
		// parenting would emit a frame's worth of particles into a tree with no world position — invisible work, and a
		// diagnostic that lies about when the effect started.
		for (const emitter of record.emitters) {
			emitter.Enabled = true;
		}

		for (let index = 0; index < record.emitters.size(); index++) {
			const emitter = record.emitters[index];
			const authored = record.authoredRates[index];

			TweenService.Create(
				emitter,
				new TweenInfo(MOTION_BLUR_FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{
					Rate: authored,
				},
			).Play();
		}

		print(
			`[MotionBlur] show generation=${generation} zone=${zone.GetFullName()} pos=${tostring(record.clone.Position)} depth=${formatSeconds(motionBlurDepthStuds(zone.Size.X))} emitters=${record.emitters.size()}`,
		);
	}

	/**
	 * Ramp every emitter's `Rate` to 0 and destroy the tree when it arrives.
	 *
	 * **`Enabled` is left alone here, deliberately.** Disabling an emitter at the start of the fade drops its live particles on
	 * the frame it flips, which reads as a cut; `Rate = 0` stops new ones and lets the existing ones live out their `Lifetime`,
	 * and the destroy at the end is what cleans up. The brief says "fades out" — this is what a fade out *is* for a streaming
	 * emitter.
	 */
	private hide(): void {
		const record = this.current;
		if (record === undefined) {
			return;
		}

		print(`[MotionBlur] hide generation=${record.generation}`);

		for (const emitter of record.emitters) {
			TweenService.Create(
				emitter,
				new TweenInfo(MOTION_BLUR_FADE_SECONDS, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
				{
					Rate: 0,
				},
			).Play();
		}

		const scheduled = record.generation;

		task.delay(MOTION_BLUR_FADE_SECONDS, () => {
			// **Two guards, one invariant.** The generation is the one that matters: it is bumped only by a `Playing` entry, so a
			// fade-out that resolves after the phase has cycled back round refuses to touch the new round's clone. The identity
			// check catches a record replaced without a bump — which this code cannot do today, and which a later edit could.
			if (!generationOwnsFadeOut(this.generation, scheduled)) {
				return;
			}

			if (this.current !== record) {
				return;
			}

			this.current = undefined;
			record.clone.Destroy();

			print(`[MotionBlur] destroyed generation=${scheduled} age=${formatSeconds(os.clock() - record.bornAt)}s`);
		});
	}

	/**
	 * Builds the tree, inert and silent, and parents it at the zone.
	 *
	 * The order is `hitEffect`'s (item 84) with two additions — a scale, and a captured rate per emitter — and every step is
	 * before `Parent` for the same class of reason:
	 *
	 *  1. **clone off-world**, so nothing is ever rendered at the template's own position;
	 *  2. **make every part inert**, because an authored part with default collision would collide with the balls the effect is
	 *     decorating, and every ball in the arena passes through a zone-sized box;
	 *  3. **read each emitter's authored rate, then zero it and disable it**, so the tree cannot stream a single particle
	 *     before this method decides to start it;
	 *  4. **scale**, still off-world, so no frame shows the unscaled tree;
	 *  5. **set the `CFrame`, then parent** — `Clone()` copies the template's transform and parenting does not re-base it
	 *     (item 86). Skipping this line is what put the first hit burst, and then the first wind trail, a hundred studs from the
	 *     arena: the effect renders wherever the asset was authored.
	 *
	 * There is no weld and there must not be one (item 96): a `WeldConstraint` preserves the offset two parts already had, and
	 * the zone is static, so a weld would only be a way to reintroduce that bug the first time somebody moves the zone.
	 */
	private cloneMotionBlur(asset: BasePart, zone: BasePart, generation: number): BlurRecord | undefined {
		const clone = asset.Clone();
		clone.Name = "MotionBlur";

		makeInert(clone);
		for (const descendant of clone.GetDescendants()) {
			if (descendant.IsA("BasePart")) {
				makeInert(descendant);
			}
		}

		const emitters = new Array<ParticleEmitter>();
		const authoredRates = new Array<number>();
		const silent = new Array<string>();

		for (const descendant of clone.GetDescendants()) {
			if (!descendant.IsA("ParticleEmitter")) {
				continue;
			}

			// **The capture point.** Read from the clone before anything writes to it, so a designer retuning the asset between
			// rounds is picked up at the next clone rather than at the next build — the same "read the asset once per use"
			// rule `hitEffect` follows for its size ramp. An emitter authored at 0 cannot fade in from anywhere, and a reader
			// looking at a motionless effect needs to know which emitter is responsible.
			const authored = descendant.Rate;
			emitters.push(descendant);
			authoredRates.push(authored);

			descendant.Rate = 0;
			descendant.Enabled = false;

			if (authored <= 0) {
				silent.push(descendant.GetFullName());
			}
		}

		if (emitters.size() === 0) {
			warn(
				`[MotionBlur] ${asset.GetFullName()} contains no ParticleEmitter — the arena will have no motion blur. Check the Studio asset's hierarchy.`,
			);
			clone.Destroy();
			return undefined;
		}

		// Nothing to fade in from and nothing to show: an asset whose every emitter is authored at rate 0 is a tree that will
		// draw nothing, so it is refused rather than parented and left invisible. A reader who sees this line should look at
		// the asset's `Rate` values, not at this controller.
		let ramping = 0;
		for (const authored of authoredRates) {
			if (authored > 0) {
				ramping++;
			}
		}

		if (ramping === 0) {
			warn(
				`[MotionBlur] every emitter in ${asset.GetFullName()} has Rate <= 0 — nothing would be emitted, so no effect was created.`,
			);
			clone.Destroy();
			return undefined;
		}

		if (silent.size() > 0) {
			warn(`[MotionBlur] ${silent.size()} emitter(s) authored at Rate 0 will stay hidden: ${silent.join(", ")}`);
		}

		// **The scale, off-world, through the shared five-property implementation** (item 101). `MOTION_BLUR_SCALE` is this
		// effect's own number — since item 177 every ball effect has its own in `shared/config/`, and none of them is this
		// one. See the constant's docblock for why a zone overlay is not ball-relative.
		scaleEffect(clone, MOTION_BLUR_SCALE);

		// **`CFrame` before `Parent`.** `Clone()` copies the template's transform; parenting does not re-base it and the clone is
		// anchored, so nothing else will ever move it. This one line is the difference between the effect at the zone and the
		// effect wherever the asset happens to sit in `ReplicatedStorage`.
		//
		// **Position from the zone's front face, rotation from the asset** — item 142, and item 97's rule applied to a
		// fixture-anchored clone. `motionBlurCloneFrame` is where that composition lives so the spec can assert it; composing it
		// here as `anchor.mul(rotation)` (or as `anchor` alone, which is what item 141 shipped) would silently render the effect at
		// the **zone's** orientation and override the rotation the user set in Studio.
		clone.CFrame = motionBlurCloneFrame(zone.CFrame, zone.Size.X, this.assetRotation);

		clone.Parent = this.effectsFolder();

		return {
			clone,
			emitters,
			authoredRates,
			generation,
			bornAt: os.clock(),
		};
	}

	/**
	 * The tagged elimination zone, or `undefined`.
	 *
	 * **The same question `RoundService.findZone` asks, deliberately.** That method is a live `GetTagged` walk filtered to
	 * `BasePart` with a live parent, not a cached instance, so this one is too: a client and the server cannot then disagree
	 * about which part bounds the arena, and re-tagging in Studio takes effect on the next round with no rejoin.
	 *
	 * A tagged **`Model`** is skipped rather than supported. The server's filter is `IsA("BasePart")`, so a model would eliminate
	 * nobody — drawing an arena-wide effect around a boundary the round does not use would be a second, quieter reading of the
	 * same tag, and the two would eventually disagree. If the fixture ever becomes a model, both sides change together.
	 */
	private findZone(): BasePart | undefined {
		for (const instance of CollectionService.GetTagged(TAGS.eliminationZone)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				return instance;
			}
		}

		return undefined;
	}

	/**
	 * `Workspace.SpawnedMotionBlur`, created on demand.
	 *
	 * Client-side and per-client, like `SpawnedHitEffects`: the clone is never replicated and never outlives a round. Not a
	 * child of the zone — see `MOTION_BLUR_FOLDER_NAME`.
	 */
	private effectsFolder(): Folder {
		const existing = Workspace.FindFirstChild(MOTION_BLUR_FOLDER_NAME);
		if (existing !== undefined && existing.IsA("Folder")) {
			return existing;
		}

		const folder = new Instance("Folder");
		folder.Name = MOTION_BLUR_FOLDER_NAME;
		folder.Parent = Workspace;
		return folder;
	}
}

/**
 * Makes one part incapable of affecting anything: no collision, no touch events, no raycast, no pixels, no shadow.
 *
 * Copied from `hit-effect-controller` rather than imported, and the copy is deliberate: that one is a module-private helper in
 * a client controller, and a `shared/` module for seven property assignments would be a third place for the list to live while
 * the two VFX paths that need it are one file each. If a fourth needs it, it moves.
 *
 * `Anchored` is in the list even though the brief names only the visual and physical four: an unanchored clone part would fall
 * out of the arena while the emitters are locked to it, which drags the whole effect downward.
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

/** Seconds to two places, so the destroy line is readable without `string.format`. */
function formatSeconds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}

/**
 * A rotation as three degrees, in the order the engine reports them: `ToOrientation()` is `toEulerAnglesYXZ`.
 *
 * ## Why degrees, and why this order
 *
 * Because the field exists to be compared with a **Studio Properties pane**, and a `Part`'s `Orientation` box shows degrees. The
 * typings are explicit that `ToOrientation` returns *"approximate angles that could be used to generate `CFrame`, if angles were
 * applied in Z, X, Y order (Equivalent to `toEulerAnglesYXZ`)"* — so it is **not** XYZ, despite what a reader might assume from
 * the three-field shape, and the values are radians. Both facts are the reason this is a named helper with a docblock rather
 * than three inline `math.deg` calls: the conversion is one word, the order is the trap.
 *
 * One decimal place, because `-0.0000001` from a floating-point `mul` is noise in a diagnostic and `0` is the truth.
 */
function describeOrientation(rotation: CFrame): string {
	const [rx, ry, rz] = rotation.ToOrientation();
	const round = (value: number) => math.round(math.deg(value) * 10) / 10;

	return `${round(rx)},${round(ry)},${round(rz)}`;
}
