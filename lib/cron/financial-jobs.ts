/**
 * Pure, dependency-free: read by the cron maintenance gate
 * (lib/maintenance-cron.ts) and by the System jobs console, which asks for a
 * typed confirm before running any of these by hand (#1527 Q10).
 */

// Financial jobs that must NOT run even in DEGRADED mode.
// These jobs call external APIs to create/cancel financial objects,
// or mutate financial state (earnings, payouts, refunds) that could
// become inconsistent during a partial deployment.
// Exported for the lock-registry drift test (#1169): every member that is
// cron-scheduled must hold a fail-closed lock.
// #1582/#1598 — `sweep-stuck-webhook-events`, `reconcile-orphaned-confirmations`
// and `sweep-orphaned-topup-captures` DO move money, but only by re-driving a
// webhook DEGRADED already exempts, so they are deliberately not listed here.
export const FINANCIAL_JOB_NAMES = new Set([
  "process-payouts",
  "create-payout-batch",
  "handle-stuck-payouts",
  "reconcile-payout-status",
  "cascade-refund-earnings",
  "reconcile-pending-refunds",
  "handle-lost-disputes",
  "reconcile-disputes",
  "cleanup-abandoned-payments",
  "release-earnings",
  "reconcile-payment-status",
  "sync-payment-earnings",
  "generate-subscription-invoices",
  "settle-invoice-accruals",
  // #1506 — cancels and refunds consultant no-shows through
  // refundBookingPayment; every job that calls the refund front door belongs
  // here so DEGRADED maintenance holds it with the other refunding jobs.
  "detect-consultant-no-shows",
  // #1506 — expirePaymentPendingRequests/expireApprovedUnallocatedSubscriptions
  // in this job call refundPaymentsForExpired, another refund front-door
  // caller that must be held with the rest of the money jobs.
  "expire-stale-requests",
  // #1775 C-12 — refunds a paid trial nobody answered within 48 h.
  "expire-unpaid-trials",
  // #1780 row 4 — refunds a cancelled class session not made up in 14 days.
  "settle-cancelled-sessions",
  // Added by the wave-5 sweep: each of these either moves money directly or
  // mutates the org contract/program state the checkout sponsorship resolver
  // reads, so a partial deployment can bill against a half-written entitlement.
  "release-pending-trust-earnings",
  "auto-renew-contracts",
  "dunning",
  "timeout-member-overages",
  "advance-program-cycles",
  "expire-contracts",
  // Registers IRNs with the government portal and writes the resulting IRP
  // state onto the invoice. It moves no money, but a half-deployed payload
  // becomes a statutory record that can only be cancelled for 24 hours.
  "irp-uploader",
  // #1370 — its healer mints tax invoices, which burns numbers from a gapless
  // statutory series. A half-deployed run leaves gaps that cannot be filled.
  "gst-outward-register-export",
]);

/**
 * #1599 F-P1-03 — the admin console (`/api/admin/system-jobs/run`) keys a few
 * jobs by an id spelled differently from the cron job name. Map those here so
 * the DEGRADED gate has one list, `FINANCIAL_JOB_NAMES`, and no second copy.
 */
const CRON_JOB_NAME_BY_ADMIN_ID: Record<string, string> = {
  "reconcile-refunds": "reconcile-pending-refunds",
  // Rides inside the abandoned-payments run since #1321.
  "cleanup-approval-payments": "cleanup-abandoned-payments",
  "tentative-occurrences": "cleanup-tentative-occurrences",
  "auth-tokens": "cleanup-auth-tokens",
};

/** True when a cron job name, or an admin console job id, is a money job. */
export function isFinancialJob(jobIdOrName: string): boolean {
  return FINANCIAL_JOB_NAMES.has(
    CRON_JOB_NAME_BY_ADMIN_ID[jobIdOrName] ?? jobIdOrName,
  );
}
