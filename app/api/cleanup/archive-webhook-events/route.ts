/**
 * Webhook Event Archive API Endpoint
 *
 * Thin wrapper around scripts/archive-webhook-events.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Weekly (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { archiveWebhookEvents } from "@/scripts/cleanup/archive-webhook-events";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized webhook archive attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:archive-webhook-events started");
    console.log("🗄️ Starting webhook event archive via API...");

    const result = await archiveWebhookEvents();

    Sentry.logger.info("cron:archive-webhook-events finished", {
      processedEventsDeleted: result.processedEventsDeleted,
      failedEventsDeleted: result.failedEventsDeleted,
      totalDeleted: result.totalDeleted,
    });
    console.log("✅ Webhook event archive completed:", {
      processedEventsDeleted: result.processedEventsDeleted,
      failedEventsDeleted: result.failedEventsDeleted,
      totalDeleted: result.totalDeleted,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "archive-webhook-events" } });
    console.error("Error in webhook event archive:", error);
    return NextResponse.json(
      {
        error: "Failed to archive webhook events",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Also support POST for manual triggering
export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
