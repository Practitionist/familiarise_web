import { NextRequest } from "next/server";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { isReconcileJob } from "@/lib/backoffice/reconcile-jobs";
import { getMaintenanceState } from "@/lib/maintenance-edge";
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";
import { POST as startLedgerRun } from "@/app/api/admin/reconcile-ledgers/route";

/**
 * #1771 K-8 — start one reconcile job from the console, with no CRON_SECRET
 * in the browser. Each job runs in-process under its own cron lock (a held
 * lock answers 409 ALREADY_RUNNING); the full ledger run is handed to its
 * background driver exactly as POST /api/admin/reconcile-ledgers does.
 */
export const POST = withOpsAction(
  "payouts.manage",
  "reconcile.run",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "ReconcileJob", id: params.job }),
    run: async ({ params }) => {
      const job = params.job;
      if (!isReconcileJob(job)) {
        throw new OpsRefusal("UNKNOWN_JOB", "No such reconcile job.", 404);
      }
      const { phase } = await getMaintenanceState();
      if (phase === "DEGRADED" || phase === "OFFLINE") {
        throw new OpsRefusal(
          "MAINTENANCE",
          "Money jobs are paused during maintenance.",
          503,
        );
      }
      const result = await runJob(job);
      return {
        target: { kind: "ReconcileJob", id: job },
        after: { job },
        response: { job, result },
        status: job === "ledgers" ? 202 : 200,
      };
    },
  },
);

async function runJob(job: string): Promise<unknown> {
  switch (job) {
    case "refunds":
      return reconcilePendingRefunds();
    case "payment-status":
      return reconcilePaymentStatus();
    case "earnings":
      return syncPaymentEarnings();
    default:
      return startLedgers();
  }
}

async function startLedgers(): Promise<unknown> {
  const res = await startLedgerRun(
    new NextRequest("http://internal/api/admin/reconcile-ledgers", {
      method: "POST",
      body: "{}",
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 409) {
    throw new OpsRefusal("ALREADY_RUNNING", "A ledger run is already going.");
  }
  if (!res.ok) {
    throw new OpsRefusal(
      "LEDGER_RUN_NOT_STARTED",
      typeof body.message === "string"
        ? body.message
        : "The ledger run could not start.",
      res.status,
    );
  }
  return body.data;
}
