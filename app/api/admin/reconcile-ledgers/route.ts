/**
 * POST /api/admin/reconcile-ledgers
 * GET  /api/admin/reconcile-ledgers
 *
 * Platform-admin-only ledger auditor.
 *
 *  - `POST` with `{ organizationId }` runs an org-scoped reconciliation
 *    synchronously and returns the resulting report.
 *  - `POST` with no body runs the full-scope reconciliation directly
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

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  isReconcileRunInProgress,
  RECONCILE_RUN_STALE_MS,
  runReconcileLedgers,
} from "@/scripts/reconcile/reconcile-ledgers";

const RunBodySchema = z.object({
  organizationId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.manage");
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => ({}));
  const parsed = RunBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { organizationId } = parsed.data;
  // requirePrivilegedAuth returns the privileged session id so we can
  // attribute the run in the report row. Fall back to null for service
  // accounts / cli if the helper ever widens.
  const triggeredById =
    (auth as unknown as { session?: { user?: { id?: string } } }).session?.user
      ?.id ?? null;

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
      return NextResponse.json(
        { error: "RUN_IN_PROGRESS", reportId: inFlight.id },
        { status: 409 },
      );
    }
  }

  try {
    const report = await runReconcileLedgers({
      scope: organizationId ? `org:${organizationId}` : "full",
      ...(organizationId ? { organizationId } : {}),
      triggeredById: triggeredById ?? undefined,
    });
    return NextResponse.json({ data: report });
  } catch (err) {
    if (err instanceof CronLockHeldError) {
      return NextResponse.json(
        { error: "RUN_IN_PROGRESS", message: err.message },
        { status: 409 },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "admin" } },
    );
    console.error("[admin/reconcile-ledgers] run failed", err);
    return NextResponse.json(
      {
        error: "Reconciliation run failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

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
