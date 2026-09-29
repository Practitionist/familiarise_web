/**
 * #1771 K-8 — the reconcile jobs the Reconcile tab can start, by the name each
 * one's cron lock and SystemJobExecution trail use.
 */
export const RECONCILE_JOBS = {
  ledgers: {
    label: "Ledger reconciliation",
    lockName: "reconcile-ledgers",
    description:
      "Re-checks every ledger balance against its journal; runs in the background.",
  },
  refunds: {
    label: "Pending refunds",
    lockName: "reconcile-pending-refunds",
    description: "Asks the gateway about every refund still pending.",
  },
  "payment-status": {
    label: "Payment status",
    lockName: "reconcile-payment-status",
    description: "Asks the gateway about every payment still pending.",
  },
  earnings: {
    label: "Earnings healer",
    lockName: "sync-payment-earnings",
    description: "Writes the earnings rows a captured payment is missing.",
  },
} as const;

export type ReconcileJob = keyof typeof RECONCILE_JOBS;

export function isReconcileJob(v: string): v is ReconcileJob {
  return Object.hasOwn(RECONCILE_JOBS, v);
}
