/** Canonical names used by the reconcile console and execution trail. */
export const RECONCILE_JOBS = {
  ledgers: {
    label: "Ledger reconciliation",
    lockName: "reconcile-ledgers",
    description:
      "Advances one ledger audit batch. Continue until the report is complete.",
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
