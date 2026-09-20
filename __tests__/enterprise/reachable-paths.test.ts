/**
 * @jest-environment node
 */

/**
 * #768 lockdown #17 — pin the 10 reachable funding-program paths.
 * #1676 S4 — HYBRID enumerates the 4 sponsor pairs; the `any/any` wildcard
 * is gone, so refused intersections stay refused for dual-capability orgs.
 *
 * Any drift to the (capability x fundingSource x programType) matrix
 * (e.g., re-introducing Programs v2 or adding a new fundingSource) must
 * update both the constant AND this test.
 */

import {
  REACHABLE_ORG_FUNDING_PATHS,
  defaultOverageBehaviorForFunding,
  isReachableOrgFundingPath,
  overageBehaviorUnsupportedReason,
  capabilityOf,
} from "@/lib/enterprise/reachable-paths";

describe("REACHABLE_ORG_FUNDING_PATHS — v0 lockdown matrix", () => {
  it("contains exactly 10 reachable shapes (4 SPONSOR + 4 HYBRID + 2 program-less)", () => {
    expect(REACHABLE_ORG_FUNDING_PATHS).toHaveLength(10);
  });

  it("contains no wildcard rows", () => {
    for (const path of REACHABLE_ORG_FUNDING_PATHS) {
      expect((path as { programType: unknown }).programType).not.toBe("any");
      expect((path as { fundingSource: unknown }).fundingSource).not.toBe(
        "any",
      );
    }
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
      expect(
        isReachableOrgFundingPath("HYBRID", "INVOICE", "CREDIT_POOL"),
      ).toBe(true);
      expect(
        isReachableOrgFundingPath("HYBRID", "INVOICE", "LICENSED_SEAT"),
      ).toBe(true);
    });

    // #1676 S4 — the old `any/any` wildcard accepted every pair for HYBRID,
    // silently re-opening the refused intersections. Enumeration keeps the
    // refusals refused for dual-capability orgs too.
    it("rejects refused pairs for HYBRID exactly as for SPONSOR", () => {
      const refused: Array<[Parameters<typeof isReachableOrgFundingPath>[1], Parameters<typeof isReachableOrgFundingPath>[2]]> = [
        ["WALLET", "LICENSED_SEAT"],
        ["LICENSE", "CREDIT_POOL"],
        ["INVOICE", null],
        ["WALLET", null],
      ];
      for (const [funding, program] of refused) {
        expect(isReachableOrgFundingPath("SPONSOR", funding, program)).toBe(
          false,
        );
        expect(isReachableOrgFundingPath("HYBRID", funding, program)).toBe(
          false,
        );
      }
      // Program-less HYBRID is not a program-funding question: HOST-side
      // earnings with no program never consult this matrix.
      expect(isReachableOrgFundingPath("HYBRID", null, null)).toBe(false);
    });
  });

  // #1458 — the matrix sanctions SPONSOR + WALLET + CREDIT_POOL, but a wallet
  // debit takes the whole booking price at commit, so there is nothing left to
  // carve back out for a member charge. Checkout could only fail closed after
  // the member had picked a slot; the config is what has to be refused.
  describe("overageBehaviorUnsupportedReason", () => {
    it("refuses CHARGE_MEMBER on a WALLET-funded account, naming #715", () => {
      const reason = overageBehaviorUnsupportedReason(
        "WALLET",
        "CHARGE_MEMBER",
      );
      expect(reason).toContain("#715");
    });

    it("refuses either charging behaviour on a LICENSE-funded account", () => {
      // A flat licence moves no money per booking, so nothing carries the
      // marginal and the leg-sum guard rejects the extra leg at COMMIT.
      expect(
        overageBehaviorUnsupportedReason("LICENSE", "CHARGE_ORG"),
      ).toContain("licence");
      expect(
        overageBehaviorUnsupportedReason("LICENSE", "CHARGE_MEMBER"),
      ).toContain("licence");
      expect(overageBehaviorUnsupportedReason("LICENSE", "BLOCK")).toBeNull();
    });

    it("allows CHARGE_ORG and BLOCK on WALLET, and CHARGE_MEMBER on INVOICE", () => {
      expect(
        overageBehaviorUnsupportedReason("WALLET", "CHARGE_ORG"),
      ).toBeNull();
      expect(overageBehaviorUnsupportedReason("WALLET", "BLOCK")).toBeNull();
      expect(
        overageBehaviorUnsupportedReason("INVOICE", "CHARGE_MEMBER"),
      ).toBeNull();
    });

    // A wallet debit collects the booking price, so the plain over-cap amount
    // rides along inside it; a surcharge sits on top of that price and nothing
    // collects it. Checkout refuses it either way, so the configuration must.
    it("refuses a surcharged CHARGE_ORG on WALLET but not the plain one", () => {
      expect(
        overageBehaviorUnsupportedReason("WALLET", "CHARGE_ORG", 1000),
      ).toContain("surcharge");
      expect(
        overageBehaviorUnsupportedReason("WALLET", "CHARGE_ORG", 0),
      ).toBeNull();
      // The surcharge only matters on the wallet rail — an invoice can carry it.
      expect(
        overageBehaviorUnsupportedReason("INVOICE", "CHARGE_ORG", 1000),
      ).toBeNull();
    });
  });

  describe("capabilityOf", () => {
    it.each([
      [true, false, "SPONSOR"],
      [false, true, "HOST"],
      [true, true, "HYBRID"],
      [false, false, null],
    ])("(%s, %s) → %s", (canSponsor, canHost, expected) => {
      expect(capabilityOf(canSponsor, canHost)).toBe(expected);
    });
  });

  // Money-positive default: INVOICE programmes charge the org (expansion
  // revenue with no refused booking); every other rail blocks.
  describe("defaultOverageBehaviorForFunding", () => {
    it("defaults INVOICE programmes to CHARGE_ORG", () => {
      expect(defaultOverageBehaviorForFunding("INVOICE")).toBe("CHARGE_ORG");
    });

    it.each(["WALLET", "LICENSE", "PERSONAL", null] as const)(
      "defaults %s to BLOCK",
      (funding) => {
        expect(defaultOverageBehaviorForFunding(funding)).toBe("BLOCK");
      },
    );
  });
});
