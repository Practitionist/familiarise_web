/**
 * Staff Dashboard Stats API
 * Returns homepage statistics for the staff dashboard.
 *
 * Thin shell — query/aggregation logic lives in
 * `lib/api/operators/stats.ts` (`getStaffDashboardStats`).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getStaffDashboardStats } from "@/lib/api/operators";

export async function GET() {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const stats = await getStaffDashboardStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching staff stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch staff stats" },
      { status: 500 },
    );
  }
}
