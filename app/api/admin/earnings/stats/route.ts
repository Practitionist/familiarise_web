/**
 * Admin Earnings Stats API
 * Get earnings statistics for admin dashboard
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { getEarningsStats } from "@/lib/payments/payouts/earnings-service";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

/**
 * GET /api/admin/earnings/stats
 * Get earnings statistics
 */
export async function GET(_req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    const stats = await getEarningsStats();

    return NextResponse.json({ stats }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching earnings stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings stats" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
