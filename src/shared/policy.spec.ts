import { describe, expect, it } from "@rbxts/jest-globals";
import { policyAllowsPurchase, policyStateFrom } from "./policy";

/**
 * The gate's only testable half.
 *
 * `GetPolicyInfoForPlayerAsync` needs a live session, so the async read stays Studio-only. What is worth pinning down is
 * the mapping, because the failure that matters is not "the call failed" ? it is "the call failed and the UI treated
 * that as permission".
 */
function info(restricted: boolean): PolicyInfo {
	return {
		AreAdsAllowed: false,
		ArePaidRandomItemsRestricted: restricted,
		AllowedExternalLinkReferences: [],
		IsEligibleToPurchaseSubscription: false,
		IsPaidItemTradingAllowed: false,
		IsSubjectToChinaPolicies: false,
	};
}

describe("policyStateFrom", () => {
	it("is restricted when the player may not see paid random items", () => {
		expect(policyStateFrom(info(true))).toBe("restricted");
	});

	it("is allowed only when the record explicitly permits it", () => {
		expect(policyStateFrom(info(false))).toBe("allowed");
	});

	it("is unknown, never allowed, when there is no record", () => {
		// The gate must not fail open. A missing record means the call failed or has not finished; either way nothing
		// has proved this player may be sold a randomised item.
		expect(policyStateFrom(undefined)).toBe("unknown");
	});
});

describe("policyAllowsPurchase", () => {
	it("permits only the allowed state", () => {
		expect(policyAllowsPurchase("allowed")).toBe(true);
		expect(policyAllowsPurchase("restricted")).toBe(false);
		expect(policyAllowsPurchase("unknown")).toBe(false);
		expect(policyAllowsPurchase("loading")).toBe(false);
	});
});
