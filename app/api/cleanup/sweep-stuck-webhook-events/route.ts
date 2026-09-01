/**
 * B5 stuck-webhook sweeper API endpoint (#785, task #10).
 *
 * Thin wrapper around scripts/cleanup/sweep-stuck-webhook-events.ts. Re-drives
 * WebhookEvent rows left processed=false after an after()-callback crash.
 *
 * Schedule: every ~10 minutes (CRON_SECRET-gated, like the other cleanup jobs).
 */
import { NextRequest, NextResponse } from "next/server";
import { sweepStuckWebhookEvents } from "@/scripts/cleanup/sweep-stuck-webhook-events";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized stuck-webhook sweep attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("sweep-stuck-webhook-events");

    Sentry.logger.info("cron:sweep-stuck-webhook-events started");
    const result = await sweepStuckWebhookEvents();

    Sentry.logger.info("cron:sweep-stuck-webhook-events finished", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
    });
    console.log("✅ Stuck-webhook sweep completed:", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
    });

    // 207 when some events are still failing after a re-drive (needs attention).
    const status = result.stillFailing > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MaintenanceActiveError) {
      return NextResponse.json(
        { error: error.message, phase: error.phase },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "sweep-stuck-webhook-events" },
    });
    console.error("Error in stuck-webhook sweep:", error);
    return NextResponse.json(
      {
        error: "Failed to sweep stuck webhook events",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
