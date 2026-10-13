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
    it.each([
      [
        "WALLET",
        "CREDIT_POOL",
        "BLOCK",
        null,
        "RECOMMENDED",
        "STANDARD_ENTERPRISE_PATH",
        false,
      ],
      [
        "INVOICE",
        "LICENSED_SEAT",
        "CHARGE_ORG",
        null,
        "RECOMMENDED",
        "STANDARD_ENTERPRISE_PATH",
        false,
      ],
      [
        "WALLET",
        "LICENSED_SEAT",
        "BLOCK",
        null,
        "ADVANCED",
        "WALLET_LICENSED_SEAT",
        false,
      ],
      [
        "INVOICE",
        "CREDIT_POOL",
        "BLOCK",
        null,
        "ADVANCED",
        "INVOICE_CREDIT_POOL",
        false,
      ],
      [
        "PERSONAL",
        "CREDIT_POOL",
        "BLOCK",
        null,
        "ADVANCED",
        "PERSONAL_PROGRAM_ALLOWANCE",
        false,
      ],
      [
        "WALLET",
        "CREDIT_POOL",
        "CHARGE_MEMBER",
        null,
        "ADVANCED",
        "SPLIT_TENDER_CHARGE_MEMBER",
        false,
      ],
      [
        "INVOICE",
        "LICENSED_SEAT",
        "CHARGE_ORG",
        1000,
        "ADVANCED",
        "CHARGE_ORG_WITH_SURCHARGE",
        false,
      ],
      [
        "WALLET",
        "CREDIT_POOL",
        "CHARGE_ORG",
        1000,
        "DISCOURAGED",
        "WALLET_CHARGE_ORG_SURCHARGE",
        true,
      ],
      [
        "LICENSE",
        "LICENSED_SEAT",
        "CHARGE_ORG",
        null,
        "DISCOURAGED",
        "LICENSE_CHARGE_ORG",
        true,
      ],
      [
        "PERSONAL",
        "LICENSED_SEAT",
        "CHARGE_ORG",
        null,
        "DISCOURAGED",
        "PERSONAL_CHARGE_ORG",
        true,
      ],
      [
        "LICENSE",
        "CREDIT_POOL",
        "BLOCK",
        null,
        "DISCOURAGED",
        "LICENSE_CREDIT_POOL",
        true,
      ],
    ] as const)(
      "classifies (%s, %s, %s, surcharge=%s) as %s (%s)",
      (
        fundingSource,
        programType,
        overageBehavior,
        overageSurchargeBps,
        tier,
        code,
        requiresConfirmation,
      ) => {
        expect(
          getPermutationGuidance({
            fundingSource,
            programType,
            overageBehavior,
            ...(overageSurchargeBps !== null ? { overageSurchargeBps } : {}),
          }),
        ).toMatchObject({ tier, code, requiresConfirmation });
      },
    );
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

