import { describe, expect, it } from "@rbxts/jest-globals";
import {
	extentAlong,
	generationOwnsFadeOut,
	MOTION_BLUR_FADE_SECONDS,
	MOTION_BLUR_PHASE,
	MOTION_BLUR_SCALE,
	motionBlurActionFor,
	motionBlurCloneFrame,
	motionBlurFillRatio,
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

	it("defaults to the zone-filling scale, not to a ball ratio", () => {
		// `MOTION_BLUR_SCALE` is **not** any ball effect's multiplier (each is `0.1` in `shared/config/` since item 177) and
		// **not** a ball ratio. Since item 192 it is a trim on `motionBlurFillRatio`, so `1` means "exactly the zone" — the
		// only defensible default for an effect whose whole job is to mark a hand-placed box. The case below proves the base it
		// trims is derived rather than authored.
		expect(MOTION_BLUR_SCALE).toBe(1);
	});
});

describe("extentAlong", () => {
	it("reads the box's own axis for an unrotated box", () => {
		// A 10 x 4 x 2 box, unrotated: its reach along world `X` is 10, along `Y` 4, along `Z` 2.
		const size = new Vector3(10, 4, 2);
		const basis = CFrame.identity;

		expect(extentAlong(size, basis, new Vector3(1, 0, 0))).toBe(10);
		expect(extentAlong(size, basis, new Vector3(0, 1, 0))).toBe(4);
		expect(extentAlong(size, basis, new Vector3(0, 0, 1))).toBe(2);
	});

	it("swaps the axes for a box turned a quarter turn, which is the whole point", () => {
		// **The case a `size.X` read would get wrong.** A quarter turn about `Y` sends the box's local `X` to world `Z`, so the
		// reach along world `X` becomes the box's `Z` size. Scaling a rotated asset against its own local axes is how an effect
		// ends up sized against the wrong dimension — the failure `motionBlurFillRatio` exists to avoid.
		const size = new Vector3(10, 4, 2);
		const basis = CFrame.Angles(0, math.rad(90), 0);

		expect(math.round(extentAlong(size, basis, new Vector3(1, 0, 0)))).toBe(2);
		expect(math.round(extentAlong(size, basis, new Vector3(0, 1, 0)))).toBe(4);
		expect(math.round(extentAlong(size, basis, new Vector3(0, 0, 1)))).toBe(10);
	});

	it("handles the asset's authored -90 degree tilt, which is what the log reports", () => {
		// The place's `motionBlur` asset is authored at `-90, 0, 0` (the `mounted` line prints it). A -90 degree turn about `X`
		// sends local `Y` to world `-Z` and local `Z` to world `Y`, so a box that is 4 deep in its own `Y` reaches 4 along world
		// `Z` — the numbers swap sign-wise but not magnitude, and the point is that the function is asked rather than assumed.
		const tilt = CFrame.Angles(math.rad(-90), 0, 0);
		const size = new Vector3(10, 4, 2);

		expect(math.round(extentAlong(size, tilt, new Vector3(0, 1, 0)))).toBe(2);
		expect(math.round(extentAlong(size, tilt, new Vector3(0, 0, 1)))).toBe(4);
	});
});

describe("motionBlurFillRatio", () => {
	it("scales a small asset up to cover a large zone", () => {
		// The reported bug, as arithmetic: a `4 x 4 x 4` authored part inside the 262-stud zone the log implies
		// (`depth=52.4` was a fifth of `zone.Size.X`). The largest per-axis ratio is `262 / 4 = 65.5`, so the effect is drawn 65
		// times its authored size and covers the box on every axis.
		expect(motionBlurFillRatio(new Vector3(262, 116, 173), new Vector3(4, 4, 4))).toBe(262 / 4);
	});

	it("is the largest ratio, so no axis is left short", () => {
		// An asset that is already zone-sized on two axes and short on the third is scaled by the short one. Taking the smallest
		// ratio instead would fit the box *inside* the zone and leave two axes short — the failure being fixed.
		const zone = new Vector3(100, 50, 20);
		const extents = new Vector3(100, 50, 5);

		expect(motionBlurFillRatio(zone, extents)).toBe(4);
	});

	it("is exactly 1 for an asset that already matches the zone", () => {
		// A designer who authors the asset to the zone's size gets `scaleEffect`'s own no-op path, so nothing is multiplied by a
		// number that means "already right".
		expect(motionBlurFillRatio(new Vector3(40, 10, 60), new Vector3(40, 10, 60))).toBe(1);
	});

	it("does not divide by zero on an asset with a flat axis", () => {
		// A `0`-thickness part (or one whose `Size` has not replicated) has no extent to measure. `1` is returned rather than an
		// infinity, so a mis-authored asset renders small — a visible bug — instead of filling the arena's interior with noise.
		expect(motionBlurFillRatio(new Vector3(100, 50, 20), new Vector3(0, 0, 0))).toBe(1);
		expect(motionBlurFillRatio(new Vector3(100, 50, 20), new Vector3(10, 10, 0))).toBe(10);
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
		// **The regression item 142 exists for.** Item 141 assigned the zone's `CFrame` straight to `clone.CFrame`, so the
		// zone's basis replaced the asset's and the effect rendered at the wrong angle — item 97's symptom, one object class
		// over. The user's Studio rotation is ground truth; the zone has no opinion about which way a particle emitter was drawn.
		const zoneFrame = new CFrame(100, 2, -5).mul(CFrame.Angles(0, math.rad(90), 0));
		const cloneFrame = motionBlurCloneFrame(zoneFrame, assetRotation);

		// The positive: the clone is turned exactly as the asset is.
		expect(equalBasis(cloneFrame, assetRotation)).toBe(true);

		// **The negative, and it is the half that catches a future "simplification".** `zoneFrame.mul(assetRotation)` — or the
		// zone's `CFrame` alone — compiles, lints, and turns the effect 90 degrees further than the designer intended. With an
		// unrotated asset *and* an unrotated zone both spellings agree, so a case that only checked the positive would pass on the
		// broken code.
		expect(equalBasis(cloneFrame, zoneFrame)).toBe(false);
		expect(equalBasis(cloneFrame, zoneFrame.Rotation)).toBe(false);

		// And the position is the zone's own: since item 192 the effect is the zone's size, so the only place it belongs is the
		// centre — including when the zone is turned. A quarter turn must move the position not at all.
		expect(math.round(cloneFrame.Position.X)).toBe(100);
		expect(math.round(cloneFrame.Position.Y)).toBe(2);
		expect(math.round(cloneFrame.Position.Z)).toBe(-5);
	});

	it("keeps the asset's rotation when the zone is rotated and the asset is not", () => {
		// Acceptance criterion 5's first combination. An identity asset rotation must survive a turned zone — the case where
		// "the effect is at the right place but tilted with the fixture" would look like a bug in the asset.
		const zoneFrame = new CFrame(0, 0, 0).mul(CFrame.Angles(0, math.rad(90), 0));
		const cloneFrame = motionBlurCloneFrame(zoneFrame, CFrame.identity);

		expect(equalBasis(cloneFrame, CFrame.identity)).toBe(true);
		expect(equalBasis(cloneFrame, zoneFrame)).toBe(false);
		// Position still follows the zone — and a zone turned about its own centre keeps that centre, which is the number this
		// asserts: no component of the position is derived from the zone's basis any more.
		expect(math.round(cloneFrame.Position.X)).toBe(0);
		expect(math.round(cloneFrame.Position.Z)).toBe(0);
	});

	it("keeps the asset's rotation when the asset is rotated and the zone is not", () => {
		// Acceptance criterion 5's second combination, and the one the user actually reported: an axis-aligned zone, a rotated
		// asset. Before item 142 this produced an identity basis — the asset's 45 degrees thrown away entirely.
		const zoneFrame = new CFrame(10, 3, 4);
		const cloneFrame = motionBlurCloneFrame(zoneFrame, assetRotation);

		expect(equalBasis(cloneFrame, assetRotation)).toBe(true);
		expect(equalBasis(cloneFrame, CFrame.identity)).toBe(false);
		// The zone's centre, unchanged by the asset's rotation: position and rotation are taken from different sources.
		expect(cloneFrame.Position.X).toBe(10);
		expect(cloneFrame.Position.Y).toBe(3);
		expect(cloneFrame.Position.Z).toBe(4);
	});
});
