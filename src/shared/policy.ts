/**
 * The paid-random-item gate, as data.
 *
 * ## Why this is a shared pure function rather than a branch inside the controller
 *
 * Because the decision is a *rule*, not a rendering detail, and rules are worth testing. Roblox returns a `PolicyInfo`
 * record whose `ArePaidRandomItemsRestricted` field decides whether this player may be shown a paid random item at all.
 * Mapping that record to one of four states is the only part of the gate that can be exercised without a live session,
 * so it lives here where a spec can reach it and the controller only has to cache the result.
 *
 * ## Why `unknown` is a state rather than an error
 *
 * `PolicyService:GetPolicyInfoForPlayerAsync` can fail — no network, a transient backend error, a Studio session that is
 * not authenticated. A gate that treated a failure as "allowed" would fail **open**, and failing open here means selling
 * a randomised item to a player whose jurisdiction forbids it, which is not a bug that can be fixed after the fact. So a
 * failure is its own state, and the caller treats it exactly like `restricted`.
 */
export type PolicyState = "loading" | "allowed" | "restricted" | "unknown";

/**
 * Maps a fetched policy record to a gate state.
 *
 * `undefined` — the call failed, or has not completed — is `"unknown"`, never `"allowed"`. The whole point of the union
 * is that the permissive state has to be *proved* by a record that explicitly permits it.
 */
export function policyStateFrom(info: PolicyInfo | undefined): PolicyState {
	if (info === undefined) {
		return "unknown";
	}

	return info.ArePaidRandomItemsRestricted ? "restricted" : "allowed";
}

/**
 * Whether a state permits showing a purchase prompt.
 *
 * Written as an allow-list rather than `state !== "restricted"` so that adding a fifth state later defaults to blocked.
 * The two spellings mean the same thing today and stop meaning the same thing the moment somebody adds a state and
 * forgets this function.
 */
export function policyAllowsPurchase(state: PolicyState): boolean {
	return state === "allowed";
}
