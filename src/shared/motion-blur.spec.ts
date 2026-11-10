import { describe, expect, it } from "@rbxts/jest-globals";
import {
	generationOwnsFadeOut,
	MOTION_BLUR_FADE_SECONDS,
	MOTION_BLUR_PHASE,
	MOTION_BLUR_SCALE,
	motionBlurActionFor,
	motionBlurAnchor,
	motionBlurCloneFrame,
	motionBlurDepthStuds,
} from "shared/motion-blur";

/**
 * The `motionBlur` overlay's two rules: **show during `Playing` and nothing else, and only the fade-out that still owns the
 * clone may destroy it.**
 *
 * ## What this can and cannot prove
 *
 * The controller reaches `CollectionService`, `Workspace` and `TweenService`, so it cannot be constructed here — a spec that
 * tried would be a spec about the engine. What it *can* prove is the part that is a state machine over a string and a
 * boolean, and the part that a stale timer would get wrong: three phases of a round, and the generation that survives them.
 * The `Rate` values themselves come from the Studio asset and are read at clone time, so there is no literal here to assert
 * on — criterion 2's "0 to authored" is a property of `TweenService` plus a capture, and the capture is `emitter.Rate` read
 * once (see the controller).
 *
 * Every failure below is one nobody sees in a single round: `Playing → PostGame → Playing` is the sequence where the old
 * fade-out's callback destroys the new clone, and it needs three phases to happen at all.
 */

describe("motionBlurActionFor", () => {
	it("shows on Playing entry, whether or not something is already showing", () => {
		// Criterion 4: `Playing → Playing` is a **restart**, not a continue. The controller destroys the old clone and builds a
		// new one whose `Rate` begins at 0 — so the machine must say "show" in both cases and never "hide then show".
		expect(motionBlurActionFor(MOTION_BLUR_PHASE, false)).toBe("show");
		expect(motionBlurActionFor(MOTION_BLUR_PHASE, true)).toBe("show");
	});

	it("hides on every phase that is not Playing, while something is showing", () => {
		// The invariant, minus the escape hatch: the effect is visible during `Playing` and nowhere else. `Waiting` is in the
		// list because debug key 2 goes `Playing → Waiting` directly (acceptance criterion 3) — a phase the surrounding prose
		// tends to forget, which is exactly why the rule is not written as three named phases.
		expect(motionBlurActionFor("PostGame", true)).toBe("hide");
		expect(motionBlurActionFor("Intermission", true)).toBe("hide");
		expect(motionBlurActionFor("Waiting", true)).toBe("hide");
	});

	it("does nothing when there is nothing to hide", () => {
		// `Intermission → Waiting → Playing` must not produce two fade-out lines with no effect behind them, and a client that
		// joined during `PostGame` must not start one. A fade-out is only ever begun by *leaving* Playing.
		expect(motionBlurActionFor("PostGame", false)).toBe("nothing");
		expect(motionBlurActionFor("Intermission", false)).toBe("nothing");
		expect(motionBlurActionFor("Waiting", false)).toBe("nothing");
	});

	it("treats an unrecognised phase as 'not Playing'", () => {
		// A fifth phase, or a value that arrived as the wrong type one hop away, must hide rather than leave an arena-wide blur
		// running for ever. Failing towards "off" is the only safe direction for an effect that covers the screen.
		expect(motionBlurActionFor("", true)).toBe("hide");
		expect(motionBlurActionFor("Scores", true)).toBe("hide");
		expect(motionBlurActionFor("playing", true)).toBe("hide");
	});
});

describe("generationOwnsFadeOut", () => {
	it("lets the fade-out that scheduled it destroy its own clone", () => {
		expect(generationOwnsFadeOut(3, 3)).toBe(true);
		expect(generationOwnsFadeOut(0, 0)).toBe(true);
	});

	it("refuses when a later Playing entry has bumped the generation", () => {
		// **The criterion-7 case, executable.** A fade-out scheduled at `Playing → PostGame` in generation 3 resolves after the
		// phase has come all the way back round to `Playing`, which is generation 4 — and the clone it would destroy is the new
		// round's, a fraction of a second after that clone faded in. The effect would appear to switch itself off at random,
		// roughly one round in N, and never in the round being watched.
		expect(generationOwnsFadeOut(4, 3)).toBe(false);
		expect(generationOwnsFadeOut(3, 4)).toBe(false);
	});

	it("is an equality, not an ordering", () => {
		// `/dev`-style jumps can move the counter in ways a monotone comparison would mis-read, and a *stale* generation that is
		// somehow ahead of the current one is still stale. Equality says exactly what the rule means; `>` would be a guess about
		// how the numbers move.
		expect(generationOwnsFadeOut(9, 3)).toBe(false);
		expect(generationOwnsFadeOut(-1, 0)).toBe(false);
	});
});

describe("the effect's tuning", () => {
	it("ramps in half a second", () => {
		// Criterion 2's number, pinned so a "tidy" that changed it fails here rather than in somebody's ears. The ramp is one
		// `TweenInfo`; what it ramps *to* is the asset's own authored rate, captured per clone.
		expect(MOTION_BLUR_FADE_SECONDS).toBe(0.5);
	});

	it("defaults to the asset's authored size", () => {
		// Criterion: `MOTION_BLUR_SCALE` is **not** `VFX_SCALE_MULTIPLIER` (`0.1`) and **not** a ball ratio. `1` means the clone
		// is drawn exactly as the designer built it, which is the only defensible default for an asset authored around a
		// hand-placed zone rather than against a 0.5-stud ball.
		expect(MOTION_BLUR_SCALE).toBe(1);
	});
});

describe("motionBlurAnchor", () => {
	/** An axis-aligned zone, 40 studs long, centred at `(100, 2, -5)`. */
	const zoneFrame = new CFrame(100, 2, -5);

	it("puts the effect inside the zone, near its front, not on the boundary", () => {
		// **The bug this fixes (item 143).** Item 141 placed the clone exactly on the front *face*, which is the boundary itself:
		// the origin sat on the wall and the emitters sprayed outward from there, so the visible result was a haze floating in
		// the air in front of the arena. A point on a boundary divides its own cloud in half.
		//
		// At `MOTION_BLUR_DEPTH_FRACTION = 0.2` of a 40-stud zone the depth is 8 studs, so the anchor is `-20 + 8 = -12` from the
		// centre: `100 - 12 = 88`.
		const anchor = motionBlurAnchor(zoneFrame, 40);

		expect(anchor.Position.X).toBe(88);
		// `Y` and `Z` are untouched: this is a slide along one axis, not a re-centring.
		expect(anchor.Position.Y).toBe(2);
		expect(anchor.Position.Z).toBe(-5);

		// And it is **strictly inside** the box — the property the face version failed. Half-length to the front face, so
		// anything greater than `-20` and less than `+20` in local X is in the arena.
		expect(motionBlurDepthStuds(40)).toBe(8);
		expect(anchor.Position.X > 100 - 20).toBe(true);
	});

	it("moves with the zone, so re-placing the fixture in Studio keeps the effect in its front", () => {
		// A hard-coded world coordinate would have to be re-derived by hand every time the zone moved; an offset from the
		// fixture is the reason this is a function of the zone at all.
		const moved = motionBlurAnchor(new CFrame(250, 7, 90), 40);

		expect(moved.Position.X).toBe(238);
		expect(moved.Position.Y).toBe(7);
		expect(moved.Position.Z).toBe(90);
	});

	it("follows the zone's size, so a resized zone keeps the effect the same fraction in", () => {
		// The depth is **proportional**, which is the point of a fraction over a studs inset: what has to stay inside is a share
		// of the box, so a longer zone moves the effect further in rather than leaving it near a face that has moved away.
		expect(motionBlurAnchor(zoneFrame, 40).Position.X).toBe(88); // -20 + 8
		expect(motionBlurAnchor(zoneFrame, 100).Position.X).toBe(70); // -50 + 20
		// A zero-length zone degenerates to its centre rather than throwing, which is what a part whose `Size` has not
		// replicated reads as.
		expect(motionBlurAnchor(zoneFrame, 0).Position.X).toBe(100);
	});

	it("keeps the zone's rotation instead of replacing it with an identity basis", () => {
		// The offset is composed **in the zone's local frame** (`CFrame.mul`), so a fixture rotated in Studio carries the effect
		// with it. Composing the offset in world space instead would leave the effect on the world `-X` side of a rotated box,
		// which is off the fixture entirely.
		//
		// **This asserts the *anchor*, not the clone.** Since item 142 the clone takes only this CFrame's `Position` and keeps the
		// asset's rotation — but the anchor's basis is still load-bearing, because it is what puts the position on the correct
		// face of a turned box, and this case is the only thing that pins it.
		const turned = CFrame.Angles(0, math.rad(90), 0);
		const rotatedZone = new CFrame(100, 2, -5).mul(turned);
		const anchor = motionBlurAnchor(rotatedZone, 40);

		// A quarter turn about +Y sends the local `-X` axis to world `+Z`, so the anchor is 12 studs along it from the centre:
		// `-5 + 12 = 7`. (Worked through rather than eyeballed: the Y-rotation matrix's first column is `(cos, 0, -sin)`, which
		// is `(0, 0, -1)` at 90 degrees, and `-12` along that is `(0, 0, +12)`.)
		expect(math.round(anchor.Position.X)).toBe(100);
		expect(math.round(anchor.Position.Z)).toBe(7);

		// And the basis is the zone's, not the identity.
		expect(math.abs(anchor.RightVector.X) < 1e-6).toBe(true);
		expect(math.round(anchor.RightVector.Z)).toBe(-1);
	});
});

/**
 * The same basis to three places, as nine numbers.
 *
 * Written out rather than comparing CFrames with `toBe` (userdata identity) or `FuzzyEq` (which the test harness is not known to
 * expose): the assertion these cases need is "these two are the *same* rotation" and "these two are *not*", and both read
 * better as a boolean over numbers a reader can see in the failure output.
 */
function equalBasis(a: CFrame, b: CFrame): boolean {
	const round = (value: number) => math.round(value * 1000) / 1000;

	const axesA = [a.RightVector, a.UpVector, a.LookVector];
	const axesB = [b.RightVector, b.UpVector, b.LookVector];

	for (let index = 0; index < axesA.size(); index++) {
		const left = axesA[index];
		const right = axesB[index];

		if (round(left.X) !== round(right.X) || round(left.Y) !== round(right.Y) || round(left.Z) !== round(right.Z)) {
			return false;
		}
	}

	return true;
}

describe("motionBlurCloneFrame", () => {
	/** An asset the designer has turned 45 degrees about Z, as the user did in Studio. */
	const assetRotation = CFrame.Angles(0, 0, math.rad(45));

	it("takes the position from the zone and the rotation from the asset", () => {
		// **The regression item 142 exists for.** Item 141 assigned the anchor straight to `clone.CFrame`, so the zone's basis
		// replaced the asset's and the effect rendered at the wrong angle — item 97's symptom, one object class over. The user's
		// Studio rotation is ground truth; the zone has no opinion about which way a particle emitter was drawn.
		const zoneFrame = new CFrame(100, 2, -5).mul(CFrame.Angles(0, math.rad(90), 0));
		const cloneFrame = motionBlurCloneFrame(zoneFrame, 40, assetRotation);

		// The positive: the clone is turned exactly as the asset is.
		expect(equalBasis(cloneFrame, assetRotation)).toBe(true);

		// **The negative, and it is the half that catches a future "simplification".** `zoneFrame.mul(assetRotation)` — or the
		// anchor, which carries the zone's basis — compiles, lints, and turns the effect 90 degrees further than the designer
		// intended. With an unrotated asset *and* an unrotated zone both spellings agree, so a case that only checked the positive
		// would pass on the broken code.
		expect(equalBasis(cloneFrame, zoneFrame)).toBe(false);
		expect(equalBasis(cloneFrame, zoneFrame.Rotation)).toBe(false);

		// And the position is still the anchor's: inside the front of the (rotated) box, where `motionBlurAnchor` puts it.
		const anchor = motionBlurAnchor(zoneFrame, 40);
		expect(math.round(cloneFrame.Position.X)).toBe(math.round(anchor.Position.X));
		expect(math.round(cloneFrame.Position.Y)).toBe(math.round(anchor.Position.Y));
		expect(math.round(cloneFrame.Position.Z)).toBe(math.round(anchor.Position.Z));
	});

	it("keeps the asset's rotation when the zone is rotated and the asset is not", () => {
		// Acceptance criterion 5's first combination. An identity asset rotation must survive a turned zone — the case where
		// "the effect is at the right place but tilted with the fixture" would look like a bug in the asset.
		const zoneFrame = new CFrame(0, 0, 0).mul(CFrame.Angles(0, math.rad(90), 0));
		const cloneFrame = motionBlurCloneFrame(zoneFrame, 40, CFrame.identity);

		expect(equalBasis(cloneFrame, CFrame.identity)).toBe(true);
		expect(equalBasis(cloneFrame, zoneFrame)).toBe(false);
		// Position still follows the zone: 12 studs along its local `-X` (half the box minus the 0.2 depth on 40 studs), which
		// a quarter turn sends to `+Z`.
		expect(math.round(cloneFrame.Position.Z)).toBe(12);
	});

	it("keeps the asset's rotation when the asset is rotated and the zone is not", () => {
		// Acceptance criterion 5's second combination, and the one the user actually reported: an axis-aligned zone, a rotated
		// asset. Before item 142 this produced an identity basis — the asset's 45 degrees thrown away entirely.
		const zoneFrame = new CFrame(10, 3, 4);
		const cloneFrame = motionBlurCloneFrame(zoneFrame, 40, assetRotation);

		expect(equalBasis(cloneFrame, assetRotation)).toBe(true);
		expect(equalBasis(cloneFrame, CFrame.identity)).toBe(false);
		// The axis-aligned anchor is `X - 20 + 8` (half the box, back in by the depth fraction).
		expect(math.round(cloneFrame.Position.X)).toBe(-2);
		expect(math.round(cloneFrame.Position.Y)).toBe(3);
		expect(math.round(cloneFrame.Position.Z)).toBe(4);
	});
});
