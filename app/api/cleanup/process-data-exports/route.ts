/**
 * POST /api/cleanup/process-data-exports
 *
 * CRON_SECRET-gated HTTP entry for the data-export worker.
 */

import { NextResponse, type NextRequest } from "next/server";
import { processDataExports } from "@/scripts/cleanup/process-data-exports";
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
    Sentry.logger.info("cron:process-data-exports started");
    const result = await processDataExports();
    Sentry.logger.info("cron:process-data-exports finished", {
      picked: result.picked,
      succeeded: result.succeeded,
      failed: result.failed,
    });
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "process-data-exports" } });
    return NextResponse.json(
      {
        error: "Data export tick failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
