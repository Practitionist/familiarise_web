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
 * `any/any` wildcard (#1676 S4): the wildcard silently re-opened the three
 * refused intersections (`WALLET+CHARGE_MEMBER`, `WALLET+CHARGE_ORG` with a
 * surcharge, `LICENSE+non-BLOCK`) that `overageBehaviorUnsupportedReason`
 * and the checkout fail-closed guards exist to keep unreachable.
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
 * The reason a programme's overage behaviour cannot be honoured on a given
 * funding source, or `null` when the combination is supported.
 *
 * #1458 — the funding matrix above says which (capability, funding, programme
 * type) shapes exist; it says nothing about what happens once a booking goes
 * past the cap, and that gap let a wallet-funded organisation save a programme
 * that charges its members. Collecting from a member requires carving the
 * over-cap portion back out of the parent payment, which on the wallet rail
 * would mean crediting the wallet mid-transaction — the credit-back that #715
 * has never built. Checkout therefore refused the booking at commit, after the
 * member had already picked a slot. Refusing the CONFIGURATION instead means
 * the state is unreachable rather than merely fatal.
 *
 * `overageSurchargeBps` participates because the surcharge, not the behaviour
 * alone, decides collectability on the wallet rail: the plain over-cap amount is
 * a slice of the price the wallet already debited, while a markup on top of that
 * price is money no rail ever collects.
 *
 * The message is returned rather than thrown so both the create route (a Zod
 * refinement) and the patch route (an inline `fail()`) can raise it in their own
 * shape without either of them owning the rule.
 */
export function overageBehaviorUnsupportedReason(
  fundingSource: FundingSource | null,
  overageBehavior: OverageBehavior,
  overageSurchargeBps?: number | null,
): string | null {
  if (fundingSource === "WALLET" && overageBehavior === "CHARGE_MEMBER") {
    return (
      "A wallet-funded organisation cannot charge members for bookings past the programme cap, because the wallet debit has already collected the whole booking price and the member credit-back is not implemented (#715). " +
      "Choose CHARGE_ORG, which is collected by that same wallet debit, or BLOCK to stop over-cap bookings."
    );
  }
  // #1458 — CHARGE_ORG on the wallet rail is collectable only while the marginal
  // is a slice of the price the wallet already debited. A surcharge is a markup
  // ON TOP of that price, so nothing collected it; the only way to would be to
  // raise `Payment.amount`, which re-arms the leg-sum trigger against an
  // unchanged WALLET leg. recordWalletCollectedOrgOverage() therefore refuses it
  // at checkout — after the member has picked a slot — so refuse the
  // configuration here for the same reason CHARGE_MEMBER is refused above.
  if (
    fundingSource === "WALLET" &&
    overageBehavior === "CHARGE_ORG" &&
    (overageSurchargeBps ?? 0) > 0
  ) {
    return (
      "A wallet-funded organisation cannot be charged an overage surcharge, because the wallet debit collects the booking price and a surcharge is a markup on top of it that no rail collects afterwards. " +
      "Remove the overage surcharge to keep charging the organisation the plain over-cap amount, or choose BLOCK to stop over-cap bookings."
    );
  }
  // A licence is a flat fee settled at contract time, so a licence-funded
  // booking collects nothing per booking: its funding leg is deliberately ₹0
  // while `Payment.amount` stays at the full price, and the leg-sum guard
  // excuses that only while the licence leg is the payment's ONLY funding leg.
  // Charging an overage adds a second leg, which re-arms the comparison and
  // makes `assert_payment_legs_ok` raise at COMMIT — so every over-cap booking
  // under such a programme died with an opaque database error. There is no
  // per-booking rail to collect the marginal on, so the configuration itself is
  // refused.
  if (fundingSource === "LICENSE" && overageBehavior !== "BLOCK") {
    return (
      "A licence-funded programme cannot charge for bookings past its cap, because a licence is a flat fee settled at contract time and no money moves per booking to carry the overage. " +
      "Choose BLOCK to stop over-cap bookings, or fund the programme from the organisation's wallet or invoice account."
    );
  }
  return null;
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
