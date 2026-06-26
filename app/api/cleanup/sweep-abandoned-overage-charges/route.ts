/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper API endpoint (#785, task #25).
 * CRON_SECRET-gated wrapper. FAILs never-paid PENDING side-charges to free the
 * per-cycle circuit-breaker ceiling. Runs daily.
 */
import { NextRequest, NextResponse } from "next/server";
import { sweepAbandonedOverageCharges } from "@/scripts/cleanup/sweep-abandoned-overage-charges";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized abandoned overage-charge sweep attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    Sentry.logger.info("cron:sweep-abandoned-overage-charges started");
    const result = await sweepAbandonedOverageCharges();
    console.log("✅ Abandoned overage-charge sweep completed:", {
      scanned: result.scanned,
      failed: result.failed,
    });
    Sentry.logger.info("cron:sweep-abandoned-overage-charges finished", {
      scanned: result.scanned,
      failed: result.failed,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run) skips
    // with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    Sentry.captureException(error, { tags: { subsystem: "cron", job: "sweep-abandoned-overage-charges" } });
    console.error("Error in abandoned overage-charge sweep:", error);
    return NextResponse.json(
      {
        error: "Failed to sweep abandoned overage charges",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
