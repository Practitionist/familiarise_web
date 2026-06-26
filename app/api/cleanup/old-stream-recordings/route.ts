/**
 * POST /api/cleanup/old-stream-recordings
 *
 * HTTP shim around scripts/cleanup/cleanup-old-stream-recordings.ts.
 * Gated by CRON_SECRET like every other route under /api/cleanup.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { cleanupOldStreamRecordings } from "@/scripts/cleanup/cleanup-old-stream-recordings";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }
  try {
    Sentry.logger.info("cron:cleanup-old-stream-recordings started");
    const result = await cleanupOldStreamRecordings();
    Sentry.logger.info("cron:cleanup-old-stream-recordings finished", { success: result.success });
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "cleanup-old-stream-recordings" },
    });
    return NextResponse.json(
      {
        error: "Stream retention sweep failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
