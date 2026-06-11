/**
 * #768 lockdown #17 — reachable (capability x fundingSource x programType) paths.
 *
 * After the Programs v2 drop (#768 Comment 3), the theoretical Cartesian
 * grid collapses to 7 reachable paths. Any code that branches on the
 * tuple should consult this constant rather than enumerating the raw
 * enums; otherwise the wizard, the route gate, and any analytics drift
 * out of sync.
 *
 * Read the matrix as: an organization in capability X can ONLY fund a
 * Program using one of the (fundingSource, programType) pairs listed
 * for that capability.
 */

import type { FundingSource, ProgramType } from "@prisma/client";

export type ReachableCapability =
  | "PERSONAL_TAG" // not a real Program — tag-only attribution
  | "SPONSOR"
  | "HOST"
  | "HYBRID";

export interface ReachablePath {
  capability: ReachableCapability;
  /** `null` means no Program at all (PERSONAL_TAG and HOST shapes). */
  fundingSource: FundingSource | null;
  /** `null` means no Program at all. `"any"` (HYBRID) means accept any of LICENSED_SEAT/CREDIT_POOL. */
  programType: ProgramType | "any" | null;
}

/**
 * Locked v0 matrix. Treat as a frozen contract — adding a row affects
 * the route gate, the wizard, and the regression test.
 */
export const REACHABLE_ORG_FUNDING_PATHS: ReadonlyArray<ReachablePath> = [
  { capability: "PERSONAL_TAG", fundingSource: null, programType: null },
  { capability: "SPONSOR", fundingSource: "WALLET", programType: "CREDIT_POOL" },
  { capability: "SPONSOR", fundingSource: "INVOICE", programType: "CREDIT_POOL" },
  { capability: "SPONSOR", fundingSource: "INVOICE", programType: "LICENSED_SEAT" },
  { capability: "SPONSOR", fundingSource: "LICENSE", programType: "LICENSED_SEAT" },
  { capability: "HOST", fundingSource: null, programType: null },
  { capability: "HYBRID", fundingSource: "any" as never, programType: "any" },
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
      (p.fundingSource === fundingSource ||
        (p.fundingSource as unknown) === "any") &&
      (p.programType === programType || p.programType === "any"),
  );
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
