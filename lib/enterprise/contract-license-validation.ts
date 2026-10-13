import { z } from "zod";

export type ContractLicenseValidationInput = {
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  licenseModel?: "FLAT_FEE" | "PER_SEAT";
  licenseCycle?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  licenseFeePaise?: number;
  licenseRatePerSeatPaise?: number;
};

/**
 * Shared Zod `.superRefine` callback for contract creation and supersession.
 * Enforces date ordering (`effectiveTo > effectiveFrom` when both are provided)
 * and mutual exclusion / required cycle rules for `FLAT_FEE` vs `PER_SEAT`
 * license inputs.
 */
function validateModelFeeRules(
  v: ContractLicenseValidationInput,
  ctx: z.RefinementCtx,
): void {
  if (v.licenseModel === "PER_SEAT") {
    if (v.licenseRatePerSeatPaise === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PER_SEAT requires licenseRatePerSeatPaise and forbids licenseFeePaise",
        path: ["licenseRatePerSeatPaise"],
      });
    }
    if (v.licenseFeePaise !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PER_SEAT requires licenseRatePerSeatPaise and forbids licenseFeePaise",
        path: ["licenseFeePaise"],
      });
    }
    return;
  }

  if (v.licenseModel === "FLAT_FEE") {
    if (v.licenseFeePaise === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "FLAT_FEE requires licenseFeePaise and forbids licenseRatePerSeatPaise",
        path: ["licenseFeePaise"],
      });
    }
    if (v.licenseRatePerSeatPaise !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "FLAT_FEE requires licenseFeePaise and forbids licenseRatePerSeatPaise",
        path: ["licenseRatePerSeatPaise"],
      });
    }
    return;
  }

  if (
    v.licenseFeePaise !== undefined &&
    v.licenseRatePerSeatPaise !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Cannot specify both licenseFeePaise and licenseRatePerSeatPaise",
      path: ["licenseModel"],
    });
  }
}

export function validateContractLicenseInput(
  v: ContractLicenseValidationInput,
  ctx: z.RefinementCtx,
): void {
  if (
    v.effectiveFrom !== undefined &&
    v.effectiveTo !== null &&
    v.effectiveTo !== undefined &&
    v.effectiveTo.getTime() <= v.effectiveFrom.getTime()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "effectiveTo must be strictly after effectiveFrom",
      path: ["effectiveTo"],
    });
  }

  const hasLicenseInput =
    v.licenseModel !== undefined ||
    v.licenseFeePaise !== undefined ||
    v.licenseRatePerSeatPaise !== undefined;
  if (hasLicenseInput && v.licenseCycle === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "licenseCycle is required when licenseModel, licenseFeePaise, or licenseRatePerSeatPaise is provided",
      path: ["licenseCycle"],
    });
  }

  validateModelFeeRules(v, ctx);
}
