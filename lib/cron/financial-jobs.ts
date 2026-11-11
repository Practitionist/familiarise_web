/**
 * Pure, dependency-free: read by the cron maintenance gate
 * (lib/maintenance-cron.ts) and by the System jobs console, which asks for a
 * typed confirm before running any of these by hand.
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
  "reconcile-pending-refunds",
  "reconcile-disputes",
  "cleanup-abandoned-payments",
  "release-earnings",
  "reconcile-payment-status",
  "reconcile-org-invoice-payments",
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
  // Voids a declared incident's sessions and refunds them through the front door.
  "settle-platform-incidents",
  "maintenance-booking-remediation",
  // Its class pass stamps each seat's class-end refund owed in the completing commit.
  "auto-complete-appointments",
  // #1846 N2 — re-drives the capture webhook's owed auto-refunds.
  "retry-auto-refunds",
  // Settles standalone sale captures and stages refunds for the ones it cannot grant.
  "reconcile-standalone-purchases",
  // Orphan auto-heal refunds stranded captures through the refund front door.
  "reconcile-orphaned-payments",
  // Added by the wave-5 sweep: each of these either moves money directly or
  // mutates the org contract/program state the checkout sponsorship resolver
  // reads, so a partial deployment can bill against a half-written entitlement.
  "auto-renew-contracts",
  "dunning",
  "timeout-member-overages",
  "sweep-abandoned-overage-charges",
  "advance-program-cycles",
  "expire-contracts",
  // Registers IRNs with the government portal and writes the resulting IRP
  // state onto the invoice. It moves no money, but a half-deployed payload
  // becomes a statutory record that can only be cancelled for 24 hours.
  "irp-uploader",
  // #1370 — its healer mints tax invoices, which burns numbers from a gapless
  // statutory series. A half-deployed run leaves gaps that cannot be filled.
  "gst-outward-register-export",
  // Mints consumer tax invoices from the same gapless series.
  "heal-consumer-invoices",
  // Referral vest and breakage post to the referral-credit liability ledger.
  "vest-referral-credits",
  "expire-referral-credits",
  // Posts gateway-fee and settlement journals from Razorpay's settlement report.
  "reconcile-gateway-settlements",
]);
