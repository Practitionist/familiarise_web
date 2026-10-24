import { NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { ledgerSummarySchema } from "@/schemas/backoffice/reconciliation";
import { RECONCILE_JOBS } from "@/lib/backoffice/reconcile-jobs";

/** ADMIN-only latest execution evidence and full-audit completion status. */
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
  const ledger = await prisma.ledgerReconciliationReport.findFirst({
    where: { scope: "full" },
    orderBy: { runAt: "desc" },
    select: { id: true, runAt: true, ok: true, scope: true, summary: true },
  });
  const summary = ledgerSummarySchema.safeParse(ledger?.summary);
  const ledgerReport = ledger
    ? {
        id: ledger.id,
        runAt: ledger.runAt,
        ok: ledger.ok,
        scope: ledger.scope,
        status: summary.success ? summary.data.status : "UNKNOWN",
      }
    : null;
  return NextResponse.json(
    { jobs, ledgerReport },
    { headers: { "Cache-Control": "no-store" } },
  );
}
