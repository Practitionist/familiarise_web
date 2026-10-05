/**
 * @jest-environment node
 */

/**
 * Pin the 20 reachable funding-program paths and three-tier permutation guidance.
 */

import {
  REACHABLE_ORG_FUNDING_PATHS,
  defaultOverageBehaviorForFunding,
  getPermutationGuidance,
  isReachableOrgFundingPath,
  overageConfigRefusals,
  capabilityOf,
} from "@/lib/enterprise/reachable-paths";

describe("REACHABLE_ORG_FUNDING_PATHS — full enterprise permutation matrix", () => {
  it("contains 20 reachable shapes (8 SPONSOR + 8 HYBRID + 4 program-less)", () => {
    expect(REACHABLE_ORG_FUNDING_PATHS).toHaveLength(20);
  });

  it("contains no wildcard rows", () => {
    for (const path of REACHABLE_ORG_FUNDING_PATHS) {
      expect((path as { programType: unknown }).programType).not.toBe("any");
      expect((path as { fundingSource: unknown }).fundingSource).not.toBe(
        "any",
      );
    }
  });

  it("restricts fundingSource and programType to supported enum values", () => {
    for (const path of REACHABLE_ORG_FUNDING_PATHS) {
      expect(["PERSONAL", "WALLET", "INVOICE", "LICENSE", null]).toContain(
        path.fundingSource as unknown,
      );
      expect(["LICENSED_SEAT", "CREDIT_POOL", null]).toContain(
        path.programType as unknown,
      );
    }
  });

  describe("isReachableOrgFundingPath", () => {
    const allFundingSources = [
      "WALLET",
      "INVOICE",
      "LICENSE",
      "PERSONAL",
    ] as const;
    const allProgramTypes = ["CREDIT_POOL", "LICENSED_SEAT"] as const;

    it.each(
      allFundingSources.flatMap((f) =>
        allProgramTypes.map((p) => [f, p] as const),
      ),
    )("accepts SPONSOR and HYBRID with %s + %s", (funding, program) => {
      expect(isReachableOrgFundingPath("SPONSOR", funding, program)).toBe(true);
      expect(isReachableOrgFundingPath("HYBRID", funding, program)).toBe(true);
    });

    it("accepts null funding and program for all capabilities", () => {
      expect(isReachableOrgFundingPath("PERSONAL_TAG", null, null)).toBe(true);
      expect(isReachableOrgFundingPath("HOST", null, null)).toBe(true);
      expect(isReachableOrgFundingPath("SPONSOR", null, null)).toBe(true);
      expect(isReachableOrgFundingPath("HYBRID", null, null)).toBe(true);
    });

    it("rejects half-null pairs and HOST with non-null funding/program", () => {
      expect(isReachableOrgFundingPath("SPONSOR", "INVOICE", null)).toBe(false);
      expect(isReachableOrgFundingPath("HYBRID", "WALLET", null)).toBe(false);
      expect(isReachableOrgFundingPath("HOST", "WALLET", "CREDIT_POOL")).toBe(
        false,
      );
    });
  });

  describe("overageConfigRefusals", () => {
    it("returns no hard backend refusals across all funding rails and overage behaviors", () => {
      for (const rail of [
        "WALLET",
        "INVOICE",
        "LICENSE",
        "PERSONAL",
        null,
      ] as const) {
        for (const behavior of [
          "BLOCK",
          "CHARGE_ORG",
          "CHARGE_MEMBER",
        ] as const) {
          expect(overageConfigRefusals(rail, behavior, null)).toEqual([]);
          expect(overageConfigRefusals(rail, behavior, 1500)).toEqual([]);
        }
      }
    });
  });

  describe("getPermutationGuidance", () => {
    it("classifies standard enterprise pairings as RECOMMENDED", () => {
      expect(
        getPermutationGuidance({
          fundingSource: "WALLET",
          programType: "CREDIT_POOL",
          overageBehavior: "BLOCK",
        }),
      ).toMatchObject({
        tier: "RECOMMENDED",
        code: "STANDARD_ENTERPRISE_PATH",
        requiresConfirmation: false,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "INVOICE",
          programType: "LICENSED_SEAT",
          overageBehavior: "CHARGE_ORG",
        }),
      ).toMatchObject({
        tier: "RECOMMENDED",
        code: "STANDARD_ENTERPRISE_PATH",
        requiresConfirmation: false,
      });
    });

    it("classifies specialized pairings and CHARGE_MEMBER as ADVANCED", () => {
      expect(
        getPermutationGuidance({
          fundingSource: "WALLET",
          programType: "LICENSED_SEAT",
          overageBehavior: "BLOCK",
        }),
      ).toMatchObject({
        tier: "ADVANCED",
        code: "WALLET_LICENSED_SEAT",
        requiresConfirmation: false,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "INVOICE",
          programType: "CREDIT_POOL",
          overageBehavior: "BLOCK",
        }),
      ).toMatchObject({
        tier: "ADVANCED",
        code: "INVOICE_CREDIT_POOL",
        requiresConfirmation: false,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "PERSONAL",
          programType: "CREDIT_POOL",
          overageBehavior: "BLOCK",
        }),
      ).toMatchObject({
        tier: "ADVANCED",
        code: "PERSONAL_PROGRAM_ALLOWANCE",
        requiresConfirmation: false,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "WALLET",
          programType: "CREDIT_POOL",
          overageBehavior: "CHARGE_MEMBER",
        }),
      ).toMatchObject({
        tier: "ADVANCED",
        code: "SPLIT_TENDER_CHARGE_MEMBER",
        requiresConfirmation: false,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "INVOICE",
          programType: "LICENSED_SEAT",
          overageBehavior: "CHARGE_ORG",
          overageSurchargeBps: 1000,
        }),
      ).toMatchObject({
        tier: "ADVANCED",
        code: "CHARGE_ORG_WITH_SURCHARGE",
        requiresConfirmation: false,
      });
    });

    it("classifies high-complexity permutations as DISCOURAGED with requiresConfirmation=true", () => {
      expect(
        getPermutationGuidance({
          fundingSource: "WALLET",
          programType: "CREDIT_POOL",
          overageBehavior: "CHARGE_ORG",
          overageSurchargeBps: 1000,
        }),
      ).toMatchObject({
        tier: "DISCOURAGED",
        code: "WALLET_CHARGE_ORG_SURCHARGE",
        requiresConfirmation: true,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "LICENSE",
          programType: "LICENSED_SEAT",
          overageBehavior: "CHARGE_ORG",
        }),
      ).toMatchObject({
        tier: "DISCOURAGED",
        code: "LICENSE_CHARGE_ORG",
        requiresConfirmation: true,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "PERSONAL",
          programType: "LICENSED_SEAT",
          overageBehavior: "CHARGE_ORG",
        }),
      ).toMatchObject({
        tier: "DISCOURAGED",
        code: "PERSONAL_CHARGE_ORG",
        requiresConfirmation: true,
      });

      expect(
        getPermutationGuidance({
          fundingSource: "LICENSE",
          programType: "CREDIT_POOL",
          overageBehavior: "BLOCK",
        }),
      ).toMatchObject({
        tier: "DISCOURAGED",
        code: "LICENSE_CREDIT_POOL",
        requiresConfirmation: true,
      });
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

