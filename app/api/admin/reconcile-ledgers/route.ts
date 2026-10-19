/**
 * POST /api/admin/reconcile-ledgers
 * GET  /api/admin/reconcile-ledgers
 *
 * Platform-admin-only ledger auditor.
 *
 *  - `POST` with `{ organizationId, reason }` runs an org-scoped reconciliation
 *    synchronously and returns the resulting report.
 *  - `POST` with only `{ reason }` runs the full-scope reconciliation directly
 *    in-process under the `reconcile-ledgers` cron lock (#1943). A full-scope
 *    run already RUNNING and younger than the stale window, or holding the
 *    cron lock, answers 409.
 *  - `GET` lists the most recent reports (paginated), or one by `?id=`.
 *
 * Access: platform admins only via `requireBackofficeSurface("payouts.manage")`
 * (ADMIN-only — STAFF is deliberately excluded: the reports expose cross-org
 * ledger aggregates incl. per-org wallet balances, which the settlement
 * surfaces keep ADMIN-only). Does NOT
 * grant org admins the ability to run reconciliation on their own org —
 * intentionally, because the reconcile output exposes cross-org
 * aggregate shapes that we don't want leaking through an in-app UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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
        after: { reportId: report.id, ok: report.ok },
        response: { data: report },
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
