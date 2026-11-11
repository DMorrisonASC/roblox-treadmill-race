/**
 * **Which player's face a body is drawn with** — the one rule the avatar overlay obeys.
 *
 * ## Why this is a module rather than one `??` in the controller
 *
 * The controller reaches `Players:GetUserThumbnailAsync`, which yields and is a web call, so it cannot be constructed in the
 * Jest runtime. A rule written inside it could only ever be checked by joining a round with a `decoy` ball and looking at
 * two bodies, and the failure it guards against is precisely the one that is invisible in a *single* look: the twin showing
 * no face at all, or showing its own (which it does not have) instead of its parent's.
 *
 * The rule itself is short enough to state in a sentence and worth asserting: **the competition key first, the display key
 * second.** A real body answers from `OwnerUserId`; a decoy twin has no `OwnerUserId` by design and answers from
 * `AvatarUserId`, which the spawner copies from its parent; a body with neither — a stray, a debug-only body, one spawned by
 * an older build — is drawn with no face rather than with a placeholder.
 */

/**
 * The `UserId` a body should be drawn as, or `undefined` when it has none.
 *
 * `ownerUserId` is `OwnerUserId` (the competition key, item 77), `avatarUserId` is `AvatarUserId` (display-only, written on
 * twins only — see `AVATAR_USER_ID_ATTRIBUTE` for why it is not one key). Both arrive as `GetAttribute`'s `AttributeValue`,
 * so both are `unknown` here and narrowed rather than asserted: an attribute written as the wrong type by some later
 * mechanic must draw nothing, not crash a client controller on the arena's most-travelled path.
 *
 * **A non-positive id is not a player.** Synthetic debug owners are negative by design (`OwnerUserId = -1`, `-2`, …), and
 * asking Roblox for the thumbnail of `-1` is a web request that can only fail. Treating "not a real player" as "draw
 * nothing" is the same answer the overlay gives to a failed fetch, and it keeps the negative-id convention load-bearing
 * rather than decorative.
 */
export function avatarUserIdFor(ownerUserId: unknown, avatarUserId: unknown): number | undefined {
	if (typeIs(ownerUserId, "number") && ownerUserId > 0) {
		return ownerUserId;
	}

	if (typeIs(avatarUserId, "number") && avatarUserId > 0) {
		return avatarUserId;
	}

	return undefined;
}
