import { NextRequest, NextResponse } from "next/server";
import { reconcileOrphanedSessions } from "@/jobs/meetings/reconcile-orphaned-sessions";
import { getMaintenanceState } from "@/lib/maintenance";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message:
            "Please provide a valid authorization header with the CRON_SECRET",
        },
        { status: 401 },
      );
    }

    const { phase } = await getMaintenanceState();
    if (phase === "OFFLINE") {
      return NextResponse.json(
        { error: "Service unavailable", message: "Maintenance in progress" },
        { status: 503 },
      );
    }

    Sentry.logger.info("cron:reconcile-sessions started");
    const result = await reconcileOrphanedSessions();
    Sentry.logger.info("cron:reconcile-sessions finished", { ...result });

    return NextResponse.json(result);
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "reconcile-sessions" } });
    console.error("Reconcile sessions API route failed:", error);
    return NextResponse.json(
      {
        error: "Reconciliation job failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
