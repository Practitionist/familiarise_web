/**
 * Stale Request Expiration API Endpoint
 *
 * Thin wrapper around scripts/expire-stale-requests.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily (via GitHub Actions or external cron)
 */

import { NextRequest, NextResponse } from "next/server";
import { expireStaleRequests } from "@/scripts/expire-stale-requests";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized stale request expiration attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.log("🕐 Starting stale request expiration via API...");

    const result = await expireStaleRequests();

    console.log("✅ Stale request expiration completed:", {
      consultationsExpired: result.consultationsExpired,
      subscriptionsExpired: result.subscriptionsExpired,
      paymentPendingExpired: result.paymentPendingExpired,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error("Error in stale request expiration:", error);
    return NextResponse.json(
      {
        error: "Failed to expire stale requests",
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
