import { describe, expect, it } from "@rbxts/jest-globals";
import { HIT_EFFECT_SCALE_MULTIPLIER } from "shared/config/hitEffect.config";
import { TAIL_WIND_SCALE_MULTIPLIER } from "shared/config/tailWind.config";
import { WIND_BOOST_SCALE_MULTIPLIER } from "shared/config/windBoost.config";
import { BASE_BALL_RADIUS } from "shared/tuning";
import { WIND_BOOST_HEADING_OFFSET_DEGREES } from "shared/config/windBoost.config";
import { TAIL_WIND_HEADING_OFFSET_DEGREES } from "shared/config/tailWind.config";
import { effectScaleForRadius, vfxForward, vfxFrameFor, vfxHeadingOffset } from "./vfx-scale";

/**
 * The two things every ball effect derives from the arena: which way is "home", and how big the effect should be.
 *
 * ## What this can prove and what it cannot
 *
 * `vfxForward` is a sign against a basis, and `vfxFrameFor` is a `CFrame` composition, so both are assertable from literals
 * with no controller and no DataModel. What it cannot prove is whether a start-ward trail *reads* as pointing home rather
 * than backwards — that depends on how each asset was authored, and it is a Studio judgement.
 */

const TOLERANCE = 1e-6;

describe("vfxForward", () => {
	it("is -RightVector on the identity frame", () => {
		const forward = vfxForward(CFrame.identity);

		// The identity frame's `RightVector` is `+X`, so start-ward is `-X` there. This is a property of the frame and not
		// of the world, which is the point: the belt has changed axes between rounds.
		expect(math.abs(forward.X + 1) < TOLERANCE).toBe(true);
		expect(math.abs(forward.Y) < TOLERANCE).toBe(true);
		expect(math.abs(forward.Z) < TOLERANCE).toBe(true);
	});

	it("follows a rotated belt rather than the world axes", () => {
		// The scene's belt: `rightVector = (0, 0, -1)`, so start-ward is `+Z`. A world-`-X` answer would pass the identity
		// case above and fail here, which is exactly why both are asserted.
		const sceneBelt = CFrame.fromMatrix(Vector3.zero, new Vector3(0, 0, -1), new Vector3(0, 1, 0));
		const forward = vfxForward(sceneBelt);

		expect(math.abs(forward.X) < TOLERANCE).toBe(true);
		expect(math.abs(forward.Y) < TOLERANCE).toBe(true);
		expect(math.abs(forward.Z - 1) < TOLERANCE).toBe(true);
	});

	it("is always exactly opposite the belt's RightVector, for any yaw", () => {
		// The property rather than three samples: whatever the belt's basis, the helper is that basis negated. Asserted as a
		// dot product and not as a world-axis component, because which world axis `RightVector` lands on after a yaw is
		// itself the thing that keeps changing between rounds.
		const spun = CFrame.Angles(0, math.pi / 2, 0);
		const forward = vfxForward(spun);

		expect(math.abs(forward.Dot(spun.RightVector) + 1) < TOLERANCE).toBe(true);
		expect(math.abs(forward.Magnitude - 1) < TOLERANCE).toBe(true);
	});

	it("is a unit vector, so a caller may use it as a direction without normalising", () => {
		expect(math.abs(vfxForward(CFrame.Angles(0.3, 1.1, -0.4)).Magnitude - 1) < TOLERANCE).toBe(true);
	});
});

describe("vfxFrameFor", () => {
	it("puts the effect at the ball, not at the asset's authored position", () => {
		const position = new Vector3(120, 3, -40);
		const frame = vfxFrameFor(position, new Vector3(0, 0, 1), CFrame.Angles(0, 2, 0));

		expect(math.abs(frame.Position.X - 120) < TOLERANCE).toBe(true);
		expect(math.abs(frame.Position.Y - 3) < TOLERANCE).toBe(true);
		expect(math.abs(frame.Position.Z + 40) < TOLERANCE).toBe(true);
	});

	it("faces the part's front (its -Z, `LookVector`) along forward", () => {
		// `CFrame.LookVector` is a part's **-Z** axis, so the assertion is on `LookVector`, not on `ZVector` — a reader who
		// checks the wrong one gets an inverted answer and a trail facing the elimination edge.
		const frame = vfxFrameFor(Vector3.zero, new Vector3(0, 0, 1), CFrame.identity);

		expect(math.abs(frame.LookVector.Z - 1) < TOLERANCE).toBe(true);
	});

	it("keeps the asset's tilt rather than forcing world up", () => {
		// An asset authored lying flat has an `UpVector` of `+Y`; one authored tilted has something else. Passing that
		// through is what stops item 97's deliberate roll being discarded by the yaw change. The tilt here is deliberately
		// not a right angle: `CFrame.Angles(rad(90), 0, 0)` puts `UpVector` parallel to a `+Z` forward, which is the
		// degenerate case the next test covers rather than this one.
		const direction = new Vector3(0, 0, 1);
		const authored = CFrame.Angles(math.rad(20), 0.6, math.rad(10));
		const frame = vfxFrameFor(Vector3.zero, direction, authored);

		// **The tilt survives minus its along-forward component**, which is `lookAlong`'s own orthonormalisation and not a
		// choice here: an up vector is only meaningful perpendicular to the look direction, so the part of it pointing along
		// the new forward is projected away. For the case that matters — an asset authored flat, up `+Y`, forward horizontal
		// — that projection is a no-op, which is the second half of this test.
		const cleaned = authored.UpVector.sub(direction.mul(authored.UpVector.Dot(direction))).Unit;
		expect(math.abs(frame.UpVector.Dot(cleaned) - 1) < 1e-4).toBe(true);
		expect(math.abs(frame.UpVector.Dot(direction)) < 1e-4).toBe(true);

		const flat = vfxFrameFor(Vector3.zero, direction, CFrame.identity);
		expect(math.abs(flat.UpVector.Y - 1) < 1e-6).toBe(true);
	});

	it("falls back to a default up when the asset's tilt is parallel to forward", () => {
		// A degenerate `up` is the one case where the asset's roll cannot survive: there is no rotation that both faces
		// forward and keeps an up pointing along forward. The frame must still be usable rather than a `NaN` basis.
		const authored = CFrame.lookAt(Vector3.zero, new Vector3(0, 0, 1));
		const frame = vfxFrameFor(Vector3.zero, new Vector3(0, 0, 1), authored);

		expect(math.abs(frame.LookVector.Z - 1) < TOLERANCE).toBe(true);
		expect(math.abs(frame.UpVector.Y - 1) < TOLERANCE).toBe(true);
	});

	it("keeps the authored frame when there is no belt yet", () => {
		// The `undefined` window `beltForward` reports. A zero forward means "no direction known", and the honest answer is
		// the previous behaviour rather than an arbitrary heading that snaps when the belt arrives.
		const authored = CFrame.Angles(0, 0.7, 0.2);
		const frame = vfxFrameFor(new Vector3(5, 6, 7), Vector3.zero, authored);

		expect(math.abs(frame.LookVector.Dot(authored.LookVector) - 1) < TOLERANCE).toBe(true);
	});
});

describe("vfxHeadingOffset", () => {
	it("returns the frame itself for a zero offset", () => {
		// `toBe`, not a value comparison: "no offset" has to be the same frame, not a recomposed near-identity. That is what
		// lets every effect ship at `0` without a branch at its call site, and it is the assertion that catches a future
		// "helpful" rewrite to `frame.mul(CFrame.Angles(0, 0, 0))`.
		const frame = vfxFrameFor(Vector3.zero, new Vector3(0, 0, 1), CFrame.identity);
		expect(vfxHeadingOffset(frame, 0)).toBe(frame);
	});

	it("turns a positive offset from -Z toward -X", () => {
		// The sign, as a literal rather than a prose claim. An identity frame's `LookVector` is `-Z`; `+90` about the frame's
		// own up leaves it on `-X`, which is the right-hand rule about `+Y` (`R_y(+90)` maps `+Z` to `+X`, so `-Z` goes to
		// `-X`). A reader tuning the config needs this to know which of `+90` and `-90` is which.
		const turned = vfxHeadingOffset(CFrame.identity, 90);

		expect(math.abs(turned.LookVector.X + 1) < TOLERANCE).toBe(true);
		expect(math.abs(turned.LookVector.Y) < TOLERANCE).toBe(true);
		expect(math.abs(turned.LookVector.Z) < TOLERANCE).toBe(true);
	});

	it("turns the other way for a negative offset", () => {
		const turned = vfxHeadingOffset(CFrame.identity, -90);

		expect(math.abs(turned.LookVector.X - 1) < TOLERANCE).toBe(true);
		expect(math.abs(turned.LookVector.Z) < TOLERANCE).toBe(true);
	});

	it("reverses the frame at 180 degrees", () => {
		const forwards = CFrame.lookAlong(Vector3.zero, new Vector3(0, 0, 1));
		const turned = vfxHeadingOffset(forwards, 180);

		// Facing the belt's start, then facing away from it — the "points home" and "points at the exit" headings.
		expect(math.abs(turned.LookVector.Dot(forwards.LookVector) + 1) < TOLERANCE).toBe(true);
	});

	it("does not move the effect and does not tilt it", () => {
		// A heading is a yaw: the position and the up vector are untouched, which is what keeps the composition with the
		// asset's kept `UpVector` from fighting the offset.
		const frame = new CFrame(new Vector3(10, 2, -3)).mul(CFrame.lookAlong(Vector3.zero, new Vector3(0, 0, 1)));
		const turned = vfxHeadingOffset(frame, 37);

		// `sub(...).Magnitude` rather than `Distance`: the installed `Vector3` typings declare `sub`/`Magnitude` but not a
		// `Distance` member.
		expect(math.abs(turned.Position.sub(frame.Position).Magnitude) < TOLERANCE).toBe(true);
		expect(math.abs(turned.UpVector.Dot(frame.UpVector) - 1) < TOLERANCE).toBe(true);
	});

	it("turns about the frame's own up, not the world's", () => {
		// The reason the rotation is post-multiplied. A frame tilted 30 degrees about X has an up that is no longer world
		// `+Y`; turning it by the same angle about *world* up would keep the up where it was and change the tilt, which on a
		// trail would lean the effect as it turned.
		const tilted = CFrame.Angles(math.rad(30), 0, 0);
		const turned = vfxHeadingOffset(tilted, 45);

		expect(math.abs(turned.UpVector.Dot(tilted.UpVector) - 1) < TOLERANCE).toBe(true);
	});

	it("reads a real number from each effect's own config", () => {
		// **Not pinned to a value.** The offset is a designer's knob and both trails have been retuned since they shipped at
		// `0`; asserting the literal would make every tuning pass fail a test that is not about the tuning. What is asserted
		// is the contract: each trail has its own finite number, and a zero offset is still the strict no-op above.
		// Whole degrees, because the four headings that read as deliberate are `0`, `90`, `180` and `-90`; a fractional value
		// is legal but is a sign somebody meant to change a different axis.
		expect(math.floor(WIND_BOOST_HEADING_OFFSET_DEGREES) === WIND_BOOST_HEADING_OFFSET_DEGREES).toBe(true);
		expect(math.floor(TAIL_WIND_HEADING_OFFSET_DEGREES) === TAIL_WIND_HEADING_OFFSET_DEGREES).toBe(true);
	});
});

describe("effectScaleForRadius", () => {
	it("is that effect's own multiplier at a ball of the design radius", () => {
		// The multiplier is a parameter now, so this asserts the parameter is used rather than the constant it replaced: a
		// different number in, a different number out.
		expect(math.abs(effectScaleForRadius(BASE_BALL_RADIUS, 0.1) - 0.1) < TOLERANCE).toBe(true);
		expect(math.abs(effectScaleForRadius(BASE_BALL_RADIUS, 0.25) - 0.25) < TOLERANCE).toBe(true);
	});

	it("scales linearly with both the radius and the multiplier", () => {
		// A 20-stud ball is a 10-stud radius — twenty design radii — so the drawn size is `20 * multiplier`. At `0.1` that is
		// `2`: twice the authored geometry, on a ball twenty times the size the pack was drawn for.
		expect(math.abs(effectScaleForRadius(20 / 2, 0.1) - 2) < TOLERANCE).toBe(true);
		expect(math.abs(effectScaleForRadius(20 / 2, 0.2) - 4) < TOLERANCE).toBe(true);
	});

	it("keeps the three effects independent", () => {
		// The whole point of item 177, stated as arithmetic: three effects, three numbers, and one effect's number cannot
		// reach another's clone. Changing what a hypothetical fourth effect would pass moves nothing here.
		const radius = 20 / 2;
		const boost = effectScaleForRadius(radius, WIND_BOOST_SCALE_MULTIPLIER);
		const tail = effectScaleForRadius(radius, TAIL_WIND_SCALE_MULTIPLIER);
		const hit = effectScaleForRadius(radius, HIT_EFFECT_SCALE_MULTIPLIER);

		// The two trails still reproduce their pre-split size; the burst does not, deliberately. Item 179 changed what its
		// multiplier multiplies — the particle ramp rather than the whole clone — because that path put the emitter out of
		// view, so `1.0` now means "authored particles, mapped onto the ball" and draws at `20` rather than `2`. The two
		// numbers being equal was never the point; being separate reads is.
		expect(math.abs(boost - 2) < TOLERANCE).toBe(true);
		expect(math.abs(tail - 2) < TOLERANCE).toBe(true);
		expect(math.abs(hit - 20) < TOLERANCE).toBe(true);

		// And they are three separate reads: pushing one through a different value leaves the others where they were.
		expect(effectScaleForRadius(radius, WIND_BOOST_SCALE_MULTIPLIER * 2) !== boost).toBe(true);
		expect(math.abs(effectScaleForRadius(radius, TAIL_WIND_SCALE_MULTIPLIER) - tail) < TOLERANCE).toBe(true);
		expect(math.abs(effectScaleForRadius(radius, HIT_EFFECT_SCALE_MULTIPLIER) - hit) < TOLERANCE).toBe(true);
	});

	it("draws unscaled when no size was reported, rather than at zero", () => {
		// An older server omits the second remote argument, so the client sees `nil` and passes nothing meaningful. Zero
		// would make the burst invisible, which is worse than the authored size the client used to draw. The multiplier is
		// deliberately not consulted on this path: "unknown size" is not "scaled by this effect's number".
		expect(effectScaleForRadius(0, 0.1)).toBe(1);
		expect(effectScaleForRadius(-1, 0.1)).toBe(1);
	});
});
