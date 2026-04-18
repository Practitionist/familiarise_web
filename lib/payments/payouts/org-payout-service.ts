/**
 * @arch4-stub Organization Payout Service — pending Arch 4-Modified rewrite.
 *
 * Original implementation aggregated `OrganizationEarnings` (new field names:
 * `grossAmountPaise`, `platformFeePaise`, `orgSharePaise`, `refundedAmountPaise`)
 * into `OrganizationPayout` batches (new field names: `amountPaise`,
 * `grossRevenuePaise`, `platformFeePaise`, `refundsPaise`, `netPayoutPaise`).
 * The parent FK moved from `organizationProfileId` → `organizationId`.
 *
 * The live rewrite also needs to integrate India compliance stubs:
 *   - lib/compliance/tds.ts     → compute TDS per payout
 *   - lib/compliance/msme.ts    → compute mustPayByDate
 *   - lib/compliance/form15.ts  → cross-border refs
 *   - lib/compliance/gst.ts     → place-of-supply for platform-fee invoice
 *
 * Stub returns safe defaults so cron jobs don't crash but no payout is
 * actually issued. See docs/compliance/india/07-stubs-and-implementation-plan.md.
 */

// Errors retained so callers still compile.
export class PayoutLockError extends Error {
  readonly code = "PAYOUT_LOCK_CONFLICT" as const;
  constructor(message?: string) {
    super(
      message ??
        "Another payout batch is being created for this organization. Please try again.",
    );
    this.name = "PayoutLockError";
  }
}

export class PayoutValidationError extends Error {
  readonly code = "PAYOUT_VALIDATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "PayoutValidationError";
  }
}

export interface OrgPayoutEligibility {
  eligible: boolean;
  readyAmount: number;
  earningsCount: number;
  reason?: string;
}

export interface OrgPayoutBatchResult {
  payoutId: string;
  amount: number;
  earningsCount: number;
  periodStart: Date;
  periodEnd: Date;
}

export async function getOrgPayoutEligibility(
  _orgId: string,
): Promise<OrgPayoutEligibility> {
  return {
    eligible: false,
    readyAmount: 0,
    earningsCount: 0,
    reason: "STUB: Arch 4-Modified payout service not yet wired",
  };
}

export async function createOrgPayoutBatch(
  _orgId: string,
  _periodStart?: Date,
  _periodEnd?: Date,
): Promise<OrgPayoutBatchResult> {
  throw new PayoutValidationError(
    "STUB: createOrgPayoutBatch pending Arch 4-Modified rewrite",
  );
}

export async function processOrgPayout(_payoutId: string): Promise<void> {
  console.warn(
    "[arch4-stub] processOrgPayout called; no payout issued (see lib/payments/payouts/org-payout-service.ts)",
  );
}
