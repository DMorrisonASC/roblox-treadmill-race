import { describe, expect, it } from "@rbxts/jest-globals";
import { getOrdinal } from "./ordinal";

/**
 * The four boundaries an English ordinal has, and the reason a leaderboard showed `0st`.
 *
 * ## Why this is worth a spec
 *
 * The first build published the array index and appended a hard-coded `st`, so the leader read `0st` and everybody else read
 * a suffix that only happened to be right for one place in ten. The bug was two mistakes in one line - a 0-based index and a
 * missing rule - and neither is caught by a build. The cases below are exactly the ones a naive implementation gets wrong:
 * the teens, and the numbers that end in a teen's last digit without being one.
 */
describe("getOrdinal", () => {
	it("uses the four suffixes for the first four places", () => {
		expect(getOrdinal(1)).toBe("1st");
		expect(getOrdinal(2)).toBe("2nd");
		expect(getOrdinal(3)).toBe("3rd");
		expect(getOrdinal(4)).toBe("4th");
	});

	it("gives every teen `th`, including the ones ending in 1, 2 and 3", () => {
		// The case a `n % 10` implementation gets wrong: `11` ends in `1` and is not `11st`.
		expect(getOrdinal(11)).toBe("11th");
		expect(getOrdinal(12)).toBe("12th");
		expect(getOrdinal(13)).toBe("13th");
		expect(getOrdinal(14)).toBe("14th");
	});

	it("resumes the last-digit rule above the teens", () => {
		expect(getOrdinal(21)).toBe("21st");
		expect(getOrdinal(22)).toBe("22nd");
		expect(getOrdinal(23)).toBe("23rd");
		expect(getOrdinal(20)).toBe("20th");
	});

	it("applies the teen rule to the hundreds as well", () => {
		// `111`, `112` and `113` end in a teen, so the rule has to read two digits, not one.
		expect(getOrdinal(101)).toBe("101st");
		expect(getOrdinal(110)).toBe("110th");
		expect(getOrdinal(111)).toBe("111th");
		expect(getOrdinal(112)).toBe("112th");
		expect(getOrdinal(113)).toBe("113th");
		expect(getOrdinal(121)).toBe("121st");
	});

	it("floors a float, so a fractional rank cannot produce a suffix for a different number", () => {
		// `% 100` on `1.7` would be `1.7`, which fails every equality test and falls through to `th`.
		expect(getOrdinal(1.7)).toBe("1st");
		expect(getOrdinal(2.9)).toBe("2nd");
	});

	it("does not claim a place for zero", () => {
		// Not a rank, and `0th` on screen is obviously wrong rather than a plausible-looking first place.
		expect(getOrdinal(0)).toBe("0th");
	});
});
