/**
 * Canonical matrix of reachable `(capability × fundingSource × programType)`
 * paths and three-tier permutation guidance for enterprise billing.
 *
 * All combinations of `(FundingSource × ProgramType)` are supported at runtime
 * for SPONSOR and HYBRID organizations. Instead of hard-refusing unconventional
 * pairings at the API layer, `getPermutationGuidance` classifies each pairing into
 * `RECOMMENDED`, `ADVANCED`, or `DISCOURAGED` tiers so the admin UI can surface
 * contextual guidance and confirmation prompts.
 */

import type {
  FundingSource,
  OverageBehavior,
  ProgramType,
} from "@prisma/client";

export type ReachableCapability =
  | "PERSONAL_TAG" // not a real Program — tag-only attribution
  | "SPONSOR"
  | "HOST"
  | "HYBRID";

export interface ReachablePath {
  capability: ReachableCapability;
  /** `null` means no Program at all (unfunded / pre-program shapes). */
  fundingSource: FundingSource | null;
  /** `null` means no Program at all. Every capability enumerates its pairs explicitly. */
  programType: ProgramType | null;
}

export type PermutationGuidanceTier =
  "RECOMMENDED" | "ADVANCED" | "DISCOURAGED";

export interface PermutationGuidance {
  tier: PermutationGuidanceTier;
  code: string;
  title: string;
  message: string;
  recommendation: string;
  requiresConfirmation: boolean;
}

/**
 * Full matrix of supported `(capability, fundingSource, programType)` triples:
 * 8 SPONSOR pairs + 8 HYBRID pairs + 4 program-less `(null, null)` shapes = 20 rows.
 */
export const REACHABLE_ORG_FUNDING_PATHS: ReadonlyArray<ReachablePath> = [
  { capability: "PERSONAL_TAG", fundingSource: null, programType: null },
  { capability: "HOST", fundingSource: null, programType: null },
  { capability: "SPONSOR", fundingSource: null, programType: null },
  { capability: "HYBRID", fundingSource: null, programType: null },
  {
    capability: "SPONSOR",
    fundingSource: "WALLET",
    programType: "CREDIT_POOL",
  },
  {
    capability: "SPONSOR",
    fundingSource: "WALLET",
    programType: "LICENSED_SEAT",
  },
  {
    capability: "SPONSOR",
    fundingSource: "INVOICE",
    programType: "CREDIT_POOL",
  },
  {
    capability: "SPONSOR",
    fundingSource: "INVOICE",
    programType: "LICENSED_SEAT",
  },
  {
    capability: "SPONSOR",
    fundingSource: "LICENSE",
    programType: "LICENSED_SEAT",
  },
  {
    capability: "SPONSOR",
    fundingSource: "LICENSE",
    programType: "CREDIT_POOL",
  },
  {
    capability: "SPONSOR",
    fundingSource: "PERSONAL",
    programType: "CREDIT_POOL",
  },
  {
    capability: "SPONSOR",
    fundingSource: "PERSONAL",
    programType: "LICENSED_SEAT",
  },
  { capability: "HYBRID", fundingSource: "WALLET", programType: "CREDIT_POOL" },
  {
    capability: "HYBRID",
    fundingSource: "WALLET",
    programType: "LICENSED_SEAT",
  },
  {
    capability: "HYBRID",
    fundingSource: "INVOICE",
    programType: "CREDIT_POOL",
  },
  {
    capability: "HYBRID",
    fundingSource: "INVOICE",
    programType: "LICENSED_SEAT",
  },
  {
    capability: "HYBRID",
    fundingSource: "LICENSE",
    programType: "LICENSED_SEAT",
  },
  {
    capability: "HYBRID",
    fundingSource: "LICENSE",
    programType: "CREDIT_POOL",
  },
  {
    capability: "HYBRID",
    fundingSource: "PERSONAL",
    programType: "CREDIT_POOL",
  },
  {
    capability: "HYBRID",
    fundingSource: "PERSONAL",
    programType: "LICENSED_SEAT",
  },
] as const;

/**
 * True iff the requested (fundingSource, programType) pair is reachable
 * for an org of the given capability shape.
 */
export function isReachableOrgFundingPath(
  capability: ReachableCapability,
  fundingSource: FundingSource | null,
  programType: ProgramType | null,
): boolean {
  return REACHABLE_ORG_FUNDING_PATHS.some(
    (p) =>
      p.capability === capability &&
      p.fundingSource === fundingSource &&
      p.programType === programType,
  );
}

export type OverageRefusalCode =
  | "CHARGE_MEMBER_NEEDS_EARNINGS_HOLD"
  | "WALLET_CHARGE_ORG_RETIRED"
  | "LICENSE_OVERAGE_UNSUPPORTED"
  | "OVERAGE_SURCHARGE_UNSUPPORTED";

export interface OverageRefusal {
  code: OverageRefusalCode;
  field: "overageBehavior" | "overageSurchargeBps";
  message: string;
}

export const CHARGE_MEMBER_NEEDS_EARNINGS_HOLD =
  "Charging members for bookings past the programme cap is not available yet: the member pays after the session, so the consultant would be paid for money that may never arrive. " +
  "Choose CHARGE_ORG to bill the organisation for the over-cap portion, or BLOCK to stop over-cap bookings.";

/**
 * Evaluates overage configuration for hard backend refusals.
 *
 * All overage permutations across WALLET, INVOICE, LICENSE, and PERSONAL
 * funding rails are supported by the settlement engine; guidance and
 * warnings for complex combinations are provided via `getPermutationGuidance`.
 */
export function overageConfigRefusals(
  _fundingSource: FundingSource | null,
  _overageBehavior: OverageBehavior,
  _overageSurchargeBps?: number | null,
): OverageRefusal[] {
  return [];
}

/**
 * Validates the combined overage configuration when patching or superseding an
 * existing program. Throws a 400 error (`code: "INVALID_OVERAGE_CONFIG"`) if
 * the merged configuration contains dead knobs (e.g. overage settings on an
 * unlimited seat cap or surcharge under BLOCK) or lacks a positive
 * `maxOveragePerCyclePaise` circuit-breaker ceiling when charging overages.
 */
export function assertMergedOverageConfigValid(params: {
  programType: ProgramType;
  fundingSource: FundingSource | null;
  overageBehavior: OverageBehavior;
  overageSurchargeBps: number | null;
  maxOveragePerCyclePaise: number | null;
  coveredEngagementsPerCycle: number | null;
  disallowMaxOverageWhenBlocked?: boolean;
  touchedOverageFields?: Partial<
    Record<"overageBehavior" | "overageSurchargeBps", boolean>
  >;
}): void {
  const {
    programType,
    fundingSource,
    overageBehavior,
    overageSurchargeBps,
    maxOveragePerCyclePaise,
    coveredEngagementsPerCycle,
    disallowMaxOverageWhenBlocked = false,
    touchedOverageFields,
  } = params;

  const fail = (message: string): never => {
    throw Object.assign(new Error(message), {
      httpStatus: 400,
      code: "INVALID_OVERAGE_CONFIG",
    });
  };

  if (
    programType === "LICENSED_SEAT" &&
    (coveredEngagementsPerCycle === null ||
      coveredEngagementsPerCycle === undefined) &&
    (overageBehavior !== "BLOCK" ||
      (overageSurchargeBps ?? 0) > 0 ||
      (maxOveragePerCyclePaise !== null &&
        maxOveragePerCyclePaise !== undefined))
  ) {
    fail(
      "Overage settings have no effect while coveredEngagementsPerCycle is unlimited — clear them or set a cap.",
    );
  }

  if (
    overageBehavior !== "BLOCK" &&
    ((coveredEngagementsPerCycle !== null &&
      coveredEngagementsPerCycle !== undefined) ||
      programType === "CREDIT_POOL") &&
    (maxOveragePerCyclePaise === null ||
      maxOveragePerCyclePaise === undefined ||
      maxOveragePerCyclePaise < 1)
  ) {
    fail(
      `overageBehavior=${overageBehavior} requires a positive maxOveragePerCyclePaise circuit-breaker ceiling.`,
    );
  }

  if (overageBehavior === "BLOCK") {
    if (
      disallowMaxOverageWhenBlocked &&
      ((overageSurchargeBps ?? 0) > 0 ||
        (maxOveragePerCyclePaise !== null &&
          maxOveragePerCyclePaise !== undefined))
    ) {
      fail(
        "overageSurchargeBps and maxOveragePerCyclePaise have no effect when overageBehavior=BLOCK — clear them or choose CHARGE_MEMBER / CHARGE_ORG.",
      );
    }
    if ((overageSurchargeBps ?? 0) > 0) {
      fail(
        "overageSurchargeBps has no effect with overageBehavior=BLOCK — remove it or pick CHARGE_MEMBER/CHARGE_ORG.",
      );
    }
  }

  const refusals = overageConfigRefusals(
    fundingSource,
    overageBehavior,
    overageSurchargeBps,
  );
  const refusal = touchedOverageFields
    ? refusals.find((r) => touchedOverageFields[r.field])
    : refusals[0];
  if (refusal) {
    fail(refusal.message);
  }
}

/**
 * Classifies a `(fundingSource, programType, overageBehavior, overageSurchargeBps)`
 * permutation into a three-tier guidance model (`RECOMMENDED`, `ADVANCED`,
 * `DISCOURAGED`) with actionable recommendations for enterprise admins.
 */
export function getPermutationGuidance(params: {
  fundingSource: FundingSource | null;
  programType: ProgramType | null;
  overageBehavior?: OverageBehavior | null;
  overageSurchargeBps?: number | null;
}): PermutationGuidance {
  const {
    fundingSource,
    programType,
    overageBehavior = "BLOCK",
    overageSurchargeBps = null,
  } = params;
  const hasSurcharge = (overageSurchargeBps ?? 0) > 0;

  // Tier 3: DISCOURAGED (supported at runtime, but carries operational or billing complexity)
  if (
    fundingSource === "WALLET" &&
    overageBehavior === "CHARGE_ORG" &&
    hasSurcharge
  ) {
    return {
      tier: "DISCOURAGED",
      code: "WALLET_CHARGE_ORG_SURCHARGE",
      title: "Prepaid wallet with organization overage surcharge",
      message:
        "When an engagement exceeds the program cap, the overage surcharge plus 18% GST is debited directly from the prepaid wallet at checkout.",
      recommendation:
        "Consider removing the overage surcharge on WALLET-funded programs, or use INVOICE funding if you want surcharges billed on monthly GST invoices.",
      requiresConfirmation: true,
    };
  }

  if (fundingSource === "LICENSE" && overageBehavior === "CHARGE_ORG") {
    return {
      tier: "DISCOURAGED",
      code: "LICENSE_CHARGE_ORG",
      title: "Flat-fee license with organization-paid overages",
      message:
        "Bookings under a flat-fee LICENSE settle at ₹0 per session until the cap is crossed, after which over-cap sessions mint a separate postpaid GST invoice accrual for the organization.",
      recommendation:
        "Use BLOCK for predictable flat-fee spend, or CHARGE_MEMBER if learners should co-pay for sessions beyond their seat allowance.",
      requiresConfirmation: true,
    };
  }

  if (fundingSource === "PERSONAL" && overageBehavior === "CHARGE_ORG") {
    return {
      tier: "DISCOURAGED",
      code: "PERSONAL_CHARGE_ORG",
      title: "Personal-card funding with organization-paid overages",
      message:
        "Members pay the base session price on their personal card while the organization accrues a postpaid GST invoice charge for the over-cap portion.",
      recommendation:
        "Use BLOCK or CHARGE_MEMBER for personal-card programs, or switch to WALLET/INVOICE funding if the organization intends to sponsor sessions.",
      requiresConfirmation: true,
    };
  }

  if (fundingSource === "LICENSE" && programType === "CREDIT_POOL") {
    return {
      tier: "DISCOURAGED",
      code: "LICENSE_CREDIT_POOL",
      title: "Flat-fee license paired with a rupee credit pool",
      message:
        "A flat-fee LICENSE contract absorbs session fees at the contract level while CREDIT_POOL meters notional rupee budgets per member.",
      recommendation:
        "Prefer LICENSED_SEAT to meter session counts under a flat-fee license, or WALLET/INVOICE funding to back a rupee credit pool.",
      requiresConfirmation: true,
    };
  }

  // Tier 2: ADVANCED (specialized split-tender or hybrid metering workflows)
  if (overageBehavior === "CHARGE_MEMBER") {
    return {
      tier: "ADVANCED",
      code: "SPLIT_TENDER_CHARGE_MEMBER",
      title: "Split-tender member overage co-pay",
      message:
        "The organization covers the in-cap portion while the member pays the over-cap marginal amount on their personal card. Consultant and organization earnings remain held until the member's card payment succeeds.",
      recommendation:
        "Ensure members are informed that bookings exceeding their program allowance require a personal card co-payment.",
      requiresConfirmation: false,
    };
  }

  if (overageBehavior === "CHARGE_ORG" && hasSurcharge) {
    return {
      tier: "ADVANCED",
      code: "CHARGE_ORG_WITH_SURCHARGE",
      title: "Organization overage with percentage surcharge",
      message:
        "Over-cap bookings accrue the pass-through session cost plus the configured percentage surcharge and 18% GST to the organization.",
      recommendation:
        "Set maxOveragePerCyclePaise as a circuit breaker to cap total overage exposure per billing cycle.",
      requiresConfirmation: false,
    };
  }

  if (fundingSource === "WALLET" && programType === "LICENSED_SEAT") {
    return {
      tier: "ADVANCED",
      code: "WALLET_LICENSED_SEAT",
      title: "Prepaid wallet with seat-count metering",
      message:
        "Members are metered by session count per cycle (LICENSED_SEAT) while each session debits its actual booking price from the organization's prepaid wallet.",
      recommendation:
        "Set priceCapPerEngagementPaise on the seat configuration to bound how much a single session can debit from the wallet.",
      requiresConfirmation: false,
    };
  }

  if (fundingSource === "INVOICE" && programType === "CREDIT_POOL") {
    return {
      tier: "ADVANCED",
      code: "INVOICE_CREDIT_POOL",
      title: "Postpaid invoice with rupee credit pool",
      message:
        "Members spend against a cycle rupee budget (CREDIT_POOL) while actual session charges accrue onto the organization's monthly postpaid GST invoice.",
      recommendation:
        "Ensure BillingAccount.creditLimit or a PurchaseOrder ceiling is configured to bound total monthly invoice exposure.",
      requiresConfirmation: false,
    };
  }

  if (
    fundingSource === "PERSONAL" &&
    (programType === "CREDIT_POOL" || programType === "LICENSED_SEAT")
  ) {
    return {
      tier: "ADVANCED",
      code: "PERSONAL_PROGRAM_ALLOWANCE",
      title: "Personal-card checkout with program metering",
      message:
        "Members pay on their personal card while bookings are validated against the program's curated panel and metered against their cycle allowance.",
      recommendation:
        "Use this mode for corporate-negotiated access or reimbursement tracking where employees pay out of pocket at checkout.",
      requiresConfirmation: false,
    };
  }

  // Tier 1: RECOMMENDED (canonical enterprise paths)
  return {
    tier: "RECOMMENDED",
    code: "STANDARD_ENTERPRISE_PATH",
    title: "Standard enterprise billing configuration",
    message:
      "This funding source and program metering combination follows the standard settlement path.",
    recommendation: "No additional configuration needed.",
    requiresConfirmation: false,
  };
}

/**
 * Money-positive default: which overage behaviour a NEW programme gets when
 * the operator doesn't pick one.
 *
 * INVOICE programmes default to CHARGE_ORG — the over-cap marginal rides the
 * monthly invoice the org already pays, so expansion revenue accrues with no
 * refused booking and no member friction.
 *
 * Every other rail defaults to BLOCK.
 */
export function defaultOverageBehaviorForFunding(
  fundingSource: FundingSource | null,
): OverageBehavior {
  return fundingSource === "INVOICE" ? "CHARGE_ORG" : "BLOCK";
}

/**
 * Resolve a capability label from the canSponsor / canHost booleans.
 * SPONSOR-only (canSponsor=true, canHost=false) → "SPONSOR".
 * HOST-only (false, true) → "HOST".
 * HYBRID (true, true) → "HYBRID".
 * INERT (false, false) → null — not reachable.
 */
export function capabilityOf(
  canSponsor: boolean,
  canHost: boolean,
): ReachableCapability | null {
  if (canSponsor && canHost) return "HYBRID";
  if (canSponsor) return "SPONSOR";
  if (canHost) return "HOST";
  return null;
}
