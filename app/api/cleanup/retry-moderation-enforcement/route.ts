/**
 * Moderation enforcement retry endpoint (#1270).
 *
 * Thin wrapper around scripts/cleanup/retry-moderation-enforcement.ts. Re-drives
 * the Stream write of moderation actions whose recorded outcome says it failed,
 * so a ban taken while Stream was down stops depending on someone noticing.
 *
 * Schedule: every 30 minutes, `CRON_SECRET`-gated like the other cleanup jobs,
 * driven by `.github/workflows/retry-moderation-enforcement.yml`. Scheduled
 * rather than on-demand because the failure it repairs is invisible from the
 * product: the database says banned and the moderator was told it worked, so
 * nobody would think to press a button.
 */
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { retryModerationEnforcement } from "@/scripts/cleanup/retry-moderation-enforcement";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized moderation enforcement retry attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:retry-moderation-enforcement started");
    const result = await retryModerationEnforcement();
    Sentry.logger.info("cron:retry-moderation-enforcement finished", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
      gaveUp: result.gaveUp,
    });

    // 207 when enforcement is still not on Stream after a re-drive — that is an
    // account the platform believes is banned and Stream does not.
    const status = result.stillFailing > 0 || result.gaveUp > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    // #476 — a concurrent invocation skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "retry-moderation-enforcement" },
    });
    console.error("Error in moderation enforcement retry:", error);
    return NextResponse.json(
      {
        error: "Failed to retry moderation enforcement",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
