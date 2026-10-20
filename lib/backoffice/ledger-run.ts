/**
 * Starts one ledger reconciliation in-process, shared by the reconcile-ledgers
 * door and the console's reconcile job. A full-scope run already going is a 409.
 * Drifted wallets are frozen exactly as the nightly run freezes them.
 */

import prisma from "@/lib/prisma";
import { OpsRefusal } from "./ops-refusal-error";
import { freezeDriftedWallets } from "@/lib/payments/wallet-freeze";
import {
  isReconcileRunInProgress,
  RECONCILE_RUN_STALE_MS,
  runReconcileLedgers,
} from "@/scripts/reconcile/reconcile-ledgers";

export async function startLedgerReconciliation(input: {
  organizationId?: string;
  triggeredById?: string;
}) {
  const { organizationId } = input;
  if (!organizationId) {
    const recent = await prisma.ledgerReconciliationReport.findMany({
      where: {
        scope: "full",
        runAt: { gte: new Date(Date.now() - RECONCILE_RUN_STALE_MS) },
      },
      orderBy: { runAt: "desc" },
      take: 5,
      select: { id: true, summary: true },
    });
    const inFlight = recent.find(isReconcileRunInProgress);
    if (inFlight) {
      throw new OpsRefusal(
        "RUN_IN_PROGRESS",
        `A full ledger run is already going (report ${inFlight.id}).`,
        409,
      );
    }
  }
  const report = await runReconcileLedgers({
    scope: organizationId ? `org:${organizationId}` : "full",
    ...(organizationId ? { organizationId } : {}),
    triggeredById: input.triggeredById,
  });
  const frozenWallets = await freezeDriftedWallets(report);
  return { ...report, frozenWallets };
}
