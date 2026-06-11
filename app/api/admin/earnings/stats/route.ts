/**
 * Admin Earnings Stats API
 * Get earnings statistics for admin dashboard
 */

import { NextRequest, NextResponse } from "next/server";
import { getEarningsStats } from "@/lib/payments/payouts/earnings-service";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

/**
 * GET /api/admin/earnings/stats
 * Get earnings statistics
 */
export async function GET(_req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const stats = await getEarningsStats();

    return NextResponse.json({ stats });
  } catch (error) {
    console.error("Error fetching earnings stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings stats" },
      { status: 500 },
    );
  }
}
