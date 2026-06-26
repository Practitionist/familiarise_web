/**
 * Mark Expired Recordings Cron Job
 *
 * Marks Stream S3 recordings whose URLs have expired as EXPIRED status.
 * Prevents serving broken links to users.
 *
 * Schedule: Daily (via GitHub Actions)
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { streamLogger } from "@/lib/stream-logger";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    streamLogger.info("Starting mark-expired-recordings cron");
    Sentry.logger.info("cron:mark-expired-recordings started");

    // #476 — same lock key as the GH Actions entry (jobs/stream/...).
    const expiredCount = await withCronLock(
      "mark-expired-recordings",
      { failMode: "open" },
      () => RecordingTransferService.markExpiredRecordings(),
    );

    Sentry.logger.info("cron:mark-expired-recordings finished", { expiredCount });
    return NextResponse.json({
      success: true,
      expiredCount,
    });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "mark-expired-recordings" } });
    streamLogger.error("Mark expired recordings cron failed", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
