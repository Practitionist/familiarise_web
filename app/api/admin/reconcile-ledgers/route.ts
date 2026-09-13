/**
 * POST /api/admin/reconcile-ledgers
 * GET  /api/admin/reconcile-ledgers
 *
 * Platform-admin-only ledger auditor.
 *
 *  - `POST` with `{ organizationId }` runs an org-scoped reconciliation
 *    synchronously and returns the resulting report (small enough to answer
 *    inside the edge's wait).
 *  - `POST` with no body runs the full scope, which takes longer than the
 *    ~26 s the Netlify edge waits for a Route Handler's first byte (#1454).
 *    It opens a report row, hands the run id to the background driver
 *    (`netlify/functions/reconcile-ledgers-background.mts`) and answers
 *    `202 { reportId }` at once; poll `GET ?id=<reportId>` until
 *    `summary.status` is COMPLETED. A full-scope run already RUNNING and
 *    younger than the stale window answers 409 with its id instead.
 *  - `GET` lists the most recent reports (paginated), or one by `?id=`.
 *
 * Access: platform admins only via `requireBackofficeSurface("payouts.read")`
 * (ADMIN-only — STAFF is deliberately excluded: the reports expose cross-org
 * ledger aggregates incl. per-org wallet balances, which the settlement
 * surfaces keep ADMIN-only). Does NOT
 * grant org admins the ability to run reconciliation on their own org —
 * intentionally, because the reconcile output exposes cross-org
 * aggregate shapes that we don't want leaking through an in-app UI.
 */

import * as Sentry from "@sentry/nextjs";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getAppUrl } from "@/lib/url";
import {
  createReconcileRun,
  isReconcileRunInProgress,
  markReconcileRunFailed,
  RECONCILE_RUN_STALE_MS,
  runReconcileLedgers,
} from "@/scripts/reconcile/reconcile-ledgers";

const RunBodySchema = z.object({
  organizationId: z.string().min(1).optional(),
});

/** Joined to `getAppUrl()`, which keeps a preview off production's driver. */
const RECONCILE_DRIVER_PATH =
  "/.netlify/functions/reconcile-ledgers-background";

/** POST the run to the background driver; Netlify answers 202 and runs it. */
async function kickReconcileDriver(args: {
  runId: string;
  triggeredById?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, reason: "CRON_SECRET is not set" };
  try {
    const res = await fetch(`${getAppUrl()}${RECONCILE_DRIVER_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    return res.status === 202
      ? { ok: true }
      : { ok: false, reason: `driver answered ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.read");
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

  if (organizationId) {
    try {
      const report = await runReconcileLedgers({
        scope: `org:${organizationId}`,
        organizationId,
        triggeredById: triggeredById ?? undefined,
      });
      return NextResponse.json({ data: report });
    } catch (err) {
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

  const runId = randomUUID();
  await createReconcileRun(
    { scope: "full", triggeredById: triggeredById ?? undefined },
    runId,
  );
  const kick = await kickReconcileDriver({
    runId,
    triggeredById: triggeredById ?? undefined,
  });
  if (!kick.ok) {
    // The row must not sit RUNNING forever and block the next kick.
    await markReconcileRunFailed(runId, `driver kick failed: ${kick.reason}`);
    Sentry.captureException(
      new Error(`reconcile driver kick failed: ${kick.reason}`),
      { tags: { subsystem: "admin" } },
    );
    return NextResponse.json(
      { error: "DRIVER_KICK_FAILED", reportId: runId, message: kick.reason },
      { status: 502 },
    );
  }
  return NextResponse.json(
    { data: { reportId: runId, status: "RUNNING" } },
    { status: 202 },
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.read");
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
