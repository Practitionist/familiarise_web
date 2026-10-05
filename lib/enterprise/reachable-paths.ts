/**
 * #768 lockdown #17 — reachable (capability x fundingSource x programType) paths.
 *
 * After the Programs v2 drop (#768 Comment 3), the theoretical Cartesian
 * grid collapses to 10 reachable paths: the 4 sellable sponsor pairs, the
 * same 4 enumerated for HYBRID (no wildcard — #1676 S4), plus the two
 * program-less shapes (PERSONAL_TAG, HOST). Any code that branches on the
 * tuple should consult this constant rather than enumerating the raw
 * enums; otherwise the wizard, the route gate, and any analytics drift
 * out of sync.
 *
 * Read the matrix as: an organization in capability X can ONLY fund a
 * Program using one of the (fundingSource, programType) pairs listed
 * for that capability.
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
  /** `null` means no Program at all (PERSONAL_TAG and HOST shapes). */
  fundingSource: FundingSource | null;
  /** `null` means no Program at all. Every capability enumerates its pairs
   *  explicitly — there is no wildcard (see HYBRID below). */
  programType: ProgramType | null;
}

/**
 * Locked v1 matrix. Treat as a frozen contract — adding a row affects
 * the route gate, the wizard, and the regression test.
 *
 * HYBRID enumerates the same 4 sponsor pairs rather than carrying an
 * `any/any` wildcard: a wildcard would re-open the refused overage shapes
 * (`CHARGE_MEMBER`, `WALLET+CHARGE_ORG`, `LICENSE+non-BLOCK`, any surcharge)
 * that `overageConfigRefusals` and the checkout fail-closed guards keep unreachable.
 */
export const REACHABLE_ORG_FUNDING_PATHS: ReadonlyArray<ReachablePath> = [
  { capability: "PERSONAL_TAG", fundingSource: null, programType: null },
  { capability: "SPONSOR", fundingSource: "WALLET", programType: "CREDIT_POOL" },
  { capability: "SPONSOR", fundingSource: "INVOICE", programType: "CREDIT_POOL" },
  { capability: "SPONSOR", fundingSource: "INVOICE", programType: "LICENSED_SEAT" },
  { capability: "SPONSOR", fundingSource: "LICENSE", programType: "LICENSED_SEAT" },
  { capability: "HOST", fundingSource: null, programType: null },
  { capability: "HYBRID", fundingSource: "WALLET", programType: "CREDIT_POOL" },
  { capability: "HYBRID", fundingSource: "INVOICE", programType: "CREDIT_POOL" },
  { capability: "HYBRID", fundingSource: "INVOICE", programType: "LICENSED_SEAT" },
  { capability: "HYBRID", fundingSource: "LICENSE", programType: "LICENSED_SEAT" },
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

/**
 * Every typed refusal an overage configuration trips, most fundamental first;
 * empty when it is supported. Only INVOICE+CHARGE_ORG and BLOCK are sellable.
 *
 * `field` names the input that carries the refused value, so a PATCH that
 * leaves a legacy value untouched can still edit its other money fields.
 * Returned rather than thrown so the create route (a 400) and the patch route
 * (an inline `fail()`) raise it in their own shape.
 */
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

/**
 * #1744 (owner decision 2026-09-20) — CHARGE_MEMBER is refused on EVERY rail
 * until an earnings hold exists: the member pays after the session while the
 * consultant is paid on the full price. Exported so the refusal copy and the
 * audit share one sentence.
 */
export const CHARGE_MEMBER_NEEDS_EARNINGS_HOLD =
  "Charging members for bookings past the programme cap is not available yet: the member pays after the session, so the consultant would be paid for money that may never arrive. " +
  "Choose CHARGE_ORG to bill the organisation for the over-cap portion, or BLOCK to stop over-cap bookings.";

export function overageConfigRefusals(
  fundingSource: FundingSource | null,
  overageBehavior: OverageBehavior,
  overageSurchargeBps?: number | null,
): OverageRefusal[] {
  const refusals: OverageRefusal[] = [];
  if (overageBehavior === "CHARGE_MEMBER") {
    refusals.push({
      code: "CHARGE_MEMBER_NEEDS_EARNINGS_HOLD",
      field: "overageBehavior",
      message: CHARGE_MEMBER_NEEDS_EARNINGS_HOLD,
    });
  }
  // A wallet debit takes the booking price at commit, so there is no later bill
  // for an over-cap charge to ride on; the wallet rail blocks at the cap instead.
  if (fundingSource === "WALLET" && overageBehavior === "CHARGE_ORG") {
    refusals.push({
      code: "WALLET_CHARGE_ORG_RETIRED",
      field: "overageBehavior",
      message:
        "A wallet-funded programme stops bookings at its cap; charging the organisation for over-cap bookings is only available on invoice billing. " +
        "Choose BLOCK, or fund the programme from the organisation's invoice account.",
    });
  }
  // A licence is a flat fee settled at contract time: no money moves per
  // booking to carry an overage, and a second funding leg fails the leg-sum guard.
  if (
    fundingSource === "LICENSE" &&
    overageBehavior !== "BLOCK" &&
    overageBehavior !== "CHARGE_MEMBER"
  ) {
    refusals.push({
      code: "LICENSE_OVERAGE_UNSUPPORTED",
      field: "overageBehavior",
      message:
        "A licence-funded programme cannot charge for bookings past its cap, because a licence is a flat fee settled at contract time and no money moves per booking to carry the overage. " +
        "Choose BLOCK to stop over-cap bookings, or fund the programme from the organisation's invoice account.",
    });
  }
  // New surcharges stay refused; a legacy one is booked as platform fee and taxed at checkout.
  if ((overageSurchargeBps ?? 0) > 0) {
    refusals.push({
      code: "OVERAGE_SURCHARGE_UNSUPPORTED",
      field: "overageSurchargeBps",
      message:
        "An overage surcharge cannot be added yet. Remove the surcharge; over-cap bookings are still billed at their session price.",
    });
  }
  return refusals;
}

/**
 * Money-positive default: which overage behaviour a NEW programme gets when
 * the operator doesn't pick one.
 *
 * INVOICE programmes default to CHARGE_ORG — the over-cap marginal rides the
 * monthly invoice the org already pays, so expansion revenue accrues with no
 * refused booking and no member friction (Datadog/Snowflake-style overage).
 * The server still requires the circuit-breaker ceiling for any non-BLOCK
 * behaviour, and the payer sentence surfaces it before pay.
 *
 * Every other rail defaults to BLOCK: WALLET collects the whole price at
 * commit (a member charge-back doesn't exist, #715) and LICENSE moves no
 * money per booking at all.
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
