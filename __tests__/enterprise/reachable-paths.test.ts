/**
 * @jest-environment node
 */

/**
 * #768 lockdown #17 — pin the 7 reachable funding-program paths.
 *
 * Any drift to the (capability x fundingSource x programType) matrix
 * (e.g., re-introducing Programs v2 or adding a new fundingSource) must
 * update both the constant AND this test.
 */

import {
  REACHABLE_ORG_FUNDING_PATHS,
  isReachableOrgFundingPath,
  capabilityOf,
} from "@/lib/enterprise/reachable-paths";

describe("REACHABLE_ORG_FUNDING_PATHS — v0 lockdown matrix", () => {
  it("contains exactly 7 reachable shapes", () => {
    expect(REACHABLE_ORG_FUNDING_PATHS.length).toBe(7);
  });

  it("rejects Programs v2 fundingSource values", () => {
    // Reachable paths must not reference PROJECT/RETAINER/AOR/EOR.
    for (const path of REACHABLE_ORG_FUNDING_PATHS) {
      expect(["PERSONAL", "WALLET", "INVOICE", "LICENSE", null, "any"]).toContain(
        path.fundingSource as unknown,
      );
      expect(["LICENSED_SEAT", "CREDIT_POOL", null, "any"]).toContain(
        path.programType as unknown,
      );
    }
  });

  describe("isReachableOrgFundingPath", () => {
    it("accepts SPONSOR + WALLET + CREDIT_POOL", () => {
      expect(
        isReachableOrgFundingPath("SPONSOR", "WALLET", "CREDIT_POOL"),
      ).toBe(true);
    });

    it("accepts SPONSOR + LICENSE + LICENSED_SEAT", () => {
      expect(
        isReachableOrgFundingPath("SPONSOR", "LICENSE", "LICENSED_SEAT"),
      ).toBe(true);
    });

    it("rejects SPONSOR + LICENSE + CREDIT_POOL (bogus combo)", () => {
      // A flat-fee LICENSE pays for unmetered usage; a per-cycle credit
      // pool on top is internal-accounting noise. See LicensedSeatConfig
      // docstring + the route's BOGUS_LICENSE_CREDIT_POOL gate.
      expect(
        isReachableOrgFundingPath("SPONSOR", "LICENSE", "CREDIT_POOL"),
      ).toBe(false);
    });

    it("accepts HOST with null funding (consultant-earnings flow)", () => {
      expect(isReachableOrgFundingPath("HOST", null, null)).toBe(true);
    });

    it("accepts HYBRID with any reachable pair", () => {
      expect(
        isReachableOrgFundingPath("HYBRID", "WALLET", "CREDIT_POOL"),
      ).toBe(true);
      expect(
        isReachableOrgFundingPath("HYBRID", "LICENSE", "LICENSED_SEAT"),
      ).toBe(true);
    });
  });

  describe("capabilityOf", () => {
    it.each([
      [true, false, "SPONSOR"],
      [false, true, "HOST"],
      [true, true, "HYBRID"],
      [false, false, null],
    ])("(%s, %s) → %s", (canSponsor, canHost, expected) => {
      expect(capabilityOf(canSponsor as boolean, canHost as boolean)).toBe(
        expected,
      );
    });
  });
});
