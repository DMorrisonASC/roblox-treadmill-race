import { describe, expect, it } from "@rbxts/jest-globals";
import { distanceFromSpawnEdge } from "./position";

/**
 * The one ranking formula both the leaderboard and the time cap read (item 208).
 *
 * What this can prove: that the number is measured from the belt's spawn edge in the belt's own frame, that it grows toward the
 * exit, and that a moved or rotated belt does not invalidate it. What it cannot prove is that the winner the cap names is the
 * body the HUD shows at rank 1 - that is two services agreeing, which is what the shared function *is* rather than something a
 * case can assert.
 */
describe("distanceFromSpawnEdge", () => {
	// The scene's belt: `333` long on its own `X`, unrotated. Its local `+X` runs toward the elimination edge, so a body at
	// local `-166.5` is at distance `0` and one at `+166.5` is at `333`.
	const BELT_LENGTH = 333;

	it("is zero at the spawn edge and the belt's length at the exit", () => {
		const frame = CFrame.identity;

		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(-166.5, 0, 0))).toBeCloseTo(0, 5);
		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(0, 0, 0))).toBeCloseTo(BELT_LENGTH / 2, 5);
		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(166.5, 0, 0))).toBeCloseTo(BELT_LENGTH, 5);
	});

	it("grows toward the exit, so smaller is further ahead", () => {
		// The direction the leaderboard sorts on: the body closest to the spawn edge has the smallest number, which is why
		// ascending is the ranking order and why the cap's winner is the **minimum**.
		const frame = CFrame.identity;
		const near = distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(-100, 0, 0));
		const far = distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(100, 0, 0));

		expect(near < far).toBe(true);
	});

	it("ignores the body's height and its position across the belt", () => {
		// The measurement is along the belt only. A ball mid-pop (`Y`) or swaying (`Z`, in this frame's terms) has not gained or
		// lost ground, so neither may move its rank.
		const frame = CFrame.identity;
		const flat = distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(10, 0, 0));

		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(10, 40, 0))).toBeCloseTo(flat, 5);
		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, new Vector3(10, 0, 75))).toBeCloseTo(flat, 5);
	});

	it("follows the belt when the belt is moved and turned", () => {
		// **The reason it takes a frame rather than reading world `X`.** A belt turned a quarter turn about `Y` sends its local
		// `+X` to world `-Z`, so a body 100 studs along the belt is 100 studs along world `-Z` from the belt's origin - and a
		// world-`X` read would report the same number for every body on it.
		const origin = new Vector3(50, 20, -30);
		const frame = new CFrame(origin).mul(CFrame.Angles(0, math.pi / 2, 0));
		const along = frame.mul(new CFrame(new Vector3(0, 0, 0))).Position;
		const tenAlong = frame.mul(new CFrame(new Vector3(10, 0, 0))).Position;

		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, along)).toBeCloseTo(BELT_LENGTH / 2, 4);
		expect(distanceFromSpawnEdge(frame, BELT_LENGTH, tenAlong)).toBeCloseTo(BELT_LENGTH / 2 + 10, 4);

		// And the two positions really are distinct in world space, so the case is not passing on a degenerate frame.
		expect(along.X !== tenAlong.X || along.Z !== tenAlong.Z).toBe(true);
	});
});
