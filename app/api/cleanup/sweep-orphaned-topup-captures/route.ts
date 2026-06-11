/**
 * Captured-but-uncredited wallet top-up reconciler API endpoint (#785, task #23).
 * Thin CRON_SECRET-gated wrapper around the reconciler. Runs every ~30 minutes.
 */
import { NextRequest, NextResponse } from "next/server";
import { sweepOrphanedTopupCaptures } from "@/scripts/cleanup/sweep-orphaned-topup-captures";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized captured-top-up sweep attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sweepOrphanedTopupCaptures();
    console.log("✅ Captured-top-up sweep completed:", {
      scanned: result.scanned,
      recredited: result.recredited,
      stillFailing: result.stillFailing,
    });

    const status = result.stillFailing > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error in captured-top-up sweep:", error);
    return NextResponse.json(
      {
        error: "Failed to sweep captured top-ups",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
