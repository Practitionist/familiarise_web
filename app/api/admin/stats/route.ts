import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getAdminStats } from "@/lib/data/admin-stats";

export async function GET() {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const stats = await getAdminStats();
    return NextResponse.json(stats, {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    return NextResponse.json(
      { error: "Failed to fetch admin stats" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
