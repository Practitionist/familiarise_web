/**
 * Single source of truth for `Organization.status` filters.
 *
 * Status semantics (from `enum OrgStatus`):
 *   - PENDING_VERIFICATION: org created, awaiting domain/identity proof.
 *     Members may sign in; INVOICE-funded bookings are credit-limited;
 *     SSO + invoiced billing + bulk invites are gated.
 *   - ACTIVE: fully verified; no governance gates.
 *   - SUSPENDED: temporarily blocked (billing failure, abuse review).
 *     Members lose access to org-scoped flows; existing bookings keep
 *     running. Recoverable via admin re-activation.
 *   - DEACTIVATED: terminal; org tear-down in progress. Treated as
 *     non-existent for billing + membership flows.
 *
 * Use these tuples instead of hand-rolling `status: { in: ["ACTIVE", ...] }`
 * filters at call sites — the rules for "is this org billable" or
 * "should this cron skip this org" should change in one place, not 17.
 */
import { OrgStatus } from "@prisma/client";

/**
 * Statuses that may be charged on the next billing cycle. Excludes
 * SUSPENDED (billing freeze) and DEACTIVATED (terminal). Used by
 * subscription-invoice + consolidated-invoice rollup crons.
 */
export const BILLABLE_ORG_STATUSES: OrgStatus[] = [OrgStatus.ACTIVE];

/**
 * Statuses that block new member onboarding (invitation accept). A
 * suspended-or-worse org cannot pull in fresh seats — even if a stale
 * invite link is clicked.
 */
export function isOnboardingBlocked(status: OrgStatus): boolean {
  return status === OrgStatus.SUSPENDED || status === OrgStatus.DEACTIVATED;
}

/**
 * True iff the org should be billed in the current cycle.
 */
export function isBillable(status: OrgStatus): boolean {
  return BILLABLE_ORG_STATUSES.includes(status);
}
