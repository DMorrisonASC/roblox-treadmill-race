import { describe, expect, it } from "@rbxts/jest-globals";
import { avatarUserIdFor } from "./ball-avatar";
import { AVATAR_USER_ID_ATTRIBUTE, OWNER_USER_ID_ATTRIBUTE } from "./attributes";

/**
 * The avatar's one rule: **competition key first, display key second.**
 *
 * The bug it guards is the `decoy` power's whole deception, in one line: a twin has no `OwnerUserId` by design, so a client
 * that only knew that key would draw nothing on the fake — and a bare ball beside an identical one *is* the fake. Every case
 * below is a pair of attributes as they actually arrive (`GetAttribute` returns `AttributeValue`, so `unknown`).
 */

describe("avatarUserIdFor", () => {
	it("uses the competition key for a real body", () => {
		// The ordinary case, and it must be the *first* branch: a real body's `OwnerUserId` is the authority, exactly as it is
		// for `getCompetitors()`, so the avatar and the winner rule cannot disagree about who owns a body.
		expect(avatarUserIdFor(4177, undefined)).toBe(4177);
	});

	it("uses the display key for a decoy twin, which has no competition key", () => {
		// **The case items 77/129/148 exist to protect.** The twin carries `AvatarUserId` copied from its parent and no
		// `OwnerUserId` at all, so this is the branch that decides whether the fake is invisible or indistinguishable.
		expect(avatarUserIdFor(undefined, 4177)).toBe(4177);
	});

	it("prefers the competition key when a body somehow has both", () => {
		// A body cannot legitimately have both — only twins are written the display key — but if one ever does, the two must
		// not be able to disagree about whose face is drawn. The competition key wins, because it is the one the rules use.
		expect(avatarUserIdFor(4177, 9999)).toBe(4177);
	});

	it("draws nothing for a body with neither key", () => {
		// A stray, a body from an older build, or a `Debug#N` ball that carries a synthetic owner. Nothing is drawn — not a
		// grey placeholder box, which would look like a broken avatar for every viewer.
		expect(avatarUserIdFor(undefined, undefined)).toBe(undefined);
	});

	it("draws nothing for a synthetic debug owner", () => {
		// Synthetic owners are negative by design (`-1`, `-2`, …). A web request for such a thumbnail can only fail, and a
		// request per debug body per round is exactly the traffic this overlay caches to avoid.
		expect(avatarUserIdFor(-1, undefined)).toBe(undefined);
		expect(avatarUserIdFor(undefined, -3)).toBe(undefined);
		expect(avatarUserIdFor(0, 0)).toBe(undefined);
	});

	it("draws nothing when an attribute was written as the wrong type", () => {
		// `GetAttribute` is untyped, and the overlay runs on the arena's most-travelled path. A string id is not a number and
		// must not reach `GetUserThumbnailAsync`; the fallback to the display key still works, which is what stops one bad
		// write from blanking a twin.
		expect(avatarUserIdFor("4177", undefined)).toBe(undefined);
		expect(avatarUserIdFor("4177", 4178)).toBe(4178);
		expect(avatarUserIdFor(true, undefined)).toBe(undefined);
	});

	it("names the two keys it reads", () => {
		// A tripwire on the *wiring* rather than the rule: these are the attribute names the spawner writes, and a rename in
		// `attributes.ts` that missed this module would leave the overlay looking for a key nobody sets — silently, because a
		// missing attribute is a legitimate "draw nothing".
		expect(OWNER_USER_ID_ATTRIBUTE).toBe("OwnerUserId");
		expect(AVATAR_USER_ID_ATTRIBUTE).toBe("AvatarUserId");
	});
});
