import { CollectionService, ContentProvider, ReplicatedStorage, TweenService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { PICKUP_SCALE_MULTIPLIER, pickupDiscDiameter } from "shared/config/pickup.config";
import { poolBallRadius } from "shared/shape-pool";
import { TAGS } from "shared/tags";
import {
	PICKUP_SIZE,
	PICKUP_SPIN_MIN_INTERVAL_SECONDS,
	PICKUP_SPIN_SECONDS,
	PICKUP_SPIN_VISIBLE_SECONDS,
	PICKUP_SPRITE_ASSET_ID,
	PICKUP_SPRITE_LIFT_STUDS,
	PICKUP_SPRITE_STUDS,
	PICKUP_MARKER_LIFT_STUDS,
	PICKUP_MARKER_PIXELS,
	PICKUP_MARKER_TRANSPARENCY,
	PICKUP_RING_MAX_DISTANCE,
	RING_COLOR,
	RING_LIFT_STUDS,
	RING_PIXELS_PER_STUD,
	RING_THICKNESS_STUDS,
	RING_TRANSPARENCY,
} from "shared/tuning";
import { effectScaleForRadius } from "shared/vfx-scale";

/**
 * **The Studio instance that may supply the sprite's image instead of the id in `tuning.ts`.** A `Decal`, a `Texture` or an
 * `ImageHandleAdornment` anywhere under `ReplicatedStorage` carrying the image; the first of those found wins, and the boot
 * line says which source was used.
 *
 * Why an override at all: swapping a sprite should not need a rebuild, and a `Decal` is how an image normally lands in a
 * place. Why it is **not** a second render path: both sources produce one `ContentId` handed to one `ImageLabel.Image`.
 */
const SPRITE_ASSET_NAME = "pickupSprite";

/**
 * The pickup's visible half: a camera-facing sprite above every invisible pickup body, which spins once when collected, and
 * a translucent filled disc on the floor showing where the body's collection volume is (items 146/147).
 *
 * ## Why the body is invisible and the visuals are not (item 144)
 *
 * The pickup used to be a red `Wedge` — a part chosen for how it *looked*, which meant the collision volume and the
 * appearance were the same decision. They are different decisions now: the server keeps a plain invisible `Block` whose only
 * job is to be a `Touched` volume, and everything a player sees is built here, on each client. The server gains nothing from
 * owning a picture, and a `BillboardGui` replicated from the server would be one instance per pickup per player for a
 * decoration.
 *
 * ## Why there are two visuals and not one (item 146)
 *
 * The sprite answers *"what is that"* and the disc answers *"where do I have to be"*, and they are not the same question.
 * A sprite floating a stud and a half above the belt says a pickup is here; it says nothing about the fact that collection is
 * a `Touched` contact with an invisible box on the floor, so a player steering by the sprite has no idea how close is close
 * enough. The disc is drawn from that box — **the pad's own `Size`, read at creation, never `PICKUP_SPRITE_STUDS`**, which
 * is the sprite's world scale and has no relationship to the collection volume.
 *
 * The *disc* rather than a ring outline is item 147's reversal of item 146; the reasoning is at the shape, in
 * `buildFootprint`.
 *
 * ## Why a `BillboardGui` and not a `ParticleEmitter` with `FacingCameraWorldUp`
 *
 * `FacingCameraWorldUp` is an `Enum.ParticleOrientation` value — it is only consumable by a `ParticleEmitter`, and this
 * sprite has to *stop*. An emitter's only rotation inputs are a constant `RotSpeed` and a per-particle random `Rotation`;
 * neither can ease a quad to rest at a chosen angle on an `Exponential` curve, which is the whole read of "this was taken".
 * Standing one up would also mean emitting continuously (`Rate > 0`, long `Lifetime`) to keep a texture visible — a stream of
 * overlapping copies of the same image to show one static picture.
 *
 * A `BillboardGui` faces the camera natively, is upright rather than tumbling (its roll follows the camera's up, which for
 * this over-the-shoulder chase camera is world-up to within a few degrees — the behaviour `FacingCameraWorldUp` names), and
 * exposes `ImageLabel.Rotation`, a tweenable number.
 *
 * The ring is deliberately *not* a billboard: it is a footprint on a surface, so it has to stay parallel to that surface. A
 * camera-facing ring would turn into the camera and stop lying on the belt, which is the one thing it is there to do.
 *
 * ## Why both visuals live on the pad rather than in a list of their own
 *
 * `Parent = pickup` means `Destroy()` on the pad takes the sprite and the ring with it — no map to sweep, no path where a
 * collected pad leaves a picture or a ring behind. The server destroys a consumed pad (and `onPhaseChanged` destroys the
 * rest), so the client needs no removal logic beyond forgetting the record. This is also what makes the ring `Playing`-only
 * for free: `PickupService` only spawns pads in `Playing`. **No phase check is added for it**, because there is nothing to
 * check — a ring cannot outlive a pad that does not exist.
 *
 * ## What the client does *not* know, and must not guess
 *
 * It does not know whether the pad will survive. A `recycle` ball leaves its pad standing (item 80) and every other ball
 * destroys it — and the client needs neither fact: a destroyed pad takes its sprite and its ring with it, and a surviving pad
 * simply stops spinning and goes back to static. **The survival is the signal**, which is why nothing here reads a power.
 */
@Controller()
export class PickupSpriteController implements OnStart {
	/** One sprite per live pad. The `BillboardGui` is parented to the pad; this map is how the spin finds its label. */
	private readonly sprites = new Map<BasePart, SpriteRecord>();

	/** The resolved image, or `undefined` when neither source produced one. Resolved once at boot. */
	private imageUri?: string;

	/**
	 * The computed size ratio for this client's pickups — `effectScaleForRadius(ballRadius, PICKUP_SCALE_MULTIPLIER)`
	 * (item 188).
	 *
	 * Computed once at boot from the **shape pool's** ball radius rather than from any live body: a pickup exists before the
	 * first ball spawns and outlives the last, so a scene scan would answer `undefined` on exactly the frames a pad is built.
	 * Every pad on a belt is the same size, so one number for the controller is also the honest model.
	 */
	private pickupScale = 1;

	/**
	 * Whether the first sprite has already reported its size. One line per session, not one per pad: the interesting fact is
	 * "a sprite was built at all, and this is how big it came out", which cannot change between pads — they share the same
	 * constants.
	 */
	private reportedFirstAttach = false;

	/**
	 * Whether the first ring has already reported its `SurfaceGui`'s settled state. One line per session, per the same
	 * argument as `reportedFirstAttach`: every pad shares the constants, so the second ring cannot say anything the first
	 * did not.
	 */
	private reportedFirstRingSurface = false;

	/** Whether the first marker has already reported its own numbers. Same one-line-per-session argument. */
	private reportedFirstMarker = false;

	public onStart(): void {
		this.imageUri = this.resolveImage();
		this.pickupScale = effectScaleForRadius(poolBallRadius(), PICKUP_SCALE_MULTIPLIER);

		if (this.imageUri === undefined) {
			// **One line, no throw, and the pads still work.** A missing sprite is a cosmetic failure: the collider is the
			// server's and does not depend on this file, so a client with no image still collects and still hears the sound.
			warn(
				`[PickupSprite] no sprite image: neither a ${SPRITE_ASSET_NAME} instance under ReplicatedStorage nor a PICKUP_SPRITE_ASSET_ID produced one — pickups will be invisible this session (they still collect).`,
			);
			return;
		}

		// **Does the id resolve to an image at all?** A blank sprite and a dot-sized sprite look the same from outside, and
		// only one of them is fixable in this file (item 145). One line, on its own thread — `PreloadAsync` yields and must
		// not delay the sweep below.
		this.reportImageLoad(this.imageUri);

		// **The sweep and the signal, both** — the pattern every tag-driven controller in this tree uses. A client can start
		// mid-round with pads already on the belt, so the initial `GetTagged` is not an optimisation; it is the only thing that
		// draws the pads that exist before this script runs.
		for (const instance of CollectionService.GetTagged(TAGS.pickup)) {
			this.attach(instance);
		}

		CollectionService.GetInstanceAddedSignal(TAGS.pickup).Connect((instance) => this.attach(instance));
		// Removal by tag, not by destruction: a pad that merely loses its tag should also lose its visuals, and a *destroyed*
		// pad takes its `BillboardGui` and its footprint part with it either way. The record has to be dropped here or
		// `sprites` would grow for the session.
		CollectionService.GetInstanceRemovedSignal(TAGS.pickup).Connect((instance) => this.detach(instance));

		print(
			`[PickupSprite] mounted image=${this.imageUri} studs=${PICKUP_SPRITE_STUDS} scale=${this.pickupScale} drawn=${PICKUP_SPRITE_STUDS * this.pickupScale} spin=${this.spinSeconds()}s (turns) throttle=${PICKUP_SPIN_MIN_INTERVAL_SECONDS}s`,
		);
		// The ring's constants have no per-pad measurement to report - its size is the pad's, which the first-attach line
		// prints - so this line is the look itself: what shape it is, its colour, how much of it lands, how finely it is
		// rasterised and how thick the slab carrying it is. Nothing here can be verified from a log; the point is that a "the
		// ring looks wrong" report can quote a value instead of describing a colour.
		//
		// `math.round` on the channels because `Color3.fromRGB` stores `n / 255` and multiplying back is not exact:
		// `191 / 255 * 255` prints as `190.99999999999997` in the one line whose job is to be comparable to a hex.
		print(
			`[PickupSprite] ring shape=disc colour=${math.round(RING_COLOR.R * 255)},${math.round(RING_COLOR.G * 255)},${math.round(RING_COLOR.B * 255)} transparency=${RING_TRANSPARENCY} pixels=${RING_PIXELS_PER_STUD}/stud thickness=${RING_THICKNESS_STUDS} lift=${RING_LIFT_STUDS}`,
		);
	}

	/**
	 * The effective spin duration: the tween's own length, floored so it cannot be tuned below the point of being noticed.
	 *
	 * `math.max` rather than a second timer, because one duration is what the tween takes. See `PICKUP_SPIN_VISIBLE_SECONDS`.
	 */
	private spinSeconds(): number {
		return math.max(PICKUP_SPIN_SECONDS, PICKUP_SPIN_VISIBLE_SECONDS);
	}

	/**
	 * The image to draw, from the Studio instance if there is one and from the id otherwise.
	 *
	 * `Texture extends Decal`, so the `IsA("Decal")` test covers both; `ImageHandleAdornment` is the third instance type that
	 * carries an image and is cheap to accept. Anything else found by that name is ignored rather than re-interpreted — a
	 * `Part` called `pickupSprite` is a mistake, and reading a property off it would invent a meaning.
	 */
	private resolveImage(): string | undefined {
		const found = ReplicatedStorage.FindFirstChild(SPRITE_ASSET_NAME, true);
		if (found !== undefined) {
			if (found.IsA("Decal")) {
				// Covers `Texture` too: `Texture extends Decal`, and `Texture` is the type that reads correctly on all faces.
				return found.Texture;
			}

			if (found.IsA("ImageHandleAdornment")) {
				return found.Image;
			}

			warn(
				`[PickupSprite] found ${found.GetFullName()} (${found.ClassName}) but it carries no image — falling back to the asset id in tuning.ts.`,
			);
		}

		// **The id, prefixed here and nowhere else.** `ImageLabel.Image` is a `ContentId`, which the engine resolves from the
		// `rbxassetid://` scheme — a bare number loads nothing and reports no error. `shared/sounds.config.ts` makes the same
		// argument about `soundUri`, and keeps the same promise: the prefix is written once, in the place the id is consumed.
		if (PICKUP_SPRITE_ASSET_ID.size() === 0) {
			return undefined;
		}

		return `rbxassetid://${PICKUP_SPRITE_ASSET_ID}`;
	}

	/**
	 * One line saying whether the engine could actually fetch the image.
	 *
	 * The failure this guards against is invisible: an `ImageLabel` whose `Image` the engine cannot resolve draws **nothing**,
	 * and "nothing" is indistinguishable from "a billboard too small to see" (item 145). `ContentProvider.PreloadAsync` is the
	 * only place the fetch status is observable, so it is asked once at boot and reported in one line. Nothing here changes
	 * behaviour: the pads collect and the sound fires whether or not a picture arrives.
	 *
	 * The likeliest cause of a `Failure` is an id that is not an image - a `Decal`'s asset id rather than its texture's, or a
	 * model/mesh id pasted into `PICKUP_SPRITE_ASSET_ID` - so the warning names the id and says which constant to check.
	 */
	private reportImageLoad(imageUri: string): void {
		task.spawn(() => {
			const [ok, failure] = pcall(() => {
				ContentProvider.PreloadAsync([imageUri], (contentId, status) => {
					if (status === Enum.AssetFetchStatus.Success) {
						print(`[PickupSprite] image loaded ${contentId}`);
					} else {
						warn(
							`[PickupSprite] image did not load: ${contentId} status=${tostring(status)} — the sprite will draw blank, not small; check that PICKUP_SPRITE_ASSET_ID is an image asset this experience can use.`,
						);
					}
				});
			});

			if (!ok) {
				warn(`[PickupSprite] image preload threw: ${tostring(failure)}`);
			}
		});
	}

	/**
	 * Draws the pad's collection footprint on the floor, and reports the numbers it used.
	 *
	 * ## Why the size comes from the pad and never from `PICKUP_SPRITE_STUDS`
	 *
	 * The ring exists to answer "how close do I have to be", so its diameter has to be a fact about the **collider**.
	 * `PICKUP_SPRITE_STUDS` is the sprite's world scale (item 145) — a look, tuned by eye, and the two numbers would drift
	 * apart the first time anyone retuned the picture. So this reads `pickup.Size`, which is the `Touched` volume the server
	 * built, and prints it in the boot line so a "the ring is the wrong size" report has the pad's real size next to it.
	 *
	 * `PickupService.createPickup` gives the pad a Y-only rotation (`new CFrame(position, position.add(belt.RightVector))`),
	 * so `Size.X` and `Size.Z` are the two horizontal axes and `Size.Y` is the height. The disc is **inscribed** in that square
	 * cross-section rather than circumscribed: every point inside the ring is inside the collider. The four corners of the
	 * square are inside the collider and outside the ring, so the ring understates the volume — the forgiving direction, since
	 * a player who aims at the ring collects.
	 *
	 * **"Inscribed" was only half true until item 190.** The diameter was `min(X, Z) * PICKUP_SCALE_MULTIPLIER`, so at a
	 * 20-stud pad and a scale of `4` the ring was drawn **80** studs across around a **20**-stud collider — circumscribed
	 * four times over, and a ball inside the paint collected nothing. The disc now takes **no** multiplier: it is
	 * `pickupDiscDiameter(padSize)`, which is the collider's own inscribed circle, and a spec asserts that equality. The
	 * paragraph above is therefore true now rather than aspirational, and it is the sentence the bug contradicted.
	 *
	 * ## Cylinder geometry, and which face the ring is drawn on
	 *
	 * `Enum.PartType.Cylinder` is *"a cylinder shape oriented along the **X** axis"* (the typings, and the same finding
	 * `BallSpawnerService.attachBallMarkers` records for the equator ring): `Size.X` is the axis length and `Size.Y`/`Size.Z`
	 * are one diameter each. So the part is `(thickness, diameter, diameter)` and `CFrame.Angles(0, 0, math.pi / 2)` stands
	 * that axis up, putting the flat circular faces on world ±Y.
	 *
	 * That rotation is also the reason the `SurfaceGui` uses `Face = Right`. `Face` is the part's **local** normal, and the
	 * 90° turn about Z maps local +X onto world +Y — so the face pointing at the sky is the part's `Right`, not its `Top`.
	 * The intuitive `Top` would draw the ring on the disc's vertical rim, i.e. edge-on to a camera looking down at the belt,
	 * which is invisible for the same reason a sheet of paper seen edge-on is.
	 *
	 * ## Why the ring is a part on the floor rather than a billboard
	 *
	 * A billboard turns to face the camera. This shape's entire job is to stay parallel to the surface it describes, so it has
	 * to be geometry. The `SurfaceGui` is what lets it be *thin* geometry: a part carrying a face gui needs no texture asset
	 * and no leaf part, and a `SurfaceGui` draws on a fully transparent part exactly as item 99 found a `Decal` does.
	 *
	 * ## Why it floats `RING_LIFT_STUDS` above the pad's bottom face
	 *
	 * The pad's bottom face is *exactly* on the surface a ball rests on (`positionFor`'s lift), so a ring at that height is
	 * coplanar with the floor and z-fights it. The lift is a depth-buffer fix, not a look. `BallSpawnerService`'s equator ring
	 * and the pad itself established the same rule: two surfaces at one height are one surface decided per frame, per pixel.
	 */
	private buildFootprint(pickup: BasePart): FootprintInfo {
		const padSize = pickup.Size;

		// **The disc is the collider's inscribed circle, and it does not take the scale multiplier (item 190).** It used to be
		// `min(padSize.X, padSize.Z) * scale`, which at a 20-stud pad and a scale of `4` painted an **80**-stud ring around a
		// **20**-stud collider: a ball visibly inside the paint did not collect, because the paint was decoration with no
		// collision and the real reach was a quarter of what it showed.
		//
		// The distinction this line now encodes: the disc is a **promise about reach**, so it follows the collider and nothing
		// else; the sprite is a **picture** and keeps its own tuner. A disc that could be tuned independently of the box it
		// describes is a disc that can lie.
		const diameter = pickupDiscDiameter(padSize);

		const ring = new Instance("Part");
		ring.Name = "PickupFootprint";
		ring.Shape = Enum.PartType.Cylinder;
		ring.Size = new Vector3(RING_THICKNESS_STUDS, diameter, diameter);
		// **World-flat, not pad-relative.** An anchored part's `CFrame` is world-space whether it is parented to the workspace
		// or to another part, so building it here as `pad bottom + lift + half its own thickness` keeps the disc lying on the
		// belt. Composed onto the pad's own frame it would inherit the pad's Y rotation — harmless today, and a slow bank of
		// the belt away from a mystery later.
		const bottom = pickup.Position.sub(new Vector3(0, padSize.Y / 2, 0));
		ring.CFrame = new CFrame(bottom.add(new Vector3(0, RING_LIFT_STUDS + RING_THICKNESS_STUDS / 2, 0))).mul(
			CFrame.Angles(0, 0, math.pi / 2),
		);
		// **Invisible as a part, drawn as a decal.** `Transparency = 1` hides the part's own surface, not the gui on it, and
		// the gui is the entire visual.
		ring.Transparency = 1;
		ring.Anchored = true;
		// It is decoration over the pads the ball must touch. Colliding would make it a kerb; touching would give the server's
		// `Touched` reader a second partner per collection; queryable would put a disc in every raycast down the belt.
		ring.CanCollide = false;
		ring.CanTouch = false;
		ring.CanQuery = false;
		// No `Massless`: anchored parts have no mass to be without. The value would have no reader, which is the same reason
		// item 144 removed the pad's `Color`.
		ring.Parent = pickup;

		const surface = new Instance("SurfaceGui");
		surface.Name = "Footprint";
		surface.Face = Enum.NormalId.Right;
		surface.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud;
		surface.PixelsPerStud = RING_PIXELS_PER_STUD;
		// Unlit, like the sprite: the arena is dark, and a ring shaded by the belt's lighting would fade out exactly where it
		// is furthest from the lamps. See `RING_COLOR` for why the colour itself is not up for tuning.
		surface.LightInfluence = 0;
		// **Not `AlwaysOnTop`.** It is paint on the floor, not an overlay: drawn through a ball it would read as a disc the
		// ball is standing in front of rather than on. The lift above is what keeps it clear of the floor it lies on.
		surface.AlwaysOnTop = false;
		// **No distance limit (item 202).** `SurfaceGui.MaxDistance` stops drawing at a fixed camera distance, and the engine
		// default is `1000` studs — a hard cut, not a fade, which is the reported symptom on a `333`-stud belt. The constant's
		// docblock quotes the documentation, including why a large finite number is used instead of the documented `0`.
		//
		// This is the *whole* fix for the round: no other property on a `SurfaceGui` is distance-dependent. `PixelsPerStud` and
		// `SizingMode` decide resolution, `ZOffset` decides depth, `ClipsDescendants` decides cropping, and `AlwaysOnTop` decides
		// occlusion — none of them can switch the gui off at a distance.
		//
		// `AlwaysOnTop` stays `false` deliberately. It cannot produce a distance cut, and the disc is `2.22` studs above the
		// belt with nothing between it and a camera looking down at the pad, so there is no occlusion for it to solve. Turning it
		// on would buy nothing here and would cost the "painted on the floor" read by drawing the disc over every ball that
		// touches a pad.
		surface.MaxDistance = PICKUP_RING_MAX_DISTANCE;
		surface.Parent = ring;

		const frame = new Instance("Frame");
		frame.Name = "Ring";
		// **A filled disc, not an annulus (item 147 — this reverses item 146's shape).** Item 146 drew a boundary: a fully
		// transparent frame whose only ink was a `UIStroke` tracing the circle, on the argument that the ball that is about to
		// collect the pad stands in the middle of the footprint, so a filled disc's most legible half is the half the ball
		// covers. **That argument is still true** — a ball at the centre does hide the middle of a disc. It lost anyway, because
		// the two shapes say different things: a boundary says "cross this line", and what a pickup actually has is an *area*
		// you have to get the ball's centre into. A fill reads as that area from further away than a 6-pixel line does, and the
		// cost — the ball covering the middle — is paid only by the pad that is about to be collected anyway.
		//
		// The inscribed-circle geometry is unchanged from item 146: the four corners of the pad's square collider collect and
		// sit outside this circle, so the disc understates the volume by the corners. That was true of the annulus too — it is
		// a property of drawing a circle on a square, not of the fill.
		//
		// **One transparency, and it is this one.** The annulus had two (`BackgroundTransparency = 1` on the frame, and the
		// stroke's own `Transparency`), which meant "what is `RING_TRANSPARENCY` doing" had two answers. There is no stroke any
		// more: the fill is the whole visual, so its transparency is the only one.
		//
		// `Size` at scale `1, 1` fills the canvas, so neither an anchor point nor a position is written: a frame that covers its
		// parent exactly has nothing left to place.
		frame.Size = UDim2.fromScale(1, 1);
		frame.BackgroundColor3 = RING_COLOR;
		frame.BackgroundTransparency = RING_TRANSPARENCY;
		frame.BorderSizePixel = 0;
		frame.Parent = surface;

		const corner = new Instance("UICorner");
		// A `UDim(1, 0)` is 100% of the frame's shorter side - a circle rather than a rounded square - and it now shapes the
		// **fill**. In item 146 this comment explained that `UIStroke` traces the cornered shape; with the stroke gone the
		// corner is what makes the drawn rectangle a disc at all. (`new UDim(1, 0)` rather than the engine's `UDim.new`:
		// roblox-ts types `UDim` as a constructor, so `UDim.new` does not compile.)
		corner.CornerRadius = new UDim(1, 0);
		corner.Parent = frame;

		// **One line per session, saying what the engine ended up with rather than what was asked for (item 202).** The round
		// before this one measured the ring at `19.2 px` on screen and could not say whether that was the ring being tiny or
		// the ring not being drawn — the log had no field that could tell those apart. `maxDistance` is the one that answers it:
		// a finite value below the camera distance means the disc is *culled*, and a huge one means anything invisible is
		// *small or faint* instead, which is a different fix.
		//
		// Every field is read back off the instance, not printed from the constant that produced it: a property the engine
		// refuses, clamps, or does not have yet reads as itself here rather than as the intent.
		//
		// On its own thread and two waits in, for the same reason `first visuals` waits: `CanvasSize` is the rasteriser's
		// answer, and it has no answer until the gui has been drawn once.
		if (!this.reportedFirstRingSurface) {
			this.reportedFirstRingSurface = true;
			task.spawn(() => {
				task.wait();
				task.wait();

				print(
					`[PickupSprite] ring surface maxDistance=${formatStuds(surface.MaxDistance)} alwaysOnTop=${tostring(surface.AlwaysOnTop)} brightness=${formatStuds(surface.Brightness)} pixelsPerStud=${formatStuds(surface.PixelsPerStud)} canvas=${surface.CanvasSize.X}x${surface.CanvasSize.Y} parent=${surface.GetFullName()}`,
				);
			});
		}

		// **No `UIStroke`, and this is a decision rather than an omission (item 147).** A stroke in the same colour at the same
		// transparency as the fill is not an edge: it is the fill drawn twice along its rim, which reads as a rendering seam at
		// some camera distances and disappears at others. An edge earns its place when it says something the fill cannot, and
		// here the fill already says where the boundary is. `RING_STROKE_THICKNESS` is deleted with it rather than left at `0`,
		// because a constant with no reader is the thing item 144 removed the pad's `Color` for.

		return { padSize: `${padSize.X}x${padSize.Y}x${padSize.Z}`, diameter };
	}

	/**
	 * Builds both of a pad's visuals, once.
	 *
	 * **The footprint ring is built even when there is no image (item 146).** The sprite depends on `this.imageUri`, which
	 * depends on an asset this file cannot verify; the ring depends on the pad's own `Size` and nothing else. Coupling them
	 * would mean that a missing or unloadable image takes away the one visual that says where to touch *and* the one that was
	 * built to be legible without a texture — so the ring is drawn first and unconditionally, and the sprite is the part that
	 * can be absent. `record.label` being `undefined` is that state, and `spin` returns early on it.
	 */
	private attach(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		if (this.sprites.has(instance)) {
			return;
		}

		const pickup = instance;

		// **The sprite says "here"; the ring says "this close" (item 146).** The ring first, so a pad is never on the belt
		// showing nothing at all.
		const footprint = this.buildFootprint(pickup);
		const label = this.buildSprite(pickup);
		// **The third visual, and the only one that survives distance (item 219).** The sprite is studs-sized and the ring is
		// paint on the floor; both are `19`-ish pixels from the game camera, which is the number item 200 measured.
		this.buildMarker(pickup);
		this.sprites.set(pickup, { label, lastSpinAt: undefined });

		// **A line per session saying the visuals were actually built, and how big they came out.** Item 145's report was
		// "only blue-ish dots": the sprite existed, was parented, and had an image, and the only thing wrong was a number the
		// boot line printed without saying what it measured. This prints the pairs that decide it — the sprite's authored size
		// and the `AbsoluteSize` the engine derived from it a frame later, and the pad's real `Size` beside the ring's diameter
		// — so a reader can tell "not built" from "built at the wrong size" without a second playtest.
		if (!this.reportedFirstAttach) {
			this.reportedFirstAttach = true;
			task.spawn(() => {
				// Two steps, not one: `AbsoluteSize` is the *rendered* size, so the canvas has to have been drawn once for the
				// number to mean anything. On its own thread, so a pad appearing never waits on this report.
				task.wait();
				task.wait();

				if (pickup.Parent === undefined) {
					// Collected before the first frame it could be measured on - nothing to report and nothing to fix.
					return;
				}

				const drawn = label === undefined ? "none" : `${label.AbsoluteSize.X}x${label.AbsoluteSize.Y}px`;
				// **`ringDiameter` and `ringRadius`, not `ring` (item 200).** The field used to read `ring=20 studs`, and that
				// single number was read as a *radius* by the next review — which made every placed pad look 10 studs over the
				// belt's edge when the arithmetic was in fact correct. A diameter and a radius differ by a factor of two, and a
				// field that does not say which it is invites exactly that mistake. Both are printed; `ringRadius` is the number
				// a bound must subtract.
				//
				// **`spriteWidth` in studs, with the rendered pixels as a separate field.** `sprite=2.6 studs` is the *authored*
				// constant and `drawn=19.2px` is what the engine rendered on screen at the current camera distance — two numbers
				// measuring different things under one word. The world size is `PICKUP_SPRITE_STUDS x scale`, which is what a
				// placement bound cares about; the pixel size is a rendering observation and stays, but labelled.
				const spriteStuds = PICKUP_SPRITE_STUDS * this.pickupScale;
				print(
					`[PickupSprite] first visuals on ${pickup.GetFullName()} spriteAuthored=${PICKUP_SPRITE_STUDS} studs spriteWidth=${formatStuds(spriteStuds)} studs spriteRadius=${formatStuds(spriteStuds / 2)} studs drawn=${drawn} lift=${PICKUP_SIZE.Y / 2 + PICKUP_SPRITE_LIFT_STUDS} studs pad=${footprint.padSize} ringDiameter=${formatStuds(footprint.diameter)} studs ringRadius=${formatStuds(footprint.diameter / 2)} studs`,
				);
			});
		}
	}

	/**
	 * Builds the pad's screen-size marker: a camera-facing circle at a fixed number of pixels, at every distance (item 219).
	 *
	 * ## Why this is the engine's own answer and not a per-frame recompute
	 *
	 * The ring cannot hold a screen size - a `SurfaceGui`'s resolution is `PixelsPerStud` over geometry, so its size is
	 * whatever the disc's studs subtend - and the sprite uses `Size`'s **scale**, which is studs and shrinks with distance. A
	 * `BillboardGui`'s **offset** components are screen pixels, so `Size = fromOffset(28, 28)` is a `28`-pixel circle at `10`
	 * studs and at `390` studs alike, with no code running per frame. The alternative - recomputing `Size` from the camera
	 * distance on `RenderStepped` - would be a per-frame write per pad to compute something the engine already defines.
	 *
	 * ## Why `DistanceStep`, `SizeOffset` and the two limits are NOT used
	 *
	 * They read as the answer and they are not, per the installed typings (`@rbxts/types`' `BillboardGui`):
	 *
	 * - `DistanceStep` - *"the size `CurrentDistance` increments and decrements in studs"* - quantises the distance reading; it
	 *   scales nothing by itself, and it is `[NotReplicated]` (settable on the client, as this file is).
	 * - `SizeOffset` - *"a 2D offset in size-relative units that acts like an anchor point"* - is a one-shot offset of the gui
	 *   within its own canvas, not a per-step growth term.
	 * - `DistanceLowerLimit` and `DistanceUpperLimit` are **both deprecated** in the current typings.
	 *
	 * So the whole mechanism above is one property: `Size` in offset. A round that reads "put the marker on `DistanceStep`" would
	 * build a gui whose size never changes and whose position wobbles.
	 *
	 * ## What it does not solve, stated rather than hidden
	 *
	 * A `BillboardGui` faces the camera and describes a **point**, not a footprint: the ring is still the thing that says "this
	 * close collects". Both are kept because they answer different questions at different ranges - the marker is what a player
	 * watching their ball from `300` studs actually sees, and the ring is what they see as they arrive. `AlwaysOnTop` stays
	 * `false` for the ring's reason: a marker drawn through every ball would read as an overlay rather than as something on the
	 * belt.
	 */
	private buildMarker(pickup: BasePart): void {
		const marker = new Instance("BillboardGui");
		marker.Name = "PickupMarker";
		// **Offset, not scale.** See the docblock: this single line is the whole distance mechanism.
		marker.Size = UDim2.fromOffset(PICKUP_MARKER_PIXELS, PICKUP_MARKER_PIXELS);
		// The ring's constant, because it is the same question ("do not cull a pickup") already answered for this map. The
		// `BillboardGui`'s own default is infinity, but a documented default is not a decision - this is.
		marker.MaxDistance = PICKUP_RING_MAX_DISTANCE;
		marker.LightInfluence = 0;
		marker.AlwaysOnTop = false;
		marker.StudsOffsetWorldSpace = new Vector3(0, PICKUP_SIZE.Y / 2 + PICKUP_MARKER_LIFT_STUDS, 0);
		marker.Parent = pickup;

		const disc = new Instance("Frame");
		disc.Name = "Disc";
		// **Scale, here, and that is not a contradiction.** This frame fills a canvas whose size is already the pixel size, so
		// `1, 1` is "all of the marker" however `PICKUP_MARKER_PIXELS` is retuned - the same shape the ring's frame uses.
		disc.Size = UDim2.fromScale(1, 1);
		disc.BackgroundColor3 = RING_COLOR;
		disc.BackgroundTransparency = PICKUP_MARKER_TRANSPARENCY;
		disc.BorderSizePixel = 0;
		disc.Parent = marker;

		const corner = new Instance("UICorner");
		corner.CornerRadius = new UDim(1, 0);
		corner.Parent = disc;

		// A circle rather than an ellipse if the pixel size is ever made non-square: the marker is a locator, and a squashed one
		// reads as a mistake. At a square size this is inert.
		const aspect = new Instance("UIAspectRatioConstraint");
		aspect.AspectRatio = 1;
		aspect.Parent = disc;

		if (!this.reportedFirstMarker) {
			this.reportedFirstMarker = true;
			// **One line per session**, per item 145's precedent: every pad shares these constants, so the second marker cannot
			// say anything the first did not. `pixels` is the rendered size by construction, which is why this line needs no
			// `AbsoluteSize` wait - unlike the sprite's, whose size the engine derives from studs and a scale.
			print(
				`[PickupSprite] marker pad=${pickup.GetFullName()} pixels=${PICKUP_MARKER_PIXELS} maxDistance=${formatStuds(marker.MaxDistance)} lift=${PICKUP_SIZE.Y / 2 + PICKUP_MARKER_LIFT_STUDS} transparency=${PICKUP_MARKER_TRANSPARENCY} asset=none`,
			);
		}
	}

	/**
	 * Builds the pad's sprite and wires its spin, or returns `undefined` on a session with no image.
	 *
	 * The `Touched` connection is made here rather than in `attach` because it exists to drive `ImageLabel.Rotation`, and a
	 * session with no image has no rotation to drive: connecting anyway would leave a per-pad handler that can only no-op.
	 *
	 * **One connection per pad, and it is never disconnected by hand.** The pad's own `Destroy()` takes the connection with
	 * it (a connection to a destroyed instance stops firing), and the record is dropped by the tag-removed signal — so the
	 * only lifetime this file manages is the map, exactly like `windBoost`'s trail map.
	 */
	private buildSprite(pickup: BasePart): ImageLabel | undefined {
		const imageUri = this.imageUri;
		if (imageUri === undefined) {
			return undefined;
		}

		const scale = this.pickupScale;
		const spriteStuds = PICKUP_SPRITE_STUDS * scale;

		const billboard = new Instance("BillboardGui");
		billboard.Name = "PickupSprite";
		// **`fromScale`, because that is the component that means studs (item 145).** A `BillboardGui`'s `Size` is not a
		// `GuiObject`'s `Size`: its *scale* components are studs in 3D space and shrink with camera distance, while its
		// *offset* components are screen pixels pinned to a fixed on-screen size. This line first read
		// `UDim2.fromOffset(PICKUP_SPRITE_STUDS, ...)`, which built a 2.6-**pixel** billboard — the pale dot a playtest
		// reported instead of a sprite. The constant is unchanged; the component it is fed through is the fix.
		billboard.Size = UDim2.fromScale(spriteStuds, spriteStuds);
		// Above the pad, so a ball sitting on it does not hide the marker. The pad is `PICKUP_SIZE.Y` tall and centred on its
		// own position, so the top face is half that above the origin.
		billboard.StudsOffsetWorldSpace = new Vector3(0, PICKUP_SIZE.Y / 2 + PICKUP_SPRITE_LIFT_STUDS, 0);
		// Unlit: the arena is dark and a shaded sprite would read as a smear rather than as a sign.
		billboard.LightInfluence = 0;
		// **Not `AlwaysOnTop`.** It is a marker on the belt, not an overlay; drawing it through balls and walls would make the
		// belt look cluttered from the far end. The lift above is what keeps it clear of the ball that collects it.
		billboard.AlwaysOnTop = false;
		billboard.Parent = pickup;

		const label = new Instance("ImageLabel");
		label.Name = "Sprite";
		label.Size = UDim2.fromScale(1, 1);
		label.BackgroundTransparency = 1;
		label.BorderSizePixel = 0;
		label.Image = imageUri;
		label.ScaleType = Enum.ScaleType.Fit;
		label.ImageTransparency = 0;
		label.Rotation = 0;
		label.Parent = billboard;

		pickup.Touched.Connect((other) => this.spin(pickup, other));

		return label;
	}

	/** Drops the bookkeeping for a pad that lost its tag or left the world. The sprite and the ring go with the pad. */
	private detach(instance: Instance): void {
		if (!instance.IsA("BasePart")) {
			return;
		}

		this.sprites.delete(instance);
	}

	/**
	 * Spins the pad's sprite, if the touch was a ball and the pad has not spun recently.
	 *
	 * ## The `Touched` caveat, stated rather than hidden
	 *
	 * Balls are pinned **server-owned** (`BallSpawnerService.spawnBall`) and pickups are anchored, so this contact is
	 * simulated on the server. A client's `Touched` for a contact it did not simulate is not guaranteed to fire, and when it
	 * does it may arrive a frame or two after the server's decision — which means the spin can trail the actual collection.
	 * That is a latency this file accepts and does not correct: the alternative is a server signal per collection (a new
	 * remote, which the brief rules out) or a per-frame overlap scan on the client (a constant cost to rediscover something
	 * the physics engine already computed). **If playtesting shows no spin at all**, the honest fix is a server-fired cue,
	 * not a longer tween.
	 *
	 * ## Why the angle accumulates instead of resetting
	 *
	 * `Rotation` is left wherever the tween stopped, and the next spin targets `from + 360`. Resetting to `0` on completion
	 * would make the sprite snap backwards on the frame the tween ended — invisible for a 360-degree turn, but not for a
	 * future partial-turn tween — and a fixed `0 -> 360` target would make a second spin a no-op tween.
	 */
	private spin(pickup: BasePart, other: BasePart): void {
		const record = this.sprites.get(pickup);
		if (record === undefined) {
			return;
		}

		const label = record.label;
		if (label === undefined) {
			// A session with no image: the ring is on the belt and there is no rotation to drive. Not an error - see
			// `buildSprite` for why the ring is built regardless.
			return;
		}

		// The same tag test the server makes before boosting, for the same reason: a marker, the slab or a wall brushing the
		// pad must not set it spinning. It is a *local* read of a replicated tag, so it costs nothing.
		if (!CollectionService.HasTag(other, TAGS.ball)) {
			return;
		}

		const now = os.clock();
		if (record.lastSpinAt !== undefined && now - record.lastSpinAt < PICKUP_SPIN_MIN_INTERVAL_SECONDS) {
			return;
		}

		record.lastSpinAt = now;

		TweenService.Create(
			label,
			new TweenInfo(this.spinSeconds(), Enum.EasingStyle.Exponential, Enum.EasingDirection.Out),
			{ Rotation: label.Rotation + 360 },
		).Play();
	}
}

/** One pad's sprite and its throttle stamp. */
interface SpriteRecord {
	/**
	 * The sprite's tween target, or `undefined` on a session where no image resolved.
	 *
	 * `undefined` rather than a second map of pads: a pad with a ring and no sprite is still a pad this controller has built
	 * its visuals for, and the only thing the record is used for is the spin. See `buildSprite`.
	 */
	readonly label: ImageLabel | undefined;
	/**
	 * `os.clock()` of the last spin, or `undefined` for a pad that has never been collected.
	 *
	 * On the record rather than in a second map keyed by the pad: two maps would be two things to delete on the same event,
	 * and the one that got missed would be a pad that spins once and then never again.
	 */
	lastSpinAt: number | undefined;
}

/**
 * What the footprint ring was drawn from, for the one line that reports it.
 *
 * Returned rather than recomputed at the log site: the diameter is `min(size.X, size.Z)` of *this* pad, and a report that
 * re-derived it from `PICKUP_SIZE` would be a second source of truth for the one number a "the ring is the wrong size" report
 * is about.
 */
interface FootprintInfo {
	/** The pad's `Size` as built by the server, formatted for the log: `x x y x z` in studs. */
	readonly padSize: string;
	/** The ring's diameter in studs — the inscribed circle of the pad's square cross-section. */
	readonly diameter: number;
}

/**
 * A stud length to two places, for the size fields on the `first visuals` line (item 200).
 *
 * Exists because that line now prints a **diameter and a radius** side by side, and `tostring` on a float would print
 * `19.999999` beside `9.999999` for what is a `20`-stud circle. Two places is the precision a stud is authored to.
 */
function formatStuds(value: number): string {
	return tostring(math.round(value * 100) / 100);
}
