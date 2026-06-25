/**
 * POST /api/cleanup/prune-audit-logs
 *
 * HTTP shim. CRON_SECRET-gated like every other cleanup route.
 */

import { NextResponse, type NextRequest } from "next/server";
import { pruneAuditLogs } from "@/scripts/cleanup/prune-audit-logs";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    Sentry.logger.info("cron:prune-audit-logs started");
    const result = await pruneAuditLogs();
    Sentry.logger.info("cron:prune-audit-logs finished", { ...result });
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "prune-audit-logs" },
    });
    return NextResponse.json(
      {
        error: "Audit prune failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
