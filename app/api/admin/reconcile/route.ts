import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { RECONCILE_JOBS } from "@/lib/backoffice/reconcile-jobs";

/**
 * #1771 K-8 — the Reconcile section's last-run line per job: the latest
 * SystemJobExecution for its lock name (the ledger run also has its report).
 * Gated like the section (admin), not by `payouts.read`, which staff hold.
 */
export async function GET() {
  const auth = await requireBackofficeSurface("payouts.manage");
  if (auth.error) return auth.error;
  const jobs = [];
  for (const [key, job] of Object.entries(RECONCILE_JOBS)) {
    const last = await prisma.systemJobExecution.findFirst({
      where: { jobName: job.lockName },
      orderBy: { startedAt: "desc" },
      select: {
        status: true,
        startedAt: true,
        endedAt: true,
        errorCount: true,
      },
    });
    jobs.push({ key, label: job.label, description: job.description, last });
  }
  const ledgerReport = await prisma.ledgerReconciliationReport.findFirst({
    orderBy: { runAt: "desc" },
    select: { id: true, runAt: true, ok: true, scope: true },
  });
  return NextResponse.json(
    { jobs, ledgerReport },
    { headers: { "Cache-Control": "no-store" } },
  );
}
