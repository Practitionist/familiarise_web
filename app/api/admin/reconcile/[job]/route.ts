import { z } from "zod";
import { statusFor } from "@/lib/cron/cleanup-route";
import { ledgerSummarySchema } from "@/schemas/backoffice/reconciliation";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  isReconcileJob,
  type ReconcileJob,
} from "@/lib/backoffice/reconcile-jobs";
import { getMaintenanceState } from "@/lib/maintenance";
import { jobsMayRunHere } from "@/lib/cron/dispatch-refusal";
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";
import { startLedgerReconciliation } from "@/lib/backoffice/ledger-run";

/** Authenticated bounded batches share canonical leases and retain an operator audit trail. */
export const POST = withOpsAction(
  "payouts.manage",
  "reconcile.run",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "ReconcileJob", id: params.job }),
    run: async ({ params, actor }) => {
      const job = params.job;
      if (!isReconcileJob(job)) {
        throw new OpsRefusal("UNKNOWN_JOB", "No such reconcile job.", 404);
      }
      if (!jobsMayRunHere()) {
        throw new OpsRefusal(
          "JOB_RUN_PRODUCTION_ONLY",
          "Reconcile jobs run only on the production deploy; this deploy shares its database.",
        );
      }
      const { phase } = await getMaintenanceState();
      if (phase === "DEGRADED" || phase === "OFFLINE") {
        throw new OpsRefusal(
          "MAINTENANCE",
          "Money jobs are paused during maintenance.",
          503,
        );
      }
      const result = await RUNNERS[job](actor.userId);
      const batch = batchOutcome(job, result);
      const ledger =
        job === "ledgers"
          ? z
              .object({ summary: ledgerSummarySchema, ok: z.boolean() })
              .parse(result)
          : null;
      return {
        target: { kind: "ReconcileJob", id: job },
        after: ledger
          ? { job, reportStatus: ledger.summary.status, ok: ledger.ok }
          : batch
            ? { job, ...batch }
            : { job },
        response: { job, result, batch },
        status: ledger
          ? statusFor(
              { success: ledger.summary.status !== "FAILED" },
              ledger.summary.status === "COMPLETED" && !ledger.ok,
            )
          : 200,
      };
    },
  },
  { stepUp: true },
);

/**
 * One bounded batch per click; later requests and scheduled runs continue remaining work.
 */
const CONSOLE_BATCH = 25;

// A Record over the union: a job added to RECONCILE_JOBS without a runner
// here fails to compile instead of starting a ledger run.
const RUNNERS: Record<ReconcileJob, (actorUserId: string) => Promise<unknown>> =
  {
    refunds: () => reconcilePendingRefunds({ limit: CONSOLE_BATCH }),
    "payment-status": () => reconcilePaymentStatus({ limit: CONSOLE_BATCH }),
    earnings: () => syncPaymentEarnings({ limit: CONSOLE_BATCH }),
    ledgers: (actorUserId) =>
      startLedgerReconciliation({ triggeredById: actorUserId }),
  };

/**
 * A full batch may leave more work. Ledger progress is shown by its persisted report.
 */
function batchOutcome(job: ReconcileJob, result: unknown) {
  if (job === "ledgers") return null;
  const processed = Number(
    (result as { totalProcessed?: unknown } | null)?.totalProcessed ?? 0,
  );
  return { processed, limit: CONSOLE_BATCH, full: processed >= CONSOLE_BATCH };
}
