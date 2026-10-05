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
  overageConfigRefusals,
  CHARGE_MEMBER_NEEDS_EARNINGS_HOLD,
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
      expect([
        "PERSONAL",
        "WALLET",
        "INVOICE",
        "LICENSE",
        null,
        "any",
      ]).toContain(path.fundingSource as unknown);
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
      expect(isReachableOrgFundingPath("HYBRID", "WALLET", "CREDIT_POOL")).toBe(
        true,
      );
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
      const refused: Array<
        [
          Parameters<typeof isReachableOrgFundingPath>[1],
          Parameters<typeof isReachableOrgFundingPath>[2],
        ]
      > = [
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

  // Only INVOICE+CHARGE_ORG and BLOCK are sellable; every other overage shape
  // is refused at configuration time with a typed code.
  describe("overageConfigRefusals", () => {
    const codes = (...args: Parameters<typeof overageConfigRefusals>) =>
      overageConfigRefusals(...args).map((r) => r.code);

    it("refuses CHARGE_MEMBER on every rail with the earnings-hold reason", () => {
      for (const rail of ["WALLET", "INVOICE", "LICENSE", null] as const) {
        const [first] = overageConfigRefusals(rail, "CHARGE_MEMBER");
        expect(first.message).toBe(CHARGE_MEMBER_NEEDS_EARNINGS_HOLD);
      }
    });

    it("retires WALLET+CHARGE_ORG and refuses any charging on LICENSE", () => {
      expect(codes("WALLET", "CHARGE_ORG")).toEqual([
        "WALLET_CHARGE_ORG_RETIRED",
      ]);
      expect(codes("LICENSE", "CHARGE_ORG")).toEqual([
        "LICENSE_OVERAGE_UNSUPPORTED",
      ]);
      expect(codes("WALLET", "BLOCK")).toEqual([]);
      expect(codes("LICENSE", "BLOCK")).toEqual([]);
      expect(codes("INVOICE", "CHARGE_ORG")).toEqual([]);
    });

    it("refuses any surcharge, on the surcharge field, alongside the rail refusal", () => {
      expect(codes("INVOICE", "CHARGE_ORG", 1000)).toEqual([
        "OVERAGE_SURCHARGE_UNSUPPORTED",
      ]);
      expect(overageConfigRefusals("WALLET", "CHARGE_ORG", 1000)).toEqual([
        expect.objectContaining({ field: "overageBehavior" }),
        expect.objectContaining({ field: "overageSurchargeBps" }),
      ]);
      expect(codes("INVOICE", "CHARGE_ORG", 0)).toEqual([]);
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
