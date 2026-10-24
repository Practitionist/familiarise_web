/** ADMIN-only bounded audit slices and report history; every run requires step-up and an audit reason. */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { statusFor } from "@/lib/cron/cleanup-route";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { startLedgerReconciliation } from "@/lib/backoffice/ledger-run";

/** A run can freeze wallets, so it is a money door: ADMIN, step-up, reason, ops log row. */
export const POST = withOpsAction(
  "payouts.manage",
  "ledger.reconcile",
  { organizationId: z.string().min(1).optional() },
  {
    mode: "gateway",
    target: ({ body }) => ({
      kind: "LedgerReconciliation",
      id: body.organizationId ?? "full",
    }),
    run: async ({ body, actor }) => {
      const report = await startLedgerReconciliation({
        organizationId: body.organizationId,
        triggeredById: actor.userId,
      });
      return {
        target: {
          kind: "LedgerReconciliation",
          id: body.organizationId ?? "full",
        },
        after: {
          reportId: report.id,
          ok: report.ok,
          status: report.summary.status,
          frozenWallets: report.frozenWallets.length,
        },
        response: { data: report },
        status: statusFor(
          { success: report.summary.status !== "FAILED" },
          report.summary.status === "COMPLETED" && !report.ok,
        ),
      };
    },
  },
  { stepUp: true },
);

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.manage");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const report = await prisma.ledgerReconciliationReport.findUnique({
      where: { id },
    });
    if (!report) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ data: report });
  }

  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1),
    100,
  );
  const onlyDirty = url.searchParams.get("onlyDirty") === "true";

  const reports = await prisma.ledgerReconciliationReport.findMany({
    where: onlyDirty ? { ok: false } : undefined,
    orderBy: { runAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ data: reports });
}
