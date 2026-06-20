import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getOperatorDashboardStats } from "@/lib/api/operators";

export async function GET() {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const stats = await getOperatorDashboardStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Admin stats error:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    return NextResponse.json(
      { error: "Failed to fetch admin stats" },
      { status: 500 },
    );
  }
}
