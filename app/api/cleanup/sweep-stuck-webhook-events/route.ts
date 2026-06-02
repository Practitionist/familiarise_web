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

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized stuck-webhook sweep attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sweepStuckWebhookEvents();

    console.log("✅ Stuck-webhook sweep completed:", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
    });

    // 207 when some events are still failing after a re-drive (needs attention).
    const status = result.stillFailing > 0 ? 207 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
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
